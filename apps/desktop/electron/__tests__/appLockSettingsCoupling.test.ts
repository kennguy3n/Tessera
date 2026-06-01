/**
 * lifecycle coupling between `appLockMode`
 * (persisted config) and PIN material (in the encrypted vault).
 *
 * Three contracts under test:
 *
 *   1. `settings:update({ appLockMode: "pin" | "biometric" })` MUST
 *      reject when no PIN is stored — otherwise the next launch
 *      would see `appLockMode === "pin"` with no PIN, forcing the
 *      user through a surprise setup flow.
 *   2. `settings:update({ appLockMode: "off" })` MUST clear the
 *      stored PIN — otherwise dead credentials linger on disk
 *      after the user explicitly opted OUT of app lock.
 *   3. `appLock:removePin` MUST reset `appLockMode` to `"off"` —
 *      otherwise the same `no_pin_set` race appears on the next
 *      launch (mode is "pin" but no PIN exists).
 *
 * These three contracts are bidirectional: any code path that
 * changes one side without the other can desync the user's
 * lock-state, so the tests exercise both directions through their
 * real IPC handlers (no shortcuts into `appLock.ts`'s internals).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

// Hoisted shared user-data dir so the `electron.app` mock and the
// `_setAppLockPathForTests` override resolve to the same tmpdir per
// test.
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
  systemPreferences: {
    canPromptTouchID: vi.fn(() => false),
    promptTouchID: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) =>
      Buffer.concat([Buffer.from("v10\x00"), Buffer.from(s, "utf-8")]),
    ),
    decryptString: vi.fn((b: Buffer) => {
      if (b.subarray(0, 4).equals(Buffer.from("v10\x00"))) {
        return b.subarray(4).toString("utf-8");
      }
      throw new Error("decryptString: not a v10 blob");
    }),
  },
}));

// Stub the bridge so audit calls succeed without a real native
// addon. The audit helpers in `settings.ts` are best-effort and
// swallow throws, but stubbing `getBridge() === null` lets the
// audit code short-circuit cleanly.
vi.mock("../appState", () => ({
  getBridge: () => null,
  isBridgeAvailable: () => false,
}));

import {
  loadConfig,
  updateConfig,
  _clearConfigCacheForTests,
} from "../config";
import { registerSettingsHandlers } from "../ipc/settings";
import { registerAppLockHandlers } from "../ipc/appLock";
import {
  hasPinSet,
  setPin,
  clearPin,
  _setAppLockPathForTests,
  _resetAttemptCounterForTests,
} from "../appLock";
import { defaultRateLimiter } from "../ipc/rateLimiter";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-lock-couple-"));
  hoisted.userData.value = tmpDir;
  _setAppLockPathForTests(() => path.join(tmpDir, "app-lock.bin"));
  handleMock.mockClear();
  removeHandlerMock.mockClear();
  _clearConfigCacheForTests();
  defaultRateLimiter.reset();
});

afterEach(() => {
  _setAppLockPathForTests(null);
  try {
    if (hasPinSet()) clearPin();
  } catch {
    /* best-effort */
  }
  try {
    _resetAttemptCounterForTests();
  } catch {
    /* best-effort — file may not exist yet */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
  vi.restoreAllMocks();
});

describe("settings:update — appLockMode requires PIN", () => {
  it("rejects appLockMode='pin' when no PIN is set", async () => {
    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("settings:update");
    await expect(handler({}, { appLockMode: "pin" })).rejects.toThrow(
      /Cannot set appLockMode to "pin" without a PIN/,
    );
    // Persisted config must be unchanged.
    expect(loadConfig().appLockMode).toBe("off");
  });

  it("rejects appLockMode='biometric' when no PIN is set", async () => {
    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("settings:update");
    await expect(handler({}, { appLockMode: "biometric" })).rejects.toThrow(
      /Cannot set appLockMode to "biometric" without a PIN/,
    );
    expect(loadConfig().appLockMode).toBe("off");
  });

  it("accepts appLockMode='pin' once a PIN is set", async () => {
    await setPin("abc123");
    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("settings:update");
    const result = (await handler({}, { appLockMode: "pin" })) as {
      appLockMode: string;
    };
    expect(result.appLockMode).toBe("pin");
    expect(loadConfig().appLockMode).toBe("pin");
    // PIN MUST still be in place after the mode change.
    expect(hasPinSet()).toBe(true);
  });

  it("accepts appLockMode='off' unconditionally (no PIN required)", async () => {
    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("settings:update");
    const result = (await handler({}, { appLockMode: "off" })) as {
      appLockMode: string;
    };
    expect(result.appLockMode).toBe("off");
  });
});

describe("settings:update — appLockMode='off' clears stored PIN", () => {
  it("removes the on-disk PIN when mode is set to 'off' from 'pin'", async () => {
    // Set up: PIN exists, mode='pin'.
    await setPin("hunter2pw");
    updateConfig({ appLockMode: "pin" });
    expect(hasPinSet()).toBe(true);
    expect(loadConfig().appLockMode).toBe("pin");

    // Act: flip mode to "off" via the IPC handler.
    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("settings:update");
    const result = (await handler({}, { appLockMode: "off" })) as {
      appLockMode: string;
    };

    // Assert: mode flipped AND the stored PIN was wiped.
    expect(result.appLockMode).toBe("off");
    expect(loadConfig().appLockMode).toBe("off");
    expect(hasPinSet()).toBe(false);
  });

  it("does not error when 'off' is set with no PIN present (idempotent)", async () => {
    expect(hasPinSet()).toBe(false);
    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("settings:update");
    await expect(handler({}, { appLockMode: "off" })).resolves.toMatchObject({
      appLockMode: "off",
    });
  });
});

describe("appLock:removePin resets appLockMode to 'off'", () => {
  it("flips mode to 'off' after a successful removePin", async () => {
    // Set up: PIN + mode='pin' both in place.
    await setPin("alpha123");
    updateConfig({ appLockMode: "pin" });
    expect(hasPinSet()).toBe(true);
    expect(loadConfig().appLockMode).toBe("pin");

    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("appLock:removePin");
    await handler({}, "alpha123");

    expect(hasPinSet()).toBe(false);
    // The whole point of the coupling — mode falls back to "off"
    // so the next launch doesn't trip `no_pin_set` on a stale
    // mode='pin' value.
    expect(loadConfig().appLockMode).toBe("off");
  });

  it("does not flip mode when removePin fails verification", async () => {
    await setPin("alpha123");
    updateConfig({ appLockMode: "pin" });

    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("appLock:removePin");
    await expect(handler({}, "wrong-pin999")).rejects.toThrow(
      /PIN verification failed/,
    );

    // PIN still present, mode unchanged.
    expect(hasPinSet()).toBe(true);
    expect(loadConfig().appLockMode).toBe("pin");
  });

  it("leaves mode='off' as-is when removePin is called from 'off' (edge case)", async () => {
    // Pathological: user has a stale PIN but no mode. The mode
    // should remain "off" after the removal (we don't re-trigger
    // a config write because there's nothing to change).
    await setPin("orphan111");
    expect(loadConfig().appLockMode).toBe("off");

    registerSettingsHandlers();
    registerAppLockHandlers();
    const handler = getHandler("appLock:removePin");
    await handler({}, "orphan111");

    expect(hasPinSet()).toBe(false);
    expect(loadConfig().appLockMode).toBe("off");
  });
});
