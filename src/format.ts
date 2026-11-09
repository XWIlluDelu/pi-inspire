/** "1 file", "2,048 files". */
export function formatCount(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

/** Human-readable byte size (B / KB / MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * Session activity age on one ladder for every session list: "now"/"12m"/"3h"/
 * "5d" (compact) or the same with " ago" (relative), then a short date.
 */
function sessionAge(
  timestamp: string,
  relative: boolean,
  now = Date.now(),
): string {
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time)) return "";
  const suffix = relative ? " ago" : "";
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return relative ? "just now" : "now";
  if (minutes < 60) return `${minutes}m${suffix}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${suffix}`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d${suffix}`;
  return new Date(time).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/** Dense navigation rows; the exact timestamp stays in the row tooltip. */
export function compactAge(timestamp: string, now = Date.now()): string {
  return sessionAge(timestamp, false, now);
}

/** Session lists with room for words (palette, Welcome recents). */
export function relativeTime(timestamp: string, now = Date.now()): string {
  return sessionAge(timestamp, true, now);
}
