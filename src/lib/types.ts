import type { StreamInfo } from './streams/types';

/** How the media is delivered. */
export type MediaKind = 'progressive' | 'hls' | 'dash';

/** Which detection tier found the media (see docs/PLAN.md §4.1). */
export type DetectionSource = 'network' | 'dom';

export interface MediaCandidate {
  /** Stable id derived from the URL, unique within a tab. */
  id: string;
  url: string;
  kind: MediaKind;
  source: DetectionSource;
  mimeType?: string;
  /** Total size in bytes, when the server told us. */
  size?: number;
  pageUrl?: string;
  pageTitle?: string;
  detectedAt: number;
  /** HLS/DASH only: qualities read from the manifest, once inspected. */
  stream?: StreamInfo;
  /** HLS/DASH only: why the manifest couldn't be read. */
  streamError?: string;
}

/** What the content script reports for each media URL it finds in the DOM. */
export interface DomMediaReport {
  url: string;
  kind: MediaKind;
  mimeType?: string;
  pageUrl: string;
  pageTitle: string;
}
