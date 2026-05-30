/**
 * Unified connector IPC handlers for all six providers.
 *
 * Replaces the hard-coded `if (provider !== 'google_drive')` path in
 * the legacy `ipc.ts` with a single dispatch table keyed by provider
 * id. Each provider has:
 *
 *   - An OAuth config in `providerOAuth.PROVIDER_OAUTH_CONFIGS`.
 *   - A `sync(ctx)` function that pulls items into the local index.
 *   - A `disconnect(ctx)` function that removes the local cache +
 *     unhooks every source the connector created.
 *
 * `connectors:authenticate` runs the OAuth flow + persists tokens.
 * `connectors:sync`         dispatches to the per-provider sync impl.
 * `connectors:disconnect`   revokes the tokens, deletes the cache,
 *                            and removes the matching sources from
 *                            the index.
 * `connectors:status`       reports `{ connected, status, offline }`
 *                            so the UI can render the Offline badge.
 *
 * Additional guarantees layered on top of the dispatch table:
 *
 *   - Rate-limit `connectors:authenticate` to 1 / 5s per provider.
 *   - Rate-limit `connectors:sync` to 1 / 30s per provider.
 *   - Validate provider id against the registry on every call.
 *   - Surface a normalised "offline" status when fetch throws an
 *     EAI_AGAIN/ENOTFOUND/ETIMEDOUT.
 *   - All disconnect paths now run per-provider cleanup (not the
 *     gdrive-only path that left orphan local files for everyone
 *     else).
 */

import { idempotentHandle } from "../register";

import type { IpcContext } from "../context";
import { assertProvider, assertString } from "../validate";
import { RateLimitError } from "../rateLimiter";
import {
  applyFailureToState,
  emptySyncFailureState,
  loadSyncFailureState,
  saveSyncFailureState,
  clearSyncFailureState,
  type FailureKind,
  type SyncFailureState,
} from "../../connectorBackoff";
import {
  exchangeAuthorizationCode,
  generatePkcePair,
  getProviderOAuthConfig,
  getRedirectUri,
  getRedirectUriMap,
  refreshProviderToken,
  revokeProviderToken,
  runRedirectServer,
  type ProviderId,
} from "./providerOAuth";
import { disconnectOneDrive, syncOneDrive } from "./onedrive";
import { disconnectNotion, syncNotion } from "./notion";
import { disconnectJira, syncJira } from "./jira";
import { disconnectConfluence, syncConfluence } from "./confluence";
import { disconnectFigma, syncFigma } from "./figma";
import { syncGoogleDrive, disconnectGoogleDrive } from "./gdrive";

export interface ConnectorStatusInfo {
  provider: string;
  connected: boolean;
  status: string;
  /** True if the last operation hit a network failure. */
  offline?: boolean;
}

interface BridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

function bridgeHooks(ctx: IpcContext): BridgeHooks {
  return {
    addLocalFile: (p) => {
      const source = ctx.requireBridge().bridgeAddLocalFile(p);
      return { id: source.id, path: source.path };
    },
    reindexSource: (id) => {
      ctx.requireBridge().bridgeReindexSource(id);
    },
    removeSource: (id) => {
      ctx.requireBridge().bridgeRemoveSource(id);
    },
    listSources: () =>
      ctx.requireBridge().bridgeListSources().map((s) => ({ id: s.id, path: s.path })),
  };
}

/**
 * Best-effort audit helper used by every `connectors:*` handler.
 *
 * The audit pass-throughs on the bridge (`bridgeLogConnector*`) are
 * defined as no-throw on the Rust side — they swallow audit-store
 * write failures and return `Ok(())`. We still wrap each call in a
 * `try ... catch` here for two independent defence-in-depth
 * reasons:
 *
 *   1. The bridge itself may not be initialised yet — the Block-C
 *      boot sequence orders `registerIpcHandlers()` BEFORE
 *      `initAppState()`, so an audit call from `connectors:status`
 *      that fires during the brief window after IPC registration
 *      but before bridge init would throw "Native bridge not
 *      available" out of `ctx.requireBridge()`.
 *   2. An audit failure must never block the user-visible action.
 *      The connector flow has already committed at the point we
 *      log; rolling back would lose the user's work.
 *
 * The handler logs the audit failure via `ctx.log.warn` so an
 * operator can diagnose a chronically-failing audit pipeline
 * without it manifesting as a user-facing error.
 */
