import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { withPageHeaders } from '../background/header-rules';
import { JobManager } from '../background/jobs';
import { baseMimeType, classifyMedia, totalSize } from '../lib/classify';
import { fetchText } from '../lib/engine/fetch';
import { extensionFor, renderFilename } from '../lib/filename';
import {
  CONTENT_SCRIPT_REQUESTS,
  ENGINE_EVENT_TYPES,
  REQUEST_TYPES,
  validateReport,
  type BackgroundEvent,
  type DownloadResult,
  type EngineEvent,
  type Request,
} from '../lib/messages';
import { siteName } from '../lib/sidecar';
import { loadSettings, onSettingsChanged, type Settings } from '../lib/settings';
import { mediaId, TabMediaStore, type StoreSnapshot } from '../lib/store';
import { inspectStream, type StreamKind } from '../lib/streams/inspect';
import { BLOCK_MESSAGES } from '../lib/streams/types';
import type { MediaCandidate } from '../lib/types';

const SNAPSHOT_KEY = 'media';
const INSPECT_TIMEOUT_MS = 15_000;

export default defineBackground(() => {
  // MV3 service workers stop when idle, so state is mirrored to storage and
  // reloaded on wake. Every handler awaits `ready` first.
  let store = new TabMediaStore();
  let settings: Settings;
  const jobs = new JobManager(() => settings.writeSidecar);
  const ready = Promise.all([
    browser.storage.session.get(SNAPSHOT_KEY).then((stored) => {
      store = TabMediaStore.fromSnapshot((stored[SNAPSHOT_KEY] as StoreSnapshot | undefined) ?? {});
    }),
    loadSettings().then((loaded) => {
      settings = loaded;
    }),
  ]).then(() => jobs.load());
  onSettingsChanged((changed) => {
    settings = changed;
  });

  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void browser.storage.session.set({ [SNAPSHOT_KEY]: store.snapshot() });
    }, 250);
  }

  function changed(tabId: number) {
    persist();
    const count = store.list(tabId).length;
    void browser.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {
      // the tab may have closed in the meantime
    });
    const event: BackgroundEvent = { type: 'media/changed', tabId };
    browser.runtime.sendMessage(event).catch(() => {
      // no popup open
    });
  }

  function addCandidate(tabId: number, candidate: MediaCandidate) {
    if (store.add(tabId, candidate)) changed(tabId);
  }

  void browser.action.setBadgeBackgroundColor({ color: '#2563eb' });

  browser.webRequest.onResponseStarted.addListener(
    (details) => {
      void ready.then(() => onResponse(details));
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'media', 'xmlhttprequest', 'other'] },
    ['responseHeaders'],
  );

  function onResponse(details: Browser.webRequest.OnResponseStartedDetails) {
    // Requests from service workers or the extension itself have no tab.
    if (details.tabId < 0) return;
    const headers = details.responseHeaders ?? [];
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    const kind = classifyMedia(details.url, contentType);

    // A new top-level document starts a fresh list (a media file opened
    // directly in the tab is the exception: it's both).
    if (details.type === 'main_frame' && store.clear(details.tabId)) changed(details.tabId);

    if (!kind || kind === 'segment') return;
    if (details.statusCode >= 400) return;
    const size = totalSize(headers);
    if (kind === 'progressive' && size !== undefined && size < settings.minSizeKB * 1024) return;

    addCandidate(details.tabId, {
      id: mediaId(details.url),
      url: details.url,
      kind,
      source: 'network',
      mimeType: baseMimeType(contentType) || undefined,
      size,
      detectedAt: Date.now(),
    });
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    void ready.then(() => {
      if (store.clear(tabId)) persist();
    });
  });

  browser.downloads.onChanged.addListener((delta) => {
    void ready.then(() => jobs.onDownloadChanged(delta));
  });

  /** Network detections don't know their page; take it from the tab. */
  async function withPageInfo(tabId: number, candidate: MediaCandidate): Promise<MediaCandidate> {
    if (candidate.pageUrl && candidate.pageTitle) return candidate;
    const tab = await browser.tabs.get(tabId).catch(() => undefined);
    store.update(tabId, candidate.id, {
      pageUrl: candidate.pageUrl || tab?.url,
      pageTitle: candidate.pageTitle || tab?.title,
    });
    persist();
    return candidate;
  }

  // Manifests are read when the popup lists them, not on detection, so
  // pages the user never asks about cost no extra requests.
  const inspecting = new Set<string>();
  function inspectStreams(tabId: number) {
    for (const candidate of store.list(tabId)) {
      const key = `${tabId}:${candidate.id}`;
      if (candidate.kind === 'progressive' || candidate.stream || candidate.streamError || inspecting.has(key)) continue;
      inspecting.add(key);
      void withPageInfo(tabId, candidate)
        .then(() =>
          withPageHeaders(candidate.pageUrl, candidate.url, () =>
            inspectStream(candidate.kind as StreamKind, candidate.url, (url) =>
              fetchText(fetch, url, AbortSignal.timeout(INSPECT_TIMEOUT_MS)),
            ),
          ),
        )
        .then(
          (stream) => store.update(tabId, candidate.id, { stream }),
          (error: unknown) =>
            store.update(tabId, candidate.id, {
              streamError: `Couldn’t read this stream: ${error instanceof Error ? error.message : String(error)}`,
            }),
        )
        .finally(() => {
          inspecting.delete(key);
          changed(tabId);
        });
    }
  }

  async function download(tabId: number, id: string, renditionId?: string): Promise<DownloadResult> {
    const found = store.get(tabId, id);
    if (!found) return { ok: false, error: 'This video is no longer listed. Reload the page.' };
    const candidate = await withPageInfo(tabId, found);
    const isStream = candidate.kind !== 'progressive';
    const filename = renderFilename(settings.filenameTemplate, {
      site: siteName(candidate.pageUrl, candidate.url),
      title: candidate.pageTitle ?? '',
      date: new Date(),
      id: candidate.id,
      ext: isStream ? 'mp4' : extensionFor(candidate.url, candidate.mimeType),
    });
    // Jobs keep their own copy, without the (possibly long) quality list.
    const snapshot: MediaCandidate = { ...candidate, stream: undefined, streamError: undefined };
    if (!isStream) {
      const job = await jobs.enqueueProgressive(snapshot, filename);
      return job.state === 'failed' ? { ok: false, error: job.error! } : { ok: true, jobId: job.id };
    }
    const info = candidate.stream;
    if (!info) return { ok: false, error: candidate.streamError ?? 'Still reading the stream; try again in a moment.' };
    if (info.blocked) return { ok: false, error: BLOCK_MESSAGES[info.blocked] };
    const rendition = info.renditions.find((r) => r.id === renditionId) ?? info.renditions[0]!;
    const job = await jobs.enqueueStream(snapshot, rendition.id, rendition.label, filename);
    return { ok: true, jobId: job.id };
  }

  async function handle(message: Request, sender: Browser.runtime.MessageSender): Promise<unknown> {
    await ready;
    switch (message.type) {
      case 'media/list':
        inspectStreams(message.tabId);
        return store.list(message.tabId);
      case 'media/download':
        return download(message.tabId, message.id, message.renditionId);
      case 'media/report': {
        // Report contents come from web pages, so they're validated.
        const tabId = sender.tab?.id;
        if (tabId === undefined || tabId < 0) return;
        for (const item of validateReport(message.items)) {
          addCandidate(tabId, { ...item, id: mediaId(item.url), source: 'dom', detectedAt: Date.now() });
        }
        return;
      }
      case 'jobs/list':
        return jobs.list();
      case 'jobs/cancel':
        return jobs.cancel(message.id);
      case 'jobs/retry':
        return jobs.retry(message.id);
      case 'jobs/show':
        return jobs.show(message.id);
      case 'jobs/clear':
        return jobs.clearFinished();
    }
  }

  const extensionOrigin = browser.runtime.getURL('/');
  const engineUrl = browser.runtime.getURL('/offscreen.html');

  browser.runtime.onMessage.addListener((message: Request | EngineEvent, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return false;
    const type = (message as { type?: string })?.type ?? '';
    if (ENGINE_EVENT_TYPES.has(type)) {
      if (sender.url !== engineUrl) return false;
      void ready.then(() => jobs.onEngineEvent(message as EngineEvent)).then(sendResponse);
      return true;
    }
    if (!REQUEST_TYPES.has(type)) return false;
    // Content scripts run inside web pages: they may only report what they found.
    const fromExtensionPage = sender.url?.startsWith(extensionOrigin) ?? false;
    if (CONTENT_SCRIPT_REQUESTS.has(type) ? fromExtensionPage : !fromExtensionPage) return false;
    void handle(message as Request, sender).then(sendResponse);
    return true;
  });
});
