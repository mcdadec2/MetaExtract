import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures';
import { openPopup, tabIdFor } from './helpers';

test('detects a progressive MP4 and saves it with a JSON sidecar', async ({
  page,
  site,
  serviceWorker,
  extensionId,
}) => {
  await page.goto(`${site}/video.html`);
  const tabId = await tabIdFor(serviceWorker, page);
  const popup = await openPopup(page, extensionId, tabId);

  // Found by both the network sniffer and the DOM scan, listed once.
  const row = popup.locator('.row', { hasText: 'sample.mp4' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('MP4/WebM');
  await expect(row).toContainText('112 KB');
  await expect
    .poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId))
    .toBe('1');

  await row.getByRole('button', { name: 'Download' }).click();
  await expect(row.getByRole('button')).toHaveText('Added');

  const downloads = await expect
    .poll(async () => {
      const items = await serviceWorker.evaluate(() => chrome.downloads.search({ state: 'complete' }));
      return items.length;
    })
    .toBe(2)
    .then(() => serviceWorker.evaluate(() => chrome.downloads.search({ state: 'complete' })));

  const video = downloads.find((item) => item.mime === 'video/mp4')!;
  const sidecar = downloads.find((item) => item.mime === 'application/json')!;
  expect(video.fileSize).toBe(readFileSync('tests/e2e/site/media/sample.mp4').length);
  expect(video.filename).toMatch(/MetaExtract[/\\]127\.0\.0\.1_\d{4}-\d{2}-\d{2}_Plain video page\.mp4$/);
  expect(sidecar.filename).toBe(video.filename.replace(/\.mp4$/, '.json'));

  const json = JSON.parse(readFileSync(sidecar.filename, 'utf8'));
  expect(json).toMatchObject({
    schemaVersion: 1,
    site: '127.0.0.1',
    kind: 'page',
    postUrl: `${site}/video.html`,
    title: 'Plain video page',
    mediaUrl: `${site}/media/sample.mp4`,
    mimeType: 'video/mp4',
    size: video.fileSize,
  });
});

test('lists an HLS media playlist with its single quality', async ({
  page,
  site,
  serviceWorker,
  extensionId,
}) => {
  await page.goto(`${site}/hls.html`);
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  const row = popup.locator('.row', { hasText: 'stream.m3u8' });
  await expect(row).toContainText('HLS');
  await expect(row).toContainText('Default quality');
  await expect(row).toContainText('0:02');
  await expect(row.getByRole('button', { name: 'Download' })).toBeEnabled();
});

test('finds videos named in og:video and JSON-LD', async ({ page, site, serviceWorker, extensionId }) => {
  await page.goto(`${site}/meta.html`);
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  await expect(popup.locator('.row', { hasText: 'og.mp4' })).toContainText('found in page');
  await expect(popup.locator('.row', { hasText: 'ld.mp4' })).toContainText('found in page');
  await expect(popup.locator('.row')).toHaveCount(2);
});

test('picks up a <video> added after load', async ({ page, site, serviceWorker, extensionId }) => {
  await page.goto(`${site}/dynamic.html`);
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  await expect(popup.locator('.empty')).toBeVisible();
  // The open popup refreshes itself when the background reports a change.
  await expect(popup.locator('.row', { hasText: 'late.mp4' })).toBeVisible({ timeout: 5000 });
});

test('ignores media below the size threshold', async ({ page, site, serviceWorker, extensionId }) => {
  await page.goto(`${site}/small.html`);
  await page.waitForLoadState('networkidle');
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  await expect(popup.locator('.empty')).toBeVisible();
});

test('starts a fresh list when the tab navigates', async ({ page, site, serviceWorker, extensionId }) => {
  await page.goto(`${site}/video.html`);
  const tabId = await tabIdFor(serviceWorker, page);
  await expect
    .poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId))
    .toBe('1');
  await page.goto(`${site}/small.html`);
  await expect
    .poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId))
    .toBe('');
  const popup = await openPopup(page, extensionId, tabId);
  await expect(popup.locator('.empty')).toBeVisible();
});

test('keeps the list when Chrome stops the idle service worker', async ({
  page,
  site,
  serviceWorker,
  extensionId,
}) => {
  await page.goto(`${site}/video.html`);
  const tabId = await tabIdFor(serviceWorker, page);
  await expect
    .poll(() => serviceWorker.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId))
    .toBe('1');
  // Let the debounced snapshot reach session storage, then stop the worker.
  await page.waitForTimeout(500);
  const cdp = await page.context().newCDPSession(page);
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
  expect(worker).toBeDefined();
  await cdp.send('Target.closeTarget', { targetId: worker!.targetId });
  await expect
    .poll(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.some((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    })
    .toBe(false);

  // Opening the popup wakes a fresh worker, which must reload the list.
  const popup = await openPopup(page, extensionId, tabId);
  await expect(popup.locator('.row', { hasText: 'sample.mp4' })).toBeVisible();
});
