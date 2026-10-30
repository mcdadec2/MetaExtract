import { describe, expect, it } from 'vitest';
import { children, readBoxes, u32, payload, child } from '../../src/lib/mp4/box';
import { FragmentCollector, fragmentTime } from '../../src/lib/mp4/collector';
import { parseInit } from '../../src/lib/mp4/init';
import { mergeTracks, type MergeInput } from '../../src/lib/mp4/merge';
import { fixtureBytes, ORIGIN } from './fixtures';
import { hasFfprobe, probe } from './media-check';
import { MemoryFile } from './memory-file';

const S = `${ORIGIN}/streams`;

async function collect(resources: Uint8Array[], chunkSize = Infinity): Promise<MergeInput> {
  const file = new MemoryFile();
  const collector = new FragmentCollector(file);
  for (const resource of resources) {
    collector.startResource();
    for (let i = 0; i < resource.length; i += chunkSize) {
      await collector.push(resource.subarray(i, Math.min(resource.length, i + chunkSize)));
    }
  }
  collector.end();
  return { init: collector.init!, fragments: collector.fragments, read: (o, l) => file.read(o, l) };
}

const templateTrack = (id: number, count: number) =>
  [`${S}/dash-template/init-${id}.m4s`, ...Array.from({ length: count }, (_, i) => `${S}/dash-template/chunk-${id}-${i + 1}.m4s`)].map(
    fixtureBytes,
  );

async function merge(inputs: MergeInput[], duration?: number): Promise<Uint8Array> {
  const out = new MemoryFile();
  await mergeTracks(inputs, out, duration);
  return out.bytes();
}

describe('parseInit', () => {
  it('reads track id, timescale and handler', () => {
    const init = fixtureBytes(`${S}/dash-template/init-1.m4s`);
    const moov = readBoxes(init).find((b) => b.type === 'moov')!;
    const info = parseInit(init.slice(moov.start, moov.start + moov.size));
    expect(info.tracks).toEqual([expect.objectContaining({ id: 1, handler: 'soun', timescale: 44100 })]);
    expect(info.encrypted).toBe(false);
  });
});

describe('FragmentCollector', () => {
  it('splits init and fragments and drops styp/sidx', async () => {
    const input = await collect(templateTrack(0, 4));
    expect(input.init.tracks[0]!.handler).toBe('vide');
    expect(input.fragments.map((f) => f.time)).toEqual([0, 1, 2, 3]);
    const first = await input.read(input.fragments[0]!.offset, input.fragments[0]!.size);
    expect(readBoxes(first).map((b) => b.type)).toEqual(['moof', 'mdat']);
  });

  it('gives the same result however the bytes are chunked', async () => {
    const file = [fixtureBytes(`${S}/dash-single/stream-0.mp4`)];
    const whole = await collect(file);
    for (const size of [1, 7, 4096]) {
      const chunked = await collect(file, size);
      expect(chunked.fragments).toEqual(whole.fragments);
    }
  });

  it('rejects a stream that stops mid-box or has no init', async () => {
    const file = fixtureBytes(`${S}/dash-single/stream-0.mp4`);
    await expect(collect([file.subarray(0, file.length - 10)])).rejects.toThrow('middle of a box');
    await expect(collect([fixtureBytes(`${S}/dash-template/chunk-0-1.m4s`)])).rejects.toThrow('before the init');
  });
});

describe('mergeTracks', () => {
  it('merges video and audio into one file with tracks 1 and 2, interleaved by time', async () => {
    const bytes = await merge([await collect(templateTrack(0, 4)), await collect(templateTrack(1, 5))], 4);
    const top = readBoxes(bytes);
    expect(top[0]!.type).toBe('ftyp');
    expect(top[1]!.type).toBe('moov');
    const moov = top[1]!;
    const ids = children(bytes, moov)
      .filter((b) => b.type === 'trak')
      .map((trak) => u32(bytes, payload(child(bytes, trak, 'tkhd')!) + 12));
    expect(ids).toEqual([1, 2]);
    expect(children(bytes, child(bytes, moov, 'mvex')!).map((b) => b.type)).toEqual(['mehd', 'trex', 'trex']);

    const moofs = top.filter((b) => b.type === 'moof');
    expect(moofs).toHaveLength(9);
    const mergedInit = parseInit(bytes.slice(moov.start, moov.start + moov.size));
    const times = moofs.map((moof) => fragmentTime(bytes.slice(moof.start, moof.start + moof.size), mergedInit));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(times[0]).toBe(0);
    expect(times.at(-1)).toBeGreaterThan(3.9);
    const sequences = moofs.map((moof) => u32(bytes, payload(child(bytes, moof, 'mfhd')!) + 4));
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it.skipIf(!hasFfprobe)('produces a file ffmpeg decodes cleanly (template and single-file inputs)', async () => {
    for (const inputs of [
      [await collect(templateTrack(0, 4)), await collect(templateTrack(1, 5))],
      [await collect([fixtureBytes(`${S}/dash-single/stream-0.mp4`)], 999), await collect([fixtureBytes(`${S}/dash-single/stream-1.mp4`)])],
    ]) {
      const result = probe(await merge(inputs, 4));
      expect(result.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac']);
      expect(result.streams[0]).toMatchObject({ width: 320, height: 180 });
      expect(result.duration).toBeGreaterThan(3.9);
      expect(result.duration).toBeLessThan(4.2);
      expect(result.decodeErrors).toBe('');
    }
  });

  it('refuses encrypted inits', async () => {
    const input = await collect(templateTrack(0, 1));
    input.init.encrypted = true;
    await expect(merge([input])).rejects.toThrow('DRM');
  });
});
