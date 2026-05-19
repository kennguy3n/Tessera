import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import { DocumentEditor, SlideEditor, SheetEditor, BaseEditor } from "../editors";
import type { ArtifactInfo } from "../types/ipc";

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
        const result = await api.artifacts.exportArtifact(id, format);
        await navigator.clipboard.writeText(result.content);
        setExportStatus(`Exported as ${result.format} — copied to clipboard`);
        setTimeout(() => setExportStatus(null), 3000);
      } catch (e) {
        setExportStatus(
          `Export failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      } finally {
        setExporting(false);
      }
    },
    [id],
  );

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
            <Button
              variant="secondary"
              onClick={() => handleExport("markdown")}
              disabled={exporting}
            >
              Export
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
