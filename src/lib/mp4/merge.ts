import {
  ascii,
  child,
  children,
  concat,
  makeBox,
  makeFullBox,
  Mp4Error,
  payload,
  readBoxes,
  setU32,
  setU64,
  u32,
  u64,
  uint32Bytes,
  type Box,
} from './box';
import type { ByteSink, FragmentEntry } from './collector';
import { trackIdOffset, type InitInfo, type TrackInfo } from './init';

/** One collected stream: its init info, and its fragments in a readable temp file. */
export interface MergeInput {
  init: InitInfo;
  fragments: FragmentEntry[];
  read(offset: number, length: number): Promise<Uint8Array>;
}

// tfhd flags
const BASE_DATA_OFFSET = 0x000001;
const SAMPLE_DESCRIPTION_INDEX = 0x000002;
const DEFAULT_DURATION = 0x000008;
const DEFAULT_SIZE = 0x000010;
const DEFAULT_FLAGS = 0x000020;
const DEFAULT_BASE_IS_MOOF = 0x020000;
// trun flags
const DATA_OFFSET = 0x000001;
const FIRST_SAMPLE_FLAGS = 0x000004;
const SAMPLE_DURATION = 0x000100;
const SAMPLE_SIZE = 0x000200;
const SAMPLE_FLAGS = 0x000400;
const SAMPLE_CTO = 0x000800;
const NON_SYNC = 0x00010000;

function flagsOf(data: Uint8Array, box: Box): number {
  const p = payload(box);
  return (data[p + 1]! << 16) | (data[p + 2]! << 8) | data[p + 3]!;
}

function i32(data: Uint8Array, offset: number): number {
  return u32(data, offset) | 0;
}

/** A contiguous run of one track's samples inside a fragment: one chunk in the output. */
interface Chunk {
  input: number;
  /** Absolute position of the bytes in the input's temp file. */
  offset: number;
  length: number;
  sampleCount: number;
  descriptionIndex: number;
  /** Decode time of the chunk's first sample, seconds (for interleaving). */
  time: number;
  outputOffset: number;
}

/** Everything the sample tables need about one track. */
class TrackSamples {
  readonly sizes: number[] = [];
  readonly durations: number[] = [];
  readonly ctos: number[] = [];
  readonly syncs: boolean[] = [];
  readonly chunks: Chunk[] = [];
  firstDecodeTime?: number;
  mediaDuration = 0;

  constructor(
    readonly input: number,
    readonly track: TrackInfo,
    readonly isVideo: boolean,
  ) {}

  /** trex defaults: sample description index, duration, size, flags. */
  defaults(): [number, number, number, number] {
    const trex = this.track.trex;
    if (!trex) return [1, 0, 0, 0];
    const p = payload(readBoxes(trex)[0]!);
    return [u32(trex, p + 8), u32(trex, p + 12), u32(trex, p + 16), u32(trex, p + 20)];
  }
}

/**
 * Reads one moof into per-track samples and chunks. Sample data stays in the
 * temp file; chunks only remember where it is.
 */
