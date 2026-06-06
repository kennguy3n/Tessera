import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// `crashReport` pulls in `./logger`, which imports `electron`. We only
// need the logger's `error()` to be a no-op here (the on-disk crash
// file is what we assert on, via an explicit `dir`), so stub it out to
// keep the test free of logger side effects.
const loggerError = vi.fn();
vi.mock("../logger", () => ({
  getLogger: () => ({
    error: loggerError,
    dirPath: () => "/tmp/devin-tessera-crashreport-unused",
  }),
}));

import {
  recordCrashReport,
  normalizeCrashReport,
  CRASH_REPORT_FILENAME,
  MAX_REPORTS,
} from "../crashReport";

describe("normalizeCrashReport", () => {
  it("defaults missing fields and stamps a timestamp", () => {
    const r = normalizeCrashReport(null);
    expect(r.component).toBe("unknown");
    expect(r.error).toBe("");
    expect(r.stack).toBe("");
    // ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(r.timestamp))).toBe(false);
  });

  it("preserves provided fields", () => {
    const r = normalizeCrashReport({
      component: "DocumentEditor",
      error: "boom",
      stack: "Error: boom\n  at x",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    expect(r).toEqual({
      component: "DocumentEditor",
      error: "boom",
      stack: "Error: boom\n  at x",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("recordCrashReport", () => {
  let dir: string;

  beforeEach(() => {
    loggerError.mockClear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-crash-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readReports() {
    const file = path.join(dir, CRASH_REPORT_FILENAME);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  it("writes crash-report.json with component, error, stack, timestamp", () => {
    const written = recordCrashReport(
      {
        component: "HomePage",
        error: "render failed",
        stack: "Error: render failed\n  at HomePage",
        timestamp: "2026-02-03T04:05:06.000Z",
      },
      dir,
    );
    expect(written).toBe(path.join(dir, CRASH_REPORT_FILENAME));

    const reports = readReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]).toEqual({
      component: "HomePage",
      error: "render failed",
      stack: "Error: render failed\n  at HomePage",
      timestamp: "2026-02-03T04:05:06.000Z",
    });
    // Also mirrored to the structured logger.
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("appends successive crashes newest-last", () => {
    recordCrashReport({ component: "A", error: "1" }, dir);
    recordCrashReport({ component: "B", error: "2" }, dir);
    const reports = readReports();
    expect(reports.map((r: { component: string }) => r.component)).toEqual([
      "A",
      "B",
    ]);
  });

  it("caps the file at MAX_REPORTS, dropping the oldest", () => {
    for (let i = 0; i < MAX_REPORTS + 5; i += 1) {
      recordCrashReport({ component: `c${i}`, error: String(i) }, dir);
    }
    const reports = readReports();
    expect(reports).toHaveLength(MAX_REPORTS);
    // Oldest five evicted; newest retained.
    expect(reports[0].component).toBe("c5");
    expect(reports[MAX_REPORTS - 1].component).toBe(`c${MAX_REPORTS + 4}`);
  });

  it("recovers from a corrupt existing file instead of throwing", () => {
    const file = path.join(dir, CRASH_REPORT_FILENAME);
    fs.writeFileSync(file, "{ not json", "utf8");
    const written = recordCrashReport({ component: "X", error: "y" }, dir);
    expect(written).toBe(file);
    const reports = readReports();
    expect(reports).toHaveLength(1);
    expect(reports[0].component).toBe("X");
  });

  it("leaves no .tmp debris after writing", () => {
    recordCrashReport({ component: "A", error: "1" }, dir);
    const debris = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(debris).toEqual([]);
  });
});
