export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return 'size unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Rough file size from a stream's bitrate and duration. */
export function estimateSize(bandwidth?: number, duration?: number): number | undefined {
  return bandwidth && duration ? Math.round((bandwidth * duration) / 8) : undefined;
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (!seconds) return undefined;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
