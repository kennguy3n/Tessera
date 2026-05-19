import { useState, useEffect, useCallback } from "react";
import type { ConnectorStatusInfo } from "../types/ipc";

interface ConnectorStatusProps {
  provider: string;
  onSync?: () => void;
  onDisconnect?: () => void;
}

export default function ConnectorStatus({ provider, onSync, onDisconnect }: ConnectorStatusProps) {
  const [status, setStatus] = useState<ConnectorStatusInfo>({
    provider,
    connected: false,
    status: "unknown",
  });
  const [syncing, setSyncing] = useState(false);
  const [lastSyncTime, setLastSyncTime] = useState<string | null>(null);

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
        await api.connectors.syncDrive();
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
    ? "var(--color-success, #22c55e)"
    : "var(--color-muted, #6b7280)";

  const providerLabel = provider === "google_drive" ? "Google Drive" : provider;

  return (
    <div className="connector-status">
      <div className="connector-status-header">
        <span className="connector-status-dot" style={{ backgroundColor: statusColor }} />
        <span className="connector-status-name">{providerLabel}</span>
        <span className="connector-status-badge">
          {status.connected ? "Connected" : "Disconnected"}
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
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={handleDisconnect}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
