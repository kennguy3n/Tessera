/**
 * Human-readable size suffix for a model download estimate, e.g.
 * " (~450 MB)" or " (~1.2 GB)". Returns "" for an unknown / nonsensical
 * size so the UI copy gracefully degrades to no estimate.
 *
 * Lives in its own module (rather than alongside `ModelDownloadBanner`)
 * so the banner file only exports a component — keeping React Fast
 * Refresh happy — while remaining independently unit-testable.
 */
export function formatModelSize(mb: number | null): string {
  if (mb === null || !Number.isFinite(mb) || mb <= 0) return "";
  if (mb >= 1024) return ` (~${(mb / 1024).toFixed(1)} GB)`;
  return ` (~${Math.round(mb)} MB)`;
}
