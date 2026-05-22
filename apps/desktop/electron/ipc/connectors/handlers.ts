/**
 * Unified connector IPC handlers for all 6 providers (Tasks 1–6).
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
 * Phase 10 additions:
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
    return await runSync(ctx, provider, token, ctx.userDataDir(), options);
  } catch (err) {
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
): Promise<void> {
  const bridge = bridgeHooks(ctx);
  switch (provider) {
    case "google_drive":
      await disconnectGoogleDrive(userDataDir, bridge);
      return;
    case "onedrive":
      await disconnectOneDrive(userDataDir, bridge);
      return;
    case "notion":
      await disconnectNotion(userDataDir, bridge);
      return;
    case "jira":
      await disconnectJira(userDataDir, bridge);
      return;
    case "confluence":
      await disconnectConfluence(userDataDir, bridge);
      return;
    case "figma":
      await disconnectFigma(userDataDir, bridge);
      return;
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
    // other refactored handler in the WS6 split.
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
      try {
        await runDisconnect(ctx, provider, ctx.userDataDir());
      } catch (err) {
        ctx.log.warn("connector disconnect cleanup failed (continuing)", {
          provider,
          error: (err as Error).message,
        });
      }
      ctx.log.info("connector disconnected", { provider });
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
      return runConnectorSync(ctx, provider);
    },
  );
}
