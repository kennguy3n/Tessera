/**
 * Main-process KChat REST + WebSocket client.
 *
 * Lives entirely in the Electron main process. The personal access
 * token is read from `tokenVault` at request time and is NEVER
 * passed back to the renderer — the renderer only sees parsed
 * response bodies through the IPC handlers in `ipc/kchat.ts`.
 *
 * Reliability primitives:
 *   - Rate limiter (the shared token-bucket from `ipc/rateLimiter.ts`)
 *     scoped by `kchat:request` / `kchat:upload` to keep us well
 *     under the KChat server-side throttle (7000 req/s, burst 100).
 *   - Exponential backoff with jitter on 408 / 429 / 500–504.
 *   - 30-second connection health check on `/api/v4/users/me`.
 *   - WebSocket reconnection with cap-and-jitter backoff.
 *
 * The implementation uses Node's global `fetch` and `WebSocket` (Node
 * 22+ in the Electron 33 main process). No third-party HTTP / WS
 * libraries are pulled in — keeps the supply-chain footprint small.
 */

import {
  KchatChannel,
  KchatChannelMember,
  KchatConnectionState,
  KchatFileInfo,
  KchatFileUploadResponse,
  KchatTeam,
  KchatUser,
  KchatWebSocketEvent,
} from "./kchatTypes";
import {
  RATE_LIMIT_PROFILES,
  RateLimiter,
  defaultRateLimiter,
} from "../ipc/rateLimiter";

/** Default KChat-hosted endpoint. Self-hosted servers override via `setServerUrl`. */
export const DEFAULT_KCHAT_SERVER = "https://kchat.com";

/** Status codes treated as transient and retried with backoff. */
const RETRYABLE_STATUSES = new Set<number>([408, 429, 500, 502, 503, 504]);

/** Total attempts before a retryable failure is surfaced to the caller. */
const MAX_ATTEMPTS = 4;

/** Base backoff in milliseconds; doubles each attempt with ±20% jitter. */
const BACKOFF_BASE_MS = 250;

/** Maximum single backoff sleep. Prevents pathological 30-second pauses. */
const BACKOFF_CAP_MS = 5_000;

/** Interval between proactive `/users/me` health pings. */
const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** Backoff seed for the WebSocket reconnect loop. */
const WS_RECONNECT_BASE_MS = 500;

/** Cap on the WebSocket reconnect interval. */
const WS_RECONNECT_CAP_MS = 30_000;

/**
 * Sleep helper that can be mocked from tests by passing a custom
 * `sleep` implementation through {@link KchatClientOptions}.
 */
type SleepFn = (ms: number) => Promise<void>;

/**
 * Minimal `fetch` shape we depend on. The Node 22 global `fetch`
 * satisfies this; tests inject their own implementation.
 */
type FetchFn = typeof globalThis.fetch;

/** Pluggable WebSocket constructor; tests inject a stub. */
type WebSocketCtor = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/** The subset of the WS API surface we use. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Constructor options surfaced for dependency-injection in tests. */
export interface KchatClientOptions {
  /** Override the default `fetch` (used in tests). */
  fetchFn?: FetchFn;
  /** Override the default `WebSocket` (used in tests). */
  webSocketCtor?: WebSocketCtor;
  /** Shared rate limiter; defaults to the IPC-wide singleton. */
  rateLimiter?: RateLimiter;
  /** Sleep impl for backoff; defaults to `setTimeout`. */
  sleep?: SleepFn;
  /** Now-source for backoff jitter; defaults to `Math.random`. */
  random?: () => number;
}

/** Listener for the parsed WebSocket events. */
export type KchatWebSocketListener = (event: KchatWebSocketEvent) => void;

/** Listener for connection-state changes. */
export type KchatStatusListener = (state: KchatConnectionState) => void;

/**
 * Reject strings containing CR or LF before they reach the wire.
 * Used to guard multipart request bodies against header-injection
 * attacks if a future caller bypasses upstream validators.
 */
function assertNoCRLF(value: string, name: string): void {
  if (typeof value !== "string") {
    throw new Error(`KChat ${name} must be a string`);
  }
  if (value.indexOf("\r") !== -1 || value.indexOf("\n") !== -1) {
    throw new Error(`KChat ${name} must not contain CR or LF`);
  }
}

