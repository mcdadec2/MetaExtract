import type { DetectionSource, MediaCandidate } from './types';

/**
 * The JSON written next to each saved video. Fields a source can't provide
 * yet are null, so the shape stays the same as site adapters fill more in.
 */
export interface Sidecar {
  schemaVersion: 1;
  site: string;
  /** post, reel, story, … once site adapters exist; generic pages are 'page'. */
  kind: string;
  postUrl: string | null;
  author: string | null;
  title: string | null;
  caption: string | null;
  publishedAt: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  expiresAt: string | null;
  mediaUrl: string;
  mimeType: string | null;
  size: number | null;
  sourceTier: DetectionSource;
  savedAt: string;
}

export function siteName(pageUrl: string | undefined, mediaUrl: string): string {
  for (const url of [pageUrl, mediaUrl]) {
    if (!url) continue;
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // try the next one
    }
  }
  return 'unknown';
}

export function buildSidecar(candidate: MediaCandidate, savedAt: Date): Sidecar {
  return {
    schemaVersion: 1,
    site: siteName(candidate.pageUrl, candidate.url),
    kind: 'page',
    postUrl: candidate.pageUrl ?? null,
    author: null,
    title: candidate.pageTitle ?? null,
    caption: null,
    publishedAt: null,
    duration: null,
    width: null,
    height: null,
    expiresAt: null,
    mediaUrl: candidate.url,
    mimeType: candidate.mimeType ?? null,
    size: candidate.size ?? null,
    sourceTier: candidate.source,
    savedAt: savedAt.toISOString(),
  };
}

/** chrome.downloads can't take a Blob from a service worker, so use a data: URL. */
export function sidecarDataUrl(sidecar: Sidecar): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sidecar, null, 2));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:application/json;base64,${btoa(binary)}`;
}
