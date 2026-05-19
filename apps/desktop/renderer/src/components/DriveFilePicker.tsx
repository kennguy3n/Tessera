import { useState, useEffect, useCallback, useRef } from "react";
import type { ConnectorFileInfo, DriveFileListResult } from "../types/ipc";

interface DriveFilePickerProps {
  onSelect: (files: ConnectorFileInfo[]) => void;
  onCancel: () => void;
}

interface BreadcrumbEntry {
  id: string;
  name: string;
}

export default function DriveFilePicker({ onSelect, onCancel }: DriveFilePickerProps) {
  const [files, setFiles] = useState<ConnectorFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbEntry[]>([
    { id: "root", name: "My Drive" },
  ]);
  const nextPageTokenRef = useRef<string | null>(null);

  const currentFolderId = breadcrumbs[breadcrumbs.length - 1].id;

  const loadFiles = useCallback(async (folderId: string, pageToken?: string) => {
    const api = window.tessera;
    if (!api) return;
    if (pageToken) {
      setLoadingMore(true);
    } else {
      setLoading(true);
      setError(null);
    }
    try {
      const fid = folderId === "root" ? undefined : folderId;
      const result: DriveFileListResult = await api.connectors.listDriveFiles(fid, pageToken);
      const items = result.files ?? [];
      if (pageToken) {
        setFiles((prev) => [...prev, ...items]);
      } else {
        setFiles(items);
      }
      nextPageTokenRef.current = result.nextPageToken ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list files");
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    nextPageTokenRef.current = null;
    loadFiles(currentFolderId);
  }, [currentFolderId, loadFiles]);

  const handleLoadMore = () => {
    if (nextPageTokenRef.current && !loadingMore) {
      loadFiles(currentFolderId, nextPageTokenRef.current);
    }
  };

  const handleFolderClick = (folder: ConnectorFileInfo) => {
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setSelected(new Set());
  };

  const handleBreadcrumbClick = (index: number) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setSelected(new Set());
  };

  const toggleSelect = (fileId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) {
        next.delete(fileId);
      } else {
        next.add(fileId);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const selectedFiles = files.filter((f) => selected.has(f.id));
    onSelect(selectedFiles);
  };

  return (
    <div className="drive-picker">
      <div className="drive-picker-header">
        <h3 className="drive-picker-title">Select files from Google Drive</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <nav className="drive-picker-breadcrumbs">
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.id}>
            {i > 0 && <span className="breadcrumb-sep"> / </span>}
            <button
              type="button"
              className="breadcrumb-link"
              onClick={() => handleBreadcrumbClick(i)}
              disabled={i === breadcrumbs.length - 1}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      {error && <div className="drive-picker-error">{error}</div>}

      <div className="drive-picker-list">
        {loading ? (
          <div className="drive-picker-loading">Loading...</div>
        ) : files.length === 0 ? (
          <div className="drive-picker-empty">No files in this folder</div>
        ) : (
          files.map((file) => (
            <div
              key={file.id}
              className={`drive-picker-item ${selected.has(file.id) ? "selected" : ""}`}
              onClick={() => (file.isFolder ? handleFolderClick(file) : toggleSelect(file.id))}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  file.isFolder ? handleFolderClick(file) : toggleSelect(file.id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span className="drive-picker-icon">
                {file.isFolder ? "\uD83D\uDCC1" : "\uD83D\uDCC4"}
              </span>
              <span className="drive-picker-name">{file.name}</span>
              {!file.isFolder && (
                <span className="drive-picker-meta">
                  {file.size > 0 ? formatSize(file.size) : ""}
                </span>
              )}
              {!file.isFolder && (
                <input
                  type="checkbox"
                  checked={selected.has(file.id)}
                  onChange={() => toggleSelect(file.id)}
                  className="drive-picker-checkbox"
                  onClick={(e) => e.stopPropagation()}
                />
              )}
            </div>
          ))
        )}
        {nextPageTokenRef.current && (
          <button
            type="button"
            className="btn btn-ghost btn-sm drive-picker-load-more"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Loading..." : "Load more files"}
          </button>
        )}
      </div>

      <div className="drive-picker-footer">
        <span className="drive-picker-count">
          {selected.size} file{selected.size !== 1 ? "s" : ""} selected
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleConfirm}
          disabled={selected.size === 0}
        >
          Add Selected
        </button>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