/**
 * Error thrown when a request is rejected after exhausting retries
 * or when the response status is non-2xx and not retryable.
 */
export class KchatRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly endpoint: string,
    body: string,
  ) {
    super(`KChat ${status} ${statusText} at ${endpoint}: ${body.slice(0, 256)}`);
    this.name = "KchatRequestError";
  }
}

/**
 * Shape of a KChat (Mattermost) object id: 20–32 lowercase
 * alphanumerics. The REST API consistently emits 26-char ids, but
 * we tolerate the documented 20–32 range to stay forward-compatible
 * with the server's stated invariant rather than over-fitting to
 * the current implementation.
 *
 * This regex is reused for renderer-supplied ids (via the IPC
 * validator `assertKchatId`) AND for server-supplied ids that are
 * about to be interpolated into a URL path or filename (via
 * {@link assertKchatServerObjectId}).
 */
const KCHAT_OBJECT_ID_RE = /^[a-z0-9]{20,32}$/;

/**
 * Validate a KChat object id that originated from the **server**
 * (e.g. an `id` field on a `KchatFileInfo` returned by
 * `listChannelFiles`). The renderer-facing IPC validator
 * `assertKchatId` covers ids that came in over IPC; this helper
 * covers the trust boundary on the other side of the client.
 *
 * Per the documented threat model, the KChat server is trusted to
 * authenticate the user but its response bodies are otherwise
 * treated as untrusted — a compromised or malicious server could
 * emit ids containing `../`, `?`, `#`, or other URL-control bytes
 * to alter request paths. Rejecting anything that does not match
 * the published id shape closes that vector at the network
 * boundary regardless of any defence-in-depth checks downstream.
 */
export function assertKchatServerObjectId(
  value: unknown,
  name: string,
): string {
  if (typeof value !== "string") {
    throw new KchatRequestError(
      502,
      "Malformed server response",
      name,
      `${name} must be a string, got ${typeof value}`,
    );
  }
  if (!KCHAT_OBJECT_ID_RE.test(value)) {
    throw new KchatRequestError(
      502,
      "Malformed server response",
      name,
      `${name} is not a valid KChat object id`,
    );
  }
  return value;
}

/**
 * Escape every regex metacharacter so the value is matched
 * literally when used inside `new RegExp(...)`. Used by
 * {@link KchatClient.scrubMessage} to redact the active token
 * regardless of which special characters KChat happens to use in
 * its PAT format.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * KChat REST + WebSocket client.
 *
 * The client is **stateful** — it owns the server URL, the active
 * token (in-memory ref to the value `tokenVault.getTokens` returned),
 * the WebSocket connection, the health-check timer, and the current
 * `KchatConnectionState`. The IPC layer holds a single instance.
 */
export class KchatClient {
  private serverUrl: string = DEFAULT_KCHAT_SERVER;
  private token: string | null = null;
  private user: KchatUser | null = null;
  private ws: WebSocketLike | null = null;
  private wsSeq = 1;
  private wsListeners = new Set<KchatWebSocketListener>();
  private statusListeners = new Set<KchatStatusListener>();
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsReconnectAttempt = 0;
  private wsClosedByUser = false;
  private connectionState: KchatConnectionState = { state: "disconnected" };

  private readonly fetchFn: FetchFn;
  private readonly webSocketCtor: WebSocketCtor | null;
  private readonly rateLimiter: RateLimiter;
  private readonly sleep: SleepFn;
  private readonly random: () => number;

  constructor(options: KchatClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    // WebSocket may not be available in every test env; the client
    // still works for REST-only callers when it's null.
    this.webSocketCtor =
      options.webSocketCtor ??
      (typeof globalThis.WebSocket === "function"
        ? (globalThis.WebSocket as unknown as WebSocketCtor)
        : null);
    this.rateLimiter = options.rateLimiter ?? defaultRateLimiter;
    this.sleep =
      options.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    this.random = options.random ?? Math.random;
  }

