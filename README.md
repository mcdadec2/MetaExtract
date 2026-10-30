# MetaExtract

A Chrome (Manifest V3) extension that saves the video playing on a page as a
file with a JSON metadata sidecar. Everything runs locally in the browser; the
extension makes no requests of its own beyond downloading what you ask for.

See [docs/PLAN.md](docs/PLAN.md) for the review of existing video capture
extensions, the architecture and the phased build plan.

## Status

**Phase 1 (skeleton) is done.** It can:

- detect progressive video (MP4, WebM, …) from network traffic and from the
  page (`<video>`, `og:video`, JSON-LD), plus HLS and DASH playlists;
- list what it found per tab in the popup, with a count on the toolbar icon;
- save progressive videos with a filename template and a JSON sidecar.

Not yet: saving HLS/DASH streams (Phase 2), Facebook and Instagram support
(Phase 3), and recording `blob:` players (Phase 4). On Facebook and Instagram
the popup will mostly show nothing useful until Phase 3.

## Install (unpacked)

1. Build it (see below), or download `extension` from a CI run's artifacts.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `.output/chrome-mv3` folder.

To update, rebuild (or replace the folder) and click the extension's reload
button on `chrome://extensions`.

## Development

Requires Node 22.

```bash
npm install
```

```bash
npm run dev        # Chrome with the extension loaded and hot reload
npm run build      # production build in .output/chrome-mv3
npm run typecheck
npm test           # unit tests (Vitest)
npm run test:e2e   # builds, then runs Playwright against a local test site
```

The first `npm run test:e2e` on a new machine needs a browser:
`npx playwright install chromium`.

Layout:

- `src/entrypoints/background.ts`: service worker: network sniffing, per-tab
  media list, downloads
- `src/entrypoints/content.ts`: DOM scan in every frame
- `src/entrypoints/popup/`, `src/entrypoints/options/`: UI (Preact)
- `src/lib/`: pure logic (classification, store, filenames, sidecar,
  message validation), covered by `tests/unit`
- `tests/e2e/`: Playwright tests and the local test site they load

## License

GNU General Public License v3.0; see [LICENSE](LICENSE).
