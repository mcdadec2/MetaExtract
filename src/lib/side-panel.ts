import { browser } from 'wxt/browser';

/**
 * Opens the downloads side panel. Chrome only allows this during a user
 * gesture, so call it first thing in a click handler, before any await.
 */
export function openDownloadsPanel(windowId: number | undefined): void {
  if (windowId === undefined) return;
  browser.sidePanel.open({ windowId }).catch(() => {
    // not in a gesture (e.g. a test page); the panel is still in the side panel menu
  });
}
