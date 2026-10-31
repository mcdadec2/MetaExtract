import { describe, expect, it } from 'vitest';
import { children, readBoxes, u32, payload, child } from '../../src/lib/mp4/box';
import { FragmentCollector } from '../../src/lib/mp4/collector';
import { parseInit } from '../../src/lib/mp4/init';
import { mergeTracks, type MergeInput } from '../../src/lib/mp4/merge';
import { fixtureBytes, ORIGIN } from './fixtures';
import { hasFfprobe, packets, probe } from './media-check';
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

async function merge(inputs: MergeInput[]): Promise<Uint8Array> {
  const out = new MemoryFile();
  await mergeTracks(inputs, out);
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
  it('writes a standard MP4: ftyp, moov with sample tables, one mdat', async () => {
    const bytes = await merge([await collect(templateTrack(0, 4)), await collect(templateTrack(1, 5))]);
    const top = readBoxes(bytes);
    expect(top.map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
    const moov = top[1]!;
    expect(children(bytes, moov).map((b) => b.type)).toEqual(['mvhd', 'trak', 'trak']);
    const traks = children(bytes, moov).filter((b) => b.type === 'trak');
    expect(traks.map((trak) => u32(bytes, payload(child(bytes, trak, 'tkhd')!) + 12))).toEqual([1, 2]);
    const stbl = (trak: (typeof traks)[number]) =>
      children(bytes, child(bytes, child(bytes, child(bytes, trak, 'mdia')!, 'minf')!, 'stbl')!).map((b) => b.type);
    // Keyframes listed (stss); B-frames need composition offsets (ctts).
    expect(stbl(traks[0]!)).toEqual(['stsd', 'stts', 'stss', 'ctts', 'stsc', 'stsz', 'stco']);
    expect(stbl(traks[1]!)).toEqual(['stsd', 'stts', 'stsc', 'stsz', 'stco']);
    // Chunk offsets point inside the mdat.
    const mdat = top[2]!;
    const stco = child(bytes, child(bytes, child(bytes, child(bytes, traks[0]!, 'mdia')!, 'minf')!, 'stbl')!, 'stco')!;
    const first = u32(bytes, payload(stco) + 8);
    expect(first).toBeGreaterThanOrEqual(mdat.start + 8);
    expect(first).toBeLessThan(mdat.start + mdat.size);
  });

  it.skipIf(!hasFfprobe)('keeps every sample, timestamp and keyframe of the source', async () => {
    const video = fixtureBytes(`${S}/dash-single/stream-0.mp4`);
    const audio = fixtureBytes(`${S}/dash-single/stream-1.mp4`);
    const output = await merge([await collect([video], 999), await collect([audio])]);
    expect(packets(output, 'v:0')).toEqual(packets(video, 'v:0'));
    // The AAC encoder's priming frame (before 0 s) is flagged for discarding
    // in a standard MP4, exactly as ffmpeg's own MP4s do.
    const undiscarded = (lines: string[]) => lines.map((line) => line.replace(/^(-[^,]+,[^,]+,[^,]+,K)D_/, '$1__'));
    expect(undiscarded(packets(output, 'a:0'))).toEqual(packets(audio, 'a:0'));
    expect(packets(output, 'v:0')).toHaveLength(100);
  });

  it.skipIf(!hasFfprobe)('produces a file ffmpeg decodes cleanly (template and single-file inputs)', async () => {
    for (const inputs of [
      [await collect(templateTrack(0, 4)), await collect(templateTrack(1, 5))],
      [
        await collect([fixtureBytes(`${S}/dash-single/stream-0.mp4`)], 999),
        await collect([fixtureBytes(`${S}/dash-single/stream-1.mp4`)]),
      ],
    ]) {
      const result = probe(await merge(inputs));
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
