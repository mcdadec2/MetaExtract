import { browser } from 'wxt/browser';
import { DEFAULT_FILENAME_TEMPLATE } from './filename';

export interface Settings {
  filenameTemplate: string;
  writeSidecar: boolean;
  /** Network responses smaller than this are ignored (ads, previews, pixels). */
  minSizeKB: number;
}

export const DEFAULT_SETTINGS: Settings = {
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  writeSidecar: true,
  minSizeKB: 100,
};

const KEY = 'settings';

/** Fills gaps and drops bad values, so stored settings can never break a download. */
export function normalizeSettings(raw: unknown): Settings {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const template = typeof value.filenameTemplate === 'string' ? value.filenameTemplate.trim() : '';
  const minSize = Number(value.minSizeKB);
  return {
    filenameTemplate: template || DEFAULT_SETTINGS.filenameTemplate,
    writeSidecar:
      typeof value.writeSidecar === 'boolean' ? value.writeSidecar : DEFAULT_SETTINGS.writeSidecar,
    minSizeKB: Number.isFinite(minSize) && minSize >= 0 ? minSize : DEFAULT_SETTINGS.minSizeKB,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(KEY);
  return normalizeSettings(stored[KEY]);
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.sync.set({ [KEY]: normalizeSettings(settings) });
}

export function onSettingsChanged(callback: (settings: Settings) => void): void {
  browser.storage.sync.onChanged.addListener((changes) => {
    if (KEY in changes) callback(normalizeSettings(changes[KEY]!.newValue));
  });
}
