/**
 * KChat authentication flow.
 *
 * Encapsulates token persistence (OS keychain / encrypted file
 * fallback through `tokenVault.ts`), server-URL configuration, and
 * `KchatClient` lifecycle. Phase 13 Task 4: now dual-mode —
 * supports BOTH a raw personal-access-token (PAT) connection AND
 * an extension-delegated connection bridged through a locally-
 * running `uney-chat-desktop` instance.
 *
 * **Auth modes**:
 *   - `pat` (existing): operator pastes a PAT in the Settings
 *     card. `connect(token, serverUrl)` verifies it against
 *     `/users/me` and persists it under provider `"kchat"` in
 *     `tokenVault`.
 *   - `extension` (Phase 13): Tessera asks the desktop app to
 *     mint a scoped delegation token via the extension bridge
 *     (see `kchatExtensionBridge.ts` /
 *     `kchatExtensionSession.ts`). The delegation lives under
 *     provider `"kchat-extension"` so a `disconnect()` in one
 *     mode leaves the other mode's vault entry intact, and the
 *     `kchat:status` IPC always reports the active mode via
 *     `authMode: "pat" | "extension"`.
 *
 * **Single-instance**: callers (the IPC layer) construct one
 * service for the app lifetime; it owns the underlying
 * `KchatClient` plus the optional extension session.
 *
 * **Security contract** (unchanged from PAT-only era):
 *   - Tokens (PAT or delegated) NEVER cross the IPC boundary out
 *     of the main process; IPC handlers receive only sanitised
 *     state through {@link KchatAuthService.getState}.
 *   - The delegation token's master credentials remain in the
 *     desktop app; Tessera holds only the derived token.
 *   - Concurrent attempts to connect in both modes are rejected
 *     — `connect()` and `connectViaExtension()` clear the other
 *     mode's state on entry so only one is active at a time.
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
import {
  ExtensionConnection,
  ExtensionProbeResult,
  probeExtension,
} from "./kchatExtensionBridge";
import {
  KchatExtensionSession,
  KCHAT_EXTENSION_VAULT_PROVIDER,
  ExtensionSessionInfo,
  RefreshFailureReason,
} from "./kchatExtensionSession";
import {
  attachExtensionEvents,
} from "./kchatExtensionEvents";

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
export type KchatAuthMode = "none" | "pat" | "extension";

/**
 * Factory used to build an `ExtensionConnection`. Injected so
 * tests can stub the transport without monkey-patching the
 * underlying `net.createConnection`.
 */
export type ExtensionConnectionFactory = () => ExtensionConnection;

/**
 * Container holding the `KchatClient` and persisting auth via the
 * shared `tokenVault`. Exposes a small surface (connect,
 * disconnect, state) that the IPC layer mounts directly.
 */
export class KchatAuthService {
  private readonly client: KchatClient;
  private readonly extensionFactory: ExtensionConnectionFactory;
  private readonly probeFn: (
    timeoutMs?: number,
  ) => Promise<ExtensionProbeResult>;
  private authMode: KchatAuthMode = "none";
  private extensionConnection: ExtensionConnection | null = null;
  private extensionSession: KchatExtensionSession | null = null;
  private extensionEventTeardown: (() => void) | null = null;
  private extensionRefreshFailureTeardown: (() => void) | null = null;
  private extensionDisconnectTeardown: (() => void) | null = null;
  private lastProbeResult: ExtensionProbeResult | null = null;

  constructor(
    client: KchatClient = new KchatClient(),
    opts: {
      extensionFactory?: ExtensionConnectionFactory;
      probeFn?: (timeoutMs?: number) => Promise<ExtensionProbeResult>;
    } = {},
  ) {
    this.client = client;
    this.extensionFactory =
      opts.extensionFactory ?? (() => new ExtensionConnection());
    this.probeFn = opts.probeFn ?? ((timeoutMs) => probeExtension({ timeoutMs }));
  }

  /** Underlying client (used by IPC handlers that need REST methods). */
  getClient(): KchatClient {
    return this.client;
  }

