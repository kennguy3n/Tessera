/**
 * Provider-agnostic OAuth 2.0 helper (Phase 10 Tasks 1–6).
 *
 * Single Authorization Code Grant flow shared by every Tessera
 * connector. The provider-specific bits (auth URL, token URL,
 * scopes, header style, refresh-token semantics) are isolated as a
 * `ProviderOAuthConfig` so each new connector is one config entry
 * plus the actual sync logic, not a new copy of the whole flow.
 *
 * Design notes:
 *   - Each provider gets its own loopback port to keep concurrent
 *     auth attempts isolated and to avoid the `EADDRINUSE` confusion
 *     of a stuck flow blocking a new one. The redirect URIs are
 *     `http://127.0.0.1:<port>/callback`.
 *   - We standardise on the loopback / localhost-redirect pattern
 *     (RFC 8252 — OAuth for Native Apps). Every provider here
 *     supports it for desktop applications.
 *   - PKCE (S256) is enabled for every provider whose OAuth surface
 *     supports it (Google Drive, OneDrive, Jira, Confluence). For
 *     those, the verifier is attached to the request and the
 *     challenge is sent on the authorize URL. Two providers opt out:
 *     **Notion** (integration tokens follow a non-expiring
 *     `client_secret + authorization_code` flow that does not accept
 *     `code_challenge`) and **Figma** (whose OAuth implementation
 *     predates PKCE and rejects the parameter outright). Both fall
 *     back to plain authorization-code with state validation; their
 *     `usePkce` flag is false. Re-enable PKCE for either the moment
 *     the upstream provider starts honouring `code_challenge_method=S256`.
 *   - Token exchange uses `application/x-www-form-urlencoded` and
 *     either `Authorization: Basic <id:secret>` or
 *     `client_secret=<secret>` in the body, per provider config.
 *   - Refresh handling is per-provider. We expose a
 *     `supportsRefresh` flag so callers can surface a "reconnect
 *     needed" UX for providers whose OAuth flow does not issue a
 *     refresh token (currently only Notion's integration tokens are
 *     non-expiring and refresh-less).
 *
 * Security notes:
 *   - We always validate the OAuth `state` returned in the callback
 *     matches what we generated. A mismatch is a hard error.
 *   - `client_id` / `client_secret` are passed by the renderer (user
 *     entered) and stored only in the OS keychain via `tokenVault`.
 *   - The redirect server is bound to `127.0.0.1` only — never on
 *     `0.0.0.0` — and shuts down immediately after the redirect.
 *
 * Test surface:
 *   - The flow logic is split between `buildAuthorizeUrl`,
 *     `runRedirectServer`, and `exchangeAuthorizationCode` so tests
 *     can exercise each piece without a live browser.
 */

import { shell } from "electron";
import * as crypto from "crypto";
import * as http from "http";

import { generateState } from "../../oauth";
import type { KnownProvider } from "../validate";

/**
 * Canonical connector identifier — a single source of truth.
 *
 * Both this OAuth layer (`PROVIDER_OAUTH_CONFIGS`, every connector's
 * sync impl, the redirect-server flow) and the IPC validator
 * (`assertProvider`, the `KNOWN_PROVIDERS` allowlist in
 * `../validate.ts`) need to enumerate the exact same set of providers.
 * Previously each side defined its own union — `ProviderId` here as an
 * explicit `"google_drive" | "onedrive" | ...` and `KnownProvider` in
 * `validate.ts` derived from the runtime allowlist — and adding a new
 * connector required updating both. TypeScript would catch the
 * mismatch lazily (at the `runSync` switch's exhaustiveness check or
 * at the `provider as ProviderId` cast in `ipc.ts`), not eagerly, and
 * a maintainer wiring up a 7th connector could plausibly miss one of
 * the two files until runtime.
 *
 * The fix derives `ProviderId` from `KNOWN_PROVIDERS` so the runtime
 * allowlist used by the IPC validator IS the type the OAuth layer
 * indexes by. Adding a connector is now a single edit (the
 * `KNOWN_PROVIDERS` tuple in `validate.ts`); every consumer —
 * `PROVIDER_OAUTH_CONFIGS`, `runSync`, `assertProvider`, the bridge
 * cast — fails to compile in the right places at the right time until
 * the new provider is wired all the way through.
 */
