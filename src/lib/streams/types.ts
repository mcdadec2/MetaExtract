/** One selectable quality of a stream. */
export interface Rendition {
  /** Stable within its manifest: the variant URL (HLS) or Representation id (DASH). */
  id: string;
  label: string;
  width?: number;
  height?: number;
  /** Bits per second, video plus audio when the manifest says so. */
  bandwidth?: number;
  codecs?: string;
}

/** Why a stream can't be saved. */
export type StreamBlock = 'drm' | 'live' | 'empty';

/** What the popup needs to offer a stream: its qualities, or why it can't be saved. */
export interface StreamInfo {
  blocked?: StreamBlock;
  /** Seconds, when the manifest says. */
  duration?: number;
  /** Best first. */
  renditions: Rendition[];
  /** Media playlists a master playlist points to; they aren't listed separately. */
  childUrls: string[];
}

export interface ByteRange {
  offset: number;
  length: number;
}

export interface SegmentRef {
  url: string;
  range?: ByteRange;
  /** HLS AES-128: key URL and IV (derived from the media sequence when absent). */
  key?: { url: string; iv: Uint8Array };
}

/**
 * One media stream to download. `fmp4` tracks either have an init segment
 * plus fragments, or (DASH SegmentBase) a single complete file as their only
 * segment. `ts` tracks are MPEG-TS (or packed audio) and get transmuxed.
 */
export interface TrackPlan {
  content: 'muxed' | 'video' | 'audio';
  container: 'ts' | 'fmp4';
  init?: SegmentRef;
  segments: SegmentRef[];
}

export interface DownloadPlan {
  tracks: TrackPlan[];
  duration?: number;
  width?: number;
  height?: number;
}

export type FetchText = (url: string) => Promise<string>;

export class StreamError extends Error {
  constructor(
    message: string,
    readonly block?: StreamBlock,
  ) {
    super(message);
  }
}

export const BLOCK_MESSAGES: Record<StreamBlock, string> = {
  drm: 'This stream is DRM-protected, so it can’t be saved.',
  live: 'Live streams can’t be saved yet.',
  empty: 'This stream has no playable media.',
};

export function qualityLabel(height?: number, bandwidth?: number): string {
  const parts: string[] = [];
  if (height) parts.push(`${height}p`);
  if (bandwidth) {
    parts.push(
      bandwidth >= 1_000_000
        ? `${(bandwidth / 1_000_000).toFixed(1)} Mbps`
        : `${Math.round(bandwidth / 1000)} kbps`,
    );
  }
  return parts.join(' · ') || 'Default quality';
}

export function resolveUrl(url: string, base: string): string {
  return new URL(url, base).href;
}
