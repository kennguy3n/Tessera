/**
 * Regression tests for the auto-updater IPC surface.
 *
 * Focus: validator parity with the rest of the IPC layer.
 *
 * `updates:setAutoUpdateEnabled` used to coerce its argument with
 * `Boolean(enabled)`, which silently accepted any type the renderer
 * sent (strings, numbers, objects). Every other IPC handler in this
 * codebase runs its inputs through the `assert*` helpers in
 * `ipc/validate.ts`, and the auto-updater handler now matches that
 * pattern.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist the test doubles so the `vi.mock()` factories below (which
// vitest hoists to the very top of the file) can close over them.
const mocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  return {
    handlers,
    ipcMain: {
      handle(
        name: string,
        fn: (event: unknown, ...args: unknown[]) => unknown,
      ): void {
        handlers.set(name, fn);
      },
      removeHandler(name: string): void {
        handlers.delete(name);
      },
    },
    storedAutoUpdate: { value: false },
  };
});

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = mocks.handlers.get(name);
  if (!fn) throw new Error(`No handler registered for ${name}`);
  return fn({}, ...args);
}

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue("/tmp"),
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: mocks.ipcMain,
}));

vi.mock("../config", () => ({
  loadConfig: () => ({ autoUpdate: mocks.storedAutoUpdate.value }),
  updateConfig: (patch: { autoUpdate?: boolean }) => {
    if (patch.autoUpdate !== undefined) {
      mocks.storedAutoUpdate.value = patch.autoUpdate;
    }
  },
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { registerAutoUpdaterIpc, _resetForTests } from "../autoUpdater";

describe("registerAutoUpdaterIpc — updates:setAutoUpdateEnabled validation", () => {
  beforeEach(() => {
    _resetForTests();
    mocks.storedAutoUpdate.value = false;
    mocks.handlers.clear();
    registerAutoUpdaterIpc();
  });

  it("accepts a true boolean and persists it", async () => {
    const result = await invoke("updates:setAutoUpdateEnabled", true);
    expect(result).toBe(true);
    expect(mocks.storedAutoUpdate.value).toBe(true);
  });

  it("accepts a false boolean and persists it", async () => {
    mocks.storedAutoUpdate.value = true;
    const result = await invoke("updates:setAutoUpdateEnabled", false);
    expect(result).toBe(false);
    expect(mocks.storedAutoUpdate.value).toBe(false);
  });

  it.each([
    ["string", "true"],
    ["number 1", 1],
    ["number 0", 0],
    ["object", { yes: true }],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s and leaves config unchanged", async (_label, value) => {
    mocks.storedAutoUpdate.value = false;
    await expect(
      invoke("updates:setAutoUpdateEnabled", value),
    ).rejects.toThrow(/must be a boolean/);
    // Config remains untouched on rejection — `assertBoolean` throws
    // before `updateConfig` is reached.
    expect(mocks.storedAutoUpdate.value).toBe(false);
  });

  it("does not let a string 'false' silently disable the toggle", async () => {
    mocks.storedAutoUpdate.value = true;
    await expect(
      invoke("updates:setAutoUpdateEnabled", "false"),
    ).rejects.toThrow(/must be a boolean/);
    expect(mocks.storedAutoUpdate.value).toBe(true);
  });
});
