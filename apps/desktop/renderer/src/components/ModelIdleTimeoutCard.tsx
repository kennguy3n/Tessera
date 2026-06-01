/**
 * Settings card that controls how long the text + vision sidecars
 * keep an idle llama-server process resident before unloading it.
 *
 * Why this lives as its own card (rather than as another row on
 * `ModelRuntimeCard`):
 *
 *   - `ModelRuntimeCard` exposes per-text-model controls (which
 *     model is active, install/uninstall/start/stop). It already
 *     spans 600+ lines and conflating those with a runtime
 *     timing knob makes both harder to maintain.
 *   - The idle window is a SHARED setting that governs both the
 *     text and the vision sidecars in tandem (see
 *     `applyModelIdleUnloadSecsToSidecars` in `electron/appState.ts`),
 *     so it belongs to neither slot specifically.
 *   - The diffusion sidecar deliberately does NOT participate in
 *     this knob because GPU memory pressure makes a 30 s policy
 *     reasonable there; that's documented in
 *     `electron/diffusionSidecar.ts`. A future "diffusion idle
 *     window" knob would ship as its own field, not as a piggy-back
 *     on this one.
 *
 * UI model: a single number input bound directly to the persisted
 * `modelIdleUnloadSecs` setting, complemented by short "preset"
 * buttons (30 s, 1 min, 5 min, 30 min, 1 h, 6 h, 24 h) for the
 * common cases. The numeric input is clamped to the same window the
 * IPC schema enforces (`MIN_MODEL_IDLE_UNLOAD_SECS` ..
 * `MAX_MODEL_IDLE_UNLOAD_SECS`) so the user never sees an IPC
 * rejection — the renderer refuses to send out-of-bound values.
 *
 * Phase 19 Task 5.
 */
import { useCallback, useEffect, useId, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import { useSettings, useUpdateSetting } from "../hooks/useSettings";
import {
  DEFAULT_MODEL_IDLE_UNLOAD_SECS,
  MAX_MODEL_IDLE_UNLOAD_SECS,
  MIN_MODEL_IDLE_UNLOAD_SECS,
} from "../types/ipc";

/**
 * Preset buttons. The 30 s / 1 m / 5 m / 30 m / 1 h / 6 h / 24 h
 * spread covers the most useful "feel" of the knob without
 * giving the user a wall of options. Selecting a preset sets the
 * staged value but does NOT auto-save — the user still has to hit
 * the explicit Save button, matching how every other settings
 * card on this page works.
 */
const PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
  { label: "30 s", seconds: 30 },
  { label: "1 min", seconds: 60 },
  { label: "5 min", seconds: 5 * 60 },
  { label: "30 min", seconds: 30 * 60 },
  { label: "1 h", seconds: 60 * 60 },
  { label: "6 h", seconds: 6 * 60 * 60 },
  { label: "24 h", seconds: 24 * 60 * 60 },
];

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MODEL_IDLE_UNLOAD_SECS;
  return Math.max(
    MIN_MODEL_IDLE_UNLOAD_SECS,
    Math.min(MAX_MODEL_IDLE_UNLOAD_SECS, Math.round(value)),
  );
}

/**
 * Format a second count into a compact human label for the helper
 * line under the input. We deliberately avoid an i18n round-trip
 * here because the rest of the settings page is also English-only;
 * once the app picks up i18n machinery this helper migrates to
 * `Intl.RelativeTimeFormat` or `Intl.NumberFormat` with a unit.
 */
function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (seconds < 60 * 60) {
    const minutes = seconds / 60;
    const rounded = Math.round(minutes * 10) / 10;
    return `${rounded} minute${rounded === 1 ? "" : "s"}`;
  }
  if (seconds < 24 * 60 * 60) {
    const hours = seconds / 3600;
    const rounded = Math.round(hours * 10) / 10;
    return `${rounded} hour${rounded === 1 ? "" : "s"}`;
  }
  const days = seconds / (24 * 3600);
  const rounded = Math.round(days * 10) / 10;
  return `${rounded} day${rounded === 1 ? "" : "s"}`;
}

