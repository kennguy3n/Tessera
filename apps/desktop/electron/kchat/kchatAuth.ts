/**
 * KChat authentication flow.
 *
 * Encapsulates token persistence (OS keychain / encrypted file
 * fallback through `tokenVault.ts`), server-URL configuration, and
 * `KchatClient` lifecycle.
 *
 * **Security contract**:
 *   - The personal access token is stored encrypted in
 *     `tokenVault` keyed as the synthetic provider `"kchat"`.
 *   - The plaintext token NEVER returns to the renderer over IPC;
 *     IPC handlers receive only sanitized state through
 *     {@link KchatAuthService.getState} (which excludes the token).
 *   - Token mutation requires explicit calls (`connect`, `disconnect`)
 *     — there is no "expose token" API.
 *
 * **Single-instance**: callers (the IPC layer) construct one service
 * for the app lifetime; it owns the underlying `KchatClient`.
 */

import {
  deleteTokens,
  getTokens,
  hasTokens,
  storeTokens,
  StoredTokens,
} from "../tokenVault";
import { KchatClient, DEFAULT_KCHAT_SERVER } from "./kchatClient";
import { KchatConnectionState, KchatUser } from "./kchatTypes";

/** Synthetic provider key under which the KChat PAT is stored. */
export const KCHAT_VAULT_PROVIDER = "kchat";

/**
 * Persisted shape we layer on top of `StoredTokens`. We reuse
 * `accessToken` for the PAT (no refresh token; KChat PATs are
 * non-expiring until explicitly revoked) and stash the server URL
 * + KChat user id in `scopes` so a connection can be restored on
 * Tessera startup without an extra round-trip to KChat.
 */
interface KchatStoredAuth {
  token: string;
  serverUrl: string;
  /** KChat user id from the last successful `/users/me` probe. */
  userId: string;
  /** ISO-8601 of the last connection-verification. */
  verifiedAt: string;
}

/**
 * Container holding the `KchatClient` and persisting auth via the
 * shared `tokenVault`. Exposes a small surface (connect, disconnect,
 * state) that the IPC layer mounts directly.
 */
export class KchatAuthService {
  private readonly client: KchatClient;

  constructor(client: KchatClient = new KchatClient()) {
    this.client = client;
  }

  /** Underlying client (used by IPC handlers that need REST methods). */
  getClient(): KchatClient {
    return this.client;
  }

  /** Returns sanitized connection state (no token). */
  getState(): KchatConnectionState {
    return this.client.getState();
  }

  /** Subscribe to connection-state transitions. */
  onStatusChange(listener: (state: KchatConnectionState) => void): () => void {
    return this.client.onStatusChange(listener);
  }

  /** Returns true if a KChat PAT has been persisted in the vault. */
  hasStoredToken(): boolean {
    return hasTokens(KCHAT_VAULT_PROVIDER);
  }

  /**
   * Restore the persisted connection on app start. Decrypts the
   * stored token, hands it to the client, and re-verifies against
   * the configured server. Returns the verified user, or `null` if
   * no token is stored.
   *
   * Verification failures (revoked token, server unreachable) leave
   * the connection state as `error` and propagate the underlying
   * error to the caller; the stored token is NOT deleted — the user
   * may simply be offline and will reconnect later.
   */
  async restoreFromVault(): Promise<KchatUser | null> {
    const stored = readStoredAuth();
    if (!stored) return null;
    // `restoreFromVault` runs at startup, but it may also be
    // called manually after a long offline gap. In either case the
    // client may carry an active WS pinned to a previous server
    // URL or a previous token. `setServerUrl` and `setToken` both
    // now tear down the stale WS internally when the value changes
    // (see their docstrings), so we get a clean state here without
    // having to call `disconnectWebSocket()` explicitly.
    this.client.setServerUrl(stored.serverUrl);
    this.client.setToken(stored.token);
    const user = await this.client.verifyConnection();
    this.client.startHealthCheck();
    // Re-persist with refreshed verifiedAt so a `restore` after a
    // long offline gap accurately reflects "last known good".
    writeStoredAuth({
      token: stored.token,
      serverUrl: stored.serverUrl,
      userId: user.id,
      verifiedAt: new Date().toISOString(),
    });
    return user;
  }

