/**
 * Recent-activity / audit-trail card shown in Settings.
 *
 * Reads from `audit:listRecent` (the new IPC channel introduced in
 * Phase 11 Task 6) and renders the latest 100 events newest-first
 * with an event-type filter. The "KChat" filter shortcut
 * concentrates the renderer view on the new
 * `Kchat*` event-type variants (KchatConnected,
 * KchatDisconnected, KchatArtifactShared, KchatChannelLinked,
 * KchatChannelUnlinked, KchatFileDownloaded).
 *
 * Per spec Task 6: "Show: who shared what, when, to which
 * channel." — the details column carries the channel/file/etc
 * information directly because the audit store keeps everything in
 * a single text payload (no separate columns). That matches the
 * audit-log invariant: the audit row is a record of *what was
 * said* at the time, not a join into mutable tables.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import type { AuditEventView } from "../../../shared/types";

// Filter category → event-type-name prefix used to match against
// the audit row's `eventType`. The Rust `AuditEventType` enum uses
// `#[serde(rename_all = "snake_case")]`, so the napi bridge surfaces
// strings like `"kchat_connected"`, `"source_added"`,
// `"connector_synced"`, `"artifact_created"`, `"model_started"`,
// etc. We substring-match on the snake_case prefix (with a trailing
// underscore so e.g. `"kchat_"` does not accidentally match a
// future `"kchat"` standalone variant). Pill labels intentionally
// end in "events" so they don't collide with Settings section
// headings like "Sources" or "Model Runtime" (a
// `getByText("Sources")` in another test must remain unambiguous).
const CATEGORIES: ReadonlyArray<{
  key: string;
  label: string;
  prefix: string | null;
}> = [
  { key: "All", label: "All events", prefix: null },
  { key: "KChat", label: "KChat events", prefix: "kchat_" },
  { key: "Sources", label: "Source events", prefix: "source_" },
  { key: "Connectors", label: "Connector events", prefix: "connector_" },
  { key: "Artifacts", label: "Artifact events", prefix: "artifact_" },
  { key: "Models", label: "Model events", prefix: "model_" },
];
type Category = (typeof CATEGORIES)[number]["key"];

// Convert a snake_case `AuditEventType` (e.g. `"kchat_connected"`)
// into a human-readable label (e.g. `"KChat Connected"`). The Rust
// enum is the source of truth for the wire format; this is a
// pure-presentation transform applied at render time.
function formatEventType(raw: string): string {
  return raw
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part === "kchat") return "KChat";
      if (part === "slm") return "SLM";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

interface AuditActivityCardProps {
  /** Override `window.tessera.audit` (used by tests). */
  api?: typeof window.tessera.audit;
}

export default function AuditActivityCard({ api }: AuditActivityCardProps = {}) {
  const audit = api ?? window.tessera?.audit;
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryKey, setCategoryKey] = useState<Category>("All");

  const refresh = useCallback(async () => {
    if (!audit) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const rows = await audit.listRecent(100, 0);
      setEvents(rows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [audit]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const cat = CATEGORIES.find((c) => c.key === categoryKey);
    if (!cat?.prefix) return events;
    return events.filter((ev) => ev.eventType.startsWith(cat.prefix as string));
  }, [events, categoryKey]);

  if (!audit) return null;

  return (
    <Card data-testid="audit-activity-card">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "var(--spacing-md)",
        }}
      >
        <h3 style={{ margin: 0 }}>Recent activity</h3>
        <Button variant="secondary" onClick={refresh} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        Every connect, share, model start, and source change is appended to
        the local audit log. Filter by category to focus on a subset (KChat
        sharing, connector sync, model lifecycle, …).
      </p>

      <div
        role="tablist"
        aria-label="Audit category filter"
        style={{
          display: "flex",
          gap: "var(--spacing-xs)",
          flexWrap: "wrap",
          marginBottom: "var(--spacing-md)",
        }}
      >
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            type="button"
            role="tab"
            aria-selected={categoryKey === c.key}
            onClick={() => setCategoryKey(c.key)}
            data-testid={`audit-filter-${c.key.toLowerCase()}`}
            style={{
              background:
                categoryKey === c.key
                  ? "var(--color-primary)"
                  : "var(--color-bg-elevated)",
              color:
                categoryKey === c.key
                  ? "var(--color-text-on-primary)"
                  : "var(--color-text-headline)",
              border: "1px solid var(--color-border)",
              borderRadius: "999px",
              padding: "4px 12px",
              fontSize: "var(--font-size-sm)",
              cursor: "pointer",
            }}
          >
            {c.label}
          </button>
        ))}
      </div>

      {error && (
        <p
          role="alert"
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-error, #c00)",
          }}
          data-testid="audit-error"
        >
          Failed to load audit log: {error}
        </p>
      )}

      {!loading && filtered.length === 0 && (
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
          }}
          data-testid="audit-empty"
        >
          No events in this category yet.
        </p>
      )}

      {filtered.length > 0 && (
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: "none",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-sm)",
            maxHeight: "320px",
            overflow: "auto",
          }}
          data-testid="audit-event-list"
        >
          {filtered.map((ev) => (
            <li
              key={ev.id}
              style={{
                padding: "var(--spacing-sm) var(--spacing-md)",
                borderBottom: "1px solid var(--color-border)",
                fontSize: "var(--font-size-sm)",
              }}
              data-testid="audit-event-row"
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: "2px",
                }}
              >
                <span
                  style={{
                    fontWeight: "var(--font-weight-medium)" as unknown as number,
                    color: "var(--color-text-headline)",
                  }}
                >
                  {formatEventType(ev.eventType)}
                </span>
                <time
                  dateTime={ev.timestamp}
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {formatRelative(ev.timestamp)}
                </time>
              </div>
              <div style={{ color: "var(--color-text-secondary)" }}>
                {ev.details}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** "5 minutes ago" / "yesterday" / ISO date for older rows. */
function formatRelative(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  if (diffMs < 60_000) return "just now";
  if (diffMs < 3_600_000) {
    const m = Math.floor(diffMs / 60_000);
    return `${m} minute${m === 1 ? "" : "s"} ago`;
  }
  if (diffMs < 86_400_000) {
    const h = Math.floor(diffMs / 3_600_000);
    return `${h} hour${h === 1 ? "" : "s"} ago`;
  }
  if (diffMs < 7 * 86_400_000) {
    const d = Math.floor(diffMs / 86_400_000);
    return d === 1 ? "yesterday" : `${d} days ago`;
  }
  return iso.slice(0, 10);
}
