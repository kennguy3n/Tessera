/**
 * KChat connection card shown in the Settings page.
 *
 * Phase 14. Tessera and KChat Desktop are independent KChat
 * clients; this card is the single place a user pastes a KChat
 * Personal Access Token (PAT). When the Tessera `.kcz` extension
 * installed in KChat Desktop is also reachable (i.e. KChat
 * Desktop is running on the same machine AND has the extension
 * installed), an additional "enhanced integration" affordance is
 * shown — but it never replaces the PAT flow; both apps still
 * authenticate to the KChat server independently.
 *
 * Detection mechanism: Tessera's main process owns a localhost
 * HTTP server (see `kchatLocalApi.ts`). Whenever the extension
 * makes an authenticated call into that server, Tessera records
 * a heartbeat (`lastExtensionContactAt`). The Settings card
 * polls `kchat.desktopBridgeStatus()` and renders the affordance
 * when the heartbeat is fresh. This is purely passive — Tessera
 * does NOT probe KChat Desktop over any external IPC.
 *
 *   * Disconnected: shows server URL + token inputs and a
 *     `Connect` button.
 *   * Connected: shows the connected user, server URL,
 *     `Disconnect` button, and a default-team selector.
 *   * Error: shows the error message inline.
 *   * Enhanced detected: renders an informational pill plus a
 *     "Open KChat Desktop extensions" button that invokes the
 *     `kchat://app/settings/extensions` deeplink.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import { useToast } from "./Toast";
import type {
  KchatConnectionStateView,
  KchatDesktopBridgeStatusView,
  KchatTeamView,
} from "../../../shared/types";

const DEFAULT_SERVER = "https://kchat.com";
const TEAM_LS_KEY = "tessera.kchat.defaultTeamId";

/**
 * A heartbeat older than this is treated as "extension no longer
 * connected" — the .kcz extension is expected to make at least
 * one status call per minute when it's loaded inside a running
 * KChat Desktop.
 */
const EXTENSION_HEARTBEAT_STALE_MS = 90_000;

/** Cadence at which the renderer re-reads the bridge status. */
const BRIDGE_STATUS_POLL_MS = 10_000;

interface KchatSettingsCardProps {
  /** Optional override for `window.tessera.kchat` (used by tests). */
  api?: typeof window.tessera.kchat;
}

export function getStoredDefaultTeamId(): string | null {
  try {
    return window.localStorage.getItem(TEAM_LS_KEY);
  } catch {
    return null;
  }
}

export function setStoredDefaultTeamId(id: string | null): void {
  try {
    if (id === null) {
      window.localStorage.removeItem(TEAM_LS_KEY);
    } else {
      window.localStorage.setItem(TEAM_LS_KEY, id);
    }
  } catch {
    /* localStorage disabled — silently no-op; the renderer can
     * still operate, the next session just loses the default. */
  }
}

/**
 * Treat the bridge status as "extension-detected" only when the
 * local API server is up AND the extension has been heard from
 * recently. Local API server up alone isn't sufficient: a
 * running Tessera with no .kcz installed in KChat Desktop also
 * exposes the server but the heartbeat never arrives.
 */
export function isExtensionDetected(
  status: KchatDesktopBridgeStatusView | null,
  nowMs: number,
): boolean {
  if (status === null) return false;
  if (!status.apiServerRunning) return false;
  if (status.lastExtensionContactAt === null) return false;
  const heartbeatMs = Date.parse(status.lastExtensionContactAt);
  if (Number.isNaN(heartbeatMs)) return false;
  return nowMs - heartbeatMs < EXTENSION_HEARTBEAT_STALE_MS;
}

