import { parse as parseMpd } from 'mpd-parser';
import {
  StreamError,
  qualityLabel,
  type DownloadPlan,
  type FetchText,
  type Rendition,
  type SegmentRef,
  type StreamInfo,
  type TrackPlan,
} from './types';

/** The parts of mpd-parser's output we use. */
interface Ref {
  resolvedUri: string;
  byterange?: { length: number; offset: number };
}

interface Playlist {
  attributes: {
    NAME: string;
    BANDWIDTH?: number;
    CODECS?: string;
    RESOLUTION?: { width: number; height: number };
    AUDIO?: string;
  };
  resolvedUri: string;
  segments: (Ref & { map?: Ref })[];
  /** Present for SegmentBase: the whole representation is one file. */
  sidx?: Ref & { map?: Ref };
  contentProtection?: unknown;
}

interface Manifest {
  duration?: number;
  playlists: Playlist[];
  mediaGroups?: { AUDIO?: Record<string, Record<string, { playlists?: Playlist[] }>> };
}

function parse(text: string, url: string): Manifest {
  if (!/<MPD[\s>]/.test(text)) throw new StreamError('Not a DASH manifest.');
  // mpd-parser only reports key systems it knows, so look at the XML too.
  if (/<(?:\w+:)?ContentProtection[\s/>]/.test(text)) throw new StreamError('DRM-protected stream.', 'drm');
  if (/\btype\s*=\s*["']dynamic["']/.test(text)) throw new StreamError('Live stream.', 'live');
  return parseMpd(text, { manifestUri: url }) as Manifest;
}

function byBandwidth(a: Playlist, b: Playlist): number {
  return (b.attributes.BANDWIDTH ?? 0) - (a.attributes.BANDWIDTH ?? 0);
}

function audioPlaylists(manifest: Manifest, group?: string): Playlist[] {
  const groups = manifest.mediaGroups?.AUDIO ?? {};
  const chosen = group && groups[group] ? [groups[group]] : Object.values(groups);
  return chosen
    .flatMap((renditions) => Object.values(renditions))
    .flatMap((rendition) => rendition.playlists ?? [])
    .sort(byBandwidth);
}

function rendition(playlist: Playlist): Rendition {
  const { NAME, BANDWIDTH, CODECS, RESOLUTION } = playlist.attributes;
  return {
    id: NAME,
    label: qualityLabel(RESOLUTION?.height, BANDWIDTH),
    width: RESOLUTION?.width,
    height: RESOLUTION?.height,
    bandwidth: BANDWIDTH,
    codecs: CODECS,
  };
}

function segmentRef(ref: Ref): SegmentRef {
  return { url: ref.resolvedUri, range: ref.byterange };
}

function track(playlist: Playlist, content: TrackPlan['content']): TrackPlan {
  if (playlist.contentProtection) throw new StreamError('DRM-protected stream.', 'drm');
  if (playlist.sidx) {
    // SegmentBase: the file holds the init segment and every fragment.
    return { content, container: 'fmp4', segments: [{ url: playlist.sidx.resolvedUri }] };
  }
  if (playlist.segments.length === 0) throw new StreamError('Empty representation.', 'empty');
  const map = playlist.segments[0]!.map;
  return {
    content,
    container: 'fmp4',
    init: map ? segmentRef(map) : undefined,
    segments: playlist.segments.map(segmentRef),
  };
}

/** Video representations, or audio ones for an audio-only manifest. Best first. */
function mainPlaylists(manifest: Manifest): Playlist[] {
  const video = [...manifest.playlists].sort(byBandwidth);
  return video.length > 0 ? video : audioPlaylists(manifest);
}

export async function inspectDash(url: string, fetchText: FetchText): Promise<StreamInfo> {
  const manifest = parse(await fetchText(url), url);
  const playlists = mainPlaylists(manifest);
  if (playlists.length === 0) return { blocked: 'empty', renditions: [], childUrls: [] };
  if (playlists.some((playlist) => playlist.contentProtection)) {
    return { blocked: 'drm', renditions: [], childUrls: [] };
  }
  const audio = manifest.playlists.length > 0 ? audioPlaylists(manifest)[0] : undefined;
  return {
    duration: manifest.duration,
    renditions: playlists.map((playlist) => {
      const info = rendition(playlist);
      // Representation bandwidths are per track; the user gets both.
      if (info.bandwidth && audio?.attributes.BANDWIDTH) {
        info.bandwidth += audio.attributes.BANDWIDTH;
        info.label = qualityLabel(info.height, info.bandwidth);
      }
      return info;
    }),
    childUrls: [],
  };
}

export async function planDash(url: string, renditionId: string, fetchText: FetchText): Promise<DownloadPlan> {
  const manifest = parse(await fetchText(url), url);
  const playlists = mainPlaylists(manifest);
  const main = playlists.find((p) => p.attributes.NAME === renditionId) ?? playlists[0];
  if (!main) throw new StreamError('No playable representation.', 'empty');
  const isVideo = manifest.playlists.includes(main);
  const audio = isVideo ? audioPlaylists(manifest, main.attributes.AUDIO)[0] : undefined;
  const tracks = [track(main, isVideo ? (audio ? 'video' : 'muxed') : 'audio')];
  if (audio) tracks.push(track(audio, 'audio'));
  return {
    tracks,
    duration: manifest.duration,
    width: main.attributes.RESOLUTION?.width,
    height: main.attributes.RESOLUTION?.height,
  };
}