  /**
   * Replace the configured KChat server URL. Used for self-hosted
   * setups and reconnect-to-a-different-server flows.
   *
   * **Invariant**: changing the server URL ALSO tears down the
   * current WebSocket. Without this, a caller that points the
   * client at a new server (e.g. `KchatAuthService.connect()`
   * after a server-URL change in Settings) would leave the WS
   * pinned to the old server while REST calls switch over —
   * silently sourcing real-time events from the wrong account.
   * The cost is one extra reconnect when the URL genuinely
   * changes, which is cheap and explicit. URL-equal calls are
   * no-ops (we compare AFTER trailing-slash normalisation), so
   * idempotent callers do not incur a reconnect.
   */
  setServerUrl(url: string): void {
    // Trim trailing slash so endpoint concatenation produces clean URLs.
    const next = url.replace(/\/+$/, "") || DEFAULT_KCHAT_SERVER;
    if (next !== this.serverUrl) {
      this.disconnectWebSocket();
      // The health check was probing the old server; its next tick
      // would race against the new server's setup. Stop it here so
      // the caller's `startHealthCheck()` after the new connection
      // is verified is the only timer running.
      this.stopHealthCheck();
      // Any cached user identity belonged to the old server.
      this.user = null;
    }
    this.serverUrl = next;
  }

  /** Currently configured server URL. */
  getServerUrl(): string {
    return this.serverUrl;
  }

  /**
   * Install or replace the personal access token. The token never
   * leaves the main process; only its presence/absence influences
   * downstream requests.
   *
   * **Invariants enforced here**:
   *   - `setToken(null)` tears down any active WebSocket AND stops
   *     the periodic health check. Without a token there is no
   *     valid request the health check could make — leaving it
   *     running would produce a stream of spurious `error` state
   *     transitions ("KChat token is not configured") every tick.
   *     This is the bug fix for the case where a re-connect after
   *     an `error` state fails verification: the catch path calls
   *     `setToken(null)`, which must take the health check timer
   *     down with it.
   *   - `setToken(newToken)` where a different token was previously
   *     installed ALSO tears down the WebSocket AND restarts the
   *     health check via stop-on-set/start-on-success at the
   *     caller. The WS performs an `authentication_challenge` send
   *     with the active token after `onopen`; keeping a stale WS
   *     open after the token has been swapped would push events
   *     tied to the wrong identity. The health check is stopped
   *     here so a stale timer from the previous identity cannot
   *     race the new caller's `startHealthCheck()`.
   *   - Same-value calls (`setToken("x")` followed by
   *     `setToken("x")`) remain no-ops on both the WS and the
   *     health check, so idempotent callers (e.g.
   *     `restoreFromVault`) do not incur a reconnect or a timer
   *     reset.
   */
  setToken(token: string | null): void {
    const previous = this.token;
    this.token = token;
    if (token === null || (previous !== null && previous !== token)) {
      this.disconnectWebSocket();
      this.stopHealthCheck();
    }
  }

  /**
   * Return `message` with any occurrence of the active PAT — or a
   * bearer-authorization pattern — replaced by `[REDACTED]`. Used
   * by the IPC layer's `toIpcError` to ensure that error messages
   * crossing the renderer boundary cannot leak token bytes even if
   * a future code path inadvertently embeds them.
   *
   * Defence-in-depth: today's error paths all originate from
   * `KchatRequestError` (rebuilt from status/statusText/endpoint —
   * no token) or low-level network errors (no token). A future
   * change to `rawRequest` that logged the outgoing headers, or a
   * server that echoed the `Authorization` header back in an error
   * payload, would otherwise expose the PAT to the renderer. The
   * scrub runs unconditionally so the renderer can rely on
   * "error.message never contains the PAT" as an invariant.
   */
  scrubMessage(message: string): string {
    if (typeof message !== "string" || message.length === 0) return message;
    let scrubbed = message;
    if (this.token && this.token.length >= 8) {
      // Length guard avoids replacing trivially-short tokens that
      // would alias on common English words. KChat PATs are 26+
      // chars in practice; we still keep the guard for safety.
      scrubbed = scrubbed.replace(
        new RegExp(escapeRegExp(this.token), "g"),
        "[REDACTED]",
      );
    }
    // Match `Bearer <opaque token>` and `Authorization: Bearer ...`
    // shapes regardless of whether the active token in `this.token`
    // matches — a stale token from a previous session could appear
    // in a logged header buffer.
    scrubbed = scrubbed.replace(
      /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
      "Bearer [REDACTED]",
    );
    return scrubbed;
  }

