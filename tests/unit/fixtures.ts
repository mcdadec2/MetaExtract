import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Fixture URLs map onto tests/e2e/site, so unit tests can "fetch" what e2e tests serve. */
export const ORIGIN = 'https://cdn.test';
const SITE = resolve(__dirname, '../e2e/site');

function pathFor(url: string): string {
  const parsed = new URL(url);
  if (parsed.origin !== ORIGIN) throw new Error(`unexpected host: ${url}`);
  return resolve(SITE, `.${decodeURIComponent(parsed.pathname)}`);
}

export const fetchText = async (url: string): Promise<string> => readFileSync(pathFor(url), 'utf8');

export function fixtureBytes(url: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(pathFor(url)));
}

/** A fetch() over the fixtures, with Range support and a request log. */
export function fixtureFetch(log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    log.push(url);
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = fixtureBytes(url);
    } catch {
      return new Response(null, { status: 404 });
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '');
    if (range) {
      const part = bytes.slice(Number(range[1]), Number(range[2]) + 1);
      return new Response(part, { status: 206, headers: { 'content-length': String(part.length) } });
    }
    return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
  }) as typeof fetch;
}
