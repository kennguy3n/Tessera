/**
 * Tests for the 6-hour substrate decay scheduler (Session 1).
 *
 * The scheduler arms a `setInterval` that calls
 * `bridge.bridgeRunDecaySweep()` directly in the main process. We use
 * fake timers + a stubbed bridge to assert:
 *
 *   1. The interval fires a sweep every `DECAY_INTERVAL_MS`.
 *   2. `start` is idempotent (no stacked intervals) and `stop` cancels
 *      future ticks.
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
  it("fires a sweep on every interval tick", () => {
    startSubstrateDecayScheduler();
    expect(bridgeMock.bridgeRunDecaySweep).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DECAY_INTERVAL_MS);
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DECAY_INTERVAL_MS);
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(2);
  });

  it("is idempotent — a second start does not stack intervals", () => {
    startSubstrateDecayScheduler();
    startSubstrateDecayScheduler();
    vi.advanceTimersByTime(DECAY_INTERVAL_MS);
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledTimes(1);
  });

  it("stops firing after stop()", () => {
    startSubstrateDecayScheduler();
    stopSubstrateDecayScheduler();
    vi.advanceTimersByTime(DECAY_INTERVAL_MS * 3);
    expect(bridgeMock.bridgeRunDecaySweep).not.toHaveBeenCalled();
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
