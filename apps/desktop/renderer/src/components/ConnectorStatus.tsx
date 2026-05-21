import { useState, useEffect, useCallback } from "react";
import type { ConnectorStatusInfo } from "../types/ipc";

interface ConnectorStatusProps {
  provider: string;
  onSync?: () => void;
  onDisconnect?: () => void;
  /**
   * Optional human-friendly label override. By default a built-in
   * label table is used (Google Drive, OneDrive, Notion, …).
   */
  label?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  notion: "Notion",
  jira: "Jira",
  confluence: "Confluence",
  figma: "Figma",
};

export default function ConnectorStatus({
  provider,
  onSync,
  onDisconnect,
  label,
}: ConnectorStatusProps) {
  const [status, setStatus] = useState<ConnectorStatusInfo>({
    provider,
    connected: false,
    status: "unknown",
  });
  const [syncing, setSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const pollStatus = useCallback(async () => {
    try {
      const api = window.tessera;
      if (!api) return;
      const result = await api.connectors.status(provider);
      setStatus(result);
    } catch {
      setStatus({ provider, connected: false, status: "error" });
    }
  }, [provider]);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 10_000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const api = window.tessera;
      if (api) {
        // Google Drive routes through the picker-driven syncDrive API
        // (which falls back to the manifest when no fileIds are given).
        // Every other provider uses the unified `sync(provider)` API.
        const result =
          provider === "google_drive"
            ? await api.connectors.syncDrive()
            : await api.connectors.sync(provider);
        setOffline(result.status === "offline");
      }
      setLastSyncTime(new Date().toLocaleTimeString());
      onSync?.();
    } catch {
      // sync error handled by polling status
    } finally {
      setSyncing(false);
      pollStatus();
    }
  };

  const handleDisconnect = async () => {
    try {
      const api = window.tessera;
      if (api) {
        await api.connectors.disconnect(provider);
      }
      onDisconnect?.();
    } catch {
      // error handled by polling
    }
    pollStatus();
  };

  const statusColor = status.connected
    ? offline
      ? "var(--color-warning, #f59e0b)"
      : "var(--color-success, #22c55e)"
    : "var(--color-muted, #6b7280)";

  const providerLabel = label ?? PROVIDER_LABELS[provider] ?? provider;

  return (
    <div className="connector-status">
      <div className="connector-status-header">
        <span
          className="connector-status-dot"
          style={{ backgroundColor: statusColor }}
          aria-hidden="true"
        />
        <span className="connector-status-name">{providerLabel}</span>
        <span
          className="connector-status-badge"
          role="status"
          aria-live="polite"
        >
          {status.connected
            ? offline
              ? "Offline"
              : "Connected"
            : "Disconnected"}
        </span>
      </div>

      {status.connected && (
        <div className="connector-status-actions">
          {lastSyncTime && (
            <span className="connector-status-last-sync">
              Last sync: {lastSyncTime}
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={handleSync}
            disabled={syncing}
            aria-label={`Sync ${providerLabel} now`}
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={handleDisconnect}
            aria-label={`Disconnect ${providerLabel}`}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
