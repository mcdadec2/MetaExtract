import { concat } from '../../src/lib/mp4/box';

/** In-memory stand-in for an OPFS temp file. */
export class MemoryFile {
  private parts: Uint8Array[] = [];
  private joined?: Uint8Array;

  async write(data: Uint8Array): Promise<void> {
    this.parts.push(data.slice());
    this.joined = undefined;
  }

  bytes(): Uint8Array {
    return (this.joined ??= concat(this.parts));
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes().slice(offset, offset + length);
  }
}

/** In-memory TempStorage; `files` shows what is left behind after a job. */
export class MemoryStorage {
  readonly files = new Map<string, MemoryFile & { close(): Promise<void> }>();

  async create(name: string) {
    const file = Object.assign(new MemoryFile(), { close: async () => {} });
    this.files.set(name, file);
    return file;
  }

  async remove(name: string): Promise<void> {
    this.files.delete(name);
  }
}
