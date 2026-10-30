import { describe, expect, it } from 'vitest';
import { buildSidecar, sidecarDataUrl, siteName } from '../../src/lib/sidecar';

describe('buildSidecar', () => {
  it('maps a candidate to the sidecar shape', () => {
    const sidecar = buildSidecar(
      {
        id: 'x',
        url: 'https://cdn.test/v.mp4',
        kind: 'progressive',
        source: 'network',
        size: 10,
        pageUrl: 'https://www.site.test/watch',
        pageTitle: 'Clip',
        detectedAt: 0,
      },
      new Date('2026-10-30T12:00:00Z'),
    );
    expect(sidecar).toMatchObject({
      schemaVersion: 1,
      site: 'site.test',
      kind: 'page',
      postUrl: 'https://www.site.test/watch',
      title: 'Clip',
      author: null,
      mediaUrl: 'https://cdn.test/v.mp4',
      size: 10,
      sourceTier: 'network',
      savedAt: '2026-10-30T12:00:00.000Z',
    });
  });
});

describe('siteName', () => {
  it('prefers the page host and falls back to the media host', () => {
    expect(siteName('https://www.a.test/x', 'https://cdn.b.test/v')).toBe('a.test');
    expect(siteName(undefined, 'https://cdn.b.test/v')).toBe('cdn.b.test');
    expect(siteName('', 'nope')).toBe('unknown');
  });
});

describe('sidecarDataUrl', () => {
  it('encodes UTF-8 JSON as base64', () => {
    const sidecar = buildSidecar(
      { id: 'x', url: 'https://cdn.test/v.mp4', kind: 'progressive', source: 'dom', pageTitle: 'Café ☕', detectedAt: 0 },
      new Date(0),
    );
    const url = sidecarDataUrl(sidecar);
    expect(url.startsWith('data:application/json;base64,')).toBe(true);
    const bytes = Uint8Array.from(atob(url.split(',')[1]!), (c) => c.charCodeAt(0));
    expect(JSON.parse(new TextDecoder().decode(bytes)).title).toBe('Café ☕');
  });
});
