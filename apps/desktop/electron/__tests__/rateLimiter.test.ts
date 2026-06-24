import { describe, it, expect } from "vitest";
import {
  RateLimiter,
  RateLimitError,
  RATE_LIMIT_PROFILES,
} from "../ipc/rateLimiter";

function fakeClock() {
  let now = 0;
  return {
    advance: (ms: number) => (now += ms),
    set: (ms: number) => (now = ms),
    read: () => now,
  };
}

describe("RateLimiter", () => {
  it("allows the first call and then blocks until refill", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock.read);
    const cfg = { tokensPerInterval: 1, intervalMs: 1000 };

    limiter.consume("k", cfg);
    expect(() => limiter.consume("k", cfg)).toThrowError(RateLimitError);
  });

  it("refills tokens over time", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock.read);
    const cfg = { tokensPerInterval: 1, intervalMs: 1000 };

    limiter.consume("k", cfg);
    expect(() => limiter.consume("k", cfg)).toThrow();
    clock.advance(1000);
    expect(() => limiter.consume("k", cfg)).not.toThrow();
  });

  it("honours burst > tokensPerInterval", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock.read);
    const cfg = { tokensPerInterval: 1, intervalMs: 1000, burst: 5 };

    for (let i = 0; i < 5; i += 1) {
      expect(() => limiter.consume("k", cfg)).not.toThrow();
    }
    expect(() => limiter.consume("k", cfg)).toThrow();
  });

  it("isolates buckets per key", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock.read);
    const cfg = { tokensPerInterval: 1, intervalMs: 1000 };

    limiter.consume("a", cfg);
    expect(() => limiter.consume("a", cfg)).toThrow();
    expect(() => limiter.consume("b", cfg)).not.toThrow();
  });

  it("includes retry-after on the thrown error", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock.read);
    const cfg = { tokensPerInterval: 1, intervalMs: 5000 };

    limiter.consume("k", cfg);
    try {
      limiter.consume("k", cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      const rle = err as RateLimitError;
      expect(rle.retryAfterMs).toBeGreaterThan(0);
      expect(rle.channel).toBe("k");
    }
  });

  it("clamps refill at burst capacity", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock.read);
    const cfg = { tokensPerInterval: 1, intervalMs: 1000, burst: 2 };

    limiter.consume("k", cfg);
    limiter.consume("k", cfg);
    // Wait long enough to refill many times — burst caps the bucket.
    clock.advance(60_000);
    limiter.consume("k", cfg);
    limiter.consume("k", cfg);
    expect(() => limiter.consume("k", cfg)).toThrow();
  });

  it("RATE_LIMIT_PROFILES exports stable channel keys", () => {
    expect(RATE_LIMIT_PROFILES["connectors:authenticate"].intervalMs).toBe(
      5000,
    );
    expect(RATE_LIMIT_PROFILES["connectors:sync"].intervalMs).toBe(30_000);
    expect(RATE_LIMIT_PROFILES["sources:search"].tokensPerInterval).toBe(10);
  });

  it("reset() clears all buckets", () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(clock.read);
    const cfg = { tokensPerInterval: 1, intervalMs: 1000 };

    limiter.consume("k", cfg);
    limiter.reset();
    expect(() => limiter.consume("k", cfg)).not.toThrow();
  });
});
