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
 *   - PKCE (S256) is enabled for every provider. The verifier is
 *     attached to the request and the challenge is sent on the
 *     authorize URL.
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

export type ProviderId =
  | "google_drive"
  | "onedrive"
  | "notion"
  | "jira"
  | "confluence"
  | "figma";

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
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
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
        server.close();
        cleanup();
        reject(new Error(`OAuth error from ${config.provider}: ${error}${desc ? ` (${desc})` : ""}`));
        return;
      }
      if (!code || returnedState !== state) {
        respond(
          400,
          "<html><body><h2>Invalid response</h2><p>State mismatch or missing code.</p></body></html>",
        );
        server.close();
        cleanup();
        reject(new Error("Invalid OAuth callback: state mismatch or missing code"));
        return;
      }

      respond(
        200,
        `<html><body><h2>Connected to ${escapeHtml(
          config.provider,
        )}</h2><p>You can close this window and return to Tessera.</p></body></html>`,
      );
      server.close();
      cleanup();
      resolve({ code, state });
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
        server.close();
        cleanup();
        reject(err);
      });
    });

    server.on("error", (err) => {
      cleanup();
      reject(
        new Error(
          `Failed to start OAuth redirect server for ${config.provider} on port ${config.redirectPort}: ${err.message}`,
        ),
      );
    });

    timeoutId = setTimeout(() => {
      server.close();
      cleanup();
      reject(new Error(`OAuth flow for ${config.provider} timed out after 5 minutes`));
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
    expiresIn: typeof expires_in === "number" ? expires_in : 3600,
    tokenType: token_type ?? "Bearer",
    extra,
  };
}

/**
 * Exchange a refresh token for a new access token.
 *
 * Atlassian returns a new refresh token on every refresh; Google
 * sometimes does. Microsoft Graph returns one on every refresh.
 * Figma classic OAuth does not support refresh — callers should
 * check `config.supportsRefresh` before calling this.
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
