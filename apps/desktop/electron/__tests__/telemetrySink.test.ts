/**
 * Phase 19 PR 10 Task 9 — local-only telemetry sink unit tests.
 *
 * Covers enable/disable transitions, key whitelisting, value
 * clamping/validation, persistence (`flushAsync` /
 * `readPersistedEvents`), and the disable-erases-disk contract.
 * Every test exercises the real `telemetrySink.ts` code path; the
 * only mock is the `electron.app.getPath` lookup that returns a
 * per-test tempdir.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const hoisted = vi.hoisted(() => ({
  userData: { value: "" },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => hoisted.userData.value) },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
}));

import {
  disableTelemetry,
  enableTelemetry,
  flushAsync,
  flushSync,
  getEventsSnapshot,
  initTelemetrySink,
  readPersistedEvents,
  recordCounter,
  recordTiming,
  _isEnabledForTests,
  _resetTelemetryForTests,
} from "../telemetrySink";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-telemetry-test-"));
  hoisted.userData.value = tmpDir;
  _resetTelemetryForTests();
});

afterEach(() => {
  _resetTelemetryForTests();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function sinkFile(): string {
  return path.join(tmpDir, "telemetry.jsonl");
}

describe("enable / disable lifecycle", () => {
  it("starts disabled by default", () => {
    expect(_isEnabledForTests()).toBe(false);
  });

  it("enableTelemetry is idempotent", () => {
    enableTelemetry();
    expect(_isEnabledForTests()).toBe(true);
    enableTelemetry();
    expect(_isEnabledForTests()).toBe(true);
  });

  it("disableTelemetry returns sink to disabled", () => {
    enableTelemetry();
    disableTelemetry();
    expect(_isEnabledForTests()).toBe(false);
  });

  it("initTelemetrySink(true) enables sink", () => {
    initTelemetrySink(true);
    expect(_isEnabledForTests()).toBe(true);
  });

  it("initTelemetrySink(false) leaves sink disabled", () => {
    initTelemetrySink(false);
    expect(_isEnabledForTests()).toBe(false);
  });
});

describe("recordCounter — whitelist + validation", () => {
  beforeEach(() => {
    enableTelemetry();
  });

  it("records a whitelisted key", async () => {
    recordCounter("artifact.save");
    await flushAsync();
    const events = readPersistedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("counter");
    expect(events[0].key).toBe("artifact.save");
    expect(events[0].value).toBe(1);
  });

  it("drops a non-whitelisted key (privacy boundary)", async () => {
    recordCounter("connector.user_email_hash"); // not in TELEMETRY_KEYS
    await flushAsync();
    expect(readPersistedEvents()).toHaveLength(0);
  });

  it("drops record when disabled", async () => {
    disableTelemetry();
    recordCounter("artifact.save");
    expect(getEventsSnapshot()).toEqual([]);
  });

  it("accepts an explicit increment", async () => {
    recordCounter("artifact.save", 5);
    await flushAsync();
    const events = readPersistedEvents();
    expect(events[0].value).toBe(5);
  });

  it("drops negative increments", async () => {
    recordCounter("artifact.save", -1);
    await flushAsync();
    expect(readPersistedEvents()).toHaveLength(0);
  });

  it("drops NaN / Infinity increments", async () => {
    recordCounter("artifact.save", Number.NaN);
    recordCounter("artifact.save", Number.POSITIVE_INFINITY);
    await flushAsync();
    expect(readPersistedEvents()).toHaveLength(0);
  });

  it("floors fractional increments to an integer", async () => {
    recordCounter("artifact.save", 3.7);
    await flushAsync();
    expect(readPersistedEvents()[0].value).toBe(3);
  });
});

describe("recordTiming — whitelist + clamping", () => {
  beforeEach(() => {
    enableTelemetry();
  });

  it("records a normal timing event", async () => {
    recordTiming("search.hybrid", 42);
    await flushAsync();
    const events = readPersistedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("timing");
    expect(events[0].value).toBe(42);
  });

  it("clamps timing > 1 hour to the hard cap", async () => {
    recordTiming("search.hybrid", 10 * 60 * 60 * 1000);
    await flushAsync();
    expect(readPersistedEvents()[0].value).toBe(60 * 60 * 1000);
  });

  it("drops negative timings", async () => {
    recordTiming("search.hybrid", -1);
    await flushAsync();
    expect(readPersistedEvents()).toHaveLength(0);
  });

  it("drops non-whitelisted timing key", async () => {
    recordTiming("private.foo", 5);
    await flushAsync();
    expect(readPersistedEvents()).toHaveLength(0);
  });
});

describe("flushAsync / flushSync persistence", () => {
  it("flushAsync writes JSONL to the sink file", async () => {
    enableTelemetry();
    recordCounter("artifact.save");
    recordTiming("search.hybrid", 100);
    await flushAsync();
    const raw = fs.readFileSync(sinkFile(), "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.k).toBe("counter");
    expect(b.k).toBe("timing");
  });

  it("flushSync writes JSONL synchronously", () => {
    enableTelemetry();
    recordCounter("artifact.save");
    flushSync();
    const raw = fs.readFileSync(sinkFile(), "utf-8");
    expect(raw.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  it("flushAsync clears the in-memory buffer after writing", async () => {
    enableTelemetry();
    recordCounter("artifact.save");
    expect(getEventsSnapshot()).toHaveLength(1);
    await flushAsync();
    // After flush the in-memory snapshot is empty (the only events
    // visible should now come from disk).
    const snapshot = getEventsSnapshot();
    expect(snapshot).toHaveLength(1); // 1 from disk + 0 in memory
  });

  it("readPersistedEvents skips malformed lines", () => {
    enableTelemetry();
    fs.writeFileSync(
      sinkFile(),
      [
        '{"t":1,"k":"counter","key":"artifact.save","value":1}',
        "<-- not json -->",
        '{"t":2,"k":"counter","key":"artifact.save","value":2}',
      ].join("\n") + "\n",
    );
    const events = readPersistedEvents();
    expect(events).toHaveLength(2);
    expect(events[0].value).toBe(1);
    expect(events[1].value).toBe(2);
  });

  it("readPersistedEvents drops events with non-whitelisted keys", () => {
    enableTelemetry();
    fs.writeFileSync(
      sinkFile(),
      [
        '{"t":1,"k":"counter","key":"artifact.save","value":1}',
        '{"t":2,"k":"counter","key":"unknown.key","value":1}',
      ].join("\n") + "\n",
    );
    const events = readPersistedEvents();
    expect(events).toHaveLength(1);
    expect(events[0].key).toBe("artifact.save");
  });
});

describe("disable contract — erase on opt-out", () => {
  it("disableTelemetry truncates the on-disk file", async () => {
    enableTelemetry();
    recordCounter("artifact.save");
    await flushAsync();
    expect(fs.existsSync(sinkFile())).toBe(true);
    disableTelemetry();
    expect(fs.existsSync(sinkFile())).toBe(false);
  });

  it("disableTelemetry drops the in-memory buffer", () => {
    enableTelemetry();
    recordCounter("artifact.save");
    expect(getEventsSnapshot()).toHaveLength(1);
    disableTelemetry();
    expect(getEventsSnapshot()).toHaveLength(0);
  });
});

describe("getEventsSnapshot — disk + memory ordering", () => {
  it("returns disk events before in-memory events", async () => {
    enableTelemetry();
    recordCounter("artifact.save");
    await flushAsync();
    recordCounter("artifact.export");
    const snapshot = getEventsSnapshot();
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0].key).toBe("artifact.save"); // disk
    expect(snapshot[1].key).toBe("artifact.export"); // memory
  });
});
