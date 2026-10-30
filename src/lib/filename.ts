import { urlExtension } from './classify';

export const DEFAULT_FILENAME_TEMPLATE = 'MetaExtract/{site}_{date}_{title}.{ext}';

export interface FilenameVars {
  site: string;
  title: string;
  /** Saved-at time; rendered as {date} (YYYY-MM-DD) and {time} (HH-MM-SS). */
  date: Date;
  id: string;
  ext: string;
}

const MAX_FIELD = 80;
const MAX_SEGMENT = 180;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Makes untrusted text (page titles, hostnames) safe inside one path segment. */
export function sanitizeField(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIELD)
    .trim();
}

function sanitizeSegment(segment: string): string {
  let clean = segment.replace(/^[.\s]+|[.\s]+$/g, '').slice(0, MAX_SEGMENT);
  if (WINDOWS_RESERVED.test(clean)) clean = `_${clean}`;
  return clean;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Picks a file extension from the URL, falling back to the MIME type. */
export function extensionFor(url: string, mimeType?: string): string {
  const fromUrl = urlExtension(url);
  if (/^(mp4|m4v|webm|mov|mkv)$/.test(fromUrl)) return fromUrl;
  if (mimeType?.includes('webm')) return 'webm';
  return 'mp4';
}

/**
 * Renders a filename template into a relative path for chrome.downloads.
 * `/` in the template creates subfolders; variable values can never add
 * folders or escape the downloads directory.
 */
export function renderFilename(template: string, vars: FilenameVars): string {
  const d = vars.date;
  const values: Record<string, string> = {
    site: sanitizeField(vars.site) || 'site',
    title: sanitizeField(vars.title) || 'video',
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
    id: sanitizeField(vars.id),
    ext: sanitizeField(vars.ext) || 'mp4',
  };
  const rendered = template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
  const segments = rendered
    .split(/[/\\]+/)
    .map(sanitizeSegment)
    .filter((segment) => segment !== '');
  return segments.length > 0 ? segments.join('/') : `video.${values.ext}`;
}

/** The sidecar sits next to the video with the same name and a .json extension. */
export function sidecarFilename(videoFilename: string): string {
  const slash = videoFilename.lastIndexOf('/');
  const dot = videoFilename.lastIndexOf('.');
  const base = dot > slash ? videoFilename.slice(0, dot) : videoFilename;
  return `${base}.json`;
}
