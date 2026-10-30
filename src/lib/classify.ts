import type { MediaKind } from './types';

/** Stream fragments: never listed themselves, their playlist is. */
export type Classification = MediaKind | 'segment' | null;

const HLS_TYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
]);
const DASH_TYPES = new Set(['application/dash+xml']);
const SEGMENT_TYPES = new Set(['video/mp2t', 'video/iso.segment', 'audio/iso.segment']);

const EXTENSIONS: Record<string, Classification> = {
  m3u8: 'hls',
  mpd: 'dash',
  mp4: 'progressive',
  m4v: 'progressive',
  webm: 'progressive',
  mov: 'progressive',
  mkv: 'progressive',
  ts: 'segment',
  m4s: 'segment',
};

export function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
}

/** Lower-cased extension of the URL's last path segment, or ''. */
export function urlExtension(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return '';
  }
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : '';
}

export function baseMimeType(contentType: string | undefined): string {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * Decides whether a URL (plus its Content-Type, when known) is media we can
 * list. The Content-Type wins over the extension, except for generic types
 * like application/octet-stream that servers use for everything.
 */
export function classifyMedia(url: string, contentType?: string): Classification {
  if (!isHttpUrl(url)) return null;
  const mime = baseMimeType(contentType);
  if (HLS_TYPES.has(mime)) return 'hls';
  if (DASH_TYPES.has(mime)) return 'dash';
  if (SEGMENT_TYPES.has(mime)) return 'segment';
  const byExtension = EXTENSIONS[urlExtension(url)] ?? null;
  if (mime.startsWith('video/')) return byExtension === 'segment' ? 'segment' : 'progressive';
  if (mime === '' || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    return byExtension;
  }
  return null;
}

/**
 * Total resource size from response headers. A 206 response's Content-Length
 * is only the requested range, so Content-Range's total is preferred.
 */
export function totalSize(headers: { name: string; value?: string }[]): number | undefined {
  let length: number | undefined;
  for (const { name, value } of headers) {
    const lower = name.toLowerCase();
    if (lower === 'content-range' && value) {
      const total = /\/(\d+)\s*$/.exec(value)?.[1];
      if (total) return Number(total);
    } else if (lower === 'content-length' && value && /^\d+$/.test(value.trim())) {
      length = Number(value.trim());
    }
  }
  return length;
}
