import Card from "./Card";
import { useResourceUsage } from "../hooks/useResourceUsage";
import { RESOURCE_MODE_LABELS } from "../constants/resourceMode";
import type {
  ResourceUsage,
  ResourceUsageSlm,
} from "../types/ipc";

/**
 * LW-12: the Settings → Performance "Resource usage" dashboard.
 *
 * A live, read-only window into what the app is actually spending right
 * now — main-process + substrate RSS, which local models are resident,
 * the SQLCipher connection count, the indexing RSS watchdog, and the
 * power state that drives battery gating. The transparency principle of
 * the lightweight work: the app feels lightweight because the user can
 * *see* it is.
 *
 * All values come from one polled `resources:getUsage` snapshot (see
 * `electron/ipc/resources.ts`); the card owns no business logic, only
 * presentation. The resource-mode *toggle* lives in the Performance
 * card directly above — this card shows the active mode read-only so
 * there is a single writable control for the setting.
 */

/** Bytes → human string, e.g. `248 MB`, `1.2 GB`. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "<1 MB";
  // Compare the *rounded* MB against the boundary so a value like
  // 1023.5 MB (which rounds to 1024) crosses to the GB branch and
  // renders "1.0 GB" rather than the nonsensical "1024 MB".
  if (Math.round(mb) < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * `${n} ${noun}` with a naive +"s" plural. The read pool is sized
 * `min(parallelism, MAX_READ_POOL_SIZE)` so it is 1 on a single-core box
 * (or when `availableParallelism()` falls back) — hard-coding "readers"
 * would render the ungrammatical "1 readers". Only used for the simple
 * "writer"/"reader" nouns here, so the dumb pluraliser is sufficient.
 */
function countLabel(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

const labelStyle: React.CSSProperties = {
  fontSize: "var(--font-size-sm)",
  color: "var(--color-text-secondary)",
};

const valueStyle: React.CSSProperties = {
  fontSize: "var(--font-size-sm)",
  fontWeight: "var(--font-weight-medium)" as unknown as number,
  color: "var(--color-text-headline)",
  textAlign: "right",
};

function Row({
  label,
  value,
  testId,
}: {
  label: string;
  value: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        gap: "var(--spacing-md)",
        padding: "var(--spacing-xs) 0",
        borderBottom: "1px solid var(--color-border-light)",
      }}
    >
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle} data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

function sidecarLabel(s: ResourceUsageSlm["text"]): string {
  return s.running ? "Loaded" : "Not loaded";
}

const IMAGEGEN_STATE_LABELS: Record<
  ResourceUsageSlm["imagegen"]["state"],
  string
> = {
  unloaded: "Not loaded",
  loading: "Loading…",
  loaded: "Loaded",
  failed: "Failed",
};

function batteryValue(b: ResourceUsage["battery"]): string {
  if (!b.hasBattery) return "On AC power (no battery)";
  const pct = b.percent === null ? "unknown" : `${Math.round(b.percent)}%`;
  const source = b.isCharging
    ? "charging"
    : b.isOnBattery
      ? "on battery"
      : "on AC power";
  return `${pct} (${source})`;
}

function indexingValue(idx: ResourceUsage["indexing"]): string {
  if (idx.deferredForMemory) return "Paused (memory pressure)";
  if (!idx.pressure) return "Idle";
  return `Active — ${formatBytes(idx.pressure.rssBytes)} RSS`;
}

export default function ResourceUsageCard() {
  const usage = useResourceUsage();

  return (
    <Card>
      <h2 className="section-title" style={{ marginBottom: "var(--spacing-xs)" }}>Resource usage</h2>
      <p
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        A live view of what Tessera is using right now. Refreshes every few
        seconds while this page is open.
      </p>

      {usage === null ? (
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
          }}
          data-testid="resource-usage-loading"
        >
          Measuring…
        </p>
      ) : (
        <div data-testid="resource-usage-body">
          <Row
            label="Memory (process + substrate)"
            value={formatBytes(usage.memory.rssBytes)}
            testId="resource-usage-rss"
          />
          <Row
            label="Resource mode"
            value={RESOURCE_MODE_LABELS[usage.resourceMode]}
            testId="resource-usage-mode"
          />
          <Row
            label="Text model"
            value={sidecarLabel(usage.slm.text)}
            testId="resource-usage-slm-text"
          />
          <Row
            label="Vision model"
            value={sidecarLabel(usage.slm.vision)}
            testId="resource-usage-slm-vision"
          />
          <Row
            label="Image generation"
            value={IMAGEGEN_STATE_LABELS[usage.slm.imagegen.state]}
            testId="resource-usage-slm-imagegen"
          />
          <Row
            label="Database connections"
            value={`${countLabel(usage.connections.writers, "writer")} + ${countLabel(usage.connections.readers, "reader")}`}
            testId="resource-usage-connections"
          />
          <Row
            label="Indexing"
            value={indexingValue(usage.indexing)}
            testId="resource-usage-indexing"
          />
          <Row
            label="Battery"
            value={batteryValue(usage.battery)}
            testId="resource-usage-battery"
          />
          {usage.battery.gating && (
            <p
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-secondary)",
                marginTop: "var(--spacing-sm)",
              }}
              data-testid="resource-usage-battery-gating"
            >
              Background synthesis is paused while the battery is low.
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