function safeAudit(ctx: IpcContext, fn: (b: ReturnType<IpcContext["requireBridge"]>) => void): void {
  try {
    fn(ctx.requireBridge());
  } catch (err) {
    ctx.log.warn("audit log failed (continuing)", {
      error: (err as Error).message,
    });
  }
}

/**
 * Phase 15 Task 11: maps a `ProviderId` (the OAuth-layer label
 * used in this file) to the `sourceType` string the bridge
 * surfaces on each `SourceInfo` row (mirror of Rust
 * `SourceType` enum serialised as snake_case).
 *
 * Every `ProviderId` MUST have a `sourceType` entry: a missing
 * entry would silently skip failure-state updates for that
 * provider, which is exactly the class of bug Task 11 exists to
 * prevent.
 */
const PROVIDER_TO_SOURCE_TYPE: Record<ProviderId, string> = {
  google_drive: "google_drive",
  onedrive: "onedrive",
  notion: "notion",
  jira: "jira",
  confluence: "confluence",
  figma: "figma",
};

/**
 * Phase 15 Task 11: classify a sync error as `transient` or
 * `permanent`. The decision matrix mirrors
 * `tessera_connectors::ConnectorError::failure_kind`:
 *
 *  - `NotConnectedError` (the user is not authenticated, OR their
 *    refresh token was revoked) → `permanent`. The retry loop
 *    would just hit the same auth wall on every attempt; the
 *    user has to re-authorise before any further progress.
 *  - `isNetworkError(err) === true` (EAI_AGAIN / ENOTFOUND /
 *    ETIMEDOUT / ECONNRESET / etc.) → `transient`. These are
 *    classic recoverable network blips.
 *  - `RateLimitError` → `transient`. The provider explicitly
 *    asks us to back off; the next attempt after the backoff
 *    interval will likely succeed.
 *  - Anything else → `transient`. We deliberately bias toward
 *    `transient` here so a one-off provider 5xx doesn't flip
 *    the sticky `failedPermanently` bit; the
 *    `MAX_RETRIES_BEFORE_PERMANENT` clamp in `connectorBackoff`
 *    will still flip it to permanent after 8 consecutive
 *    failures, which is enough signal that the source is
 *    actually broken (not just intermittently flaky).
 */
function classifyConnectorError(err: unknown): FailureKind {
  if (err == null) return "transient";
  if (typeof err === "object") {
    if ((err as { isNotConnectedError?: boolean }).isNotConnectedError === true) {
      return "permanent";
    }
  }
  // RateLimitError is `transient` (matches Rust `RateLimited`).
  // We don't import the class here to avoid a circular dep —
  // the `name` check is sufficient because RateLimitError is the
  // only thrown type with that name in this codebase.
  return "transient";
}

/**
 * Phase 15 Task 11: stamp a successful sync onto every source
 * row that belongs to `provider`. Clearing per-source is
 * intentional — a single provider's sync may touch multiple
 * sources (e.g. multiple Drive folders), and any of them that
 * had a previous failure recorded must have its state cleared so
 * the UI's "permanently failed" badge disappears.
 *
 * Failures inside this helper are logged but NOT propagated:
 * recording success is observability, not correctness. The user
 * just saw their sync succeed — we must not turn that into a
 * thrown error because a downstream DB write hiccuped.
 */
function clearAllProviderFailureStates(ctx: IpcContext, provider: ProviderId): void {
  const targetType = PROVIDER_TO_SOURCE_TYPE[provider];
  if (targetType == null) return;
  try {
    const bridge = ctx.requireBridge();
    const sources = bridge.bridgeListSources();
    for (const src of sources) {
      if (src.sourceType !== targetType) continue;
      try {
        clearSyncFailureState(bridge, src.id);
      } catch (inner) {
        ctx.log.warn("clear sync-failure state failed (continuing)", {
          provider,
          sourceId: src.id,
          error: (inner as Error).message,
        });
      }
    }
  } catch (err) {
    ctx.log.warn("could not enumerate sources for failure-state clear", {
      provider,
      error: (err as Error).message,
    });
  }
}

/**
 * Phase 15 Task 11: stamp a failed sync onto every source row
 * that belongs to `provider`, applying the policy in
 * `connectorBackoff` to the previous state to compute the new
 * `(retry_count, failed_permanently)` tuple.
 *
 * Same logging-not-throwing posture as `clearAllProviderFailureStates`
 * — recording is observability and must never override the
 * actual error the caller is about to surface.
 */