export type ProviderId = KnownProvider;

export interface ProviderOAuthConfig {
  /** Stable provider id used by tokenVault and the connector registry. */
  provider: ProviderId;
  /** Authorization endpoint. */
  authUrl: string;
  /** Token exchange endpoint. */
  tokenUrl: string;
  /** Optional token revocation endpoint. */
  revokeUrl?: string;
  /** Space-delimited scope string. */
  scope: string;
  /** Loopback port the redirect URI will listen on. Must be unique per provider. */
  redirectPort: number;
  /**
   * Loopback host for the redirect URI. RFC 8252 prefers `127.0.0.1`
   * but Google's published examples and the legacy Tessera OAuth
   * client (pre-Phase 10) use `localhost`. Existing user OAuth
   * client configurations in Google Cloud Console therefore have
   * `http://localhost:9876/callback` registered — switching to
   * `127.0.0.1` would break every existing installation with a
   * `redirect_uri_mismatch` error. We default new providers to
   * `127.0.0.1` (the spec-compliant choice) but keep Google Drive
   * on `localhost` for backward compatibility.
   */
  redirectHost?: "127.0.0.1" | "localhost";
  /** Optional extra params to add to the authorize URL (e.g. `prompt=consent`). */
  extraAuthorizeParams?: Record<string, string>;
  /** Whether to send `client_id:client_secret` as HTTP Basic Auth on token exchange. */
  basicAuth?: boolean;
  /** Whether `offline_access` should be added to the scope for refresh tokens. */
  requestOfflineAccess?: boolean;
  /**
   * Whether the provider's OAuth flow issues a refresh token. Notion
   * integration tokens are non-expiring and refresh-less; every other
   * connector (Drive, OneDrive, Jira, Confluence, Figma) supports
   * refresh.
   */
  supportsRefresh: boolean;
  /** Whether to send PKCE code_challenge / code_verifier on the flow. */
  usePkce: boolean;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  /** Provider-specific extra payload (e.g. Notion's `workspace_id`, Figma's `user`). */
  extra?: Record<string, unknown>;
}

export interface AuthorizationCodeResult {
  code: string;
  state: string;
}

/**
 * Per-provider OAuth config. Every value is a constant of the
 * provider's documented OAuth surface; no values come from runtime
 * configuration. Adding a new connector means adding an entry here.
 */
