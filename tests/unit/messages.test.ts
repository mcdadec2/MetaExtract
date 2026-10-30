import { describe, expect, it } from 'vitest';
import { validateReport } from '../../src/lib/messages';

const base = { pageUrl: 'https://site.test/p', pageTitle: 'Page' };

describe('validateReport', () => {
  it('keeps well-formed http(s) media reports', () => {
    const items = [{ url: 'https://cdn.test/v.mp4', kind: 'progressive', ...base }];
    expect(validateReport(items)).toEqual([{ ...items[0], mimeType: undefined }]);
  });

  it('rejects non-arrays, bad URLs and unknown kinds', () => {
    expect(validateReport('nope')).toEqual([]);
    expect(
      validateReport([
        null,
        { url: 'javascript:alert(1)', kind: 'progressive', ...base },
        { url: 'blob:https://site.test/x', kind: 'progressive', ...base },
        { url: 'https://cdn.test/v.mp4', kind: 'exe', ...base },
      ]),
    ).toEqual([]);
  });

  it("rejects a kind that contradicts the URL's extension", () => {
    expect(validateReport([{ url: 'https://cdn.test/v.m3u8', kind: 'progressive', ...base }])).toEqual([]);
  });

  it('blanks a non-http page URL and truncates long titles', () => {
    const [item] = validateReport([
      { url: 'https://cdn.test/v', kind: 'progressive', pageUrl: 'file:///x', pageTitle: 't'.repeat(900) },
    ]);
    expect(item!.pageUrl).toBe('');
    expect(item!.pageTitle).toHaveLength(500);
  });
});