export default function KchatSettingsCard({ api }: KchatSettingsCardProps = {}) {
  const kchat = api ?? window.tessera?.kchat;
  const toast = useToast();
  const serverId = useId();
  const tokenId = useId();
  const teamId = useId();

  const [available, setAvailable] = useState<boolean | null>(null);
  const [state, setState] = useState<KchatConnectionStateView>({
    state: "disconnected",
  });
  const [serverUrl, setServerUrl] = useState<string>(DEFAULT_SERVER);
  const [token, setToken] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [teams, setTeams] = useState<KchatTeamView[]>([]);
  const [defaultTeamId, setDefaultTeamId] = useState<string | null>(
    getStoredDefaultTeamId(),
  );
  const [bridgeStatus, setBridgeStatus] =
    useState<KchatDesktopBridgeStatusView | null>(null);
  // `now` ticks on the bridge poll cadence so the `isExtensionDetected`
  // staleness check rerenders without a separate clock. Initialised
  // to `Date.now()` so the first render after mount evaluates
  // freshness against the actual mount time, not against `0`.
  const [now, setNow] = useState<number>(() => Date.now());

  // Feature gate + initial status sync.
  useEffect(() => {
    if (!kchat) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const ok = await kchat.isAvailable();
        if (!cancelled) setAvailable(ok);
        if (!ok) return;
        const s = await kchat.status();
        if (cancelled) return;
        setState(s);
        if (s.serverUrl) setServerUrl(s.serverUrl);
      } catch {
        if (!cancelled) setAvailable(false);
      }
    })();

    const unsubscribe = kchat.onStatusChange((s) => {
      if (cancelled) return;
      setState(s);
      if (s.serverUrl) setServerUrl(s.serverUrl);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [kchat]);

  // Poll the bridge-status snapshot so the "KChat Desktop detected"
  // affordance picks up a desktop-app launch / extension install
  // without a Settings remount. The poll is cheap (a single IPC
  // round-trip into the main process); the interval is generous
  // (10 s) to keep idle CPU near zero.
  useEffect(() => {
    if (!kchat) return;
    let cancelled = false;
    const pull = async () => {
      try {
        const next = await kchat.desktopBridgeStatus();
        if (!cancelled) {
          setBridgeStatus(next);
          setNow(Date.now());
        }
      } catch {
        if (!cancelled) {
          // Treat a probe failure as "no extension detected"
          // without surfacing a toast — the user has no
          // remediation for an IPC channel failure.
          setBridgeStatus(null);
          setNow(Date.now());
        }
      }
    };
    void pull();
    const handle = window.setInterval(pull, BRIDGE_STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [kchat]);

  // Once connected, hydrate the team list so the default-team
  // selector can render.
  useEffect(() => {
    if (!kchat || state.state !== "connected") {
      setTeams([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await kchat.listTeams();
        if (cancelled) return;
        setTeams(list);
        if (!getStoredDefaultTeamId() && list[0]) {
          setStoredDefaultTeamId(list[0].id);
          setDefaultTeamId(list[0].id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast.addToast(`KChat: failed to list teams (${msg})`, "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kchat, state.state, toast]);

  const handleConnect = useCallback(async () => {
    if (!kchat) return;
    if (!token.trim()) {
      toast.addToast("Enter a KChat personal access token", "error");
      return;
    }
    if (!/^https?:\/\//i.test(serverUrl.trim())) {
      toast.addToast(
        "Server URL must start with http:// or https://",
        "error",
      );
      return;
    }
    setBusy(true);
    try {
      const user = await kchat.connect(token.trim(), serverUrl.trim());
      setToken(""); // never keep the token in component state
      const s = await kchat.status();
      setState(s);
      toast.addToast(`Connected to KChat as ${user.username}`, "success");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        const s = await kchat.status();
        setState(s);
      } catch {
        /* ignore secondary failure */
      }
      toast.addToast(`KChat connect failed: ${msg}`, "error");
    } finally {
      setBusy(false);
    }
  }, [kchat, token, serverUrl, toast]);

  const handleDisconnect = useCallback(async () => {
    if (!kchat) return;
    setBusy(true);
    try {
      await kchat.disconnect();
      setState({ state: "disconnected" });
      setTeams([]);
      setStoredDefaultTeamId(null);
      setDefaultTeamId(null);
      toast.addToast("Disconnected from KChat", "info");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.addToast(`KChat disconnect failed: ${msg}`, "error");
    } finally {
      setBusy(false);
    }
  }, [kchat, toast]);

  const handleOpenExtensionSettings = useCallback(async () => {
    // The `kchat://app/settings/extensions` deeplink is routed by
    // the OS to whichever binary owns the `kchat://` scheme —
    // KChat Desktop when it's installed. The IPC handler is a
    // typed enum (no free-form URLs cross the boundary) so the
    // renderer cannot smuggle arbitrary deeplinks into
    // `shell.openExternal`.
    if (!kchat) return;
    try {
      await kchat.openDesktopExtensions();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.addToast(
        `Failed to open KChat Desktop extension settings: ${msg}`,
        "error",
      );
    }
  }, [kchat, toast]);

  const handleTeamChange = useCallback((id: string) => {
    setStoredDefaultTeamId(id || null);
    setDefaultTeamId(id || null);
  }, []);

  const connectedLabel = useMemo(() => {
    if (state.state !== "connected" || !state.user) return null;
    const fullName = `${state.user.firstName ?? ""} ${state.user.lastName ?? ""}`.trim();
    return fullName
      ? `${fullName} (@${state.user.username})`
      : `@${state.user.username}`;
  }, [state]);

  const extensionDetected = useMemo(
    () => isExtensionDetected(bridgeStatus, now),
    [bridgeStatus, now],
  );

  if (available === null) return null;
  if (available === false) return null;

  return (
    <Card data-testid="kchat-settings-card">
      <h3 style={{ marginBottom: "var(--spacing-md)" }}>KChat</h3>
      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        Connect to KChat (Mattermost-compatible) to share artifacts to
        channels, index channel files as sources, and collaborate
        with channel members in real time. The personal access token
        is stored in the OS keychain and never leaves the main
        process.
      </p>

      {extensionDetected && (
        <div
          data-testid="kchat-desktop-detected"
          style={{
            marginBottom: "var(--spacing-md)",
            padding: "var(--spacing-sm) var(--spacing-md)",
            border: "1px solid var(--color-success, #2c8a3d)",
            borderRadius: "var(--border-radius-md)",
            background:
              "var(--color-success-subtle, rgba(44,138,61,0.08))",
          }}
        >
          <p
            style={{
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-headline)",
              marginBottom: "var(--spacing-xs)",
              fontWeight: "var(--font-weight-medium)" as unknown as number,
            }}
          >
            KChat Desktop is running — enhanced integration active
          </p>
          <p
            style={{
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-secondary)",
              marginBottom: "var(--spacing-sm)",
            }}
          >
            The Tessera extension installed in KChat Desktop can open
            sources, share artifacts, and trigger channel ingestion
            without leaving the chat client. Both apps still
            authenticate to the KChat server with their own
            credentials.
          </p>
          <button
            type="button"
            onClick={handleOpenExtensionSettings}
            data-testid="kchat-open-desktop-extensions"
            style={{
              background: "none",
              border: "none",
              color: "var(--color-text-link, #06f)",
              cursor: "pointer",
              fontSize: "var(--font-size-sm)",
              textDecoration: "underline",
              padding: 0,
            }}
          >
            Open KChat Desktop extensions
          </button>
        </div>
      )}

      <div style={{ marginBottom: "var(--spacing-md)" }}>
        <label
          htmlFor={serverId}
          style={{
            display: "block",
            fontSize: "var(--font-size-sm)",
            fontWeight: "var(--font-weight-medium)" as unknown as number,
            marginBottom: "var(--spacing-xs)",
            color: "var(--color-text-headline)",
          }}
        >
          Server URL
        </label>
        <input
          id={serverId}
          className="input"
          type="url"
          autoComplete="off"
          spellCheck={false}
          value={serverUrl}
          disabled={busy || state.state === "connected"}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder={DEFAULT_SERVER}
        />
      </div>

      {state.state !== "connected" && (
        <div style={{ marginBottom: "var(--spacing-md)" }}>
          <label
            htmlFor={tokenId}
            style={{
              display: "block",
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)" as unknown as number,
              marginBottom: "var(--spacing-xs)",
              color: "var(--color-text-headline)",
            }}
          >
            Personal access token
          </label>
          <input
            id={tokenId}
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            disabled={busy}
            onChange={(e) => setToken(e.target.value)}
            placeholder="generated in KChat → Account Settings → Security"
          />
        </div>
      )}

      <div
        style={{
          display: "flex",
          gap: "var(--spacing-sm)",
          alignItems: "center",
        }}
      >
        {state.state === "connected" ? (
          <>
            <Button
              onClick={handleDisconnect}
              disabled={busy}
              data-testid="kchat-disconnect"
            >
              {busy ? "Disconnecting…" : "Disconnect"}
            </Button>
            <span
              style={{
                fontSize: "var(--font-size-sm)",
                color: "var(--color-text-secondary)",
              }}
              data-testid="kchat-connected-user"
            >
              Connected as <strong>{connectedLabel}</strong>
            </span>
          </>
        ) : (
          <Button
            onClick={handleConnect}
            disabled={busy}
            data-testid="kchat-connect"
          >
            {busy ? "Connecting…" : "Connect"}
          </Button>
        )}
      </div>

      {state.state === "error" && state.error && (
        <p
          role="alert"
          style={{
            marginTop: "var(--spacing-sm)",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-error, #c00)",
          }}
          data-testid="kchat-error"
        >
          {state.error}
        </p>
      )}

      {state.state === "connected" && teams.length > 0 && (
        <div style={{ marginTop: "var(--spacing-lg)" }}>
          <label
            htmlFor={teamId}
            style={{
              display: "block",
              fontSize: "var(--font-size-sm)",
              fontWeight: "var(--font-weight-medium)" as unknown as number,
              marginBottom: "var(--spacing-xs)",
              color: "var(--color-text-headline)",
            }}
          >
            Default team
          </label>
          <select
            id={teamId}
            className="input"
            value={defaultTeamId ?? ""}
            onChange={(e) => handleTeamChange(e.target.value)}
            data-testid="kchat-default-team"
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.display_name || t.name}
              </option>
            ))}
          </select>
        </div>
      )}
    </Card>
  );
}
