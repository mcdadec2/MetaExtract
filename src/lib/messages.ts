import { browser } from 'wxt/browser';
import { classifyMedia, isHttpUrl } from './classify';
import type { StreamJobSpec } from './engine/run-job';
import type { Job } from './jobs';
import type { DomMediaReport, MediaCandidate } from './types';

/** Requests from extension pages and content scripts to the background. */
export type Request =
  | { type: 'media/list'; tabId: number }
  | { type: 'media/download'; tabId: number; id: string; renditionId?: string }
  | { type: 'media/report'; items: DomMediaReport[] }
  | { type: 'jobs/list' }
  | { type: 'jobs/cancel'; id: string }
  | { type: 'jobs/retry'; id: string }
  | { type: 'jobs/show'; id: string }
  | { type: 'jobs/clear' };

export type DownloadResult = { ok: true; jobId: string } | { ok: false; error: string };

export interface ResponseFor {
  'media/list': MediaCandidate[];
  'media/download': DownloadResult;
  'media/report': void;
  'jobs/list': Job[];
  'jobs/cancel': void;
  'jobs/retry': void;
  'jobs/show': void;
  'jobs/clear': void;
}

/** Only content scripts may send these; everything else needs an extension page. */
export const CONTENT_SCRIPT_REQUESTS: ReadonlySet<string> = new Set(['media/report']);
export const REQUEST_TYPES: ReadonlySet<string> = new Set([
  'media/list',
  'media/download',
  'media/report',
  'jobs/list',
  'jobs/cancel',
  'jobs/retry',
  'jobs/show',
  'jobs/clear',
]);

/** Broadcasts from the background so open pages refresh. */
export type BackgroundEvent = { type: 'media/changed'; tabId: number } | { type: 'jobs/changed'; jobs: Job[] };
export type MediaChangedEvent = Extract<BackgroundEvent, { type: 'media/changed' }>;

/** Background → offscreen engine. */
export type EngineCommand =
  | { type: 'engine/start'; spec: StreamJobSpec }
  | { type: 'engine/cancel'; jobId: string }
  | { type: 'engine/release'; jobId: string };

/** Offscreen engine → background. */
export type EngineEvent =
  | { type: 'engine/progress'; jobId: string; phase: 'downloading' | 'merging'; fraction: number; bytes: number }
  | { type: 'engine/hosts'; jobId: string; hosts: string[] }
  | {
      type: 'engine/done';
      jobId: string;
      url: string;
      size: number;
      duration?: number;
      width?: number;
      height?: number;
    }
  | { type: 'engine/failed'; jobId: string; error: string; canceled: boolean };

export const ENGINE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'engine/progress',
  'engine/hosts',
  'engine/done',
  'engine/failed',
]);

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
