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
  KchatPostInfo,
  KchatPostListPage,
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

/**
 * Status codes treated as transient and retried with backoff.
 *
 * Default set used by all idempotent verbs (GET, PUT, DELETE) and by
 * POST endpoints whose server-side semantics make a duplicate
 * invocation harmless (e.g. `/users/login` — repeated logins replace
 * the previous session token).
 *
 * Non-idempotent POSTs (file uploads, post creation) MUST opt into
 * the narrower {@link NON_IDEMPOTENT_RETRYABLE_STATUSES} set. Retrying
 * a 500/502/503/504 on a non-idempotent POST can produce duplicate
 * server-side effects (a second file in the channel, a second message
 * in the timeline) because the server may have processed the first
 * request and crashed before sending the response — see seventh-pass
 * Devin Review ANALYSIS_0005.
 */
const RETRYABLE_STATUSES = new Set<number>([408, 429, 500, 502, 503, 504]);

/**
 * Retryable-status subset for non-idempotent POST endpoints.
 *
 * 408 (Request Timeout) and 429 (Too Many Requests) are the only
 * codes where the server is documented to NOT have processed the
 * request — a retry cannot cause a duplicate side-effect. Every
 * 5xx is excluded because the server received the request bytes
 * and may have committed the side-effect before the connection
 * dropped; we surface the 5xx to the caller so the user (or the
 * audit layer) decides whether to retry.
 */
const NON_IDEMPOTENT_RETRYABLE_STATUSES = new Set<number>([408, 429]);

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
 * Hard cap on the number of `(eventName, reason)` entries the
 * trust-boundary drop-warn cooldown map will hold AT ONCE.
 *
 * The keys are `${eventName}::${reason}`, and `eventName` is the
 * untrusted `parsed.event` value off the wire. A malicious or buggy
 * peer that floods malformed frames with thousands of unique made-
 * up event names can grow the map indefinitely without this cap.
 * Ninth-pass Devin Review on PR #43
 * (`ANALYSIS_pr-review-job-...0001`) flagged that the prior
 * "~8 MB for 100k entries is acceptable" argument missed the
 * across-reconnect dimension: every reconnect re-opens the WS but
 * the map persists, so over a long-lived process under attack the
 * map is truly unbounded.
 *
 * 256 entries is well above the legitimate ceiling (the KChat /
 * Mattermost event vocabulary is ~30 named events × 3 drop reasons
 * = 90 tuples; doubling that for headroom against future protocol
 * additions still leaves slack) and small enough that the worst-
 * case memory footprint of the map is bounded at ~20 KB regardless
 * of how long the process runs or how many reconnects occur. When
 * the cap is hit we clear the map entirely (rather than evicting
 * an LRU entry) so the next legitimate event-name observation gets
 * a warning fresh — the cooldown semantics already tolerate the
 * occasional re-warn within a window, and the simpler clear-on-cap
 * has predictable behavior under flood.
 */
const WS_DROP_WARN_COOLDOWN_MAX_ENTRIES = 256;

/**
 * Minimum interval between trust-boundary drop warnings for the
 * SAME `(eventName, reason)` tuple.
 *
 * `handleWsMessage` is the sole point where untrusted JSON becomes
 * typed `KchatWebSocketEvent` (see the block-comment in that
 * function for why every malformed-frame guard must short-circuit
 * here rather than being deferred to downstream consumers).
 *
 * The first iteration of the trust boundary silently `return`-ed
 * on every dropped frame, which left operators blind to two
 * legitimate operational concerns flagged by Devin Review on PR
 * #43 (`ANALYSIS_pr-review-job-...0005`):
 *
 *   1. **Protocol evolution**: a future KChat protocol version
 *      that introduces a legitimate event with no `data` field
 *      would be silently dropped with no diagnostic in the logs
 *      — the only signal would be "users report missing events".
 *   2. **Buggy / misconfigured peer**: a self-hosted KChat server
 *      that ships malformed frames (bug, version mismatch, MITM
 *      proxy mangling, etc.) would look identical to "no events"
 *      in production — there'd be no way to distinguish a quiet
 *      WS from a wedged-by-trust-boundary WS.
 *
 * We log a `console.warn` at each drop site so operators can
 * correlate, BUT we rate-limit per `(eventName, reason)` tuple
 * to bound the worst case: a malicious or buggy peer flooding
 * malformed frames at 1000/s must not flood the main-process
 * stderr / dev-tools console with 1000/s warnings. 60 s is the
 * standard cooldown — long enough to compress a flood, short
 * enough that a real protocol-evolution gap is still visible
 * promptly during a debugging session.
 */
