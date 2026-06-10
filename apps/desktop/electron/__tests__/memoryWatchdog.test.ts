import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MemoryWatchdog,
  nextPausedState,
  startMemoryWatchdog,
  stopMemoryWatchdog,
  isIndexingDeferredForMemory,
  memoryPressureSnapshot,
  DEFAULT_HIGH_WATER_MARK_BYTES,
  DEFAULT_LOW_WATER_MARK_BYTES,
} from "../memoryWatchdog";

const MB = 1024 * 1024;

describe("nextPausedState (LW-7 hysteresis policy)", () => {
  const low = 400 * MB;
  const high = 500 * MB;

  it("trips into paused only once RSS breaches the high mark", () => {
    expect(nextPausedState(false, 499 * MB, low, high)).toBe(false);
    expect(nextPausedState(false, 500 * MB, low, high)).toBe(true);
    expect(nextPausedState(false, 600 * MB, low, high)).toBe(true);
  });

  it("stays paused across the dead-band and only resumes below the low mark", () => {
    // In the dead-band (low <= rss < high) a paused watchdog holds.
    expect(nextPausedState(true, 450 * MB, low, high)).toBe(true);
    expect(nextPausedState(true, 400 * MB, low, high)).toBe(true);
    // Only a clear recovery below the low mark resumes.
    expect(nextPausedState(true, 399 * MB, low, high)).toBe(false);
  });

  it("does not chatter at a single threshold (the point of the gap)", () => {
    // A workload hovering at exactly 500 MB: not-paused trips, and once
    // paused it does NOT immediately resume (450/500 are in the band).
    expect(nextPausedState(false, 500 * MB, low, high)).toBe(true);
    expect(nextPausedState(true, 500 * MB, low, high)).toBe(true);
  });
});

describe("MemoryWatchdog", () => {
  it("pauses above high-water and resumes only below low-water", () => {
    let rss = 100 * MB;
    const changes: Array<{ paused: boolean; rss: number }> = [];
    const wd = new MemoryWatchdog({
      sampleRssBytes: () => rss,
      onPressureChange: (paused, rssBytes) => changes.push({ paused, rss: rssBytes }),
    });

    expect(wd.poll()).toBe(false); // 100 MB: calm

    rss = 480 * MB;
    expect(wd.poll()).toBe(false); // below high mark: still calm

    rss = 520 * MB;
    expect(wd.poll()).toBe(true); // breach high mark: pause

    rss = 450 * MB;
    expect(wd.poll()).toBe(true); // dead-band: hold pause

    rss = 380 * MB;
    expect(wd.poll()).toBe(false); // below low mark: resume

    // Exactly two transitions were observed, in order.
    expect(changes).toEqual([
      { paused: true, rss: 520 * MB },
      { paused: false, rss: 380 * MB },
    ]);
  });

  it("clamps an inverted low>high pair so it cannot chatter", () => {
    const wd = new MemoryWatchdog({
      lowWaterMarkBytes: 600 * MB,
      highWaterMarkBytes: 500 * MB,
      sampleRssBytes: () => 0,
    });
    const snap = wd.snapshot();
    // low is clamped down to high.
    expect(snap.lowWaterMarkBytes).toBe(500 * MB);
    expect(snap.highWaterMarkBytes).toBe(500 * MB);
  });

  it("fails open (holds state, never throws) when the sampler throws", () => {
    let mode: "ok" | "throw" = "ok";
    const wd = new MemoryWatchdog({
      sampleRssBytes: () => {
        if (mode === "throw") throw new Error("rss probe failed");
        return 520 * MB;
      },
    });
    expect(wd.poll()).toBe(true); // 520 MB → paused
    mode = "throw";
    // A throwing sample must not flip or crash — state is held.
    expect(() => wd.poll()).not.toThrow();
    expect(wd.isPaused()).toBe(true);
  });

  it("snapshot reports the last sample and the configured marks", () => {
    const wd = new MemoryWatchdog({ sampleRssBytes: () => 123 * MB });
    wd.poll();
    expect(wd.snapshot()).toEqual({
      paused: false,
      rssBytes: 123 * MB,
      highWaterMarkBytes: DEFAULT_HIGH_WATER_MARK_BYTES,
      lowWaterMarkBytes: DEFAULT_LOW_WATER_MARK_BYTES,
    });
  });

  it("start() is idempotent and stop() releases the timer", () => {
    vi.useFakeTimers();
    try {
      const sample = vi.fn(() => 100 * MB);
      const wd = new MemoryWatchdog({ sampleRssBytes: sample, pollIntervalMs: 1000 });
      wd.start(); // one immediate priming poll + arms the interval
      wd.start(); // second call must NOT prime again or install a 2nd interval
      vi.advanceTimersByTime(3000);
      // 1 priming poll on the first start() + 3 interval ticks; the second
      // start() is a no-op so it neither re-primes nor double-counts.
      expect(sample).toHaveBeenCalledTimes(4);
      wd.stop();
      vi.advanceTimersByTime(5000);
      expect(sample).toHaveBeenCalledTimes(4); // no ticks after stop
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("module singleton admission gate", () => {
  // These tests assert on the process-wide `singleton` in memoryWatchdog.ts,
  // which starts `null`. That holds under vitest's default worker-per-file
  // isolation, but NOT if isolation is ever disabled (`isolate: false` /
  // `threads: false`) and another file leaves a watchdog running. Reset the
  // singleton around each test so the "fails open" precondition is explicit
  // rather than implicitly relying on module-load order. `stopMemoryWatchdog`
  // is null-safe (`singleton?.stop()` then nulls it), so this is a no-op when
  // nothing is running.
  beforeEach(() => stopMemoryWatchdog());
  afterEach(() => stopMemoryWatchdog());

  it("fails open before any watchdog is started", () => {
    // No singleton yet → indexing is admitted, snapshot is null.
    expect(isIndexingDeferredForMemory()).toBe(false);
    expect(memoryPressureSnapshot()).toBeNull();
  });

  it("reflects watchdog pressure once started, then fails open after stop()", () => {
    let rss = 100 * MB;
    const wd = startMemoryWatchdog({ sampleRssBytes: () => rss });
    try {
      expect(isIndexingDeferredForMemory()).toBe(false);
      rss = 520 * MB;
      wd.poll();
      expect(isIndexingDeferredForMemory()).toBe(true);
      expect(memoryPressureSnapshot()?.paused).toBe(true);
    } finally {
      stopMemoryWatchdog();
    }
    // After stop() the admission gate MUST fail open even though the
    // watchdog was paused at teardown: a stopped watchdog can never keep
    // indexing wedged. (Regression guard for the bug where stop() left the
    // paused singleton in place and `isIndexingDeferredForMemory()` stayed
    // `true` forever.)
    expect(isIndexingDeferredForMemory()).toBe(false);
    expect(memoryPressureSnapshot()).toBeNull();
  });
});
