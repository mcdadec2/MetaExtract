import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { classifyMedia, baseMimeType, totalSize } from '../lib/classify';
import { extensionFor, renderFilename, sidecarFilename } from '../lib/filename';
import { validateReport, type DownloadResult, type MediaChangedEvent, type Request } from '../lib/messages';
import { buildSidecar, sidecarDataUrl, siteName } from '../lib/sidecar';
import { loadSettings, onSettingsChanged, type Settings } from '../lib/settings';
import { mediaId, TabMediaStore, type StoreSnapshot } from '../lib/store';
import type { MediaCandidate } from '../lib/types';

const SNAPSHOT_KEY = 'media';

export default defineBackground(() => {
  // MV3 service workers stop when idle, so the store is mirrored to session
  // storage and reloaded on wake. Every handler awaits `ready` first.
  let store = new TabMediaStore();
  let settings: Settings;
  const ready = Promise.all([
    browser.storage.session.get(SNAPSHOT_KEY).then((stored) => {
      store = TabMediaStore.fromSnapshot((stored[SNAPSHOT_KEY] as StoreSnapshot | undefined) ?? {});
    }),
    loadSettings().then((loaded) => {
      settings = loaded;
    }),
  ]);
  onSettingsChanged((changed) => {
    settings = changed;
  });

  let persistTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void browser.storage.session.set({ [SNAPSHOT_KEY]: store.snapshot() });
    }, 250);
  }

  function changed(tabId: number) {
    persist();
    const count = store.list(tabId).length;
    void browser.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {
      // the tab may have closed in the meantime
    });
    const event: MediaChangedEvent = { type: 'media/changed', tabId };
    browser.runtime.sendMessage(event).catch(() => {
      // no popup open
    });
  }

  function addCandidate(tabId: number, candidate: MediaCandidate) {
    if (store.add(tabId, candidate)) changed(tabId);
  }

  void browser.action.setBadgeBackgroundColor({ color: '#2563eb' });

  browser.webRequest.onResponseStarted.addListener(
    (details) => {
      void ready.then(() => onResponse(details));
    },
    { urls: ['<all_urls>'], types: ['main_frame', 'media', 'xmlhttprequest', 'other'] },
    ['responseHeaders'],
  );

  function onResponse(details: Browser.webRequest.OnResponseStartedDetails) {
    // Requests from service workers or the extension itself have no tab.
    if (details.tabId < 0) return;
    const headers = details.responseHeaders ?? [];
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value;
    const kind = classifyMedia(details.url, contentType);

    // A new top-level document starts a fresh list (a media file opened
    // directly in the tab is the exception: it's both).
    if (details.type === 'main_frame' && store.clear(details.tabId)) changed(details.tabId);

    if (!kind || kind === 'segment') return;
    if (details.statusCode >= 400) return;
    const size = totalSize(headers);
    if (kind === 'progressive' && size !== undefined && size < settings.minSizeKB * 1024) return;

    addCandidate(details.tabId, {
      id: mediaId(details.url),
      url: details.url,
      kind,
      source: 'network',
      mimeType: baseMimeType(contentType) || undefined,
      size,
      detectedAt: Date.now(),
    });
  }

  browser.tabs.onRemoved.addListener((tabId) => {
    void ready.then(() => {
      if (store.clear(tabId)) persist();
    });
  });

  async function download(tabId: number, id: string): Promise<DownloadResult> {
    const candidate = store.get(tabId, id);
    if (!candidate) return { ok: false, error: 'This video is no longer listed. Reload the page.' };
    if (candidate.kind !== 'progressive') {
      return { ok: false, error: 'HLS and DASH streams need the stream engine (coming in Phase 2).' };
    }
    // Network detections don't know their page; take it from the tab now.
    if (!candidate.pageUrl || !candidate.pageTitle) {
      const tab = await browser.tabs.get(tabId).catch(() => undefined);
      candidate.pageUrl ||= tab?.url;
      candidate.pageTitle ||= tab?.title;
      persist();
    }
    const now = new Date();
    const filename = renderFilename(settings.filenameTemplate, {
      site: siteName(candidate.pageUrl, candidate.url),
      title: candidate.pageTitle ?? '',
      date: now,
      id: candidate.id,
      ext: extensionFor(candidate.url, candidate.mimeType),
    });
    try {
      await browser.downloads.download({ url: candidate.url, filename, conflictAction: 'uniquify' });
      if (settings.writeSidecar) {
        await browser.downloads.download({
          url: sidecarDataUrl(buildSidecar(candidate, now)),
          filename: sidecarFilename(filename),
          conflictAction: 'uniquify',
        });
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async function handle(message: Request, sender: Browser.runtime.MessageSender): Promise<unknown> {
    await ready;
    switch (message.type) {
      case 'media/list':
        return store.list(message.tabId);
      case 'media/download':
        return download(message.tabId, message.id);
      case 'media/report': {
        // Only our own pages and content scripts can send messages (there's no
        // externally_connectable), but report contents come from web pages.
        const tabId = sender.tab?.id;
        if (tabId === undefined || tabId < 0) return;
        for (const item of validateReport(message.items)) {
          addCandidate(tabId, { ...item, id: mediaId(item.url), source: 'dom', detectedAt: Date.now() });
        }
        return;
      }
    }
  }

  const REQUEST_TYPES = new Set<string>(['media/list', 'media/download', 'media/report']);
  browser.runtime.onMessage.addListener((message: Request, sender, sendResponse) => {
    if (!REQUEST_TYPES.has(message?.type)) return false;
    void handle(message, sender).then(sendResponse);
    return true;
  });
});
