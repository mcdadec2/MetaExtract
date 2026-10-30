import { describe, expect, it } from 'vitest';
import { MAX_PER_TAB, mediaId, TabMediaStore } from '../../src/lib/store';
import type { MediaCandidate } from '../../src/lib/types';

function candidate(url: string, extra: Partial<MediaCandidate> = {}): MediaCandidate {
  return { id: mediaId(url), url, kind: 'progressive', source: 'network', detectedAt: 0, ...extra };
}

describe('TabMediaStore', () => {
  it('deduplicates by URL and fills in missing details', () => {
    const store = new TabMediaStore();
    expect(store.add(1, candidate('https://a.test/v.mp4'))).toBe(true);
    expect(store.add(1, candidate('https://a.test/v.mp4'))).toBe(false);
    expect(store.add(1, candidate('https://a.test/v.mp4', { size: 42, source: 'dom' }))).toBe(true);
    expect(store.list(1)).toHaveLength(1);
    expect(store.list(1)[0]).toMatchObject({ size: 42, source: 'network' });
  });

  it('keeps tabs separate and clears one tab', () => {
    const store = new TabMediaStore();
    store.add(1, candidate('https://a.test/1.mp4'));
    store.add(2, candidate('https://a.test/2.mp4'));
    expect(store.clear(1)).toBe(true);
    expect(store.clear(1)).toBe(false);
    expect(store.list(1)).toEqual([]);
    expect(store.list(2)).toHaveLength(1);
  });

  it('drops the oldest entry past the per-tab cap', () => {
    const store = new TabMediaStore();
    for (let i = 0; i <= MAX_PER_TAB; i++) store.add(1, candidate(`https://a.test/${i}.mp4`));
    const items = store.list(1);
    expect(items).toHaveLength(MAX_PER_TAB);
    expect(items[0]!.url).toBe('https://a.test/1.mp4');
  });

  it('round-trips through a snapshot', () => {
    const store = new TabMediaStore();
    store.add(7, candidate('https://a.test/v.mp4'));
    const restored = TabMediaStore.fromSnapshot(JSON.parse(JSON.stringify(store.snapshot())));
    expect(restored.get(7, mediaId('https://a.test/v.mp4'))?.url).toBe('https://a.test/v.mp4');
  });
});
