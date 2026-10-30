import { browser } from 'wxt/browser';
import { runStreamJob, type StreamJobSpec, type TempFile, type TempStorage } from '../../lib/engine/run-job';
import type { EngineCommand, EngineEvent } from '../../lib/messages';

/** Job files live in the origin private file system, so large videos never sit in memory. */
class OpfsStorage implements TempStorage {
  private readonly dir = navigator.storage
    .getDirectory()
    .then((root) => root.getDirectoryHandle('jobs', { create: true }));

  async create(name: string): Promise<TempFile> {
    const handle = await (await this.dir).getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let file: File | undefined;
    return {
      write: (data) => writable.write(data as Uint8Array<ArrayBuffer>),
      close: async () => {
        await writable.close();
        file = await handle.getFile();
      },
      read: async (offset, length) => new Uint8Array(await file!.slice(offset, offset + length).arrayBuffer()),
    };
  }

  async remove(name: string): Promise<void> {
    await (await this.dir).removeEntry(name);
  }

  async file(name: string): Promise<File> {
    return (await (await this.dir).getFileHandle(name)).getFile();
  }

  /** Leftovers from a crash or browser restart. */
  async clear(): Promise<void> {
    const dir = await this.dir;
    for await (const name of dir.keys()) await dir.removeEntry(name).catch(() => {});
  }
}

const storage = new OpfsStorage();
const running = new Map<string, AbortController>();
const finished = new Map<string, { url: string; name: string }>();
// The background only creates this document when no job is running.
const cleared = storage.clear();

function emit(event: EngineEvent): Promise<unknown> {
  return browser.runtime.sendMessage(event);
}

async function run(spec: StreamJobSpec): Promise<void> {
  await cleared;
  const controller = new AbortController();
  running.set(spec.id, controller);
  try {
    const result = await runStreamJob(spec, {
      fetch: (input, init) => fetch(input, init),
      storage,
      signal: controller.signal,
      onProgress: (progress) => void emit({ type: 'engine/progress', jobId: spec.id, ...progress }).catch(() => {}),
      onHosts: async (hosts) => {
        await emit({ type: 'engine/hosts', jobId: spec.id, hosts });
      },
    });
    const url = URL.createObjectURL(await storage.file(result.name));
    finished.set(spec.id, { url, name: result.name });
    await emit({
      type: 'engine/done',
      jobId: spec.id,
      url,
      size: result.size,
      duration: result.plan.duration,
      width: result.plan.width,
      height: result.plan.height,
    });
  } catch (error) {
    await emit({
      type: 'engine/failed',
      jobId: spec.id,
      error: error instanceof Error ? error.message : String(error),
      canceled: controller.signal.aborted,
    }).catch(() => {});
  } finally {
    running.delete(spec.id);
  }
}

async function release(jobId: string): Promise<void> {
  const output = finished.get(jobId);
  if (!output) return;
  finished.delete(jobId);
  URL.revokeObjectURL(output.url);
  await storage.remove(output.name).catch(() => {});
}

browser.runtime.onMessage.addListener((message: EngineCommand, sender, sendResponse) => {
  // Only the background (no tab, our own extension) commands the engine.
  if (sender.id !== browser.runtime.id || sender.tab) return false;
  switch (message?.type) {
    case 'engine/start':
      if (!running.has(message.spec.id)) void run(message.spec);
      sendResponse({ ok: true });
      return false;
    case 'engine/cancel':
      running.get(message.jobId)?.abort(new Error('Canceled'));
      sendResponse({ ok: true });
      return false;
    case 'engine/release':
      void release(message.jobId);
      sendResponse({ ok: true });
      return false;
  }
  return false;
});
