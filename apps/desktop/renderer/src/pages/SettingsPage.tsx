import { useState, useEffect } from "react";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import ModelRuntimeCard from "../components/ModelRuntimeCard";
import { useSettings, useUpdateSetting } from "../hooks/useSettings";

export default function SettingsPage() {
  const { settings, loading, refresh } = useSettings();
  const { update } = useUpdateSetting();
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
              className="input"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </div>
        </Card>

        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>Sources</h3>
          <div style={{ marginBottom: "var(--spacing-md)" }}>
            <label
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
              className="input"
              value={watchPatterns}
              onChange={(e) => setWatchPatterns(e.target.value)}
              placeholder="**/*.md, **/*.txt"
            />
          </div>
          <div>
            <label
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
              className="input"
              value={ignorePatterns}
              onChange={(e) => setIgnorePatterns(e.target.value)}
              placeholder=".git, node_modules, .DS_Store"
            />
          </div>
        </Card>

        <ModelRuntimeCard />

        <Card>
          <h3 style={{ marginBottom: "var(--spacing-md)" }}>Export</h3>
          <div>
            <label
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
              className="input"
              value={defaultExportFormat}
              onChange={(e) => setDefaultExportFormat(e.target.value)}
            >
              <option value="markdown">Markdown</option>
              <option value="html">HTML</option>
              <option value="csv">CSV</option>
              <option value="json">JSON</option>
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
