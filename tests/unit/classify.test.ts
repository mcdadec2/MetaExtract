import { describe, expect, it } from 'vitest';
import { classifyMedia, totalSize, urlExtension } from '../../src/lib/classify';

describe('classifyMedia', () => {
  it.each([
    ['https://cdn.test/v/clip.mp4', undefined, 'progressive'],
    ['https://cdn.test/v/clip.webm?sig=1', 'application/octet-stream', 'progressive'],
    ['https://cdn.test/live/index.m3u8', undefined, 'hls'],
    ['https://cdn.test/manifest', 'application/vnd.apple.mpegurl', 'hls'],
    ['https://cdn.test/manifest', 'application/x-mpegURL; charset=utf-8', 'hls'],
    ['https://cdn.test/stream.mpd', undefined, 'dash'],
    ['https://cdn.test/manifest', 'application/dash+xml', 'dash'],
    ['https://cdn.test/seg/0001.ts', 'video/mp2t', 'segment'],
    ['https://cdn.test/seg/chunk-5.m4s', 'video/mp4', 'segment'],
    ['https://cdn.test/media/12345', 'video/mp4', 'progressive'],
  ] as const)('%s (%s) → %s', (url, contentType, expected) => {
    expect(classifyMedia(url, contentType)).toBe(expected);
  });

  it('ignores non-media responses even with a media-looking path', () => {
    expect(classifyMedia('https://site.test/watch/video.mp4', 'text/html')).toBeNull();
  });

  it('ignores audio, images and unknown files', () => {
    expect(classifyMedia('https://cdn.test/a.mp3', 'audio/mpeg')).toBeNull();
    expect(classifyMedia('https://cdn.test/a.png', 'image/png')).toBeNull();
    expect(classifyMedia('https://cdn.test/data', undefined)).toBeNull();
  });

  it('only accepts http(s) URLs', () => {
    expect(classifyMedia('blob:https://site.test/1234', 'video/mp4')).toBeNull();
    expect(classifyMedia('data:video/mp4;base64,AAAA')).toBeNull();
  });
});

describe('urlExtension', () => {
  it('reads the last path segment, not the query', () => {
    expect(urlExtension('https://a.test/x.y/clip.MP4?name=z.m3u8')).toBe('mp4');
    expect(urlExtension('https://a.test/dir/')).toBe('');
    expect(urlExtension('not a url')).toBe('');
  });
});

describe('totalSize', () => {
  it('prefers the Content-Range total over a partial Content-Length', () => {
    expect(
      totalSize([
        { name: 'Content-Length', value: '1024' },
        { name: 'Content-Range', value: 'bytes 0-1023/987654' },
      ]),
    ).toBe(987654);
  });

  it('falls back to Content-Length, and ignores unknown totals', () => {
    expect(totalSize([{ name: 'content-length', value: '5000' }])).toBe(5000);
    expect(totalSize([{ name: 'Content-Range', value: 'bytes 0-99/*' }])).toBeUndefined();
    expect(totalSize([])).toBeUndefined();
  });
});