function readFragment(moof: Uint8Array, fragment: FragmentEntry, tracks: Map<number, TrackSamples>): void {
  const [moofBox] = readBoxes(moof);
  let previousTrafEnd = 0;
  for (const traf of children(moof, moofBox!).filter((b) => b.type === 'traf')) {
    const parts = children(moof, traf);
    const tfhd = parts.find((b) => b.type === 'tfhd');
    if (!tfhd) throw new Mp4Error('traf without tfhd.');
    const p = payload(tfhd);
    const flags = flagsOf(moof, tfhd);
    const samples = tracks.get(u32(moof, p + 4));
    if (!samples) throw new Mp4Error('Fragment refers to a track the init segment doesn’t have.');
    let [descriptionIndex, defaultDuration, defaultSize, defaultFlags] = samples.defaults();
    let q = p + 8;
    let base: number;
    if (flags & BASE_DATA_OFFSET) {
      // An absolute position in the source resource; make it fragment-relative.
      base = u64(moof, q) - fragment.sourceOffset;
      q += 8;
    } else {
      base = flags & DEFAULT_BASE_IS_MOOF ? 0 : previousTrafEnd;
    }
    if (flags & SAMPLE_DESCRIPTION_INDEX) (descriptionIndex = u32(moof, q)), (q += 4);
    if (flags & DEFAULT_DURATION) (defaultDuration = u32(moof, q)), (q += 4);
    if (flags & DEFAULT_SIZE) (defaultSize = u32(moof, q)), (q += 4);
    if (flags & DEFAULT_FLAGS) defaultFlags = u32(moof, q);

    // Decode times continue from the previous fragment; tfdt fixes up gaps.
    const tfdt = parts.find((b) => b.type === 'tfdt');
    const timescale = samples.track.timescale;
    if (tfdt) {
      const t = payload(tfdt);
      const decodeTime = moof[t] === 1 ? u64(moof, t + 4) : u32(moof, t + 4);
      if (samples.firstDecodeTime === undefined) {
        samples.firstDecodeTime = decodeTime;
      } else if (samples.durations.length > 0) {
        const gap = decodeTime - (samples.firstDecodeTime + samples.mediaDuration);
        const last = samples.durations.length - 1;
        const adjusted = Math.max(1, samples.durations[last]! + gap);
        samples.mediaDuration += adjusted - samples.durations[last]!;
        samples.durations[last] = adjusted;
      }
    }
    samples.firstDecodeTime ??= 0;

    let cursor = base;
    for (const trun of parts.filter((b) => b.type === 'trun')) {
      const r = payload(trun);
      const signed = moof[r] === 1;
      const runFlags = flagsOf(moof, trun);
      const count = u32(moof, r + 4);
      let at = r + 8;
      if (runFlags & DATA_OFFSET) (cursor = base + i32(moof, at)), (at += 4);
      let firstFlags: number | undefined;
      if (runFlags & FIRST_SAMPLE_FLAGS) (firstFlags = u32(moof, at)), (at += 4);
      const chunk: Chunk = {
        input: samples.input,
        offset: fragment.offset + cursor,
        length: 0,
        sampleCount: count,
        descriptionIndex,
        time: (samples.firstDecodeTime + samples.mediaDuration) / timescale,
        outputOffset: 0,
      };
      for (let i = 0; i < count; i++) {
        const duration = runFlags & SAMPLE_DURATION ? u32(moof, (at += 4) - 4) : defaultDuration;
        const size = runFlags & SAMPLE_SIZE ? u32(moof, (at += 4) - 4) : defaultSize;
        let sampleFlags = runFlags & SAMPLE_FLAGS ? u32(moof, (at += 4) - 4) : defaultFlags;
        if (i === 0 && firstFlags !== undefined) sampleFlags = firstFlags;
        const cto = runFlags & SAMPLE_CTO ? (signed ? i32(moof, (at += 4) - 4) : u32(moof, (at += 4) - 4)) : 0;
        samples.sizes.push(size);
        samples.durations.push(duration);
        samples.ctos.push(cto);
        // Audio frames are all sync samples, whatever the flags say.
        samples.syncs.push(!samples.isVideo || !(sampleFlags & NON_SYNC));
        samples.mediaDuration += duration;
        chunk.length += size;
      }
      if (cursor < fragment.moofSize || cursor + chunk.length > fragment.size) {
        throw new Mp4Error('Sample data lies outside its fragment.');
      }
      cursor += chunk.length;
      if (count > 0) samples.chunks.push(chunk);
    }
    previousTrafEnd = cursor;
  }
}

/** [count, value] pairs for runs of equal values (stts, ctts). */
function runLengths(values: number[]): [number, number][] {
  const runs: [number, number][] = [];
  for (const value of values) {
    const last = runs.at(-1);
    if (last && last[1] === value) last[0]++;
    else runs.push([1, value]);
  }
  return runs;
}

function u32Table(rows: number[][]): Uint8Array {
  const out = new Uint8Array(4 + rows.length * (rows[0]?.length ?? 0) * 4);
  setU32(out, 0, rows.length);
  let at = 4;
  for (const row of rows) for (const value of row) setU32(out, (at += 4) - 4, value >>> 0);
  return out;
}

