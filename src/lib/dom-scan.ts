import { baseMimeType, classifyMedia, isHttpUrl } from './classify';
import type { DomMediaReport, MediaKind } from './types';

const MAX_JSON_LD_LENGTH = 200_000;

/** Collects `contentUrl`s of every VideoObject in a JSON-LD document. */
export function videoUrlsFromJsonLd(text: string): string[] {
  if (text.length > MAX_JSON_LD_LENGTH) return [];
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const urls: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    const record = node as Record<string, unknown>;
    const type = record['@type'];
    const isVideo = type === 'VideoObject' || (Array.isArray(type) && type.includes('VideoObject'));
    if (isVideo && typeof record.contentUrl === 'string') urls.push(record.contentUrl);
    for (const value of Object.values(record)) visit(value, depth + 1);
  };
  visit(data, 0);
  return urls;
}

/**
 * Kind for a URL found in the DOM. Elements that play it tell us it's media,
 * so an unknown extension counts as progressive; meta tags and JSON-LD often
 * point at player pages, so they need a recognisable extension or MIME type.
 */
function kindFor(url: string, mimeType: string | undefined, played: boolean): MediaKind | null {
  const kind = classifyMedia(url, mimeType);
  if (kind === 'segment') return null;
  if (kind) return kind;
  return played && isHttpUrl(url) && !baseMimeType(mimeType) ? 'progressive' : null;
}

function absolute(url: string | null | undefined, base: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

export function findMediaInDocument(doc: Document): DomMediaReport[] {
  const pageUrl = doc.location?.href ?? '';
  const meta = (selector: string) => doc.querySelector<HTMLMetaElement>(selector)?.content;
  const pageTitle = meta('meta[property="og:title"]') || doc.title || '';
  const found = new Map<string, DomMediaReport>();
  const add = (raw: string | null | undefined, mimeType: string | undefined, played: boolean) => {
    const url = absolute(raw, doc.baseURI);
    if (!url || found.has(url)) return;
    const kind = kindFor(url, mimeType, played);
    if (kind) found.set(url, { url, kind, mimeType: mimeType || undefined, pageUrl, pageTitle });
  };

  // blob: sources (MSE players) are skipped by kindFor; later tiers handle them.
  for (const video of doc.querySelectorAll('video')) {
    add(video.currentSrc || video.getAttribute('src'), undefined, true);
    for (const source of video.querySelectorAll('source')) {
      add(source.getAttribute('src'), source.type, true);
    }
  }

  const ogType = meta('meta[property="og:video:type"]');
  for (const selector of [
    'meta[property="og:video:secure_url"]',
    'meta[property="og:video:url"]',
    'meta[property="og:video"]',
  ]) {
    add(meta(selector), ogType, false);
  }
  add(meta('meta[name="twitter:player:stream"]'), meta('meta[name="twitter:player:stream:content_type"]'), false);

  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    for (const url of videoUrlsFromJsonLd(script.textContent ?? '')) add(url, undefined, false);
  }

  return [...found.values()];
}
