import { useState, useCallback } from "react";
import type { ConnectorStatusInfo } from "../types/ipc";
import { useSuspendablePolling } from "../hooks/useSuspendablePolling";

interface ConnectorStatusProps {
  provider: string;
  onSync?: () => void;
  onDisconnect?: () => void;
  /**
   * Optional human-friendly label override. By default a built-in
   * label table is used (Google Drive, OneDrive, Notion, …).
   */
  label?: string;
  /**
   * Optional one-click reauthentication affordance. When supplied, a
   * "Reconnect" button is rendered alongside Sync/Disconnect so the
   * user can re-run the OAuth flow without first disconnecting —
   * useful when a refresh token has been revoked upstream or the
   * granted scopes were narrowed. The owner (e.g. `ConnectorsList`)
   * wires this to open the shared credential modal. Left undefined
   * by callers that own their own connect flow (e.g. the Google
   * Drive card on `SourcesPage`), in which case no button renders
   * and behaviour is unchanged.
   */
  onReconnect?: () => void;
}

const PROVIDER_LABELS: Record<string, string> = {
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  notion: "Notion",
  jira: "Jira",
  confluence: "Confluence",
  figma: "Figma",
  hubspot: "HubSpot",
  slack: "Slack",
  email: "Email",
  github: "GitHub",
};

export default function ConnectorStatus({
  provider,
  onSync,
  onDisconnect,
  label,
  onReconnect,
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
      // Reset the Offline badge whenever we observe the connector
      // transition into a non-connected state (i.e. disconnected, or
      // re-authenticating). The renderer keeps `ConnectorStatus`
      // mounted across disconnect/reconnect cycles for `google_drive`
      // (see SourcesPage.tsx) so without this gate the Offline flag
      // from an earlier failed sync would survive the disconnect →
      // OAuth → reconnect flow and re-appear the instant `connected`
      // flips back to true, even though the brand-new OAuth handshake
      // proves the network is healthy. Clearing here closes that
      // window; the next successful `handleSync` will write the badge
      // back if the new connection is itself offline.
      if (!result.connected) {
        setOffline(false);
      }
      setStatus(result);
    } catch {
      setStatus({ provider, connected: false, status: "error" });
      // Same reasoning as above — a status-poll exception means we
      // cannot prove the connector is offline, only that the status
      // probe itself failed (which the renderer will retry every 10s).
      // Holding onto a stale Offline badge from a prior sync would
      // misrepresent the connector's actual state.
      setOffline(false);
    }
  }, [provider]);

  // LW-4: pause the 10s status poll while the window is hidden; resume
  // (and re-sync immediately) on show.
  useSuspendablePolling(pollStatus, 10_000, { immediate: true });

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
        const isOffline = result.status === "offline";
        setOffline(isOffline);
        // Only stamp "Last sync" when the sync actually transferred —
        // surfacing "Last sync: 3:45 PM" alongside the Offline badge
        // (which means *this* attempt failed at the network layer)
        // tells the user the data is fresher than it really is. The
        // last successful timestamp from a *previous* run remains
        // unchanged; the next successful sync overwrites it. See
        if (!isOffline) setLastSyncTime(new Date().toLocaleTimeString());
      }
      onSync?.();
    } catch {
      // a thrown error here is never a network
      // error. Both the unified `api.connectors.sync(provider)` channel
      // and the legacy `api.connectors.syncDrive()` channel are backed
      // by `runConnectorSync` (`handlers.ts:434-474` and `ipc.ts:1339`
      // respectively), which catches every `NetworkError` —
      // `fetch failed`, DNS failures, socket resets, EAI_AGAIN, and so
      // on — and turns it into a `{ status: "offline" }` return value.
      // What still throws is rate-limit exhaustion, `NotConnectedError`,
      // validation errors, and bridge faults: none of those should
      // light up the Offline badge. The previous code re-implemented
      // a weaker regex copy of the main-process `isNetworkError`
      // classifier (`handlers.ts:157-223`) here, creating a drift
      // surface between renderer heuristics and the canonical
      // classifier; deleting it removes that drift risk without
      // weakening the badge, because the offline state already lives
      // entirely on the structured `result.status` field above.
      setOffline(false);
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
    // Clear the Offline badge synchronously on disconnect — the
    // pollStatus below will also clear it once it observes
    // `connected: false`, but the explicit reset here removes the
    // race window between disconnect succeeding and the next status
    // poll completing. Without this, a user who saw "Offline" and
    // chose to Disconnect would see the badge briefly persist after
    // the connector was already gone.
    setOffline(false);
    setLastSyncTime(null);
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
          {onReconnect && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onReconnect}
              aria-label={`Reconnect ${providerLabel}`}
            >
              Reconnect
            </button>
          )}
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
