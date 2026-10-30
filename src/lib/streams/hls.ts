import { Parser } from 'm3u8-parser';
import {
  StreamError,
  qualityLabel,
  resolveUrl,
  type DownloadPlan,
  type FetchText,
  type Rendition,
  type SegmentRef,
  type StreamInfo,
  type TrackPlan,
} from './types';

/** The parts of m3u8-parser's output we use. */
interface Segment {
  uri: string;
  duration: number;
  byterange?: { length: number; offset: number };
  key?: { method: string; uri: string; iv?: Uint32Array };
  map?: { uri: string; byterange?: { length: number; offset: number } };
}

interface Variant {
  uri: string;
  attributes: {
    BANDWIDTH?: number;
    CODECS?: string;
    RESOLUTION?: { width: number; height: number };
    AUDIO?: string;
  };
}

interface AudioRendition {
  uri?: string;
  default?: boolean;
}

interface Manifest {
  playlists?: Variant[];
  mediaGroups?: { AUDIO?: Record<string, Record<string, AudioRendition>> };
  segments: Segment[];
  mediaSequence?: number;
  endList?: boolean;
  contentProtection?: unknown;
}

function parse(text: string): Manifest {
  if (!text.trimStart().startsWith('#EXTM3U')) throw new StreamError('Not an HLS playlist.');
  // Keys m3u8-parser doesn't treat as encryption still mean DRM: SAMPLE-AES,
  // or any key format other than plain AES-128 with the identity format.
  for (const match of text.matchAll(/^#EXT-X-(?:SESSION-)?KEY:(.*)$/gm)) {
    const attributes = match[1]!;
    const method = /METHOD=([^,\s]+)/.exec(attributes)?.[1];
    const format = /KEYFORMAT="([^"]*)"/.exec(attributes)?.[1];
    if (method === 'NONE') continue;
    if (method !== 'AES-128' || (format && format !== 'identity')) {
      throw new StreamError('DRM-protected stream.', 'drm');
    }
  }
  const parser = new Parser();
  parser.push(text);
  parser.end();
  return parser.manifest as Manifest;
}

function isMaster(manifest: Manifest): boolean {
  return (manifest.playlists?.length ?? 0) > 0;
}

function sortedVariants(manifest: Manifest, base: string): Variant[] {
  const seen = new Set<string>();
  return [...(manifest.playlists ?? [])]
    .map((variant) => ({ ...variant, uri: resolveUrl(variant.uri, base) }))
    .filter((variant) => !seen.has(variant.uri) && seen.add(variant.uri))
    .sort((a, b) => (b.attributes.BANDWIDTH ?? 0) - (a.attributes.BANDWIDTH ?? 0));
}

function audioPlaylistUrl(manifest: Manifest, variant: Variant, base: string): string | undefined {
  const group = variant.attributes.AUDIO ? manifest.mediaGroups?.AUDIO?.[variant.attributes.AUDIO] : undefined;
  if (!group) return undefined;
  const renditions = Object.values(group);
  // Without a URI, the audio is muxed into the variant itself.
  const chosen = renditions.find((r) => r.default && r.uri) ?? renditions.find((r) => r.uri);
  return chosen?.uri ? resolveUrl(chosen.uri, base) : undefined;
}

function duration(media: Manifest): number {
  return media.segments.reduce((sum, segment) => sum + segment.duration, 0);
}

function checkMedia(media: Manifest): void {
  if (media.contentProtection) throw new StreamError('DRM-protected stream.', 'drm');
  if (!media.endList) throw new StreamError('Live stream.', 'live');
  if (media.segments.length === 0) throw new StreamError('Empty playlist.', 'empty');
}

export async function inspectHls(url: string, fetchText: FetchText): Promise<StreamInfo> {
  const manifest = parse(await fetchText(url));
  if (!isMaster(manifest)) {
    checkMedia(manifest);
    return { duration: duration(manifest), renditions: [{ id: url, label: 'Default quality' }], childUrls: [] };
  }
  const variants = sortedVariants(manifest, url);
  const childUrls = new Set(variants.map((variant) => variant.uri));
  for (const variant of variants) {
    const audio = audioPlaylistUrl(manifest, variant, url);
    if (audio) childUrls.add(audio);
  }
  // The best variant's media playlist tells us the duration and whether it's
  // live. Even a blocked master reports its children, so they stay hidden.
  let media: Manifest;
  try {
    media = parse(await fetchText(variants[0]!.uri));
    checkMedia(media);
  } catch (error) {
    if (error instanceof StreamError && error.block) {
      return { blocked: error.block, renditions: [], childUrls: [...childUrls] };
    }
    throw error;
  }
  const renditions: Rendition[] = variants.map((variant) => ({
    id: variant.uri,
    label: qualityLabel(variant.attributes.RESOLUTION?.height, variant.attributes.BANDWIDTH),
    width: variant.attributes.RESOLUTION?.width,
    height: variant.attributes.RESOLUTION?.height,
    bandwidth: variant.attributes.BANDWIDTH,
    codecs: variant.attributes.CODECS,
  }));
  return { duration: duration(media), renditions, childUrls: [...childUrls] };
}

/** m3u8-parser gives the IV as four big-endian 32-bit words. */
function ivBytes(words: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  words.forEach((word, i) => view.setUint32(i * 4, word));
  return bytes;
}

/** Without an IV attribute, the IV is the segment's media sequence number. */
export function sequenceIv(sequence: number): Uint8Array {
  const bytes = new Uint8Array(16);
  new DataView(bytes.buffer).setUint32(12, sequence);
  return bytes;
}

function trackFromMedia(media: Manifest, base: string, content: TrackPlan['content']): TrackPlan {
  checkMedia(media);
  const firstMap = media.segments.find((segment) => segment.map)?.map;
  const segments: SegmentRef[] = media.segments.map((segment, index) => ({
    url: resolveUrl(segment.uri, base),
    range: segment.byterange,
    key:
      segment.key?.method === 'AES-128'
        ? {
            url: resolveUrl(segment.key.uri, base),
            iv: segment.key.iv ? ivBytes(segment.key.iv) : sequenceIv((media.mediaSequence ?? 0) + index),
          }
        : undefined,
  }));
  if (firstMap && media.segments.some((segment) => segment.map?.uri !== firstMap.uri)) {
    throw new StreamError('Playlists that switch init segments mid-stream aren’t supported yet.');
  }
  return {
    content,
    container: firstMap ? 'fmp4' : 'ts',
    init: firstMap ? { url: resolveUrl(firstMap.uri, base), range: firstMap.byterange } : undefined,
    segments,
  };
}

export async function planHls(url: string, renditionId: string, fetchText: FetchText): Promise<DownloadPlan> {
  const manifest = parse(await fetchText(url));
  if (!isMaster(manifest)) {
    return { tracks: [trackFromMedia(manifest, url, 'muxed')], duration: duration(manifest) };
  }
  const variants = sortedVariants(manifest, url);
  const variant = variants.find((v) => v.uri === renditionId) ?? variants[0]!;
  const media = parse(await fetchText(variant.uri));
  const audioUrl = audioPlaylistUrl(manifest, variant, url);
  const tracks = [trackFromMedia(media, variant.uri, audioUrl ? 'video' : 'muxed')];
  if (audioUrl) tracks.push(trackFromMedia(parse(await fetchText(audioUrl)), audioUrl, 'audio'));
  return {
    tracks,
    duration: duration(media),
    width: variant.attributes.RESOLUTION?.width,
    height: variant.attributes.RESOLUTION?.height,
  };
}
