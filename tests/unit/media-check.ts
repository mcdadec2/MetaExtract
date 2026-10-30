import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;

export interface ProbeResult {
  streams: { codec_type: string; codec_name: string; width?: number; height?: number }[];
  duration: number;
  /** Decoder errors from a full decode; empty when the file plays cleanly. */
  decodeErrors: string;
}

/** Probes and fully decodes an MP4 file (path or bytes) with ffprobe/ffmpeg. */
export function probe(file: string | Uint8Array): ProbeResult {
  let path = file as string;
  if (typeof file !== 'string') {
    path = join(mkdtempSync(join(tmpdir(), 'metaextract-probe-')), 'out.mp4');
    writeFileSync(path, file);
  }
  const info = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], {
    encoding: 'utf8',
  });
  if (info.status !== 0) throw new Error(`ffprobe failed: ${info.stderr}`);
  const json = JSON.parse(info.stdout);
  const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { encoding: 'utf8' });
  return { streams: json.streams, duration: Number(json.format.duration), decodeErrors: decode.stderr.trim() };
}
