/**
 * Settings → Backup card.
 *
 * Surfaces the local backup & recovery system: a toggle for the
 * automatic-backup scheduler, the backup folder (chosen via a native
 * picker), the retention count, a manual "Back up now" button, and a
 * list of recent backups each with a "Restore" action (which warns it
 * replaces the current data and requires a restart). It also drives the
 * full-workspace bundle export/import.
 *
 * All persistence and scheduling live in the main process behind the
 * `backup:*` channels; this card is a thin, self-contained view (like
 * {@link AuditActivityCard} / {@link KchatSettingsCard}) that reads
 * `backup:status` + `backup:list` and writes through `backup:configure`,
 * `backup:create`, `backup:restore`, and the bundle channels. A restore
 * never mutates the live database — it stages a file swapped in at the
 * next launch — so the card prompts the user to relaunch afterwards.
 */
import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import {
  MIN_BACKUP_RETENTION_COUNT,
  MAX_BACKUP_RETENTION_COUNT,
  MIN_BACKUP_INTERVAL_HOURS,
  MAX_BACKUP_INTERVAL_HOURS,
  type BackupInfo,
  type BackupStatus,
} from "../../../shared/types";
import { formatBytes, formatRelativeTime } from "../utils/formatBackup";

interface BackupSettingsCardProps {
  /** Override `window.tessera.backup` (used by tests). */
  api?: typeof window.tessera.backup;
  /** Override `window.tessera.dialog` (used by tests). */
  dialogApi?: typeof window.tessera.dialog;
}

