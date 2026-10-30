import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import '../../assets/base.css';
import { formatBytes } from '../../lib/format';
import { sendRequest, type MediaChangedEvent } from '../../lib/messages';
import type { MediaCandidate } from '../../lib/types';
import './style.css';

type RowStatus = { state: 'saving' } | { state: 'saved' } | { state: 'error'; message: string };

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
async function targetTabId(): Promise<number | undefined> {
  const param = new URLSearchParams(location.search).get('tabId');
  if (param) return Number(param);
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

function MediaRow({ item, tabId }: { item: MediaCandidate; tabId: number }) {
  const [status, setStatus] = useState<RowStatus>();
  const isStream = item.kind !== 'progressive';

  const save = async () => {
    setStatus({ state: 'saving' });
    const result = await sendRequest({ type: 'media/download', tabId, id: item.id });
    setStatus(result.ok ? { state: 'saved' } : { state: 'error', message: result.error });
  };

  return (
    <li class="row" data-kind={item.kind}>
      <div class="info">
        <div class="name" title={item.url}>
          {displayName(item.url)}
        </div>
        <div class="meta">
          <span class="chip">{KIND_LABEL[item.kind]}</span>
          <span>{formatBytes(item.size)}</span>
          <span>found in {item.source === 'network' ? 'network' : 'page'}</span>
        </div>
        {isStream && <div class="note">Streams can be saved once the stream engine lands (Phase 2).</div>}
        {status?.state === 'error' && <div class="error">{status.message}</div>}
      </div>
      <button
        disabled={isStream || status?.state === 'saving' || status?.state === 'saved'}
        onClick={save}
      >
        {status?.state === 'saving' ? 'Saving…' : status?.state === 'saved' ? 'Saved' : 'Download'}
      </button>
    </li>
  );
}

function App() {
  const [tabId, setTabId] = useState<number>();
  const [items, setItems] = useState<MediaCandidate[]>();

  useEffect(() => {
    void targetTabId().then(setTabId);
  }, []);

  useEffect(() => {
    if (tabId === undefined) return;
    const refresh = () => void sendRequest({ type: 'media/list', tabId }).then(setItems);
    refresh();
    const onMessage = (message: MediaChangedEvent) => {
      if (message?.type === 'media/changed' && message.tabId === tabId) refresh();
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [tabId]);

  return (
    <main>
      <header>
        <h1>MetaExtract</h1>
        <a href={browser.runtime.getURL('/options.html')} target="_blank">
          Options
        </a>
      </header>
      {items === undefined || tabId === undefined ? (
        <p class="empty">Loading…</p>
      ) : items.length === 0 ? (
        <p class="empty">
          No video found on this page yet. Start playing it, then reopen this popup.
        </p>
      ) : (
        <ul class="list">
          {/* Newest first: the video the user just started is usually the one they want. */}
          {[...items].reverse().map((item) => (
            <MediaRow key={item.id} item={item} tabId={tabId} />
          ))}
        </ul>
      )}
    </main>
  );
}

render(<App />, document.getElementById('app')!);
