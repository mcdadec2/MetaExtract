import type { MediaKind } from '../types';
import { inspectDash, planDash } from './dash';
import { inspectHls, planHls } from './hls';
import { StreamError, type DownloadPlan, type FetchText, type StreamInfo } from './types';

export type StreamKind = Exclude<MediaKind, 'progressive'>;

/** Reads a manifest into the qualities the popup offers. Blocks are results, not errors. */
export async function inspectStream(kind: StreamKind, url: string, fetchText: FetchText): Promise<StreamInfo> {
  try {
    return kind === 'hls' ? await inspectHls(url, fetchText) : await inspectDash(url, fetchText);
  } catch (error) {
    if (error instanceof StreamError && error.block) return { blocked: error.block, renditions: [], childUrls: [] };
    throw error;
  }
}

export function planStream(
  kind: StreamKind,
  url: string,
  renditionId: string,
  fetchText: FetchText,
): Promise<DownloadPlan> {
  return kind === 'hls' ? planHls(url, renditionId, fetchText) : planDash(url, renditionId, fetchText);
}
