/** ISO BMFF (MP4) box primitives. Offsets are into the Uint8Array passed in. */
export interface Box {
  type: string;
  start: number;
  size: number;
  /** 8, or 16 when the size is a 64-bit "largesize". */
  header: number;
}

export class Mp4Error extends Error {}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

export function u32(data: Uint8Array, offset: number): number {
  return view(data).getUint32(offset);
}

export function u64(data: Uint8Array, offset: number): number {
  return Number(view(data).getBigUint64(offset));
}

export function setU32(data: Uint8Array, offset: number, value: number): void {
  view(data).setUint32(offset, value);
}

export function setU64(data: Uint8Array, offset: number, value: number): void {
  view(data).setBigUint64(offset, BigInt(value));
}

export function fourcc(data: Uint8Array, offset: number): string {
  return String.fromCharCode(data[offset]!, data[offset + 1]!, data[offset + 2]!, data[offset + 3]!);
}

/** Box size and header length from the first bytes of a box, or undefined if more bytes are needed. */
export function readHeader(data: Uint8Array, offset = 0): { type: string; size: number; header: number } | undefined {
  if (data.length - offset < 8) return undefined;
  const size32 = u32(data, offset);
  const type = fourcc(data, offset + 4);
  if (size32 === 1) {
    if (data.length - offset < 16) return undefined;
    return { type, size: u64(data, offset + 8), header: 16 };
  }
  // 0 means "to the end of the file"; only valid for the last box.
  return { type, size: size32 === 0 ? Infinity : size32, header: 8 };
}

export function readBoxes(data: Uint8Array, start = 0, end = data.length): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset < end) {
    const header = readHeader(data.subarray(0, end), offset);
    if (!header) throw new Mp4Error(`Truncated box header at ${offset}.`);
    const size = header.size === Infinity ? end - offset : header.size;
    if (size < header.header || offset + size > end) {
      throw new Mp4Error(`Box ${header.type} at ${offset} has a bad size (${size}).`);
    }
    boxes.push({ type: header.type, start: offset, size, header: header.header });
    offset += size;
  }
  return boxes;
}

export function payload(box: Box): number {
  return box.start + box.header;
}

/** Children of a container box. `skip` jumps fields before the children (e.g. 8 for stsd). */
export function children(data: Uint8Array, box: Box, skip = 0): Box[] {
  return readBoxes(data, payload(box) + skip, box.start + box.size);
}

export function child(data: Uint8Array, box: Box, type: string, skip = 0): Box | undefined {
  return children(data, box, skip).find((b) => b.type === type);
}

/** Follows a path of box types from `box`, e.g. ['mdia', 'mdhd']. */
export function descend(data: Uint8Array, box: Box, path: string[]): Box | undefined {
  let current: Box | undefined = box;
  for (const type of path) {
    if (!current) return undefined;
    current = child(data, current, type);
  }
  return current;
}

export function bytesOf(data: Uint8Array, box: Box): Uint8Array {
  return data.slice(box.start, box.start + box.size);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

export function uint32Bytes(value: number): Uint8Array {
  const out = new Uint8Array(4);
  setU32(out, 0, value);
  return out;
}

export function makeBox(type: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([uint32Bytes(body.length + 8), ascii(type), body]);
}

/** A full box: version, 24-bit flags, then the fields. */
export function makeFullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return makeBox(type, Uint8Array.of(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
}
