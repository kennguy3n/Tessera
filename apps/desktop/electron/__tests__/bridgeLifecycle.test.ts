/**
 * LW-8 (cold-start budget): bridge-readiness signal contract.
 *
 * These specs pin the main-side state machine that carries the
 * "bridge is up / failed" transition to the renderer so it can stop
 * showing the "Loading workspace…" skeleton. The invariants under test:
 *
 *   1. The module boots in `initializing` (the renderer must not
 *      optimistically hydrate before the bridge is up).
 *   2. Every transition broadcasts the new snapshot to renderers.
 *   3. An `error` state carries its reason; any non-error transition
 *      clears a previously-set reason so a stale message can't linger.
 *   4. A throwing broadcaster never escapes `setBridgeState` — a send
 *      failure must not wedge boot (the renderer falls back to the
 *      `getBridgeState` invoke).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

import {
  BRIDGE_STATE_CHANNEL,
  getBridgeStateSnapshot,
  setBridgeState,
  _resetBridgeStateForTests,
} from "../bridgeLifecycle";
import type { BridgeStateView } from "../../shared/types";

beforeEach(() => {
  _resetBridgeStateForTests();
});

describe("bridge lifecycle state", () => {
  it("starts in the initializing state with no error", () => {
    expect(getBridgeStateSnapshot()).toEqual({
      state: "initializing",
      error: null,
    });
  });

  it("getBridgeStateSnapshot returns a defensive copy", () => {
    const a = getBridgeStateSnapshot();
    const b = getBridgeStateSnapshot();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("broadcasts the snapshot on the ready transition", () => {
    const sent: Array<{ channel: string; payload: BridgeStateView }> = [];
    const snap = setBridgeState("ready", {
      broadcast: (channel, payload) => sent.push({ channel, payload }),
    });
    expect(snap).toEqual({ state: "ready", error: null });
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(BRIDGE_STATE_CHANNEL);
    expect(sent[0].payload).toEqual({ state: "ready", error: null });
    expect(getBridgeStateSnapshot()).toEqual({ state: "ready", error: null });
  });

  it("records the reason on an error transition", () => {
    const snap = setBridgeState("error", {
      error: "open_store failed: locked",
      broadcast: () => {},
    });
    expect(snap).toEqual({
      state: "error",
      error: "open_store failed: locked",
    });
  });

  it("defaults the error reason when none is supplied", () => {
    const snap = setBridgeState("error", { broadcast: () => {} });
    expect(snap.state).toBe("error");
    expect(snap.error).toBe("Unknown error");
  });

  it("clears a stale error reason on a non-error transition", () => {
    setBridgeState("error", { error: "boom", broadcast: () => {} });
    const snap = setBridgeState("ready", { broadcast: () => {} });
    expect(snap).toEqual({ state: "ready", error: null });
    expect(getBridgeStateSnapshot().error).toBeNull();
  });

  it("swallows a throwing broadcaster so boot can never wedge", () => {
    expect(() =>
      setBridgeState("ready", {
        broadcast: () => {
          throw new Error("webContents destroyed mid-send");
        },
      }),
    ).not.toThrow();
    // The state still advanced even though the broadcast failed — the
    // renderer learns it via the getBridgeState invoke on next mount.
    expect(getBridgeStateSnapshot()).toEqual({ state: "ready", error: null });
  });

  it("_resetBridgeStateForTests returns to initializing", () => {
    setBridgeState("ready", { broadcast: () => {} });
    _resetBridgeStateForTests();
    expect(getBridgeStateSnapshot()).toEqual({
      state: "initializing",
      error: null,
    });
  });
});
