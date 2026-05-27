/**
 * uney-chat-desktop extension session handoff + token lifecycle.
 *
 * Phase 13 Task 2. Once `kchatExtensionBridge.ts` has discovered
 * the desktop app, this module performs the *session handoff*:
 *
 *   1. Send a `handshake` frame asking the desktop app to mint a
 *      scoped, time-limited delegation token bound to the
 *      currently-authenticated KChat user.
 *
 *   2. Validate the response shape AND the embedded `serverUrl`
 *      through the same SSRF guard the PAT path uses
 *      (`enforceKchatServerUrl`). A handshake response that
 *      points at a private/loopback address is rejected with the
 *      same "set TESSERA_KCHAT_ALLOW_INTERNAL=1 to override" UX —
 *      the trust boundary is identical between the two auth modes.
 *
 *   3. Store the token under provider `kchat:extension` in the
 *      existing `tokenVault`. The `scopes[0]` slot carries the
 *      metadata envelope (`serverUrl`, `userId`, `username`,
 *      `expiresAtMs`, `scopesGranted`) — same convention as the
 *      PAT path's `kchat` provider entry, so the renderer's
 *      "Connected via …" affordance and the audit-trail
 *      `KchatExtensionConnected` row share a single source of
 *      truth.
 *
 *   4. Schedule a refresh timer that fires shortly before
 *      `expiresAtMs`. The refresh re-uses the existing
 *      `ExtensionConnection` (no new handshake) so the desktop
 *      app does not see a churn of new sessions when Tessera is
 *      simply renewing a delegation. Refresh failure transitions
 *      the session to `disconnected` and surfaces a typed error
 *      back to `KchatAuthService` for UI display.
 *
 *   5. `disconnect()` deletes the vault entry, cancels the
 *      refresh timer, and closes the underlying connection — same
 *      teardown shape as the PAT path's `disconnect()`. Phase 13
 *      Task 28 wires the extension-mode cleanup through the
 *      `KchatAuthService.disconnect` orchestrator so a single call
 *      tears down both auth modes cleanly when the user toggles
 *      between them.
 *
 * **Security**: the desktop app's master credentials NEVER cross
 * the extension boundary. Tessera asks for a delegation, and the
 * desktop app responds with a scoped derived token (analogous to
 * OAuth's "exchange refresh for short-lived access token"). The
 * vault entry stores only the derived token; revoking the vault
 * entry revokes Tessera's access without touching the desktop
 * app's session.
 */

import {
  ExtensionConnection,
  HandshakeRequestFrame,
  HandshakeResponseFrame,
  TokenRefreshResponseFrame,
} from "./kchatExtensionBridge";
import { enforceKchatServerUrl } from "./ssrfGuard";
import {
  deleteTokens,
  getTokens,
  hasTokens,
  storeTokens,
} from "../tokenVault";

/** Vault provider tag for extension-delegated tokens. */
export const KCHAT_EXTENSION_VAULT_PROVIDER = "kchat-extension";

/** Default scope set Tessera asks for at handshake. */
export const DEFAULT_HANDSHAKE_SCOPES: readonly string[] = [
  "kchat:teams.read",
  "kchat:channels.read",
  "kchat:files.read",
  "kchat:posts.read",
  "kchat:posts.write",
  "kchat:events.subscribe",
];

/**
 * Refresh the delegation token this many milliseconds before
 * `expiresAtMs`. 30 seconds is a comfortable margin: the typical
 * delegation lasts 15+ minutes, so 30 s is well below the floor
 * but well above the round-trip cost of refresh under load.
 */
const REFRESH_MARGIN_MS = 30_000;

/**
 * Floor on refresh-timer delay. The desktop app may mint a token
 * with `expiresAtMs` already inside the margin (e.g. on a clock
 * skew); we still schedule a refresh, but at least 1 second out
 * to avoid a tight loop.
 */
const REFRESH_MIN_DELAY_MS = 1_000;

/**
 * Result of `handshake()`. The renderer uses these fields to
 * decorate the Settings card ("Connected via KChat Desktop as
 * <username>"); `KchatAuthService` uses `serverUrl` + `token` to
 * configure the underlying `KchatClient`.
 */
export interface ExtensionSessionInfo {
  user: {
    id: string;
    username: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  serverUrl: string;
  token: string;
  expiresAtMs: number;
  scopesGranted: string[];
}

/**
 * Reason a refresh failed. Surfaced to `KchatAuthService` so the
 * UI can pick a sensible message:
 *   - `"bridge-unavailable"`: the desktop app is no longer
 *     reachable; UI should show "KChat Desktop disconnected".
 *   - `"refresh-rejected"`: the desktop app rejected the
 *     refresh (e.g. user revoked Tessera's access from the
 *     desktop-app UI).
 *   - `"timeout"`: refresh request did not get a response.
 *   - `"protocol-error"`: response shape was wrong.
 */
export type RefreshFailureReason =
  | "bridge-unavailable"
  | "refresh-rejected"
  | "timeout"
  | "protocol-error";

/**
 * Manages a single extension-delegated session: handshake, token
 * lifecycle, vault persistence, refresh scheduling, disconnect
 * cleanup. Stateful — a process holds at most one instance at a
 * time, owned by `KchatAuthService`.
 */
export class KchatExtensionSession {
  private current: ExtensionSessionInfo | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private refreshFailureListeners = new Set<
    (reason: RefreshFailureReason, err: Error) => void
  >();

