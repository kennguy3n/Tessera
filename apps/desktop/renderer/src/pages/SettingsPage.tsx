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
import { useSettings, useUpdateSetting } from "../hooks/useSettings";
import {
  EXPORT_FORMATS,
  THEMES,
  type ExportFormat,
  type Theme,
} from "../types/ipc";
import { MAX_MODEL_IDLE_TIMEOUT_SECS } from "../../../shared/types";

/**
 * Phase 19 PR 9 Task 5: discrete buckets exposed via the
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

  useEffect(() => {
    setTheme(settings.theme);
    setDefaultExportFormat(settings.defaultExportFormat);
    setIgnorePatterns(settings.ignorePatterns.join(", "));
    setWatchPatterns(settings.watchPatterns.join(", "));
    setModelIdleTimeoutSecs(settings.modelIdleTimeoutSecs);
  }, [settings]);

  const handleSave = async () => {
    // Phase 19 PR 9 Task 5: cap to MAX_MODEL_IDLE_TIMEOUT_SECS
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
              latency on the next call.
            </p>
          </div>
        </Card>

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
