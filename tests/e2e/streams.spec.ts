import { readdirSync, readFileSync } from 'node:fs';
import { hasFfprobe, probe } from '../unit/media-check';
import { expect, test } from './fixtures';
import { openPopup, openSidePanel, tabIdFor, waitForSaved } from './helpers';

/** A page whose "player" fetches the given manifests, like hls.js or dash.js would. */
function streamPage(site: string, ...sources: string[]): string {
  return `${site}/stream.html?${sources.map((src) => `src=${encodeURIComponent(src)}`).join('&')}`;
}

const VARIANTS = [
  { name: 'HLS TS, chosen quality', src: '/streams/hls-ts/master.m3u8', quality: '108p · 185 kbps', width: 192 },
  { name: 'HLS fMP4 with separate audio', src: '/streams/hls-fmp4/master.m3u8', width: 320 },
  { name: 'HLS AES-128', src: '/streams/hls-aes/index.m3u8', width: 320 },
  { name: 'DASH SegmentTemplate', src: '/streams/dash-template/manifest.mpd', width: 320 },
  { name: 'DASH SegmentList', src: '/streams/dash-single/manifest.mpd', width: 320 },
  { name: 'DASH SegmentBase (Facebook/Instagram layout)', src: '/streams/dash-single/segmentbase.mpd', width: 320 },
  { name: 'DASH behind a Referer check', src: '/protected/streams/dash-single/segmentbase.mpd', width: 320 },
];

for (const variant of VARIANTS) {
  test(`saves ${variant.name} as one playable MP4 with a sidecar`, async ({
    page,
    site,
    serviceWorker,
    extensionId,
    downloadsDir,
  }) => {
    test.skip(!hasFfprobe, 'needs ffmpeg to check the output');
    await page.goto(streamPage(site, variant.src));
    const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
    const row = popup.locator('.row').first();
    await expect(popup.locator('.row')).toHaveCount(1);
    if (variant.quality) await row.getByLabel('Quality').selectOption({ label: variant.quality });
    await row.getByRole('button', { name: 'Download' }).click();
    await expect(row).toContainText('Added');

    const panel = await openSidePanel(page, extensionId);
    await expect(panel.locator('.job').first()).toHaveAttribute('data-state', 'done', { timeout: 20_000 });
    await expect(panel.locator('.job').first()).toContainText('Saved');

    const [json, mp4] = await waitForSaved(downloadsDir, 2);
    expect(mp4).toMatch(/MetaExtract[/\\]127\.0\.0\.1_\d{4}-\d{2}-\d{2}_Stream page\.mp4$/);
    const media = probe(mp4!);
    expect(media.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac']);
    expect(media.streams[0]!.width).toBe(variant.width);
    expect(media.duration).toBeGreaterThan(3.8);
    expect(media.duration).toBeLessThan(4.3);
    expect(media.decodeErrors).toBe('');

    const sidecar = JSON.parse(readFileSync(json!, 'utf8'));
    expect(sidecar).toMatchObject({
      title: 'Stream page',
      mediaUrl: `${site}${variant.src}`,
      mimeType: 'video/mp4',
      duration: 4,
      size: readFileSync(mp4!).length,
    });
  });
}

test('sends the page as Referer on every engine request to a protected CDN', async ({
  page,
  site,
  serviceWorker,
  extensionId,
  downloadsDir,
  seenRequests,
}) => {
  const src = '/protected/streams/dash-template/manifest.mpd';
  await page.goto(streamPage(site, src));
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  await popup.locator('.row').getByRole('button', { name: 'Download' }).click();
  await waitForSaved(downloadsDir, 2);
  const protectedRequests = seenRequests.filter((r) => r.path.startsWith('/protected/streams/dash-template/'));
  expect(protectedRequests.length).toBeGreaterThan(9); // manifest, inits and segments
  for (const request of protectedRequests) expect(request.referer).toBe(page.url());
});

test('shows only the master playlist, not the media playlists it points to', async ({
  page,
  site,
  serviceWorker,
  extensionId,
}) => {
  await page.goto(streamPage(site, '/streams/hls-ts/master.m3u8', '/streams/hls-ts/180p.m3u8'));
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  await expect(popup.getByLabel('Quality')).toBeVisible();
  await expect(popup.locator('.row')).toHaveCount(1);
  await expect(popup.locator('.row')).toContainText('master.m3u8');
  await expect(popup.getByLabel('Quality').locator('option')).toHaveText(['180p · 383 kbps', '108p · 185 kbps']);
});

for (const [src, message] of [
  ['/streams/dash-template/drm.mpd', 'DRM-protected'],
  ['/streams/hls-aes/fairplay.m3u8', 'DRM-protected'],
  ['/streams/hls-ts/live.m3u8', 'Live streams can’t be saved yet'],
]) {
  test(`explains why ${src} can't be saved`, async ({ page, site, serviceWorker, extensionId }) => {
    await page.goto(streamPage(site, src!));
    const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
    const row = popup.locator('.row');
    await expect(row).toContainText(message!);
    await expect(row.getByRole('button')).toHaveCount(0);
  });
}

test('cancels a running stream download and keeps nothing', async ({
  page,
  site,
  serviceWorker,
  extensionId,
  downloadsDir,
}) => {
  await page.goto(streamPage(site, '/slow/streams/dash-template/manifest.mpd'));
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  await popup.locator('.row').getByRole('button', { name: 'Download' }).click();
  const panel = await openSidePanel(page, extensionId);
  const job = panel.locator('.job').first();
  await expect(job).toHaveAttribute('data-state', 'downloading');
  await job.getByRole('button', { name: 'Cancel' }).click();
  await expect(job).toHaveAttribute('data-state', 'canceled');
  await expect(job.getByRole('button', { name: 'Retry' })).toBeVisible();
  await page.waitForTimeout(1500);
  expect(readdirOrEmpty(downloadsDir)).toEqual([]);

  // Retry runs it again to completion.
  await job.getByRole('button', { name: 'Retry' }).click();
  await expect(job).toHaveAttribute('data-state', 'done', { timeout: 30_000 });
  await waitForSaved(downloadsDir, 2);
});

test('lists progressive downloads in the side panel too', async ({
  page,
  site,
  serviceWorker,
  extensionId,
  downloadsDir,
}) => {
  await page.goto(`${site}/video.html`);
  const popup = await openPopup(page, extensionId, await tabIdFor(serviceWorker, page));
  await popup.locator('.row', { hasText: 'sample.mp4' }).getByRole('button', { name: 'Download' }).click();
  const panel = await openSidePanel(page, extensionId);
  await expect(panel.locator('.job').first()).toHaveAttribute('data-state', 'done');
  await expect(panel.locator('.job').first()).toContainText('Plain video page');
  await expect(panel.getByRole('button', { name: 'Show in folder' })).toBeVisible();
  await waitForSaved(downloadsDir, 2);
  await panel.getByRole('button', { name: 'Clear finished' }).click();
  await expect(panel.locator('.empty')).toBeVisible();
});

function readdirOrEmpty(dir: string): string[] {
  try {
    return (readdirSync(dir, { recursive: true }) as string[]).filter((n) => !n.endsWith('MetaExtract'));
  } catch {
    return [];
  }
}
