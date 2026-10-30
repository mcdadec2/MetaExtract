import { describe, expect, it } from 'vitest';
import { sequenceIv } from '../../src/lib/streams/hls';
import { inspectStream, planStream } from '../../src/lib/streams/inspect';
import { fetchText, ORIGIN } from './fixtures';

const S = `${ORIGIN}/streams`;

describe('HLS', () => {
  it('lists variants of a master playlist, best first, with duration', async () => {
    const info = await inspectStream('hls', `${S}/hls-ts/master.m3u8`, fetchText);
    expect(info.blocked).toBeUndefined();
    expect(info.duration).toBe(4);
    expect(info.renditions.map((r) => r.label)).toEqual(['180p · 383 kbps', '108p · 185 kbps']);
    expect(info.childUrls).toEqual([`${S}/hls-ts/180p.m3u8`, `${S}/hls-ts/108p.m3u8`]);
  });

  it('plans a muxed TS variant', async () => {
    const plan = await planStream('hls', `${S}/hls-ts/master.m3u8`, `${S}/hls-ts/108p.m3u8`, fetchText);
    expect(plan).toMatchObject({ duration: 4, width: 192, height: 108 });
    expect(plan.tracks).toHaveLength(1);
    expect(plan.tracks[0]).toMatchObject({ content: 'muxed', container: 'ts' });
    expect(plan.tracks[0]!.segments.map((s) => s.url)).toEqual([0, 1, 2, 3].map((i) => `${S}/hls-ts/108p-${i}.ts`));
  });

  it('plans fMP4 video plus a separate audio rendition', async () => {
    const info = await inspectStream('hls', `${S}/hls-fmp4/master.m3u8`, fetchText);
    expect(info.childUrls).toEqual([`${S}/hls-fmp4/video.m3u8`, `${S}/hls-fmp4/audio.m3u8`]);
    const plan = await planStream('hls', `${S}/hls-fmp4/master.m3u8`, info.renditions[0]!.id, fetchText);
    expect(plan.tracks.map((t) => [t.content, t.container, t.init?.url])).toEqual([
      ['video', 'fmp4', `${S}/hls-fmp4/video-init.mp4`],
      ['audio', 'fmp4', `${S}/hls-fmp4/audio-init.mp4`],
    ]);
  });

  it('carries AES-128 keys with their IVs', async () => {
    const plan = await planStream('hls', `${S}/hls-aes/index.m3u8`, '', fetchText);
    const key = plan.tracks[0]!.segments[0]!.key!;
    expect(key.url).toBe(`${S}/hls-aes/key.bin`);
    expect(Buffer.from(key.iv).toString('hex')).toBe('00112233445566778899aabbccddeeff');
  });

  it('derives the IV from the media sequence when the playlist has none', () => {
    expect(Buffer.from(sequenceIv(258)).toString('hex')).toBe('00000000000000000000000000000102');
  });

  it('blocks DRM and live playlists', async () => {
    expect((await inspectStream('hls', `${S}/hls-aes/fairplay.m3u8`, fetchText)).blocked).toBe('drm');
    expect((await inspectStream('hls', `${S}/hls-ts/live.m3u8`, fetchText)).blocked).toBe('live');
    await expect(planStream('hls', `${S}/hls-ts/live.m3u8`, '', fetchText)).rejects.toThrow('Live');
  });

  it('rejects text that is not a playlist', async () => {
    await expect(inspectStream('hls', `${S}/../video.html`, fetchText)).rejects.toThrow('Not an HLS playlist');
  });
});

describe('DASH', () => {
  it('lists representations with combined video+audio bandwidth', async () => {
    const info = await inspectStream('dash', `${S}/dash-template/manifest.mpd`, fetchText);
    expect(info).toMatchObject({ duration: 4, childUrls: [] });
    expect(info.renditions).toEqual([
      expect.objectContaining({ id: '0', label: '180p · 348 kbps', width: 320, height: 180, bandwidth: 348000 }),
    ]);
  });

  it('plans SegmentTemplate video and audio with init segments', async () => {
    const plan = await planStream('dash', `${S}/dash-template/manifest.mpd`, '0', fetchText);
    expect(plan.tracks.map((t) => [t.content, t.init?.url, t.segments.length])).toEqual([
      ['video', `${S}/dash-template/init-0.m4s`, 4],
      ['audio', `${S}/dash-template/init-1.m4s`, 4],
    ]);
  });

  it('plans SegmentList byte ranges', async () => {
    const plan = await planStream('dash', `${S}/dash-single/manifest.mpd`, '0', fetchText);
    expect(plan.tracks[0]!.init).toEqual({ url: `${S}/dash-single/stream-0.mp4`, range: { offset: 0, length: 834 } });
    expect(plan.tracks[0]!.segments[1]).toEqual({
      url: `${S}/dash-single/stream-0.mp4`,
      range: { offset: 27618, length: 35114 },
    });
  });

  it('plans SegmentBase as one whole file per track (the Facebook/Instagram layout)', async () => {
    const plan = await planStream('dash', `${S}/dash-single/segmentbase.mpd`, '0', fetchText);
    expect(plan.tracks).toEqual([
      { content: 'video', container: 'fmp4', segments: [{ url: `${S}/dash-single/stream-0.mp4` }] },
      { content: 'audio', container: 'fmp4', segments: [{ url: `${S}/dash-single/stream-1.mp4` }] },
    ]);
  });

  it('blocks ContentProtection and dynamic manifests', async () => {
    expect((await inspectStream('dash', `${S}/dash-template/drm.mpd`, fetchText)).blocked).toBe('drm');
    const live = async () => '<MPD type="dynamic"><Period/></MPD>';
    expect((await inspectStream('dash', `${S}/live.mpd`, live)).blocked).toBe('live');
  });
});
