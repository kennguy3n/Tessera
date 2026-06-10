import { useState, useEffect, useId } from "react";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import ModelRuntimeCard from "../components/ModelRuntimeCard";
import ModelSlotPanel from "../components/ModelSlotPanel";
import ExternalProviderCard from "../components/ExternalProviderCard";
import HybridSearchCard from "../components/HybridSearchCard";
import EmbeddingModelCard from "../components/EmbeddingModelCard";
import KchatSettingsCard from "../components/KchatSettingsCard";
import AuditActivityCard from "../components/AuditActivityCard";
import SourceHealthDashboard from "../components/SourceHealthDashboard";
import ResourceUsageCard from "../components/ResourceUsageCard";
import { RESOURCE_MODE_LABELS } from "../constants/resourceMode";
import { useSettings, useUpdateSetting } from "../hooks/useSettings";
import {
  EXPORT_FORMATS,
  RESOURCE_MODES,
  THEMES,
  type ExportFormat,
  type ResourceMode,
  type Theme,
} from "../types/ipc";
import { MAX_MODEL_IDLE_TIMEOUT_SECS } from "../../../shared/types";

/**
 * discrete buckets exposed via the
 * `<select>` for `modelIdleTimeoutSecs`. Buckets cover the common
 * range — quick reload (30 s) through a long-running session
 * (1 hour) — plus a `0` sentinel that disables idle unloading
 * entirely. The label "Never (keep loaded)" matches the
 * `MAX_MODEL_IDLE_TIMEOUT_SECS`-bounded "never" semantics in the
 * IPC + on-disk schemas: the `0` value short-circuits
 * `startIdleMonitor` so we never even arm the timer.
 *
 * Bucket values are sorted ascending (the `0` sentinel is
 * displayed last so the natural top-to-bottom reading order is
 * "shorter window → longer window → never").
 */
const MODEL_IDLE_TIMEOUT_BUCKETS: ReadonlyArray<{
  value: number;
  label: string;
}> = [
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 5 * 60, label: "5 minutes" },
  { value: 30 * 60, label: "30 minutes" },
  { value: 60 * 60, label: "1 hour" },
  { value: 0, label: "Never (keep loaded)" },
];

const THEME_LABELS: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
  markdown: "Markdown",
  html: "HTML",
  csv: "CSV",
  json: "JSON",
};