  /** Returns the user struct from the last successful `/users/me` probe. */
  getUser(): KchatUser | null {
    return this.user;
  }

  /** Returns the immutable view of the current connection state. */
  getState(): KchatConnectionState {
    return { ...this.connectionState };
  }

  /** Subscribe to connection-state transitions (idempotent). */
  onStatusChange(listener: KchatStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Subscribe to parsed WebSocket events. */
  onWebSocketEvent(listener: KchatWebSocketListener): () => void {
    this.wsListeners.add(listener);
    return () => this.wsListeners.delete(listener);
  }

  /**
   * Verify the configured token by probing `/users/me`. Updates the
   * cached `user` + state on success, transitions to `error` on
   * failure. Returns the verified user so the caller can persist it
   * in the audit log.
   *
   * Pass `silent: true` to skip the `connecting` state transition on
   * success. The periodic health check uses this so a healthy
   * connection does not flicker through `connecting → connected`
   * every tick (which would cause spurious UI loading states in any
   * renderer that subscribes to state pushes). On failure the
   * silent path still transitions to `error` so the renderer learns
   * the connection has degraded.
   */
  async verifyConnection(
    opts: { silent?: boolean } = {},
  ): Promise<KchatUser> {
    if (!opts.silent) {
      this.transition({ state: "connecting", serverUrl: this.serverUrl });
    }
    try {
      const user = await this.request<KchatUser>("GET", "/api/v4/users/me");
      // Validate the server-supplied `user.id` BEFORE caching it.
      // The id is interpolated into URL paths by `listTeams()` and
      // `listChannels()`, so a compromised server returning an id
      // with `../`, `?`, or `#` could otherwise rewrite the request
      // path the next time the client makes a REST call. Matches
      // the same trust boundary `downloadFile()` enforces on
      // server-supplied `fileId` values — every server id that
      // crosses a URL-interpolation site is validated at the
      // deserialisation boundary, not just at the request site.
      assertKchatServerObjectId(user.id, "users.me.id");
      this.user = user;
      this.transition({
        state: "connected",
        serverUrl: this.serverUrl,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
        },
        lastHealthyAt: new Date().toISOString(),
      });
      return user;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.transition({
        state: "error",
        serverUrl: this.serverUrl,
        error: message,
      });
      throw err;
    }
  }

