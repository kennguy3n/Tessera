/**
 * Subtle HomePage "last backup" indicator.
 *
 * Reads `backup:list` and shows the age of the newest backup
 * ("Last backup: 2h ago"). If no backup has ever been created, it shows
 * a non-blocking prompt linking to Settings → Backup so the user can
 * enable automatic backups. Deliberately understated — a single muted
 * line, never a modal — so it informs without nagging.
 *
 * Self-contained (own IPC read, own `api`/`onOpenSettings` override
 * props for tests) so HomePage stays a thin composition of cards.
 */
import { useCallback, useEffect, useState } from "react";
import type { BackupInfo } from "../../../shared/types";
import { formatRelativeTime } from "../utils/formatBackup";

interface BackupStatusIndicatorProps {
  /** Override `window.tessera.backup` (used by tests). */
  api?: typeof window.tessera.backup;
  /** Navigate to Settings → Backup. Injected so HomePage owns routing. */
  onOpenSettings?: () => void;
}

export default function BackupStatusIndicator({
  api,
  onOpenSettings,
}: BackupStatusIndicatorProps = {}) {
  const backup = api ?? window.tessera?.backup;
  const [newest, setNewest] = useState<BackupInfo | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!backup) {
      setLoaded(true);
      return;
    }
    try {
      const list = await backup.list();
      // `backup:list` is newest-first; the first entry is the freshest.
      setNewest(list[0] ?? null);
    } catch {
      // A read failure here must never break the HomePage — the
      // indicator simply renders its "no backups yet" prompt.
      setNewest(null);
    } finally {
      setLoaded(true);
    }
  }, [backup]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Render nothing until the first read resolves so we never flash the
  // "no backups" prompt at a user who actually has backups.
  if (!backup || !loaded) return null;

  if (newest) {
    return (
      <div
        data-testid="backup-indicator"
        style={{
          fontSize: "0.85em",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-lg)",
        }}
      >
        Last backup: {formatRelativeTime(newest.createdAtMs)}
      </div>
    );
  }

  return (
    <div
      data-testid="backup-indicator-empty"
      style={{
        fontSize: "0.85em",
        color: "var(--color-text-secondary)",
        marginBottom: "var(--spacing-lg)",
      }}
    >
      No backups yet.{" "}
      <button
        type="button"
        onClick={onOpenSettings}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          color: "var(--color-primary)",
          cursor: "pointer",
          textDecoration: "underline",
          font: "inherit",
        }}
      >
        Turn on automatic backups
      </button>{" "}
      to protect your data.
    </div>
  );
}