export const PROVIDER_OAUTH_CONFIGS: Record<ProviderId, ProviderOAuthConfig> = {
  google_drive: {
    provider: "google_drive",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    redirectPort: 9876,
    // Google Drive was the first connector wired into Tessera (pre-
    // Phase 10) using `http://localhost:9876/callback`. Users have
    // already registered that exact URI in Google Cloud Console; we
    // must preserve it bit-for-bit or every existing installation
    // breaks with `redirect_uri_mismatch`.
    redirectHost: "localhost",
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  onedrive: {
    provider: "onedrive",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Microsoft v2.0 token endpoint accepts client_secret in the body for
    // confidential clients; PKCE is required for public/desktop clients.
    scope: "offline_access Files.Read.All User.Read",
    redirectPort: 9877,
    extraAuthorizeParams: {
      response_mode: "query",
      prompt: "select_account",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  notion: {
    provider: "notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scope: "",
    redirectPort: 9878,
    extraAuthorizeParams: {
      owner: "user",
    },
    basicAuth: true,
    supportsRefresh: false,
    usePkce: false,
  },
  jira: {
    provider: "jira",
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scope:
      "read:jira-work read:jira-user offline_access",
    redirectPort: 9879,
    extraAuthorizeParams: {
      audience: "api.atlassian.com",
      prompt: "consent",
    },
    requestOfflineAccess: true,
    supportsRefresh: true,
    usePkce: true,
  },
  confluence: {
    provider: "confluence",
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    scope:
      "read:confluence-content.summary read:confluence-content.all read:confluence-space.summary offline_access",
    redirectPort: 9880,
    extraAuthorizeParams: {
      audience: "api.atlassian.com",
      prompt: "consent",
    },
    requestOfflineAccess: true,
    supportsRefresh: true,
    usePkce: true,
  },
  figma: {
    provider: "figma",
    authUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    scope: "files:read",
    redirectPort: 9881,
    extraAuthorizeParams: {},
    supportsRefresh: true,
    usePkce: false,
  },
};

export function getProviderOAuthConfig(provider: ProviderId): ProviderOAuthConfig {
  const cfg = PROVIDER_OAUTH_CONFIGS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);
  return cfg;
}

export function getRedirectUri(config: ProviderOAuthConfig): string {
  const host = config.redirectHost ?? "127.0.0.1";
  return `http://${host}:${config.redirectPort}/callback`;
}

/**
 * Return the full redirect-URI map for every known provider.
 *
 * The renderer's `ConnectorsList` used to hardcode a per-provider
 * fallback URI that had to match the `redirectPort` / `redirectHost`
 * declared here — a maintenance trap where updating a port in one
 * place but not the other silently broke OAuth for that provider.
 * Exposing the canonical map via a single IPC call at mount time
 * (`connectors:getAllRedirectUris`) lets the renderer derive the
 * value from this single source of truth and eliminate the duplicate
 * constants entirely.
 */
export function getRedirectUriMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [provider, config] of Object.entries(PROVIDER_OAUTH_CONFIGS)) {
    map[provider] = getRedirectUri(config);
  }
  return map;
}

