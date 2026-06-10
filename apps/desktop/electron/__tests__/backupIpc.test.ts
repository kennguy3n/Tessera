/**
 * Integration tests for the `backup:*` IPC channels.
 *
 * The handlers are a thin main-process layer over the Rust bridge and
 * the backup scheduler; the crypto / atomicity guarantees live Rust-
 * side. These tests pin the wiring that the renderer depends on:
 *
 *   1. Every documented channel is registered on `ipcMain` (name
 *      pinning so the preload bridge can't drift).
 *   2. `backup:create` delegates to the scheduler's single-flight
 *      `runBackupNow` (shared prune + coalescing), not a raw bridge call.
 *   3. `backup:list` lists the resolved backup dir, newest-first.
 *   4. `backup:restore` STAGES (never mutates the live DB) and reports
 *      `requiresRestart: true`.
 *   5. `backup:configure` persists via `updateConfig` and refreshes the
 *      scheduler so a cadence change needs no restart; strict schema
 *      drops unknown keys.
 *   6. `backup:status` reflects config + scheduler health.
 *   7. bundle export/import forward the config sidecar (the renderer
 *      never learns the on-disk config path) and the handlers reject a
 *      missing bridge loudly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
}));

const getBridgeMock = vi.fn();
vi.mock("../appState", () => ({
  getBridge: () => getBridgeMock(),
}));

const loadConfigMock = vi.fn();
const updateConfigMock = vi.fn();
const getConfigPathMock = vi.fn(() => "/userData/config.json");
vi.mock("../config", () => ({
  loadConfig: () => loadConfigMock(),
  updateConfig: (patch: unknown) => updateConfigMock(patch),
  getConfigPath: () => getConfigPathMock(),
}));

const runBackupNowMock = vi.fn();
const refreshBackupSchedulerMock = vi.fn();
const getBackupSchedulerStatusMock = vi.fn();
const resolveBackupDirMock = vi.fn();
vi.mock("../backupScheduler", () => ({
  runBackupNow: () => runBackupNowMock(),
  refreshBackupScheduler: () => refreshBackupSchedulerMock(),
  getBackupSchedulerStatus: () => getBackupSchedulerStatusMock(),
  resolveBackupDir: (...args: unknown[]) => resolveBackupDirMock(...args),
}));

import { registerBackupHandlers } from "../ipc/backup";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

function getHandler(channel: string): Handler {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as Handler;
}

const FAKE_EVENT = { sender: { id: 1 } as unknown };

const BACKUP_INFO = {
  path: "/userData/backups/tessera-1.tdbak",
  fileName: "tessera-1.tdbak",
  createdAtMs: 1_700_000_000_000,
  sizeBytes: 4096,
};

function fakeConfig() {
  return {
    autoBackup: true,
    backupDir: "",
    backupIntervalHours: 24,
    backupRetentionCount: 7,
  };
}

function fakeSchedulerStatus() {
  return {
    running: true,
    inFlight: false,
    lastBackupAt: 1_700_000_000_000,
    lastBackupError: null,
  };
}

beforeEach(() => {
  handleMock.mockClear();
  removeHandlerMock.mockClear();
  getBridgeMock.mockReset();
  loadConfigMock.mockReset().mockReturnValue(fakeConfig());
  updateConfigMock.mockReset();
  getConfigPathMock.mockClear();
  runBackupNowMock.mockReset();
  refreshBackupSchedulerMock.mockReset();
  getBackupSchedulerStatusMock
    .mockReset()
    .mockReturnValue(fakeSchedulerStatus());
  resolveBackupDirMock.mockReset().mockReturnValue("/userData/backups");
  registerBackupHandlers();
});

describe("registerBackupHandlers — channel registration", () => {
  it("registers exactly the documented channel set", () => {
    const channels = handleMock.mock.calls.map((c) => c[0]).sort();
    expect(channels).toEqual(
      [
        "backup:configure",
        "backup:create",
        "backup:exportBundle",
        "backup:importBundle",
        "backup:list",
        "backup:restore",
        "backup:status",
      ].sort(),
    );
  });
});

describe("backup:create", () => {
  it("delegates to the single-flight runBackupNow", async () => {
    runBackupNowMock.mockResolvedValue(BACKUP_INFO);
    const result = await getHandler("backup:create")(FAKE_EVENT);
    expect(runBackupNowMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(BACKUP_INFO);
  });
});

describe("backup:list", () => {
  it("lists the resolved backup directory", async () => {
    const bridge = { bridgeListBackups: vi.fn(() => [BACKUP_INFO]) };
    getBridgeMock.mockReturnValue(bridge);
    const result = await getHandler("backup:list")(FAKE_EVENT);
    expect(bridge.bridgeListBackups).toHaveBeenCalledWith("/userData/backups");
    expect(result).toEqual([BACKUP_INFO]);
  });

  it("throws when the bridge is unavailable", async () => {
    getBridgeMock.mockReturnValue(null);
    await expect(getHandler("backup:list")(FAKE_EVENT)).rejects.toThrow(
      /bridge/i,
    );
  });
});

describe("backup:restore", () => {
  it("stages the chosen backup and requires a restart", async () => {
    const bridge = {
      bridgeStageRestore: vi.fn(() => "/userData/tessera.db.pending-restore"),
    };
    getBridgeMock.mockReturnValue(bridge);
    const result = await getHandler("backup:restore")(FAKE_EVENT, {
      backupPath: "/userData/backups/tessera-1.tdbak",
    });
    expect(bridge.bridgeStageRestore).toHaveBeenCalledWith(
      "/userData/backups/tessera-1.tdbak",
    );
    expect(result).toEqual({
      stagedPath: "/userData/tessera.db.pending-restore",
      requiresRestart: true,
    });
  });

  it("rejects an unknown extra key (strict schema)", async () => {
    getBridgeMock.mockReturnValue({ bridgeStageRestore: vi.fn() });
    await expect(
      getHandler("backup:restore")(FAKE_EVENT, {
        backupPath: "/p",
        evil: true,
      }),
    ).rejects.toBeTruthy();
  });
});

describe("backup:configure", () => {
  it("persists the patch and refreshes the scheduler", async () => {
    const result = await getHandler("backup:configure")(FAKE_EVENT, {
      autoBackup: false,
      backupRetentionCount: 5,
    });
    expect(updateConfigMock).toHaveBeenCalledWith({
      autoBackup: false,
      backupRetentionCount: 5,
    });
    expect(refreshBackupSchedulerMock).toHaveBeenCalledTimes(1);
    // Returns a fresh status snapshot.
    expect(result).toMatchObject({
      autoBackup: true,
      schedulerRunning: true,
    });
  });

  it("rejects unknown keys (strict schema) without persisting", async () => {
    await expect(
      getHandler("backup:configure")(FAKE_EVENT, {
        autoBackup: true,
        sneaky: "value",
      }),
    ).rejects.toBeTruthy();
    expect(updateConfigMock).not.toHaveBeenCalled();
  });
});

describe("backup:status", () => {
  it("merges config and scheduler health", async () => {
    const result = await getHandler("backup:status")(FAKE_EVENT);
    expect(result).toEqual({
      autoBackup: true,
      backupDir: "/userData/backups",
      backupIntervalHours: 24,
      backupRetentionCount: 7,
      schedulerRunning: true,
      backupInFlight: false,
      lastBackupAt: 1_700_000_000_000,
      lastBackupError: null,
    });
  });
});

describe("backup:exportBundle / importBundle", () => {
  it("export forwards the config sidecar to the bridge", async () => {
    const bridge = {
      bridgeExportBundle: vi.fn(() => ({
        path: "/out.tessera-backup",
        sizeBytes: 100,
      })),
    };
    getBridgeMock.mockReturnValue(bridge);
    await getHandler("backup:exportBundle")(FAKE_EVENT, {
      outPath: "/out.tessera-backup",
    });
    expect(bridge.bridgeExportBundle).toHaveBeenCalledWith(
      "/out.tessera-backup",
      [
        {
          role: "app-config",
          arcname: "tessera-config.json",
          path: "/userData/config.json",
        },
      ],
    );
  });

  it("import forwards the config restore target to the bridge", async () => {
    const bridge = {
      bridgeImportBundle: vi.fn(() => ({
        stagedDbPath: "/userData/tessera.db.pending-restore",
        restoredSidecars: ["tessera-config.json"],
      })),
    };
    getBridgeMock.mockReturnValue(bridge);
    await getHandler("backup:importBundle")(FAKE_EVENT, {
      bundlePath: "/in.tessera-backup",
    });
    expect(bridge.bridgeImportBundle).toHaveBeenCalledWith(
      "/in.tessera-backup",
      [{ arcname: "tessera-config.json", path: "/userData/config.json" }],
    );
  });

  it("export rejects when the bridge is unavailable", async () => {
    getBridgeMock.mockReturnValue(null);
    await expect(
      getHandler("backup:exportBundle")(FAKE_EVENT, { outPath: "/o" }),
    ).rejects.toThrow(/bridge/i);
  });
});
