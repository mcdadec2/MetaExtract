import { browser } from 'wxt/browser';
import { classifyMedia, isHttpUrl } from './classify';
import type { DomMediaReport, MediaCandidate } from './types';

export type Request =
  | { type: 'media/list'; tabId: number }
  | { type: 'media/download'; tabId: number; id: string }
  | { type: 'media/report'; items: DomMediaReport[] };

export type DownloadResult = { ok: true } | { ok: false; error: string };

export interface ResponseFor {
  'media/list': MediaCandidate[];
  'media/download': DownloadResult;
  'media/report': void;
}

/** Broadcast from the background when a tab's list changes, so an open popup refreshes. */
export interface MediaChangedEvent {
  type: 'media/changed';
  tabId: number;
}

const MAX_REPORT_ITEMS = 50;
const MAX_URL_LENGTH = 8192;
const MAX_TITLE_LENGTH = 500;

/**
 * Content scripts relay data from the page's DOM, which the page controls.
 * Keep only well-formed http(s) media URLs and bound every string.
 */
export function validateReport(items: unknown): DomMediaReport[] {
  if (!Array.isArray(items)) return [];
  const valid: DomMediaReport[] = [];
  for (const item of items.slice(0, MAX_REPORT_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    const { url, kind, mimeType, pageUrl, pageTitle } = item as Record<string, unknown>;
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH || !isHttpUrl(url)) continue;
    if (kind !== 'progressive' && kind !== 'hls' && kind !== 'dash') continue;
    // The URL's own extension must not contradict the claimed kind.
    const byUrl = classifyMedia(url);
    if (byUrl !== null && byUrl !== kind) continue;
    valid.push({
      url,
      kind,
      mimeType: typeof mimeType === 'string' ? mimeType.slice(0, 100) : undefined,
      pageUrl: typeof pageUrl === 'string' && isHttpUrl(pageUrl) ? pageUrl.slice(0, MAX_URL_LENGTH) : '',
      pageTitle: typeof pageTitle === 'string' ? pageTitle.slice(0, MAX_TITLE_LENGTH) : '',
    });
  }
  return valid;
}

export function sendRequest<R extends Request>(request: R): Promise<ResponseFor[R['type']]> {
  return browser.runtime.sendMessage(request);
}
