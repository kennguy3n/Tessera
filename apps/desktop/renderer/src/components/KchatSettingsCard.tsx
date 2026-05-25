/**
 * KChat connection card shown in the Settings page.
 *
 * - Hidden entirely when `window.tessera.kchat.isAvailable()`
 *   returns false (feature gate — defaults to true today, future
 *   licence/enterprise gating can flip it).
 * - When disconnected: shows server URL + personal-access-token
 *   inputs and a `Connect` button.
 * - When connected: shows the connected user, server URL,
 *   `Disconnect` button, and a default-team selector populated from
 *   `kchat:listTeams`. The selected default-team id is persisted in
 *   localStorage so KChat-aware UI elsewhere (sidebar, share modal)
 *   can default to the same team without an extra IPC.
 * - On error: shows the error message inline.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import { useToast } from "./Toast";
import type {
  KchatConnectionStateView,
  KchatTeamView,
} from "../../../shared/types";

const DEFAULT_SERVER = "https://kchat.com";
const TEAM_LS_KEY = "tessera.kchat.defaultTeamId";

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
      } catch (err) {
        if (!cancelled) {
          setAvailable(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kchat]);

  // Once connected, hydrate the team list so the default-team
  // selector can render. Re-run when the connection state flips to
  // `connected` (disconnect → reconnect path).
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
        // If no default is stored, pick the first team so KChat UI
        // elsewhere has somewhere to land.
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
      // The connection might have transitioned to `error` server-
      // side; refresh state so the inline error renders.
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

  const handleTeamChange = useCallback((id: string) => {
    setStoredDefaultTeamId(id || null);
    setDefaultTeamId(id || null);
  }, []);

  const connectedLabel = useMemo(() => {
    if (state.state !== "connected" || !state.user) return null;
    const fullName = `${state.user.firstName ?? ""} ${state.user.lastName ?? ""}`.trim();
    return fullName ? `${fullName} (@${state.user.username})` : `@${state.user.username}`;
  }, [state]);

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

      <div style={{ display: "flex", gap: "var(--spacing-sm)", alignItems: "center" }}>
        {state.state === "connected" ? (
          <>
            <Button onClick={handleDisconnect} disabled={busy} data-testid="kchat-disconnect">
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
          <Button onClick={handleConnect} disabled={busy} data-testid="kchat-connect">
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
