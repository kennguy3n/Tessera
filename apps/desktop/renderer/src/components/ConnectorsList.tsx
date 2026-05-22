/**
 * Phase 10 — multi-provider connector list.
 *
 * Renders one row per supported connector (Google Drive, OneDrive,
 * Notion, Jira, Confluence, Figma) with an inline "Connect" button
 * for disconnected providers, falling through to the existing
 * `ConnectorStatus` card when connected so the user gets the same
 * Sync Now / Disconnect controls for every provider.
 *
 * The OAuth client_id / client_secret entry modal is shared across
 * all six providers — only the labelled help text differs by
 * provider (e.g. "Microsoft Entra ID" vs "Google Cloud Console").
 */
import { useCallback, useEffect, useState } from "react";
import type { ConnectorStatusInfo } from "../types/ipc";
import Button from "./Button";
import Modal from "./Modal";
import ConnectorStatus from "./ConnectorStatus";

export interface ConnectorDescriptor {
  provider: string;
  label: string;
  /** Where the user creates an OAuth app + redirect URI to copy in. */
  consoleUrl: string;
  /** Help text shown in the connect modal. */
  help: string;
  /**
   * Fallback loopback redirect URI shown before the live value is
   * resolved from the main process. The authoritative value comes
   * from `connectors.getRedirectUri()` so the UI cannot drift from
   * the actual OAuth config — this is just the initial render value
   * for the case where the IPC has not yet responded.
   */
  redirectUri: string;
  /** Some providers (Notion) accept no secret in the public model. */
  secretRequired?: boolean;
}

export const CONNECTOR_DESCRIPTORS: ConnectorDescriptor[] = [
  {
    provider: "google_drive",
    label: "Google Drive",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console and add the redirect URI below.",
    // Google Drive is pinned to `localhost` (not `127.0.0.1`) for
    // backward compatibility with the redirect URI users have already
    // registered in pre-Phase-10 installs. See
    // `electron/ipc/connectors/providerOAuth.ts > google_drive`.
    redirectUri: "http://localhost:9876/callback",
    secretRequired: true,
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    consoleUrl: "https://entra.microsoft.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    help: "Register an app in Microsoft Entra ID with the redirect URI below and request Files.Read.All + offline_access.",
    redirectUri: "http://127.0.0.1:9877/callback",
    secretRequired: true,
  },
  {
    provider: "notion",
    label: "Notion",
    consoleUrl: "https://www.notion.so/my-integrations",
    help: "Create a Public integration in Notion and add the redirect URI below.",
    redirectUri: "http://127.0.0.1:9878/callback",
    secretRequired: true,
  },
  {
    provider: "jira",
    label: "Jira (Atlassian)",
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:jira-work + offline_access scopes and add the redirect URI below.",
    redirectUri: "http://127.0.0.1:9879/callback",
    secretRequired: true,
  },
  {
    provider: "confluence",
    label: "Confluence (Atlassian)",
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:confluence-content.* + offline_access scopes and add the redirect URI below.",
    redirectUri: "http://127.0.0.1:9880/callback",
    secretRequired: true,
  },
  {
    provider: "figma",
    label: "Figma",
    consoleUrl: "https://www.figma.com/developers/apps",
    help: "Create a Figma OAuth app, request files:read, and add the redirect URI below.",
    redirectUri: "http://127.0.0.1:9881/callback",
    secretRequired: true,
  },
];

interface ConnectorsListProps {
  onChange?: () => void;
}