  constructor(private readonly connection: ExtensionConnection) {}

  /** Returns the active session info or `null` when disconnected. */
  getSessionInfo(): ExtensionSessionInfo | null {
    return this.current;
  }

  /**
   * Subscribe to refresh-failure notifications. The session is
   * already in the disconnected state by the time the listener
   * fires (token cleared, refresh timer cleared, vault entry
   * still present so the user can manually re-handshake).
   */
  onRefreshFailure(
    listener: (reason: RefreshFailureReason, err: Error) => void,
  ): () => void {
    this.refreshFailureListeners.add(listener);
    return () => {
      this.refreshFailureListeners.delete(listener);
    };
  }

  /**
   * Run the initial handshake. The caller must have already
   * `await conn.open()`ed the connection. Stores the resulting
   * token in `tokenVault` and starts the refresh timer.
   */
  async handshake(
    options: {
      tesseraVersion?: string;
      scopesRequested?: readonly string[];
    } = {},
  ): Promise<ExtensionSessionInfo> {
    const req: HandshakeRequestFrame = {
      type: "handshake",
      tesseraVersion: options.tesseraVersion ?? "tessera/unknown",
      scopesRequested: [
        ...(options.scopesRequested ?? DEFAULT_HANDSHAKE_SCOPES),
      ],
      requestId: "",
    };
    const resp = (await this.connection.request<HandshakeResponseFrame>(
      req,
    )) as HandshakeResponseFrame;
    const info = await validateHandshakeResponse(resp);
    this.persist(info);
    this.scheduleRefresh(info.expiresAtMs);
    return info;
  }

  /**
   * Re-establish the in-memory session from the vault entry on
   * application start. Returns the persisted info (or `null` if
   * the entry is absent / corrupt / expired). Does NOT re-run the
   * handshake — the caller is expected to verify the token by
   * calling the underlying `KchatClient.verifyConnection()` next.
   */
  restoreFromVault(): ExtensionSessionInfo | null {
    if (!hasTokens(KCHAT_EXTENSION_VAULT_PROVIDER)) return null;
    const tokens = getTokens(KCHAT_EXTENSION_VAULT_PROVIDER);
    if (!tokens) return null;
    let meta: {
      serverUrl?: string;
      userId?: string;
      username?: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      expiresAtMs?: number;
      scopesGranted?: string[];
    };
    try {
      meta = JSON.parse(tokens.scopes[0] ?? "{}");
    } catch {
      return null;
    }
    if (
      typeof meta.serverUrl !== "string" ||
      typeof meta.userId !== "string" ||
      typeof meta.username !== "string" ||
      typeof meta.email !== "string" ||
      typeof meta.firstName !== "string" ||
      typeof meta.lastName !== "string" ||
      typeof meta.expiresAtMs !== "number" ||
      !Array.isArray(meta.scopesGranted)
    ) {
      return null;
    }
    // Don't restore an already-expired delegation — the caller
    // would just have to refresh anyway, and a stale serverUrl
    // is better caught at refresh time than at first request.
    if (Date.now() >= meta.expiresAtMs) {
      return null;
    }
    const info: ExtensionSessionInfo = {
      user: {
        id: meta.userId,
        username: meta.username,
        email: meta.email,
        firstName: meta.firstName,
        lastName: meta.lastName,
      },
      serverUrl: meta.serverUrl,
      token: tokens.accessToken,
      expiresAtMs: meta.expiresAtMs,
      scopesGranted: meta.scopesGranted.filter((s) => typeof s === "string"),
    };
    this.current = info;
    this.scheduleRefresh(info.expiresAtMs);
    return info;
  }

  /**
   * Tear down the session. Phase 13 Task 28: the extension-mode
   * cleanup path. Deletes the vault entry, cancels the refresh
   * timer, and notifies the caller — the underlying
   * `ExtensionConnection` is NOT closed here because the
   * connection may be shared with other surfaces (event bridge);
   * the orchestrator (`KchatAuthService.disconnect`) is
   * responsible for closing the connection.
   *
   * Returns the user id that was disconnected, or `null` if there
   * was no active session — the auth service uses this to populate
   * the audit row.
   */
  disconnect(): string | null {
    const userId = this.current?.user.id ?? null;
    this.cancelRefresh();
    this.current = null;
    if (hasTokens(KCHAT_EXTENSION_VAULT_PROVIDER)) {
      deleteTokens(KCHAT_EXTENSION_VAULT_PROVIDER);
    }
    return userId;
  }

