/**
 * Tests for the 6-hour substrate decay scheduler (Session 1).
 *
 * The scheduler arms a `setInterval` that calls
 * `bridge.bridgeRunDecaySweep()` directly in the main process. We use
 * fake timers + a stubbed bridge to assert:
 *
 *   1. `start` runs an immediate catch-up sweep, then fires a sweep
 *      every `DECAY_INTERVAL_MS`.
 *   2. `start` is idempotent (no stacked intervals, no double catch-up)
 *      and `stop` cancels future ticks.
 *   3. `runSubstrateDecaySweepOnce` no-ops when the bridge is absent
 *      (cold start) and swallows bridge-side errors (a bad sweep can't
 *      crash the main process or cancel the timer).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const bridgeMock = {
  bridgeRunDecaySweep: vi
    .fn()
    .mockReturnValue({ scored: 0, candidatesArchived: 0, supersededArchived: 0 }),
};

let bridgeAvailable = true;

vi.mock("../appState", () => ({
  getBridge: () => (bridgeAvailable ? bridgeMock : null),
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  DECAY_INTERVAL_MS,
  runSubstrateDecaySweepOnce,
  startSubstrateDecayScheduler,
  stopSubstrateDecayScheduler,
} from "../substrateDecayScheduler";

beforeEach(() => {
  vi.useFakeTimers();
  bridgeAvailable = true;
  bridgeMock.bridgeRunDecaySweep.mockClear();
  bridgeMock.bridgeRunDecaySweep.mockReturnValue({
    scored: 0,
    candidatesArchived: 0,
    supersededArchived: 0,
  });
});

afterEach(() => {
  stopSubstrateDecayScheduler();
  vi.useRealTimers();
});

describe("substrate decay scheduler", () => {
  it("runs a catch-up sweep on start, then on every interval tick", () => {
    startSubstrateDecayScheduler();
    // Immediate catch-up sweep so decay isn't gated on 6h of continuous
    // uptime (a desktop app rarely accumulates that in one session).
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DECAY_INTERVAL_MS);
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(DECAY_INTERVAL_MS);
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(3);
  });

  it("is idempotent — a second start neither double-sweeps nor stacks intervals", () => {
    startSubstrateDecayScheduler();
    startSubstrateDecayScheduler();
    // The second start is a no-op: exactly one catch-up sweep, not two.
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(1);
    // One interval fires one tick (not two) — proving no stacked interval.
    vi.advanceTimersByTime(DECAY_INTERVAL_MS);
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(2);
  });

  it("stops firing after stop()", () => {
    startSubstrateDecayScheduler();
    // The start-time catch-up sweep has already fired once.
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(1);
    stopSubstrateDecayScheduler();
    vi.advanceTimersByTime(DECAY_INTERVAL_MS * 3);
    // No further sweeps after stop().
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(1);
  });

  it("stop() is safe to call when never started", () => {
    expect(() => stopSubstrateDecayScheduler()).not.toThrow();
  });

  it("runOnce no-ops without a bridge", () => {
    bridgeAvailable = false;
    expect(() => runSubstrateDecaySweepOnce()).not.toThrow();
    expect(bridgeMock.bridgeRunDecaySweep).not.toHaveBeenCalled();
  });

  it("runOnce swallows a bridge-side error", () => {
    bridgeMock.bridgeRunDecaySweep.mockImplementationOnce(() => {
      throw new Error("sweep boom");
    });
    expect(() => runSubstrateDecaySweepOnce()).not.toThrow();
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(1);
  });
});
