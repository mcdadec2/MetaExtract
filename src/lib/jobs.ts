import type { MediaCandidate } from './types';

export type JobState = 'queued' | 'downloading' | 'merging' | 'saving' | 'done' | 'failed' | 'canceled';

export const ACTIVE_STATES: ReadonlySet<JobState> = new Set(['queued', 'downloading', 'merging', 'saving']);

/** One download, as the side panel shows it. */
export interface Job {
  id: string;
  createdAt: number;
  /** What was detected; used for retries and the sidecar. */
  candidate: MediaCandidate;
  renditionId?: string;
  renditionLabel?: string;
  filename: string;
  state: JobState;
  /** 0..1 while downloading. */
  progress?: number;
  /** Bytes fetched so far, or the file size once saved. */
  bytes?: number;
  error?: string;
  downloadId?: number;
  /** Filled from the download plan, for the sidecar. */
  duration?: number;
  width?: number;
  height?: number;
}

export const MAX_JOBS_KEPT = 100;