const WS_DROP_WARN_COOLDOWN_MS = 60_000;

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
  /**
   * Wall-clock source for the trust-boundary drop-warn cooldown
   * map. Defaults to `Date.now`. Tests pin this to a controlled
   * clock so the cooldown logic is deterministic.
   */
  now?: () => number;
  /**
   * Log sink for trust-boundary drop warnings. Defaults to
   * `console.warn`. Tests inject a spy so they can assert on the
   * structured drop-warning payload without polluting suite
   * output with real stderr writes.
   */
  logWarn?: (message: string, context: Record<string, unknown>) => void;
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
 * Non-throwing variant of {@link assertCallerObjectId} for the
 * enrichment layer (Phase 13 Theme 2 Task 9, Devin Review pass 2
 * on bef2fa0, ANALYSIS_0002).
 *
 * The bulk-enrichment path in `kchat:searchPosts` calls
 * `getUsersByIds` with a list of ids whose validity it cannot
 * vouch for individually — a single substrate-corrupted row would
 * cause the assertion inside `getUsersByIds` to reject the entire
 * batch, suppressing username enrichment for every other hit in
 * the result set. Pre-filtering with this predicate lets the
 * enrichment layer partition into "send these" vs "leave as raw
 * id" without changing the trust-boundary semantics of the bulk
 * endpoint itself (which keeps its strict assertion).
 *
 * Note: the helper is intentionally narrow — it returns `false`
 * for both malformed strings and non-string inputs. Callers
 * upstream may already have a `string` type contract, but the
 * narrower predicate is friendlier to call sites that have
 * `unknown` / `string | null` in scope.
 */
export function isKchatObjectId(value: unknown): value is string {
  return typeof value === "string" && KCHAT_OBJECT_ID_RE.test(value);
}

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
 * Validate a KChat object id that originated from a **caller**
 * inside the main process (e.g. a future scheduled sync loop or
 * an internal helper) before interpolating it into a URL path
 * segment.
 *
 * The IPC layer already runs renderer-supplied ids through
 * `assertKchatId` (`electron/ipc/kchat.ts`), so today every
 * caller that reaches the public client methods has already
 * validated. This helper is defense-in-depth for future callers
 * that bypass the IPC layer (background polling, internal tests,
 * batch sync workers) so the URL-path-segment guarantees the
 * client relies on are enforced AT the client boundary, not
 * upstream-of-it (fourteenth-pass Devin Review ANALYSIS_0004).
 *
 * Throws a plain `Error` rather than a `KchatRequestError` —
 * server-response validation failures and caller-input failures
 * are distinct, and the latter should not masquerade as a 502
 * from the wire.
 */
