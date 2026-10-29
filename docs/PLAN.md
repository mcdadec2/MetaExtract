# MetaExtract: Video Capture Extension Plan

A Chrome (Manifest V3) extension that finds the video playing on any page,
including Facebook and Instagram, and saves it as a single playable file with a
metadata sidecar. Everything runs locally in the browser.

---

## 1. Goals and non-goals

**Goals**

- Detect downloadable video on any site: progressive MP4/WebM, HLS (`.m3u8`),
  DASH (`.mpd`), and `blob:` players backed by Media Source Extensions (MSE).
- Facebook and Instagram are first-class targets: posts, Reels, Watch, Stories
  the signed-in user can already view, and carousel posts.
- Output one muxed `.mp4` (video and audio together) at the best available
  quality, without re-encoding when possible.
- Write an optional `.json` sidecar with title, author, post URL, timestamp,
  caption, duration and resolution. This is the "Meta" in MetaExtract.
- No servers, telemetry or remote code. The extension makes no requests the
  user's own browser session couldn't make.

**Non-goals (deliberate)**

- **No DRM circumvention.** Widevine/PlayReady/FairPlay content (Netflix,
  Disney+, Prime, most paid streaming) is out of scope. The extension detects
  encrypted media (`encrypted` event, `requestMediaKeySystemAccess`, `cenc`
  boxes) and says "protected content, can't be saved" instead of producing
  garbage.
- **No YouTube in the Chrome Web Store build.** Store policy rejects
  extensions that download from YouTube. The store build blocks that domain.
  A self-distributed build can drop the block.
- **No bulk scraping.** No profile, hashtag or "download all" crawlers. That
  needs calls to private APIs, violates Meta's terms most visibly, and is the
  thing most likely to break or get accounts flagged. One video at a time,
  or the items of one carousel.
- No private content the user can't already see.

---

## 2. Review of existing extensions

| Extension | How it finds video | How it saves | FB / IG | Notes |
|---|---|---|---|---|
| **Video DownloadHelper** | Network sniffing (`webRequest`) plus per-site logic | Direct download; HLS/DASH merging and conversion through a native **CoApp** (ffmpeg) installed separately | Partial; merging needs CoApp | About 5M users, MV3, freemium. Strong format coverage, but the native helper means a second install, OS-specific bugs (bitness and registry issues in its wiki) and a paid tier. |
| **cat-catch (猫抓)** | `webRequest` sniffing on all URLs, plus an injected script that **hooks MSE** (`MediaSource.addSourceBuffer`, `SourceBuffer.appendBuffer`, `endOfStream`) and records the bytes the player feeds in | m3u8 and mpd parser pages (hls.js, mux.js, mpd-parser), StreamSaver for large files, optional ffmpeg merge; MSE capture saves one file per track | Works through MSE capture during playback, with no site-specific parsing | GPL-3.0, MV3, about 18k stars. The best open-source reference. Weak spots: MSE capture only gets what the player buffered (real-time, current quality); it finds init segments by scanning for `ftyp`/EBML magic; audio and video come out as separate files unless ffmpeg is used. Fake clones with adware exist in the stores. |
| **HLS Downloader** (puemos) | Detects `.m3u8` playlists | Fetches segments into browser storage, muxes with **ffmpeg.wasm** to MP4/MKV, lets you pick quality and audio track | No; Meta doesn't use HLS for ordinary posts | MIT. Clean architecture (React popup, Redux + redux-observable, pnpm workspaces, e2e tests). HLS only. Good model for the download engine and UI. |
| **Stream Recorder–style tools** | MSE or playback recording | Records while the video plays | Works generically | Simple and universal, but real-time and tied to whatever quality the player chose. |
| **Site-specific FB/IG downloaders** (many store listings) | Read page JSON or call Meta's internal GraphQL/REST endpoints | Direct link to the progressive MP4 | Yes, until Meta changes something | They break often. Many are ad-funded, route requests through their own servers, or have been sold and turned malicious. Usually progressive-only (lower quality, no DASH merge). |
| **Screen/tab recorders** (Loom, Screencastify, `tabCapture` samples) | None; they record pixels | `MediaRecorder` → WebM | Always works | Universal, but real-time, re-encoded (quality loss), records UI overlays, and DRM video records as black. |
| **yt-dlp** (CLI, reference only) | Per-site extractors | ffmpeg | Yes, actively maintained | Not an extension, but its `facebook.py` and `instagram.py` extractors are the most reliable public record of where Meta keeps video URLs. Instagram's extractor was reworked in mid-2026. Track its changelog. |

