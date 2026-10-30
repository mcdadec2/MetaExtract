// Minimal declarations for untyped video.js libraries; only what we use.

declare module 'm3u8-parser' {
  export class Parser {
    manifest: unknown;
    push(chunk: string): void;
    end(): void;
  }
}

declare module 'mpd-parser' {
  export function parse(manifest: string, options?: { manifestUri?: string }): unknown;
}

declare module 'mux.js/lib/mp4/transmuxer' {
  export interface TransmuxedSegment {
    initSegment: Uint8Array;
    data: Uint8Array;
  }
  export class Transmuxer {
    constructor(options?: { remux?: boolean; keepOriginalTimestamps?: boolean });
    on(event: 'data', listener: (segment: TransmuxedSegment) => void): void;
    on(event: 'done', listener: () => void): void;
    push(bytes: Uint8Array): void;
    flush(): void;
  }
}
