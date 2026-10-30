# MetaExtract

A Chrome (Manifest V3) extension that saves the video playing on a page as a
file with a JSON metadata sidecar. Everything runs locally in the browser; the
extension makes no requests of its own beyond downloading what you ask for.

See [docs/PLAN.md](docs/PLAN.md) for the review of existing video capture
extensions, the architecture and the phased build plan.

## Status

**Phases 1 and 2 are done.** It can:

- detect progressive video (MP4, WebM, …) from network traffic and from the
  page (`<video>`, `og:video`, JSON-LD), plus HLS and DASH manifests;
- list what it found per tab in the popup, with a quality picker for streams;
- save progressive files directly, and HLS/DASH streams as one MP4 with
  video and audio merged (no re-encoding), including AES-128 HLS and
  CDNs that check the Referer;
- show a download queue with progress, cancel and retry in the side panel;
- write a JSON sidecar next to every saved video.

It refuses DRM-protected and live streams with a message saying why.

Not yet: Facebook and Instagram support (Phase 3) and recording `blob:`
players (Phase 4). On Facebook and Instagram the popup will mostly show
nothing useful until Phase 3.

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
`npx playwright install chromium`. Tests that check merged files decode
cleanly need `ffmpeg`/`ffprobe` on the PATH, and are skipped without them.
`tests/e2e/make-stream-fixtures.sh` regenerates the HLS/DASH fixtures.

Layout:

- `src/entrypoints/background.ts`: service worker: network sniffing, per-tab
  media list, stream inspection; `src/background/`: download queue,
  offscreen engine control, Referer/Origin rules
- `src/entrypoints/offscreen/`: the stream engine (runs jobs, stores parts
  in the origin private file system)
- `src/entrypoints/content.ts`: DOM scan in every frame
- `src/entrypoints/popup/`, `sidepanel/`, `options/`: UI (Preact)
- `src/lib/streams/`: HLS/DASH manifest parsing; `src/lib/mp4/`: fragmented
  MP4 parsing and merging; `src/lib/engine/`: fetching, decryption,
  transmuxing and the job runner
- `tests/unit/`: Vitest tests, including the whole engine against the fixtures
- `tests/e2e/`: Playwright tests and the local test site they load

## License

GNU General Public License v3.0; see [LICENSE](LICENSE). Bundled libraries
are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
