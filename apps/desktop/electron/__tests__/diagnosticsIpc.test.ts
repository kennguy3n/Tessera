/**
 * Tests for the `diagnostics:reportCrash` IPC handler.
 *
 * The handler validates an untrusted renderer payload through
 * `RendererCrashReportSchema` and forwards it to
 * `crashReport.recordCrashReport`. We stub `recordCrashReport` and
 * assert:
 *
 *   1. A well-formed report is forwarded verbatim.
 *   2. A grossly malformed payload (non-object) still calls the
 *      recorder (with `null`) so the normalisation layer can default
 *      it — the renderer is mid-crash and must never get a rejection.
 *   3. The handler resolves to `undefined` (write-only surface).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      captured.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      captured.delete(channel);
    },
  },
}));

const recordCrashReport = vi.fn();
vi.mock("../crashReport", () => ({
  recordCrashReport: (...args: unknown[]) => recordCrashReport(...args),
}));

import { registerDiagnosticsHandlers } from "../ipc/diagnostics";

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const listener = captured.get(channel);
  if (!listener) throw new Error(`No handler captured for "${channel}"`);
  return listener({} as unknown, ...args);
}

beforeEach(() => {
  captured.clear();
  recordCrashReport.mockClear();
  registerDiagnosticsHandlers();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("diagnostics:reportCrash IPC handler", () => {
  it("registers the channel", () => {
    expect(captured.has("diagnostics:reportCrash")).toBe(true);
  });

  it("forwards a well-formed report to recordCrashReport", async () => {
    const report = {
      component: "SlideEditor",
      error: "kaboom",
      stack: "Error: kaboom\n  at SlideEditor",
      timestamp: "2026-02-03T04:05:06.000Z",
    };
    const result = await invoke("diagnostics:reportCrash", report);
    expect(result).toBeUndefined();
    expect(recordCrashReport).toHaveBeenCalledTimes(1);
    expect(recordCrashReport).toHaveBeenCalledWith(report);
  });

  it("passes null for a non-object payload so it is defaulted", async () => {
    await invoke("diagnostics:reportCrash", 42);
    expect(recordCrashReport).toHaveBeenCalledWith(null);
  });

  it("accepts a partial report (all fields optional)", async () => {
    await invoke("diagnostics:reportCrash", { component: "HomePage" });
    expect(recordCrashReport).toHaveBeenCalledWith({ component: "HomePage" });
  });
});
