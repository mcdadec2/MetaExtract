import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import '../../assets/base.css';
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '../../lib/settings';
import './style.css';

function App() {
  const [settings, setSettings] = useState<Settings>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  if (!settings) return <main>Loading…</main>;

  const update = (patch: Partial<Settings>) => {
    setSettings({ ...settings, ...patch });
    setSaved(false);
  };

  const submit = async (event: Event) => {
    event.preventDefault();
    await saveSettings(settings);
    setSettings(await loadSettings());
    setSaved(true);
  };

  return (
    <main>
      <h1>MetaExtract options</h1>
      <form onSubmit={submit}>
        <label>
          <span>Filename template</span>
          <input
            name="filenameTemplate"
            value={settings.filenameTemplate}
            onInput={(e) => update({ filenameTemplate: e.currentTarget.value })}
          />
          <small>
            Variables: <code>{'{site}'}</code> <code>{'{title}'}</code> <code>{'{date}'}</code>{' '}
            <code>{'{time}'}</code> <code>{'{id}'}</code> <code>{'{ext}'}</code>. Use <code>/</code> for
            subfolders inside your Downloads folder. Default:{' '}
            <code>{DEFAULT_SETTINGS.filenameTemplate}</code>
          </small>
        </label>
        <label class="check">
          <input
            type="checkbox"
            name="writeSidecar"
            checked={settings.writeSidecar}
            onChange={(e) => update({ writeSidecar: e.currentTarget.checked })}
          />
          <span>Save a JSON metadata file next to each video</span>
        </label>
        <label>
          <span>Ignore network media smaller than (KB)</span>
          <input
            type="number"
            min={0}
            name="minSizeKB"
            value={settings.minSizeKB}
            onInput={(e) => update({ minSizeKB: Number(e.currentTarget.value) })}
          />
          <small>Skips ads, previews and tracking pixels.</small>
        </label>
        <div class="actions">
          <button type="submit">Save</button>
          {saved && <span class="saved">Saved</span>}
        </div>
      </form>
      <p class="version">Version {browser.runtime.getManifest().version}</p>
    </main>
  );
}

render(<App />, document.getElementById('app')!);
