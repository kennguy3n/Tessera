import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderPlus } from "lucide-react";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import Modal from "../components/Modal";
import ComparisonResultModal from "../components/ComparisonResultModal";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import ConnectorStatus from "../components/ConnectorStatus";
import ConnectorsList from "../components/ConnectorsList";
import DriveFilePicker from "../components/DriveFilePicker";
import KchatChannelSourcePicker from "../components/KchatChannelSourcePicker";
import { useSourceList, useAddSource, useRemoveSource } from "../hooks/useSources";
// Phase 13 Theme 2 (Task 11 review-pass fix, ANALYSIS_0005 on
// f7c8dd1): import from the shared utility module instead of from
// `./SourceDetailPage`. The two pages are siblings; routing list
// pages through detail-page imports creates a structurally
// unjustified coupling and pulls the SourceDetailPage component
// tree into SourcesPage's module graph.
import { formatSourceTypeLabel, sourceTypeIcon } from "../utils/sourceLabels";
import type {
  CompareSourcesResult,
  ConnectorFileInfo,
  ConnectorStatusInfo,
} from "../types/ipc";

// Stable reference so `ConnectorsList`'s dep-equality memo doesn't
// invalidate on every render of `SourcesPage`.
const EXCLUDED_FROM_LIST: ReadonlyArray<string> = ["google_drive"];