function sampleTable(samples: TrackSamples, stsd: Uint8Array, wide: boolean, ctoShift: number): Uint8Array {
  // Box order as ffmpeg writes it (stss before ctts), the layout QuickTime is known to read.
  const boxes = [stsd, makeFullBox('stts', 0, 0, u32Table(runLengths(samples.durations)))];
  if (samples.syncs.some((sync) => !sync)) {
    const keyframes = samples.syncs.flatMap((sync, i) => (sync ? [[i + 1]] : []));
    boxes.push(makeFullBox('stss', 0, 0, u32Table(keyframes)));
  }
  if (samples.ctos.some((cto) => cto + ctoShift !== 0)) {
    boxes.push(makeFullBox('ctts', 0, 0, u32Table(runLengths(samples.ctos.map((cto) => cto + ctoShift)))));
  }
  const stsc: number[][] = [];
  samples.chunks.forEach((chunk, i) => {
    const last = stsc.at(-1);
    if (!last || last[1] !== chunk.sampleCount || last[2] !== chunk.descriptionIndex) {
      stsc.push([i + 1, chunk.sampleCount, chunk.descriptionIndex]);
    }
  });
  boxes.push(makeFullBox('stsc', 0, 0, u32Table(stsc)));
  boxes.push(makeFullBox('stsz', 0, 0, uint32Bytes(0), u32Table(samples.sizes.map((size) => [size]))));
  if (wide) {
    const co64 = new Uint8Array(4 + samples.chunks.length * 8);
    setU32(co64, 0, samples.chunks.length);
    samples.chunks.forEach((chunk, i) => setU64(co64, 4 + i * 8, chunk.outputOffset));
    boxes.push(makeFullBox('co64', 0, 0, co64));
  } else {
    boxes.push(makeFullBox('stco', 0, 0, u32Table(samples.chunks.map((chunk) => [chunk.outputOffset]))));
  }
  return makeBox('stbl', ...boxes);
}

/** Rebuilds a container box, replacing (or dropping, with null) children by type. */
function rebuild(data: Uint8Array, box: Box, replace: (child: Box) => Uint8Array | null): Uint8Array {
  const parts = children(data, box)
    .map(replace)
    .filter((part): part is Uint8Array => part !== null);
  return makeBox(box.type, ...parts);
}

function copyBox(data: Uint8Array, box: Box): Uint8Array {
  return data.slice(box.start, box.start + box.size);
}

/** Sets a full box's duration field: after creation and modification times (and timescale, for mdhd/mvhd). */
function withDuration(data: Uint8Array, box: Box, offsetV0: number, offsetV1: number, value: number): Uint8Array {
  const out = copyBox(data, box);
  const p = box.header;
  if (out[p] === 1) setU64(out, p + offsetV1, value);
  else setU32(out, p + offsetV0, Math.min(value, 0xffffffff));
  return out;
}

interface TrackPlan {
  samples: TrackSamples;
  /** Media time (track timescale, our timeline) that shows at the edit's start. */
  mediaTime: number;
  /** Media time the edit runs for: up to the end of the last frame shown. */
  visibleDuration: number;
  /** Movie-timescale delay before this track starts, relative to the earliest track. */
  delay: number;
  ctoShift: number;
}