### What to take from them

1. **No single detection method covers everything.** The robust tools stack
   several: site parsers for quality and metadata, network sniffing for
   generic sites, MSE capture as the universal fallback.
2. **Everything should merge in the browser.** A native helper (VDH) is the
   biggest usability cost. ffmpeg.wasm (HLS Downloader) shows merging works
   in the browser.
3. **MSE capture is the "any website" trick**, but it is real-time and
   current-quality only, so it's a fallback, not the main path.
4. **Site adapters must be isolated and cheap to update.** Meta changes its
   JSON shapes regularly. A broken adapter should fall back to the generic
   tiers, not break the extension.
5. **Trust is a feature.** Fake clones and adware downloaders are common. Open
   source, minimal permissions, no network calls of its own and no telemetry
   set this apart.

---

## 3. How Facebook and Instagram deliver video

Both use the same Meta player stack. The `<video>` element's `src` is a `blob:`
URL backed by MSE, which is why "right-click → save video" and naive
downloaders fail.

### Facebook

- Video metadata ships inside the page and in GraphQL responses (Relay
  "prefetched" data in `<script type="application/json">` tags, plus later
  `/api/graphql/` fetches as you scroll).
- Fields worth looking for (per yt-dlp's extractor):
  - Legacy, often under `videoDeliveryLegacyFields`: `playable_url` (SD,
    muxed), `playable_url_quality_hd` (HD, muxed), `browser_native_sd_url`,
    `browser_native_hd_url`, `playable_url_dash`, `dash_manifest`.
  - Newer: `videoDeliveryResponseFragment` → `videoDeliveryResponseResult` →
    `progressive_urls`, `dash_manifests`, `dash_manifest_urls`,
    `hls_playlist_urls`.
  - Captions: `video_available_captions_locales`, `captions_url`.
- DASH manifests are often **inline XML strings**, URL-encoded. The
  representations point to `*.fbcdn.net` MP4 files with separate video and
  audio tracks. The player fetches byte ranges (`bytestart`/`byteend` query
  params). Dropping those params reportedly returns the whole representation.
  **Verify in Phase 0.**
- CDN URLs are signed and expire (`oe=` param). Download soon after detection,
  or refresh from the page.

### Instagram

- Media JSON appears in `data-sjs` script tags (`RelayPrefetchedStreamCache`
  → `xig_polaris_media`) and in responses from `/api/graphql` and
  `/api/v1/media/{id}/info/`.
- Fields: `video_versions[]` (progressive MP4s with `url`, `width`, `height`;
  usually muxed but capped in quality), `video_dash_manifest` (inline MPD with
  separate higher-quality video and audio), `has_audio`, `video_duration`,
  `carousel_media[]` for multi-item posts, plus `user.username`, `caption.text`,
  `taken_at`, `code` (shortcode) for the sidecar.
- Instagram sends `X-IG-App-ID: 936619743392459` on web API calls. We won't
  make our own API calls (see 5.1), so we only need to recognise these
  responses.

### Consequences for the design

- **Best quality** = parse the DASH manifest, fetch the best video and best
  audio representation, and remux. **Fastest path** = the muxed progressive URL
  (`browser_native_hd_url` / top `video_versions` entry), offered as "Quick
  download".
- We can get all of this **passively**, by reading what the page already loaded,
  so we never call Meta's private endpoints ourselves.

---

## 4. Architecture

```
┌─────────────────────────── Web page (any site) ───────────────────────────┐
│ MAIN world script (document_start)                                        │
│   • fetch/XHR response tap   → scans JSON for known media keys (adapters) │
│   • MSE hook                 → records SourceBuffer appends (fallback)    │
│   • EME detector             → flags DRM                                  │
│        │ window.postMessage (validated, untrusted)                        │
│ ISOLATED content script                                                   │
│   • reads <script data-sjs>/Relay JSON on load + SPA navigations          │
│   • runs site adapters (facebook, instagram, generic <video>/og:video)    │
│   • optional in-page "Save" button (off by default)                       │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ chrome.runtime messages
┌──────────────▼──────────── Service worker ────────────────────────────────┐
│ • webRequest.onResponseStarted (observe only): media by MIME/extension    │
│ • Detection store per tab: dedupe, group audio+video, rank by quality     │
│ • declarativeNetRequest session rules: add Referer/Origin to our fetches  │
│ • Download queue state, badge count, context menu                         │
└──────────────┬────────────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────── Offscreen document ────────────────────────────┐
│ Download engine: segment fetch (concurrency, retry, AES-128 for HLS)      │
│   → OPFS temp storage → remux (mp4box/mux.js, ffmpeg.wasm fallback)       │
│   → blob URL → chrome.downloads                                           │
│ Tab recorder: tabCapture stream → MediaRecorder (last-resort fallback)    │
└───────────────────────────────────────────────────────────────────────────┘
┌──────────── UI ───────────┐
│ Popup: media found in tab │  Side panel: download queue, progress, history
└───────────────────────────┘
```

### 4.1 Detection tiers, in priority order

1. **Site adapters** (Facebook, Instagram; add others later). Pure functions
   `(json) → MediaCandidate[]` that walk any JSON blob for the keys in §3.
   They are fed page script JSON on load, every tapped `fetch`/XHR JSON
   response, and re-scans on SPA navigation (`history.pushState` hook +
   `navigation` events). Key names live in a **data table**, not code, so a
   Meta schema change is a one-line fix. MV3 allows remote *data*, so a signed
   remote rules JSON is possible later; no remote code.
2. **Generic network sniffing.** `webRequest.onResponseStarted` with
   `<all_urls>`, matching `Content-Type` (`video/*`, `audio/*`,
   `application/vnd.apple.mpegurl`, `application/x-mpegURL`,
   `application/dash+xml`) and extensions (`.mp4 .webm .m3u8 .mpd .m4s .ts`).
   Ignore tiny responses and known ad/tracker hosts. Group segment requests
   under their playlist.
3. **DOM scan.** `<video src>` / `<source>` with real URLs, `og:video` meta,
   JSON-LD `VideoObject`.
4. **MSE capture.** Hook `MediaSource.prototype.addSourceBuffer` and the
   returned `SourceBuffer.appendBuffer` (the cat-catch technique). Store
   chunks per track with MIME type. Offer "Record while playing" for players
   none of the above can resolve. Track init segments explicitly (first
   append after `addSourceBuffer` and any `changeType`) rather than scanning
   for magic bytes. Bytes go to OPFS in chunks so long videos don't sit in
   page memory.
5. **Tab recording.** `chrome.tabCapture.getMediaStreamId` (needs a user
   gesture) → offscreen document `getUserMedia({chromeMediaSource:'tab'})` →
   `MediaRecorder`. Works on anything not DRM-protected, at the cost of
   real-time capture and re-encoding.

Each `MediaCandidate` carries: `id`, `source tier`, `kind`
(progressive/hls/dash/mse/recording), `tracks[]` (url or byte source, MIME,
codec, bitrate, width/height, language), `duration`, `muxed?`, `expiresAt?`,
`drm?`, and `metadata` (title, author, postUrl, publishedAt, caption, thumbnail).

### 4.2 Download engine (offscreen document)

- **Progressive**: `chrome.downloads.download` directly. The browser handles
  resume and large files.
- **HLS**: parse master and media playlists (`m3u8-parser`), pick variant and
  audio rendition, fetch segments with bounded concurrency (4–6), retry with
  backoff, refresh the playlist on expiry, decrypt AES-128 with WebCrypto.
  Refuse SAMPLE-AES / `EXT-X-KEY` with a DRM keyformat.
- **DASH**: parse MPD (`mpd-parser`, which handles inline XML too); support
  `SegmentBase` (single file + byte ranges, Meta's case), `SegmentTemplate`
  and `SegmentList`. Refuse `ContentProtection` elements.
- **Remux**, no re-encode:
  - fMP4 video + fMP4 audio → MP4: mp4box.js, or a small in-house muxer that
    merges both `moov`s and interleaves `moof/mdat`. Fast and tiny.
  - MPEG-TS (HLS) → MP4: `mux.js` transmuxer.
  - Anything else, or when the above fails: **ffmpeg.wasm** (`-c copy`),
    bundled locally (MV3 forbids remote code; needs `wasm-unsafe-eval` in the
    extension CSP). Load it lazily; it's about 30 MB.
- **Storage**: segments stream to **OPFS**, not memory, so multi-GB files
  don't crash the tab. The final file is assembled into a `Blob` backed by OPFS
  and handed to `chrome.downloads` via an object URL created in the offscreen
  document (the service worker can't create object URLs).
- **Headers**: some CDNs require `Referer`/`Origin`. Add them only for our own
  requests with `declarativeNetRequest` session rules scoped to
  `initiatorDomains: [chrome.runtime.id]`.
- **Lifetime**: MV3 service workers sleep after about 30 s idle. All long work
  runs in the offscreen document, and queue state is persisted to
  `chrome.storage.session` so a restart resumes.

### 4.3 UI

- **Popup**: list of media for the current tab, with thumbnail, title, quality
  options (e.g. "1080p · 2 tracks · ~84 MB"), **Download** and **Quick
  download** (progressive) buttons, "Record while playing" when only tiers 4–5
  apply, and a DRM notice when relevant. A badge shows the count.
- **Side panel**: queue, per-item progress, cancel/retry, history, "show in
  folder".
- **Options**: filename template (`{site}_{author}_{date}_{title}.{ext}`),
  sidecar on/off, preferred quality, max concurrency, per-site enable/disable,
  MSE hook on/off.
- **In-page button** on FB/IG video hover: off by default. It touches Meta's
  DOM, the part that changes most and is most visible to their integrity
  systems.

### 4.4 Manifest sketch

```jsonc
{
  "manifest_version": 3,
  "name": "MetaExtract",
  "permissions": ["webRequest", "declarativeNetRequest", "downloads",
                  "storage", "offscreen", "scripting", "tabCapture",
                  "sidePanel", "contextMenus"],
  "host_permissions": ["*://*.facebook.com/*", "*://*.instagram.com/*",
                       "*://*.fbcdn.net/*", "*://*.cdninstagram.com/*"],
  "optional_host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["main-world.js"],
      "run_at": "document_start", "all_frames": true, "world": "MAIN" },
    { "matches": ["<all_urls>"], "js": ["content.js"],
      "run_at": "document_start", "all_frames": true }
  ],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  }
}
```

Permissions strategy: Facebook and Instagram are required host permissions.
`<all_urls>` is optional and requested at onboarding ("enable on all
sites"). Sniffing needs the permission *before* a page loads, so `activeTab`
alone doesn't work. This keeps the Web Store review lighter and is honest with
users. Content scripts for other sites are registered dynamically
(`chrome.scripting.registerContentScripts`) once the optional permission is
granted.

### 4.5 Security and robustness rules

- Everything the MAIN-world script sends is **untrusted** (the page can forge
  `postMessage`). Validate the shape, accept only http(s)/blob URLs, never eval,
  and never let page data pick a download path.
- Hooks must be invisible and safe: wrap with `Proxy`, preserve
  `Function.prototype.toString` output, never throw into the page, and call the
  original first.
- Response tapping clones the response and parses off the hot path, skipping
  bodies over a size cap.
- Filenames are sanitized and capped in length.

---

## 5. Tech stack

- **TypeScript**, built with **WXT** (MV3-first, handles MAIN/ISOLATED
  scripts, offscreen documents and a Firefox build target). Plain Vite +
  CRXJS also works.
- **UI**: Preact or React + a small CSS layer. Popup and side panel share
  components.
- **Parsing/muxing**: `m3u8-parser`, `mpd-parser`, `mux.js`, `mp4box.js`,
  `@ffmpeg/ffmpeg` (bundled, lazy).
- **Testing**:
  - Vitest unit tests for adapters against **saved JSON fixtures** from real
    FB/IG pages (scrubbed of personal data), and for playlist/MPD parsing and
    remuxing.
  - Playwright e2e with the unpacked extension against **local test pages**:
    progressive MP4, HLS (TS and fMP4, AES-128), DASH SegmentBase and
    SegmentTemplate, an MSE player (hls.js/dash.js), an EME page that must be
    refused. CI never hits live Facebook or Instagram.
  - A manual smoke checklist for live FB/IG (post, Reel, Watch, Story,
    carousel, logged-out view) run before each release.
- **Licensing note**: cat-catch is GPL-3.0. Reading it for ideas is fine,
  but copying code makes MetaExtract GPL-3.0. HLS Downloader is MIT and can
  be reused with attribution. Pick our license before Phase 1 (see §8).

### 5.1 Why passive extraction only

Calling Meta's GraphQL/REST endpoints directly (as yt-dlp and many downloader
extensions do) needs tokens (`lsd`, `csrftoken`, `doc_id` values) that rotate,
adds request patterns Meta's integrity systems can flag on the user's
account, and breaks more often. Reading responses the page already received
gets the same data with none of those costs. The trade-off: a video has to be
loaded in the page (open the post or Reel) before we can offer it.

---

## 6. Phased delivery

Each phase ends with something shippable and testable.

**Phase 0: Spike and fixtures**
- Record HAR files and page JSON for a FB post, FB Reel, FB Watch, IG post,
  IG Reel, IG carousel and IG Story. Confirm the keys in §3, the
  `bytestart`/`byteend` behavior, URL expiry, and whether progressive URLs are
  muxed.
- Prototype the MAIN-world fetch tap and MSE hook on both sites. Make sure
  playback isn't affected.
- *Exit:* fixture set committed; written list of the exact JSON paths in use
  today.

**Phase 1: Skeleton + generic progressive**
- WXT project, service worker, popup, detection store, `webRequest` sniffing,
  DOM scan, direct downloads, filename templates, badge.
- *Exit:* saves a progressive MP4 from a plain site; e2e test green.

**Phase 2: Download engine**
- Offscreen document, OPFS storage, HLS and DASH downloaders, AES-128,
  fMP4 and TS remux, ffmpeg.wasm fallback, queue + side panel, DRM refusal.
- *Exit:* all local test pages (HLS/DASH variants) produce a playable single
  MP4; the EME page is refused cleanly.

**Phase 3: Facebook and Instagram adapters**
- Response tap, Relay/`data-sjs` page parsing, key table, candidate grouping
  (one entry per video with quality choices), carousel support, metadata
  sidecar, SPA navigation handling, expiry refresh.
- *Exit:* the Phase 0 fixtures pass as unit tests; manual smoke checklist
  passes on live FB/IG at best available quality with audio.

**Phase 4: Universal fallbacks**
- MSE capture with OPFS-backed buffering and explicit init-segment tracking.
  Tab recording through `tabCapture` + offscreen `MediaRecorder`.
- *Exit:* a site with an opaque MSE player (no sniffable manifest) can be saved
  by playing it through; any non-DRM page can be recorded.

**Phase 5: Hardening and release**
- Options page, i18n, error reporting shown to the user (no telemetry),
  permission onboarding, YouTube block in the store build, Firefox build,
  privacy policy, store listing and screenshots.
- *Exit:* Chrome Web Store submission; tagged GitHub release with an unpacked
  build.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Meta changes JSON shapes or player behavior | Key table as data; fixtures from Phase 0 to spot drift; generic tiers as automatic fallback; watch yt-dlp's FB/IG extractor commits as an early warning. |
| Chrome Web Store rejection (downloader category, broad permissions) | Optional `<all_urls>`, YouTube blocked, clear DRM refusal, no remote code, privacy policy. Self-distribution as fallback. |
| Large files exhaust memory | OPFS streaming; ffmpeg.wasm only below a size threshold, otherwise in-JS remux or separate tracks. |
| MV3 service worker shutdown mid-download | Work in the offscreen document; persisted queue; resumable segment index. |
| Hooks break a site or get detected | Proxy-based, toString-preserving hooks; per-site kill switch in options; MSE hook can be turned off. |
| Legal and terms exposure | Personal-use framing in the listing and UI; no DRM; no bulk tools; no YouTube in the store build. Users are responsible for the rights to what they save. |

---

## 8. Open decisions

1. **Distribution**: Chrome Web Store, or self-hosted/unpacked only? This
   decides the YouTube block and how tightly to scope permissions.
2. **Browsers**: Chrome only, or Firefox/Edge as well? WXT makes Firefox cheap,
   but Firefox has no `offscreen` API (it uses background pages instead).
3. **License**: MIT (can reuse HLS Downloader code) or GPL-3.0 (can reuse
   cat-catch code).
4. **Metadata scope**: a sidecar JSON only, or also embed title/author/date
   into the MP4 (`udta`/`©nam` atoms) and save thumbnails and captions?
5. **Stories and logged-out viewing**: in scope for v1, or later?
