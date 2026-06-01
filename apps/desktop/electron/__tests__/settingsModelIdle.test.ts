/**
 * Phase 19 Task 5: end-to-end integration test for the model
 * idle-unload IPC wiring.
 *
 * Surface under test:
 *
 *   1. `settings:get`     returns the persisted `modelIdleUnloadSecs`
 *      so the renderer's `useSettings` hook sees the user's stored
 *      preference on boot.
 *   2. `settings:update`  validates the new value against the IPC
 *      schema bounds (5 .. 86_400 seconds), persists it via
 *      `updateConfig`, pushes the milliseconds-converted value to
 *      every live ModelSidecar through
 *      `applyModelIdleUnloadSecsToSidecars`, AND emits an audit row.
 *   3. Out-of-range / wrong-type values rejected at the schema
 *      boundary before any side effect runs (no persistence, no
 *      sidecar push, no audit emission).
 *
 * The intent of this suite is to pin the cross-layer contract that
 * earlier rounds got wrong (renderer sent seconds, sidecar took
 * milliseconds, electron persisted the wrong unit) so the unit
 * boundary is enforced once at the IPC handler and never again
 * downstream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

let userDataDir = "";

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  app: {
    getPath: (which: string) => {
      if (which === "userData") return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

// Mock the appState module so the handler's late-resolved
// `applyModelIdleUnloadSecsToSidecars` import lands on a controllable
// stub. This is the surface the handler uses to fan a new value
// out to the live text+vision sidecars without forcing this test
// to spin up real child processes.
const applyModelIdleUnloadSecsToSidecarsMock = vi.fn();
vi.mock("../appState", () => ({
  getBridge: () => null,
  isBridgeAvailable: () => false,
  applyModelIdleUnloadSecsToSidecars: (idleUnloadSecs: number) =>
    applyModelIdleUnloadSecsToSidecarsMock(idleUnloadSecs),
}));

// `auditSettingsField` in settings.ts routes through
// `getBridge()?.bridgeLogSettingsChanged(...)`. Because the
// `appState` mock above returns `null` for `getBridge()`, audit
// emission short-circuits to a silent no-op — no extra mock
// needed. The audit *contract* (one row per changed field) is
// covered by `auditPassThroughs.test.ts`; this suite focuses on
// the persistence + sidecar fan-out side effects.

import {
  loadConfig,
  updateConfig,
  _clearConfigCacheForTests,
} from "../config";
import { registerSettingsHandlers } from "../ipc/settings";
import { defaultRateLimiter } from "../ipc/rateLimiter";
import type { SettingsData } from "../../shared/types";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

describe("settings model idle-unload IPC", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tessera-idle-test-"),
    );
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    applyModelIdleUnloadSecsToSidecarsMock.mockClear();
    _clearConfigCacheForTests();
    defaultRateLimiter.reset();
  });

  afterEach(() => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    vi.restoreAllMocks();
  });

  it("settings:get surfaces the persisted modelIdleUnloadSecs on cold read", async () => {
    // Pre-seed the on-disk config with a user-picked value
    // (5 minutes) so the renderer-facing handler has something
    // non-default to return.
    updateConfig({ modelIdleUnloadSecs: 300 });
    registerSettingsHandlers();
    const handler = getHandler("settings:get");
    const result = (await handler({})) as SettingsData;
    expect(result.modelIdleUnloadSecs).toBe(300);
  });

  it("settings:get returns the documented default (60 s) for a fresh install", async () => {
    registerSettingsHandlers();
    const handler = getHandler("settings:get");
    const result = (await handler({})) as SettingsData;
    expect(result.modelIdleUnloadSecs).toBe(60);
  });

  it("settings:update persists modelIdleUnloadSecs AND pushes it to live sidecars", async () => {
    registerSettingsHandlers();
    const handler = getHandler("settings:update");

    // 5 min → seconds value the renderer would send.
    const result = (await handler(
      {},
      { modelIdleUnloadSecs: 300 },
    )) as SettingsData;

    // Returned value reflects what's on disk after the write,
    // not the inbound patch.
    expect(result.modelIdleUnloadSecs).toBe(300);

    // Persistence side effect — disk holds the new value so the
    // next boot's `initAppState` reads it via `loadConfig()`.
    expect(loadConfig().modelIdleUnloadSecs).toBe(300);

    // Live propagation side effect — the sidecar fan-out is called
    // exactly once, with seconds (not milliseconds); the conversion
    // to ms happens inside `applyModelIdleUnloadSecsToSidecars`
    // itself so that callers don't have to remember the unit.
    expect(applyModelIdleUnloadSecsToSidecarsMock).toHaveBeenCalledTimes(1);
    expect(applyModelIdleUnloadSecsToSidecarsMock).toHaveBeenCalledWith(300);
  });

  it("settings:update does NOT call the sidecar fan-out when the field is omitted", async () => {
    registerSettingsHandlers();
    const handler = getHandler("settings:update");
    // Submit a `theme` change but leave `modelIdleUnloadSecs`
    // untouched.
    await handler({}, { theme: "dark" });
    expect(applyModelIdleUnloadSecsToSidecarsMock).not.toHaveBeenCalled();
    // The persisted value remains the default.
    expect(loadConfig().modelIdleUnloadSecs).toBe(60);
  });

  it("settings:update rejects values below MIN_MODEL_IDLE_UNLOAD_SECS (5)", async () => {
    registerSettingsHandlers();
    const handler = getHandler("settings:update");
    // 1 s is below the 5-s schema floor.
    await expect(
      handler({}, { modelIdleUnloadSecs: 1 }),
    ).rejects.toThrow();
    // No side effects landed.
    expect(applyModelIdleUnloadSecsToSidecarsMock).not.toHaveBeenCalled();
    expect(loadConfig().modelIdleUnloadSecs).toBe(60);
  });

  it("settings:update rejects values above MAX_MODEL_IDLE_UNLOAD_SECS (86_400)", async () => {
    registerSettingsHandlers();
    const handler = getHandler("settings:update");
    // 86_401 s is one second above the 24-h ceiling.
    await expect(
      handler({}, { modelIdleUnloadSecs: 86_401 }),
    ).rejects.toThrow();
    expect(applyModelIdleUnloadSecsToSidecarsMock).not.toHaveBeenCalled();
    expect(loadConfig().modelIdleUnloadSecs).toBe(60);
  });

  it("settings:update rejects non-integer / non-finite values", async () => {
    registerSettingsHandlers();
    const handler = getHandler("settings:update");
    await expect(
      handler({}, { modelIdleUnloadSecs: 60.5 }),
    ).rejects.toThrow();
    await expect(
      handler({}, { modelIdleUnloadSecs: Number.NaN }),
    ).rejects.toThrow();
    await expect(
      handler({}, { modelIdleUnloadSecs: "60" as unknown as number }),
    ).rejects.toThrow();
    expect(applyModelIdleUnloadSecsToSidecarsMock).not.toHaveBeenCalled();
  });

  it("settings:update accepts boundary values (5 and 86_400)", async () => {
    registerSettingsHandlers();
    const handler = getHandler("settings:update");

    let result = (await handler(
      {},
      { modelIdleUnloadSecs: 5 },
    )) as SettingsData;
    expect(result.modelIdleUnloadSecs).toBe(5);
    expect(applyModelIdleUnloadSecsToSidecarsMock).toHaveBeenLastCalledWith(5);

    result = (await handler(
      {},
      { modelIdleUnloadSecs: 86_400 },
    )) as SettingsData;
    expect(result.modelIdleUnloadSecs).toBe(86_400);
    expect(applyModelIdleUnloadSecsToSidecarsMock).toHaveBeenLastCalledWith(
      86_400,
    );

    expect(applyModelIdleUnloadSecsToSidecarsMock).toHaveBeenCalledTimes(2);
  });
});