  /**
   * Manually trigger a refresh. The auto-refresh timer calls this
   * internally; the IPC layer can also invoke it (e.g. on an
   * explicit "reconnect" action from Settings).
   */
  async refresh(): Promise<ExtensionSessionInfo> {
    if (!this.current) {
      throw new Error("KchatExtensionSession: no active session to refresh");
    }
    let resp: TokenRefreshResponseFrame;
    try {
      resp = await this.connection.request<TokenRefreshResponseFrame>({
        type: "token_refresh",
        requestId: "",
      });
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      const reason: RefreshFailureReason =
        /timed out/i.test(wrapped.message)
          ? "timeout"
          : /not open|closed/i.test(wrapped.message)
            ? "bridge-unavailable"
            : "protocol-error";
      this.handleRefreshFailure(reason, wrapped);
      throw wrapped;
    }
    if (!resp.ok || !resp.token || typeof resp.expiresAtMs !== "number") {
      const wrapped = new Error(
        resp.error || "KchatExtensionSession: refresh rejected",
      );
      this.handleRefreshFailure("refresh-rejected", wrapped);
      throw wrapped;
    }
    if (resp.expiresAtMs <= Date.now()) {
      const wrapped = new Error(
        "KchatExtensionSession: refresh returned an already-expired token",
      );
      this.handleRefreshFailure("protocol-error", wrapped);
      throw wrapped;
    }
    const renewed: ExtensionSessionInfo = {
      ...this.current,
      token: resp.token,
      expiresAtMs: resp.expiresAtMs,
    };
    this.persist(renewed);
    this.scheduleRefresh(renewed.expiresAtMs);
    return renewed;
  }

  private persist(info: ExtensionSessionInfo): void {
    this.current = info;
    storeTokens(KCHAT_EXTENSION_VAULT_PROVIDER, {
      accessToken: info.token,
      refreshToken: null,
      expiresAt: info.expiresAtMs,
      scopes: [
        JSON.stringify({
          serverUrl: info.serverUrl,
          userId: info.user.id,
          username: info.user.username,
          email: info.user.email,
          firstName: info.user.firstName,
          lastName: info.user.lastName,
          expiresAtMs: info.expiresAtMs,
          scopesGranted: info.scopesGranted,
        }),
      ],
    });
  }

  private scheduleRefresh(expiresAtMs: number): void {
    this.cancelRefresh();
    const delay = Math.max(
      REFRESH_MIN_DELAY_MS,
      expiresAtMs - Date.now() - REFRESH_MARGIN_MS,
    );
    this.refreshTimer = setTimeout(() => {
      void this.refresh().catch(() => {
        // refresh() already surfaced the failure via the listener
        // set; swallow here so the timer callback does not warn
        // on the unhandled rejection.
      });
    }, delay);
    // Allow the process to exit even with a pending refresh —
    // an in-flight refresh should not pin the event loop.
    this.refreshTimer.unref?.();
  }

  private cancelRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private handleRefreshFailure(
    reason: RefreshFailureReason,
    err: Error,
  ): void {
    this.cancelRefresh();
    this.current = null;
    for (const l of this.refreshFailureListeners) {
      try {
        l(reason, err);
      } catch {
        // intentional — listeners must not throw
      }
    }
  }
}

/**
 * Validate a `handshake_response` frame and shape it into a
 * `ExtensionSessionInfo`. SSRF check applies to the embedded
 * `serverUrl` — same policy as the PAT path's `kchat:connect`.
 * Exported for the unit-test suite (`kchatExtension.test.ts`).
 */
export async function validateHandshakeResponse(
  resp: HandshakeResponseFrame,
): Promise<ExtensionSessionInfo> {
  if (!resp || resp.type !== "handshake_response") {
    throw new Error("KchatExtensionSession: missing handshake response");
  }
  if (!resp.ok) {
    throw new Error(
      resp.error || "KchatExtensionSession: handshake rejected by desktop app",
    );
  }
  if (!resp.user || typeof resp.user !== "object") {
    throw new Error("KchatExtensionSession: handshake response missing user");
  }
  const u = resp.user;
  if (
    typeof u.id !== "string" ||
    typeof u.username !== "string" ||
    typeof u.email !== "string" ||
    typeof u.firstName !== "string" ||
    typeof u.lastName !== "string"
  ) {
    throw new Error("KchatExtensionSession: handshake response user is malformed");
  }
  if (typeof resp.token !== "string" || resp.token.length === 0) {
    throw new Error("KchatExtensionSession: handshake response missing token");
  }
  if (typeof resp.expiresAtMs !== "number" || resp.expiresAtMs <= Date.now()) {
    throw new Error(
      "KchatExtensionSession: handshake response missing or expired token expiry",
    );
  }
  if (typeof resp.serverUrl !== "string") {
    throw new Error("KchatExtensionSession: handshake response missing serverUrl");
  }
  // SSRF guard — symmetric with the PAT path's `kchat:connect`.
  // A delegated session that points at a private/loopback address
  // is rejected just like a PAT user typing the same URL would be.
  await enforceKchatServerUrl(resp.serverUrl);
  const scopes = Array.isArray(resp.scopesGranted)
    ? resp.scopesGranted.filter((s) => typeof s === "string")
    : [];
  return {
    user: {
      id: u.id,
      username: u.username,
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
    },
    serverUrl: resp.serverUrl,
    token: resp.token,
    expiresAtMs: resp.expiresAtMs,
    scopesGranted: scopes,
  };
}
