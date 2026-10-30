import type { MediaCandidate } from './types';

/** Per-tab cap, so a page that streams endless media can't grow the list forever. */
export const MAX_PER_TAB = 200;

/** FNV-1a, enough to give each URL a short stable id. */
export function mediaId(url: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export type StoreSnapshot = Record<string, MediaCandidate[]>;

/**
 * Media found per tab, deduplicated by URL. Plain in-memory data; the
 * background script persists snapshots because MV3 service workers restart.
 */
export class TabMediaStore {
  private tabs = new Map<number, MediaCandidate[]>();

  static fromSnapshot(snapshot: StoreSnapshot): TabMediaStore {
    const store = new TabMediaStore();
    for (const [tabId, items] of Object.entries(snapshot)) {
      store.tabs.set(Number(tabId), items);
    }
    return store;
  }

  snapshot(): StoreSnapshot {
    return Object.fromEntries(this.tabs);
  }

  list(tabId: number): MediaCandidate[] {
    return this.tabs.get(tabId) ?? [];
  }

  get(tabId: number, id: string): MediaCandidate | undefined {
    return this.list(tabId).find((item) => item.id === id);
  }

  /**
   * Adds a candidate, or fills in details (size, MIME type, page info) on an
   * existing one with the same URL. Returns whether anything changed.
   */
  add(tabId: number, candidate: MediaCandidate): boolean {
    const items = this.tabs.get(tabId) ?? [];
    const existing = items.find((item) => item.id === candidate.id);
    if (existing) {
      const before = JSON.stringify(existing);
      existing.size ??= candidate.size;
      existing.mimeType ??= candidate.mimeType;
      existing.pageUrl ??= candidate.pageUrl;
      existing.pageTitle ??= candidate.pageTitle;
      return JSON.stringify(existing) !== before;
    }
    if (items.length >= MAX_PER_TAB) items.shift();
    items.push(candidate);
    this.tabs.set(tabId, items);
    return true;
  }

  /** Returns whether the tab had anything to clear. */
  clear(tabId: number): boolean {
    return this.tabs.delete(tabId);
  }
}
