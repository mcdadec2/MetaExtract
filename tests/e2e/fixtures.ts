import { test as base, chromium, type BrowserContext, type Worker } from '@playwright/test';
import { createReadStream, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const EXTENSION_PATH = resolve('.output/chrome-mv3');
const SITE_ROOT = resolve('tests/e2e/site');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

/** Static server for the test site, with Range support like a real CDN. */
function startServer(): Promise<Server> {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url!, 'http://x').pathname));
    const file = join(SITE_ROOT, path);
    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
    };
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'content-length': size });
      createReadStream(file).pipe(res);
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

export const test = base.extend<
  { context: BrowserContext; serviceWorker: Worker; extensionId: string; downloadsDir: string },
  { site: string }
>({
  site: [
    async ({}, use) => {
      const server = await startServer();
      await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      server.close();
    },
    { scope: 'worker' },
  ],
  downloadsDir: async ({}, use) => {
    await use(mkdtempSync(join(tmpdir(), 'metaextract-downloads-')));
  },
  context: async ({ downloadsDir }, use) => {
    // Chrome's own download handling, not Playwright's: Playwright (and any
    // DevTools download override) ignores the filename an extension asks for.
    const userDataDir = mkdtempSync(join(tmpdir(), 'metaextract-profile-'));
    mkdirSync(join(userDataDir, 'Default'));
    writeFileSync(
      join(userDataDir, 'Default', 'Preferences'),
      JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false } }),
    );
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });
    const cdp = await context.newCDPSession(context.pages()[0] ?? (await context.newPage()));
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await use(worker);
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
  },
});

export const expect = test.expect;