/** Build the provider authorize URL. */
export function buildAuthorizeUrl(
  config: ProviderOAuthConfig,
  params: {
    clientId: string;
    state: string;
    codeChallenge?: string;
    redirectUri: string;
  },
): string {
  const url = new URL(config.authUrl);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  if (config.scope.length > 0) {
    url.searchParams.set("scope", config.scope);
  }
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(config.extraAuthorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Generate a PKCE verifier/challenge pair.
 *
 * Verifier: 64 random URL-safe characters.
 * Challenge: BASE64URL(SHA256(verifier)).
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(48));
  const challenge = base64UrlEncode(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Run the loopback redirect server and wait for the OAuth callback.
 * Opens the system browser to the authorize URL and resolves with
 * the returned `code` + `state` (after validating the state matches).
 *
 * Times out after 5 minutes so a stuck flow doesn't hold a port
 * forever.
 */
export async function runRedirectServer(
  config: ProviderOAuthConfig,
  params: { clientId: string; codeChallenge?: string },
): Promise<AuthorizationCodeResult> {
  const state = generateState();
  const redirectUri = getRedirectUri(config);
  const authUrl = buildAuthorizeUrl(config, {
    clientId: params.clientId,
    state,
    codeChallenge: params.codeChallenge,
    redirectUri,
  });

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // Single-shot guard around all `server.close()` + Promise
    // settlement paths. Each event (callback hit, server-level
    // error, timeout) is internally safe — `server.close()` after a
    // prior close is a documented no-op (Node may emit an `'error'`
    // event but the listener is detached by the time we attach the
    // next one), and `resolve`/`reject` on an already-settled
    // Promise are spec no-ops. Even so, racing the timeout against a
    // late callback (or the server-error path against an external
    // close) would historically have invoked `server.close()` twice
    // and walked the cleanup branch twice. Making the guard
    // explicit removes the silent reliance on N layers of
    // idempotency and gives a single place to add future invariants
    // (e.g. event-bus emit, structured-log write).
    let settled = false;
    const settleOnce = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // Already closed or never bound — Node's HTTP server
        // tolerates either case and the surrounding code did so
        // implicitly before this guard existed. Swallowed so the
        // outer Promise settlement path can never reject from a
        // best-effort cleanup.
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      fn();
    };

    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const respond = (status: number, body: string) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(body);
      };

      if (error) {
        const desc = url.searchParams.get("error_description") ?? "";
        respond(
          200,
          `<html><body><h2>Authorization failed</h2><p>${escapeHtml(
            error,
          )}${desc ? `: ${escapeHtml(desc)}` : ""}</p><p>You can close this window.</p></body></html>`,
        );
        settleOnce(() =>
          reject(
            new Error(
              `OAuth error from ${config.provider}: ${error}${desc ? ` (${desc})` : ""}`,
            ),
          ),
        );
        return;
      }
      if (!code || returnedState !== state) {
        respond(
          400,
          "<html><body><h2>Invalid response</h2><p>State mismatch or missing code.</p></body></html>",
        );
        settleOnce(() =>
          reject(new Error("Invalid OAuth callback: state mismatch or missing code")),
        );
        return;
      }

      respond(
        200,
        `<html><body><h2>Connected to ${escapeHtml(
          config.provider,
        )}</h2><p>You can close this window and return to Tessera.</p></body></html>`,
      );
      settleOnce(() => resolve({ code, state }));
    });

    // Bind the loopback server to the same host the redirect URI
    // advertises. Most systems map `localhost` to both `127.0.0.1`
    // and `::1`, but on IPv6-only hosts (or hosts where `localhost`
    // resolves only to `::1` per `/etc/hosts`) binding to a literal
    // `127.0.0.1` while telling the browser to fetch `localhost`
    // produces an unreachable callback. Binding to the same host
    // string the redirect URI uses lets Node pick the address family
    // the OS resolves `localhost` to, eliminating the mismatch.
    const bindHost = config.redirectHost ?? "127.0.0.1";
    server.listen(config.redirectPort, bindHost, () => {
      shell.openExternal(authUrl).catch((err) => {
        settleOnce(() => reject(err));
      });
    });

    server.on("error", (err) => {
      // Belt-and-braces: `server.close()` is a no-op when the
      // socket was never successfully bound (the EADDRINUSE /
      // EACCES `listen` failure case, which is by far the
      // dominant cause of 'error' events on Node HTTP servers).
      // But an 'error' event CAN also fire after a successful
      // `listen` for connection-level failures, in which case the
      // listener is still bound to the port — calling close() here
      // releases it deterministically rather than relying on GC.
      // Cheap insurance against the rare post-listen error path.
      settleOnce(() =>
        reject(
          new Error(
            `Failed to start OAuth redirect server for ${config.provider} on port ${config.redirectPort}: ${err.message}`,
          ),
        ),
      );
    });

    timeoutId = setTimeout(() => {
      settleOnce(() =>
        reject(new Error(`OAuth flow for ${config.provider} timed out after 5 minutes`)),
      );
    }, 300_000);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeAuthorizationCode(
  config: ProviderOAuthConfig,
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    codeVerifier?: string;
  },
): Promise<TokenResponse> {
  const redirectUri = getRedirectUri(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: redirectUri,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (config.basicAuth) {
    const auth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString(
      "base64",
    );
    headers.Authorization = `Basic ${auth}`;
  } else {
    body.set("client_id", params.clientId);
    body.set("client_secret", params.clientSecret);
  }

  if (params.codeVerifier) {
    body.set("code_verifier", params.codeVerifier);
  }

  const resp = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Token exchange failed for ${config.provider}: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }

  const raw = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    [k: string]: unknown;
  };

  if (!raw.access_token) {
    throw new Error(
      `Token exchange for ${config.provider} returned no access_token`,
    );
  }

  const { access_token, refresh_token, expires_in, token_type, ...extra } = raw;
  return {
    accessToken: access_token,
    refreshToken: refresh_token ?? null,
    // Providers that document their access tokens as non-expiring (e.g.
    // Notion's integration tokens) typically omit `expires_in` entirely
    // from the token-exchange response. Defaulting to a normal 1-hour
    // lifetime there would make every stored token look "expired" after
    // an hour and trigger the auth-state cleanup path (see the
    // non-refreshable guard in `handlers.getValidAccessToken`). For
    // those providers we store an effectively-non-expiring value so
    // inspection / debugging surfaces a sensible `expiresAt`. The
    // expiry check still short-circuits for them, so this is
    // defense-in-depth, not the load-bearing fix.
    expiresIn:
      typeof expires_in === "number"
        ? expires_in
        : config.supportsRefresh
          ? 3600
          : 10 * 365 * 24 * 3600,
    tokenType: token_type ?? "Bearer",
    extra,
  };
}

