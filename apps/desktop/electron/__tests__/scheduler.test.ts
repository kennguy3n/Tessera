/**
 * Tests for the automations scheduler service. The scheduler runs in
 * the Electron main process and dispatches `Schedule`-triggered
 * automations directly against the N-API bridge. These tests cover:
 *
 * 1. `tick()` dispatches each due automation and records the run.
 * 2. Reindex action calls `bridgeReindexSource` with the correct id.
 * 3. Generate action calls `bridgeGenerateFromTemplate` with template + sources.
 * 4. An action that throws records a `failed: ...` status (not "ok").
 * 5. `dispatchOnGenerate` only fires matching automations + persists their status.
 * 6. Re-entrancy guard prevents overlapping ticks (a slow tick must not
 *    produce double-fires).
 * 7. A bridge-level failure on `bridgeDueScheduledAutomations` surfaces
 *    via `getSchedulerStatus().lastTickError` without crashing the loop.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../appState", () => ({
  getBridge: vi.fn(),
  getKchatBackfillImpl: vi.fn(),
}));

import type { NativeBridge, AutomationInfo } from "../appState";
import { getKchatBackfillImpl } from "../appState";
import {
  tick,
  runNow,
  stopScheduler,
  dispatchOnGenerate,
  dispatchKchatMessage,
  getSchedulerStatus,
  __testing__,
} from "../scheduler";
import {
  __setBatteryStatusForTests,
  stopBatteryMonitor,
} from "../batteryMonitor";

const mockedGetKchatBackfillImpl = vi.mocked(getKchatBackfillImpl);

function fakeAutomation(
  id: string,
  actionJson: string,
  overrides: Partial<AutomationInfo> = {},
): AutomationInfo {
  return {
    id,
    name: `auto-${id}`,
    triggerJson: '{"kind":"schedule","interval_seconds":3600}',
    actionJson,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    nextScheduledAt: null,
    ...overrides,
  };
}

interface BridgeMock {
  bridgeDueScheduledAutomations: ReturnType<typeof vi.fn>;
  bridgeMatchingOnGenerateAutomations: ReturnType<typeof vi.fn>;
  bridgeMatchingKchatMessageAutomations: ReturnType<typeof vi.fn>;
  bridgeReindexSource: ReturnType<typeof vi.fn>;
  bridgeGenerateFromTemplate: ReturnType<typeof vi.fn>;
  bridgeRecordAutomationRun: ReturnType<typeof vi.fn>;
}

function newBridge(): BridgeMock {
  return {
    bridgeDueScheduledAutomations: vi.fn().mockReturnValue([]),
    bridgeMatchingOnGenerateAutomations: vi.fn().mockReturnValue([]),
    bridgeMatchingKchatMessageAutomations: vi.fn().mockReturnValue([]),
    bridgeReindexSource: vi.fn().mockReturnValue({}),
    bridgeGenerateFromTemplate: vi.fn().mockReturnValue({}),
    bridgeRecordAutomationRun: vi.fn(),
  };
}

beforeEach(() => {
  __testing__.reset();
  vi.clearAllMocks();
  // LW-3: reset to the fail-open (AC always) snapshot so a battery
  // level set by one test never leaks into the next. The default state
  // means `isBatteryLow()` is false, so existing tests are unaffected.
  stopBatteryMonitor();
});

describe("scheduler.tick", () => {
  it("dispatches each due automation and records ok", async () => {
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "a1",
        '{"kind":"reindex_source","source_id":"src-1"}',
      ),
      fakeAutomation(
        "a2",
        '{"kind":"generate_from_template","template_id":"prd-v1","source_ids":["s1","s2"]}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeReindexSource).toHaveBeenCalledWith("src-1");
    expect(bridge.bridgeGenerateFromTemplate).toHaveBeenCalledWith(
      "prd-v1",
      ["s1", "s2"],
    );
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("a1", "ok");
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("a2", "ok");

    const status = getSchedulerStatus();
    expect(status.lastTickError).toBeNull();
    expect(status.lastTickAt).not.toBeNull();
    expect(status.inFlight).toBe(false);
  });

  it("records `failed: ...` when an action throws", async () => {
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation("bad", '{"kind":"reindex_source","source_id":"src-x"}'),
    ]);
    bridge.bridgeReindexSource.mockImplementation(() => {
      throw new Error("source not found");
    });

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith(
      "bad",
      "failed: source not found",
    );
    // The tick itself succeeded — only the individual action failed.
    expect(getSchedulerStatus().lastTickError).toBeNull();
  });

  it("skips generate_from_template on low battery and records skipped: battery_low", async () => {
    // LW-3: a laptop at/below 20% on battery defers background
    // synthesis. The action must NOT call the bridge, and the run must
    // record a non-failure `skipped: battery_low` so the UI shows it as
    // deferred (and the automation fires normally once charged).
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 12,
    });
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "gen",
        '{"kind":"generate_from_template","template_id":"prd-v1","source_ids":["s1"]}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeGenerateFromTemplate).not.toHaveBeenCalled();
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith(
      "gen",
      "skipped: battery_low",
    );
    expect(getSchedulerStatus().lastTickError).toBeNull();
  });

  it("does NOT gate reindex_source on low battery (only synthesis is gated)", async () => {
    // Battery gating is synthesis-only: indexing/sync are cheap relative
    // to SLM inference and must keep working so search stays fresh.
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 5,
    });
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation("idx", '{"kind":"reindex_source","source_id":"src-1"}'),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeReindexSource).toHaveBeenCalledWith("src-1");
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("idx", "ok");
  });

  it("does NOT gate generation when discharging but above threshold", async () => {
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 55,
    });
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "gen",
        '{"kind":"generate_from_template","template_id":"t","source_ids":[]}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeGenerateFromTemplate).toHaveBeenCalledWith("t", []);
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("gen", "ok");
  });

  it("records a structural error for malformed actionJson", async () => {
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation("malformed", "not-json"),
    ]);

    await tick(bridge as unknown as NativeBridge);

    const recorded = bridge.bridgeRecordAutomationRun.mock.calls[0];
    expect(recorded[0]).toBe("malformed");
    expect(recorded[1]).toMatch(/^failed:/);
  });

  it("surfaces bridge-level failures via lastTickError without throwing", async () => {
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockImplementation(() => {
      throw new Error("db locked");
    });

    await expect(
      tick(bridge as unknown as NativeBridge),
    ).resolves.toBeUndefined();
    expect(getSchedulerStatus().lastTickError).toBe("db locked");
    // No automations ever ran, so no recordAutomationRun call.
    expect(bridge.bridgeRecordAutomationRun).not.toHaveBeenCalled();
  });

  it("re-entrancy guard prevents overlapping ticks", async () => {
    const bridge = newBridge();
    // First call returns one automation whose reindex blocks until
    // we release it; second call (from the parallel `tick`) should be
    // ignored because `inFlight` is true.
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dueCallCount = 0;
    bridge.bridgeDueScheduledAutomations.mockImplementation(() => {
      dueCallCount += 1;
      if (dueCallCount === 1) {
        return [
          fakeAutomation(
            "slow",
            '{"kind":"reindex_source","source_id":"src-slow"}',
          ),
        ];
      }
      return [];
    });
    bridge.bridgeReindexSource.mockImplementation(async () => {
      await blocked;
    });

    const firstTick = tick(bridge as unknown as NativeBridge);
    // While the first tick is still running, fire a second one. It
    // must short-circuit at the `inFlight` guard.
    const secondTick = tick(bridge as unknown as NativeBridge);
    release();
    await Promise.all([firstTick, secondTick]);

    // `bridgeDueScheduledAutomations` was called exactly once because
    // the second tick bailed before reading due automations.
    expect(dueCallCount).toBe(1);
  });
});

describe("scheduler.runNow", () => {
  it("runs immediately when no tick is in flight", async () => {
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "rn1",
        '{"kind":"reindex_source","source_id":"src-immediate"}',
      ),
    ]);

    await runNow(bridge as unknown as NativeBridge);

    expect(bridge.bridgeReindexSource).toHaveBeenCalledWith("src-immediate");
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("rn1", "ok");
  });

  it("queues a follow-up tick when one is already in flight so the caller always observes a fresh run", async () => {
    const bridge = newBridge();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dueCallCount = 0;
    bridge.bridgeDueScheduledAutomations.mockImplementation(() => {
      dueCallCount += 1;
      // Both invocations return the same automation, so a successful
      // queue-then-run produces two recorded runs (one for the active
      // tick, one for the queued follow-up).
      return [
        fakeAutomation(
          `slow-${dueCallCount}`,
          '{"kind":"reindex_source","source_id":"src-slow"}',
        ),
      ];
    });
    bridge.bridgeReindexSource.mockImplementationOnce(async () => {
      await blocked;
    });

    const firstTick = tick(bridge as unknown as NativeBridge);
    const runNowPromise = runNow(bridge as unknown as NativeBridge);
    release();
    await Promise.all([firstTick, runNowPromise]);

    // The interval-driven tick and the runNow-queued tick each ran
    // once — the runNow caller's click was not silently dropped.
    expect(dueCallCount).toBe(2);
    expect(bridge.bridgeReindexSource).toHaveBeenCalledTimes(2);
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent runNow callers onto a single queued follow-up", async () => {
    const bridge = newBridge();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dueCallCount = 0;
    bridge.bridgeDueScheduledAutomations.mockImplementation(() => {
      dueCallCount += 1;
      return [
        fakeAutomation(
          `coalesce-${dueCallCount}`,
          '{"kind":"reindex_source","source_id":"src-coalesce"}',
        ),
      ];
    });
    bridge.bridgeReindexSource.mockImplementationOnce(async () => {
      await blocked;
    });

    const firstTick = tick(bridge as unknown as NativeBridge);
    // Three concurrent clicks while the first tick is still blocking.
    // They must all resolve, but only ONE extra tick should run.
    const r1 = runNow(bridge as unknown as NativeBridge);
    const r2 = runNow(bridge as unknown as NativeBridge);
    const r3 = runNow(bridge as unknown as NativeBridge);
    release();
    await Promise.all([firstTick, r1, r2, r3]);

    // Active tick + single coalesced follow-up = 2 invocations total.
    expect(dueCallCount).toBe(2);
  });
});

describe("scheduler.stopScheduler", () => {
  it("awaits an in-flight tick before resolving", async () => {
    const bridge = newBridge();
    let released = false;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = () => {
        released = true;
        resolve();
      };
    });
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "long-running",
        '{"kind":"reindex_source","source_id":"src-block"}',
      ),
    ]);
    bridge.bridgeReindexSource.mockImplementation(async () => {
      await blocked;
    });

    const tickPromise = tick(bridge as unknown as NativeBridge);
    const stopPromise = stopScheduler();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });
    // Yield a few microtasks; stopScheduler must NOT resolve while the
    // tick is still blocking.
    await Promise.resolve();
    await Promise.resolve();
    expect(stopResolved).toBe(false);
    expect(released).toBe(false);

    release();
    await Promise.all([tickPromise, stopPromise]);
    expect(stopResolved).toBe(true);
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith(
      "long-running",
      "ok",
    );
  });

  it("awaits a queued runNow follow-up as well", async () => {
    const bridge = newBridge();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dueCallCount = 0;
    bridge.bridgeDueScheduledAutomations.mockImplementation(() => {
      dueCallCount += 1;
      return [
        fakeAutomation(
          `drain-${dueCallCount}`,
          '{"kind":"reindex_source","source_id":"src-drain"}',
        ),
      ];
    });
    bridge.bridgeReindexSource.mockImplementationOnce(async () => {
      await blocked;
    });

    const firstTick = tick(bridge as unknown as NativeBridge);
    // Queue a follow-up while the first tick is blocked.
    const queuedFollowUp = runNow(bridge as unknown as NativeBridge);
    // stopScheduler must wait for BOTH the active tick and the queued
    // follow-up — otherwise the process would tear down while the
    // follow-up was still executing against the bridge.
    const stopPromise = stopScheduler();

    release();
    await Promise.all([firstTick, queuedFollowUp, stopPromise]);

    // Both the active tick and the queued follow-up executed before
    // stopScheduler resolved.
    expect(dueCallCount).toBe(2);
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledTimes(2);
  });
});

describe("scheduler.dispatchOnGenerate", () => {
  it("only dispatches automations whose trigger matches the template id", async () => {
    const bridge = newBridge();
    bridge.bridgeMatchingOnGenerateAutomations.mockReturnValue([
      fakeAutomation(
        "og1",
        '{"kind":"reindex_source","source_id":"src-A"}',
      ),
    ]);

    await dispatchOnGenerate("prd-v1", bridge as unknown as NativeBridge);

    expect(bridge.bridgeMatchingOnGenerateAutomations).toHaveBeenCalledWith(
      "prd-v1",
    );
    expect(bridge.bridgeReindexSource).toHaveBeenCalledWith("src-A");
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("og1", "ok");
  });

  it("swallows bridge errors when resolving matches", async () => {
    const bridge = newBridge();
    bridge.bridgeMatchingOnGenerateAutomations.mockImplementation(() => {
      throw new Error("template lookup failed");
    });

    // Must not propagate — generation is the user's primary action and
    // we don't want a broken automation to fail the parent IPC.
    await expect(
      dispatchOnGenerate("bogus", bridge as unknown as NativeBridge),
    ).resolves.toBeUndefined();
    expect(bridge.bridgeRecordAutomationRun).not.toHaveBeenCalled();
  });
});

describe("scheduler.getSchedulerStatus", () => {
  it("reports `running=false` before startScheduler is called", () => {
    const status = getSchedulerStatus();
    expect(status.running).toBe(false);
    expect(status.lastTickAt).toBeNull();
    expect(status.lastTickError).toBeNull();
  });
});

// ----------------------------------------------------------------
// Scheduler + KChat backfill interaction
// ----------------------------------------------------------------

describe("scheduler.tick — backfill_kchat_channel action", () => {
  it("dispatches a KChat backfill and records ok", async () => {
    const bridge = newBridge();
    const backfillSpy = vi.fn().mockResolvedValue({
      outcome: "completed",
      pagesWalked: 1,
      totalPostsIngested: 5,
      totalPostsUnchanged: 0,
      totalPostsSkippedRevoked: 0,
    });
    mockedGetKchatBackfillImpl.mockReturnValue(backfillSpy);
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "bf1",
        '{"kind":"backfill_kchat_channel","channel_id":"chidschedbackfillaaaaaaaa"}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(backfillSpy).toHaveBeenCalledWith("chidschedbackfillaaaaaaaa");
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("bf1", "ok");
    expect(getSchedulerStatus().lastTickError).toBeNull();
  });

  it("records failed when backfill impl is not available", async () => {
    const bridge = newBridge();
    mockedGetKchatBackfillImpl.mockReturnValue(null);
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "bf-noimpl",
        '{"kind":"backfill_kchat_channel","channel_id":"chidschedbackfillaaaaaaaa"}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    const recorded = bridge.bridgeRecordAutomationRun.mock.calls[0];
    expect(recorded[0]).toBe("bf-noimpl");
    expect(recorded[1]).toMatch(/^failed:.*not available/i);
  });

  it("records failed when channel_id is missing", async () => {
    const bridge = newBridge();
    const backfillSpy = vi.fn();
    mockedGetKchatBackfillImpl.mockReturnValue(backfillSpy);
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "bf-noid",
        '{"kind":"backfill_kchat_channel"}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    const recorded = bridge.bridgeRecordAutomationRun.mock.calls[0];
    expect(recorded[0]).toBe("bf-noid");
    expect(recorded[1]).toMatch(/^failed:.*missing channel_id/i);
    expect(backfillSpy).not.toHaveBeenCalled();
  });

  it("records failed when backfill impl throws", async () => {
    const bridge = newBridge();
    const backfillSpy = vi.fn().mockRejectedValue(
      new Error("REST 403: user removed from channel"),
    );
    mockedGetKchatBackfillImpl.mockReturnValue(backfillSpy);
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "bf-err",
        '{"kind":"backfill_kchat_channel","channel_id":"chidschedbackfillaaaaaaaa"}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    const recorded = bridge.bridgeRecordAutomationRun.mock.calls[0];
    expect(recorded[0]).toBe("bf-err");
    expect(recorded[1]).toMatch(/^failed:.*403/);
    expect(getSchedulerStatus().lastTickError).toBeNull();
  });

  it("mixes backfill + reindex actions in one tick without interference", async () => {
    const bridge = newBridge();
    const backfillSpy = vi.fn().mockResolvedValue({
      outcome: "completed",
      pagesWalked: 1,
      totalPostsIngested: 3,
      totalPostsUnchanged: 0,
      totalPostsSkippedRevoked: 0,
    });
    mockedGetKchatBackfillImpl.mockReturnValue(backfillSpy);
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "a-reindex",
        '{"kind":"reindex_source","source_id":"src-mixed"}',
      ),
      fakeAutomation(
        "a-backfill",
        '{"kind":"backfill_kchat_channel","channel_id":"chidmixedtickaaaaaaaaaaa"}',
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeReindexSource).toHaveBeenCalledWith("src-mixed");
    expect(backfillSpy).toHaveBeenCalledWith("chidmixedtickaaaaaaaaaaa");
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith(
      "a-reindex",
      "ok",
    );
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith(
      "a-backfill",
      "ok",
    );
  });
});

// ----------------------------------------------------------------
// on_kchat_message_match dispatch
// ----------------------------------------------------------------

describe("scheduler.dispatchKchatMessage", () => {
  it("runs every automation the bridge reports as matching", async () => {
    const bridge = newBridge();
    bridge.bridgeMatchingKchatMessageAutomations.mockReturnValue([
      fakeAutomation(
        "km1",
        '{"kind":"reindex_source","source_id":"src-km"}',
        { triggerJson: '{"kind":"on_kchat_message_match","channel_id":"c1","regex":"deploy"}' },
      ),
    ]);

    await dispatchKchatMessage("c1", "please deploy now", bridge as unknown as NativeBridge);

    expect(bridge.bridgeMatchingKchatMessageAutomations).toHaveBeenCalledWith(
      "c1",
      "please deploy now",
    );
    expect(bridge.bridgeReindexSource).toHaveBeenCalledWith("src-km");
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("km1", "ok");
  });

  it("is a no-op when the channel id is empty (never calls the bridge)", async () => {
    const bridge = newBridge();
    await dispatchKchatMessage("", "anything", bridge as unknown as NativeBridge);
    expect(bridge.bridgeMatchingKchatMessageAutomations).not.toHaveBeenCalled();
    expect(bridge.bridgeRecordAutomationRun).not.toHaveBeenCalled();
  });

  it("swallows a bridge resolution failure without throwing", async () => {
    const bridge = newBridge();
    bridge.bridgeMatchingKchatMessageAutomations.mockImplementation(() => {
      throw new Error("regex engine exploded");
    });
    await expect(
      dispatchKchatMessage("c1", "msg", bridge as unknown as NativeBridge),
    ).resolves.toBeUndefined();
    expect(bridge.bridgeRecordAutomationRun).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------
// Multi-step (sequence) actions
// ----------------------------------------------------------------

describe("scheduler — multi-step sequence actions", () => {
  it("runs every leaf step in order and records ok when all succeed", async () => {
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "seq-ok",
        JSON.stringify({
          kind: "sequence",
          actions: [
            { kind: "reindex_source", source_id: "s1" },
            { kind: "reindex_source", source_id: "s2" },
            { kind: "generate_from_template", template_id: "t1", source_ids: ["s3"] },
          ],
        }),
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeReindexSource.mock.calls).toEqual([["s1"], ["s2"]]);
    expect(bridge.bridgeGenerateFromTemplate).toHaveBeenCalledWith("t1", ["s3"]);
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith("seq-ok", "ok");
  });

  it("continues past a failing step and aggregates failures in the status", async () => {
    const bridge = newBridge();
    bridge.bridgeReindexSource.mockImplementation((id: string) => {
      if (id === "boom") throw new Error("kaboom");
    });
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "seq-partial",
        JSON.stringify({
          kind: "sequence",
          actions: [
            { kind: "reindex_source", source_id: "ok-1" },
            { kind: "reindex_source", source_id: "boom" },
            { kind: "reindex_source", source_id: "ok-2" },
          ],
        }),
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    // The failing middle step did NOT abort the chain — both ok steps ran.
    expect(bridge.bridgeReindexSource.mock.calls).toEqual([
      ["ok-1"],
      ["boom"],
      ["ok-2"],
    ]);
    const recorded = bridge.bridgeRecordAutomationRun.mock.calls[0];
    expect(recorded[0]).toBe("seq-partial");
    expect(recorded[1]).toBe("failed: 1/3 steps failed: step 2: kaboom");
  });

  it("flattens nested sequences before executing", async () => {
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "seq-nested",
        JSON.stringify({
          kind: "sequence",
          actions: [
            { kind: "reindex_source", source_id: "a" },
            {
              kind: "sequence",
              actions: [
                { kind: "reindex_source", source_id: "b" },
                { kind: "reindex_source", source_id: "c" },
              ],
            },
          ],
        }),
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeReindexSource.mock.calls).toEqual([["a"], ["b"], ["c"]]);
    expect(bridge.bridgeRecordAutomationRun).toHaveBeenCalledWith(
      "seq-nested",
      "ok",
    );
  });

  it("treats a low-battery skip of a generate step as skipped, not failed", async () => {
    // LW-3: in a sequence, a deferred synthesis step must not count as a
    // failure. The reindex steps still run (indexing is never gated) and
    // the run records `skipped: battery_low` rather than `failed: …`.
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 8,
    });
    const bridge = newBridge();
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "seq-batt",
        JSON.stringify({
          kind: "sequence",
          actions: [
            { kind: "reindex_source", source_id: "s1" },
            { kind: "generate_from_template", template_id: "t1", source_ids: [] },
          ],
        }),
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    expect(bridge.bridgeReindexSource).toHaveBeenCalledWith("s1");
    expect(bridge.bridgeGenerateFromTemplate).not.toHaveBeenCalled();
    const recorded = bridge.bridgeRecordAutomationRun.mock.calls[0];
    expect(recorded[0]).toBe("seq-batt");
    expect(recorded[1]).toBe("skipped: battery_low (1/2 steps)");
  });

  it("reports BOTH failures and battery skips when a sequence has both", async () => {
    // LW-3 review fix: when a sequence has a genuinely failing step AND a
    // battery-deferred synthesis step, the recorded status must disclose
    // both. Reporting only `failed: 1/3` would imply the other two steps
    // ran fine and hide that one was deferred. Steps: reindex(fails) →
    // generate(battery-skipped) → reindex(ok).
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 8,
    });
    const bridge = newBridge();
    bridge.bridgeReindexSource.mockImplementation((id: string) => {
      if (id === "boom") throw new Error("source not found");
    });
    bridge.bridgeDueScheduledAutomations.mockReturnValue([
      fakeAutomation(
        "seq-mixed",
        JSON.stringify({
          kind: "sequence",
          actions: [
            { kind: "reindex_source", source_id: "boom" },
            { kind: "generate_from_template", template_id: "t1", source_ids: [] },
            { kind: "reindex_source", source_id: "ok" },
          ],
        }),
      ),
    ]);

    await tick(bridge as unknown as NativeBridge);

    // The battery-gated generate never ran; both reindex steps were
    // attempted (one threw, one succeeded).
    expect(bridge.bridgeGenerateFromTemplate).not.toHaveBeenCalled();
    expect(bridge.bridgeReindexSource.mock.calls).toEqual([["boom"], ["ok"]]);
    const recorded = bridge.bridgeRecordAutomationRun.mock.calls[0];
    expect(recorded[0]).toBe("seq-mixed");
    expect(recorded[1]).toBe(
      "failed: 1/3 steps failed (1 skipped: battery_low): step 1: source not found",
    );
  });
});
