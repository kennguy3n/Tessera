/**
 * LW-9 (minimize-to-tray): the `closeToTray` preference round-trips
 * through the real `settings:get` / `settings:update` IPC handlers and
 * persists to `config.json`.
 *
 * The window `close` handler in `main.ts` re-reads `loadConfig()
 * .closeToTray` on every close (so toggling the setting takes effect
 * without a relaunch), so the contract that matters is: a
 * `settings:update({ closeToTray })` must be durably persisted and
 * visible both to a follow-up `settings:get` AND to a direct
 * `loadConfig()` read. These tests exercise that through the real
 * handlers (no shortcuts into `config.ts`), mirroring
 * `appLockSettingsCoupling.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

const hoisted = vi.hoisted(() => ({
  userData: { value: "" },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => hoisted.userData.value) },
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: vi.fn(),
}));

// No native addon in the vitest runtime; `getBridge() === null` makes
// the best-effort audit helpers in `settings.ts` short-circuit cleanly.
vi.mock("../appState", () => ({
  getBridge: () => null,
  isBridgeAvailable: () => false,
}));

import {
  loadConfig,
  _clearConfigCacheForTests,
} from "../config";
import { registerSettingsHandlers } from "../ipc/settings";
import { defaultRateLimiter } from "../ipc/rateLimiter";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-close-to-tray-"));
  hoisted.userData.value = tmpDir;
  handleMock.mockClear();
  removeHandlerMock.mockClear();
  _clearConfigCacheForTests();
  defaultRateLimiter.reset();
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("settings closeToTray round-trip (LW-9)", () => {
  it("settings:get reports the default (false) on a fresh install", async () => {
    registerSettingsHandlers();
    const get = getHandler("settings:get");
    const settings = (await get({})) as { closeToTray: boolean };
    expect(settings.closeToTray).toBe(false);
  });

  it("settings:update persists closeToTray and returns it; get + loadConfig agree", async () => {
    registerSettingsHandlers();
    const update = getHandler("settings:update");
    const get = getHandler("settings:get");

    const updated = (await update({}, { closeToTray: true })) as {
      closeToTray: boolean;
    };
    // The handler echoes the persisted value…
    expect(updated.closeToTray).toBe(true);
    // …a follow-up read sees it…
    const afterGet = (await get({})) as { closeToTray: boolean };
    expect(afterGet.closeToTray).toBe(true);
    // …and it is durable on disk (the window `close` handler reads it
    // fresh via `loadConfig()` on every close).
    expect(loadConfig().closeToTray).toBe(true);
  });

  it("toggling closeToTray back to false persists the opt-out", async () => {
    registerSettingsHandlers();
    const update = getHandler("settings:update");

    await update({}, { closeToTray: true });
    expect(loadConfig().closeToTray).toBe(true);

    const reverted = (await update({}, { closeToTray: false })) as {
      closeToTray: boolean;
    };
    expect(reverted.closeToTray).toBe(false);
    expect(loadConfig().closeToTray).toBe(false);
  });

  it("an update that omits closeToTray leaves the persisted value untouched", async () => {
    registerSettingsHandlers();
    const update = getHandler("settings:update");

    await update({}, { closeToTray: true });
    expect(loadConfig().closeToTray).toBe(true);

    // A typical Settings save of an unrelated field must not clobber it.
    await update({}, { theme: "dark" });
    expect(loadConfig().closeToTray).toBe(true);
  });
});
