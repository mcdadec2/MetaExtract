#!/usr/bin/env bash
# Regenerates the HLS/DASH fixtures in tests/e2e/site/streams with ffmpeg.
# The output is committed so tests don't depend on the local ffmpeg version.
set -euo pipefail
cd "$(dirname "$0")/site/streams"
rm -rf hls-ts hls-fmp4 hls-aes dash-template dash-single
mkdir -p hls-ts hls-fmp4 hls-aes dash-template dash-single

# 4 s of test pattern + tone, small enough to commit.
src=(-f lavfi -i "testsrc2=duration=4:size=320x180:rate=25" -f lavfi -i "sine=frequency=440:duration=4")
x264=(-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 25 -keyint_min 25 -sc_threshold 0)
aac=(-c:a aac -b:a 48k -ac 2)

# HLS, MPEG-TS segments, two muxed variants under a master playlist.
ffmpeg -loglevel error -y "${src[@]}" \
  -filter_complex "[0:v]split=2[a][b];[b]scale=192:108[b2]" \
  -map "[a]" -map 1:a -map "[b2]" -map 1:a \
  "${x264[@]}" -b:v:0 300k -b:v:1 120k "${aac[@]}" \
  -f hls -hls_time 1 -hls_playlist_type vod -master_pl_name master.m3u8 \
  -var_stream_map "v:0,a:0,name:180p v:1,a:1,name:108p" \
  -hls_segment_filename "hls-ts/%v-%d.ts" hls-ts/%v.m3u8

# HLS, fMP4 segments, video and audio as separate renditions.
ffmpeg -loglevel error -y "${src[@]}" -map 0:v -map 1:a \
  "${x264[@]}" -b:v 300k "${aac[@]}" \
  -f hls -hls_time 1 -hls_playlist_type vod -hls_segment_type fmp4 \
  -master_pl_name master.m3u8 -var_stream_map "v:0,agroup:aud,name:video a:0,agroup:aud,name:audio,default:yes" \
  -hls_fmp4_init_filename "%v-init.mp4" -hls_segment_filename "hls-fmp4/%v-%d.m4s" hls-fmp4/%v.m3u8

# HLS, TS segments encrypted with AES-128 (key served next to the playlist).
printf '0123456789abcdef' > hls-aes/key.bin
printf 'key.bin\nhls-aes/key.bin\n00112233445566778899aabbccddeeff\n' > hls-aes/keyinfo
ffmpeg -loglevel error -y "${src[@]}" "${x264[@]}" -b:v 300k "${aac[@]}" \
  -f hls -hls_time 1 -hls_playlist_type vod -hls_key_info_file hls-aes/keyinfo \
  -hls_segment_filename "hls-aes/%d.ts" hls-aes/index.m3u8
rm hls-aes/keyinfo

# DASH, SegmentTemplate with numbered segments.
ffmpeg -loglevel error -y "${src[@]}" -map 0:v -map 1:a "${x264[@]}" -b:v 300k "${aac[@]}" \
  -f dash -seg_duration 1 -use_template 1 -use_timeline 0 \
  -init_seg_name 'init-$RepresentationID$.m4s' -media_seg_name 'chunk-$RepresentationID$-$Number$.m4s' \
  dash-template/manifest.mpd

# DASH, one file per representation with SegmentBase (what Facebook and Instagram use).
ffmpeg -loglevel error -y "${src[@]}" -map 0:v -map 1:a "${x264[@]}" -b:v 300k "${aac[@]}" \
  -f dash -seg_duration 1 -single_file 1 -single_file_name 'stream-$RepresentationID$.mp4' \
  dash-single/manifest.mpd

# Variants that must be refused: DRM (DASH and HLS) and a live HLS playlist.
sed 's#<AdaptationSet \(.*contentType="video".*\)>#<AdaptationSet \1>\n\t\t\t<ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" />#' \
  dash-template/manifest.mpd > dash-template/drm.mpd
sed 's#^\#EXT-X-KEY:METHOD=AES-128#\#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery"#' \
  hls-aes/index.m3u8 > hls-aes/fairplay.m3u8
grep -v -e '#EXT-X-ENDLIST' -e '#EXT-X-PLAYLIST-TYPE' hls-ts/180p.m3u8 > hls-ts/live.m3u8

# Facebook/Instagram style: SegmentBase over the same single files, so the
# whole file is the representation (no per-segment URLs or ranges).
sed -e '/<SegmentList/,/<\/SegmentList>/d' \
  -e 's#\(<BaseURL>stream-0.mp4</BaseURL>\)#\1\n\t\t\t\t<SegmentBase indexRange="834-885"><Initialization range="0-833" /></SegmentBase>#' \
  -e 's#\(<BaseURL>stream-1.mp4</BaseURL>\)#\1\n\t\t\t\t<SegmentBase indexRange="765-816"><Initialization range="0-764" /></SegmentBase>#' \
  dash-single/manifest.mpd > dash-single/segmentbase.mpd
