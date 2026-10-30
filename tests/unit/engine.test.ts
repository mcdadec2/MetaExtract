import { describe, expect, it } from 'vitest';
import { HttpError } from '../../src/lib/engine/fetch';
import { runStreamJob, type StreamJobSpec } from '../../src/lib/engine/run-job';
import { fixtureBytes, fixtureFetch, ORIGIN } from './fixtures';
import { hasFfprobe, probe } from './media-check';
import { MemoryStorage } from './memory-file';

const S = `${ORIGIN}/streams`;

function spec(kind: StreamJobSpec['kind'], path: string, renditionId = ''): StreamJobSpec {
  return { id: 'job1', kind, manifestUrl: `${S}/${path}`, renditionId };
}

async function run(job: StreamJobSpec, fetchFn = fixtureFetch(), signal = new AbortController().signal) {
  const storage = new MemoryStorage();
  const progress: number[] = [];
  const hosts: string[][] = [];
  const result = await runStreamJob(job, {
    fetch: fetchFn,
    storage,
    signal,
    onProgress: (p) => progress.push(p.fraction),
    onHosts: async (h) => void hosts.push(h),
  });
  const output = storage.files.get(result.name)!.bytes();
  return { result, output, storage, progress, hosts };
}

describe('runStreamJob', () => {
  it.skipIf(!hasFfprobe).each([
    ['HLS TS, muxed', spec('hls', 'hls-ts/master.m3u8', `${S}/hls-ts/180p.m3u8`), 320],
    ['HLS TS, lower variant', spec('hls', 'hls-ts/master.m3u8', `${S}/hls-ts/108p.m3u8`), 192],
    ['HLS fMP4 + separate audio', spec('hls', 'hls-fmp4/master.m3u8', `${S}/hls-fmp4/video.m3u8`), 320],
    ['HLS AES-128', spec('hls', 'hls-aes/index.m3u8'), 320],
    ['DASH SegmentTemplate', spec('dash', 'dash-template/manifest.mpd', '0'), 320],
    ['DASH SegmentList ranges', spec('dash', 'dash-single/manifest.mpd', '0'), 320],
    ['DASH SegmentBase', spec('dash', 'dash-single/segmentbase.mpd', '0'), 320],
  ])('%s → one playable MP4 with video and audio', async (_name, job, width) => {
    const { result, output, storage, progress, hosts } = await run(job);
    expect(result.size).toBe(output.length);
    const media = probe(output);
    expect(media.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac']);
    expect(media.streams[0]!.width).toBe(width);
    expect(media.duration).toBeGreaterThan(3.8);
    expect(media.duration).toBeLessThan(4.3);
    expect(media.decodeErrors).toBe('');
    // Only the finished file is left; temp tracks are gone.
    expect([...storage.files.keys()]).toEqual(['job1.mp4']);
    expect(progress.at(-1)).toBe(1);
    expect(hosts).toEqual([['cdn.test']]);
  });

  it('retries transient errors', async () => {
    let failures = 2;
    const base = fixtureFetch();
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('chunk-0-2.m4s') && failures-- > 0) return new Response(null, { status: 503 });
      return base(input, init);
    }) as typeof fetch;
    const { result } = await run(spec('dash', 'dash-template/manifest.mpd', '0'), flaky);
    expect(result.size).toBeGreaterThan(0);
  });

  it('resumes a whole-file download that drops part way', async () => {
    const log: string[] = [];
    const base = fixtureFetch();
    let dropped = false;
    const dropping = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range');
      log.push(`${String(input).split('/').pop()} ${range ?? ''}`);
      const response = await base(input, init);
      if (!String(input).endsWith('stream-0.mp4') || dropped) return response;
      dropped = true;
      // Send 50 KB, then fail the connection.
      const bytes = new Uint8Array(await response.arrayBuffer()).slice(0, 50_000);
      let pulls = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(bytes);
          else controller.error(new TypeError('network error'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-length': '146000' } });
    }) as typeof fetch;
    const { output } = await run(spec('dash', 'dash-single/segmentbase.mpd', '0'), dropping);
    expect(log).toContain('stream-0.mp4 bytes=50000-');
    if (hasFfprobe) expect(probe(output).decodeErrors).toBe('');
  });

  it('fails with a clear message on an expired link, and cleans up', async () => {
    const base = fixtureFetch();
    const forbidden = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith('.m4s') ? new Response(null, { status: 403 }) : base(input, init)) as typeof fetch;
    const storage = new MemoryStorage();
    const error = await runStreamJob(spec('dash', 'dash-template/manifest.mpd', '0'), {
      fetch: forbidden,
      storage,
      signal: new AbortController().signal,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as Error).message).toContain('may have expired');
    expect(storage.files.size).toBe(0);
  });

  it('refuses an encrypted init segment', async () => {
    const base = fixtureFetch();
    const encrypted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('init-0.m4s')) return base(input, init);
      // Rename the avc1 sample entry to encv, as encrypted streams have.
      const bytes = fixtureBytes(String(input));
      const at = Buffer.from(bytes).indexOf('avc1');
      bytes.set([0x65, 0x6e, 0x63, 0x76], at);
      return new Response(bytes);
    }) as typeof fetch;
    await expect(run(spec('dash', 'dash-template/manifest.mpd', '0'), encrypted)).rejects.toThrow('DRM');
  });

  it('stops and cleans up when cancelled', async () => {
    const controller = new AbortController();
    const base = fixtureFetch();
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('chunk-')) controller.abort(new Error('Cancelled'));
      return base(input, init);
    }) as typeof fetch;
    const storage = new MemoryStorage();
    await expect(
      runStreamJob(spec('dash', 'dash-template/manifest.mpd', '0'), { fetch: slow, storage, signal: controller.signal }),
    ).rejects.toThrow('Cancelled');
    expect(storage.files.size).toBe(0);
  });
});
