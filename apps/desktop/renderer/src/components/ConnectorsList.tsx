/**
 * Searchable, categorized connector gallery.
 *
 * Renders the supported connectors (Google Drive, OneDrive, Notion,
 * Jira, Confluence, Figma, HubSpot, Slack, Email/Gmail, GitHub)
 * grouped into categories (Storage, Docs & Wiki, Chat, …) with a
 * search box, per-connector health + last-sync, a one-click
 * reconnect/reauth affordance, and a "what we read / what we never
 * touch" scope-transparency disclosure.
 *
 * Connected providers fall through to the existing `ConnectorStatus`
 * card so the user gets the same Sync Now / Disconnect controls for
 * every provider; disconnected providers show a "Connect" button
 * that opens the shared OAuth credential modal — only the labelled
 * help text differs by provider (e.g. "Microsoft Entra ID" vs
 * "Google Cloud Console").
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ConnectorProbeResult,
  ConnectorScopeComparison,
  ConnectorStatusInfo,
} from "../types/ipc";
import Button from "./Button";
import Card from "./Card";
import Modal from "./Modal";
import SearchInput from "./SearchInput";
import EmptyState from "./EmptyState";
import StatusBadge from "./StatusBadge";
import ConnectorStatus from "./ConnectorStatus";
import {
  CONNECTOR_DESCRIPTORS,
  connectorMatchesQuery,
  groupConnectorsByCategory,
  type ConnectorDescriptor,
} from "./connectorDescriptors";
import {
  getConnectSpec,
  validateConnectorField,
} from "../../../shared/connectorConfig";

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

/**
 * Read-only inspection of the requested-vs-granted OAuth scope diff
 * for a connector, guarded against showcase / partial-mock bridges
 * that don't implement `inspectScopes`. Returns `null` (treated as
 * "no narrowing to report") on any failure so a connector card never
 * crashes the gallery just because scope inspection is unavailable.
 */
async function safeInspectScopes(
  provider: string,
): Promise<ConnectorScopeComparison | null> {
  const api = typeof window !== "undefined" ? window.tessera : undefined;
  if (!api || typeof api.connectors.inspectScopes !== "function") return null;
  try {
    return await api.connectors.inspectScopes(provider);
  } catch {
    return null;
  }
}

/**
 * The "what we read / what we never touch" transparency disclosure.
 * Rendered for every connector (connected or not) so the user can
 * audit the data surface before authorising. Uses a native
 * `<details>`/`<summary>` so it is keyboard-operable for free.
 */
