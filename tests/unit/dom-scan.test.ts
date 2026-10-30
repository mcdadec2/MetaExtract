import { describe, expect, it } from 'vitest';
import { videoUrlsFromJsonLd } from '../../src/lib/dom-scan';

describe('videoUrlsFromJsonLd', () => {
  it('finds VideoObject contentUrls, including nested and in @graph', () => {
    const text = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        { '@type': 'WebPage', name: 'x' },
        { '@type': 'VideoObject', contentUrl: 'https://cdn.test/a.mp4' },
        { '@type': 'Article', video: { '@type': ['VideoObject'], contentUrl: 'https://cdn.test/b.mp4' } },
      ],
    });
    expect(videoUrlsFromJsonLd(text)).toEqual(['https://cdn.test/a.mp4', 'https://cdn.test/b.mp4']);
  });

  it('ignores invalid JSON and other types', () => {
    expect(videoUrlsFromJsonLd('{nope')).toEqual([]);
    expect(videoUrlsFromJsonLd('{"@type":"ImageObject","contentUrl":"https://cdn.test/a.png"}')).toEqual([]);
  });
});
