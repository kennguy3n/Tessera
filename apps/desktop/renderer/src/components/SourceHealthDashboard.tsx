/**
 * Source Health dashboard for the Settings page.
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
  const [report, setReport] = useState<SourceHealthReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    // Devin Review PR #70 follow-up (BUG): resolve the
    // bridge reference INSIDE the refresh callback rather than at
    // component-render time. Previously the resolution lived above
    // (`const sources = api ?? window.tessera?.sources`) and was
    // captured by this `useCallback`'s closure via `[sources]`. If
    // `window.tessera` was undefined on initial mount (transient
    // renderer<->preload initialisation window, or a test that
    // hadn't yet stubbed the bridge), `sources` was undefined, the
    // first `refresh()` hit the error banner, and the bridge later
    // becoming defined did NOT cause a re-render of this component
    // — so the `refresh` closure stayed stuck on `sources=undefined`
    // forever. Clicking the Refresh button just called the same
    // stale closure and re-surfaced "Bridge not available" against
    // a bridge that was actually live by then.
    //
    // Re-reading `window.tessera?.sources` on each invocation makes
    // the Refresh button structurally self-healing: the next click
    // after the bridge becomes available picks it up and loads
    // normally. `api` (the test-override prop) is still captured by
    // the closure because it's a prop that triggers a re-render
    // when it changes, so test overrides work as before. The
    // dependency array therefore only needs `[api]` — `window`
    // identity never changes for the lifetime of the renderer.
    const sources = api ?? window.tessera?.sources;
    if (!sources) {
      // Devin Review PR #70 follow-up: the bridge can
      // legitimately be unavailable (transient renderer<->main
      // initialisation window, or `SettingsPage` mounted from a test
      // that didn't override `api`). Previously the early-return left
      // `report=null, loading=false, error=null`, so the card body
      // rendered completely empty — header + Refresh button with no
      // status text, no error message, and no empty-state placeholder.
      // The user would see a blank Source Health card and have no
      // idea whether it was loading, broken, or simply had no data.
      //
      // Route the unavailable-bridge case through the existing error
      // banner so the user gets a clear "Bridge not available …"
      // explanation, the table is replaced by the banner, and the
      // Refresh button stays clickable so the user can retry once the
      // bridge initialises. We deliberately do NOT throw or set
      // `loading=true` — that would either crash the React tree or
      // keep the button disabled forever during a slow bridge boot.
      setReport(null);
      setError(
        "Bridge not available — Source Health cannot load until the renderer reconnects to the main process.",
      );
      setLoading(false);
      return;
    }
    // Devin Review PR #70: clear the previous error
    // at the START of a refresh attempt, not just on success.
    // Otherwise the user simultaneously sees the old error banner,
    // the dimmed-stale table, AND the "Refreshing…" button text —
    // a confusing UI surface that suggests the retry has already
    // failed before the IPC has even resolved. Clearing the error
    // up-front gives the user clean visual feedback ("we're trying
    // again") and on failure the banner re-appears with the new
    // error message. The brief banner flicker on a fast-failing
    // retry is preferable to the static "stuck on the old error"
    // appearance during a slow successful retry.
    //
    // The stale-table semantics (the regression-test fix from
    // round one) are unchanged: `isStale` is still
    // derived from `error !== null && report !== null`, so the
    // dimmed-and-aria-described table only appears after a refresh
    // has actually failed — not during the in-flight retry.
    setLoading(true);
    setError(null);
    try {
      const r = await sources.healthReport();
      setReport(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Devin Review PR #70: when `error` is set AND a
  // prior `report` exists, the dashboard previously rendered both
  // the error banner AND the table side-by-side with no indication
  // that the table data was stale. The architecturally correct fix
  // is to (1) make the staleness explicit in the error banner copy
  // (referencing `report.generatedAt`), (2) show a "Last refreshed"
  // caption whenever a report is loaded so the user always knows
  // the freshness of what they're looking at, (3) dim the table
  // visually + wire `aria-describedby` to the error banner so
  // screen readers also announce "this data is stale". The
  // graceful-degradation choice (show stale > show blank) is
  // preserved — we just no longer hide it from the user.
  const isStale = error !== null && report !== null;

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
        <h2 className="section-title" style={{ margin: 0 }}>
          Source Health
        </h2>
        <Button onClick={refresh} variant="secondary" disabled={loading}>
          <RefreshCw
            size={14}
            aria-hidden="true"
            style={{ marginRight: "0.25rem" }}
          />
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {report && (
        <div
          data-testid="source-health-last-refreshed"
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-secondary, #6b7280)",
            marginBottom: "var(--spacing-sm)",
          }}
        >
          Last refreshed: {formatRelativeTime(report.generatedAt)}
        </div>
      )}

      {error && (
        <div
          id="source-health-error"
          role="alert"
          style={{
            color: "#b91c1c",
            fontSize: "var(--font-size-sm)",
            marginBottom: "var(--spacing-sm)",
          }}
        >
          {report
            ? `Failed to refresh source health: ${error}. Showing data from ${formatRelativeTime(report.generatedAt)}.`
            : `Failed to load source health: ${error}`}
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
          aria-label={
            isStale
              ? "Source health summary (showing stale data, refresh failed)"
              : "Source health summary"
          }
          aria-describedby={isStale ? "source-health-error" : undefined}
          data-stale={isStale ? "true" : undefined}
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.5rem",
            opacity: isStale ? 0.6 : 1,
            transition: "opacity 0.15s ease",
          }}
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
