import { defineContentScript } from 'wxt/utils/define-content-script';
import { findMediaInDocument } from '../lib/dom-scan';
import { sendRequest } from '../lib/messages';

const RESCAN_DELAY_MS = 500;

/** Tier 3 of the detection plan: media URLs visible in the DOM. */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main(ctx) {
    const reported = new Set<string>();

    const scan = () => {
      const fresh = findMediaInDocument(document).filter((item) => !reported.has(item.url));
      if (fresh.length === 0) return;
      for (const item of fresh) reported.add(item.url);
      sendRequest({ type: 'media/report', items: fresh }).catch(() => {
        // extension reloaded; ctx invalidation stops further scans
      });
    };

    // Throttled rather than debounced: busy pages (Facebook) mutate
    // constantly, and a debounce would never fire.
    let timer: number | undefined;
    const scheduleScan = () => {
      if (timer !== undefined) return;
      timer = ctx.setTimeout(() => {
        timer = undefined;
        scan();
      }, RESCAN_DELAY_MS);
    };

    scan();
    // Players add <video> elements and swap sources long after load.
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
    // Media events don't bubble, but capture-phase listeners still see them.
    document.addEventListener('loadstart', scheduleScan, true);
    ctx.onInvalidated(() => {
      observer.disconnect();
      document.removeEventListener('loadstart', scheduleScan, true);
    });
  },
});