function ScopeTransparency({
  descriptor,
}: {
  descriptor: ConnectorDescriptor;
}) {
  const reads = descriptor.reads ?? [];
  const neverTouches = descriptor.neverTouches ?? [];
  if (reads.length === 0 && neverTouches.length === 0) return null;
  return (
    <details className="connector-scopes">
      <summary aria-label={`Data access for ${descriptor.label}`}>
        What we read / what we never touch
      </summary>
      {reads.length > 0 && (
        <div className="connector-scopes-group">
          <span className="connector-scopes-label">We read</span>
          <ul>
            {reads.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {neverTouches.length > 0 && (
        <div className="connector-scopes-group">
          <span className="connector-scopes-label">We never touch</span>
          <ul>
            {neverTouches.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
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
  const descriptors = useMemo(() => {
    const excluded = new Set(excludeKey ? excludeKey.split("|") : []);
    return CONNECTOR_DESCRIPTORS.filter((d) => !excluded.has(d.provider));
  }, [excludeKey]);
  const [statuses, setStatuses] = useState<Record<string, ConnectorStatusInfo>>(
    {},
  );
  // Per-provider requested-vs-granted scope diff, fetched for
  // connected providers so a "scopes narrowed" banner + Reconnect CTA
  // can surface without the user first attempting a sync.
  const [scopeInfo, setScopeInfo] = useState<
    Record<string, ConnectorScopeComparison>
  >({});
  const [query, setQuery] = useState("");
  const [authOpenFor, setAuthOpenFor] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  // Per-target / non-OAuth2 connector config the user types in the
  // connect modal, keyed by the `auth_config_json` field name (see
  // `shared/connectorConfig.ts`). Empty for whole-account OAuth2
  // providers that declare no extra fields.
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  // Field keys the user has interacted with (changed or blurred), so an
  // inline format error only appears AFTER the user touches a field —
  // never pre-flagging a pristine required field red on modal open.
  const [touchedFields, setTouchedFields] = useState<Record<string, boolean>>(
    {},
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  // Result of the last "Test connection" probe for the open modal, or
  // `null` before the user runs one (or after they edit a field, which
  // invalidates the prior result). `testBusy` gates a second probe and
  // the Connect button while one is in flight.
  const [testResult, setTestResult] = useState<ConnectorProbeResult | null>(
    null,
  );
  const [testBusy, setTestBusy] = useState(false);
  // Authoritative redirect URI map sourced from the OAuth config in
  // the main process. Materialised in one IPC round-trip at mount
  // (and re-fetched if the descriptor set changes) instead of the
  // previous N parallel `getRedirectUri(provider)` calls + hardcoded
  // fallbacks. Until the map resolves, the modal's URI block shows a
  // “Loading…” placeholder — we deliberately do NOT render a guessed
  // value, because the most common reason for that guessed value to
  // be wrong is exactly the case the user is about to act on
  // (registering a redirect URI in the provider's developer console).
  const [redirectUris, setRedirectUris] = useState<Record<
    string,
    string
  > | null>(null);

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

  // Invoked fire-and-forget from the mount effect and from the
  // authenticate/disconnect handlers, so it must never reject: an
  // unhandled rejection would surface as a noisy console error (or a
  // test failure) for no actionable reason. Per-provider IPC failures
  // are already absorbed below; the outer try/catch additionally guards
  // the trailing `setState` calls so every caller can safely ignore the
  // returned promise.
  const pollAll = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    try {
      const nextStatuses: Record<string, ConnectorStatusInfo> = {};
      const nextScopes: Record<string, ConnectorScopeComparison> = {};
      await Promise.all(
        descriptors.map(async (d) => {
          let info: ConnectorStatusInfo;
          try {
            info = await api.connectors.status(d.provider);
          } catch {
            info = {
              provider: d.provider,
              connected: false,
              status: "error",
            };
          }
          nextStatuses[d.provider] = info;
          // Scope inspection is meaningful only for a connected
          // provider (it reads the stored token). Skipping the call
          // for disconnected providers avoids a guaranteed `null`
          // round-trip per poll.
          if (info.connected) {
            const cmp = await safeInspectScopes(d.provider);
            if (cmp) nextScopes[d.provider] = cmp;
          }
        }),
      );
      setStatuses(nextStatuses);
      setScopeInfo(nextScopes);
    } catch {
      // Unexpected failure (e.g. a React state update error). Swallow
      // it rather than reject — there is no recovery action and the
      // next poll/action will retry from a clean slate.
    }
  }, [descriptors]);

  useEffect(() => {
    pollAll();
  }, [pollAll]);

  const descriptor = authOpenFor
    ? descriptors.find((d) => d.provider === authOpenFor)
    : null;
  // Connect spec for the open modal: drives whether we render the OAuth
  // client-credential inputs (oauth2) or only the pasted-credential +
  // per-target fields (token), and which extra inputs to collect.
  const connectSpec = descriptor ? getConnectSpec(descriptor.provider) : null;
  const isTokenMethod = connectSpec?.connectMethod === "token";

  // Per-field inline validation result for the open modal, keyed by
  // field `key`. Recomputed only when the spec or the typed values
  // change. A field shows its `error` once the user has touched it
  // (`touchedFields`) so the modal doesn't flag every required field
  // red before the user has typed anything.
  const fieldErrors = useMemo(() => {
    const errors: Record<string, string | undefined> = {};
    for (const field of connectSpec?.configFields ?? []) {
      const result = validateConnectorField(
        field,
        configValues[field.key] ?? "",
      );
      if (!result.valid) errors[field.key] = result.error;
    }
    return errors;
  }, [connectSpec, configValues]);

  // Whether every required client-credential + per-target field is
  // present AND every declared format rule passes. Drives the Connect
  // and Test-connection buttons' disabled state so the user cannot
  // submit a value we already know the backend will reject.
  const formValid = useMemo(() => {
    if (!connectSpec) return false;
    if (!isTokenMethod) {
      if (!clientId.trim()) return false;
      if (descriptor?.secretRequired && !clientSecret.trim()) return false;
    }
    return Object.keys(fieldErrors).length === 0;
  }, [
    connectSpec,
    isTokenMethod,
    clientId,
    clientSecret,
    descriptor,
    fieldErrors,
  ]);

  const openAuthModal = useCallback((provider: string) => {
    setClientId("");
    setClientSecret("");
    setConfigValues({});
    setTouchedFields({});
    setAuthError(null);
    setTestResult(null);
    setAuthOpenFor(provider);
  }, []);

  // Stable per-provider reconnect handlers so `ConnectorStatus` (a child
  // that polls on its own interval) doesn't see a new callback identity
  // every render. Recomputed only when the descriptor set or the modal
  // opener changes, so the handlers can never close over a stale
  // `openAuthModal`.
  const reconnectHandlers = useMemo(() => {
    const handlers: Record<string, () => void> = {};
    for (const d of descriptors) {
      handlers[d.provider] = () => openAuthModal(d.provider);
    }
    return handlers;
  }, [descriptors, openAuthModal]);

  const handleAuthenticate = async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api || !descriptor) return;
    const spec = getConnectSpec(descriptor.provider);
    const tokenMethod = spec.connectMethod === "token";
    // OAuth2 providers need the client credentials; token-method
    // providers (GitLab, Trello) supply their credential as a config
    // field instead, so the OAuth inputs aren't shown or required.
    if (!tokenMethod) {
      if (!clientId.trim()) {
        setAuthError("Client ID is required");
        return;
      }
      if (descriptor.secretRequired && !clientSecret.trim()) {
        setAuthError("Client Secret is required");
        return;
      }
    }
    // Validate + collect the declared per-target / credential fields.
    const config: Record<string, string> = {};
    for (const field of spec.configFields) {
      const value = (configValues[field.key] ?? "").trim();
      if (!value) {
        if (field.required) {
          setAuthError(`${field.label} is required`);
          return;
        }
        continue;
      }
      config[field.key] = value;
    }
    setAuthBusy(true);
    setAuthError(null);
    try {
      // `config` carries the declared per-target / credential fields and
      // is empty for whole-account OAuth2 providers. The handler's
      // `assertConnectorConfig` treats an empty bag identically to an
      // omitted one, so we always pass it and avoid a 3-arg/4-arg branch.
      const next = await api.connectors.authenticate(
        descriptor.provider,
        tokenMethod ? "" : clientId.trim(),
        tokenMethod ? "" : clientSecret.trim(),
        config,
      );
      setStatuses((prev) => ({ ...prev, [descriptor.provider]: next }));
      // Drop the pre-reconnect scope diff in the same render that marks
      // the provider connected. Otherwise this provider would briefly
      // satisfy `narrowed` (connected + stale `fullyGranted: false`) and
      // flash the "scopes narrowed" banner the user just reconnected to
      // clear, until the un-awaited `pollAll()` below resolves with the
      // fresh diff (which re-adds the entry only if scopes are still
      // genuinely narrowed).
      setScopeInfo((prev) => {
        if (!(descriptor.provider in prev)) return prev;
        const { [descriptor.provider]: _dropped, ...rest } = prev;
        return rest;
      });
      setAuthOpenFor(null);
      setClientId("");
      setClientSecret("");
      setConfigValues({});
      // Re-poll so the freshly-connected provider's scope diff (and
      // any newly-cleared "scopes narrowed" banner) reflects the new
      // token rather than the pre-reconnect state.
      pollAll();
      onChange?.();
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      setAuthBusy(false);
    }
  };

  // Run a read-only connection probe with the entered
  // credentials/target BEFORE connecting. Nothing is persisted: the
  // main process discards the token after the probe, so a failed (or
  // even a successful) test never writes to the keychain — the user
  // still has to click Connect. Surfaces a precise, non-secret reason
  // on failure so the user fixes a wrong project/board id or revoked
  // token here rather than discovering it on the first sync.
  const handleTestConnection = async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api || !descriptor || typeof api.connectors.test !== "function") {
      return;
    }
    const spec = getConnectSpec(descriptor.provider);
    const tokenMethod = spec.connectMethod === "token";
    const config: Record<string, string> = {};
    for (const field of spec.configFields) {
      const value = (configValues[field.key] ?? "").trim();
      if (value) config[field.key] = value;
    }
    setTestBusy(true);
    setTestResult(null);
    setAuthError(null);
    try {
      const result = await api.connectors.test(
        descriptor.provider,
        tokenMethod ? "" : clientId.trim(),
        tokenMethod ? "" : clientSecret.trim(),
        config,
      );
      setTestResult(result);
    } catch (err) {
      // The IPC itself rejected (rate-limit, or an unexpected
      // main-process error). Expected credential/network failures come
      // back as `{ ok: false }`, not a rejection.
      setTestResult({
        provider: descriptor.provider,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestBusy(false);
    }
  };

  // Whether the bridge exposes the `connectors:test` probe. Older
  // native addons (and the showcase/test mocks) may omit it, in which
  // case the modal simply hides the Test-connection button rather than
  // offering an action that would no-op.
  const testSupported =
    typeof window !== "undefined" &&
    typeof window.tessera?.connectors?.test === "function";

  const visibleDescriptors = useMemo(
    () => descriptors.filter((d) => connectorMatchesQuery(d, query)),
    [descriptors, query],
  );
  const groups = useMemo(
    () => groupConnectorsByCategory(visibleDescriptors),
    [visibleDescriptors],
  );

  const renderConnectorCard = (d: ConnectorDescriptor) => {
    const status = statuses[d.provider];
    const connected = status?.connected ?? false;
    const scopes = scopeInfo[d.provider];
    const narrowed = connected && scopes ? !scopes.fullyGranted : false;
    return (
      <Card
        key={d.provider}
        className="connector-card"
        data-testid={`connector-card-${d.provider}`}
      >
        {connected ? (
          <ConnectorStatus
            provider={d.provider}
            label={d.label}
            onSync={onChange}
            onReconnect={reconnectHandlers[d.provider]}
            onDisconnect={() => {
              pollAll();
              onChange?.();
            }}
          />
        ) : (
          <div className="connector-status">
            <div className="connector-status-header">
              <span
                aria-hidden="true"
                className="connector-status-dot"
                style={{ background: "var(--color-muted, #6b7280)" }}
              />
              <span className="connector-status-name">{d.label}</span>
              <span className="connector-status-badge">
                <StatusBadge status="disconnected" />
              </span>
            </div>
            <div className="connector-status-actions">
              <Button
                variant="secondary"
                onClick={() => openAuthModal(d.provider)}
                aria-label={`Connect ${d.label}`}
              >
                Connect
              </Button>
            </div>
          </div>
        )}

        {narrowed && (
          <div className="connector-scope-warning" role="alert">
            <span>
              Some requested permissions weren't granted
              {scopes && scopes.missing.length > 0
                ? ` (${scopes.missing.join(", ")})`
                : ""}
              . Reconnect to restore full access.
            </span>
            <Button
              variant="secondary"
              onClick={() => openAuthModal(d.provider)}
              aria-label={`Reconnect ${d.label} to restore permissions`}
            >
              Reconnect
            </Button>
          </div>
        )}

        <ScopeTransparency descriptor={d} />
      </Card>
    );
  };

  return (
    <div className="connector-gallery" aria-label="Remote connectors">
      <div className="connector-gallery-search">
        <SearchInput
          value={query}
          onSearch={setQuery}
          placeholder="Search connectors…"
          aria-label="Search connectors"
        />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          title="No connectors found"
          message={`No connector matches “${query.trim()}”. Try a different name or clear the search.`}
          action={
            <Button variant="secondary" onClick={() => setQuery("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        groups.map((group) => {
          const headingId = `connector-category-${group.category
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")}`;
          return (
            <section
              key={group.category}
              className="connector-category"
              aria-labelledby={headingId}
            >
              <div className="connector-category-header">
                {/*
                  Connector categories are the top-level sections of the
                  Sources page, sitting directly under its `<h1>`. They
                  are `<h2>` so the heading outline reads h1 → h2 rather
                  than skipping to h3 (the `<section aria-labelledby>`
                  wrapper makes each one a named region for AT users).
                */}
                <h2 id={headingId} className="connector-category-title">
                  {group.category}
                </h2>
                <span className="connector-category-count">
                  {group.descriptors.length}
                </span>
              </div>
              <div className="connector-grid">
                {group.descriptors.map(renderConnectorCard)}
              </div>
            </section>
          );
        })
      )}

      <Modal
        isOpen={authOpenFor !== null}
        onClose={() => {
          setAuthOpenFor(null);
          setAuthError(null);
          setTestResult(null);
        }}
        title={descriptor ? `Connect ${descriptor.label}` : "Connect provider"}
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
            {!isTokenMethod && (
              <>
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
                  onChange={(e) => {
                    setClientId(e.target.value);
                    setTestResult(null);
                  }}
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
                  onChange={(e) => {
                    setClientSecret(e.target.value);
                    setTestResult(null);
                  }}
                  aria-label="OAuth Client Secret"
                />
              </>
            )}
            {(connectSpec?.configFields ?? []).map((field) => {
              const fieldError = touchedFields[field.key]
                ? fieldErrors[field.key]
                : undefined;
              const errorId = `connector-field-error-${field.key}`;
              return (
                <div key={field.key} style={{ marginTop: "var(--spacing-sm)" }}>
                  <input
                    className="input"
                    placeholder={
                      field.placeholder ??
                      (field.required
                        ? field.label
                        : `${field.label} (optional)`)
                    }
                    type={field.secret ? "password" : "text"}
                    value={configValues[field.key] ?? ""}
                    onChange={(e) => {
                      const value = e.target.value;
                      setConfigValues((prev) => ({
                        ...prev,
                        [field.key]: value,
                      }));
                      setTouchedFields((prev) => ({
                        ...prev,
                        [field.key]: true,
                      }));
                      // The typed value diverged from whatever was last
                      // probed, so the stale result no longer applies.
                      setTestResult(null);
                    }}
                    onBlur={() =>
                      setTouchedFields((prev) => ({
                        ...prev,
                        [field.key]: true,
                      }))
                    }
                    aria-label={field.label}
                    aria-invalid={fieldError ? true : undefined}
                    aria-describedby={fieldError ? errorId : undefined}
                  />
                  {fieldError ? (
                    <p
                      id={errorId}
                      role="alert"
                      style={{
                        marginTop: "calc(var(--spacing-xs, 4px))",
                        fontSize: "var(--font-size-xs, 0.75rem)",
                        color: "var(--color-danger, #ef4444)",
                      }}
                    >
                      {fieldError}
                    </p>
                  ) : (
                    field.help && (
                      <p
                        style={{
                          marginTop: "calc(var(--spacing-xs, 4px))",
                          fontSize: "var(--font-size-xs, 0.75rem)",
                          color: "var(--color-muted, #6b7280)",
                        }}
                      >
                        {field.help}
                      </p>
                    )
                  )}
                </div>
              );
            })}
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
            {testResult && (
              <p
                style={{
                  color: testResult.ok
                    ? "var(--color-success, #16a34a)"
                    : "var(--color-danger, #ef4444)",
                  fontSize: "var(--font-size-sm)",
                  marginTop: "var(--spacing-sm)",
                }}
                role="status"
                data-testid="connector-test-result"
              >
                {testResult.ok
                  ? "Connection succeeded — these credentials can reach the provider."
                  : (testResult.message ??
                    "Connection failed. Check the credentials and target, then try again.")}
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
                    setTestResult(null);
                  }}
                >
                  Cancel
                </Button>
                {testSupported && (
                  <Button
                    variant="secondary"
                    onClick={handleTestConnection}
                    disabled={authBusy || testBusy || !formValid}
                  >
                    {testBusy ? "Testing…" : "Test connection"}
                  </Button>
                )}
                <Button
                  onClick={handleAuthenticate}
                  disabled={authBusy || testBusy || !formValid}
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