function buildTrak(plan: TrackPlan, id: number, movieTimescale: number, wide: boolean): Uint8Array {
  const { samples, mediaTime, delay, ctoShift } = plan;
  const data = samples.track.trak;
  const [trak] = readBoxes(data);
  const editDuration = movieUnits(plan, movieTimescale);
  const trackDuration = delay + editDuration;

  const edits: number[][] = [];
  if (delay > 0) edits.push([delay, 0xffffffff, 0x00010000]); // empty edit: media_time -1
  if (delay > 0 || mediaTime !== 0) edits.push([editDuration, mediaTime, 0x00010000]);
  const edts = edits.length > 0 ? makeBox('edts', makeFullBox('elst', 0, 0, u32Table(edits))) : null;

  const parts: Uint8Array[] = [];
  for (const box of children(data, trak!)) {
    if (box.type === 'tkhd') {
      const tkhd = withDuration(data, box, 20, 28, trackDuration);
      setU32(tkhd, trackIdOffset(tkhd, { ...box, start: 0 }), id);
      tkhd[box.header + 3]! |= 0x03; // enabled, in movie
      parts.push(tkhd);
      if (edts) parts.push(edts);
    } else if (box.type === 'edts') {
      // replaced above
    } else if (box.type === 'mdia') {
      parts.push(
        rebuild(data, box, (mdiaChild) => {
          if (mdiaChild.type === 'mdhd') return withDuration(data, mdiaChild, 16, 24, samples.mediaDuration);
          if (mdiaChild.type !== 'minf') return copyBox(data, mdiaChild);
          return rebuild(data, mdiaChild, (minfChild) => {
            if (minfChild.type !== 'stbl') return copyBox(data, minfChild);
            const stsd = child(data, minfChild, 'stsd');
            if (!stsd) throw new Mp4Error('Track has no sample descriptions.');
            return sampleTable(samples, copyBox(data, stsd), wide, ctoShift);
          });
        }),
      );
    } else {
      parts.push(copyBox(data, box));
    }
  }
  return makeBox('trak', ...parts);
}

/** The first edit's media_time in the source init, if it has a simple one. */
function sourceMediaTime(track: TrackInfo): number | undefined {
  const [trak] = readBoxes(track.trak);
  const edts = child(track.trak, trak!, 'edts');
  const elst = edts && child(track.trak, edts, 'elst');
  if (!elst) return undefined;
  const p = payload(elst);
  const v1 = track.trak[p] === 1;
  const count = u32(track.trak, p + 4);
  for (let i = 0; i < count; i++) {
    const at = p + 8 + i * (v1 ? 20 : 12);
    const mediaTime = v1 ? Number(new DataView(track.trak.buffer, track.trak.byteOffset).getBigInt64(at + 8)) : i32(track.trak, at + 4);
    if (mediaTime >= 0) return mediaTime;
  }
  return undefined;
}

function movieUnits(plan: TrackPlan, movieTimescale: number): number {
  return Math.round((plan.visibleDuration / plan.samples.track.timescale) * movieTimescale);
}

function ftyp(hasAvc: boolean): Uint8Array {
  return makeBox('ftyp', ascii('isom'), uint32Bytes(0x200), ascii(`isomiso2${hasAvc ? 'avc1' : ''}mp41`));
}

/**
 * Writes a standard (non-fragmented) MP4 holding every input's tracks:
 * ftyp, then moov with full sample tables, then one mdat with the tracks'
 * chunks interleaved by decode time. This is the layout `ffmpeg -c copy`
 * writes, which every player (QuickTime included) opens; no samples are
 * decoded or re-encoded.
 */
