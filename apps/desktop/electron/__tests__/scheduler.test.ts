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
}));

import type { NativeBridge, AutomationInfo } from "../appState";
import {
  tick,
  dispatchOnGenerate,
  getSchedulerStatus,
  __testing__,
} from "../scheduler";

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
  bridgeReindexSource: ReturnType<typeof vi.fn>;
  bridgeGenerateFromTemplate: ReturnType<typeof vi.fn>;
  bridgeRecordAutomationRun: ReturnType<typeof vi.fn>;
}

function newBridge(): BridgeMock {
  return {
    bridgeDueScheduledAutomations: vi.fn().mockReturnValue([]),
    bridgeMatchingOnGenerateAutomations: vi.fn().mockReturnValue([]),
    bridgeReindexSource: vi.fn().mockReturnValue({}),
    bridgeGenerateFromTemplate: vi.fn().mockReturnValue({}),
    bridgeRecordAutomationRun: vi.fn(),
  };
}

beforeEach(() => {
  __testing__.reset();
  vi.clearAllMocks();
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
