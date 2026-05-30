/**
 * Phase 15 Task 28 — sliding-window rate limiter for the loopback
 * KChat extension API.
 *
 * Why a separate limiter from the IPC `rateLimiter.ts`:
 *
 *   The IPC limiter caps Electron-renderer → main-process traffic,
 *   keyed by IPC channel. The loopback HTTP server has a completely
 *   different threat model: requests arrive from a separate process
 *   (the .kcz extension running inside KChat Desktop, or anything
 *   else that has stolen the port-file's bearer token), keyed by
 *   remote IP. The two limiters share no state and protect against
 *   different abuses:
 *
 *     - IPC limiter: a buggy or compromised renderer fan-outs on
 *       `sources:batchReindex` and burns the bridge.
 *     - Loopback limiter: a compromised local process (or an
 *       extension stuck in a retry loop) saturates the bearer-
 *       authenticated routes and starves the legitimate caller.
 *
 *   Because the server binds to 127.0.0.1 the keyed-by-IP design is
 *   in practice "127.0.0.1 vs. nothing", but keeping per-IP semantics
 *   means we degrade gracefully if a future Phase opens the surface
 *   to e.g. a Tailscale loopback or a UDS bridge — the limiter's
 *   contract stays valid without rewrite.
 *
 * The sliding-window algorithm:
 *
 *   For each (key) we store a ring-buffer of millisecond timestamps,
 *   capped at `limit`. On every call:
 *
 *     1. Drop entries older than `now - windowMs`.
 *     2. If the remaining count is ≥ `limit`, REJECT — compute the
 *        smallest `Retry-After` (in seconds, rounded up, minimum 1)
 *        such that the oldest surviving entry will have aged out
 *        when the caller retries.
 *     3. Otherwise APPEND `now`, ALLOW.
 *
 *   Storage is bounded: each key's array is at most `limit` long
 *   because step 1 trims to ≤ limit-1 before step 3 appends one.
 *   Idle keys leak entries until they fully expire (the next call
 *   to that key prunes them). For an HTTP loopback server with one
 *   real caller this is fine; if we ever extend the surface, a
 *   periodic GC pass over the map can be added.
 */

/**
 * Default 100 requests per 60 seconds — the limit specified in the
 * Phase 15 task description. Exposed so callers can override
 * for tests or future tuning.
 */
export const DEFAULT_LOOPBACK_LIMIT = 100;
export const DEFAULT_LOOPBACK_WINDOW_MS = 60 * 1000;

export interface LoopbackRateLimiterOptions {
  /** Maximum requests per window. Default 100. */
  limit?: number;
  /** Window length in milliseconds. Default 60_000. */
  windowMs?: number;
  /** Injected clock (tests). Default `Date.now`. */
  nowMs?: () => number;
}

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

/**
 * In-memory sliding-window rate limiter.
 *
 * Instances are intentionally single-process and single-purpose:
 * each `KchatLocalApiServer` owns one limiter and discards it when
 * the server stops.
 */
export class LoopbackRateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly nowMs: () => number;
  private readonly buckets = new Map<string, number[]>();

  constructor(opts: LoopbackRateLimiterOptions = {}) {
    const limit = opts.limit ?? DEFAULT_LOOPBACK_LIMIT;
    const windowMs = opts.windowMs ?? DEFAULT_LOOPBACK_WINDOW_MS;
    if (limit <= 0 || !Number.isFinite(limit) || !Number.isInteger(limit)) {
      throw new Error(
        `LoopbackRateLimiter: limit must be a positive integer (got ${limit})`,
      );
    }
    if (windowMs <= 0 || !Number.isFinite(windowMs)) {
      throw new Error(
        `LoopbackRateLimiter: windowMs must be a positive finite number (got ${windowMs})`,
      );
    }
    this.limit = limit;
    this.windowMs = windowMs;
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Record an incoming request for `key`. Returns `{ ok: true }`
   * if the request is admitted, otherwise `{ ok: false,
   * retryAfterSeconds }` — the caller MUST short-circuit with HTTP
   * 429 and surface `Retry-After: <seconds>`.
   */
  check(key: string): RateLimitDecision {
    const now = this.nowMs();
    const cutoff = now - this.windowMs;
    const bucket = this.buckets.get(key) ?? [];
    // Drop expired entries. Timestamps are appended in monotonic
    // order so this is a linear walk from the start until the
    // first not-yet-expired entry.
    let drop = 0;
    while (drop < bucket.length && bucket[drop] <= cutoff) {
      drop += 1;
    }
    const fresh = drop === 0 ? bucket : bucket.slice(drop);
    if (fresh.length >= this.limit) {
      // The next slot will open up when the oldest surviving entry
      // ages out. `Math.max(1, …)` clamps to at least 1 second so
      // callers don't busy-loop on sub-second retries; HTTP
      // `Retry-After` is a whole-second integer per RFC 7231.
      const oldest = fresh[0];
      const waitMs = oldest + this.windowMs - now;
      const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
      // Persist the trimmed bucket so the next call doesn't redo
      // the same trim walk.
      this.buckets.set(key, fresh);
      return { ok: false, retryAfterSeconds };
    }
    fresh.push(now);
    this.buckets.set(key, fresh);
    return { ok: true };
  }

  /**
   * Test / shutdown hook: drop all bucket state. Production code
   * does not need to call this — bucket entries age out naturally.
   */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Test introspection: how many entries are currently tracked for
   * `key`. Production code does not need this.
   */
  bucketSize(key: string): number {
    return this.buckets.get(key)?.length ?? 0;
  }
}
