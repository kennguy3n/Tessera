/**
 * KChat authentication flow.
 *
 * Encapsulates token persistence (OS keychain / encrypted file
 * fallback through `tokenVault.ts`), server-URL configuration, and
 * `KchatClient` lifecycle. Phase 14 — single mode: every Tessera
 * connection is authenticated by a Personal Access Token (PAT) the
 * user pastes into the Settings card. The previous extension-bridge
 * delegation path (Phase 13) has been removed: KChat Desktop and
 * Tessera now talk to the KChat server independently, and the only
 * cross-app cooperation is through the `.kcz` extension Tessera
 * ships into KChat Desktop (see
 * `extensions/tessera-kchat/`) plus the `tessera://` deeplink
 * scheme.
 *
 * **Single-instance**: callers (the IPC layer) construct one
 * service for the app lifetime; it owns the underlying
 * `KchatClient`.
 *
 * **Security contract**:
 *   - The PAT NEVER crosses the IPC boundary out of the main
 *     process; IPC handlers receive only sanitised state through
 *     `KchatAuthService.getState()`.
 *   - `connect()` verifies the token BEFORE persisting it. Any
 *     verification failure clears the in-memory token and the
 *     vault is left untouched.
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

/** Auth backend currently powering the connection. */
export type KchatAuthMode = "none" | "pat";

/**
 * Container holding the `KchatClient` and persisting auth via the
 * shared `tokenVault`. Exposes a small surface (connect,
 * disconnect, state) that the IPC layer mounts directly.
 */
export class KchatAuthService {
  private readonly client: KchatClient;
  private authMode: KchatAuthMode = "none";

  constructor(client: KchatClient = new KchatClient()) {
    this.client = client;
  }

  /** Underlying client (used by IPC handlers that need REST methods). */
  getClient(): KchatClient {
    return this.client;
  }

  /** Currently-active auth backend (`"none"` while disconnected). */
  getAuthMode(): KchatAuthMode {
    return this.authMode;
  }

  /**
   * Returns sanitised connection state (no token). Decorated with
   * `authMode` so the renderer can render a "Connected via PAT"
   * vs disconnected affordance.
   */
  getState(): KchatConnectionState {
    const base = this.client.getState();
    return {
      ...base,
      authMode: this.authMode,
    };
  }

  /**
   * Subscribe to connection-state transitions. Wraps the
   * underlying client listener so subscribers see the same
   * `authMode` decoration that `getState()` returns.
   */
  onStatusChange(listener: (state: KchatConnectionState) => void): () => void {
    return this.client.onStatusChange((state) => {
      listener({
        ...state,
        authMode: this.authMode,
      });
    });
  }

  /** Returns true if a KChat PAT has been persisted in the vault. */
  hasStoredToken(): boolean {
    return hasTokens(KCHAT_VAULT_PROVIDER);
  }

  /**
   * Restore the persisted PAT connection on app start.
   *
   * On `verifyConnection()` failure, the in-memory token and
   * serverUrl that were just pushed into the client are rolled
   * back so the client's view matches the auth-service view
   * (`authMode === "none"`, no live PAT). This mirrors the
   * symmetric cleanup in `connect()` and prevents a stale token
   * from lingering on the client across a failed restore — even
   * though the practical fallout is small (the health check is
   * never started, and any subsequent `connect()` overwrites the
   * client state), the asymmetry was a footgun: a future caller
   * inspecting `client.getToken()` between a failed restore and
   * the next connect would see a token that no auth code thinks
   * is valid. Per Phase 14 Round 7 Devin Review ANALYSIS_0002.
   *
   * Note: the vault entry is intentionally NOT deleted on failure
   * — a failed restore (e.g. transient network blip on startup)
   * should leave the stored credential intact so a later
   * `restoreFromVault()` can recover the prior session. Only an
   * explicit `disconnect()` clears the vault.
   */
  async restoreFromVault(): Promise<KchatUser | null> {
    const stored = readStoredAuth();
    if (!stored) return null;
    this.client.setServerUrl(stored.serverUrl);
    this.client.setToken(stored.token);
    let user: KchatUser;
    try {
      user = await this.client.verifyConnection();
    } catch (err) {
      // Symmetric with `connect()` (see below): on verification
      // failure, drop the just-pushed in-memory token so the
      // client's view matches the auth-service view. `authMode`
      // is already "none" here (we never advanced it), so no
      // status push needs to be emitted.
      this.client.setToken(null);
      throw err;
    }
    this.client.startHealthCheck();
    this.authMode = "pat";
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
   * propagates with no vault write.
   */
  async connect(token: string, serverUrl: string): Promise<KchatUser> {
    const trimmedToken =
      typeof token === "string" ? token.trim() : "";
    if (trimmedToken.length === 0) {
      throw new Error("KChat token is required");
    }
    const url = (serverUrl || DEFAULT_KCHAT_SERVER).trim();

    this.client.stopHealthCheck();
    this.client.setServerUrl(url);
    this.client.setToken(trimmedToken);

    let user: KchatUser;
    try {
      user = await this.client.verifyConnection();
    } catch (err) {
      if (err instanceof Error) {
        err.message = this.client.scrubMessage(err.message);
      }
      // Phase 14 Round 5 Devin Review ANALYSIS_0002: when a caller
      // re-runs `connect()` from an already-connected `authMode === "pat"`
      // session and the new token fails `verifyConnection()`,
      // `getState()` would otherwise report
      // `{ state: "error", authMode: "pat" }` — a misleading projection
      // because no PAT is in memory and the health check was stopped at
      // the top of this function. Resetting `authMode` BEFORE
      // `setToken(null)` is load-bearing: `onStatusChange` wraps every
      // client state-push with `{ ...state, authMode: this.authMode }`,
      // so reordering would emit a push carrying the stale
      // `authMode: "pat"` to the renderer. Same ordering rationale as
      // `disconnect()` below. The vault entry is intentionally NOT
      // cleared here — a failed re-connect should not wipe the
      // previously-good stored credential; the user can re-run
      // `restoreFromVault()` to recover the prior session.
      this.authMode = "none";
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
    this.authMode = "pat";
    return user;
  }

  /**
   * Disconnect the KChat session. Deletes the PAT vault entry and
   * shuts the client down. Returns the KChat user id that was
   * disconnected (for audit logging), or `null` if no connection
   * was active.
   */
  disconnect(): string | null {
    // Idempotent: a redundant `disconnect()` call (UI rerender that
    // fires the action twice, automation that defensively
    // disconnects on app close) is a no-op so the vault entry is
    // not accidentally wiped on the second call.
    if (this.authMode === "none") {
      return null;
    }
    const stored = readStoredAuth();
    const userId = stored?.userId ?? null;
    // Clear `authMode` before `shutdown()` so the disconnected
    // status push carries the post-disconnect authMode value. The
    // `onStatusChange` wrapper reads `this.authMode` at emit time;
    // without this ordering subscribers would see a stale
    // `{ state: "disconnected", authMode: "pat" }` push before the
    // final `authMode: "none"` push.
    this.authMode = "none";
    this.client.shutdown();
    deleteTokens(KCHAT_VAULT_PROVIDER);
    return userId;
  }
}

function readStoredAuth(): KchatStoredAuth | null {
  const raw = getTokens(KCHAT_VAULT_PROVIDER);
  if (!raw) return null;
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
