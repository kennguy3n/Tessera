/**
 * Presentation helpers for the backup UI (Settings → Backup card and
 * the HomePage "last backup" indicator). Pure functions, no DOM or IPC,
 * so they're unit-testable in isolation.
 */

/** Binary unit ladder for {@link formatBytes}. */
const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/**
 * Format a byte count as a short human string (e.g. `1.4 MB`). Uses
 * binary (1024) steps to match what OS file managers report for a
 * SQLite file. Negative / non-finite inputs collapse to `0 B` rather
 * than rendering `NaN`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const exponent = Math.min(
    BYTE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / Math.pow(1024, exponent);
  // No decimals for whole bytes; one decimal for larger units so
  // "1.4 MB" reads cleanly without "1.40 MB" noise.
  const formatted =
    exponent === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${formatted} ${BYTE_UNITS[exponent]}`;
}

/**
 * Format an epoch-ms timestamp as a coarse relative string ("just
 * now", "2h ago", "3d ago"). Coarse on purpose — the backup indicator
 * only needs to convey freshness, not a precise duration. A future
 * timestamp (clock skew) collapses to "just now" rather than rendering
 * a negative interval. `now` is injectable for deterministic tests.
 */
export function formatRelativeTime(
  epochMs: number,
  now: number = Date.now(),
): string {
  const deltaMs = now - epochMs;
  if (!Number.isFinite(deltaMs) || deltaMs < 30_000) return "just now";
  const seconds = Math.floor(deltaMs / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
