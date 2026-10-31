import type { ByteSink } from '../mp4/collector';
import { FragmentCollector } from '../mp4/collector';
import { mergeTracks, type MergeInput } from '../mp4/merge';
import { planStream, type StreamKind } from '../streams/inspect';
import { StreamError, type DownloadPlan, type SegmentRef, type TrackPlan } from '../streams/types';
import { fetchBytes, fetchText, streamFile } from './fetch';
import { decryptAes128, TsToMp4 } from './transmux';

/** A file in temporary storage (OPFS in the extension, memory in tests). */
export interface TempFile extends ByteSink {
  /** Finishes writing; read() works only after this. */
  close(): Promise<void>;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface TempStorage {
  create(name: string): Promise<TempFile>;
  remove(name: string): Promise<void>;
}

export interface StreamJobSpec {
  id: string;
  kind: StreamKind;
  manifestUrl: string;
  renditionId: string;
}

export interface Progress {
  phase: 'downloading' | 'merging';
  /** 0..1 */
  fraction: number;
  bytes: number;
}

export interface EngineDeps {
  fetch: typeof fetch;
  storage: TempStorage;
  signal: AbortSignal;
  onProgress?: (progress: Progress) => void;
  /** Called with every host the job will fetch from, before fetching media. */
  onHosts?: (hosts: string[]) => Promise<void>;
  /** Segments fetched ahead, per track. */
  concurrency?: number;
}

export interface JobResult {
  /** Name of the finished MP4 in temp storage. */
  name: string;
  size: number;
  plan: DownloadPlan;
}

/** Fetches up to `concurrency` items ahead, but hands results over strictly in order. */
async function inOrder<T, R>(
  items: T[],
  concurrency: number,
  start: (item: T) => Promise<R>,
  consume: (result: R) => Promise<void>,
): Promise<void> {
  const pending: Promise<R>[] = [];
  let next = 0;
  for (let i = 0; i < items.length; i++) {
    while (next < items.length && next < i + concurrency) {
      const promise = start(items[next++]!);
      promise.catch(() => {}); // awaited below; avoid unhandled-rejection noise meanwhile
      pending.push(promise);
    }
    await consume(await pending.shift()!);
  }
}

function hostsOf(plan: DownloadPlan): string[] {
  const urls = plan.tracks.flatMap((track) => [
    ...(track.init ? [track.init.url] : []),
    ...track.segments.flatMap((segment) => [segment.url, ...(segment.key ? [segment.key.url] : [])]),
  ]);
  return [...new Set(urls.map((url) => new URL(url).hostname))];
}

/** A SegmentBase representation: one whole file holding init and fragments. */
function isWholeFile(track: TrackPlan): boolean {
  return track.container === 'fmp4' && !track.init && track.segments.length === 1 && !track.segments[0]!.range;
}

export async function runStreamJob(spec: StreamJobSpec, deps: EngineDeps): Promise<JobResult> {
  const { storage } = deps;
  // One failing track stops the others.
  const controller = new AbortController();
  const onAbort = () => controller.abort(deps.signal.reason);
  deps.signal.addEventListener('abort', onAbort, { once: true });
  const signal = controller.signal;
  const concurrency = deps.concurrency ?? 4;

  const names: string[] = [];
  const outputName = `${spec.id}.mp4`;
  try {
    const plan = await planStream(spec.kind, spec.manifestUrl, spec.renditionId, (url) =>
      fetchText(deps.fetch, url, signal),
    );
    await deps.onHosts?.(hostsOf(plan));
    plan.tracks.forEach((_, i) => names.push(`${spec.id}-track${i}`));

    // Progress: every segment (and init) is one unit; whole files count by bytes.
    const totalUnits = plan.tracks.reduce((n, track) => n + track.segments.length + (track.init ? 1 : 0), 0);
    let doneUnits = 0;
    const partial = plan.tracks.map(() => 0);
    let bytes = 0;
    let lastReport = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 250) return;
      lastReport = now;
      const fraction = (doneUnits + partial.reduce((a, b) => a + b, 0)) / totalUnits;
      deps.onProgress?.({ phase: 'downloading', fraction: Math.min(1, fraction), bytes });
    };

    const keys = new Map<string, Promise<Uint8Array>>();
    const getKey = (url: string) => {
      if (!keys.has(url)) keys.set(url, fetchBytes(deps.fetch, url, signal));
      return keys.get(url)!;
    };
    const fetchSegment = async (segment: SegmentRef): Promise<Uint8Array> => {
      let data = await fetchBytes(deps.fetch, segment.url, signal, segment.range);
      bytes += data.length;
      if (segment.key) data = await decryptAes128(data, await getKey(segment.key.url), segment.key.iv);
      return data;
    };

    const downloadTrack = async (track: TrackPlan, i: number): Promise<MergeInput> => {
      const file = await storage.create(names[i]!);
      const collector = new FragmentCollector(file);
      const checkDrm = () => {
        if (collector.init?.encrypted) throw new StreamError('DRM-protected stream.', 'drm');
      };
      if (isWholeFile(track)) {
        collector.startResource();
        await streamFile(deps.fetch, track.segments[0]!.url, signal, async (chunk, received, total) => {
          bytes += chunk.length;
          await collector.push(chunk);
          checkDrm();
          if (total) partial[i] = received / total;
          report();
        });
        partial[i] = 0;
        doneUnits++;
      } else {
        const transmuxer = track.container === 'ts' ? new TsToMp4() : undefined;
        const segments = track.init ? [track.init, ...track.segments] : track.segments;
        await inOrder(segments, concurrency, fetchSegment, async (data) => {
          collector.startResource();
          await collector.push(transmuxer ? transmuxer.convert(data) : data);
          checkDrm();
          doneUnits++;
          report();
        });
      }
      collector.end();
      await file.close();
      return { init: collector.init!, fragments: collector.fragments, read: (o, l) => file.read(o, l) };
    };

    const settled = await Promise.allSettled(
      plan.tracks.map((track, i) =>
        downloadTrack(track, i).catch((error: unknown) => {
          controller.abort(error);
          throw error;
        }),
      ),
    );
    // Report the error that started it, not the aborts it caused.
    const failure = settled.find((result) => result.status === 'rejected');
    if (failure) throw deps.signal.aborted ? deps.signal.reason : (signal.reason ?? failure.reason);
    const inputs = settled.map((result) => (result as PromiseFulfilledResult<MergeInput>).value);
    report(true);

    deps.onProgress?.({ phase: 'merging', fraction: 1, bytes });
    const output = await storage.create(outputName);
    const size = await mergeTracks(inputs, output);
    await output.close();
    signal.throwIfAborted();
    return { name: outputName, size, plan };
  } catch (error) {
    await storage.remove(outputName).catch(() => {});
    throw error;
  } finally {
    deps.signal.removeEventListener('abort', onAbort);
    await Promise.all(names.map((name) => storage.remove(name).catch(() => {})));
  }
}
