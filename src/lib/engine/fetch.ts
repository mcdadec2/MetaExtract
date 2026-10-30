import type { ByteRange } from '../streams/types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(
      status === 401 || status === 403
        ? `The server refused the download (HTTP ${status}). The link may have expired; reload the page and try again.`
        : status === 404 || status === 410
          ? `Part of the video is missing on the server (HTTP ${status}). Reload the page and try again.`
          : `The server returned HTTP ${status}.`,
    );
  }
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const ATTEMPTS = 4;

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function rangeHeader(range: ByteRange | undefined, from = 0): HeadersInit | undefined {
  if (!range && from === 0) return undefined;
  const start = (range?.offset ?? 0) + from;
  const end = range ? `${range.offset + range.length - 1}` : '';
  return { Range: `bytes=${start}-${end}` };
}

/**
 * fetch() with retries for network errors and transient statuses
 * (backoff 0.5 s, 1 s, 2 s). Other HTTP errors fail at once.
 */
export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  signal: AbortSignal,
  headers?: HeadersInit,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      // Cookies go along, as they would for the page itself.
      response = await fetchFn(url, { headers, signal, credentials: 'include' });
    } catch (error) {
      if (signal.aborted || attempt >= ATTEMPTS) throw signal.aborted ? signal.reason : error;
      await sleep(250 * 2 ** attempt, signal);
      continue;
    }
    if (response.ok) return response;
    if (!RETRYABLE.has(response.status) || attempt >= ATTEMPTS) throw new HttpError(response.status, url);
    await sleep(250 * 2 ** attempt, signal);
  }
}

/** Downloads a resource (or a byte range of it) into memory. For segments, keys, manifests. */
export async function fetchBytes(
  fetchFn: typeof fetch,
  url: string,
  signal: AbortSignal,
  range?: ByteRange,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetchWithRetry(fetchFn, url, signal, rangeHeader(range));
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A server that ignores Range sends the whole file; cut out our part.
  if (range && response.status === 200) return bytes.slice(range.offset, range.offset + range.length);
  return bytes;
}

export async function fetchText(fetchFn: typeof fetch, url: string, signal: AbortSignal): Promise<string> {
  return (await fetchWithRetry(fetchFn, url, signal)).text();
}

/**
 * Streams a whole file to `onChunk`. If the connection drops part way, it
 * resumes with a Range request from the last byte received.
 */
export async function streamFile(
  fetchFn: typeof fetch,
  url: string,
  signal: AbortSignal,
  onChunk: (chunk: Uint8Array, received: number, total: number | undefined) => Promise<void>,
): Promise<void> {
  let received = 0;
  let total: number | undefined;
  for (let attempt = 1; ; attempt++) {
    const response = await fetchWithRetry(fetchFn, url, signal, rangeHeader(undefined, received));
    // Resuming but the server sent everything again: skip what we have.
    let skip = received > 0 && response.status === 200 ? received : 0;
    if (total === undefined) {
      const length = Number(response.headers.get('content-length'));
      total = response.status === 200 && length > 0 ? length : undefined;
    }
    const reader = response.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        let chunk = value;
        if (skip > 0) {
          const drop = Math.min(skip, chunk.length);
          skip -= drop;
          chunk = chunk.subarray(drop);
          if (chunk.length === 0) continue;
        }
        received += chunk.length;
        await onChunk(chunk, received, total);
      }
    } catch (error) {
      if (signal.aborted || attempt >= ATTEMPTS) throw signal.aborted ? signal.reason : error;
      await sleep(250 * 2 ** attempt, signal);
    }
  }
}
