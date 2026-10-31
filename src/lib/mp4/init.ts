import { bytesOf, child, children, descend, fourcc, Mp4Error, payload, readBoxes, u32, type Box } from './box';

export interface TrackInfo {
  id: number;
  /** mdhd timescale: units per second for this track's sample times. */
  timescale: number;
  /** 'vide', 'soun', … */
  handler: string;
  /** First sample entry type: 'avc1', 'mp4a', … */
  codec: string;
  trak: Uint8Array;
  trex?: Uint8Array;
}

export interface InitInfo {
  mvhd: Uint8Array;
  /** mvhd timescale, used by tkhd and elst durations. */
  movieTimescale: number;
  tracks: TrackInfo[];
  /** Encrypted sample entries or pssh boxes: DRM, can't be saved. */
  encrypted: boolean;
}

/** mvhd and mdhd share the layout up to the timescale. */
function timescaleOf(data: Uint8Array, box: Box): number {
  const p = payload(box);
  return u32(data, p + (data[p] === 1 ? 20 : 12));
}

export function trackIdOffset(data: Uint8Array, tkhd: Box): number {
  const p = payload(tkhd);
  return p + (data[p] === 1 ? 20 : 12);
}

const ENCRYPTED_ENTRIES = new Set(['encv', 'enca', 'enct', 'encs']);

/** Reads the parts of a moov box needed to merge it with others. */
export function parseInit(moovBytes: Uint8Array): InitInfo {
  const [moov] = readBoxes(moovBytes);
  if (!moov || moov.type !== 'moov') throw new Mp4Error('Init segment has no moov box.');
  const top = children(moovBytes, moov);
  const mvhd = top.find((b) => b.type === 'mvhd');
  if (!mvhd) throw new Mp4Error('moov has no mvhd box.');
  let encrypted = top.some((b) => b.type === 'pssh');

  const trexById = new Map<number, Uint8Array>();
  const mvex = top.find((b) => b.type === 'mvex');
  for (const trex of mvex ? children(moovBytes, mvex).filter((b) => b.type === 'trex') : []) {
    trexById.set(u32(moovBytes, payload(trex) + 4), bytesOf(moovBytes, trex));
  }

  const tracks = top
    .filter((b) => b.type === 'trak')
    .map((trak): TrackInfo => {
      const tkhd = child(moovBytes, trak, 'tkhd');
      const mdhd = descend(moovBytes, trak, ['mdia', 'mdhd']);
      const hdlr = descend(moovBytes, trak, ['mdia', 'hdlr']);
      const stsd = descend(moovBytes, trak, ['mdia', 'minf', 'stbl', 'stsd']);
      if (!tkhd || !mdhd || !hdlr || !stsd) throw new Mp4Error('Incomplete trak box.');
      // stsd: version/flags and entry count precede the sample entries.
      const entries = children(moovBytes, stsd, 8);
      if (entries.some((entry) => ENCRYPTED_ENTRIES.has(entry.type))) encrypted = true;
      const id = u32(moovBytes, trackIdOffset(moovBytes, tkhd));
      return {
        id,
        timescale: timescaleOf(moovBytes, mdhd),
        handler: fourcc(moovBytes, payload(hdlr) + 8),
        codec: entries[0]?.type ?? '',
        trak: bytesOf(moovBytes, trak),
        trex: trexById.get(id),
      };
    });
  if (tracks.length === 0) throw new Mp4Error('moov has no tracks.');
  return { mvhd: bytesOf(moovBytes, mvhd), movieTimescale: timescaleOf(moovBytes, mvhd), tracks, encrypted };
}
