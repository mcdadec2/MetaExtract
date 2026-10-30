import {
  ascii,
  child,
  children,
  concat,
  descend,
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
} from './box';
import type { ByteSink, FragmentEntry } from './collector';
import { trackIdOffset, type InitInfo } from './init';

/** One collected stream: its init info, and its fragments in a readable temp file. */
export interface MergeInput {
  init: InitInfo;
  fragments: FragmentEntry[];
  read(offset: number, length: number): Promise<Uint8Array>;
}

const TFHD_BASE_DATA_OFFSET = 0x000001;

function ftyp(): Uint8Array {
  return makeBox('ftyp', ascii('isom'), uint32Bytes(0x200), ascii('isomiso2iso6mp41'));
}

/** Copies a trak with a new track id, rescaling movie-timescale durations if needed. */
function retrack(trak: Uint8Array, newId: number, scale: number): Uint8Array {
  const out = trak.slice();
  const [box] = readBoxes(out);
  const tkhd = child(out, box!, 'tkhd')!;
  setU32(out, trackIdOffset(out, tkhd), newId);
  if (scale !== 1) {
    const p = payload(tkhd);
    if (out[p] === 1) setU64(out, p + 28, Math.round(u64(out, p + 28) * scale));
    else setU32(out, p + 20, Math.round(u32(out, p + 20) * scale));
    const elst = descend(out, box!, ['edts', 'elst']);
    if (elst) {
      const e = payload(elst);
      const v1 = out[e] === 1;
      const count = u32(out, e + 4);
      for (let i = 0; i < count; i++) {
        const at = e + 8 + i * (v1 ? 20 : 12);
        if (v1) setU64(out, at, Math.round(u64(out, at) * scale));
        else setU32(out, at, Math.round(u32(out, at) * scale));
      }
    }
  }
  return out;
}

function trex(source: Uint8Array | undefined, newId: number): Uint8Array {
  if (!source) {
    // Defaults: first sample description, everything else zero.
    return makeFullBox('trex', 0, 0, uint32Bytes(newId), uint32Bytes(1), new Uint8Array(12));
  }
  const out = source.slice();
  setU32(out, payload(readBoxes(out)[0]!) + 4, newId);
  return out;
}

/** Builds one moov holding every track of every input, numbered 1..n. */
export function mergedInit(inputs: InitInfo[], durationSeconds?: number): {
  bytes: Uint8Array;
  idMaps: Map<number, number>[];
} {
  const first = inputs[0];
  if (!first) throw new Mp4Error('Nothing to merge.');
  const timescale = first.movieTimescale;
  const idMaps: Map<number, number>[] = [];
  const traks: Uint8Array[] = [];
  const trexes: Uint8Array[] = [];
  let nextId = 1;
  for (const init of inputs) {
    const map = new Map<number, number>();
    for (const track of init.tracks) {
      map.set(track.id, nextId);
      traks.push(retrack(track.trak, nextId, timescale / init.movieTimescale));
      trexes.push(trex(track.trex, nextId));
      nextId++;
    }
    idMaps.push(map);
  }

  const mvhd = first.mvhd.slice();
  setU32(mvhd, mvhd.length - 4, nextId); // next_track_ID is mvhd's last field

  const mvexParts: Uint8Array[] = [];
  if (durationSeconds && durationSeconds > 0) {
    // mehd: the whole presentation's duration, which players show.
    const units = Math.round(durationSeconds * timescale);
    if (units > 0xffffffff) {
      const field = new Uint8Array(8);
      setU64(field, 0, units);
      mvexParts.push(makeFullBox('mehd', 1, 0, field));
    } else {
      mvexParts.push(makeFullBox('mehd', 0, 0, uint32Bytes(units)));
    }
  }
  mvexParts.push(...trexes);

  return { bytes: concat([ftyp(), makeBox('moov', mvhd, ...traks, makeBox('mvex', ...mvexParts))]), idMaps };
}

/**
 * Rewrites a moof (at the start of `fragment`) for the merged file: new
 * track ids, a new sequence number, and absolute data offsets moved by
 * `offsetDelta`.
 */
export function rewriteFragment(
  fragment: Uint8Array,
  idMap: Map<number, number>,
  sequence: number,
  offsetDelta: number,
): Uint8Array {
  const out = fragment.slice();
  const [moof, mdat] = readBoxes(out);
  if (!moof || moof.type !== 'moof') throw new Mp4Error('Fragment does not start with a moof.');
  // An mdat sized "to end of file" must get its real size once it isn't last.
  if (mdat && u32(out, mdat.start) === 0) {
    if (mdat.size > 0xffffffff) throw new Mp4Error('Unsized mdat is too large to rewrite.');
    setU32(out, mdat.start, mdat.size);
  }
  for (const box of children(out, moof)) {
    if (box.type === 'mfhd') setU32(out, payload(box) + 4, sequence);
    if (box.type !== 'traf') continue;
    const tfhd = child(out, box, 'tfhd');
    if (!tfhd) throw new Mp4Error('traf without tfhd.');
    const p = payload(tfhd);
    const newId = idMap.get(u32(out, p + 4));
    if (newId === undefined) throw new Mp4Error('Fragment refers to a track the init segment doesn’t have.');
    setU32(out, p + 4, newId);
    const flags = (out[p + 1]! << 16) | (out[p + 2]! << 8) | out[p + 3]!;
    if (flags & TFHD_BASE_DATA_OFFSET) setU64(out, p + 8, u64(out, p + 8) + offsetDelta);
  }
  return out;
}

/**
 * Writes one fragmented MP4 holding every input's tracks, with fragments
 * interleaved by decode time so players can stream it front to back.
 */
export async function mergeTracks(inputs: MergeInput[], out: ByteSink, durationSeconds?: number): Promise<number> {
  if (inputs.some((input) => input.init.encrypted)) throw new Mp4Error('The stream is DRM-protected.');
  const { bytes: head, idMaps } = mergedInit(
    inputs.map((input) => input.init),
    durationSeconds,
  );
  await out.write(head);
  let position = head.length;

  const order = inputs
    .flatMap((input, index) => input.fragments.map((fragment, n) => ({ fragment, index, n })))
    .sort((a, b) => a.fragment.time - b.fragment.time || a.index - b.index || a.n - b.n);

  let sequence = 1;
  for (const { fragment, index } of order) {
    const bytes = await inputs[index]!.read(fragment.offset, fragment.size);
    const rewritten = rewriteFragment(bytes, idMaps[index]!, sequence++, position - fragment.sourceOffset);
    await out.write(rewritten);
    position += rewritten.length;
  }
  return position;
}
