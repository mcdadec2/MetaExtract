import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page, Worker } from '@playwright/test';
import { expect } from './fixtures';

/** Finds the extension's tab id for a page, from inside the service worker. */
export async function tabIdFor(serviceWorker: Worker, page: Page): Promise<number> {
  const url = page.url();
  return serviceWorker.evaluate(async (target) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url === target)!.id!;
  }, url);
}

/** Opens the popup as a page for the given tab. */
export async function openPopup(page: Page, extensionId: string, tabId: number): Promise<Page> {
  const popup = await page.context().newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html?tabId=${tabId}`);
  return popup;
}

export async function openSidePanel(page: Page, extensionId: string): Promise<Page> {
  const panel = await page.context().newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  return panel;
}

/** Files saved under the downloads folder, relative paths, sorted. */
export function savedFiles(downloadsDir: string): string[] {
  return (readdirSync(downloadsDir, { recursive: true }) as string[])
    .filter((name) => /\.(mp4|webm|json)$/.test(name))
    .sort();
}

export async function waitForSaved(downloadsDir: string, count: number): Promise<string[]> {
  await expect.poll(() => savedFiles(downloadsDir).length, { timeout: 20_000 }).toBe(count);
  return savedFiles(downloadsDir).map((name) => join(downloadsDir, name));
}
