import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import '../../assets/base.css';
import { estimateSize, formatBytes, formatDuration } from '../../lib/format';
import { sendRequest, type BackgroundEvent } from '../../lib/messages';
import { openDownloadsPanel } from '../../lib/side-panel';
import { BLOCK_MESSAGES } from '../../lib/streams/types';
import type { MediaCandidate } from '../../lib/types';
import './style.css';

type RowStatus = { state: 'adding' } | { state: 'added' } | { state: 'error'; message: string };

const KIND_LABEL: Record<MediaCandidate['kind'], string> = {
  progressive: 'MP4/WebM',
  hls: 'HLS',
  dash: 'DASH',
};

function displayName(url: string): string {
  try {
    const { pathname, hostname } = new URL(url);
    const last = decodeURIComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
    return last || hostname;
  } catch {
    return url;
  }
}

/** The popup lists the active tab; `?tabId=` lets tests open it as a page. */
async function targetTab(): Promise<{ tabId?: number; windowId?: number }> {
  const param = new URLSearchParams(location.search).get('tabId');
  if (param) {
    const tab = await browser.tabs.get(Number(param)).catch(() => undefined);
    return { tabId: Number(param), windowId: tab?.windowId };
  }
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return { tabId: tab?.id, windowId: tab?.windowId };
}

/** What a stream row can offer: a quality picker, or why not. */
function streamState(item: MediaCandidate): { note?: string; error?: string; ready: boolean } {
  if (item.streamError) return { error: item.streamError, ready: false };
  if (!item.stream) return { note: 'Reading the stream…', ready: false };
  if (item.stream.blocked) return { error: BLOCK_MESSAGES[item.stream.blocked], ready: false };
  return { ready: true };
}

function MediaRow({ item, tabId, windowId }: { item: MediaCandidate; tabId: number; windowId?: number }) {
  const [status, setStatus] = useState<RowStatus>();
  const isStream = item.kind !== 'progressive';
  const stream = isStream ? streamState(item) : { ready: true };
  const renditions = item.stream?.renditions ?? [];
  const [renditionId, setRenditionId] = useState<string>();
  const chosen = renditions.find((r) => r.id === renditionId) ?? renditions[0];
  const size = isStream ? estimateSize(chosen?.bandwidth, item.stream?.duration) : item.size;

  const save = async () => {
    // Streams take a while: show their progress. Must run before any await.
    if (isStream) openDownloadsPanel(windowId);
    setStatus({ state: 'adding' });
    const result = await sendRequest({ type: 'media/download', tabId, id: item.id, renditionId: chosen?.id });
    setStatus(result.ok ? { state: 'added' } : { state: 'error', message: result.error });
  };

  return (
    <li class="row" data-kind={item.kind}>
      <div class="info">
        <div class="name" title={item.url}>
          {displayName(item.url)}
        </div>
        <div class="meta">
          <span class="chip">{KIND_LABEL[item.kind]}</span>
          <span>{size === undefined ? 'size unknown' : `${isStream ? '~' : ''}${formatBytes(size)}`}</span>
          {isStream && formatDuration(item.stream?.duration) && <span>{formatDuration(item.stream?.duration)}</span>}
          <span>found in {item.source === 'network' ? 'network' : 'page'}</span>
        </div>
        {stream.ready && renditions.length > 1 && (
          <select
            class="quality"
            aria-label="Quality"
            value={chosen?.id}
            onChange={(e) => setRenditionId(e.currentTarget.value)}
          >
            {renditions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        )}
        {stream.ready && renditions.length === 1 && <div class="note">{renditions[0]!.label}</div>}
        {stream.note && <div class="note">{stream.note}</div>}
        {stream.error && <div class="error">{stream.error}</div>}
        {status?.state === 'error' && <div class="error">{status.message}</div>}
        {status?.state === 'added' && (
          <div class="note">
            Added.{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), openDownloadsPanel(windowId))}>
              View downloads
            </a>
          </div>
        )}
      </div>
      {!stream.error && (
        <button disabled={!stream.ready || status?.state === 'adding' || status?.state === 'added'} onClick={save}>
          {status?.state === 'adding' ? 'Adding…' : status?.state === 'added' ? 'Added' : 'Download'}
        </button>
      )}
    </li>
  );
}

function App() {
  const [target, setTarget] = useState<{ tabId?: number; windowId?: number }>();
  const [items, setItems] = useState<MediaCandidate[]>();
  const tabId = target?.tabId;

  useEffect(() => {
    void targetTab().then(setTarget);
  }, []);

  useEffect(() => {
    if (tabId === undefined) return;
    const refresh = () => void sendRequest({ type: 'media/list', tabId }).then(setItems);
    refresh();
    const onMessage = (message: BackgroundEvent) => {
      if (message?.type === 'media/changed' && message.tabId === tabId) refresh();
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  // A master playlist lists its media playlists; show only the master.
  const children = new Set((items ?? []).flatMap((item) => item.stream?.childUrls ?? []));
  const visible = (items ?? []).filter((item) => !children.has(item.url));

  return (
    <main>
      <header>
        <h1>MetaExtract</h1>
        <nav>
          <a href="#" onClick={(e) => (e.preventDefault(), openDownloadsPanel(target?.windowId))}>
            Downloads
          </a>
          <a href={browser.runtime.getURL('/options.html')} target="_blank">
            Options
          </a>
        </nav>
      </header>
      {items === undefined || tabId === undefined ? (
        <p class="empty">Loading…</p>
      ) : visible.length === 0 ? (
        <p class="empty">No video found on this page yet. Start playing it, then reopen this popup.</p>
      ) : (
        <ul class="list">
          {/* Newest first: the video the user just started is usually the one they want. */}
          {[...visible].reverse().map((item) => (
            <MediaRow key={item.id} item={item} tabId={tabId} windowId={target?.windowId} />
          ))}
        </ul>
      )}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