export default function ConnectorsList({ onChange }: ConnectorsListProps) {
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatusInfo>>(
    {},
  );
  const [authOpenFor, setAuthOpenFor] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // Live redirect URIs sourced from the OAuth config in the main
  // process. The static `redirectUri` on each descriptor is only used
  // as the initial render value before this resolves.
  const [liveRedirectUris, setLiveRedirectUris] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      await Promise.all(
        CONNECTOR_DESCRIPTORS.map(async (d) => {
          try {
            next[d.provider] = await api.connectors.getRedirectUri(d.provider);
          } catch {
            // Fall back to the descriptor's static value on error so
            // the modal still renders a URI; the OAuth flow itself
            // sources from the same config so connecting will fail
            // loudly with a real error rather than silently mis-
            // instructing the user.
            next[d.provider] = d.redirectUri;
          }
        }),
      );
      if (!cancelled) setLiveRedirectUris(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const pollAll = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    const next: Record<string, ConnectorStatusInfo> = {};
    await Promise.all(
      CONNECTOR_DESCRIPTORS.map(async (d) => {
        try {
          next[d.provider] = await api.connectors.status(d.provider);
        } catch {
          next[d.provider] = {
            provider: d.provider,
            connected: false,
            status: "error",
          };
        }
      }),
    );
    setStatuses(next);
  }, []);

  useEffect(() => {
    pollAll();
  }, [pollAll]);

  const descriptor = authOpenFor
    ? CONNECTOR_DESCRIPTORS.find((d) => d.provider === authOpenFor)
    : null;

  const handleAuthenticate = async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api || !descriptor) return;
    if (!clientId.trim()) {
      setAuthError("Client ID is required");
      return;
    }
    if (descriptor.secretRequired && !clientSecret.trim()) {
      setAuthError("Client Secret is required");
      return;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      const next = await api.connectors.authenticate(
        descriptor.provider,
        clientId.trim(),
        clientSecret.trim(),
      );
      setStatuses((prev) => ({ ...prev, [descriptor.provider]: next }));
      setAuthOpenFor(null);
      setClientId("");
      setClientSecret("");
      onChange?.();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  return (
    <div
      className="connectors-list"
      style={{ display: "grid", gap: "var(--spacing-sm)" }}
      aria-label="Remote connectors"
    >
      {CONNECTOR_DESCRIPTORS.map((d) => {
        const status = statuses[d.provider];
        const connected = status?.connected ?? false;
        if (connected) {
          return (
            <ConnectorStatus
              key={d.provider}
              provider={d.provider}
              label={d.label}
              onSync={onChange}
              onDisconnect={() => {
                pollAll();
                onChange?.();
              }}
            />
          );
        }
        return (
          <div
            key={d.provider}
            className="connector-status"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--spacing-sm) var(--spacing-md)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-sm)",
              }}
            >
              <span
                aria-hidden="true"
                className="connector-status-dot"
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "var(--color-muted, #6b7280)",
                  display: "inline-block",
                }}
              />
              <span className="connector-status-name">{d.label}</span>
              <span className="connector-status-badge" role="status">
                Disconnected
              </span>
            </div>
            <Button
              variant="secondary"
              onClick={() => {
                setClientId("");
                setClientSecret("");
                setAuthError(null);
                setAuthOpenFor(d.provider);
              }}
              aria-label={`Connect ${d.label}`}
            >
              Connect
            </Button>
          </div>
        );
      })}

      <Modal
        isOpen={authOpenFor !== null}
        onClose={() => {
          setAuthOpenFor(null);
          setAuthError(null);
        }}
        title={
          descriptor ? `Connect ${descriptor.label}` : "Connect provider"
        }
      >
        {descriptor && (
          <>
            <p
              style={{
                marginBottom: "var(--spacing-md)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              {descriptor.help}
            </p>
            <p
              style={{
                marginBottom: "var(--spacing-md)",
                fontSize: "var(--font-size-sm)",
                fontFamily: "var(--font-mono, monospace)",
                wordBreak: "break-all",
              }}
            >
              Redirect URI:{" "}
              <code>
                {liveRedirectUris[descriptor.provider] ?? descriptor.redirectUri}
              </code>
            </p>
            <input
              className="input"
              placeholder="Client ID"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              aria-label="OAuth Client ID"
              style={{ marginBottom: "var(--spacing-sm)" }}
            />
            <input
              className="input"
              placeholder={
                descriptor.secretRequired
                  ? "Client Secret"
                  : "Client Secret (optional)"
              }
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              aria-label="OAuth Client Secret"
            />
            {authError && (
              <p
                style={{
                  color: "var(--color-danger, #ef4444)",
                  fontSize: "var(--font-size-sm)",
                  marginTop: "var(--spacing-sm)",
                }}
                role="alert"
              >
                {authError}
              </p>
            )}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: "var(--spacing-sm)",
                marginTop: "var(--spacing-md)",
              }}
            >
              <a
                href={descriptor.consoleUrl}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  fontSize: "var(--font-size-sm)",
                  color: "var(--color-primary, #6366f1)",
                }}
              >
                Open {descriptor.label} developer console
              </a>
              <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setAuthOpenFor(null);
                    setAuthError(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={handleAuthenticate}
                  disabled={
                    authBusy ||
                    !clientId.trim() ||
                    (descriptor.secretRequired && !clientSecret.trim())
                  }
                >
                  {authBusy ? "Authenticating…" : "Authenticate"}
                </Button>
              </div>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