  /** Currently-active auth backend (`"none"` while disconnected). */
  getAuthMode(): KchatAuthMode {
    return this.authMode;
  }

  /** Cached extension-availability state (last probe result). */
  isExtensionAvailable(): boolean {
    return this.lastProbeResult?.available === true;
  }

  /**
   * Returns sanitised connection state (no token). Phase 13 Task 4:
   * decorated with `authMode` and `extensionAvailable` so the
   * `kchat:status` IPC handler can hand the state straight to the
   * renderer.
   */
  getState(): KchatConnectionState {
    const base = this.client.getState();
    return {
      ...base,
      authMode: this.authMode,
      extensionAvailable: this.isExtensionAvailable(),
    };
  }

  /**
   * Subscribe to connection-state transitions. Wraps the
   * underlying client listener so subscribers see the same
   * `authMode` + `extensionAvailable` decoration that
   * `getState()` returns.
   */
  onStatusChange(listener: (state: KchatConnectionState) => void): () => void {
    return this.client.onStatusChange((state) => {
      listener({
        ...state,
        authMode: this.authMode,
        extensionAvailable: this.isExtensionAvailable(),
      });
    });
  }

  /** Returns true if a KChat PAT has been persisted in the vault. */
  hasStoredToken(): boolean {
    return hasTokens(KCHAT_VAULT_PROVIDER);
  }

  /**
   * Returns true if an extension-delegated token is persisted in
   * the vault. Phase 13 Task 4.
   */
  hasStoredExtensionToken(): boolean {
    return hasTokens(KCHAT_EXTENSION_VAULT_PROVIDER);
  }

  /**
   * Probe the extension surface and update the cached
   * availability state. Returns the probe result so the IPC
   * layer can surface it to the renderer (`kchat:extensionStatus`).
   */
  async probeExtension(timeoutMs?: number): Promise<ExtensionProbeResult> {
    const result = await this.probeFn(timeoutMs);
    this.lastProbeResult = result;
    return result;
  }

  /**
   * Restore the persisted connection on app start. Phase 13 Task 4:
   * prefers an extension-delegated entry when both are present —
   * the desktop app is the more recent UX, and a stale PAT entry
   * left over from a previous session shouldn't shadow the
   * delegation. Returns the verified user, or `null` if no
   * connection is restorable.
   */
  async restoreFromVault(): Promise<KchatUser | null> {
    // Try extension restore first — it's the preferred mode when
    // both vault entries exist.
    if (hasTokens(KCHAT_EXTENSION_VAULT_PROVIDER)) {
      try {
        const user = await this.restoreExtensionFromVault();
        if (user) return user;
      } catch {
        // Extension restore failed (desktop app no longer running,
        // delegation expired, network blip). Fall through to the
        // PAT path so the user is not stranded.
      }
    }
    return await this.restorePatFromVault();
  }

