/**
 * Tests for [`stopSidecarsList`] — the pure helper that underpins
 * [`stopAllSidecars`] in `appState.ts`, which `main.ts` calls from
 * its `will-quit` handler.
 *
 * CONTRIBUTING.md flags scheduler-drain and process-shutdown logic
 * as security-sensitive boundaries that require regression tests.
 * The Devin Review pass-4 finding (ANALYSIS_pr-review-job-
 * 08df75766eba4513809fceac8a2cb5e0_0007) called out the absence of
 * a test covering the integration of `stopAllSidecars` in the quit
 * path; this file fills that gap.
 *
 * The function is tested via [`stopSidecarsList`] (the dependency-
 * injected helper) rather than [`stopAllSidecars`] (which reads
 * module-private state) because the production state is set by
 * `initAppState`, which transitively spawns sidecars, allocates a
 * SQLCipher key file, and resolves the native addon — none of
 * which the will-quit invariants depend on. Testing the helper
 * directly is the right abstraction level: a hung sidecar's
 * `stop()` must not block the other sidecars' `stop()` calls, and
 * a throwing sidecar's `stop()` must not bubble an error up to the
 * will-quit handler (where it would block `app.quit()`).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// `appState.ts` imports `app` from "electron" at module load time. The
// vitest test environment can't actually install Electron's native
// binary on CI, and we only need a tiny shape — `getPath`, `getName`,
// `getVersion`, `getLocale` are the surface we use elsewhere. Stub
// them out so loading `../appState` doesn't blow up.
vi.mock("electron", () => ({
  app: {
    getPath: (k: string) => `/tmp/tessera-test-${k}`,
    getName: () => "tessera-test",
    getVersion: () => "0.0.0-test",
    getLocale: () => "en-US",
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

import { stopSidecarsList } from "../appState";

interface FakeSidecar {
  stop(): Promise<void>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stopSidecarsList", () => {
  it("calls stop() on every sidecar in the list", async () => {
    const text = { stop: vi.fn().mockResolvedValue(undefined) };
    const vision = { stop: vi.fn().mockResolvedValue(undefined) };
    const diffusion = { stop: vi.fn().mockResolvedValue(undefined) };

    await stopSidecarsList([
      { label: "text", sidecar: text },
      { label: "vision", sidecar: vision },
      { label: "diffusion", sidecar: diffusion },
    ]);

    expect(text.stop).toHaveBeenCalledTimes(1);
    expect(vision.stop).toHaveBeenCalledTimes(1);
    expect(diffusion.stop).toHaveBeenCalledTimes(1);
  });

  it("skips entries whose sidecar is null", async () => {
    // When the diffusion sidecar was never warmed up (no imagegen
    // model installed yet), `diffusionSidecar` is `null`. Calling
    // `.stop()` on null would be a NullPointerException at the
    // exact moment when we're shutting down the app — the
    // will-quit handler can't recover from a crash there. Filter
    // these out before invoking `.stop()`.
    const text = { stop: vi.fn().mockResolvedValue(undefined) };

    await stopSidecarsList([
      { label: "text", sidecar: text },
      { label: "vision", sidecar: null },
      { label: "diffusion", sidecar: null },
    ]);

    expect(text.stop).toHaveBeenCalledTimes(1);
  });

  it("does not bubble a sidecar's stop() rejection up to the caller", async () => {
    // The will-quit handler in `main.ts` wraps `stopAllSidecars()`
    // in `try/finally` so a stop() error is caught before
    // `app.quit()` runs anyway, but defence-in-depth says the
    // helper itself MUST resolve even if every sidecar rejects.
    // A bubbled rejection from Promise.all would short-circuit
    // sibling tasks and leave them un-awaited.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const text = {
      stop: vi
        .fn()
        .mockRejectedValue(new Error("text sidecar SIGTERM ignored")),
    };
    const vision = {
      stop: vi.fn().mockRejectedValue(new Error("vision sidecar hung")),
    };
    const diffusion = {
      stop: vi.fn().mockResolvedValue(undefined),
    };

    // Must resolve, not reject.
    await expect(
      stopSidecarsList([
        { label: "text", sidecar: text },
        { label: "vision", sidecar: vision },
        { label: "diffusion", sidecar: diffusion },
      ]),
    ).resolves.toBeUndefined();

    // Every sidecar's stop() MUST have been called — a sibling's
    // rejection cannot short-circuit the rest.
    expect(text.stop).toHaveBeenCalledTimes(1);
    expect(vision.stop).toHaveBeenCalledTimes(1);
    expect(diffusion.stop).toHaveBeenCalledTimes(1);

    // Each rejection should have produced a labelled log line so
    // post-mortem audits can distinguish text/vision/diffusion
    // shutdown failures. The exact format isn't load-bearing, but
    // the label and the underlying error message must appear.
    const calls = errSpy.mock.calls.map((c) =>
      c.map((v) => String(v)).join(" "),
    );
    expect(
      calls.some((c) => c.includes("text") && c.includes("SIGTERM ignored")),
    ).toBe(true);
    expect(calls.some((c) => c.includes("vision") && c.includes("hung"))).toBe(
      true,
    );
  });

  it("does not allow one slow sidecar to delay the others' stop() calls", async () => {
    // We can't time-skip with fake timers here because stop()
    // returns a real Promise rather than scheduling a tick. The
    // proxy we use is that all three stop() functions must be
    // CALLED before any of them resolves. If `stopSidecarsList`
    // were accidentally rewritten as a sequential `for...of`
    // (instead of Promise.all), the vision and diffusion calls
    // would only happen after the text sidecar resolved — and
    // we'd block on the hung one indefinitely.
    let resolveText!: () => void;
    const textPending = new Promise<void>((r) => {
      resolveText = r;
    });
    const text: FakeSidecar = {
      stop: vi.fn().mockReturnValue(textPending),
    };
    const vision: FakeSidecar = {
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const diffusion: FakeSidecar = {
      stop: vi.fn().mockResolvedValue(undefined),
    };

    const done = stopSidecarsList([
      { label: "text", sidecar: text },
      { label: "vision", sidecar: vision },
      { label: "diffusion", sidecar: diffusion },
    ]);

    // Yield the microtask queue once so all three stops fire.
    await Promise.resolve();
    await Promise.resolve();

    expect(text.stop).toHaveBeenCalledTimes(1);
    expect(vision.stop).toHaveBeenCalledTimes(1);
    expect(diffusion.stop).toHaveBeenCalledTimes(1);

    // `done` is still pending until we resolve the slow stop()
    // call — which is exactly what we want (the `will-quit`
    // handler is awaiting this promise).
    resolveText();
    await expect(done).resolves.toBeUndefined();
  });

  it("returns immediately when the list is empty (e.g. tests / no sidecars init'd)", async () => {
    await expect(stopSidecarsList([])).resolves.toBeUndefined();
  });
});