export default function BackupSettingsCard({
  api,
  dialogApi,
}: BackupSettingsCardProps = {}) {
  const backup = api ?? window.tessera?.backup;
  const dialog = dialogApi ?? window.tessera?.dialog;

  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Number inputs are edited as free text ("draft") so an in-progress
  // value like "" or "1" mid-typing never fires IPC or trips the
  // backend's min/max validation. The draft is committed — parsed,
  // clamped, and persisted — only on blur / Enter, then re-synced from
  // the authoritative status below.
  const [intervalDraft, setIntervalDraft] = useState("");
  const [retentionDraft, setRetentionDraft] = useState("");

  const refresh = useCallback(async () => {
    if (!backup) return;
    setLoading(true);
    try {
      const [nextStatus, nextBackups] = await Promise.all([
        backup.status(),
        backup.list(),
      ]);
      setStatus(nextStatus);
      setBackups(nextBackups);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [backup]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Persist a single config field and adopt the returned status so the
  // UI reflects the (clamped / resolved) authoritative state rather
  // than the optimistic local value.
  const configure = useCallback(
    async (patch: Parameters<typeof backup.configure>[0]) => {
      if (!backup) return;
      setBusy(true);
      try {
        const next = await backup.configure(patch);
        setStatus(next);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [backup],
  );

  const handleToggleAuto = useCallback(
    (checked: boolean) => {
      void configure({ autoBackup: checked });
    },
    [configure],
  );

  // Re-sync the editable drafts whenever the authoritative status
  // changes (initial load, a clamp applied by the main process, or a
  // config change from elsewhere). Keyed on the numeric fields so an
  // unrelated status update (e.g. lastBackupError) doesn't clobber an
  // in-progress edit.
  const statusInterval = status?.backupIntervalHours;
  const statusRetention = status?.backupRetentionCount;
  useEffect(() => {
    if (statusInterval !== undefined) setIntervalDraft(String(statusInterval));
  }, [statusInterval]);
  useEffect(() => {
    if (statusRetention !== undefined)
      setRetentionDraft(String(statusRetention));
  }, [statusRetention]);

  // Commit a number-input draft: parse, clamp to [min, max], and persist
  // only if the value actually changed. An unparseable/empty draft
  // reverts to the authoritative value rather than sending a bad write.
  const commitInterval = useCallback(() => {
    const parsed = Number(intervalDraft);
    if (!Number.isFinite(parsed) || intervalDraft.trim() === "") {
      if (statusInterval !== undefined) setIntervalDraft(String(statusInterval));
      return;
    }
    const clamped = Math.max(
      MIN_BACKUP_INTERVAL_HOURS,
      Math.min(MAX_BACKUP_INTERVAL_HOURS, Math.floor(parsed)),
    );
    setIntervalDraft(String(clamped));
    if (clamped !== statusInterval) {
      void configure({ backupIntervalHours: clamped });
    }
  }, [intervalDraft, statusInterval, configure]);

  const commitRetention = useCallback(() => {
    const parsed = Number(retentionDraft);
    if (!Number.isFinite(parsed) || retentionDraft.trim() === "") {
      if (statusRetention !== undefined)
        setRetentionDraft(String(statusRetention));
      return;
    }
    const clamped = Math.max(
      MIN_BACKUP_RETENTION_COUNT,
      Math.min(MAX_BACKUP_RETENTION_COUNT, Math.floor(parsed)),
    );
    setRetentionDraft(String(clamped));
    if (clamped !== statusRetention) {
      void configure({ backupRetentionCount: clamped });
    }
  }, [retentionDraft, statusRetention, configure]);

  const handleChooseFolder = useCallback(async () => {
    if (!dialog || !backup) return;
    const result = await dialog.openDirectory({
      title: "Choose backup folder",
    });
    if (result.canceled || result.filePath === null) return;
    void configure({ backupDir: result.filePath });
  }, [dialog, backup, configure]);

  const handleResetFolder = useCallback(() => {
    // Empty string is the "use the default `<userData>/backups`"
    // sentinel the main process resolves at runtime.
    void configure({ backupDir: "" });
  }, [configure]);

  const handleBackupNow = useCallback(async () => {
    if (!backup) return;
    setBusy(true);
    setNotice(null);
    try {
      const info = await backup.create();
      setNotice(`Backed up — ${info.fileName} (${formatBytes(info.sizeBytes)})`);
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [backup, refresh]);

  const handleRestore = useCallback(
    async (info: BackupInfo) => {
      if (!backup) return;
      const ok = window.confirm(
        `Restore from "${info.fileName}"?\n\nThis replaces your current data ` +
          `with the backup. The app must restart to finish restoring, and ` +
          `any changes made since the backup will be lost.`,
      );
      if (!ok) return;
      setBusy(true);
      setNotice(null);
      try {
        await backup.restore(info.path);
        setNotice(
          "Restore staged. Restart Tessera to finish restoring from this backup.",
        );
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [backup],
  );

  const handleExportBundle = useCallback(async () => {
    if (!backup || !dialog) return;
    const save = await dialog.showSaveDialog({
      title: "Export workspace bundle",
      defaultPath: "tessera-workspace.tessera-backup",
      // Lock the picker to the bundle extension so the saved file keeps
      // its `.tessera-backup` suffix and shows up in the import picker
      // (which filters on the same extension) without the user having to
      // switch to "All files".
      filters: [
        { name: "Tessera workspace bundle", extensions: ["tessera-backup"] },
      ],
    });
    if (save.canceled || !save.filePath) return;
    setBusy(true);
    setNotice(null);
    try {
      const info = await backup.exportBundle(save.filePath);
      setNotice(
        `Exported workspace bundle (${formatBytes(info.sizeBytes)}, ` +
          `${info.entryCount} item${info.entryCount === 1 ? "" : "s"}).`,
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [backup, dialog]);

  const handleImportBundle = useCallback(async () => {
    if (!backup || !dialog) return;
    const picked = await dialog.openBundle({
      title: "Import workspace bundle",
    });
    if (picked.canceled || picked.filePath === null) return;
    const ok = window.confirm(
      "Import this workspace bundle?\n\nThis replaces your current data and " +
        "settings with the contents of the bundle. The app must restart to " +
        "finish, and any changes made since the bundle was exported will be lost.",
    );
    if (!ok) return;
    setBusy(true);
    setNotice(null);
    try {
      await backup.importBundle(picked.filePath);
      setNotice(
        "Bundle import staged. Restart Tessera to finish restoring from the bundle.",
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [backup, dialog]);

  if (!backup) {
    return (
      <Card>
        <h2 className="section-title" style={{ marginBottom: "var(--spacing-md)" }}>Backup &amp; Recovery</h2>
        <p style={{ color: "var(--color-text-secondary)" }}>
          Backup is unavailable in this environment.
        </p>
      </Card>
    );
  }

  const newest = backups[0] ?? null;

  return (
    <Card>
      <h2 className="section-title" style={{ marginBottom: "var(--spacing-md)" }}>Backup &amp; Recovery</h2>

      {error && (
        <p role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
      {notice && (
        <p role="status" style={{ color: "var(--color-text-secondary)" }}>
          {notice}
        </p>
      )}

      {/* Auto-backup toggle */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-sm)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        <input
          type="checkbox"
          checked={status?.autoBackup ?? true}
          disabled={busy || loading}
          onChange={(e) => handleToggleAuto(e.target.checked)}
        />
        <span>
          Automatically back up my data
          {status && !status.autoBackup ? " (currently off)" : ""}
        </span>
      </label>

      {/* Backup folder */}
      <div style={{ marginBottom: "var(--spacing-md)" }}>
        <div style={{ marginBottom: "var(--spacing-xs)" }}>
          <strong>Backup folder</strong>
        </div>
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "0.85em",
            color: "var(--color-text-secondary)",
            wordBreak: "break-all",
            marginBottom: "var(--spacing-xs)",
          }}
        >
          {status?.backupDir ?? "…"}
        </div>
        <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void handleChooseFolder()}
          >
            Choose folder…
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={handleResetFolder}
          >
            Use default
          </Button>
        </div>
      </div>

      {/* Interval + retention */}
      <div
        style={{
          display: "flex",
          gap: "var(--spacing-lg)",
          marginBottom: "var(--spacing-md)",
          flexWrap: "wrap",
        }}
      >
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span>Back up every (hours)</span>
          <input
            type="number"
            min={MIN_BACKUP_INTERVAL_HOURS}
            max={MAX_BACKUP_INTERVAL_HOURS}
            value={intervalDraft}
            disabled={busy || loading}
            style={{ width: 100 }}
            onChange={(e) => setIntervalDraft(e.target.value)}
            onBlur={commitInterval}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span>Keep this many backups</span>
          <input
            type="number"
            min={MIN_BACKUP_RETENTION_COUNT}
            max={MAX_BACKUP_RETENTION_COUNT}
            value={retentionDraft}
            disabled={busy || loading}
            style={{ width: 100 }}
            onChange={(e) => setRetentionDraft(e.target.value)}
            onBlur={commitRetention}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
      </div>

      {/* Actions */}
      <div
        style={{
          display: "flex",
          gap: "var(--spacing-sm)",
          marginBottom: "var(--spacing-md)",
          flexWrap: "wrap",
        }}
      >
        <Button disabled={busy} onClick={() => void handleBackupNow()}>
          Back up now
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void handleExportBundle()}
        >
          Export workspace bundle…
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => void handleImportBundle()}
        >
          Import workspace bundle…
        </Button>
      </div>

      {/* Last backup summary */}
      <div
        style={{
          marginBottom: "var(--spacing-md)",
          color: "var(--color-text-secondary)",
          fontSize: "0.9em",
        }}
      >
        {newest
          ? `Last backup ${formatRelativeTime(newest.createdAtMs)} · ${formatBytes(
              newest.sizeBytes,
            )}`
          : "No backups yet."}
        {status?.lastBackupError ? ` · Last error: ${status.lastBackupError}` : ""}
      </div>

      {/* Recent backups list */}
      <div>
        <strong>Recent backups</strong>
        {loading && backups.length === 0 ? (
          <p style={{ color: "var(--color-text-secondary)" }}>Loading…</p>
        ) : backups.length === 0 ? (
          <p style={{ color: "var(--color-text-secondary)" }}>
            None yet. Click “Back up now” to create your first backup.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {backups.map((b) => (
              <li
                key={b.path}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--spacing-sm)",
                  padding: "var(--spacing-xs) 0",
                  borderBottom: "1px solid var(--color-border)",
                }}
              >
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontFamily: "monospace", fontSize: "0.85em" }}>
                    {b.fileName}
                  </span>
                  <span
                    style={{
                      color: "var(--color-text-secondary)",
                      fontSize: "0.8em",
                    }}
                  >
                    {formatRelativeTime(b.createdAtMs)} · {formatBytes(b.sizeBytes)}
                  </span>
                </span>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void handleRestore(b)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
