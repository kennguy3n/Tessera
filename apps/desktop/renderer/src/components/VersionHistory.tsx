import { useState, useEffect, useCallback } from "react";
import Button from "./Button";
import type { ArtifactVersionInfo } from "../types/ipc";

interface VersionHistoryProps {
  artifactId: string;
  isOpen: boolean;
  onClose: () => void;
  onRestore: () => void;
}

export default function VersionHistory({
  artifactId,
  isOpen,
  onClose,
  onRestore,
}: VersionHistoryProps) {
  const [versions, setVersions] = useState<ArtifactVersionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [previewVersion, setPreviewVersion] = useState<number | null>(null);
  const [previewContent, setPreviewContent] = useState<string>("");
  const [restoring, setRestoring] = useState(false);

  const loadVersions = useCallback(async () => {
    setLoading(true);
    try {
      const api = window.tessera;
      if (!api) return;
      const response = await api.artifacts.listVersions(artifactId);
      setVersions(response);
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [artifactId]);

  useEffect(() => {
    if (isOpen) loadVersions();
  }, [isOpen, loadVersions]);

  const handlePreview = (version: ArtifactVersionInfo) => {
    setPreviewVersion(version.version);
    setPreviewContent(version.content);
  };

  const handleRestore = async () => {
    if (previewVersion == null) return;
    setRestoring(true);
    try {
      const api = window.tessera;
      if (!api) return;
      await api.artifacts.restoreVersion(artifactId, previewVersion);
      setPreviewVersion(null);
      onRestore();
    } finally {
      setRestoring(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="version-history-panel">
      <div className="version-history-header">
        <h3>Version History</h3>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      {loading ? (
        <p>Loading versions...</p>
      ) : versions.length === 0 ? (
        <p className="version-empty">No previous versions available.</p>
      ) : (
        <div className="version-list">
          {versions.map((version) => (
            <div
              key={version.version}
              className={`version-item ${previewVersion === version.version ? "active" : ""}`}
            >
              <button
                type="button"
                className="version-item-btn"
                onClick={() => handlePreview(version)}
              >
                <span className="version-number">v{version.version}</span>
                <span className="version-date">
                  {new Date(version.createdAt).toLocaleString()}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}

      {previewVersion != null && (
        <div className="version-preview">
          <div className="version-preview-header">
            <span>Preview: v{previewVersion}</span>
            <Button onClick={handleRestore} disabled={restoring}>
              {restoring ? "Restoring..." : "Restore This Version"}
            </Button>
          </div>
          <pre className="version-preview-content">{previewContent}</pre>
        </div>
      )}
    </div>
  );
}
