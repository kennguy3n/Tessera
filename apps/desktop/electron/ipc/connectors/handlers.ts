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

import { ipcMain } from "electron";

import type { IpcContext } from "../context";
import { assertProvider, assertString } from "../validate";
import { RateLimitError } from "../rateLimiter";
import {
  exchangeAuthorizationCode,
  generatePkcePair,
  getProviderOAuthConfig,
  getRedirectUri,
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

function isNetworkError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  if (
    [
      "EAI_AGAIN",
      "ENOTFOUND",
      "ETIMEDOUT",
      "ECONNREFUSED",
      "ECONNRESET",
      "ENETUNREACH",
      "EHOSTUNREACH",
    ].includes(code)
  ) {
    return true;
  }
  const msg = (e.message ?? "").toLowerCase();
  return /fetch failed|network|connect/i.test(msg) && code === "";
}

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
  if (!stored) throw new Error(`${provider} is not connected — authenticate first`);
  if (Date.now() < stored.expiresAt - 60_000) return stored.accessToken;

  const config = getProviderOAuthConfig(provider);
  if (!config.supportsRefresh || !stored.refreshToken) {
    ctx.tokenVault.deleteTokens(provider);
    throw new Error(
      `${provider} access token expired and refresh is not available — re-authenticate`,
    );
  }
  if (!stored.clientId || !stored.clientSecret) {
    ctx.tokenVault.deleteTokens(provider);
    throw new Error(`${provider} client credentials missing — re-authenticate`);
  }
  const refreshed = await refreshProviderToken(config, {
    refreshToken: stored.refreshToken,
    clientId: stored.clientId,
    clientSecret: stored.clientSecret,
  });
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

async function runSync(
  ctx: IpcContext,
  provider: ProviderId,
  accessToken: string,
  userDataDir: string,
  options?: { selectedFileIds?: string[] },
): Promise<{ added: number; modified: number; removed: number; status: string }> {
  const bridge = bridgeHooks(ctx);
  switch (provider) {
    case "google_drive":
      return syncGoogleDrive({
        accessToken,
        userDataDir,
        bridge,
        selectedFileIds: options?.selectedFileIds,
      });
    case "onedrive":
      return syncOneDrive({ accessToken, userDataDir, bridge });
    case "notion":
      return syncNotion({ accessToken, userDataDir, bridge });
    case "jira":
      return syncJira({ accessToken, userDataDir, bridge });
    case "confluence":
      return syncConfluence({ accessToken, userDataDir, bridge });
    case "figma":
      return syncFigma({ accessToken, userDataDir, bridge });
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
  }
}

export function registerConnectorHandlers(ctx: IpcContext): void {
  ipcMain.handle(
    "connectors:authenticate",
    async (
      _event,
      providerRaw: string,
      clientIdRaw: string,
      clientSecretRaw: string,
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

  ipcMain.handle(
    "connectors:disconnect",
    async (_event, providerRaw: string): Promise<ConnectorStatusInfo> => {
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

  ipcMain.handle(
    "connectors:status",
    async (_event, providerRaw: string): Promise<ConnectorStatusInfo> => {
      const provider = assertProvider(providerRaw, "provider");
      const hasTokens = ctx.tokenVault.hasTokens(provider);
      return {
        provider,
        connected: hasTokens,
        status: hasTokens ? "connected" : "disconnected",
      };
    },
  );

  ipcMain.handle(
    "connectors:getRedirectUri",
    async (_event, providerRaw: string): Promise<string> => {
      // Single source of truth for the loopback redirect URI: the
      // OAuth config in `providerOAuth.ts`. The Settings UI fetches
      // this via IPC so the URI it tells the user to register in the
      // provider's developer console cannot drift from the one the
      // OAuth flow actually sends in the authorize request. Drift
      // here caused a previous Devin Review bug where the UI told
      // users to register `http://127.0.0.1:9876/callback` for
      // Google Drive while the OAuth flow sent
      // `http://localhost:9876/callback`, producing
      // `redirect_uri_mismatch` on every connect attempt.
      const provider = assertProvider(providerRaw, "provider");
      const config = getProviderOAuthConfig(provider);
      return getRedirectUri(config);
    },
  );

  ipcMain.handle(
    "connectors:sync",
    async (_event, providerRaw: string) => {
      const provider = assertProvider(providerRaw, "provider");
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
        const token = await getValidAccessToken(ctx, provider);
        return await runSync(ctx, provider, token, ctx.userDataDir());
      } catch (err) {
        if (isNetworkError(err)) {
          ctx.log.warn("connector sync hit network failure", {
            provider,
            error: (err as Error).message,
          });
          return {
            added: 0,
            modified: 0,
            removed: 0,
            status: "offline",
          };
        }
        throw err;
      }
    },
  );
}
