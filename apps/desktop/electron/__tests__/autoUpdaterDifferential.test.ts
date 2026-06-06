/**
 * Verifies the auto-updater opts into blockmap-based *differential*
 * (delta) downloads.
 *
 * electron-updater performs a delta download — fetching only the
 * changed blocks of a new release via its `.blockmap` — when
 * `disableDifferentialDownload` is false. The canonical updater
 * configuration (`configureUpdater`, exercised here via
 * `_configureUpdaterForTests`) must set that flag explicitly so a
 * future refactor can't silently regress to full-artifact downloads.
 *
 * We test the config function directly rather than driving
 * `getUpdater()`: the real `electron-updater` is CommonJS + packaged-
 * only and isn't mockable through `require()` in this runtime, so a
 * `getUpdater()`-based test would only ever hit the catch path.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn().mockReturnValue("/tmp"),
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
}));

vi.mock("../config", () => ({
  loadConfig: () => ({ autoUpdate: false, enforceUpdateSignature: true }),
  updateConfig: () => {},
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../telemetrySink", () => ({
  recordCounter: () => {},
}));

import { _configureUpdaterForTests } from "../autoUpdater";

interface FakeUpdater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
  logger: unknown;
  on(event: string, cb: (...args: unknown[]) => void): void;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
}

function makeFakeUpdater(): FakeUpdater {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    // Start at the *unsafe* value so the test fails if production
    // code never touches it.
    disableDifferentialDownload: true,
    logger: null,
    on: () => {},
    checkForUpdates: async () => undefined,
    quitAndInstall: () => {},
  };
}

describe("autoUpdater differential (delta) download", () => {
  it("enables blockmap delta downloads via disableDifferentialDownload = false", () => {
    const updater = makeFakeUpdater();
    _configureUpdaterForTests(updater);
    expect(updater.disableDifferentialDownload).toBe(false);
  });

  it("applies the rest of the canonical updater config", () => {
    const updater = makeFakeUpdater();
    _configureUpdaterForTests(updater);
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.logger).not.toBeNull();
  });
});