  /**
   * Start the periodic health-check timer. No-op if already running.
   * Each tick re-probes `/users/me`; the connection state flips to
   * `error` on failure so the renderer can surface a banner.
   */
  startHealthCheck(): void {
    if (this.healthCheckTimer) return;
    this.healthCheckTimer = setInterval(() => {
      // Fire-and-forget; verifyConnection updates the state itself.
      // `silent: true` suppresses the transient `connecting`
      // transition on a successful probe — we only want renderer-
      // visible state changes when the connection actually degrades,
      // not on every routine health-check tick.
      void this.verifyConnection({ silent: true }).catch(() => {});
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** Stop the periodic health-check timer. */
  stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /**
   * List the teams the authenticated user belongs to.
   *
   * Every team id in the response is validated against the KChat
   * object-id shape at the deserialisation boundary. A team id
   * returned here can flow back into `listChannels(teamId)` (the
   * renderer fetches the team list, picks one, and passes the id
   * back through IPC). The IPC layer's `assertKchatId` also
   * checks renderer-supplied ids, but doing it here too closes the
   * loop end-to-end: every server-emitted id is shape-checked
   * before any downstream URL interpolation, independent of how
   * many hops it took to reach the next request site.
   */
  async listTeams(): Promise<KchatTeam[]> {
    const me = this.user ?? (await this.verifyConnection());
    const teams = await this.request<KchatTeam[]>(
      "GET",
      `/api/v4/users/${me.id}/teams`,
    );
    for (const t of teams) {
      assertKchatServerObjectId(t.id, "team.id");
    }
    return teams;
  }

  /**
   * List the channels in `teamId` that the authenticated user
   * belongs to.
   *
   * Validates server-supplied channel ids (and the embedded
   * `team_id` field) at the deserialisation boundary for the
   * same reason {@link listTeams} does — channel ids feed into
   * `listChannelMembers`, `listChannelFiles`, and the upload
   * endpoint, all of which interpolate the id into a URL path.
   */
  async listChannels(teamId: string): Promise<KchatChannel[]> {
    const me = this.user ?? (await this.verifyConnection());
    // KChat exposes the "channels for me on this team" endpoint as
    // /users/{me}/teams/{team}/channels. The /teams/{id}/channels
    // endpoint requires team-admin scope.
    const channels = await this.request<KchatChannel[]>(
      "GET",
      `/api/v4/users/${me.id}/teams/${teamId}/channels`,
    );
    for (const c of channels) {
      assertKchatServerObjectId(c.id, "channel.id");
      assertKchatServerObjectId(c.team_id, "channel.team_id");
    }
    return channels;
  }

  /**
   * List members of `channelId`.
   *
   * Validates server-supplied `channel_id` and `user_id` so a
   * downstream caller that interpolates either into a URL path
   * (e.g. the future `/users/{user_id}/...` endpoints in block B)
   * cannot be tricked by a compromised server.
   */
  async listChannelMembers(
    channelId: string,
    page = 0,
    perPage = 200,
  ): Promise<KchatChannelMember[]> {
    const members = await this.request<KchatChannelMember[]>(
      "GET",
      `/api/v4/channels/${channelId}/members?page=${page}&per_page=${perPage}`,
    );
    for (const m of members) {
      assertKchatServerObjectId(m.channel_id, "channelMember.channel_id");
      assertKchatServerObjectId(m.user_id, "channelMember.user_id");
    }
    return members;
  }

  /**
   * List files attached to `channelId`.
   *
   * Validates each `file.id` at the deserialisation boundary.
   * `downloadFile()` revalidates again before URL interpolation,
   * so this is defence-in-depth: a future caller that builds a
   * URL from `fi.id` without going through `downloadFile` (e.g. a
   * tracing/debug helper that logs the file path) still cannot
   * embed a malicious id.
   */
  async listChannelFiles(
    channelId: string,
    page = 0,
    perPage = 60,
  ): Promise<KchatFileInfo[]> {
    const files = await this.request<KchatFileInfo[]>(
      "GET",
      `/api/v4/channels/${channelId}/files?page=${page}&per_page=${perPage}`,
    );
    for (const fi of files) {
      assertKchatServerObjectId(fi.id, "fileInfo.id");
    }
    return files;
  }

  /**
   * Upload `bytes` as `filename` into `channelId`.
   *
   * Uses the KChat `/files` endpoint with a multipart body. The
   * caller is responsible for kicking off a `posts` create to make
   * the upload visible in the channel timeline; on its own this
   * call only deposits the file in the channel's file store.
   */
  async uploadFile(
    channelId: string,
    filename: string,
    bytes: Uint8Array | Buffer,
    contentType = "application/octet-stream",
  ): Promise<KchatFileInfo> {
    // Defense-in-depth against multipart header injection. The
    // current call sites all pass strictly validated `channelId`
    // (assertKchatId), a renderer-controlled `filename` (URI-encoded
    // below), and a hardcoded `contentType` from `mimeForFormat`. A
    // future caller that bypasses any of those guarantees and lets
    // an attacker-controlled string reach this method must NOT be
    // able to inject a `\r\n` and forge a second multipart part. We
    // reject anything containing CR / LF outright here so the guard
    // is enforced at the network boundary, not at every caller.
    assertNoCRLF(channelId, "channelId");
    assertNoCRLF(filename, "filename");
    assertNoCRLF(contentType, "contentType");
    // Also forbid embedded quotes in `filename` — the value lands
    // inside a quoted `filename="..."` parameter and an embedded `"`
    // would terminate it early. `encodeURIComponent` happens to
    // encode `"` to `%22` so this is also defense-in-depth, but
    // making the rule explicit means a future refactor that swaps
    // the encoder cannot accidentally regress.
    if (filename.includes('"')) {
      throw new Error("KChat upload filename must not contain quotes");
    }
    // Upload limiter is keyed globally (not per-channel). The KChat
    // server enforces a single per-server upload quota; carving it
    // into per-channel buckets would let a user sharing into N
    // channels concurrently exceed the server-side throttle by Nx.
    // The general REST limiter (`kchat:request`) below is also
    // global for the same reason — pick consistency over per-
    // channel fairness, which is meaningless on a single-tenant
    // outgoing connection.
    void channelId;
    this.rateLimiter.consume(
      "kchat:upload",
      RATE_LIMIT_PROFILES["kchat:upload"],
    );

    const boundary = `----TesseraBoundary${Date.now().toString(36)}${Math.floor(this.random() * 1e9).toString(36)}`;
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="channel_id"\r\n\r\n` +
      `${channelId}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${encodeURIComponent(filename)}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([
      Buffer.from(head, "utf-8"),
      Buffer.from(bytes),
      Buffer.from(tail, "utf-8"),
    ]);

    const resp = await this.rawRequest("POST", "/api/v4/files", {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    const parsed = (await resp.json()) as KchatFileUploadResponse;
    if (!parsed.file_infos || parsed.file_infos.length === 0) {
      throw new KchatRequestError(
        500,
        "Unexpected upload response",
        "/api/v4/files",
        JSON.stringify(parsed).slice(0, 256),
      );
    }
    return parsed.file_infos[0];
  }

  /**
   * Download `fileId` from the KChat server. Returns the raw bytes
   * (the indexer extracts text from them via the standard
   * extraction pipeline).
   *
   * **Trust boundary**: `fileId` typically arrives via
   * `listChannelFiles()` (server-supplied) or via an IPC handler
   * that validates renderer-supplied ids with `assertKchatId`.
   * Either way the value is interpolated into a URL path here, so
   * we re-validate at the network boundary. A KChat object id must
   * match the documented `^[a-z0-9]{20,32}$` shape — anything else
   * could rewrite the request path (`../`), inject a query string
   * (`?`), or split off a fragment (`#`). Rejecting at this layer
   * means the path-traversal defence holds even if a caller
   * forgets `assertKchatId` and even if a malicious server emits a
   * malformed id in `listChannelFiles`.
   */
  async downloadFile(fileId: string): Promise<Uint8Array> {
    assertKchatServerObjectId(fileId, "fileId");
    const resp = await this.rawRequest(
      "GET",
      `/api/v4/files/${fileId}`,
    );
    const ab = await resp.arrayBuffer();
    return new Uint8Array(ab);
  }

  /**
   * Open the KChat WebSocket and start dispatching events to
   * registered listeners. Re-uses the same `WebSocket` instance for
   * the lifetime of the connection; reconnects on close with
   * exponential backoff.
   */
  async connectWebSocket(): Promise<void> {
    if (!this.webSocketCtor) {
      throw new Error("KChat WebSocket constructor is not available");
    }
    if (this.ws) return;
    if (!this.token) throw new Error("KChat token is not configured");

    // Derive the WebSocket URL via the `URL` constructor instead of
    // a `String#replace` so we handle `https → wss` / `http → ws`
    // explicitly and reject any non-http(s) scheme outright. The
    // IPC validator already gates on `http(s)://` prefix, but doing
    // this defensively here means a future caller that bypasses
    // that validator (e.g. a config restore from disk) cannot
    // produce a malformed `ws://` URL silently.
    const wsUrl = (() => {
      const u = new URL(this.serverUrl);
      if (u.protocol === "https:") u.protocol = "wss:";
      else if (u.protocol === "http:") u.protocol = "ws:";
      else {
        throw new Error(
          `KChat server URL must use http or https, got ${u.protocol}`,
        );
      }
      // Preserve a non-root base path if the operator deployed
      // KChat behind a reverse-proxy prefix; we append the well-
      // known websocket path to whatever the configured base path is.
      const base = u.pathname.replace(/\/+$/, "");
      u.pathname = `${base}/api/v4/websocket`;
      return u.toString();
    })();
    this.wsClosedByUser = false;
    const ws = new this.webSocketCtor(wsUrl);
    this.ws = ws;
    this.wsSeq = 1;

    ws.onopen = () => {
      // KChat WS auth: send `authentication_challenge` with the token.
      ws.send(
        JSON.stringify({
          seq: this.wsSeq++,
          action: "authentication_challenge",
          data: { token: this.token },
        }),
      );
      this.wsReconnectAttempt = 0;
    };
    ws.onmessage = (ev) => this.handleWsMessage(ev.data);
    ws.onclose = () => {
      this.ws = null;
      if (!this.wsClosedByUser) this.scheduleWsReconnect();
    };
    ws.onerror = (err) => {
      // Don't log the full event (it can include internal handles);
      // only the message side. The error itself is a no-op — the
      // close handler will fire next and trigger reconnect.
      const message =
        err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : "unknown websocket error";
      this.emitStatusError(message);
    };
  }

  /** Close the WebSocket and cancel any pending reconnect. */
  disconnectWebSocket(): void {
    this.wsClosedByUser = true;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Closing a half-open socket is best-effort.
      }
      this.ws = null;
    }
  }

  /** Full client shutdown — token, WS, timers, listeners all cleared. */
  shutdown(): void {
    this.disconnectWebSocket();
    this.stopHealthCheck();
    this.token = null;
    this.user = null;
    this.wsListeners.clear();
    this.transition({ state: "disconnected", serverUrl: this.serverUrl });
    this.statusListeners.clear();
  }

  // --- Internal helpers ------------------------------------------------

  private transition(next: KchatConnectionState): void {
    this.connectionState = next;
    for (const l of this.statusListeners) {
      try {
        l({ ...next });
      } catch {
        // Listener errors must not break the client.
      }
    }
  }

  private emitStatusError(message: string): void {
    this.transition({
      state: "error",
      serverUrl: this.serverUrl,
      error: message,
      user: this.connectionState.user,
    });
  }

  private handleWsMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: KchatWebSocketEvent;
    try {
      parsed = JSON.parse(raw) as KchatWebSocketEvent;
    } catch {
      return;
    }
    if (typeof parsed.event !== "string") return;
    for (const l of this.wsListeners) {
      try {
        l(parsed);
      } catch {
        // Listener errors must not break the WS read loop.
      }
    }
  }

  private scheduleWsReconnect(): void {
    if (this.wsReconnectTimer) return;
    const jitter = 1 + (this.random() - 0.5) * 0.4;
    const wait = Math.min(
      WS_RECONNECT_CAP_MS,
      WS_RECONNECT_BASE_MS * 2 ** this.wsReconnectAttempt,
    );
    const delay = Math.max(0, wait * jitter);
    this.wsReconnectAttempt++;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      void this.connectWebSocket().catch(() => {
        // The close handler will schedule the next attempt.
      });
    }, delay);
  }