export async function mergeTracks(inputs: MergeInput[], out: ByteSink): Promise<number> {
  if (inputs.length === 0) throw new Mp4Error('Nothing to merge.');
  if (inputs.some((input) => input.init.encrypted)) throw new Mp4Error('The stream is DRM-protected.');

  // 1. Read every moof into sample lists.
  const all: TrackSamples[] = [];
  for (const [index, input] of inputs.entries()) {
    const tracks = new Map<number, TrackSamples>();
    for (const track of input.init.tracks) {
      const samples = new TrackSamples(index, track, track.handler === 'vide');
      tracks.set(track.id, samples);
      all.push(samples);
    }
    for (const fragment of input.fragments) {
      readFragment(await input.read(fragment.offset, fragment.moofSize), fragment, tracks);
    }
  }
  const used = all.filter((samples) => samples.sizes.length > 0);
  if (used.length === 0) throw new Mp4Error('The stream has no samples.');

  // 2. Timing. Our timeline starts each track's first sample at decode time
  // 0; the edit list picks the first media time to show (skipping encoder
  // priming and B-frame delay), and an empty edit delays a track that
  // starts later than the others.
  const movieTimescale = inputs[0]!.init.movieTimescale;
  const plans = used.map((samples): TrackPlan => {
    // Loops, not Math.min(...array): long videos have hundreds of thousands of samples.
    let minCto = 0;
    for (const cto of samples.ctos) minCto = Math.min(minCto, cto);
    const ctoShift = -minCto; // ctts v0 can't hold negative offsets
    let firstShown = Infinity;
    let lastShownEnd = 0;
    let dts = 0;
    for (let i = 0; i < samples.ctos.length; i++) {
      const pts = dts + samples.ctos[i]! + ctoShift;
      firstShown = Math.min(firstShown, pts);
      lastShownEnd = Math.max(lastShownEnd, pts + samples.durations[i]!);
      dts += samples.durations[i]!;
    }
    // A source edit counts media time from its own zero; ours starts at the first fragment.
    const sourceEdit = sourceMediaTime(samples.track);
    const mediaTime =
      sourceEdit === undefined ? firstShown : Math.max(0, sourceEdit - samples.firstDecodeTime!) + ctoShift;
    return { samples, mediaTime, visibleDuration: Math.max(0, lastShownEnd - mediaTime), delay: 0, ctoShift };
  });
  // Where each track's edit starts on the shared timeline, in seconds: the
  // source's own edit maps its media time to 0; without one, media time is
  // presentation time.
  const starts = plans.map((plan) => {
    const sourceEdit = sourceMediaTime(plan.samples.track) ?? 0;
    const firstDecodeTime = plan.samples.firstDecodeTime!;
    return (firstDecodeTime + plan.mediaTime - plan.ctoShift - sourceEdit) / plan.samples.track.timescale;
  });
  const earliest = Math.min(...starts);
  plans.forEach((plan, i) => (plan.delay = Math.round((starts[i]! - earliest) * movieTimescale)));

  // 3. Interleave chunks by time, then lay out mdat.
  const chunks = used
    .flatMap((samples, track) => samples.chunks.map((chunk, n) => ({ chunk, track, n })))
    .sort((a, b) => a.chunk.time - b.chunk.time || a.track - b.track || a.n - b.n)
    .map(({ chunk }) => chunk);
  const dataLength = chunks.reduce((n, chunk) => n + chunk.length, 0);
  const mdatHeader = dataLength + 8 > 0xffffffff ? 16 : 8;

  const head = ftyp(used.some((s) => s.track.codec === 'avc1' || s.track.codec === 'avc3'));
  const buildMoov = (wide: boolean, dataStart: number): Uint8Array => {
    let at = dataStart;
    for (const chunk of chunks) (chunk.outputOffset = at), (at += chunk.length);
    const traks = plans.map((plan, i) => buildTrak(plan, i + 1, movieTimescale, wide));
    const movieDuration = Math.max(...plans.map((plan) => plan.delay + movieUnits(plan, movieTimescale)));
    const mvhdSource = inputs[0]!.init.mvhd;
    const [mvhdBox] = readBoxes(mvhdSource);
    const mvhd = withDuration(mvhdSource, mvhdBox!, 16, 24, movieDuration);
    setU32(mvhd, mvhd.length - 4, plans.length + 1); // next_track_ID
    return makeBox('moov', mvhd, ...traks);
  };
  // Offsets don't change the moov's size, so size it first, then fill them in.
  let wide = false;
  let moov = buildMoov(wide, 0);
  if (head.length + moov.length + mdatHeader + dataLength > 0xffffffff) {
    wide = true;
    moov = buildMoov(wide, 0);
  }
  const dataStart = head.length + moov.length + mdatHeader;
  moov = buildMoov(wide, dataStart);

  // 4. Write it out, copying sample data straight from the temp files.
  const header = new Uint8Array(mdatHeader);
  if (mdatHeader === 16) {
    setU32(header, 0, 1);
    setU64(header, 8, dataLength + 16);
  } else {
    setU32(header, 0, dataLength + 8);
  }
  header.set(ascii('mdat'), 4);
  await out.write(concat([head, moov, header]));
  for (const chunk of chunks) {
    await out.write(await inputs[chunk.input]!.read(chunk.offset, chunk.length));
  }
  return dataStart + dataLength;
}