/**
 * Exchange a refresh token for a new access token.
 *
 * Refresh-token behaviour per provider:
 *   - Atlassian (Jira + Confluence): returns a new refresh token on
 *     every refresh.
 *   - Microsoft Graph (OneDrive): returns a new refresh token on
 *     every refresh.
 *   - Google (Drive): sometimes returns a new refresh token; callers
 *     persist the new one when present, fall through to the previous
 *     one when absent.
 *   - Notion: does not support refresh tokens at all
 *     (`supportsRefresh: false` in the config) — when the access
 *     token expires the user must re-authenticate.
 *   - Figma: the modern OAuth v2 flow at
 *     `api.figma.com/v1/oauth/token` returns and accepts refresh
 *     tokens (`supportsRefresh: true`). The early-2024 "classic"
 *     endpoint that did not support refresh has been retired; this
 *     comment reflects the live config.
 *
 * Callers must check `config.supportsRefresh` before invoking this;
 * the early `if (!config.supportsRefresh) throw` below is a guard,
 * not an error path that callers should rely on.
 */
export async function refreshProviderToken(
  config: ProviderOAuthConfig,
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<TokenResponse> {
  if (!config.supportsRefresh) {
    throw new Error(
      `${config.provider} does not support refresh tokens — user must re-authenticate`,
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (config.basicAuth) {
    const auth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString(
      "base64",
    );
    headers.Authorization = `Basic ${auth}`;
  } else {
    body.set("client_id", params.clientId);
    body.set("client_secret", params.clientSecret);
  }

  const resp = await fetch(config.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Token refresh failed for ${config.provider}: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }

  const raw = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    [k: string]: unknown;
  };

  if (!raw.access_token) {
    throw new Error(
      `Token refresh for ${config.provider} returned no access_token`,
    );
  }

  const { access_token, refresh_token, expires_in, token_type, ...extra } = raw;
  return {
    accessToken: access_token,
    refreshToken: refresh_token ?? params.refreshToken,
    // We bail out at the top of this function when `!supportsRefresh`,
    // so by the time control reaches here `config.supportsRefresh` is
    // always `true` and the non-refreshable-provider branch from
    // `exchangeAuthorizationCode` would be dead code. Keep the simple
    // 1-hour default and let the original token-exchange path own the
    // non-expiring-token defense-in-depth.
    expiresIn: typeof expires_in === "number" ? expires_in : 3600,
    tokenType: token_type ?? "Bearer",
    extra,
  };
}

/** Best-effort token revocation. */
export async function revokeProviderToken(
  config: ProviderOAuthConfig,
  token: string,
): Promise<void> {
  if (!config.revokeUrl) {
    // Microsoft, Notion, Atlassian, Figma don't expose a public revoke
    // endpoint for native apps. Tessera revokes by deleting the local
    // token store; the user can revoke server-side via the provider's
    // app settings.
    return;
  }
  try {
    await fetch(
      `${config.revokeUrl}?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
  } catch {
    // best effort
  }
}
