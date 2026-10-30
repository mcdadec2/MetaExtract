import { children, concat, Mp4Error, payload, readBoxes, readHeader, u32, u64 } from './box';
import { parseInit, type InitInfo } from './init';

export interface ByteSink {
  write(data: Uint8Array): Promise<void>;
}

/** Where one moof+mdat pair landed in the track's temp file. */
export interface FragmentEntry {
  offset: number;
  size: number;
  /** Earliest decode time in the fragment, in seconds. */
  time: number;
  /** The moof's position in the resource it came from (for absolute data offsets). */
  sourceOffset: number;
}

/** Boxes we need whole. Anything else except mdat is skipped as it streams past. */
const BUFFERED = new Set(['ftyp', 'moov', 'moof']);
const MAX_BUFFERED_BOX = 64 * 1024 * 1024;

type State =
  | { kind: 'header' }
  | { kind: 'buffer'; type: string; bytes: Uint8Array; filled: number; start: number }
  | { kind: 'stream'; remaining: number }
  | { kind: 'skip'; remaining: number };

/**
 * Splits a fragmented MP4 byte stream (one or more resources, pushed in
 * arbitrary chunks) into its init segment and moof+mdat fragments. Fragments
 * are written to `sink` as they arrive, so mdat payloads never sit in memory;
 * styp, sidx and other boxes are dropped.
 */
export class FragmentCollector {
  init?: InitInfo;
  readonly fragments: FragmentEntry[] = [];
  private state: State = { kind: 'header' };
  private headerBytes: Uint8Array = new Uint8Array(0);
  private written = 0;
  private resourcePos = 0;
  private open?: FragmentEntry;

  constructor(private readonly sink: ByteSink) {}

  /** Call at the start of each fetched resource (segment or file). */
  startResource(): void {
    this.resourcePos = 0;
  }

  async push(chunk: Uint8Array): Promise<void> {
    let i = 0;
    while (i < chunk.length) {
      const state = this.state;
      if (state.kind === 'header') {
        const needed = Math.min(16 - this.headerBytes.length, chunk.length - i);
        const candidate = concat([this.headerBytes, chunk.subarray(i, i + needed)]);
        const header = readHeader(candidate);
        if (!header) {
          this.headerBytes = candidate;
          i += needed;
          continue;
        }
        // Consume only the header's own bytes from this chunk.
        const used = header.header - this.headerBytes.length;
        i += used;
        this.headerBytes = new Uint8Array(0);
        const headerBytes = candidate.subarray(0, header.header);
        const boxStart = this.resourcePos;
        this.resourcePos += header.header;
        await this.beginBox(header.type, header.size, headerBytes, boxStart);
        continue;
      }
      const remaining = state.kind === 'buffer' ? state.bytes.length - state.filled : state.remaining;
      const take = Math.min(remaining, chunk.length - i);
      const piece = chunk.subarray(i, i + take);
      i += take;
      this.resourcePos += take;
      if (state.kind === 'buffer') {
        state.bytes.set(piece, state.filled);
        state.filled += take;
        if (state.filled === state.bytes.length) {
          this.state = { kind: 'header' };
          await this.endBufferedBox(state.type, state.bytes, state.start);
        }
      } else {
        if (state.kind === 'stream') await this.write(piece);
        state.remaining -= take;
        if (state.remaining === 0) {
          this.state = { kind: 'header' };
          if (state.kind === 'stream') this.closeFragment();
        }
      }
    }
  }

  /** Call once all resources are pushed. */
  end(): void {
    if (this.state.kind === 'stream' && this.state.remaining === Infinity) {
      this.state = { kind: 'header' };
      this.closeFragment();
    }
    if (this.state.kind !== 'header' || this.headerBytes.length > 0) {
      throw new Mp4Error('The stream ended in the middle of a box.');
    }
    if (this.open) throw new Mp4Error('The stream ended after a moof without its mdat.');
    if (!this.init) throw new Mp4Error('The stream has no init segment (moov).');
  }

  private async write(data: Uint8Array): Promise<void> {
    await this.sink.write(data);
    this.written += data.length;
  }

  private async beginBox(type: string, size: number, header: Uint8Array, start: number): Promise<void> {
    const remaining = size - header.length;
    if (type === 'mdat') {
      if (!this.open) throw new Mp4Error('Found media data outside a fragment; this isn’t a fragmented MP4.');
      await this.write(header);
      this.state = { kind: 'stream', remaining };
      if (remaining === 0) {
        this.state = { kind: 'header' };
        this.closeFragment();
      }
    } else if (BUFFERED.has(type)) {
      if (size > MAX_BUFFERED_BOX) throw new Mp4Error(`The ${type} box is too large.`);
      const bytes = new Uint8Array(size);
      bytes.set(header);
      this.state = { kind: 'buffer', type, bytes, filled: header.length, start };
      if (remaining === 0) {
        this.state = { kind: 'header' };
        await this.endBufferedBox(type, bytes, start);
      }
    } else {
      this.state = { kind: 'skip', remaining };
    }
  }

  private async endBufferedBox(type: string, bytes: Uint8Array, start: number): Promise<void> {
    if (type === 'moov') {
      // Repeated init segments (one per DASH segment, say) are identical; keep the first.
      this.init ??= parseInit(bytes);
    } else if (type === 'moof') {
      if (!this.init) throw new Mp4Error('Found a fragment before the init segment.');
      if (this.open) throw new Mp4Error('Found a moof without its mdat.');
      this.open = { offset: this.written, size: 0, time: fragmentTime(bytes, this.init), sourceOffset: start };
      await this.write(bytes);
    }
  }

  private closeFragment(): void {
    const fragment = this.open!;
    fragment.size = this.written - fragment.offset;
    this.fragments.push(fragment);
    this.open = undefined;
  }
}

/** Earliest tfdt across the fragment's tracks, in seconds; 0 when absent. */
export function fragmentTime(moof: Uint8Array, init: InitInfo): number {
  const [box] = readBoxes(moof);
  let earliest = Infinity;
  for (const traf of children(moof, box!).filter((b) => b.type === 'traf')) {
    const parts = children(moof, traf);
    const tfhd = parts.find((b) => b.type === 'tfhd');
    const tfdt = parts.find((b) => b.type === 'tfdt');
    if (!tfhd || !tfdt) continue;
    const trackId = u32(moof, payload(tfhd) + 4);
    const timescale = init.tracks.find((t) => t.id === trackId)?.timescale;
    if (!timescale) continue;
    const p = payload(tfdt);
    const decodeTime = moof[p] === 1 ? u64(moof, p + 4) : u32(moof, p + 4);
    earliest = Math.min(earliest, decodeTime / timescale);
  }
  return earliest === Infinity ? 0 : earliest;
}
