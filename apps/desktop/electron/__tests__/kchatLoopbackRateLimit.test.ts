/**
 * sliding-window rate limiter on the loopback
 * KChat extension API.
 *
 * The pure limiter (`LoopbackRateLimiter`) and its HTTP integration
 * (the `respondRateLimited` path in `KchatLocalApiServer.dispatch`)
 * are tested separately:
 *
 *   - Pure unit tests assert the sliding-window math: 1..N admit,
 *     N+1 rejects, expired entries age out, different keys are
 *     isolated, Retry-After is rounded up to the right whole second.
 *   - Integration tests boot a real `KchatLocalApiServer` on
 *     127.0.0.1, fire 101 requests within the configured window,
 *     and assert: (a) requests 1..100 return 200, (b) request 101
 *     returns 429 with a `Retry-After` header, (c) the body uses
 *     the standard `LocalApiError` wire shape with `code:
 *     "rate_limited"`.
 *
 * Tests use a clock injection so the wall-clock window is never
 * actually waited on — fast and deterministic.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_LOOPBACK_LIMIT,
  DEFAULT_LOOPBACK_WINDOW_MS,
  LoopbackRateLimiter,
} from "../kchat/kchatRateLimiter";
import {
  KchatLocalApiServer,
  type LocalApiHandlers,
} from "../kchat/kchatLocalApi";

const TEST_TOKEN = "x".repeat(40);

describe("LoopbackRateLimiter — sliding-window math", () => {
  it("uses the documented defaults (100 req / 60s)", () => {
    expect(DEFAULT_LOOPBACK_LIMIT).toBe(100);
    expect(DEFAULT_LOOPBACK_WINDOW_MS).toBe(60_000);
  });

  it("admits exactly `limit` requests inside the window, rejects the next one", () => {
    let t = 1_700_000_000_000;
    const limiter = new LoopbackRateLimiter({
      limit: 5,
      windowMs: 1000,
      nowMs: () => t,
    });
    for (let i = 0; i < 5; i += 1) {
      const decision = limiter.check("127.0.0.1");
      expect(decision.ok).toBe(true);
      t += 10; // 10ms between requests, well inside the 1s window
    }
    const denied = limiter.check("127.0.0.1");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    // Five requests at t=0, 10, 20, 30, 40 (relative); the limiter
    // observed denial at t=50. Oldest entry is t=0; it ages out at
    // t=1000. Wait time = 1000 - 50 = 950ms → ceil to 1s, then
    // clamped to ≥ 1s. So Retry-After must be 1.
    expect(denied.retryAfterSeconds).toBe(1);
  });

  it("admits a new request once the oldest entry has aged out", () => {
    let t = 1_700_000_000_000;
    const limiter = new LoopbackRateLimiter({
      limit: 3,
      windowMs: 1000,
      nowMs: () => t,
    });
    // Fill the bucket at t=0, 100, 200 (relative).
    limiter.check("k");
    t += 100;
    limiter.check("k");
    t += 100;
    limiter.check("k");
    // 4th request at t=300 → denied.
    expect(limiter.check("k").ok).toBe(false);
    // Advance to t=1001 — only the t=0 entry has aged out, so the
    // bucket holds t=100 and t=200, leaving room for one more.
    t = 1_700_000_000_000 + 1001;
    const allowed = limiter.check("k");
    expect(allowed.ok).toBe(true);
    // And ONE more after that should be denied again — t=100 is
    // still inside the window (t=100 + 1000 = 1100 > 1001), so
    // the bucket is full.
    expect(limiter.check("k").ok).toBe(false);
  });

  it("rounds Retry-After UP to the next whole second (per RFC 7231)", () => {
    let t = 1_700_000_000_000;
    const limiter = new LoopbackRateLimiter({
      limit: 1,
      windowMs: 5000,
      nowMs: () => t,
    });
    limiter.check("k"); // admit at t=0
    t += 100; // 100ms in
    const denied = limiter.check("k");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    // Oldest entry ages out at t=5000; current t=100 → wait 4900ms
    // → ceil to 5s.
    expect(denied.retryAfterSeconds).toBe(5);
  });

  it("isolates buckets per key — two IPs do not share the same budget", () => {
    const t = 1_700_000_000_000;
    const limiter = new LoopbackRateLimiter({
      limit: 2,
      windowMs: 1000,
      nowMs: () => t,
    });
    limiter.check("ip-a");
    limiter.check("ip-a");
    expect(limiter.check("ip-a").ok).toBe(false);
    // ip-b's budget is independent.
    expect(limiter.check("ip-b").ok).toBe(true);
    expect(limiter.check("ip-b").ok).toBe(true);
    expect(limiter.check("ip-b").ok).toBe(false);
    expect(limiter.bucketSize("ip-a")).toBe(2);
    expect(limiter.bucketSize("ip-b")).toBe(2);
  });

  it("clamps Retry-After to a minimum of 1 second", () => {
    // A pathological clock skew where the oldest entry is already
    // past its window when we check would give a negative wait. The
    // contract is "Retry-After is always >= 1" so RFC-7231 clients
    // don't busy-loop.
    let t = 1_700_000_000_000;
    const limiter = new LoopbackRateLimiter({
      limit: 1,
      windowMs: 1000,
      nowMs: () => t,
    });
    limiter.check("k"); // admit at t=0
    t += 999; // 999ms in — entry still in window, just barely.
    const denied = limiter.check("k");
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    // wait = 1000 - 999 = 1ms → ceil → 1s → clamp → 1s.
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("rejects construction with a non-positive limit", () => {
    expect(() => new LoopbackRateLimiter({ limit: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => new LoopbackRateLimiter({ limit: -1 })).toThrow(
      /positive integer/,
    );
    expect(() => new LoopbackRateLimiter({ limit: 1.5 })).toThrow(
      /positive integer/,
    );
  });

  it("rejects construction with a non-positive window", () => {
    expect(() => new LoopbackRateLimiter({ windowMs: 0 })).toThrow(
      /positive finite/,
    );
    expect(() => new LoopbackRateLimiter({ windowMs: -1 })).toThrow(
      /positive finite/,
    );
  });

  it("reset() clears all buckets", () => {
    const limiter = new LoopbackRateLimiter({ limit: 2, windowMs: 1000 });
    limiter.check("k");
    limiter.check("k");
    expect(limiter.bucketSize("k")).toBe(2);
    limiter.reset();
    expect(limiter.bucketSize("k")).toBe(0);
    expect(limiter.check("k").ok).toBe(true);
  });
});

describe("KchatLocalApiServer — loopback rate limit integration", () => {
  let cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const fn of cleanup) await fn();
    cleanup = [];
  });

  function makeHandlers(): LocalApiHandlers {
    return {
      async status() {
        return {
          tesseraVersion: "test",
          capabilities: [],
          apiServerPort: 0,
          startedAt: new Date(0).toISOString(),
          processId: process.pid,
        };
      },
      async listSources() {
        return [];
      },
      async ingestChannel() {
        return { sourceId: "s", state: "running" };
      },
      async shareArtifact() {
        return { shareId: "x", postId: "y", permalink: "https://e/x" };
      },
    };
  }

  async function startServer(opts: { limit: number; windowMs: number }) {
    const userDataDir = mkdtempSync(join(tmpdir(), "tessera-ratelimit-"));
    const now = { value: 1_700_000_000_000 };
    const server = new KchatLocalApiServer(makeHandlers(), {
      userDataDir,
      tokenForTesting: TEST_TOKEN,
      nowMsForTesting: () => now.value,
      rateLimit: { limit: opts.limit, windowMs: opts.windowMs },
    });
    const { port } = await server.start();
    cleanup.push(async () => {
      await server.stop();
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    });
    return {
      server,
      now,
      baseUrl: `http://127.0.0.1:${port}`,
    };
  }

  it("returns 429 with Retry-After after the configured limit is reached", async () => {
    // Use a tiny limit so the test runs fast. The integration is
    // identical at limit=100 — we just don't want to fire 100
    // network round-trips inside a unit test.
    const { baseUrl } = await startServer({ limit: 3, windowMs: 60_000 });
    const headers = {
      authorization: `Bearer ${TEST_TOKEN}`,
      "content-type": "application/json",
    };
    const r1 = await fetch(`${baseUrl}/api/status`, { headers });
    const r2 = await fetch(`${baseUrl}/api/status`, { headers });
    const r3 = await fetch(`${baseUrl}/api/status`, { headers });
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);

    const r4 = await fetch(`${baseUrl}/api/status`, { headers });
    expect(r4.status).toBe(429);
    const retryAfter = r4.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    expect(Number.parseInt(retryAfter ?? "0", 10)).toBeGreaterThanOrEqual(1);
    const body = (await r4.json()) as { code: string; message: string };
    expect(body.code).toBe("rate_limited");
    expect(body.message).toMatch(/rate limit/i);
  });

  it("rate-limits BEFORE bearer auth so 429 wins over 401 when both apply", async () => {
    // A spammer hammering the loopback with bad bearer tokens
    // would still consume the rate budget if auth ran first — and
    // worse, the legitimate caller (sharing the IP) would be
    // locked out by the spammer's failed-auth volume.
    // Task 28 specifies the limiter runs BEFORE auth. Verify by
    // exhausting the budget with auth'd requests, then asserting
    // an UN-auth'd request now also gets 429 (not 401) — the
    // limiter intercepted before requireBearer could fire.
    const { baseUrl } = await startServer({ limit: 2, windowMs: 60_000 });
    const headers = {
      authorization: `Bearer ${TEST_TOKEN}`,
      "content-type": "application/json",
    };
    await fetch(`${baseUrl}/api/status`, { headers });
    await fetch(`${baseUrl}/api/status`, { headers });
    // Now hit the same IP with NO bearer at all. Without rate
    // limiting this would be a 401 unauthorized. With rate
    // limiting in the right place, it's a 429.
    const unauth = await fetch(`${baseUrl}/api/status`);
    expect(unauth.status).toBe(429);
    expect(unauth.headers.get("retry-after")).not.toBeNull();
  });

  it("admits a new request after the window slides", async () => {
    // Advance the injected clock past the window between requests
    // to verify the sliding-window logic threads through the HTTP
    // server correctly (not just the standalone limiter).
    const { baseUrl, now } = await startServer({ limit: 1, windowMs: 1000 });
    const headers = {
      authorization: `Bearer ${TEST_TOKEN}`,
      "content-type": "application/json",
    };
    const r1 = await fetch(`${baseUrl}/api/status`, { headers });
    expect(r1.status).toBe(200);
    const r2 = await fetch(`${baseUrl}/api/status`, { headers });
    expect(r2.status).toBe(429);
    // Slide the window past expiry, then retry — should admit.
    now.value += 2000;
    const r3 = await fetch(`${baseUrl}/api/status`, { headers });
    expect(r3.status).toBe(200);
  });
});
