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
import { useCallback, useEffect, useMemo, useState } from "react";
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
  /** Some providers (Notion) accept no secret in the public model. */
  secretRequired?: boolean;
}

/**
 * Connector metadata used by the renderer. The redirect URI is
 * intentionally NOT stored here — it is fetched from the main
 * process at mount time via `api.connectors.getAllRedirectUris()`
 * so that `providerOAuth.ts > PROVIDER_OAUTH_CONFIGS` remains the
 * single source of truth. Hardcoded fallbacks were removed in wave 20
 * because they introduced a drift surface: a port-number change in
 * the OAuth config would silently work in the OAuth flow but show
 * a stale URI in the modal, leaving the user with
 * `redirect_uri_mismatch` errors that took several support cycles to
 * diagnose. See Devin Review wave 20 ANALYSIS: "ConnectorsList
 * hardcodes fallback redirectUri values that must sync with
 * providerOAuth.ts config".
 */
export const CONNECTOR_DESCRIPTORS: ConnectorDescriptor[] = [
  {
    provider: "google_drive",
    label: "Google Drive",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    consoleUrl: "https://entra.microsoft.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    help: "Register an app in Microsoft Entra ID with the redirect URI below and request Files.Read.All + offline_access.",
    secretRequired: true,
  },
  {
    provider: "notion",
    label: "Notion",
    consoleUrl: "https://www.notion.so/my-integrations",
    help: "Create a Public integration in Notion and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "jira",
    label: "Jira (Atlassian)",
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:jira-work + offline_access scopes and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "confluence",
    label: "Confluence (Atlassian)",
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:confluence-content.* + offline_access scopes and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "figma",
    label: "Figma",
    consoleUrl: "https://www.figma.com/developers/apps",
    help: "Create a Figma OAuth app, request files:read, and add the redirect URI below.",
    secretRequired: true,
  },
];

interface ConnectorsListProps {
  onChange?: () => void;
  /**
   * Provider ids to omit from the list. The `SourcesPage` keeps a
   * dedicated `ConnectorStatus` card for Google Drive (because its
   * file-picker flow lives on that page) so it passes
   * `excludeProviders={["google_drive"]}` here to avoid rendering
   * the Drive card twice.
   */
  excludeProviders?: ReadonlyArray<string>;
}

export default function ConnectorsList({
  onChange,
  excludeProviders,
}: ConnectorsListProps) {
  // Stable identity for the exclude set: callers usually pass a
  // literal `["google_drive"]` which is a new array every render.
  // Memoising on a sorted-joined string lets us deduplicate cheaply
  // without forcing parent components to also memo.
  const excludeKey = (excludeProviders ?? []).slice().sort().join("|");
  const descriptors = useMemo(
    () => {
      const excluded = new Set(excludeKey ? excludeKey.split("|") : []);
      return CONNECTOR_DESCRIPTORS.filter((d) => !excluded.has(d.provider));
    },
    [excludeKey],
  );
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatusInfo>>(
    {},
  );
  const [authOpenFor, setAuthOpenFor] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // Authoritative redirect URI map sourced from the OAuth config in
  // the main process. Materialised in one IPC round-trip at mount
  // (and re-fetched if the descriptor set changes) instead of the
  // previous N parallel `getRedirectUri(provider)` calls + hardcoded
  // fallbacks. Until the map resolves, the modal's URI block shows a
  // “Loading…” placeholder — we deliberately do NOT render a guessed
  // value, because the most common reason for that guessed value to
  // be wrong is exactly the case the user is about to act on
  // (registering a redirect URI in the provider's developer console).
  // See Devin Review wave 20 ANALYSIS.
  const [redirectUris, setRedirectUris] = useState<
    Record<string, string> | null
  >(null);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    let cancelled = false;
    (async () => {
      try {
        const next = await api.connectors.getAllRedirectUris();
        if (!cancelled) setRedirectUris(next);
      } catch {
        // Leave the URI block as “Loading…”. The OAuth flow itself
        // sources from the same config, so an actual connect attempt
        // will fail loudly with a real error instead of the modal
        // silently mis-instructing the user.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [descriptors]);

  const pollAll = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    const next: Record<string, ConnectorStatusInfo> = {};
    await Promise.all(
      descriptors.map(async (d) => {
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
  }, [descriptors]);

  useEffect(() => {
    pollAll();
  }, [pollAll]);

  const descriptor = authOpenFor
    ? descriptors.find((d) => d.provider === authOpenFor)
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
      {descriptors.map((d) => {
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
                {redirectUris?.[descriptor.provider] ?? "Loading…"}
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