  private async restorePatFromVault(): Promise<KchatUser | null> {
    const stored = readStoredAuth();
    if (!stored) return null;
    this.client.setServerUrl(stored.serverUrl);
    this.client.setToken(stored.token);
    const user = await this.client.verifyConnection();
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
   * Restore an extension-delegated connection on app start. Opens
   * the extension socket, re-attaches the event bridge, runs a
   * verifyConnection() to confirm the delegation token is still
   * accepted server-side, and arms the refresh timer. Returns
   * `null` if the stored delegation cannot be restored (e.g.
   * expired, desktop app not running, vault entry corrupt).
   */
  private async restoreExtensionFromVault(): Promise<KchatUser | null> {
    const conn = this.extensionFactory();
    let opened = false;
    try {
      await conn.open();
      opened = true;
    } catch {
      try {
        conn.close();
      } catch {
        // intentional — close is best-effort
      }
      return null;
    }
    const session = new KchatExtensionSession(conn);
    const restored = session.restoreFromVault();
    if (!restored) {
      if (opened) {
        try {
          conn.close();
        } catch {
          // intentional
        }
      }
      return null;
    }
    this.client.setServerUrl(restored.serverUrl);
    this.client.setToken(restored.token);
    let user: KchatUser;
    try {
      user = await this.client.verifyConnection();
    } catch (err) {
      // Delegation no longer accepted server-side. Clean up the
      // half-open socket + in-memory client; leave the vault
      // entry in place so the user can manually re-handshake from
      // Settings rather than silently losing the saved session.
      try {
        conn.close();
      } catch {
        // intentional
      }
      this.client.setToken(null);
      throw err;
    }
    this.attachExtensionConnection(conn, session);
    this.client.startHealthCheck();
    this.authMode = "extension";
    return user;
  }

  /**
   * Verify `token` against `serverUrl` and, ONLY on success, persist
   * it to the vault and start the periodic health check. PAT mode.
   *
   * Phase 13 Task 4: if an extension-delegated connection is
   * currently active, it is torn down BEFORE the PAT attempt so
   * the two modes never overlap (the IPC handler also gates this,
   * but we keep the invariant inside the service for tests + any
   * future caller).
   *
   * Security ordering: the token is verified BEFORE it touches the
   * vault. On any verification failure (network error, 401, bad
   * server URL, etc.) the in-memory token is cleared and the error
   * propagates with no vault write.
   */
  async connect(token: string, serverUrl: string): Promise<KchatUser> {
    if (this.authMode === "extension") {
      this.teardownExtension();
    }
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
   * Phase 13 Task 4 — connect through the `uney-chat-desktop`
   * extension bridge. Opens the extension socket, runs the
   * handshake, configures `KchatClient` with the delegated token
   * + server URL, verifies the delegation against `/users/me`,
   * and attaches the event bridge.
   *
   * If a PAT connection is currently active, it is torn down
   * first (mirroring `connect()`'s teardown of an active
   * extension session) so only one mode is ever live at a time.
   */
  async connectViaExtension(
    opts: {
      tesseraVersion?: string;
      scopesRequested?: readonly string[];
    } = {},
  ): Promise<KchatUser> {
    if (this.authMode === "pat") {
      // Tear down the PAT connection without deleting its vault
      // entry — operator may want to reconnect later with the
      // saved PAT. We must reset `authMode` to "none" here (not
      // just shut down the client) so that if any subsequent
      // step in this method throws (`conn.open()`,
      // `session.handshake()`, `verifyConnection()`), the auth
      // service doesn't end up reporting `{ state: "disconnected",
      // authMode: "pat" }` with a dead client — which is a
      // misleading combination since no PAT connection exists.
      // `authMode` will be re-set to "extension" at the end of
      // this method on success.
      this.client.shutdown();
      this.authMode = "none";
    }
    if (this.authMode === "extension") {
      this.teardownExtension();
    }
    const conn = this.extensionFactory();
    try {
      await conn.open();
    } catch (err) {
      try {
        conn.close();
      } catch {
        // intentional
      }
      throw err;
    }
    const session = new KchatExtensionSession(conn);
    let info: ExtensionSessionInfo;
    try {
      info = await session.handshake({
        tesseraVersion: opts.tesseraVersion,
        scopesRequested: opts.scopesRequested,
      });
    } catch (err) {
      try {
        conn.close();
      } catch {
        // intentional
      }
      throw err;
    }
    this.client.stopHealthCheck();
    this.client.setServerUrl(info.serverUrl);
    this.client.setToken(info.token);
    let user: KchatUser;
    try {
      user = await this.client.verifyConnection();
    } catch (err) {
      if (err instanceof Error) {
        err.message = this.client.scrubMessage(err.message);
      }
      this.client.setToken(null);
      // Roll back the delegation so we don't leave a half-set-up
      // vault entry — the desktop-app session is unaffected.
      try {
        session.disconnect();
      } catch {
        // intentional
      }
      try {
        conn.close();
      } catch {
        // intentional
      }
      throw err;
    }
    this.attachExtensionConnection(conn, session);
    this.client.startHealthCheck();
    this.authMode = "extension";
    return user;
  }

  /**
   * Disconnect the KChat session. Phase 13 Tasks 4 + 28: handles
   * both auth modes — PAT teardown deletes the PAT vault entry,
   * extension teardown deletes the delegation vault entry AND
   * closes the extension socket. Returns the KChat user id that
   * was disconnected (for audit logging).
   */
  disconnect(): string | null {
    let userId: string | null = null;
    if (this.authMode === "extension") {
      userId = this.extensionSession?.disconnect() ?? null;
      this.teardownExtensionConnection();
      this.client.shutdown();
      // Phase 13 Task 28: also wipe a PAT entry left over from a
      // previous PAT session that the user explicitly disconnected
      // from. The vault entry under `kchat` is NOT touched here —
      // a user toggling between modes shouldn't lose their saved
      // PAT just because they're disconnecting the extension. The
      // extension provider entry is wiped by
      // `KchatExtensionSession.disconnect()` above.
    } else {
      const stored = readStoredAuth();
      userId = stored?.userId ?? null;
      this.client.shutdown();
      deleteTokens(KCHAT_VAULT_PROVIDER);
    }
    this.authMode = "none";
    return userId;
  }

  /**
   * Phase 13 Task 28: tear down only the extension-mode state
   * without touching the PAT vault entry. Used internally when
   * switching from extension → PAT, and when the desktop app
   * notifies that it's shutting down mid-session.
   */
  private teardownExtension(): void {
    if (this.authMode !== "extension") return;
    this.extensionSession?.disconnect();
    this.teardownExtensionConnection();
    this.client.shutdown();
    this.authMode = "none";
  }

  private attachExtensionConnection(
    conn: ExtensionConnection,
    session: KchatExtensionSession,
  ): void {
    this.extensionConnection = conn;
    this.extensionSession = session;
    // Wire desktop-app events into the existing
    // `KchatClient.emitWebSocketEvent` fan-out (see
    // `kchatExtensionEvents.ts`). The forwarder + sidebar continue
    // to work unchanged.
    this.extensionEventTeardown = attachExtensionEvents(conn, (event) =>
      this.client.emitWebSocketEvent(event),
    );
    this.extensionRefreshFailureTeardown = session.onRefreshFailure(
      (reason: RefreshFailureReason, err: Error) => {
        this.handleExtensionRefreshFailure(reason, err);
      },
    );
    this.extensionDisconnectTeardown = conn.onDisconnect((reason) => {
      this.handleExtensionDisconnect(reason);
    });
  }

  private teardownExtensionConnection(): void {
    this.extensionEventTeardown?.();
    this.extensionRefreshFailureTeardown?.();
    this.extensionDisconnectTeardown?.();
    this.extensionEventTeardown = null;
    this.extensionRefreshFailureTeardown = null;
    this.extensionDisconnectTeardown = null;
    try {
      this.extensionConnection?.close();
    } catch {
      // intentional — close is best-effort
    }
    this.extensionConnection = null;
    this.extensionSession = null;
  }

  private handleExtensionRefreshFailure(
    _reason: RefreshFailureReason,
    err: Error,
  ): void {
    // Refresh failure → transition the client to `error` state so
    // the renderer's sidebar / Settings card shows the disconnect.
    // The vault entry survives so the user can manually
    // reconnect (the saved delegation may simply need a fresh
    // handshake).
    this.client.shutdown();
    this.teardownExtensionConnection();
    this.authMode = "none";
    // Re-surface the underlying message through the client so the
    // status push has the same error shape as PAT-side failures.
    this.client.emitExtensionAuthError(
      `KChat Desktop session refresh failed: ${err.message}`,
    );
  }

  private handleExtensionDisconnect(reason: string): void {
    if (this.authMode !== "extension") return;
    this.teardownExtensionConnection();
    this.client.shutdown();
    this.authMode = "none";
    this.client.emitExtensionAuthError(
      `KChat Desktop disconnected (${reason})`,
    );
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
