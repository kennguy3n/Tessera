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
 * Default profile pinning the expensive-IPC channels.
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
  // ONNX model download. A 22 MB or 120 MB
  // download takes 5-60 s on a typical home connection. The bridge
  // tracker's `mark_starting` resets the progress slot but does NOT
  // serialise concurrent `DownloadEmbeddingModelTask` instances —
  // two rapid calls before this rate limiter kicks in could both
  // spawn libuv workers that proceed in parallel (the SHA-256 /
  // atomic-rename invariant keeps them safe but their progress
  // updates would race and waste bandwidth). This rate limiter at
  // 1 / 5 s is the actual primary serialisation barrier; the SHA
  // check is the integrity backstop. Both together also keep the
  // upstream HuggingFace CDN happy under runaway-component
  // scenarios.
  "settings:downloadEmbeddingModel": {
    tokensPerInterval: 1,
    intervalMs: 5_000,
  },
  // Switching the active model is cheap (a few hundred ms ONNX
  // session load) but every switch invalidates the current
  // model's vectors from the search hot path and queues a
  // backfill. 1 per second is plenty for an attentive user; a
  // runaway component would otherwise oscillate the active model
  // and thrash the search engine's vector cache.
  "settings:switchEmbeddingModel": {
    tokensPerInterval: 1,
    intervalMs: 1_000,
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
  // Vision completion: ~5-15 s per call (image base64 + VLM
  // forward pass on llama-server). Burst of 5 lets the indexing
  // pipeline batch a few images quickly without the rate limiter
  // tripping; the 1/s refill blocks a runaway component (e.g. a
  // visual-sources panel that re-mounts in a render loop) from
  // queueing thousands of vision calls.
  "vision:describe": {
    tokensPerInterval: 1,
    intervalMs: 1_000,
    burst: 5,
  },
  // Image generation: ~10-30 s per call on FLUX.2-klein on a
  // consumer GPU. The IPC handler ALSO enforces 1 in-flight call
  // at a time (the diffusion sidecar is single-threaded under the
  // hood — running two concurrent generations would double VRAM
  // pressure and tank both). This rate limiter is the defense-
  // in-depth lower bound: 1 token per 5 s lets a user click
  // "Generate" → review → click again steadily, while a frozen-
  // button-mash attack settles into one start per 5 s instead of
  // overwhelming the in-flight gate with rejected tries.
  "imagegen:generate": {
    tokensPerInterval: 1,
    intervalMs: 5_000,
  },
  // KChat REST calls: KChat (Mattermost) production rate-limits to
  // 7000 req/s per host with a burst of 100. We sit well under that
  // so a Tessera client never contributes to a server-side throttle.
  // 5 req/s sustained with a burst of 20 covers normal browsing
  // (channel list → file list → presence) plus a handful of
  // concurrent file downloads.
  "kchat:request": {
    tokensPerInterval: 5,
    intervalMs: 1_000,
    burst: 20,
  },
  // KChat file uploads (artifact share): rate-limit to 1 per 2 s,
  // burst 3. A user can share a few exports in a row but a runaway
  // component cannot flood the channel.
  "kchat:upload": {
    tokensPerInterval: 1,
    intervalMs: 2_000,
    burst: 3,
  },
  // KChat channel sync polling: 1 per 15 s. A KChat-channel source
  // re-fetches its file list on this cadence; faster polling adds
  // no real-time value because new files trigger a WebSocket event
  // anyway and that path bypasses the rate limiter.
  "kchat:syncChannel": {
    tokensPerInterval: 1,
    intervalMs: 15_000,
  },
  // KChat post-body retrieval. Mirrors
  // the `sources:search` profile (10 r/s sustained, 20 burst) so
  // a renderer that debounces and fires both `sources:search` +
  // `kchat:searchPosts` for every keystroke can keep up under
  // typical typing speed without tripping either gate. The IPC
  // handler also performs an AEAD-verify per chunk (one AES-GCM-
  // 256 open per hit), so the actual cost ceiling is bounded by
  // the limit * verification cost, not by the IPC call rate.
  "kchat:searchPosts": {
    tokensPerInterval: 10,
    intervalMs: 1_000,
    burst: 20,
  },
  // "Open in KChat Desktop" deeplink fan-out.
  // The handler calls `shell.openExternal()` to invoke a
  // `kchat://app/conversation/<id>` URL the user clicked on in
  // the Tessera sidebar. A single user click should fire the
  // channel exactly once; we cap at 4 per second sustained with
  // a burst of 8 so a multi-channel batch action ("open every
  // selected channel in Desktop") still runs without rate-limit
  // pain, but a runaway re-render cannot spam the OS shell.
  "kchat:openInDesktop": {
    tokensPerInterval: 4,
    intervalMs: 1_000,
    burst: 8,
  },
  // backfill progress polling. The
  // SourceDetailPage subscribes via this channel while a backfill
  // is active; a single user-initiated source detail view should
  // poll at most a few times per second. 2/s sustained with
  // burst 5 lets the UI refresh smoothly during active backfill
  // without enabling a runaway poll loop.
  "kchat:backfillProgress": {
    tokensPerInterval: 2,
    intervalMs: 1_000,
    burst: 5,
  },
  // thread-context retrieval is called
  // on-demand when the user expands a search hit's thread
  // affordance. The substrate call is cheap (single SQL window
  // bounded at 3 rows + per-row AEAD verify); no network. A
  // legitimate caller fires this once per expand-click — a
  // sustained 5/s with burst 10 lets a user rapidly expand
  // several threads in quick succession (e.g. cycling through
  // search hits) without throttling, while still being tight
  // enough that a buggy auto-expand-all renderer can't pin a
  // CPU.
  "kchat:fetchThreadContext": {
    tokensPerInterval: 5,
    intervalMs: 1_000,
    burst: 10,
  },
  // `kchat:searchUsers` backs the `@mention` typeahead in the
  // DocumentEditor. The renderer debounces keystrokes, but each
  // accepted keystroke fires a server-side user search; 8/s with
  // burst 12 keeps fast typing smooth while bounding a runaway
  // component that re-fires the query on every render.
  "kchat:searchUsers": {
    tokensPerInterval: 8,
    intervalMs: 1_000,
    burst: 12,
  },
  // `kchat:getUserStatuses` backs the Sidebar presence indicator,
  // which polls on a timer and on reconnect. 2/s with burst 5 lets
  // the indicator refresh promptly after a reconnect without
  // letting a misbehaving poll loop hammer the status endpoint.
  "kchat:getUserStatuses": {
    tokensPerInterval: 2,
    intervalMs: 1_000,
    burst: 5,
  },
} satisfies Record<string, RateLimitConfig>;

/** Shared default limiter instance used by the IPC layer. */
export const defaultRateLimiter = new RateLimiter();