export default function SourcesPage() {
  const navigate = useNavigate();
  const { sources, loading, refresh } = useSourceList();
  const { addFolder, addFile } = useAddSource();
  const { remove } = useRemoveSource();
  const [modalOpen, setModalOpen] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [addMode, setAddMode] = useState<"folder" | "file">("folder");
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [compareError, setCompareError] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [comparisonResult, setComparisonResult] =
    useState<CompareSourcesResult | null>(null);

  const [driveStatus, setDriveStatus] = useState<ConnectorStatusInfo>({
    provider: "google_drive",
    connected: false,
    status: "unknown",
  });
  const [driveAuthOpen, setDriveAuthOpen] = useState(false);
  const [driveAuthClientId, setDriveAuthClientId] = useState("");
  const [driveAuthClientSecret, setDriveAuthClientSecret] = useState("");
  const [driveAuthError, setDriveAuthError] = useState<string | null>(null);
  const [driveAuthBusy, setDriveAuthBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerBusy, setPickerBusy] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const [kchatConnected, setKchatConnected] = useState<boolean | null>(null);
  const [kchatPickerOpen, setKchatPickerOpen] = useState(false);

  // Probe KChat status on mount. We re-probe whenever the modal
  // closes so a fresh connect from Settings is picked up without a
  // page reload.
  useEffect(() => {
    const k = window.tessera?.kchat;
    if (!k) {
      setKchatConnected(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const available = await k.isAvailable();
        if (cancelled) return;
        if (!available) {
          setKchatConnected(false);
          return;
        }
        const status = await k.status();
        if (!cancelled) setKchatConnected(status.state === "connected");
      } catch {
        if (!cancelled) setKchatConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kchatPickerOpen]);

  const refreshDriveStatus = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    try {
      const next = await api.connectors.status("google_drive");
      setDriveStatus(next);
    } catch {
      setDriveStatus({ provider: "google_drive", connected: false, status: "error" });
    }
  }, []);

  useEffect(() => {
    refreshDriveStatus();
  }, [refreshDriveStatus]);

  // Prune `selectedIds` whenever the source list changes so a removed
  // source can never leave a stale ID in the selection. This fixes the
  // failure mode where a user selected two sources, removed one via the
  // Remove modal, and clicked Compare — the removed source's ID was
  // still in `selectedIds` so the button remained enabled and dispatched
  // an `artifacts:compareSources` call with a now-invalid ID, which
  // failed on the backend.
  // We do this reactively against `sources` instead of patching
  // `handleRemove` for two reasons:
  //   1. Defense-in-depth — every code path that mutates the source
  //      list (handleRemove, Drive sync that drops a no-longer-shared
  //      file, hot-reload during npm run dev, future "trash" workflow,
  //      multi-window concurrent removal) automatically prunes the
  //      selection. There is no way to add a future source mutation
  //      that accidentally bypasses this.
  //   2. The "valid selection ⊆ visible sources" invariant is now
  //      expressed in code rather than relying on every call site to
  //      remember to clean up.
  // Identity preservation: if no prune is needed we return the same
  // `Set` reference so consumers (`selectedIds.size !== 2 || comparing`
  // in the Compare button) don't trigger unnecessary re-renders.
  useEffect(() => {
    const validIds = new Set(sources.map((s) => s.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [sources]);

  const handleAuthenticateDrive = async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setDriveAuthError("Tessera bridge not available");
      return;
    }
    if (!driveAuthClientId.trim() || !driveAuthClientSecret.trim()) {
      setDriveAuthError("Client ID and Client Secret are required");
      return;
    }
    setDriveAuthBusy(true);
    setDriveAuthError(null);
    try {
      const next = await api.connectors.authenticate(
        "google_drive",
        driveAuthClientId.trim(),
        driveAuthClientSecret.trim(),
      );
      setDriveStatus(next);
      setDriveAuthOpen(false);
      setDriveAuthClientId("");
      setDriveAuthClientSecret("");
    } catch (err) {
      setDriveAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setDriveAuthBusy(false);
    }
  };

  const handlePickerSelect = async (picked: ConnectorFileInfo[]) => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setPickerOpen(false);
      return;
    }
    setPickerBusy(true);
    setPickerError(null);
    try {
      await api.connectors.selectItems(
        picked.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType })),
      );
      await api.connectors.syncDrive(picked.map((f) => f.id));
      refresh();
    } catch (err) {
      // selectItems / syncDrive failures (network errors, expired Drive
      // creds, etc.) used to silently propagate to the nearest error boundary
      // and the picker just closed — the user had no idea their picks were
      // dropped. Surface the message as a top-level alert so they can retry.
      setPickerError(err instanceof Error ? err.message : String(err));
    } finally {
      setPickerBusy(false);
      setPickerOpen(false);
    }
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleCompare = async () => {
    if (selectedIds.size !== 2) {
      setCompareError("Select exactly two sources to compare.");
      return;
    }
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setCompareError("Tessera bridge not available");
      return;
    }
    setComparing(true);
    setCompareError(null);
    try {
      const [a, b] = Array.from(selectedIds);
      // The bridge now returns a structured `CompareSourcesResult`
      // carrying both the persisted artifact AND the rich theme
      // breakdown. Display the structured view in the modal
      // instead of immediately navigating away — the user can
      // still click "Open artifact" inside the modal to reach the
      // full artifact page. This keeps the comparison flow
      // self-contained on the SourcesPage (where the user picked
      // the two sources) so cross-comparing pairs of sources
      // doesn't bounce them through the artifact editor.
      const result = await api.artifacts.compareSources(a, b);
      setComparisonResult(result);
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err));
    } finally {
      setComparing(false);
    }
  };

  const handleAdd = async () => {
    if (!folderPath.trim()) return;
    if (addMode === "folder") {
      await addFolder(folderPath.trim());
    } else {
      await addFile(folderPath.trim());
    }
    setFolderPath("");
    setModalOpen(false);
    refresh();
  };

  const handleRemove = async (id: string) => {
    await remove(id);
    setConfirmRemove(null);
    refresh();
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Sources" description="Manage your data sources" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Sources"
        description="Manage your data sources"
        actions={
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            <Button
              variant="secondary"
              onClick={() => setDriveAuthOpen(true)}
              data-testid="connect-google-drive"
            >
              {driveStatus.connected ? "Manage Google Drive" : "Connect Google Drive"}
            </Button>
            {driveStatus.connected && (
              <Button
                variant="secondary"
                onClick={() => setPickerOpen(true)}
                data-testid="pick-drive-files"
              >
                Pick Drive Files
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={handleCompare}
              disabled={selectedIds.size !== 2 || comparing}
              data-testid="compare-sources"
            >
              {comparing ? "Comparing…" : `Compare (${selectedIds.size}/2)`}
            </Button>
            {kchatConnected && (
              <Button
                variant="secondary"
                onClick={() => setKchatPickerOpen(true)}
                data-testid="add-kchat-channel"
              >
                Add KChat Channel
              </Button>
            )}
            <Button onClick={() => setModalOpen(true)}>Add Source</Button>
          </div>
        }
      />

      <div
        style={{
          marginBottom: "var(--spacing-md)",
          display: "grid",
          gap: "var(--spacing-md)",
        }}
      >
        {/* Google Drive keeps its own ConnectorStatus card here because
            the Drive file picker flow lives in this page (see the
            DriveFilePicker modal below) and the "Manage Google Drive"
            button needs the current `driveStatus`. */}
        <ConnectorStatus
          provider="google_drive"
          onSync={refresh}
          onDisconnect={() => {
            refreshDriveStatus();
            refresh();
          }}
        />
        {/* the rest of the connectors (OneDrive / Notion /
            Jira / Confluence / Figma) share the same multi-provider
            list. Connecting one of these triggers the OAuth flow and
            adds its synced files to the index. Google Drive is
            excluded here because the dedicated `ConnectorStatus`
            above already renders it (and owns the Drive file-picker
            flow attached to this page). */}
        <ConnectorsList onChange={refresh} excludeProviders={EXCLUDED_FROM_LIST} />
      </div>

      {compareError && (
        <div
          style={{
            marginBottom: "var(--spacing-md)",
            padding: "var(--spacing-sm)",
            color: "var(--color-danger, #ef4444)",
            fontSize: "var(--font-size-sm)",
          }}
          data-testid="compare-error"
        >
          {compareError}
        </div>
      )}

      {pickerError && (
        <div
          style={{
            marginBottom: "var(--spacing-md)",
            padding: "var(--spacing-sm)",
            color: "var(--color-danger, #ef4444)",
            fontSize: "var(--font-size-sm)",
          }}
          data-testid="picker-error"
        >
          Drive sync failed: {pickerError}
        </div>
      )}

      {sources.length === 0 ? (
        <EmptyState
          icon={<FolderPlus size={48} strokeWidth={1.5} aria-hidden="true" />}
          title="No sources connected"
          message="Add a local folder or file to start indexing and searching your content."
          action={
            <Button onClick={() => setModalOpen(true)}>Add Source</Button>
          }
        />
      ) : (
        <div
          style={{
            display: "grid",
            gap: "var(--spacing-md)",
          }}
        >
          {sources.map((source) => {
            const typeIcon = sourceTypeIcon(source.sourceType);
            return (
            <Card key={source.id}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                }}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--spacing-sm)" }}>
                  <input
                    type="checkbox"
                    checked={selectedIds.has(source.id)}
                    onChange={() => toggleSelected(source.id)}
                    data-testid={`source-select-${source.id}`}
                    style={{ marginTop: 6 }}
                  />
                  <div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-sm)",
                      marginBottom: "var(--spacing-xs)",
                    }}
                  >
                    {typeIcon.glyph && (
                      <span
                        role="img"
                        aria-label={typeIcon.ariaLabel}
                        data-testid={`source-icon-${source.id}`}
                        data-source-type={source.sourceType}
                        style={{
                          fontSize: "1.1em",
                          lineHeight: 1,
                          flexShrink: 0,
                        }}
                      >
                        {typeIcon.glyph}
                      </span>
                    )}
                    <span
                      className="card-title"
                      style={{ margin: 0, cursor: "pointer" }}
                      onClick={() => navigate(`/sources/${source.id}`)}
                    >
                      {source.path}
                    </span>
                    <StatusBadge status={source.status} />
                  </div>
                  <div className="card-description">
                    {formatSourceTypeLabel(source.sourceType)}{" "}
                    &middot; {source.fileCount} files
                    {source.lastIndexed && (
                      <>
                        {" "}
                        &middot; Last indexed:{" "}
                        {new Date(source.lastIndexed).toLocaleString()}
                      </>
                    )}
                  </div>
                  </div>
                </div>
                <Button
                  variant="danger"
                  onClick={() => setConfirmRemove(source.id)}
                >
                  Remove
                </Button>
              </div>
            </Card>
            );
          })}
        </div>
      )}

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Add Source"
      >
        <div style={{ display: "flex", gap: "var(--spacing-sm)", marginBottom: "var(--spacing-md)" }}>
          <Button
            variant={addMode === "folder" ? "primary" : "secondary"}
            onClick={() => setAddMode("folder")}
          >
            Local Folder
          </Button>
          <Button
            variant={addMode === "file" ? "primary" : "secondary"}
            onClick={() => setAddMode("file")}
          >
            Local File
          </Button>
        </div>
        <input
          className="input"
          placeholder={
            addMode === "folder"
              ? "Enter folder path (e.g., /home/user/docs)"
              : "Enter file path (e.g., /home/user/report.md)"
          }
          value={folderPath}
          onChange={(e) => setFolderPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
        />
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--spacing-sm)",
            marginTop: "var(--spacing-md)",
          }}
        >
          <Button variant="secondary" onClick={() => setModalOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!folderPath.trim()}>
            Add
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={driveAuthOpen}
        onClose={() => {
          setDriveAuthOpen(false);
          setDriveAuthError(null);
        }}
        title="Connect Google Drive"
      >
        <p style={{ marginBottom: "var(--spacing-md)", fontSize: "var(--font-size-sm)" }}>
          Provide an OAuth client created in Google Cloud Console (Desktop app type).
          Tessera stores the resulting refresh token encrypted in the platform keystore.
        </p>
        <input
          className="input"
          placeholder="Client ID"
          value={driveAuthClientId}
          onChange={(e) => setDriveAuthClientId(e.target.value)}
          style={{ marginBottom: "var(--spacing-sm)" }}
        />
        <input
          className="input"
          placeholder="Client Secret"
          type="password"
          value={driveAuthClientSecret}
          onChange={(e) => setDriveAuthClientSecret(e.target.value)}
        />
        {driveAuthError && (
          <p
            style={{
              color: "var(--color-danger, #ef4444)",
              fontSize: "var(--font-size-sm)",
              marginTop: "var(--spacing-sm)",
            }}
            data-testid="drive-auth-error"
          >
            {driveAuthError}
          </p>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--spacing-sm)",
            marginTop: "var(--spacing-md)",
          }}
        >
          <Button
            variant="secondary"
            onClick={() => {
              setDriveAuthOpen(false);
              setDriveAuthError(null);
            }}
          >
            Cancel
          </Button>
          <Button
            onClick={handleAuthenticateDrive}
            disabled={driveAuthBusy || !driveAuthClientId.trim() || !driveAuthClientSecret.trim()}
          >
            {driveAuthBusy ? "Authenticating…" : "Authenticate"}
          </Button>
        </div>
      </Modal>

      <Modal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Pick Files from Google Drive"
      >
        {pickerBusy ? (
          <p>Syncing selected files…</p>
        ) : (
          <DriveFilePicker
            onSelect={handlePickerSelect}
            onCancel={() => setPickerOpen(false)}
          />
        )}
      </Modal>

      <Modal
        isOpen={confirmRemove !== null}
        onClose={() => setConfirmRemove(null)}
        title="Remove Source"
      >
        <p style={{ marginBottom: "var(--spacing-md)" }}>
          Are you sure you want to remove this source? This will delete all
          indexed content from this source.
        </p>
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: "var(--spacing-sm)",
          }}
        >
          <Button variant="secondary" onClick={() => setConfirmRemove(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => confirmRemove && handleRemove(confirmRemove)}
          >
            Remove
          </Button>
        </div>
      </Modal>

      {comparisonResult && (
        <ComparisonResultModal
          isOpen={comparisonResult !== null}
          onClose={() => setComparisonResult(null)}
          result={comparisonResult}
        />
      )}

      {kchatPickerOpen && (
        <KchatChannelSourcePicker
          isOpen={kchatPickerOpen}
          onClose={() => setKchatPickerOpen(false)}
          onAdded={() => {
            refresh();
            setKchatPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}
