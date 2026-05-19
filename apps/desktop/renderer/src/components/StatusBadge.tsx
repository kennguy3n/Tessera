type BadgeVariant = "success" | "warning" | "error" | "info";

interface StatusBadgeProps {
  status: string;
  variant?: BadgeVariant;
}

const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  connected: "success",
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