function recordAllProviderFailures(
  ctx: IpcContext,
  provider: ProviderId,
  err: unknown,
): void {
  const targetType = PROVIDER_TO_SOURCE_TYPE[provider];
  if (targetType == null) return;
  const kind = classifyConnectorError(err);
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  try {
    const bridge = ctx.requireBridge();
    const sources = bridge.bridgeListSources();
    for (const src of sources) {
      if (src.sourceType !== targetType) continue;
      try {
        const prev: SyncFailureState = (() => {
          try {
            return loadSyncFailureState(bridge, src.id);
          } catch {
            return emptySyncFailureState();
          }
        })();
        const next = applyFailureToState(prev, { kind, message });
        saveSyncFailureState(bridge, src.id, next);
      } catch (inner) {
        ctx.log.warn("record sync-failure state failed (continuing)", {
          provider,
          sourceId: src.id,
          error: (inner as Error).message,
        });
      }
    }
  } catch (err2) {
    ctx.log.warn("could not enumerate sources for failure-state record", {
      provider,
      error: (err2 as Error).message,
    });
  }
}

// Network-error classification (NetworkError class, NotConnectedError
// class, isNetworkError function) lives in a dedicated
// `./networkErrors` module so per-connector sync files
// (`notion.ts`, `confluence.ts`, `figma.ts`, etc.) can import the
// classifier without forming an import cycle with this file. See the
// module-level docstring in `networkErrors.ts` for the full rationale.
// `handlers.ts` re-exports the public surface unchanged so existing
// imports (`import { NetworkError, isNetworkError } from "./handlers"`
// in tests and `ipc.ts`) continue to work without code churn.
import {
  NetworkError,
  NotConnectedError,
  isNetworkError,
} from "./networkErrors";
export { NetworkError, NotConnectedError, isNetworkError };

/**
 * Resolve a fresh access token, refreshing via the refresh token if
 * the access token has expired (or is within 60s of expiry). Throws
 * a clear error if the connector is not connected.
 */
