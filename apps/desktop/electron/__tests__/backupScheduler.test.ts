/**
 * Tests for the automatic-backup scheduler (`backupScheduler.ts`).
 *
 * The scheduler runs in the Electron main process and drives hot
 * backups of the encrypted database on a cadence. These tests inject
 * the timer + clock + bridge seams (`BackupSchedulerDeps`) so the
 * behaviour is exercised deterministically without real waits:
 *
 *   1. `runBackupNow` creates a backup and prunes to the retention.
 *   2. A prune failure does NOT fail the backup (best-effort prune).
 *   3. Single-flight: a second `runBackupNow` while one is in flight
 *      coalesces onto the same promise (one copy, not two).
 *   4. Catch-up on launch: a stale newest backup (or none) schedules an
 *      initial backup after `INITIAL_CATCHUP_DELAY_MS`; a fresh one does
 *      not.
 *   5. `autoBackup: false` arms no timers.
 *   6. The steady interval timer fires a backup each period.
 *   7. `stopBackupScheduler` clears timers and drains an in-flight copy.
 *   8. Status reflects last success / last error.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as path from "path";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/userData") },
}));

// `resolveBackupDir` builds the default with `path.join`, so the
// expected separator is platform-dependent (`/` on POSIX, `\` on
// Windows). Compute the expectation the same way so the assertion is
// not pinned to a single OS's separator.
const DEFAULT_BACKUP_DIR = path.join("/userData", "backups");

const loadConfigMock = vi.fn();
vi.mock("../config", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { BackupInfo, NativeBridge } from "../appState";
import type { AppConfig } from "../config";
import {
  INITIAL_CATCHUP_DELAY_MS,
  runBackupNow,
  startBackupScheduler,
  stopBackupScheduler,
  resolveBackupDir,
  getBackupSchedulerStatus,
  _resetBackupSchedulerForTests,
  type BackupSchedulerDeps,
} from "../backupScheduler";

/** Minimal config with the backup fields the scheduler reads. */
function fakeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    autoBackup: true,
    backupDir: "",
    backupIntervalHours: 24,
    backupRetentionCount: 7,
    ...overrides,
  } as AppConfig;
}

function fakeBackupInfo(overrides: Partial<BackupInfo> = {}): BackupInfo {
  return {
    path: "/userData/backups/tessera-2026.tdbak",
    fileName: "tessera-2026.tdbak",
    createdAtMs: 1_000_000,
    sizeBytes: 4096,
    ...overrides,
  };
}

/**
 * A controllable timer harness: captures scheduled callbacks so a test
 * can fire them on demand and advance a virtual clock.
 */