function assertCallerObjectId(value: string, name: string): string {
  if (!KCHAT_OBJECT_ID_RE.test(value)) {
    throw new Error(
      `${name} is not a valid KChat object id (expected 20–32 lowercase alphanumeric chars)`,
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
 * Normalise a KChat post envelope (snake_case as returned by the
 * REST endpoint) into the renderer-safe camelCase shape the
 * forwarder, audit surfaces, and the substrate ingest path
 * consume. Throws on missing-required-field so a malformed server
 * response surfaces immediately rather than producing a half-
 * populated row downstream.
 *
 * Used by both {@link KchatClient.getPost} and
 * {@link KchatClient.getPostsForChannel} so the validation rules
 * stay consistent across the two endpoints.
 *
 * Block C Task 1 (Phase 12).
 */
function normalisePost(raw: Record<string, unknown>): KchatPostInfo {
  const id = typeof raw.id === "string" ? raw.id : null;
  const channelId =
    typeof raw.channel_id === "string" ? raw.channel_id : null;
  const userId = typeof raw.user_id === "string" ? raw.user_id : null;
  const message = typeof raw.message === "string" ? raw.message : null;
  const createAt = typeof raw.create_at === "number" ? raw.create_at : null;
  const editAt = typeof raw.edit_at === "number" ? raw.edit_at : 0;
  const rootIdRaw = raw.root_id;
  const rootId =
    typeof rootIdRaw === "string" && rootIdRaw.length > 0 ? rootIdRaw : null;

  if (id === null) throw new Error("post.id missing");
  if (channelId === null) throw new Error("post.channel_id missing");
  if (userId === null) throw new Error("post.user_id missing");
  if (message === null) throw new Error("post.message missing");
  if (createAt === null) throw new Error("post.create_at missing");

  assertKchatServerObjectId(id, "post.id");
  assertKchatServerObjectId(channelId, "post.channel_id");
  assertKchatServerObjectId(userId, "post.user_id");
  if (rootId !== null) {
    assertKchatServerObjectId(rootId, "post.root_id");
  }

  return { id, channelId, rootId, userId, message, createAt, editAt };
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
  private readonly now: () => number;
  private readonly logWarn: (
    message: string,
    context: Record<string, unknown>,
  ) => void;

  /**
   * Last-warned timestamp per `(eventName, reason)` tuple, used
   * to rate-limit trust-boundary drop warnings. Keyed by
   * `"${eventName}::${reason}"` so a flood that targets one event
   * type doesn't suppress warnings for a genuinely-different
   * malformed frame on another event type.
   *
   * The map is hard-capped at `WS_DROP_WARN_COOLDOWN_MAX_ENTRIES`
   * entries (see the module-level constant for the rationale) and
   * cleared entirely when the cap is reached, so the size cannot
   * exceed that bound regardless of how many unique untrusted
   * `eventName` values arrive. The map is ALSO cleared on every
   * `disconnectWebSocket()` so each new WS session starts from a
   * clean slate — defeating an adversarial peer that tries to
   * accumulate entries across forced reconnects. Both invariants
   * are exercised by regression tests in `kchatClient.test.ts`:
   * `caps the drop-warn cooldown map under adversarial event-name
   * flood` and `clears the trust-boundary drop-warn cooldown on
   * disconnect`. Tenth-pass Devin Review on PR #43
   * (`ANALYSIS_pr-review-job-...0005`) flagged that an earlier
   * iteration of this comment claimed the map was unbounded —
   * stale once the cap landed in ninth-pass.
   */
  private readonly wsDropWarnCooldown = new Map<string, number>();

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
    this.now = options.now ?? Date.now;
    this.logWarn =
      options.logWarn ??
      ((message, context) => {
        console.warn(message, context);
      });
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
   * Fan a (synthetic or extension-bridged) `KchatWebSocketEvent`
   * out to every registered `wsListeners`. Phase 13 Task 4:
   * `KchatExtensionEvents` calls this so events translated from
   * the `uney-chat-desktop` extension surface flow into the same
   * downstream pipeline as native WebSocket events. The two
   * sources are interchangeable from the forwarder's point of
   * view; the only difference is `evt.data._extension_native_event`
   * is set on extension-bridged events (see
   * `kchatExtensionEvents.ts`).
   *
   * No trust-boundary validation runs here — the caller (only
   * `KchatExtensionEvents`) is responsible for producing a
   * well-formed envelope. Listener errors are swallowed
   * individually so a faulty listener does not break the fan-out
   * for the others (same posture as the native WebSocket
   * dispatch site).
   */
  emitWebSocketEvent(evt: KchatWebSocketEvent): void {
    for (const l of this.wsListeners) {
      try {
        l(evt);
      } catch {
        // Listener errors must not break the fan-out.
      }
    }
  }

  /**
   * Phase 13 Task 4: transition into the `error` state with a
   * caller-supplied message, used by `KchatAuthService` when the
   * extension bridge surfaces a refresh failure or a
   * desktop-app-initiated disconnect. Wraps the private
   * `emitStatusError` so the auth service does not have to reach
   * across the encapsulation boundary.
   */
  emitExtensionAuthError(message: string): void {
    this.emitStatusError(message);
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
    // Defense-in-depth caller-input validation (fourteenth-pass
    // Devin Review ANALYSIS_0004): the IPC layer already validates
    // renderer-supplied ids with `assertKchatId`, but a future
    // internal caller (scheduled sync, batch worker) that bypasses
    // IPC would otherwise interpolate an unchecked string into the
    // URL path. We re-validate at the client boundary so the URL-
    // path-segment guarantee is enforced HERE, not upstream-of-here.
    assertCallerObjectId(teamId, "teamId");
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
    assertCallerObjectId(channelId, "channelId");
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
   * Bulk-resolve KChat user records by id (Phase 13 Theme 2 Task 9).
   *
   * Uses the Mattermost-compatible `POST /api/v4/users/ids`
   * endpoint, which accepts a JSON array of user ids and returns
   * the corresponding `KchatUser[]`. The endpoint silently omits
   * ids that are not visible to the authenticated principal, so
   * the returned list may be shorter than the input.
   *
   * Each caller-supplied id is validated at the boundary via
   * {@link assertCallerObjectId} so a future internal caller that
   * bypasses IPC can't smuggle a `/`, `?`, or `#` into the
   * downstream URL path the way `listChannels` / `listTeams` are
   * already protected. Server-returned ids are re-validated with
   * {@link assertKchatServerObjectId} so a compromised server
   * can't echo back a malicious id that downstream consumers
   * (e.g. URL interpolation, log strings) would trust.
   *
   * Used by `kchat:searchPosts` to enrich each post hit with the
   * sender's username before returning the row to the renderer,
   * so the CitationPanel can render "@<username>" instead of the
   * raw user object id.
   */
  async getUsersByIds(ids: string[]): Promise<KchatUser[]> {
    if (ids.length === 0) return [];
    for (const id of ids) {
      assertCallerObjectId(id, "userId");
    }
    const users = await this.request<KchatUser[]>(
      "POST",
      "/api/v4/users/ids",
      ids,
    );
    for (const u of users) {
      assertKchatServerObjectId(u.id, "user.id");
    }
    return users;
  }

  /**
   * Fetch a single channel by id (Phase 13 Theme 2 Task 9).
   *
   * Uses `GET /api/v4/channels/{id}`. Unlike `listChannels`, this
   * works across teams — the auth check is "is the authenticated
   * user a member of this channel?", not "is the channel on this
   * team?" — which is exactly what the search-result enrichment
   * needs: a hit can come from any channel the user has access to,
   * and we don't know the team at the IPC enrichment site.
   *
   * Used by `kchat:searchPosts` to enrich each post hit with the
   * channel's `display_name` before returning it to the renderer,
   * so the CitationPanel can render "#general" instead of the raw
   * channel object id.
   */
  async getChannel(channelId: string): Promise<KchatChannel> {
    assertCallerObjectId(channelId, "channelId");
    const channel = await this.request<KchatChannel>(
      "GET",
      `/api/v4/channels/${channelId}`,
    );
    assertKchatServerObjectId(channel.id, "channel.id");
    assertKchatServerObjectId(channel.team_id, "channel.team_id");
    return channel;
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
    assertCallerObjectId(channelId, "channelId");
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
   * Fetch the metadata for a single file by id.
   *
   * Used by the Block B Task 2 WS forwarder: a `file_added` event
   * carries only the `file_id`, so the forwarder calls
   * `getFileInfo(fileId)` to resolve the server-side `name` /
   * `extension` / `size` before downloading the bytes. The full
   * `listChannelFiles` paginated walk would otherwise need to
   * sweep up to `n / perPage` pages just to find the metadata for
   * one file.
   *
   * Trust boundary: `fileId` arrives via a WS broadcast payload
   * whose source is the KChat server. We re-validate at the URL-
   * interpolation site so a malformed id cannot pivot into a
   * different REST endpoint. The returned `KchatFileInfo` is
   * re-validated against the same server-object-id shape used in
   * `listChannelFiles`.
   */
  async getFileInfo(fileId: string): Promise<KchatFileInfo> {
    assertKchatServerObjectId(fileId, "fileId");
    const fi = await this.request<KchatFileInfo>(
      "GET",
      `/api/v4/files/${fileId}/info`,
    );
    assertKchatServerObjectId(fi.id, "fileInfo.id");
    return fi;
  }

  /**
   * Fetch a single post by id. Used by the Block C Task 1 WS
   * forwarder's `post_edited` recovery path — if the WS payload's
   * stringified `post` is malformed (e.g. truncated by an
   * intermediate proxy), the forwarder falls back to this REST
   * fetch by id. Returns the normalised {@link KchatPostInfo}
   * shape the renderer + audit surfaces consume.
   *
   * Trust boundary: `postId` arrives via WS, so we re-validate at
   * the URL-interpolation site. The returned envelope's `id` /
   * `channel_id` / `user_id` are also re-validated.
   */
  async getPost(postId: string): Promise<KchatPostInfo> {
    assertKchatServerObjectId(postId, "postId");
    const raw = await this.request<{
      id?: unknown;
      channel_id?: unknown;
      root_id?: unknown;
      user_id?: unknown;
      message?: unknown;
      create_at?: unknown;
      edit_at?: unknown;
    }>("GET", `/api/v4/posts/${postId}`);
    return normalisePost(raw);
  }

  /**
   * Paginated post fetch for `channelId`. The cursor model
   * mirrors KChat's `GET /channels/{id}/posts` endpoint:
   *
   *   - `before` / `after`: post-id cursors. Pass the oldest
   *     post id of the current page to step further back in
   *     history.
   *   - `since`: epoch-ms watermark. The server returns posts
   *     edited or created since this time. Used by the Block C
   *     Task 4 (future) backfill watermark loop.
   *   - `perPage`: page size. Server caps this at 60 on most
   *     KChat builds; we cap at 200 client-side and let the
   *     server clamp downward.
   *
   * Per-channel safety cap: a misconfigured server or a
   * malicious payload could return an unbounded sequence of
   * pages, so callers are expected to walk pages with a
   * cumulative-row safety cap (50_000 posts, mirroring the
   * member-pagination cap in the forwarder). This single-page
   * method does not enforce the cap itself; the caller decides
   * when to stop.
   *
   * Trust boundary: every returned post id / channel id / user
   * id is re-validated at the deserialisation boundary so a
   * downstream caller that interpolates any of them into a URL
   * path cannot be tricked by a compromised server.
   */
  async getPostsForChannel(
    channelId: string,
    opts: {
      before?: string;
      after?: string;
      sinceMs?: number;
      perPage?: number;
    } = {},
  ): Promise<KchatPostListPage> {
    assertCallerObjectId(channelId, "channelId");
    const perPage = Math.min(opts.perPage ?? 60, 200);
    const params = new URLSearchParams();
    params.set("per_page", String(perPage));
    if (typeof opts.before === "string" && opts.before.length > 0) {
      assertCallerObjectId(opts.before, "before");
      params.set("before", opts.before);
    }
    if (typeof opts.after === "string" && opts.after.length > 0) {
      assertCallerObjectId(opts.after, "after");
      params.set("after", opts.after);
    }
    if (
      typeof opts.sinceMs === "number" &&
      Number.isFinite(opts.sinceMs) &&
      opts.sinceMs >= 0
    ) {
      params.set("since", String(Math.trunc(opts.sinceMs)));
    }

    const raw = await this.request<{
      order?: unknown;
      posts?: unknown;
      prev_post_id?: unknown;
      next_post_id?: unknown;
    }>(
      "GET",
      `/api/v4/channels/${channelId}/posts?${params.toString()}`,
    );

    // KChat returns `posts` as a dictionary keyed by post id +
    // an `order` array giving the canonical (newest-first)
    // sequence. We project this into a flat array in `order`
    // sequence so callers don't have to redo the join.
    const postsMap =
      raw.posts !== null && typeof raw.posts === "object"
        ? (raw.posts as Record<string, unknown>)
        : {};
    const order = Array.isArray(raw.order) ? raw.order : [];
    const posts: KchatPostInfo[] = [];
    for (const id of order) {
      if (typeof id !== "string") continue;
      const envelope = postsMap[id];
      if (envelope === null || typeof envelope !== "object") continue;
      posts.push(normalisePost(envelope as Record<string, unknown>));
    }

    const prevPostId =
      typeof raw.prev_post_id === "string" && raw.prev_post_id.length > 0
        ? raw.prev_post_id
        : null;
    const nextPostId =
      typeof raw.next_post_id === "string" && raw.next_post_id.length > 0
        ? raw.next_post_id
        : null;
    // `hasMore` is server-signalled via a non-empty `prev_post_id`
    // (older page exists) when paginating backwards. The caller
    // also stops when a page comes back shorter than `perPage`.
    const hasMore = prevPostId !== null;
    return { posts, prevPostId, nextPostId, hasMore };
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

    // `uploadFile` POSTs to a non-idempotent endpoint — retrying on
    // 5xx would risk duplicate files in the channel because the
    // KChat server may have persisted the file before the response
    // failed to reach us. Constrain retries to the codes where the
    // server is documented to NOT have processed the request
    // (408/429); a 5xx surfaces immediately so the caller (the IPC
    // handler in `ipc/kchat.ts`) can decide whether to re-attempt.
    // The handler then re-runs the entire share flow with a fresh
    // export, which is the right behaviour: the user can see the
    // failure, the audit log records it (via the partial-success
    // path), and there's no silent duplication.
    const resp = await this.rawRequest("POST", "/api/v4/files", {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      retryableStatuses: NON_IDEMPOTENT_RETRYABLE_STATUSES,
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
    // Reset the trust-boundary drop-warn cooldown so the next
    // connection (potentially against a different server URL after
    // a `setServerUrl()` cutover) starts from a clean slate. Without
    // this, an adversarial peer that cycles unique made-up event
    // names across forced reconnects could accumulate entries
    // across the lifetime of the process, defeating the per-
    // connection bound enforced by `WS_DROP_WARN_COOLDOWN_MAX_ENTRIES`.
    // The cooldown's intent is "don't double-warn the operator
    // about the same drop pattern" — once the WS is gone, the
    // drop-pattern provenance is gone too, and the next session
    // deserves its own warnings. Ninth-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0001`).
    this.wsDropWarnCooldown.clear();
  }

  /**
   * Tear down the client's own connection state — token, WebSocket,
   * health-check / reconnect timers. Emits one final
   * `disconnected` transition so subscribers observe the shutdown
   * before the timers are gone.
   *
   * `wsListeners` and `statusListeners` are deliberately NOT
   * cleared here. External subscribers (notably
   * `KchatEventForwarder`, which is constructed once in
   * `getKchatAuthService()` and outlives every connect/disconnect
   * cycle in the app lifetime) own their own listener lifecycle
   * via the unsubscribe closure returned from
   * `onWebSocketEvent` / `onStatusChange`. Clearing the Sets here
   * would silently strip those external subscribers from the
   * client without their `unsubscribe()` ever running, and there
   * is no mechanism for the forwarder to detect the loss and
   * re-attach on the subsequent reconnect (its own `start()` guard
   * would treat the call as a no-op because the cached
   * `unsubscribeWs` / `unsubscribeStatus` closures are still
   * non-null). The result on the previous draft was a permanently
   * dead push pipeline after the first disconnect/reconnect cycle;
   * the 30 s reconciliation poll papered over it for the sidebar
   * badge but every push consumer downstream lost delivery.
   *
   * The auth service drives the lifecycle from `disconnect()` /
   * `connect()` — `shutdown()` is invoked on disconnect and the
   * same client instance is reused across reconnects, so keeping
   * external subscribers attached across the gap is exactly what
   * preserves the forwarder's IPC delivery. Fourth-pass Devin
   * Review on PR #43 (`BUG_pr-review-job-…_0001`).
   */
  shutdown(): void {
    this.disconnectWebSocket();
    this.stopHealthCheck();
    this.token = null;
    this.user = null;
    this.transition({ state: "disconnected", serverUrl: this.serverUrl });
  }

  // --- Internal helpers ------------------------------------------------

  private transition(next: KchatConnectionState): void {
    // Defence-in-depth: scrub the `error` field at write time so
    // every reader (the `kchat:status` IPC handler, all subscribed
    // status listeners, log dumps that inspect `connectionState`
    // directly, future N-API bridge consumers) observes an
    // already-scrubbed message. Centralising the scrub here pins
    // the invariant "`connectionState.error` never contains the
    // PAT" to a single write site — any future code path that
    // transitions into an `error` state (the `verifyConnection`
    // catch, `emitStatusError`, websocket error handlers, a future
    // request-layer error) inherits the redaction without having
    // to remember to call `scrubMessage` at every call site.
    // Sixth-pass Devin Review (ANALYSIS_0004) flagged the
    // `kchat:status` handler as the one IPC surface that bypassed
    // `toIpcError` (and therefore `scrubMessage`); the fix lives
    // here rather than in the handler so it cannot be re-introduced
    // by a future refactor that surfaces state through any other
    // path.
    const scrubbed: KchatConnectionState =
      typeof next.error === "string" && next.error.length > 0
        ? { ...next, error: this.scrubMessage(next.error) }
        : next;
    this.connectionState = scrubbed;
    for (const l of this.statusListeners) {
      try {
        l({ ...scrubbed });
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

  /**
   * Emit a trust-boundary drop warning, rate-limited per
   * `(eventName, reason)` tuple. Called only from
   * `handleWsMessage` — the only function that drops untrusted
   * frames at the trust boundary.
   *
   * The cooldown is per-tuple (not global) so a flood that
   * targets one event type doesn't mask warnings for a genuinely
   * different malformed-frame shape on another event type. A
   * future protocol-evolution gap (e.g. a new event introduced
   * with no `data` field) would consistently emit one warning
   * per minute until an operator notices, rather than being
   * compressed to a single warning per process lifetime.
   */
  private warnDroppedFrame(
    eventName: string | undefined,
    reason:
      | "missing-event"
      | "malformed-broadcast"
      | "malformed-data"
      | "malformed-seq",
  ): void {
    const name = eventName ?? "<no-event>";
    const key = `${name}::${reason}`;
    const now = this.now();
    // Use `Map.has()` to distinguish "first occurrence of this
    // tuple" from "subsequent occurrence within cooldown". The
    // earlier shape `(this.wsDropWarnCooldown.get(key) ?? 0)`
    // collapsed both cases to `lastWarned === 0`, which made the
    // very first warning at `now === 0` (and any test that pinned
    // the clock to 0) suppressed by the cooldown comparison.
    const lastWarned = this.wsDropWarnCooldown.get(key);
    if (
      lastWarned !== undefined &&
      now - lastWarned < WS_DROP_WARN_COOLDOWN_MS
    ) {
      return;
    }
    // Bounded-growth guard: if the map has hit its hard cap, drop
    // every existing entry and start fresh. The keys include the
    // untrusted `eventName` so an adversarial peer that cycles
    // unique event names across reconnects can otherwise grow the
    // map without bound (the cooldown alone doesn't shrink it).
    // Clearing (rather than LRU-evicting one entry) is the simpler
    // shape and predictable under flood: the next 256 distinct
    // tuples all get a fresh warning, then the next 256 fold into
    // their cooldown again. The cooldown semantics already tolerate
    // an occasional re-warn within a window. Ninth-pass Devin
    // Review on PR #43 (`ANALYSIS_pr-review-job-...0001`).
    if (this.wsDropWarnCooldown.size >= WS_DROP_WARN_COOLDOWN_MAX_ENTRIES) {
      this.wsDropWarnCooldown.clear();
    }
    this.wsDropWarnCooldown.set(key, now);
    this.logWarn(
      "[KchatClient] dropped malformed WS frame at trust boundary",
      {
        event: name,
        reason,
        // The cooldown means an operator who notices ONE warning
        // should treat it as "the actual rate is at least 1 per
        // 60 s for this tuple", not as a single-occurrence event.
        cooldownMs: WS_DROP_WARN_COOLDOWN_MS,
      },
    );
  }

  private handleWsMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    // `JSON.parse` returns the parsed JSON value, which can be a
    // primitive (number / boolean / string / null) or an array, not
    // just an object. The literal frame `"null"` parses to the
    // JavaScript value `null`; `"42"` parses to `42`; `"[]"` parses
    // to an empty array. The subsequent `parsed.event` access
    // crashes on `null` with `TypeError: Cannot read properties of
    // null (reading 'event')`, and the error would propagate
    // unhandled out of `ws.onmessage`, taking the WS reader loop
    // down on a malicious or buggy peer that sends those literals.
    // Ninth-pass Devin Review on PR #43
    // (`BUG_pr-review-job-...0001`) flagged this as a real crash
    // vector at the trust boundary. The earlier `broadcast` and
    // `data` guards are STRUCTURAL guards (the frame parsed to a
    // non-null object but some inner field was malformed); this is
    // a PARSE-TYPE guard (the whole JSON value isn't an object at
    // all). It must run first because the structural guards each
    // reach through `parsed.*`.
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      this.warnDroppedFrame(undefined, "missing-event");
      return;
    }
    // After the parse-type guard above we know `parsed` is a
    // non-null, non-array object — narrow it to a generic record
    // so we can inspect Mattermost control fields before the
    // protocol-event narrowing below.
    const obj = parsed as Record<string, unknown>;
    // Mattermost / KChat WebSocket protocol carries two distinct
    // frame families on the same wire:
    //
    //   1. Server-pushed EVENTS: framed with a top-level `event`
    //      string (e.g. `"posted"`, `"file_added"`) and the
    //      `broadcast` + `data` envelopes the rest of this method
    //      validates. These are what our subscribers consume.
    //
    //   2. Client-request RESPONSES: framed with `seq_reply` (the
    //      sequence number the client put on its request) and a
    //      `status` field (`"OK"` / `"FAIL"`). NO `event` field is
    //      present. We send exactly one such request per
    //      connection: the `authentication_challenge` issued on
    //      `onopen` (see lines 906–916). Mattermost responds with
    //      `{"status":"OK","seq_reply":N}`; on a token reject we
    //      get `{"status":"FAIL","seq_reply":N,"error":{...}}`.
    //
    // The eighth-pass drop-warn path treated EVERY non-event frame
    // as "malformed" and emitted a `missing-event` warning. That's
    // accurate for genuinely-malformed frames but emits a warning
    // on every legitimate auth response, which fires once per
    // reconnect — a steady cadence of "malformed frame" warnings
    // on a healthy connection is operationally misleading. Tenth-
    // pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0001`) flagged this. The fix is
    // to treat `seq_reply` as the discriminator: any frame with a
    // numeric `seq_reply` is a control response we deliberately
    // do not surface to subscribers, and is not a malformed-frame
    // warning candidate. We drop it silently. Frames with neither
    // `event` NOR `seq_reply` are genuinely malformed and continue
    // to fire the rate-limited drop warning.
    if (typeof obj.seq_reply === "number") {
      return;
    }
    const evt = obj as unknown as KchatWebSocketEvent;
    if (typeof evt.event !== "string") {
      this.warnDroppedFrame(undefined, "missing-event");
      return;
    }
    // The KChat / Mattermost protocol always frames events with a
    // `broadcast` object (`channel_id`, `team_id`, `user_id`,
    // `omit_users`) AND a `data` object (event-specific payload —
    // `create_at`, `file_id`, `channel_name`, etc.). A server we
    // do not control could in principle ship a malformed frame —
    // `{"event":"hello","seq":0}` with no `broadcast` field at
    // all, `{"broadcast":null}`, `{"data":[]}`, or
    // `{"event":"posted","broadcast":{...}}` with no `data` — and
    // the downstream projection (`toRendererEventView` and any
    // listener that destructures `parsed.broadcast.*` /
    // `parsed.data.*`) would TypeError on the property access. The
    // error would surface only as a swallowed exception in the
    // per-listener try/catch below; the listener would silently
    // drop the event and the forwarder's ring buffer would lose
    // it without an audit trail. Renderer consumers (notably
    // `KchatSidebarSection` which destructures `event.data.create_at`)
    // would receive a typed `KchatWebSocketEventView` that lies
    // about `data` being defined and TypeError in the renderer
    // event loop with no try/catch above it.
    //
    // The trust boundary for the WS frame is THIS function — once
    // we leave it, every consumer assumes `KchatWebSocketEvent`
    // matches its TypeScript shape. Reject malformed frames here
    // (rather than scattering optional-chain guards at every
    // projection site) so the post-parse contract holds.
    // Fifth-pass Devin Review on PR #43 added the `broadcast`
    // guard (`ANALYSIS_pr-review-job-..._0001`); sixth-pass added
    // the symmetric `data` guard (`BUG_pr-review-job-...0001`)
    // for the same renderer-TypeError reason on a different field;
    // eighth-pass added the rate-limited drop-warn logging
    // (`ANALYSIS_pr-review-job-...0005`) so protocol-evolution
    // gaps and buggy peers don't go silently undetected in
    // production.
    if (
      typeof evt.broadcast !== "object" ||
      evt.broadcast === null ||
      Array.isArray(evt.broadcast)
    ) {
      this.warnDroppedFrame(evt.event, "malformed-broadcast");
      return;
    }
    if (
      typeof evt.data !== "object" ||
      evt.data === null ||
      Array.isArray(evt.data)
    ) {
      this.warnDroppedFrame(evt.event, "malformed-data");
      return;
    }
    // `KchatWebSocketEvent.seq` is declared `number`. The trust
    // boundary's contract is "after this function returns OK, every
    // typed field on the asserted shape holds." Validating `seq`
    // here means downstream consumers (`KchatSidebarSection`,
    // `KchatEventForwarder`, future gap-detection logic) can branch
    // on `view.seq` arithmetic without optional-chaining or runtime
    // typeof checks scattered across call sites. The cost of one
    // additional `typeof` is trivial against the consistency
    // benefit. Eleventh-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0005`) flagged that `seq` was the
    // only typed field the trust boundary did not validate; a
    // malicious server sending `{...,"seq":"not-a-number"}` would
    // have flowed through as a string-typed `number` and broken any
    // arithmetic the renderer eventually runs on it (gap detection
    // is mentioned in this method's surrounding docs as a likely
    // future use). Closing the gap now is cheap and prevents the
    // class of bug.
    if (typeof evt.seq !== "number") {
      this.warnDroppedFrame(evt.event, "malformed-seq");
      return;
    }
    for (const l of this.wsListeners) {
      try {
        l(evt);
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
    // Only attach `Content-Type: application/json` when a body is
    // actually being sent. HTTP servers ignore Content-Type on
    // bodyless requests per RFC 9110 §8.3, but strict reverse
    // proxies and WAF rules sometimes flag the mismatch (e.g.
    // "GET with declared JSON body but Content-Length: 0") and
    // either rewrite the request or drop it. Sending the header
    // only on body-carrying methods removes the foot-gun without
    // affecting any current call site (fourteenth-pass Devin
    // Review ANALYSIS_0006).
    const headers: Record<string, string> =
      body === undefined ? {} : { "Content-Type": "application/json" };
    const resp = await this.rawRequest(method, endpoint, {
      headers,
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
    init: {
      headers?: Record<string, string>;
      body?: BodyInit | undefined;
      /**
       * Per-call override of the retryable-status set. Non-idempotent
       * POSTs (`uploadFile`) pass {@link NON_IDEMPOTENT_RETRYABLE_STATUSES}
       * so 5xx responses are NOT retried; all idempotent verbs use
       * the default {@link RETRYABLE_STATUSES}. The override is
       * scoped per-call (rather than per-endpoint or per-method)
       * because the safe-to-retry property is a function of
       * endpoint semantics, not HTTP verb — KChat's `users/login`
       * is a POST that IS safe to retry, and `posts` create is a
       * POST that ISN'T.
       */
      retryableStatuses?: Set<number>;
    } = {},
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
    const retryable = init.retryableStatuses ?? RETRYABLE_STATUSES;

    let lastError: unknown = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await this.fetchFn(url, {
          method,
          headers,
          body: init.body as BodyInit,
        });
        if (resp.ok) return resp;
        if (!retryable.has(resp.status)) {
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
        if (err instanceof KchatRequestError && !retryable.has(err.status)) {
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
