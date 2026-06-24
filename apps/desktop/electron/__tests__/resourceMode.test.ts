import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// `appState.ts` imports `app` from "electron" at module load time, and
// `config.ts` reads `app.getPath('userData')` to locate config.json.
// Point both at a per-test tempdir so the resource-mode persistence
// round-trip touches an isolated file and `../appState` loads cleanly.
let userDataDir: string;
vi.mock("electron", () => ({
  app: {
    getPath: (_k: string) => userDataDir,
    getName: () => "tessera-test",
    getVersion: () => "0.0.0-test",
    getLocale: () => "en-US",
    getAppPath: () => "/tmp/tessera-test-app",
    isPackaged: false,
  },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
    on: () => undefined,
    removeListener: () => undefined,
  },
  BrowserWindow: class {},
  shell: { openExternal: async () => undefined },
}));

import { _clearConfigCacheForTests, loadConfig, updateConfig } from "../config";
import { stopOtherSidecarsForExclusivity, type SidecarKind } from "../appState";

/** Minimal sidecar stub honouring the slot shape the helper reads. */
function fakeSidecar(isRunning: boolean): {
  isRunning: boolean;
  stop: ReturnType<typeof vi.fn>;
} {
  return { isRunning, stop: vi.fn().mockResolvedValue(undefined) };
}

describe("resourceMode config (LW-2)", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-resmode-"));
    _clearConfigCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    _clearConfigCacheForTests();
  });

  it("defaults a fresh install to lightweight", () => {
    expect(loadConfig().resourceMode).toBe("lightweight");
  });

  it("persists an explicit performance choice", () => {
    updateConfig({ resourceMode: "performance" });
    expect(loadConfig().resourceMode).toBe("performance");
  });

  it("heals a corrupted on-disk value back to lightweight", () => {
    // Must match getConfigPath() in config.ts, which resolves to
    // "tessera-config.json" under userData — writing "config.json"
    // would land at a path loadConfig() never reads, so the test would
    // pass on the fresh-install default instead of exercising the
    // zod .catch("lightweight") healing path it documents.
    const cfgPath = path.join(userDataDir, "tessera-config.json");
    // Pair the corrupt resourceMode with a VALID non-default sibling
    // (theme defaults to "light"). Asserting theme === "dark" round-trips
    // proves loadConfig() actually read THIS file and healed only the
    // bad field — rather than silently falling back to the all-defaults
    // config because the file was written to a path it never reads.
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({ resourceMode: "turbo", theme: "dark" }),
    );
    _clearConfigCacheForTests();
    const healed = loadConfig();
    expect(healed.resourceMode).toBe("lightweight");
    expect(healed.theme).toBe("dark");
  });
});

describe("stopOtherSidecarsForExclusivity (LW-2 single-sidecar)", () => {
  it("is a no-op in performance mode (concurrent sidecars allowed)", async () => {
    const text = fakeSidecar(true);
    const vision = fakeSidecar(true);
    const diffusion = fakeSidecar(true);
    await stopOtherSidecarsForExclusivity("vision", "performance", [
      { kind: "text", sidecar: text },
      { kind: "vision", sidecar: vision },
      { kind: "diffusion", sidecar: diffusion },
    ]);
    expect(text.stop).not.toHaveBeenCalled();
    expect(vision.stop).not.toHaveBeenCalled();
    expect(diffusion.stop).not.toHaveBeenCalled();
  });

  it("stops every other running sidecar in lightweight mode", async () => {
    const text = fakeSidecar(true);
    const vision = fakeSidecar(true);
    const diffusion = fakeSidecar(true);
    await stopOtherSidecarsForExclusivity("vision", "lightweight", [
      { kind: "text", sidecar: text },
      { kind: "vision", sidecar: vision },
      { kind: "diffusion", sidecar: diffusion },
    ]);
    // Starting vision stops text + diffusion, but never itself.
    expect(text.stop).toHaveBeenCalledTimes(1);
    expect(diffusion.stop).toHaveBeenCalledTimes(1);
    expect(vision.stop).not.toHaveBeenCalled();
  });

  it("never stops the sidecar being started even if it is running", async () => {
    const text = fakeSidecar(true);
    await stopOtherSidecarsForExclusivity("text", "lightweight", [
      { kind: "text", sidecar: text },
    ]);
    expect(text.stop).not.toHaveBeenCalled();
  });

  it("skips slots that are null or not running", async () => {
    const text = fakeSidecar(false); // constructed but idle
    const diffusion = fakeSidecar(true);
    await stopOtherSidecarsForExclusivity("vision", "lightweight", [
      { kind: "text", sidecar: text },
      { kind: "vision", sidecar: null },
      { kind: "diffusion", sidecar: diffusion },
    ]);
    expect(text.stop).not.toHaveBeenCalled();
    expect(diffusion.stop).toHaveBeenCalledTimes(1);
  });

  it("does not let one sidecar's stop() failure block the others", async () => {
    const text = fakeSidecar(true);
    text.stop.mockRejectedValueOnce(new Error("SIGTERM failed"));
    const diffusion = fakeSidecar(true);
    await expect(
      stopOtherSidecarsForExclusivity("vision", "lightweight", [
        { kind: "text", sidecar: text },
        { kind: "diffusion", sidecar: diffusion },
      ]),
    ).resolves.toBeUndefined();
    expect(text.stop).toHaveBeenCalledTimes(1);
    expect(diffusion.stop).toHaveBeenCalledTimes(1);
  });

  it("matches the SidecarKind union the production wrapper passes", () => {
    const kinds: SidecarKind[] = ["text", "vision", "diffusion"];
    expect(kinds).toHaveLength(3);
  });
});
