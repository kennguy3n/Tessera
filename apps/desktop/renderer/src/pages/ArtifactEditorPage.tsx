import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import { DocumentEditor, SlideEditor, SheetEditor, BaseEditor } from "../editors";
import { embedIcons } from "../services/iconResolver";
import type { ArtifactInfo } from "../types/ipc";

const ICON_AWARE_FORMATS = new Set(["html", "pdf", "docx"]);
const BINARY_FORMATS = new Set(["pdf", "docx", "xlsx", "pptx"]);

export default function ArtifactEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<ArtifactInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  const loadArtifact = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      const result = await api.artifacts.get(id);
      setArtifact(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadArtifact();
  }, [loadArtifact]);

  const handleSave = useCallback(
    async (content: string) => {
      if (!id) return;
      try {
        const api = window.tessera;
        if (!api) return;
        const updated = await api.artifacts.update(id, content);
        setArtifact(updated);
      } catch {
        // silently handled — debounced auto-save
      }
    },
    [id],
  );

  const handleExport = useCallback(
    async (format: string) => {
      if (!id) return;
      setExporting(true);
      setExportStatus(null);
      try {
        const api = window.tessera;
        if (!api) return;

        // For icon-aware text formats, resolve {{icon:...}} tokens into
        // inline SVG before handing the content to the Rust exporter.
        // The exporter sees pre-baked SVG and treats it as opaque HTML.
        if (
          ICON_AWARE_FORMATS.has(format) &&
          artifact?.content &&
          /\{\{icon:/.test(artifact.content)
        ) {
          const embedded = embedIcons(artifact.content);
          if (embedded !== artifact.content) {
            await api.artifacts.update(id, embedded);
          }
        }

        if (BINARY_FORMATS.has(format)) {
          // Binary formats can't be copied to the clipboard as text; write
          // them to a temp path next to the artifact and let the user
          // re-export to a chosen location later. Path resolution happens
          // on the main process for sandboxing.
          const ext = format;
          const name = `${artifact?.title ?? "artifact"}.${ext}`.replace(
            /[^A-Za-z0-9._-]/g,
            "_",
          );
          const filePath = `${name}`;
          await api.artifacts.exportToFile(id, format, filePath);
          setExportStatus(`Exported as ${format} → ${filePath}`);
          setTimeout(() => setExportStatus(null), 4000);
        } else {
          const result = await api.artifacts.exportArtifact(id, format);
          await navigator.clipboard.writeText(result.content);
          setExportStatus(
            `Exported as ${result.format} — copied to clipboard`,
          );
          setTimeout(() => setExportStatus(null), 3000);
        }
      } catch (e) {
        setExportStatus(
          `Export failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      } finally {
        setExporting(false);
      }
    },
    [id, artifact?.title, artifact?.content],
  );

  const handleExportEvidencePack = useCallback(async () => {
    if (!id) return;
    const api = window.tessera;
    if (!api) {
      setExportStatus("Export failed: Tessera bridge not available");
      return;
    }
    setExporting(true);
    setExportStatus(null);
    try {
      const safeTitle = (artifact?.title ?? "evidence-pack")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "evidence-pack";
      const dialogResult = await api.dialog.showSaveDialog({
        title: "Export Evidence Pack",
        defaultPath: `${safeTitle}.zip`,
        buttonLabel: "Export",
        filters: [{ name: "Evidence Pack", extensions: ["zip"] }],
      });
      if (dialogResult.canceled || !dialogResult.filePath) {
        setExporting(false);
        return;
      }
      const outPath = await api.artifacts.exportEvidencePack(id, dialogResult.filePath);
      setExportStatus(`Evidence pack exported to ${outPath}`);
      setTimeout(() => setExportStatus(null), 6000);
    } catch (e) {
      setExportStatus(
        `Export failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    } finally {
      setExporting(false);
    }
  }, [id, artifact?.title]);

  if (loading) {
    return (
      <div>
        <PageHeader title="Editor" description="Loading artifact..." />
        <p>Loading...</p>
      </div>
    );
  }

  if (error || !artifact) {
    return (
      <div>
        <PageHeader title="Editor" description="" />
        <Card>
          <p style={{ color: "var(--color-danger)" }}>
            {error || "Artifact not found"}
          </p>
          <Button variant="secondary" onClick={() => navigate("/")}>
            Back to Home
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PageHeader
        title={artifact.title}
        description={`${artifact.artifactType} — v${artifact.version}`}
        actions={
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            <select
              aria-label="Export artifact"
              disabled={exporting}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) {
                  handleExport(v);
                  e.target.value = "";
                }
              }}
              style={{
                padding: "var(--spacing-xs) var(--spacing-sm)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-bg-elevated, #fff)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              <option value="" disabled>
                Export…
              </option>
              <option value="markdown">Markdown (.md)</option>
              <option value="html">HTML (.html)</option>
              <option value="json">JSON (.json)</option>
              <option value="csv">CSV (.csv)</option>
              <option value="pdf">PDF (.pdf)</option>
              <option value="docx">Word (.docx)</option>
              <option value="xlsx">Excel (.xlsx)</option>
              <option value="pptx">PowerPoint (.pptx, Marp)</option>
            </select>
            <Button
              variant="secondary"
              onClick={handleExportEvidencePack}
              disabled={exporting}
              data-testid="export-evidence-pack"
            >
              Export Evidence Pack
            </Button>
            <Button variant="secondary" onClick={() => navigate("/")}>
              Back
            </Button>
          </div>
        }
      />
      {exportStatus && (
        <div
          style={{
            padding: "var(--spacing-sm) var(--spacing-md)",
            background: exportStatus.startsWith("Export failed")
              ? "var(--color-danger-bg, #fee)"
              : "var(--color-success-bg, #efe)",
            borderBottom: "1px solid var(--color-border)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          {exportStatus}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <EditorSwitch artifact={artifact} onSave={handleSave} />
      </div>
    </div>
  );
}

function EditorSwitch({
  artifact,
  onSave,
}: {
  artifact: ArtifactInfo;
  onSave: (content: string) => void;
}) {
  switch (artifact.artifactType) {
    case "document":
      return <DocumentEditor content={artifact.content} onSave={onSave} />;
    case "slides":
      return <SlideEditor content={artifact.content} onSave={onSave} />;
    case "sheet":
      return <SheetEditor content={artifact.content} onSave={onSave} />;
    case "base":
      return <BaseEditor content={artifact.content} onSave={onSave} />;
    default:
      return (
        <Card>
          <p>Unknown artifact type: {artifact.artifactType}</p>
        </Card>
      );
  }
}