  /**
   * Issue a JSON request and decode the body. Wraps {@link rawRequest}
   * with JSON deserialisation.
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const resp = await this.rawRequest(method, endpoint, {
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (resp.status === 204) return undefined as unknown as T;
    return (await resp.json()) as T;
  }

  /**
   * Run a single HTTP request with rate limiting, auth-header
   * injection, and exponential-backoff retry for transient failures.
   *
   * Returns the raw {@link Response} so binary callers (file
   * download) can read the body as bytes instead of JSON.
   */
  private async rawRequest(
    method: string,
    endpoint: string,
    init: { headers?: Record<string, string>; body?: BodyInit | undefined } = {},
  ): Promise<Response> {
    if (!this.token) throw new Error("KChat token is not configured");

    this.rateLimiter.consume(
      "kchat:request",
      RATE_LIMIT_PROFILES["kchat:request"],
    );

    const url = `${this.serverUrl}${endpoint}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
      ...(init.headers ?? {}),
    };

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await this.fetchFn(url, {
          method,
          headers,
          body: init.body as BodyInit,
        });
        if (resp.ok) return resp;
        if (!RETRYABLE_STATUSES.has(resp.status)) {
          const text = await safeReadText(resp);
          throw new KchatRequestError(
            resp.status,
            resp.statusText,
            endpoint,
            text,
          );
        }
        lastError = new KchatRequestError(
          resp.status,
          resp.statusText,
          endpoint,
          await safeReadText(resp),
        );
      } catch (err) {
        if (err instanceof KchatRequestError && !RETRYABLE_STATUSES.has(err.status)) {
          throw err;
        }
        lastError = err;
      }

      if (attempt + 1 < MAX_ATTEMPTS) {
        const jitter = 1 + (this.random() - 0.5) * 0.4;
        const wait = Math.min(
          BACKOFF_CAP_MS,
          BACKOFF_BASE_MS * 2 ** attempt,
        );
        await this.sleep(Math.max(0, wait * jitter));
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`KChat ${method} ${endpoint} failed after ${MAX_ATTEMPTS} attempts`);
  }
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}
