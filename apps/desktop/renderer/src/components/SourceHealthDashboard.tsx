/**
 * Phase 15 Task 22 — Source Health dashboard for the Settings page.
 *
 * Renders a single Card containing one row per indexed source, with
 * (a) a traffic-light health badge (healthy / warning / error),
 * (b) the last sync timestamp formatted relatively,
 * (c) the indexed-chunk count, and
 * (d) an on-disk storage estimate (sum of every indexed file's size
 *     in bytes, formatted to KB/MB/GB).
 *
 * Data comes from `sources:healthReport`, a single-round-trip IPC
 * handler that aggregates the per-source stats from the bridge. We
 * deliberately keep this dashboard a *snapshot*-style view (refresh
 * on mount + an explicit "Refresh" button) rather than wiring it to
 * the indexing-progress poll loop: per-source storage stats require
 * `fs.stat` walks that we don't want to fire every 500ms.
 *
 * Health classification (computed in the IPC layer; see
 * `ipc/sources.ts:healthReport`):
 *   - error   → backing status is "error" / "access_revoked"
 *   - warning → status is "indexing", any indexed file failed to
 *               stat (file moved since last index), or no
 *               lastIndexed timestamp persisted yet
 *   - healthy → status is "indexed" / "connected" AND every
 *               indexed file is still readable
 */
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  FolderOpen,
} from "lucide-react";
import Card from "./Card";
import Button from "./Button";
import type {
  SourceHealthReport,
  SourceHealthEntry,
} from "../../../shared/types";

interface SourceHealthDashboardProps {
  /** Override `window.tessera.sources` (used by tests). */
  api?: typeof window.tessera.sources;
}

/**
 * Format bytes as a human-readable size string (KB/MB/GB). Uses
 * 1024-base for parity with `ls -lh` on Linux / Finder on macOS.
 * Values are rounded to one decimal place; the smallest readable
 * unit (B) is used for very small sources.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Render integers cleanly: `1 B` not `1.0 B`.
  if (unit === 0) return `${value} ${units[unit]}`;
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Format an ISO-8601 timestamp as a relative-time string. We render
 * relative because absolute timestamps drift across timezones and
 * the user only cares about "was this recent?". Falls back to the
 * literal string if parsing fails.
 */
function formatRelativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const deltaMs = Date.now() - ts;
  const deltaSec = Math.round(deltaMs / 1000);
  if (deltaSec < 60) return "just now";
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.round(deltaHr / 24);
  if (deltaDay < 30) return `${deltaDay}d ago`;
  // For older timestamps, fall back to a date (no time-of-day).
  return new Date(ts).toLocaleDateString();
}

/**
 * Health badge — colour + icon + label. Inline styles instead of a
 * stylesheet so the component is drop-in usable from any Settings
 * card variant without theme leakage.
 */
function HealthBadge({ health }: { health: SourceHealthEntry["health"] }) {
  const cfg: Record<
    SourceHealthEntry["health"],
    { color: string; bg: string; label: string; Icon: typeof CheckCircle2 }
  > = {
    healthy: {
      color: "#15803d",
      bg: "#dcfce7",
      label: "Healthy",
      Icon: CheckCircle2,
    },
    warning: {
      color: "#b45309",
      bg: "#fef3c7",
      label: "Warning",
      Icon: AlertTriangle,
    },
    error: {
      color: "#b91c1c",
      bg: "#fee2e2",
      label: "Error",
      Icon: XCircle,
    },
  };
  const { color, bg, label, Icon } = cfg[health];
  return (
    <span
      data-testid={`source-health-badge-${health}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0.125rem 0.5rem",
        borderRadius: "9999px",
        backgroundColor: bg,
        color,
        fontSize: "var(--font-size-xs)",
        fontWeight: 500,
      }}
      role="status"
      aria-label={`Source health: ${label}`}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

export default function SourceHealthDashboard({
  api,
}: SourceHealthDashboardProps = {}) {
  const sources = api ?? window.tessera?.sources;
  const [report, setReport] = useState<SourceHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!sources) {
      setReport(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const r = await sources.healthReport();
      setReport(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sources]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Card data-testid="source-health-dashboard">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "var(--spacing-md)",
        }}
      >
        <h3 style={{ margin: 0 }}>Source Health</h3>
        <Button onClick={refresh} variant="secondary" disabled={loading}>
          <RefreshCw
            size={14}
            aria-hidden="true"
            style={{ marginRight: "0.25rem" }}
          />
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            color: "#b91c1c",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-sm)",
          }}
        >
          Failed to load source health: {error}
        </div>
      )}

      {!loading && report && report.sources.length === 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            color: "var(--color-text-secondary, #6b7280)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <FolderOpen size={16} aria-hidden="true" />
          No sources connected yet.
        </div>
      )}

      {report && report.sources.length > 0 && (
        <div
          role="table"
          aria-label="Source health summary"
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          <div
            role="row"
            style={{
              display: "grid",
              gridTemplateColumns:
                "minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.8fr)",
              gap: "0.5rem",
              fontSize: "var(--font-size-xs)",
              fontWeight: 600,
              color: "var(--color-text-secondary, #6b7280)",
              borderBottom: "1px solid var(--color-border, #e2e8f0)",
              paddingBottom: "0.25rem",
            }}
          >
            <span role="columnheader">Source</span>
            <span role="columnheader">Last sync</span>
            <span role="columnheader">Health</span>
            <span role="columnheader">Chunks</span>
            <span role="columnheader">Storage</span>
          </div>
          {report.sources.map((src) => (
            <div
              key={src.sourceId}
              role="row"
              data-testid={`source-health-row-${src.sourceId}`}
              style={{
                display: "grid",
                gridTemplateColumns:
                  "minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 0.8fr) minmax(0, 0.8fr)",
                gap: "0.5rem",
                alignItems: "center",
                fontSize: "var(--font-size-sm)",
              }}
            >
              <span
                role="cell"
                title={src.path}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {src.path}
              </span>
              <span role="cell">{formatRelativeTime(src.lastIndexed)}</span>
              <span role="cell">
                <HealthBadge health={src.health} />
              </span>
              <span role="cell">{src.chunkCount.toLocaleString()}</span>
              <span role="cell">{formatBytes(src.storageBytes)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
