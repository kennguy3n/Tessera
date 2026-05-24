type BadgeVariant = "success" | "warning" | "error" | "info";

interface StatusBadgeProps {
  status: string;
  variant?: BadgeVariant;
}

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  connected: "success",
  // `indexed` is the post-`Indexing` happy path — a source that has
  // been fully ingested. Treated as the most "ready" status (more
  // settled than `connected`, which only means the credentials work).
  // Phase 10 / Task 27: HomePage's source-status-breakdown card
  // surfaces this count, so the badge needs to render with the same
  // success variant as `connected` instead of falling through to the
  // default `info`.
  indexed: "success",
  syncing: "warning",
  indexing: "warning",
  error: "error",
  disconnected: "error",
  idle: "info",
  not_configured: "info",
};

export default function StatusBadge({ status, variant }: StatusBadgeProps) {
  const resolvedVariant = variant ?? STATUS_VARIANTS[status] ?? "info";
  return <span className={`badge badge-${resolvedVariant}`}>{status}</span>;
}