export default function SettingsPage() {
  const { settings, loading, refresh } = useSettings();
  const { update } = useUpdateSetting();
  // Stable per-instance ids so the sibling-pattern labels in this page
  // can be wired to their inputs via htmlFor for screen-reader
  // accessibility. Without these the four labels (Theme, Watch
  // Patterns, Ignore Patterns, Default Export Format) render as
  // orphan <label> elements that don't focus the input on click and
  // are not announced as the input's accessible name.
  const themeId = useId();
  const watchPatternsId = useId();
  const ignorePatternsId = useId();
  const exportFormatId = useId();
  const modelIdleTimeoutId = useId();
  const resourceModeId = useId();
  const [theme, setTheme] = useState(settings.theme);
  const [defaultExportFormat, setDefaultExportFormat] = useState(
    settings.defaultExportFormat,
  );
  const [ignorePatterns, setIgnorePatterns] = useState(
    settings.ignorePatterns.join(", "),
  );
  const [watchPatterns, setWatchPatterns] = useState(
    settings.watchPatterns.join(", "),
  );
  const [modelIdleTimeoutSecs, setModelIdleTimeoutSecs] = useState<number>(
    settings.modelIdleTimeoutSecs,
  );
  const [simplifiedNav, setSimplifiedNav] = useState(settings.simplifiedNav);
  const [autoDownloadModel, setAutoDownloadModel] = useState(
    settings.autoDownloadModel,
  );
  const [resourceMode, setResourceMode] = useState<ResourceMode>(
    settings.resourceMode,
  );
  const [closeToTray, setCloseToTray] = useState(settings.closeToTray);

  useEffect(() => {
    setTheme(settings.theme);
    setDefaultExportFormat(settings.defaultExportFormat);
    setIgnorePatterns(settings.ignorePatterns.join(", "));
    setWatchPatterns(settings.watchPatterns.join(", "));
    setModelIdleTimeoutSecs(settings.modelIdleTimeoutSecs);
    setSimplifiedNav(settings.simplifiedNav);
    setAutoDownloadModel(settings.autoDownloadModel);
    setResourceMode(settings.resourceMode);
    setCloseToTray(settings.closeToTray);
  }, [settings]);

  const handleSave = async () => {
    // cap to MAX_MODEL_IDLE_TIMEOUT_SECS
    // (24 h) before sending — the IPC schema also enforces this
    // but we keep the renderer guard as defense-in-depth so a
    // future bucket value or a manual DOM edit can't poison the
    // on-disk config with an out-of-range value.
    const clampedIdleTimeout = Math.max(
      0,
      Math.min(MAX_MODEL_IDLE_TIMEOUT_SECS, Math.floor(modelIdleTimeoutSecs)),
    );
    await update({
      theme,
      defaultExportFormat,
      ignorePatterns: ignorePatterns
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      watchPatterns: watchPatterns
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
      modelIdleTimeoutSecs: clampedIdleTimeout,
      simplifiedNav,
      autoDownloadModel,
      resourceMode,
      closeToTray,
    });
    refresh();
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Settings" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Settings"
        actions={<Button onClick={handleSave}>Save</Button>}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-lg)" }}>
        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>General</h3>
          <div style={{ marginBottom: "var(--spacing-md)" }}>
            <label
              htmlFor={themeId}
              style={{
                display: "block",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)" as unknown as number,
                marginBottom: "var(--spacing-xs)",
                color: "var(--color-text-headline)",
              }}
            >
              Theme
            </label>
            <select
              id={themeId}
              className="input"
              value={theme}
              onChange={(e) => setTheme(e.target.value as Theme)}
            >
              {THEMES.map((t) => (
                <option key={t} value={t}>
                  {THEME_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
        </Card>

        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>
            Navigation &amp; setup
          </h3>
          <div style={{ marginBottom: "var(--spacing-md)" }}>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--spacing-sm)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={simplifiedNav}
                data-testid="settings-simplified-nav"
                onChange={(e) => setSimplifiedNav(e.target.checked)}
              />
              <span>
                <span
                  style={{
                    display: "block",
                    fontWeight:
                      "var(--font-weight-medium)" as unknown as number,
                    color: "var(--color-text-headline)",
                  }}
                >
                  Simplified navigation
                </span>
                <span
                  style={{
                    fontSize: "var(--font-size-sm)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  Collapse secondary tools (Templates, Tasks, Automations,
                  Vision) under a &ldquo;More tools&rdquo; section by default.
                  Turn off to always show every item in the sidebar.
                </span>
              </span>
            </label>
          </div>
          <div>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--spacing-sm)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={autoDownloadModel}
                data-testid="settings-auto-download-model"
                onChange={(e) => setAutoDownloadModel(e.target.checked)}
              />
              <span>
                <span
                  style={{
                    display: "block",
                    fontWeight:
                      "var(--font-weight-medium)" as unknown as number,
                    color: "var(--color-text-headline)",
                  }}
                >
                  Auto-download recommended AI model
                </span>
                <span
                  style={{
                    fontSize: "var(--font-size-sm)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  On a fresh install, download the recommended local model in
                  the background. Turn off to stay in extraction-only mode and
                  download models manually.
                </span>
              </span>
            </label>
          </div>
          <div style={{ marginTop: "var(--spacing-md)" }}>
            <label
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--spacing-sm)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={closeToTray}
                data-testid="settings-close-to-tray"
                onChange={(e) => setCloseToTray(e.target.checked)}
              />
              <span>
                <span
                  style={{
                    display: "block",
                    fontWeight:
                      "var(--font-weight-medium)" as unknown as number,
                    color: "var(--color-text-headline)",
                  }}
                >
                  Close to tray
                </span>
                <span
                  style={{
                    fontSize: "var(--font-size-sm)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  Keep Tessera running in the system tray when you close the
                  window. Models stop and background work pauses to free memory;
                  reopen from the tray icon. Turn off to quit on close. Use
                  &ldquo;Quit Tessera&rdquo; in the tray menu to exit fully.
                </span>
              </span>
            </label>
          </div>
        </Card>

        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>Sources</h3>
          <div style={{ marginBottom: "var(--spacing-md)" }}>
            <label
              htmlFor={watchPatternsId}
              style={{
                display: "block",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)" as unknown as number,
                marginBottom: "var(--spacing-xs)",
                color: "var(--color-text-headline)",
              }}
            >
              Watch Patterns
            </label>
            <input
              id={watchPatternsId}
              className="input"
              value={watchPatterns}
              onChange={(e) => setWatchPatterns(e.target.value)}
              placeholder="**/*.md, **/*.txt"
            />
          </div>
          <div>
            <label
              htmlFor={ignorePatternsId}
              style={{
                display: "block",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)" as unknown as number,
                marginBottom: "var(--spacing-xs)",
                color: "var(--color-text-headline)",
              }}
            >
              Ignore Patterns
            </label>
            <input
              id={ignorePatternsId}
              className="input"
              value={ignorePatterns}
              onChange={(e) => setIgnorePatterns(e.target.value)}
              placeholder=".git, node_modules, .DS_Store"
            />
          </div>
        </Card>

        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>Performance</h3>
          <div style={{ marginBottom: "var(--spacing-lg)" }}>
            <label
              htmlFor={resourceModeId}
              style={{
                display: "block",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)" as unknown as number,
                marginBottom: "var(--spacing-xs)",
                color: "var(--color-text-headline)",
              }}
            >
              Resource mode
            </label>
            <select
              id={resourceModeId}
              className="input"
              value={resourceMode}
              data-testid="settings-resource-mode"
              onChange={(e) =>
                setResourceMode(e.target.value as ResourceMode)
              }
            >
              {RESOURCE_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {RESOURCE_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
            <p
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-secondary)",
                marginTop: "var(--spacing-xs)",
              }}
            >
              <strong>Lightweight</strong> keeps the idle footprint
              minimal: only one local model (text, vision, or image
              generation) runs at a time — starting one stops the
              others — and background work is gated more aggressively.{" "}
              <strong>Performance</strong> allows text and vision models
              to run concurrently for workflows that interleave them, at
              the cost of higher memory use. Image generation never
              starts automatically in either mode. Switching to
              Lightweight while several models are already running does
              not stop the extras immediately — the single-model limit
              applies the next time a model starts, so an in-progress
              generation is never interrupted.
            </p>
          </div>
          <div>
            <label
              htmlFor={modelIdleTimeoutId}
              style={{
                display: "block",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)" as unknown as number,
                marginBottom: "var(--spacing-xs)",
                color: "var(--color-text-headline)",
              }}
            >
              Model idle unload
            </label>
            <select
              id={modelIdleTimeoutId}
              className="input"
              value={modelIdleTimeoutSecs}
              onChange={(e) =>
                setModelIdleTimeoutSecs(Number(e.target.value))
              }
            >
              {/*
               * follow-up: if the persisted
               * value isn't in `MODEL_IDLE_TIMEOUT_BUCKETS` (e.g.
               * the user hand-edited `config.json` to `90`, or a
               * future build changes the bucket list and a stale
               * config carries an old value), the `<select>` would
               * otherwise render blank — `<select>` falls back to
               * the first option visually but `value` still reports
               * the unmatched number, so saving snaps it to the
               * first bucket on the next render. Prepending a
               * synthetic "Custom" option preserves the user's
               * explicit choice in the UI and labels it clearly
               * so they know it didn't come from the bucket list.
               */}
              {!MODEL_IDLE_TIMEOUT_BUCKETS.some(
                (b) => b.value === modelIdleTimeoutSecs,
              ) && (
                <option
                  key="custom"
                  value={modelIdleTimeoutSecs}
                >
                  Custom ({modelIdleTimeoutSecs} seconds)
                </option>
              )}
              {MODEL_IDLE_TIMEOUT_BUCKETS.map((bucket) => (
                <option key={bucket.value} value={bucket.value}>
                  {bucket.label}
                </option>
              ))}
            </select>
            <p
              style={{
                fontSize: "var(--font-size-xs)",
                color: "var(--color-text-secondary)",
                marginTop: "var(--spacing-xs)",
              }}
            >
              How long the local text / vision / image-generation
              sidecars stay loaded after the last request. Lower
              values free RAM faster; higher values avoid reload
              latency on the next call. On memory-constrained GPUs
              (≤ 8 GB), the <strong>30 seconds</strong> bucket
              matches the pre-unification diffusion default and
              reduces peak GPU VRAM hold time.
            </p>
          </div>
        </Card>

        <ResourceUsageCard />

        <ModelRuntimeCard />

        {/*
         * Vision and image-generation slots — separate cards because
         * each slot has its own active-model-<capability>.json file,
         * its own download lifecycle, and its own lazy-start sidecar.
         * The `ModelSlotPanel` component handles install / recommend /
         * delete for one capability at a time; Start/Stop is omitted
         * because the vision + diffusion sidecars start on the first
         * `vision:describe` / `imagegen:generate` call and there is no
         * point pre-warming them (each consumes multi-GB of RAM).
         */}
        <ModelSlotPanel
          capability="vision"
          title="Vision model"
          description="Used by the Vision page (describe, OCR, chart extraction) and by source indexing for image / PDF understanding. Sidecar starts on the first vision call."
          testIdPrefix="vision-slot"
        />

        <ModelSlotPanel
          capability="imagegen"
          title="Image-generation model"
          description="Used by the infographic and landing-page editors to generate hero images. Requires a supported GPU (Metal / CUDA / Vulkan) or Apple Silicon. Sidecar starts on the first generation call."
          testIdPrefix="imagegen-slot"
        />

        <ExternalProviderCard />

        <HybridSearchCard />

        <EmbeddingModelCard />

        <KchatSettingsCard />

        <AuditActivityCard />

        <SourceHealthDashboard />

        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>Export</h3>
          <div>
            <label
              htmlFor={exportFormatId}
              style={{
                display: "block",
                fontSize: "var(--font-size-sm)",
                fontWeight: "var(--font-weight-medium)" as unknown as number,
                marginBottom: "var(--spacing-xs)",
                color: "var(--color-text-headline)",
              }}
            >
              Default Export Format
            </label>
            <select
              id={exportFormatId}
              className="input"
              value={defaultExportFormat}
              onChange={(e) =>
                setDefaultExportFormat(e.target.value as ExportFormat)
              }
            >
              {EXPORT_FORMATS.map((fmt) => (
                <option key={fmt} value={fmt}>
                  {EXPORT_FORMAT_LABELS[fmt]}
                </option>
              ))}
            </select>
          </div>
        </Card>

        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>About</h3>
          <div style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>
            <p>
              <strong>Tessera</strong> v0.1.0
            </p>
            <p>Local-first open-source productivity workspace</p>
            <p style={{ marginTop: "var(--spacing-sm)" }}>
              <a
                href="https://github.com/kennguy3n/Tessera"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>{" "}
              &middot; MIT License
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
