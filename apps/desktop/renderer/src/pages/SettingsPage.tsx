import { useState, useEffect, useId } from "react";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import ModelRuntimeCard from "../components/ModelRuntimeCard";
import ExternalProviderCard from "../components/ExternalProviderCard";
import HybridSearchCard from "../components/HybridSearchCard";
import { useSettings, useUpdateSetting } from "../hooks/useSettings";
import {
  EXPORT_FORMATS,
  THEMES,
  type ExportFormat,
  type Theme,
} from "../types/ipc";

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

  useEffect(() => {
    setTheme(settings.theme);
    setDefaultExportFormat(settings.defaultExportFormat);
    setIgnorePatterns(settings.ignorePatterns.join(", "));
    setWatchPatterns(settings.watchPatterns.join(", "));
  }, [settings]);

  const handleSave = async () => {
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

        <ModelRuntimeCard />

        <ExternalProviderCard />

        <HybridSearchCard />

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
