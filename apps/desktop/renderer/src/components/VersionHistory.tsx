import { useState, useEffect, useCallback, useMemo } from "react";
import Button from "./Button";
import type { ArtifactVersionInfo } from "../types/ipc";
import { diffLines } from "../utils/lineDiff";

interface VersionHistoryProps {
  artifactId: string;
  isOpen: boolean;
  onClose: () => void;
  onRestore: () => void;
}

type ViewMode = "preview" | "compare";

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
  // Phase 15 Task 24: side-by-side diff for two versions. The
  // compare-selection set is a Set rather than a tuple so the user
  // can click any two versions in either order; the diff direction
  // is "oldest → newest" by version number regardless of click order
  // so users don't have to think about the direction semantics.
  const [compareSet, setCompareSet] = useState<Set<number>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("preview");

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
    setViewMode("preview");
    setPreviewVersion(version.version);
    setPreviewContent(version.content);
  };

  const handleToggleCompare = (version: ArtifactVersionInfo) => {
    setCompareSet((prev) => {
      const next = new Set(prev);
      if (next.has(version.version)) {
        next.delete(version.version);
      } else {
        // Cap at 2 selections. When the user picks a third version we
        // discard the LOWEST-numbered version currently in the set
        // (NOT necessarily the first-clicked one — `Set` insertion
        // order would give us that, but the policy we want is "always
        // keep the two most recent versions the user has expressed
        // interest in" and version number is a reliable recency proxy
        // here because versions are append-only monotonically-
        // incrementing integers). This keeps the UI out of the
        // "you must deselect before continuing" dead-end while
        // gravitating toward the most-recent-pair compare the user
        // most likely wants.
        if (next.size >= 2) {
          const lowestNumbered = Array.from(next).sort((a, b) => a - b)[0];
          if (lowestNumbered !== undefined) next.delete(lowestNumbered);
        }
        next.add(version.version);
      }
      return next;
    });
  };

  const compareSelections = useMemo(
    () => Array.from(compareSet).sort((a, b) => a - b),
    [compareSet],
  );
  const canCompare = compareSelections.length === 2;

  const compareDiff = useMemo(() => {
    if (viewMode !== "compare" || !canCompare) return null;
    const [vA, vB] = compareSelections;
    const a = versions.find((v) => v.version === vA);
    const b = versions.find((v) => v.version === vB);
    if (!a || !b) return null;
    const { entries, summary } = diffLines(a.content, b.content);
    return { entries, summary, aVersion: vA, bVersion: vB };
  }, [viewMode, canCompare, compareSelections, versions]);

  const handleStartCompare = () => {
    if (!canCompare) return;
    setViewMode("compare");
    setPreviewVersion(null);
    setPreviewContent("");
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
        <>
          <div className="version-history-compare-bar">
            <span className="version-history-compare-hint">
              {compareSelections.length === 0
                ? "Tick two versions to compare."
                : compareSelections.length === 1
                  ? "Pick one more version to compare."
                  : `Comparing v${compareSelections[0]} ↔ v${compareSelections[1]}`}
            </span>
            <Button
              variant="secondary"
              onClick={handleStartCompare}
              disabled={!canCompare}
            >
              Compare
            </Button>
          </div>
          <div className="version-list">
            {versions.map((version) => {
              const isSelectedForCompare = compareSet.has(version.version);
              return (
                <div
                  key={version.version}
                  className={`version-item ${previewVersion === version.version ? "active" : ""}`}
                >
                  <label className="version-compare-checkbox">
                    <input
                      type="checkbox"
                      aria-label={`Select v${version.version} for comparison`}
                      checked={isSelectedForCompare}
                      onChange={() => handleToggleCompare(version)}
                    />
                  </label>
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
              );
            })}
          </div>
        </>
      )}

      {viewMode === "preview" && previewVersion != null && (
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

      {viewMode === "compare" && compareDiff && (
        <div className="version-diff" aria-label="Version comparison">
          <div className="version-diff-header">
            <span>
              Diff: v{compareDiff.aVersion} → v{compareDiff.bVersion}
            </span>
            <span className="version-diff-summary">
              <span className="version-diff-added">
                +{compareDiff.summary.added}
              </span>
              <span className="version-diff-removed">
                −{compareDiff.summary.removed}
              </span>
              <span className="version-diff-unchanged">
                ={compareDiff.summary.unchanged}
              </span>
            </span>
          </div>
          <pre className="version-diff-content">
            {compareDiff.entries.map((entry, idx) => {
              const prefix =
                entry.op === "add" ? "+" : entry.op === "remove" ? "−" : " ";
              return (
                <div
                  key={`${entry.op}-${idx}`}
                  className={`version-diff-line version-diff-line-${entry.op}`}
                >
                  <span className="version-diff-prefix">{prefix}</span>
                  <span className="version-diff-text">{entry.text}</span>
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </div>
  );
}
