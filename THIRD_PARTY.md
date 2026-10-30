# Third-party code

MetaExtract is GPL-3.0. These libraries are bundled into the built
extension; their licenses are compatible with the GPL-3.0. The full license
texts ship with each package in `node_modules/` and will be included in
release zips.

| Package | Used for | License |
|---|---|---|
| [preact](https://github.com/preactjs/preact) | Popup, options and side panel UI | MIT |
| [m3u8-parser](https://github.com/videojs/m3u8-parser) | Parsing HLS playlists | Apache-2.0 |
| [mpd-parser](https://github.com/videojs/mpd-parser) | Parsing DASH manifests | Apache-2.0 |
| [mux.js](https://github.com/videojs/mux.js) | Converting MPEG-TS segments to MP4 | Apache-2.0 |
| [@videojs/vhs-utils](https://github.com/videojs/vhs-utils) | Dependency of the parsers | MIT |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | XML parsing for mpd-parser | MIT |
| [global](https://github.com/Raynos/global) | Dependency of the video.js libraries | MIT |
| [@babel/runtime](https://github.com/babel/babel) | Dependency of the video.js libraries | MIT |

The video.js packages and `@videojs/vhs-utils` are pinned to releases from
before 2026-10-29: all of them published new versions within an hour of each
other that day, and we wait before taking releases like that.
