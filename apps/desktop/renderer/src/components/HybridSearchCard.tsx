/**
 * Settings card that lets the user tune the hybrid retrieval pipeline:
 *   - "Hybrid mode" toggle. When off, `vectorWeight` is set to 0 so
 *     ranking falls back to pure BM25 lexical scoring.
 *   - "Recency half-life" slider (1–365 days). Controls how aggressively
 *     the temporal decay penalises older sources.
 *   - "Apply temporal decay" toggle. When off, decay is disabled
 *     entirely (Rust's `f64::INFINITY` sentinel; surfaced here as a
 *     boolean because JSON can't carry Infinity round-trip).
 *
 * The card reads `settings:getHybridSearchConfig` on mount and writes
 * via `settings:updateHybridSearchConfig`. The bridge round-trips the
 * effective config (post-validation), so the controls always reflect
 * what the live search engine is using — not a stale local copy.
 */
import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import type { HybridSearchConfigInfo } from "../types/ipc";

const SECONDS_PER_DAY = 24 * 60 * 60;
const MIN_HALFLIFE_DAYS = 1;
const MAX_HALFLIFE_DAYS = 365;

// Pre-bridge defaults — only used until the first successful read
// returns. Kept in sync with `DEFAULT_HYBRID_SEARCH_CONFIG` in
// `electron/config.ts` and `HybridSearchConfig::default()` in
// `crates/tessera_sources/src/hybrid.rs`.
const PRELOAD_DEFAULTS: HybridSearchConfigInfo = {
  bm25Weight: 1.0,
  vectorWeight: 1.0,
  rrfK: 60.0,
  recencyDecayEnabled: true,
  recencyHalflifeSecs: 30 * SECONDS_PER_DAY,
  candidatePoolSize: 0,
  retentionWeight: 1.0,
};

export default function HybridSearchCard() {
  const [config, setConfig] = useState<HybridSearchConfigInfo | null>(null);
  const [draftHalflifeDays, setDraftHalflifeDays] = useState<number>(30);
  const [hybridEnabled, setHybridEnabled] = useState<boolean>(true);
  const [decayEnabled, setDecayEnabled] = useState<boolean>(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const seed = useCallback((info: HybridSearchConfigInfo) => {
    setConfig(info);
    setHybridEnabled(info.vectorWeight > 0);
    setDecayEnabled(info.recencyDecayEnabled);
    // When decay is disabled the bridge returns null halflife; in
    // that case fall back to either the previously-shown draft or
    // the documented 30-day default so the slider has a value to
    // render while it's grayed out.
    const halflifeSecs =
      info.recencyHalflifeSecs ?? PRELOAD_DEFAULTS.recencyHalflifeSecs!;
    setDraftHalflifeDays(
      Math.round(Math.max(halflifeSecs / SECONDS_PER_DAY, MIN_HALFLIFE_DAYS)),
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await window.tessera.settings.getHybridSearchConfig();
        if (!cancelled) {
          seed(info);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          // Seed with the documented defaults so the UI is still
          // interactive while the bridge is unreachable. Saving
          // will surface the real bridge error.
          seed(PRELOAD_DEFAULTS);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [seed]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const info = await window.tessera.settings.updateHybridSearchConfig({
        // When the user disables hybrid mode we set vectorWeight to 0
        // (per spec). Re-enabling restores `bm25Weight` parity so the
        // weights are balanced; the user can tune them later through
        // a power-user UI we haven't built yet.
        vectorWeight: hybridEnabled ? (config?.bm25Weight ?? 1.0) : 0,
        recencyDecayEnabled: decayEnabled,
        recencyHalflifeSecs: decayEnabled
          ? draftHalflifeDays * SECONDS_PER_DAY
          : undefined,
      });
      seed(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!config) {
    return (
      <Card>
        <h2
          className="section-title"
          style={{ marginBottom: "var(--spacing-md)" }}
        >
          Search
        </h2>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Loading search config…
        </p>
      </Card>
    );
  }

  const halflifeId = "hybrid-halflife-slider";
  const hybridToggleId = "hybrid-mode-toggle";
  const decayToggleId = "hybrid-decay-toggle";

  return (
    <Card>
      <h2
        className="section-title"
        style={{ marginBottom: "var(--spacing-md)" }}
      >
        Search
      </h2>
      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        Controls how Tessera ranks search hits. Hybrid mode blends lexical
        (BM25) and semantic (vector) scoring; recency decay biases
        recently-modified sources higher when content similarity is equal.
      </p>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        <input
          id={hybridToggleId}
          type="checkbox"
          checked={hybridEnabled}
          onChange={(e) => setHybridEnabled(e.target.checked)}
          data-testid="hybrid-mode-toggle"
        />
        <label htmlFor={hybridToggleId}>
          <span style={{ fontWeight: 600 }}>Hybrid mode</span>{" "}
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-secondary)",
            }}
          >
            (off → BM25 only)
          </span>
        </label>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        <input
          id={decayToggleId}
          type="checkbox"
          checked={decayEnabled}
          onChange={(e) => setDecayEnabled(e.target.checked)}
          data-testid="hybrid-decay-toggle"
        />
        <label htmlFor={decayToggleId}>
          <span style={{ fontWeight: 600 }}>Apply temporal decay</span>{" "}
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-secondary)",
            }}
          >
            (boost recent sources)
          </span>
        </label>
      </div>

      <div style={{ marginBottom: "var(--spacing-md)" }}>
        <label
          htmlFor={halflifeId}
          style={{
            display: "block",
            fontSize: "var(--font-size-sm)",
            fontWeight: 600,
            marginBottom: "var(--spacing-xs)",
            color: "var(--color-text-headline)",
            opacity: decayEnabled ? 1 : 0.5,
          }}
        >
          Recency half-life
        </label>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-sm)",
          }}
        >
          <input
            id={halflifeId}
            type="range"
            min={MIN_HALFLIFE_DAYS}
            max={MAX_HALFLIFE_DAYS}
            step={1}
            value={draftHalflifeDays}
            onChange={(e) =>
              setDraftHalflifeDays(Number.parseInt(e.target.value, 10))
            }
            disabled={!decayEnabled}
            data-testid="hybrid-halflife-slider"
            aria-label="Recency half-life in days"
            aria-valuemin={MIN_HALFLIFE_DAYS}
            aria-valuemax={MAX_HALFLIFE_DAYS}
            aria-valuenow={draftHalflifeDays}
            style={{ flex: 1 }}
          />
          <span
            style={{
              minWidth: "5ch",
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              color: "var(--color-text-secondary)",
              opacity: decayEnabled ? 1 : 0.5,
            }}
            aria-live="polite"
          >
            {draftHalflifeDays} day{draftHalflifeDays === 1 ? "" : "s"}
          </span>
        </div>
        <p
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-secondary)",
            marginTop: "var(--spacing-xs)",
            opacity: decayEnabled ? 1 : 0.5,
          }}
        >
          Sources older than the half-life contribute half as much to ranking as
          a fresh source with the same content.
        </p>
      </div>

      {error && (
        <p
          role="alert"
          style={{ color: "var(--color-error)" }}
          data-testid="hybrid-error"
        >
          {error}
        </p>
      )}

      <Button onClick={handleSave} disabled={saving} data-testid="hybrid-save">
        {saving ? "Saving…" : "Save"}
      </Button>
    </Card>
  );
}
