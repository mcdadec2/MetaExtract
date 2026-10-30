import { browser } from 'wxt/browser';
import type { EngineCommand } from '../lib/messages';

const URL_PATH = '/offscreen.html';
let creating: Promise<void> | undefined;

export async function hasEngine(): Promise<boolean> {
  const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

/** The engine runs in an offscreen document: it outlives service worker restarts and can make blob URLs. */
async function ensureEngine(): Promise<void> {
  if (await hasEngine()) return;
  creating ??= browser.offscreen
    .createDocument({
      url: URL_PATH,
      reasons: ['BLOBS'],
      justification: 'Downloads and merges video streams, then hands the file to chrome.downloads.',
    })
    .finally(() => {
      creating = undefined;
    });
  await creating;
}

export async function closeEngine(): Promise<void> {
  if (await hasEngine()) await browser.offscreen.closeDocument();
}

/**
 * Sends a command to the engine, starting it if needed. Other extension
 * pages also receive runtime messages, so only an `{ ok: true }` reply
 * counts as delivered; a new document may need a moment to listen.
 */
export async function sendToEngine(command: EngineCommand): Promise<void> {
  await ensureEngine();
  for (let attempt = 0; attempt < 30; attempt++) {
    const reply = (await browser.runtime.sendMessage(command).catch(() => undefined)) as { ok?: boolean } | undefined;
    if (reply?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The download engine did not start.');
}