  /**
   * Verify `token` against `serverUrl` and, ONLY on success, persist
   * it to the vault and start the periodic health check.
   *
   * Security ordering: the token is verified BEFORE it touches the
   * vault. On any verification failure (network error, 401, bad
   * server URL, etc.) the in-memory token is cleared and the error
   * propagates with no vault write — so a known-bad token can never
   * cause `restore()` to loop on an unauthenticated server. The
   * caller is responsible for prompting the user to retry; a
   * transient network blip costs a re-paste of the PAT, which is
   * the right trade-off because PATs are revocable and the failure
   * is loud.
   */
  async connect(token: string, serverUrl: string): Promise<KchatUser> {
    // Normalise at the boundary: trim once here so every downstream
    // path (in-memory `client.setToken`, vault persistence, future
    // callers that bypass the renderer) sees the canonical token
    // shape. Without this, a caller that pastes a PAT with stray
    // whitespace would land that whitespace in the keychain and the
    // Authorization header — KChat tolerates the leading space in
    // some builds but not all, producing intermittent 401s that are
    // hard to diagnose.
    const trimmedToken =
      typeof token === "string" ? token.trim() : "";
    if (trimmedToken.length === 0) {
      throw new Error("KChat token is required");
    }
    const url = (serverUrl || DEFAULT_KCHAT_SERVER).trim();

    // `setServerUrl` and `setToken` both now tear down any active
    // WebSocket internally when the value actually changes. That
    // means a re-`connect()` to a different KChat instance (e.g.
    // user switches from self-hosted to kchat.com in Settings)
    // cannot leave a stale WebSocket pointing at the old server
    // while REST calls move to the new one. The previous
    // implementation relied on the caller invoking `disconnect()`
    // first; the WS-teardown invariants make that implicit
    // requirement explicit at the client layer.
    //
    // We also explicitly stop the health check up-front, before
    // the URL/token mutations. This handles the corner case where
    // a user re-connects with the SAME url+token after a previous
    // connection degraded to `error` state: `setServerUrl(sameUrl)`
    // is a no-op (and does not stop the timer); `setToken(sameToken)`
    // is also a no-op for the same reason; and the previous health
    // check timer would still be running. Stopping it here ensures
    // exactly one timer ever exists — the one armed after the
    // verification below succeeds.
    this.client.stopHealthCheck();
    this.client.setServerUrl(url);
    this.client.setToken(trimmedToken);

    let user: KchatUser;
    try {
      user = await this.client.verifyConnection();
    } catch (err) {
      // Defence-in-depth ordering (sixth-pass Devin Review
      // ANALYSIS_0001): scrub the error message IN PLACE before
      // clearing the token in the client. `KchatClient.scrubMessage`
      // performs two redactions — (a) a literal-substring replace of
      // `this.token` with `[REDACTED]`, and (b) a generic
      // `Bearer \s+...` regex. Branch (a) is strictly stronger
      // because it catches the live PAT regardless of context
      // (URL-encoded, base64-fragmented, embedded inside a logged
      // header buffer, …), but it depends on `this.token` still
      // being non-null. If we cleared the token first and let the
      // error bubble through to the IPC layer's `toIpcError(err)`,
      // by the time the scrub ran branch (a) would be a no-op and
      // only the weaker generic regex would catch leakage — for any
      // future error path that embeds the PAT in a non-Bearer
      // shape (a URL query param, a JSON value, etc.) the redaction
      // would silently miss. By scrubbing here, with the live
      // token, the IPC-layer re-scrub (which still runs as
      // belt-and-braces) operates on an already-clean string.
      //
      // Today's `KchatRequestError` messages are built from
      // response metadata that doesn't contain the PAT, so this is
      // forward-looking insurance against a future code path that
      // does embed it (e.g. a server that echoes the auth header
      // in a 5xx body, a fetch error that includes a logged URL).
      if (err instanceof Error) {
        err.message = this.client.scrubMessage(err.message);
      }
      this.client.setToken(null);
      throw err;
    }

    writeStoredAuth({
      token: trimmedToken,
      serverUrl: url,
      userId: user.id,
      verifiedAt: new Date().toISOString(),
    });
    this.client.startHealthCheck();
    return user;
  }

  /**
   * Disconnect the KChat session. Stops the WebSocket + health
   * check, removes the token from the vault, and clears in-memory
   * state. Returns the KChat user id that was disconnected (for
   * audit logging).
   */
  disconnect(): string | null {
    const stored = readStoredAuth();
    const userId = stored?.userId ?? null;
    this.client.shutdown();
    deleteTokens(KCHAT_VAULT_PROVIDER);
    return userId;
  }
}

function readStoredAuth(): KchatStoredAuth | null {
  const raw = getTokens(KCHAT_VAULT_PROVIDER);
  if (!raw) return null;
  // Encoded shape: `accessToken` carries the PAT, `scopes` carries
  // a single-element JSON string holding `{ serverUrl, userId,
  // verifiedAt }`. We use this rather than a separate file so the
  // tokenVault recovery path (clear-on-keyring-loss) wipes the
  // KChat auth atomically with the rest of the vault.
  if (!raw.accessToken) return null;
  const meta = raw.scopes[0];
  if (!meta) {
    return {
      token: raw.accessToken,
      serverUrl: DEFAULT_KCHAT_SERVER,
      userId: "",
      verifiedAt: new Date(0).toISOString(),
    };
  }
  try {
    const parsed = JSON.parse(meta) as {
      serverUrl?: string;
      userId?: string;
      verifiedAt?: string;
    };
    return {
      token: raw.accessToken,
      serverUrl: parsed.serverUrl ?? DEFAULT_KCHAT_SERVER,
      userId: parsed.userId ?? "",
      verifiedAt: parsed.verifiedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return {
      token: raw.accessToken,
      serverUrl: DEFAULT_KCHAT_SERVER,
      userId: "",
      verifiedAt: new Date(0).toISOString(),
    };
  }
}

function writeStoredAuth(auth: KchatStoredAuth): void {
  const tokens: StoredTokens = {
    accessToken: auth.token,
    refreshToken: null,
    expiresAt: 0,
    scopes: [
      JSON.stringify({
        serverUrl: auth.serverUrl,
        userId: auth.userId,
        verifiedAt: auth.verifiedAt,
      }),
    ],
  };
  storeTokens(KCHAT_VAULT_PROVIDER, tokens);
}
