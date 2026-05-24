/**
 * In-memory rate limiter for expensive IPC operations.
 *
 * Defense-in-depth against a buggy or compromised renderer that
 * hammers a single channel. The renderer already debounces user
 * input, so any traffic that trips a limit here represents a real
 * fault (infinite loop, runaway component re-render, malicious code)
 * and should fail fast rather than tie up the main process.
 *
 * Strategy: a simple token bucket per "channel:discriminator" key.
 *   - `channel` is the IPC channel name.
 *   - `discriminator` lets us scope limits per-provider (so
 *     `connectors:sync:google_drive` and `connectors:sync:notion`
 *     have independent budgets), per-job, etc.
 *
 * The bucket is refilled at `tokensPerInterval / intervalMs`. Calls
 * that hit an empty bucket throw `RateLimitError`. We intentionally
 * keep this in-process / in-memory — the limits are sized for
 * "one user, one Electron window" and do not need persistence.
 */

export interface RateLimitConfig {
  /** Number of tokens added to the bucket each interval. */
  tokensPerInterval: number;
  /** Interval in milliseconds. */
  intervalMs: number;
  /** Maximum tokens the bucket can hold. Defaults to tokensPerInterval. */
  burst?: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimitError extends Error {
  constructor(
    public readonly channel: string,
    public readonly retryAfterMs: number,
  ) {
    super(
      `Rate limit exceeded for ${channel} — retry in ${Math.ceil(
        retryAfterMs / 1000,
      )}s`,
    );
    this.name = "RateLimitError";
  }
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Attempt to consume one token from the bucket for the given key.
   * Throws {@link RateLimitError} when the bucket is empty.
   */
  consume(key: string, config: RateLimitConfig): void {
    const burst = config.burst ?? config.tokensPerInterval;
    const t = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: burst, lastRefillMs: t };
      this.buckets.set(key, bucket);
    } else {
      const elapsed = t - bucket.lastRefillMs;
      if (elapsed > 0) {
        const refill = (elapsed / config.intervalMs) * config.tokensPerInterval;
        bucket.tokens = Math.min(burst, bucket.tokens + refill);
        bucket.lastRefillMs = t;
      }
    }
    if (bucket.tokens < 1) {
      const deficit = 1 - bucket.tokens;
      const retryAfterMs =
        (deficit / config.tokensPerInterval) * config.intervalMs;
      throw new RateLimitError(key, retryAfterMs);
    }
    bucket.tokens -= 1;
  }

  /** Reset all buckets (used by tests). */
  reset(): void {
    this.buckets.clear();
  }

  /** Visible state for tests. */
  inspect(key: string): { tokens: number; lastRefillMs: number } | undefined {
    return this.buckets.get(key);
  }
}

/**
 * Default profile for the limits called out in the  brief.
 *
 * - `connectors:authenticate` — 1 per 5s per provider.
 * - `connectors:sync` — 1 per 30s per provider.
 * - `runtime:downloadModel` — 1 concurrent (handled with a separate
 *   in-flight flag in the runtime handler; rate limiter still bounds
 *   *start* attempts to 1 every 5s as a safety net).
 * - `sources:search` — 10 per second (debounce is in renderer, this
 *   is defense-in-depth).
 * - `sources:backfillEmbeddings` — 1 every 10s. Backfill walks the
 *   whole chunks table and runs the embedder on every missing row;
 *   a clicky user mashing the Re-embed button could otherwise queue
 *   up multiple concurrent passes. The Rust side is also idempotent
 *   so a second click is at worst a no-op, but rate-limiting saves
 *   the spurious round trips and gives the user predictable UI
 *   feedback ("you can re-click in 10 seconds").
 * - `settings:updateHybridSearchConfig` — 5 per second. The Settings
 *   slider can fire many updates as the user drags it; rate-limiting
 *   prevents the IPC channel from becoming a bottleneck while still
 *   letting interactive feedback flow through.
 * - `externalProvider:listModels` — 1 per second, burst 5. The
 *   "List models" button on the External Provider settings card
 *   issues an outbound HTTPS request with the user's API key on
 *   every click. Without a limiter a misbehaving renderer (or a
 *   user mashing the button while iterating on the URL field)
 *   could flood the upstream provider, costing the user real money
 *   on metered APIs and tripping per-IP throttling on the upstream
 *   side (which would then cascade into failed `externalProvider:
 *   test` calls). The 5-token burst lets a power user click
 *   List → tweak URL → List → tweak again a few times without
 *   hitting the gate, while the 1/s refill blocks scripted
 *   abuse. Matches the sibling-handler posture (`connectors:
 *   authenticate`, `connectors:sync`, `runtime:downloadModel`)
 *   that also wrap outbound network calls.
 * - `externalProvider:test` — 1 per second, burst 5. Identical
 *   shape and rationale to `listModels`: the "Test" button on
 *   the same External Provider settings card issues an outbound
 *   HTTPS chat-completion request (NOT a discovery call) with the
 *   user's API key on every click, costing real tokens on metered
 *   APIs. The test request is arguably MORE expensive than
 *   listModels (chat completion vs. cheap discovery endpoint), so
 *   leaving it ungated while limiting listModels would invert the
 *   protection priority. Adding this entry closes the gap
 *   between `listModels` and its sibling outbound-network
 *   handler.
 */
export const RATE_LIMIT_PROFILES = {
  "connectors:authenticate": {
    tokensPerInterval: 1,
    intervalMs: 5_000,
  },
  "connectors:sync": {
    tokensPerInterval: 1,
    intervalMs: 30_000,
  },
  "runtime:downloadModel": {
    tokensPerInterval: 1,
    intervalMs: 5_000,
  },
  "sources:search": {
    tokensPerInterval: 10,
    intervalMs: 1_000,
    burst: 20,
  },
  "sources:backfillEmbeddings": {
    tokensPerInterval: 1,
    intervalMs: 10_000,
  },
  "settings:updateHybridSearchConfig": {
    tokensPerInterval: 5,
    intervalMs: 1_000,
    burst: 10,
  },
  "externalProvider:listModels": {
    tokensPerInterval: 1,
    intervalMs: 1_000,
    burst: 5,
  },
  "externalProvider:test": {
    tokensPerInterval: 1,
    intervalMs: 1_000,
    burst: 5,
  },
} satisfies Record<string, RateLimitConfig>;

/** Shared default limiter instance used by the IPC layer. */
export const defaultRateLimiter = new RateLimiter();
