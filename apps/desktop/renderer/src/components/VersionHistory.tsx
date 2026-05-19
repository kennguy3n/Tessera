import { useState, useEffect, useCallback } from "react";
import Button from "./Button";

interface ArtifactVersionInfo {
  versionNumber: number;
  contentSnapshot: string;
  createdAt: string;
}

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
      // Use IPC to get versions - this will be wired through the bridge
      const response = await (window as unknown as { tessera: { artifacts: { listVersions: (id: string) => Promise<ArtifactVersionInfo[]> } } }).tessera.artifacts.listVersions(artifactId);
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
    setPreviewVersion(version.versionNumber);
    setPreviewContent(version.contentSnapshot);
  };

  const handleRestore = async () => {
    if (previewVersion == null) return;
    setRestoring(true);
    try {
      const api = window.tessera;
      if (!api) return;
      await (window as unknown as { tessera: { artifacts: { restoreVersion: (id: string, version: number) => Promise<void> } } }).tessera.artifacts.restoreVersion(artifactId, previewVersion);
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
              key={version.versionNumber}
              className={`version-item ${previewVersion === version.versionNumber ? "active" : ""}`}
            >
              <button
                type="button"
                className="version-item-btn"
                onClick={() => handlePreview(version)}
              >
                <span className="version-number">v{version.versionNumber}</span>
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