function makeHarness(bridge: NativeBridge | null) {
  let nowMs = 10_000_000;
  const intervals: Array<{ fn: () => void; ms: number; id: number }> = [];
  const timeouts: Array<{ fn: () => void; ms: number; id: number }> = [];
  let nextId = 1;

  const deps: BackupSchedulerDeps = {
    setInterval: (fn, ms) => {
      const id = nextId++;
      intervals.push({ fn, ms, id });
      return id as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: (handle) => {
      const idx = intervals.findIndex((i) => i.id === (handle as unknown));
      if (idx >= 0) intervals.splice(idx, 1);
    },
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timeouts.push({ fn, ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (handle) => {
      const idx = timeouts.findIndex((t) => t.id === (handle as unknown));
      if (idx >= 0) timeouts.splice(idx, 1);
    },
    now: () => nowMs,
    getBridge: () => bridge,
  };

  return {
    deps,
    intervals,
    timeouts,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setNow: (ms: number) => {
      nowMs = ms;
    },
    fireInitialTimeout: () => {
      const t = timeouts.shift();
      if (!t) throw new Error("no initial timeout scheduled");
      t.fn();
    },
    fireInterval: () => {
      if (intervals.length === 0) throw new Error("no interval scheduled");
      intervals[0].fn();
    },
  };
}

function makeBridge(overrides: Partial<NativeBridge> = {}): NativeBridge {
  return {
    bridgeCreateBackup: vi.fn(() => fakeBackupInfo()),
    bridgePruneBackups: vi.fn(() => []),
    bridgeListBackups: vi.fn(() => []),
    ...overrides,
  } as unknown as NativeBridge;
}

beforeEach(() => {
  _resetBackupSchedulerForTests();
  loadConfigMock.mockReset();
  loadConfigMock.mockReturnValue(fakeConfig());
});

describe("resolveBackupDir", () => {
  it("uses <userData>/backups when backupDir is empty", () => {
    expect(resolveBackupDir(fakeConfig({ backupDir: "" }))).toBe(
      DEFAULT_BACKUP_DIR,
    );
  });

  it("honours an explicit backupDir", () => {
    expect(
      resolveBackupDir(fakeConfig({ backupDir: "/custom/dir" })),
    ).toBe("/custom/dir");
  });

  it("treats a whitespace-only backupDir as the default sentinel", () => {
    expect(resolveBackupDir(fakeConfig({ backupDir: "   " }))).toBe(
      DEFAULT_BACKUP_DIR,
    );
  });
});

describe("runBackupNow", () => {
  it("creates a backup and prunes to the retention count", async () => {
    const bridge = makeBridge();
    const h = makeHarness(bridge);
    // runBackupNow uses module deps; prime them via startBackupScheduler
    // with autoBackup off so only the deps are installed, no timers.
    loadConfigMock.mockReturnValue(fakeConfig({ autoBackup: false }));
    startBackupScheduler(h.deps);
    loadConfigMock.mockReturnValue(
      fakeConfig({ backupRetentionCount: 3, backupDir: "/d" }),
    );

    const info = await runBackupNow();

    expect(info.fileName).toBe("tessera-2026.tdbak");
    expect(bridge.bridgeCreateBackup).toHaveBeenCalledWith("/d");
    expect(bridge.bridgePruneBackups).toHaveBeenCalledWith("/d", 3);
    expect(getBackupSchedulerStatus().lastBackupError).toBeNull();
  });

  it("does not fail the backup when pruning throws", async () => {
    const bridge = makeBridge({
      bridgePruneBackups: vi.fn(() => {
        throw new Error("prune boom");
      }),
    });
    const h = makeHarness(bridge);
    loadConfigMock.mockReturnValue(fakeConfig({ autoBackup: false }));
    startBackupScheduler(h.deps);

    const info = await runBackupNow();
    expect(info.fileName).toBe("tessera-2026.tdbak");
    expect(getBackupSchedulerStatus().lastBackupError).toBeNull();
  });

  it("records lastBackupError when the backup itself throws", async () => {
    const bridge = makeBridge({
      bridgeCreateBackup: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    const h = makeHarness(bridge);
    loadConfigMock.mockReturnValue(fakeConfig({ autoBackup: false }));
    startBackupScheduler(h.deps);

    await expect(runBackupNow()).rejects.toThrow("disk full");
    expect(getBackupSchedulerStatus().lastBackupError).toBe("disk full");
  });

  it("stopBackupScheduler drains the full side-effect chain on failure", async () => {
    // Regression: `activeBackup` must hold the *chained* promise (with
    // the .catch that records lastBackupError and the .finally that
    // clears the guard), not the raw IIFE promise. If it held the raw
    // promise, the drain in stopBackupScheduler would resolve a microtask
    // early — before lastBackupError was recorded and before the guard
    // was cleared.
    const bridge = makeBridge({
      bridgeCreateBackup: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    const h = makeHarness(bridge);
    loadConfigMock.mockReturnValue(fakeConfig({ autoBackup: false }));
    startBackupScheduler(h.deps);

    // Kick off a failing backup but do NOT await its returned promise,
    // so the drain — not our await — is what settles the chain.
    const pending = runBackupNow();
    pending.catch(() => {
      /* failure asserted via status below */
    });

    await stopBackupScheduler();

    const status = getBackupSchedulerStatus();
    expect(status.lastBackupError).toBe("disk full");
    expect(status.inFlight).toBe(false);
  });

  it("coalesces concurrent calls onto a single in-flight backup", async () => {
    const createMock = vi.fn(() => fakeBackupInfo());
    const bridge = makeBridge({
      bridgeCreateBackup:
        createMock as unknown as NativeBridge["bridgeCreateBackup"],
    });
    const h = makeHarness(bridge);
    loadConfigMock.mockReturnValue(fakeConfig({ autoBackup: false }));
    startBackupScheduler(h.deps);

    // Fire two backups without awaiting between them. The second call
    // observes the still-set `activeBackup` guard and returns the
    // in-flight promise instead of starting a second copy against the
    // shared connection, so the bridge is hit exactly once.
    const p1 = runBackupNow();
    const p2 = runBackupNow();
    await Promise.all([p1, p2]);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when the bridge is unavailable", async () => {
    const h = makeHarness(null);
    loadConfigMock.mockReturnValue(fakeConfig({ autoBackup: false }));
    startBackupScheduler(h.deps);
    await expect(runBackupNow()).rejects.toThrow(/native bridge/i);
  });
});

describe("startBackupScheduler — catch-up + cadence", () => {
  it("schedules a catch-up backup when no backup exists", async () => {
    const bridge = makeBridge({ bridgeListBackups: vi.fn(() => []) });
    const h = makeHarness(bridge);
    startBackupScheduler(h.deps);

    // One initial timeout (catch-up) + one steady interval armed.
    expect(h.timeouts).toHaveLength(1);
    expect(h.timeouts[0].ms).toBe(INITIAL_CATCHUP_DELAY_MS);
    expect(h.intervals).toHaveLength(1);

    h.fireInitialTimeout();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.bridgeCreateBackup).toHaveBeenCalledTimes(1);
  });

  it("schedules a catch-up when the newest backup is older than the interval", () => {
    const bridge = makeBridge({
      bridgeListBackups: vi.fn(() => [fakeBackupInfo({ createdAtMs: 0 })]),
    });
    const h = makeHarness(bridge);
    // now is 10_000_000; interval 1h = 3_600_000 → newest is stale.
    loadConfigMock.mockReturnValue(fakeConfig({ backupIntervalHours: 1 }));
    startBackupScheduler(h.deps);
    expect(h.timeouts).toHaveLength(1);
  });

  it("does NOT schedule a catch-up when the newest backup is fresh", () => {
    const h0 = makeHarness(null);
    const freshTs = h0.deps.now() - 1000; // 1s ago
    const bridge = makeBridge({
      bridgeListBackups: vi.fn(() => [
        fakeBackupInfo({ createdAtMs: freshTs }),
      ]),
    });
    const h = makeHarness(bridge);
    loadConfigMock.mockReturnValue(fakeConfig({ backupIntervalHours: 24 }));
    startBackupScheduler(h.deps);
    // No catch-up timeout, but the steady interval is still armed.
    expect(h.timeouts).toHaveLength(0);
    expect(h.intervals).toHaveLength(1);
  });

  it("arms no timers when autoBackup is disabled", () => {
    const bridge = makeBridge();
    const h = makeHarness(bridge);
    loadConfigMock.mockReturnValue(fakeConfig({ autoBackup: false }));
    startBackupScheduler(h.deps);
    expect(h.timeouts).toHaveLength(0);
    expect(h.intervals).toHaveLength(0);
    expect(getBackupSchedulerStatus().running).toBe(false);
  });

  it("fires a backup on each steady interval tick", async () => {
    const bridge = makeBridge({
      bridgeListBackups: vi.fn(() => [
        fakeBackupInfo({ createdAtMs: makeHarness(null).deps.now() }),
      ]),
    });
    const h = makeHarness(bridge);
    startBackupScheduler(h.deps);
    h.fireInterval();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.bridgeCreateBackup).toHaveBeenCalledTimes(1);
  });
});

describe("stopBackupScheduler", () => {
  it("clears timers and reports not running", async () => {
    const bridge = makeBridge();
    const h = makeHarness(bridge);
    startBackupScheduler(h.deps);
    expect(getBackupSchedulerStatus().running).toBe(true);
    await stopBackupScheduler();
    expect(getBackupSchedulerStatus().running).toBe(false);
    expect(h.intervals).toHaveLength(0);
    expect(h.timeouts).toHaveLength(0);
  });
});
