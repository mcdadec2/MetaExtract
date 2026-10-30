import { browser, type Browser } from 'wxt/browser';
import { sidecarFilename } from '../lib/filename';
import { ACTIVE_STATES, MAX_JOBS_KEPT, type Job } from '../lib/jobs';
import type { BackgroundEvent, EngineEvent } from '../lib/messages';
import { buildSidecar, sidecarDataUrl } from '../lib/sidecar';
import type { StreamKind } from '../lib/streams/inspect';
import type { MediaCandidate } from '../lib/types';
import { clearPageHeaders, ENGINE_RULE_ID, setPageHeaders } from './header-rules';
import { closeEngine, hasEngine, sendToEngine } from './offscreen';

const STORAGE_KEY = 'jobs';
const RUNNING: ReadonlySet<Job['state']> = new Set(['downloading', 'merging']);

/**
 * The download queue. Progressive files go straight to chrome.downloads;
 * streams run one at a time in the offscreen engine, then their finished
 * file goes to chrome.downloads. The sidecar is written once the video is
 * saved. State lives in storage.local so the side panel keeps its history.
 */
export class JobManager {
  private jobs: Job[] = [];
  /** The stream job whose page headers the engine rule currently carries. */
  private ruleOwner?: string;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly writeSidecar: () => boolean) {}

  async load(): Promise<void> {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    this.jobs = (stored[STORAGE_KEY] as Job[] | undefined) ?? [];
    await this.recover();
  }

  list(): Job[] {
    return this.jobs;
  }

  private get(id: string): Job | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  private changed(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      void browser.storage.local.set({ [STORAGE_KEY]: this.jobs });
    }, 250);
    const event: BackgroundEvent = { type: 'jobs/changed', jobs: this.jobs };
    browser.runtime.sendMessage(event).catch(() => {
      // nothing open to listen
    });
  }

  private update(job: Job, patch: Partial<Job>): void {
    Object.assign(job, patch);
    this.changed();
  }

  private add(job: Job): Job {
    this.jobs.unshift(job);
    // Drop the oldest finished jobs beyond the cap; never active ones.
    while (this.jobs.length > MAX_JOBS_KEPT) {
      const index = this.jobs.findLastIndex((j) => !ACTIVE_STATES.has(j.state));
      if (index < 0) break;
      this.jobs.splice(index, 1);
    }
    this.changed();
    return job;
  }

  /** After a browser or extension restart, work that was in flight is gone. */
  private async recover(): Promise<void> {
    const engineAlive = await hasEngine();
    for (const job of this.jobs) {
      const orphaned = job.state === 'queued' && job.candidate.kind === 'progressive';
      if (orphaned || (RUNNING.has(job.state) && !engineAlive)) {
        this.update(job, { state: 'failed', error: 'Interrupted (Chrome or the extension restarted). Retry to start again.' });
      } else if (job.state === 'saving' && job.downloadId !== undefined) {
        const [item] = await browser.downloads.search({ id: job.downloadId });
        if (item?.state === 'complete') await this.finish(job);
        else if (!item || item.state === 'interrupted') this.update(job, { state: 'failed', error: 'The download was interrupted.' });
      }
    }
    await this.pump();
  }

  async enqueueProgressive(candidate: MediaCandidate, filename: string): Promise<Job> {
    const job = this.add({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      candidate,
      filename,
      state: 'queued',
    });
    await this.saveProgressive(job);
    return job;
  }

  private async saveProgressive(job: Job): Promise<void> {
    try {
      const downloadId = await browser.downloads.download({
        url: job.candidate.url,
        filename: job.filename,
        conflictAction: 'uniquify',
      });
      this.update(job, { state: 'saving', downloadId, error: undefined });
    } catch (error) {
      this.update(job, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  async enqueueStream(candidate: MediaCandidate, renditionId: string, renditionLabel: string, filename: string): Promise<Job> {
    const job = this.add({
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      candidate,
      renditionId,
      renditionLabel,
      filename,
      state: 'queued',
    });
    await this.pump();
    return job;
  }

  /** Starts the oldest queued stream when the engine is free. */
  private async pump(): Promise<void> {
    if (this.jobs.some((job) => RUNNING.has(job.state))) return;
    const next = this.jobs.findLast((job) => job.state === 'queued' && job.candidate.kind !== 'progressive');
    if (!next) {
      // Nothing running and nothing waiting for a blob URL: free the engine.
      if (!this.jobs.some((job) => job.state === 'saving' && job.candidate.kind !== 'progressive')) {
        await closeEngine().catch(() => {});
      }
      return;
    }
    this.update(next, { state: 'downloading', progress: 0, bytes: 0, error: undefined });
    try {
      const manifestHost = new URL(next.candidate.url).hostname;
      this.ruleOwner = next.id;
      await setPageHeaders(ENGINE_RULE_ID, next.candidate.pageUrl, [manifestHost]);
      await sendToEngine({
        type: 'engine/start',
        spec: {
          id: next.id,
          kind: next.candidate.kind as StreamKind,
          manifestUrl: next.candidate.url,
          renditionId: next.renditionId ?? '',
        },
      });
    } catch (error) {
      this.update(next, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
      await this.pump();
    }
  }

  async onEngineEvent(event: EngineEvent): Promise<unknown> {
    const job = this.get(event.jobId);
    if (!job) return;
    switch (event.type) {
      case 'engine/progress':
        if (!RUNNING.has(job.state)) return;
        this.update(job, { state: event.phase, progress: event.fraction, bytes: event.bytes });
        return;
      case 'engine/hosts':
        if (this.ruleOwner === job.id) await setPageHeaders(ENGINE_RULE_ID, job.candidate.pageUrl, event.hosts);
        return { ok: true };
      case 'engine/done':
        await this.releaseRule(job);
        if (job.state === 'canceled') {
          await this.release(job);
        } else {
          this.update(job, {
            state: 'saving',
            progress: 1,
            bytes: event.size,
            duration: event.duration,
            width: event.width,
            height: event.height,
          });
          try {
            const downloadId = await browser.downloads.download({
              url: event.url,
              filename: job.filename,
              conflictAction: 'uniquify',
            });
            this.update(job, { downloadId });
          } catch (error) {
            this.update(job, { state: 'failed', error: error instanceof Error ? error.message : String(error) });
            await this.release(job);
          }
        }
        await this.pump();
        return;
      case 'engine/failed':
        await this.releaseRule(job);
        this.update(job, event.canceled ? { state: 'canceled' } : { state: 'failed', error: event.error });
        await this.pump();
        return;
    }
  }

  private async releaseRule(job: Job): Promise<void> {
    if (this.ruleOwner !== job.id) return;
    this.ruleOwner = undefined;
    await clearPageHeaders(ENGINE_RULE_ID);
  }

  async onDownloadChanged(delta: Browser.downloads.DownloadDelta): Promise<void> {
    const job = this.jobs.find((j) => j.downloadId === delta.id);
    if (!job || job.state !== 'saving') return;
    if (delta.state?.current === 'complete') {
      await this.finish(job);
    } else if (delta.state?.current === 'interrupted') {
      const reason = delta.error?.current;
      this.update(
        job,
        reason === 'USER_CANCELED' ? { state: 'canceled' } : { state: 'failed', error: `Saving failed (${reason ?? 'unknown error'}).` },
      );
      await this.release(job);
    }
  }

  private async finish(job: Job): Promise<void> {
    const [item] = await browser.downloads.search({ id: job.downloadId! });
    this.update(job, { state: 'done', bytes: item?.fileSize ?? job.bytes });
    await this.release(job);
    if (this.writeSidecar()) {
      const sidecar = buildSidecar(job.candidate, new Date(), {
        duration: job.duration,
        width: job.width,
        height: job.height,
        size: item?.fileSize,
        mimeType: item?.mime || undefined,
      });
      await browser.downloads
        .download({ url: sidecarDataUrl(sidecar), filename: sidecarFilename(job.filename), conflictAction: 'uniquify' })
        .catch(() => {});
    }
  }

  /** Lets the engine drop the finished file once Chrome has it (or gave up). */
  private async release(job: Job): Promise<void> {
    if (job.candidate.kind === 'progressive') return;
    if (await hasEngine()) {
      await browser.runtime.sendMessage({ type: 'engine/release', jobId: job.id }).catch(() => {});
    }
    await this.pump();
  }

  async cancel(id: string): Promise<void> {
    const job = this.get(id);
    if (!job || !ACTIVE_STATES.has(job.state)) return;
    if (job.state === 'saving' && job.downloadId !== undefined) {
      // Chrome reports the interruption through onDownloadChanged.
      await browser.downloads.cancel(job.downloadId).catch(() => {});
      return;
    }
    const wasRunning = RUNNING.has(job.state);
    this.update(job, { state: 'canceled' });
    if (wasRunning && (await hasEngine())) {
      await browser.runtime.sendMessage({ type: 'engine/cancel', jobId: id }).catch(() => {});
    }
    await this.pump();
  }

  async retry(id: string): Promise<void> {
    const job = this.get(id);
    if (!job || (job.state !== 'failed' && job.state !== 'canceled')) return;
    this.update(job, { state: 'queued', progress: undefined, bytes: undefined, error: undefined, downloadId: undefined });
    if (job.candidate.kind === 'progressive') await this.saveProgressive(job);
    else await this.pump();
  }

  async show(id: string): Promise<void> {
    const job = this.get(id);
    if (job?.state === 'done' && job.downloadId !== undefined) browser.downloads.show(job.downloadId);
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((job) => ACTIVE_STATES.has(job.state));
    this.changed();
  }
}