export default function ModelIdleTimeoutCard() {
  const { settings, loading, refresh } = useSettings();
  const { update } = useUpdateSetting();
  const inputId = useId();
  const [draft, setDraft] = useState<number>(settings.modelIdleUnloadSecs);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-seed draft from persisted value when the underlying
  // settings refresh (e.g. user reverted via another window, or
  // boot-time IPC resolved). We intentionally do NOT mirror
  // `settings.modelIdleUnloadSecs` on every render — that would
  // clobber the user's in-progress edit on the very next
  // useSettings re-render.
  useEffect(() => {
    setDraft(settings.modelIdleUnloadSecs);
  }, [settings.modelIdleUnloadSecs]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const next = clamp(draft);
      await update({ modelIdleUnloadSecs: next });
      // `useUpdateSetting.update` writes the new SettingsData into
      // the shared `useSettings` cache via the IPC round-trip;
      // refresh() forces a re-read so any sibling card observing
      // the same field is also in sync.
      refresh();
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, refresh, update]);

  if (loading) {
    return (
      <Card>
        <h3 style={{ marginBottom: "var(--spacing-md)" }}>Model idle timeout</h3>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Loading model runtime settings…
        </p>
      </Card>
    );
  }

  const persisted = settings.modelIdleUnloadSecs;
  const dirty = clamp(draft) !== persisted;

  return (
    <Card>
      <h3 style={{ marginBottom: "var(--spacing-md)" }}>Model idle timeout</h3>
      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        How long the text and vision sidecars keep a model resident
        after the last request before unloading it from RAM. Shorter
        values free memory faster; longer values reduce cold-start
        latency when you return to a task. Applies live — no restart
        required.
      </p>

      <div style={{ marginBottom: "var(--spacing-md)" }}>
        <label
          htmlFor={inputId}
          style={{
            display: "block",
            fontSize: "var(--font-size-sm)",
            fontWeight: 600,
            marginBottom: "var(--spacing-xs)",
            color: "var(--color-text-headline)",
          }}
        >
          Idle window
        </label>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-sm)",
          }}
        >
          <input
            id={inputId}
            className="input"
            type="number"
            min={MIN_MODEL_IDLE_UNLOAD_SECS}
            max={MAX_MODEL_IDLE_UNLOAD_SECS}
            step={1}
            value={draft}
            onChange={(e) => {
              const raw = Number.parseInt(e.target.value, 10);
              setDraft(Number.isFinite(raw) ? raw : draft);
            }}
            onBlur={() => setDraft((d) => clamp(d))}
            data-testid="model-idle-input"
            aria-label="Idle window in seconds"
            style={{ width: "10ch" }}
          />
          <span
            style={{
              color: "var(--color-text-secondary)",
              fontSize: "var(--font-size-sm)",
            }}
            aria-live="polite"
          >
            seconds &middot;{" "}
            <span data-testid="model-idle-human">
              {formatSeconds(clamp(draft))}
            </span>
          </span>
        </div>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--spacing-xs)",
          marginBottom: "var(--spacing-md)",
        }}
        data-testid="model-idle-presets"
      >
        {PRESETS.map((preset) => {
          const active = clamp(draft) === preset.seconds;
          return (
            <button
              key={preset.seconds}
              type="button"
              onClick={() => setDraft(preset.seconds)}
              data-testid={`model-idle-preset-${preset.seconds}`}
              aria-pressed={active}
              style={{
                padding: "var(--spacing-xs) var(--spacing-sm)",
                borderRadius: "var(--radius-sm)",
                fontSize: "var(--font-size-sm)",
                border: "1px solid var(--color-border)",
                background: active
                  ? "var(--color-accent-muted, var(--color-surface-elevated))"
                  : "var(--color-surface)",
                color: active
                  ? "var(--color-text-headline)"
                  : "var(--color-text-secondary)",
                cursor: "pointer",
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <p
        style={{
          fontSize: "var(--font-size-xs)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        Range: {MIN_MODEL_IDLE_UNLOAD_SECS} s –{" "}
        {formatSeconds(MAX_MODEL_IDLE_UNLOAD_SECS)}. Currently
        persisted: {formatSeconds(persisted)} ({persisted} s).
      </p>

      {error && (
        <p
          role="alert"
          style={{ color: "var(--color-error)" }}
          data-testid="model-idle-error"
        >
          {error}
        </p>
      )}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
        }}
      >
        <Button
          onClick={handleSave}
          disabled={saving || !dirty}
          data-testid="model-idle-save"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        {savedAt !== null && !dirty && !saving && (
          <span
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-secondary)",
            }}
            aria-live="polite"
            data-testid="model-idle-saved-marker"
          >
            Saved
          </span>
        )}
      </div>
    </Card>
  );
}