async function getValidAccessToken(
  ctx: IpcContext,
  provider: ProviderId,
): Promise<string> {
  const stored = ctx.tokenVault.getTokens(provider);
  if (!stored) {
    throw new NotConnectedError(
      `${provider} is not connected — authenticate first`,
    );
  }
  const config = getProviderOAuthConfig(provider);

  // If we have no refresh token stored — for ANY reason, regardless
  // of whether the provider config advertises `supportsRefresh: true`
  // — there is no point checking `expiresAt` and proactively
  // deleting the access token: we have nothing to refresh with.
  // The guard used to require BOTH `!supportsRefresh` AND
  // `!stored.refreshToken`, which silently force-disconnected users
  // whose stored tokens lacked a refresh token even when the provider
  // config said it supported refresh. This shows up in practice for
  // Figma (Figma's OAuth response sometimes omits `refresh_token`
  // depending on the app's grant configuration, even though the
  // provider supports them) and for any Atlassian flow whose initial
  // exchange returned only an access token (e.g. an older integration
  // upgraded mid-session).
  // The reasoning is the same as the original Notion-only carve-out:
  // proactively deleting a token we *believe* expired is strictly
  // worse than letting the upstream API tell us via a 401 if the
  // token is actually invalid, because:
  //   (a) we have no way to recover (no refresh token),
  //   (b) the only consequence of our guess being wrong is to forcibly
  //       sign the user out of a working integration.
  // So whenever we lack a refresh token, skip the expiry check
  // entirely and return the stored access token verbatim.
  if (!stored.refreshToken) {
    return stored.accessToken;
  }

  if (Date.now() < stored.expiresAt - 60_000) return stored.accessToken;

  // Reachability: the `!stored.refreshToken` early-return above means
  // `stored.refreshToken` is necessarily truthy here, so the only way
  // this guard can fire is `!config.supportsRefresh`. Keeping the
  // `!config.supportsRefresh` half explicit makes the intent obvious
  // and protects against a future code path that flips the early
  // return into a fall-through (e.g. a hypothetical "refresh token
  // is stored but provider config changed to supportsRefresh: false").
  if (!config.supportsRefresh) {
    ctx.tokenVault.deleteTokens(provider);
    throw new NotConnectedError(
      `${provider} access token expired and refresh is not available — re-authenticate`,
    );
  }
  if (!stored.clientId || !stored.clientSecret) {
    ctx.tokenVault.deleteTokens(provider);
    throw new NotConnectedError(
      `${provider} client credentials missing — re-authenticate`,
    );
  }
  // Wrap the refresh-token exchange so a transport-level failure
  // (DNS, TCP refused, undici timeout, etc.) escapes via our branded
  // `NetworkError` rather than as a bare `fetch` rejection. The
  // outer `runConnectorSync` wrapper keys its `{ status: "offline" }`
  // fallback on `isNetworkError(err)`, but `getValidAccessToken` runs
  // OUTSIDE that wrapper's try/catch (so we don't burn the rate-limit
  // budget on auth-state errors) — without this re-wrap, a refresh
  // call that fails because the user's wifi dropped would bubble out
  // as a raw fetch rejection and the renderer would surface a
  // confusing "fetch failed" error instead of the Offline badge.
  let refreshed: Awaited<ReturnType<typeof refreshProviderToken>>;
  try {
    refreshed = await refreshProviderToken(config, {
      refreshToken: stored.refreshToken,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
    });
  } catch (err) {
    if (isNetworkError(err)) {
      throw new NetworkError(
        `Network error while refreshing ${provider} access token: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
    throw err;
  }
  ctx.tokenVault.storeTokens(provider, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
    expiresAt: Date.now() + refreshed.expiresIn * 1000,
    scopes: stored.scopes,
    clientId: stored.clientId,
    clientSecret: stored.clientSecret,
  });
  return refreshed.accessToken;
}

export function getValidAccessTokenForProvider(
  ctx: IpcContext,
  provider: ProviderId,
): Promise<string> {
  return getValidAccessToken(ctx, provider);
}

/**
 * Result shape returned by every per-provider sync. The `status`
 * field is `"synced"` on a normal run and `"offline"` when the
 * shared wrapper (`runConnectorSync` below) catches a network
 * failure on behalf of the caller. The renderer keys the Offline
 * badge on `status === "offline"`.
 */
export interface ConnectorSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

async function runSync(
  ctx: IpcContext,
  provider: ProviderId,
  accessToken: string,
  userDataDir: string,
  options?: { selectedFileIds?: string[] },
): Promise<ConnectorSyncResult> {
  const bridge = bridgeHooks(ctx);
  // Production refresh hook: each connector's hot loop calls this
  // per iteration so a long-running sync (>1h, the default OAuth
  // access-token lifetime for Google / Microsoft / Atlassian /
  // Notion / Figma) transparently refreshes via the stored refresh
  // token. `getValidAccessToken` already returns the cached value
  // when there's >60s left and only hits the network when truly
  // expired, so the per-iteration cost is a vault read + a
  // millisecond comparison in the common case.
  const getAccessToken = (): Promise<string> => getValidAccessToken(ctx, provider);
  switch (provider) {
    case "google_drive":
      return syncGoogleDrive({
        accessToken,
        getAccessToken,
        userDataDir,
        bridge,
        selectedFileIds: options?.selectedFileIds,
      });
    case "onedrive":
      return syncOneDrive({ accessToken, getAccessToken, userDataDir, bridge });
    case "notion":
      return syncNotion({ accessToken, getAccessToken, userDataDir, bridge });
    case "jira":
      return syncJira({ accessToken, getAccessToken, userDataDir, bridge });
    case "confluence":
      return syncConfluence({ accessToken, getAccessToken, userDataDir, bridge });
    case "figma":
      return syncFigma({ accessToken, getAccessToken, userDataDir, bridge });
    default: {
      // Exhaustiveness assertion. `ProviderId` is derived from the
      // `KNOWN_PROVIDERS` tuple in `validate.ts`, so a future 7th
      // provider added to that tuple without a matching
      // `case` in this switch fails the compile here — the `never`
      // assignment is the only place TypeScript will narrow `provider`
      // to a non-empty type if the switch is non-exhaustive. The
      // runtime `throw` is dead code today but is the only safe
      // behaviour if a downstream caller ever circumvents the validator
      // and routes an unknown provider id through to this function.
      // Without this branch a non-exhaustive switch returns `undefined`
      // at runtime and the IPC layer surfaces an opaque
      // "Cannot read properties of undefined (reading 'then')".
      const _exhaustive: never = provider;
      throw new Error(`runSync: unknown provider ${String(_exhaustive)}`);
    }
  }
}

/**
 * Shared rate-limit + offline-catch wrapper used by every connector
 * sync channel — both the new `connectors:sync` channel below and
 * the legacy `connectors:gdrive:sync` channel registered in
 * `ipc.ts`. Centralising this here means:
 *
 *   - Drive and the other five providers all get the same
 *     1-per-30-second per-provider rate limit (the legacy gdrive
 *     channel had no rate limit before this; a buggy renderer could
 *     hammer the Drive API on its behalf).
 *   - Network failures are surfaced as `{ status: "offline" }` for
 *     Drive too, instead of being thrown out of the handler and
 *     silently swallowed by the renderer's empty `catch {}` — that
 *     was why the Offline badge introduced for the other providers
 *     never lit up for Drive.
 *   - Auth-prerequisite errors (`NotConnectedError`) still propagate
 *     as hard errors so the UI can prompt re-authentication.
 */
export async function runConnectorSync(
  ctx: IpcContext,
  provider: ProviderId,
  options?: { selectedFileIds?: string[] },
): Promise<ConnectorSyncResult> {
  const offlineResult = (): ConnectorSyncResult => ({
    added: 0,
    modified: 0,
    removed: 0,
    status: "offline",
  });
  // Resolve the access token BEFORE consuming the rate-limit budget.
  // The token check is local (vault lookup + optional refresh-token
  // exchange) and short-circuits with `NotConnectedError` when the
  // user simply isn't authenticated — spending the 1/30s budget on
  // that case would mask the real "please re-authenticate" error
  // behind a generic "rate-limited" message on the next click.
  // The rate-limit is still consumed before any expensive per-
  // provider sync work (the actual API calls in `runSync`), which is
  // where defence-in-depth against a runaway renderer matters.
  let token: string;
  try {
    token = await getValidAccessToken(ctx, provider);
  } catch (err) {
    // A refresh-token exchange that fails because the network dropped
    // must still surface as "offline" to the renderer; otherwise the
    // user clicks Sync, sees a raw `fetch failed` and has no idea the
    // problem is transport, not auth. `getValidAccessToken` now wraps
    // its `refreshProviderToken` call so the rejection carries the
    // `NetworkError` brand isNetworkError() recognises. Keeping the
    // detection here too (rather than letting the brand survive
    // unwrapped) means non-network refresh errors (4xx from the
    // provider, missing credentials, etc.) still propagate as hard
    // errors so the UI can prompt re-authentication.
    if (isNetworkError(err)) {
      ctx.log.warn("token refresh hit network failure", {
        provider,
        error: (err as Error).message,
      });
      return offlineResult();
    }
    throw err;
  }
  try {
    ctx.rateLimiter.consume(`connectors:sync:${provider}`, {
      tokensPerInterval: 1,
      intervalMs: 30_000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new Error(
        `Sync for ${provider} is rate-limited. Wait ${Math.ceil(
          err.retryAfterMs / 1000,
        )}s and try again.`,
      );
    }
    throw err;
  }
  try {
    const result = await runSync(ctx, provider, token, ctx.userDataDir(), options);
    // log the sync delta counts on the `"synced"`
    // path only. The `"offline"` status returned below reflects a
    // transient network failure (no actual sync work happened) so an
    // audit row for it would pollute reports with noise.
    //
    // This audit lives inside `runConnectorSync` — NOT inside the
    // individual IPC handlers — so EVERY caller is audited
    // automatically: the new `connectors:sync` handler in this file
    // AND the legacy `connectors:gdrive:sync` handler in
    // `connectorsLegacy.ts` (still reachable from the renderer via
    // `preload.ts`'s `gdrive:sync` channel), AND any future channel
    // that delegates to this shared wrapper.
    // Previously the audit lived in the
    // handler; moving it here closes it structurally instead of
    // requiring every future caller to remember to add the wrap.
    if (result.status === "synced") {
      safeAudit(ctx, (b) =>
        b.bridgeLogConnectorSynced(
          provider,
          result.added,
          result.modified,
          result.removed,
        ),
      );
      // Phase 15 Task 11: a successful sync clears any previously
      // recorded failure state. Done AFTER the audit log emits so
      // a hypothetical race where the clear happens but the audit
      // does not still leaves the audit pipeline as the source of
      // truth — but well after the actual sync committed, so
      // there is no "phantom success" risk from clearing.
      clearAllProviderFailureStates(ctx, provider);
    }
    return result;
  } catch (err) {
    // Phase 15 Task 11: record failure BEFORE the offline-result
    // branch returns. The renderer's source-health UI relies on
    // this to render the retry-count badge on every source the
    // provider owns. Even when we degrade to `{ status: "offline" }`
    // (transient network blip), we still bump retry_count so a
    // chronically offline source eventually flips to permanent.
    recordAllProviderFailures(ctx, provider, err);
    if (isNetworkError(err)) {
      ctx.log.warn("connector sync hit network failure", {
        provider,
        error: (err as Error).message,
      });
      return offlineResult();
    }
    throw err;
  }
}

async function runDisconnect(
  ctx: IpcContext,
  provider: ProviderId,
  userDataDir: string,
): Promise<{ filesRemoved: number }> {
  const bridge = bridgeHooks(ctx);
  switch (provider) {
    case "google_drive":
      return disconnectGoogleDrive(userDataDir, bridge);
    case "onedrive":
      return disconnectOneDrive(userDataDir, bridge);
    case "notion":
      return disconnectNotion(userDataDir, bridge);
    case "jira":
      return disconnectJira(userDataDir, bridge);
    case "confluence":
      return disconnectConfluence(userDataDir, bridge);
    case "figma":
      return disconnectFigma(userDataDir, bridge);
    default: {
      // Exhaustiveness assertion. Same architectural rationale as the
      // sibling `default` branch in `runSync` above: `ProviderId` is
      // derived from the `KNOWN_PROVIDERS` tuple in `validate.ts`, so
      // a future 7th provider added there without a matching `case`
      // in this switch fails the compile here. Without the assertion
      // `runDisconnect` would silently fall through and return `void`
      // — the user clicks Disconnect, the tokens are revoked and
      // deleted (the work above in the disconnect handler), but the
      // per-provider cleanup (purging the sync directory, unhooking
      // the bridge sources, deleting the local manifest) would never
      // run for the new provider. The orphaned files and stale source
      // index entries would persist until the user manually deletes
      // the sync directory — exactly the silent-failure mode the
      // sibling `runSync` exhaustiveness assertion was added to prevent.
      const _exhaustive: never = provider;
      throw new Error(`runDisconnect: unknown provider ${String(_exhaustive)}`);
    }
  }
}

export function registerConnectorHandlers(ctx: IpcContext): void {
  // Every `idempotentHandle(...)` below does its own
  // `ipcMain.removeHandler` first, so re-importing this module (test
  // harness or future hot-reload) no longer needs a separate
  // per-channel cleanup loop.
  idempotentHandle(
    "connectors:authenticate",
    // Electron IPC delivers every argument as `unknown` at runtime — the
    // `assertProvider` / `assertString` calls below are what produce a
    // narrowed `string`. Typing the handler parameters as `unknown`
    // matches that reality and keeps this module consistent with every
    // other refactored handler in the per-domain split.
    async (
      _event,
      providerRaw: unknown,
      clientIdRaw: unknown,
      clientSecretRaw: unknown,
    ): Promise<ConnectorStatusInfo> => {
      const provider = assertProvider(providerRaw, "provider");
      const clientId = assertString(clientIdRaw, "clientId", { maxLen: 512 });
      const clientSecret = assertString(clientSecretRaw, "clientSecret", {
        maxLen: 512,
        // Every provider supported today (Google Drive, OneDrive,
        // Notion, Jira, Confluence, Figma) is registered as a
        // confidential OAuth client and therefore requires a non-empty
        // `client_secret`. If a future connector is added with a public
        // / PKCE-only OAuth client, special-case it here.
        allowEmpty: false,
      });
      try {
        ctx.rateLimiter.consume(`connectors:authenticate:${provider}`, {
          tokensPerInterval: 1,
          intervalMs: 5_000,
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          throw new Error(
            `Too many authentication attempts for ${provider}. Wait ${Math.ceil(
              err.retryAfterMs / 1000,
            )}s and try again.`,
          );
        }
        throw err;
      }

      const config = getProviderOAuthConfig(provider);
      const pkce = config.usePkce ? generatePkcePair() : null;
      const result = await runRedirectServer(config, {
        clientId,
        codeChallenge: pkce?.challenge,
      });
      const tokens = await exchangeAuthorizationCode(config, {
        code: result.code,
        clientId,
        clientSecret,
        codeVerifier: pkce?.verifier,
      });
      ctx.tokenVault.storeTokens(provider, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
        scopes: config.scope.split(/\s+/).filter(Boolean),
        clientId,
        clientSecret,
      });
      ctx.log.info("connector authenticated", { provider });
      // log the connect event AFTER the tokens
      // have been written to the vault. A failed audit append must
      // not roll back the user's successful OAuth flow — `safeAudit`
      // swallows the failure and logs a warning instead.
      safeAudit(ctx, (b) => b.bridgeLogConnectorConnected(provider));
      return { provider, connected: true, status: "connected" };
    },
  );

  idempotentHandle(
    "connectors:disconnect",
    async (_event, providerRaw: unknown): Promise<ConnectorStatusInfo> => {
      const provider = assertProvider(providerRaw, "provider");
      let stored: ReturnType<typeof ctx.tokenVault.getTokens> = null;
      try {
        stored = ctx.tokenVault.getTokens(provider);
      } catch {
        // vault may be corrupted — proceed with cleanup
      }
      if (stored) {
        const config = getProviderOAuthConfig(provider);
        await revokeProviderToken(
          config,
          stored.refreshToken ?? stored.accessToken,
        ).catch(() => undefined);
      }
      try {
        ctx.tokenVault.deleteTokens(provider);
      } catch {
        // best-effort
      }
      // `runDisconnect` returns the count of bridge sources actually
      // removed from the index — the audit code plumbs this
      // count through to the `ConnectorDisconnected` audit event so
      // an auditor can see how much state each disconnect cleaned
      // up. On cleanup failure we still log the disconnect (the
      // user-visible action — token revocation — already
      // succeeded) but report `filesRemoved=0` rather than guess.
      let filesRemoved = 0;
      try {
        const result = await runDisconnect(ctx, provider, ctx.userDataDir());
        filesRemoved = result.filesRemoved;
      } catch (err) {
        ctx.log.warn("connector disconnect cleanup failed (continuing)", {
          provider,
          error: (err as Error).message,
        });
      }
      ctx.log.info("connector disconnected", { provider, filesRemoved });
      safeAudit(ctx, (b) => b.bridgeLogConnectorDisconnected(provider, filesRemoved));
      return { provider, connected: false, status: "disconnected" };
    },
  );

  idempotentHandle(
    "connectors:status",
    async (_event, providerRaw: unknown): Promise<ConnectorStatusInfo> => {
      const provider = assertProvider(providerRaw, "provider");
      const hasTokens = ctx.tokenVault.hasTokens(provider);
      return {
        provider,
        connected: hasTokens,
        status: hasTokens ? "connected" : "disconnected",
      };
    },
  );

  idempotentHandle(
    "connectors:getRedirectUri",
    async (_event, providerRaw: unknown): Promise<string> => {
      // Single source of truth for the loopback redirect URI: the
      // OAuth config in `providerOAuth.ts`. The Settings UI fetches
      // this via IPC so the URI it tells the user to register in the
      // provider's developer console cannot drift from the one the
      // OAuth flow actually sends in the authorize request. Drift
      // here caused a bug where the UI told users to register
      // `http://127.0.0.1:9876/callback` for Google Drive while the
      // OAuth flow sent `http://localhost:9876/callback`, producing
      // `redirect_uri_mismatch` on every connect attempt.
      const provider = assertProvider(providerRaw, "provider");
      const config = getProviderOAuthConfig(provider);
      return getRedirectUri(config);
    },
  );

  idempotentHandle(
    "connectors:getAllRedirectUris",
    async (): Promise<Record<string, string>> => {
      return getRedirectUriMap();
    },
  );

  idempotentHandle(
    "connectors:sync",
    async (_event, providerRaw: unknown): Promise<ConnectorSyncResult> => {
      const provider = assertProvider(providerRaw, "provider");
      // The audit row for successful syncs is emitted by
      // `runConnectorSync` itself so the legacy `connectors:gdrive:sync`
      // handler (also routed through `runConnectorSync`) gets audited
      // automatically. See the doc comment in `runConnectorSync`.
      return await runConnectorSync(ctx, provider);
    },
  );
}
