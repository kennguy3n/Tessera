/**
 * Phase 15 Task 22 — `sources:healthReport` IPC handler.
 *
 * Covers the renderer-facing health summary used by
 * `SourceHealthDashboard`. The Rust bridge is mocked because the
 * `.node` addon is unavailable in the vitest sandbox, but the real
 * handler logic exercises:
 *
 *   1. `bridgeListSources` + per-source `bridgeGetSourceDetail`
 *      stitching: chunks aggregated correctly.
 *   2. `fs.stat` on every indexed file: storage estimate matches
 *      sum of stat sizes. Files missing from disk demote the source
 *      to `warning` AND contribute 0 bytes (not stat-error throws).
 *   3. Status → traffic-light mapping:
 *      - `indexed`/`connected` (and lastIndexed != null) + all
 *        files readable → `healthy`
 *      - `indexing` OR any stat error OR lastIndexed == null →
 *        `warning`
 *      - `error` OR `access_revoked` → `error` (overrides every
 *        other signal)
 *   4. Per-source isolation: a bridge throwing on one source still
 *      lets every other source surface a row (the failing one is
 *      reported with health=error, chunkCount=0, storageBytes=0).
 *   5. Bridge unavailable → handler rejects, not crashes.
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

let stubBridge: unknown = null;
vi.mock("../appState", () => ({
  getBridge: () => stubBridge,
  isBridgeAvailable: () => stubBridge !== null,
}));

import { registerSourcesHandlers } from "../ipc/sources";
import type {
  SourceHealthReport,
  SourceInfo,
  SourceDetailInfo,
} from "../../shared/types";

function getHandler(channel: string): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "src-health-"));
  handleMock.mockReset();
  removeHandlerMock.mockReset();
  stubBridge = null;
});

afterEach(() => {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeSource(over: Partial<SourceInfo>): SourceInfo {
  // Use `'lastIndexed' in over` so a caller can explicitly pass
  // `lastIndexed: null` (the "never indexed" state) without it being
  // swallowed by `?? defaultDate`. `??` coalesces null AND undefined,
  // so a literal `null` would otherwise round-trip to the default.
  return {
    id: over.id ?? "src-1",
    sourceType: over.sourceType ?? "local_folder",
    path: over.path ?? "/tmp",
    status: over.status ?? "indexed",
    createdAt: over.createdAt ?? new Date().toISOString(),
    lastIndexed:
      "lastIndexed" in over ? over.lastIndexed! : new Date().toISOString(),
    fileCount: over.fileCount ?? 0,
  } as SourceInfo;
}

describe("sources:healthReport", () => {
  it("rejects when the bridge is unavailable", async () => {
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    await expect(handler({})).rejects.toThrow(/bridge/i);
  });

  it("aggregates chunk counts and storage bytes per source, classifies as healthy", async () => {
    // Create two real files on disk so fs.stat returns deterministic
    // sizes; the report should sum them up.
    const f1 = path.join(userDataDir, "a.md");
    const f2 = path.join(userDataDir, "b.md");
    fs.writeFileSync(f1, "x".repeat(100));
    fs.writeFileSync(f2, "y".repeat(250));

    stubBridge = {
      bridgeListSources: vi.fn().mockReturnValue([
        makeSource({ id: "src-1", path: userDataDir, status: "indexed" }),
      ]),
      bridgeGetSourceDetail: vi.fn().mockReturnValue({
        source: makeSource({ id: "src-1" }),
        files: [
          { path: f1, hash: "h1", lastModified: "x", chunkCount: 3 },
          { path: f2, hash: "h2", lastModified: "y", chunkCount: 5 },
        ],
      } as SourceDetailInfo),
    };
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    const report = (await handler({})) as SourceHealthReport;

    expect(report.sources).toHaveLength(1);
    const row = report.sources[0];
    expect(row.chunkCount).toBe(8);
    expect(row.storageBytes).toBe(350);
    expect(row.staleFiles).toBe(0);
    expect(row.health).toBe("healthy");
  });

  it("marks a source as warning when an indexed file no longer stats", async () => {
    const real = path.join(userDataDir, "real.md");
    fs.writeFileSync(real, "ok");
    const missing = path.join(userDataDir, "missing.md");

    stubBridge = {
      bridgeListSources: vi.fn().mockReturnValue([
        makeSource({ id: "src-stale", path: userDataDir }),
      ]),
      bridgeGetSourceDetail: vi.fn().mockReturnValue({
        source: makeSource({ id: "src-stale" }),
        files: [
          { path: real, hash: "h", lastModified: "x", chunkCount: 1 },
          { path: missing, hash: "h2", lastModified: "y", chunkCount: 4 },
        ],
      } as SourceDetailInfo),
    };
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    const report = (await handler({})) as SourceHealthReport;

    expect(report.sources[0].chunkCount).toBe(5);
    expect(report.sources[0].storageBytes).toBe(2); // only the real file
    expect(report.sources[0].staleFiles).toBe(1);
    expect(report.sources[0].health).toBe("warning");
  });

  it("classifies error / access_revoked sources as error regardless of files", async () => {
    stubBridge = {
      bridgeListSources: vi.fn().mockReturnValue([
        makeSource({ id: "broken", status: "error", path: userDataDir }),
        makeSource({
          id: "revoked",
          status: "access_revoked",
          path: userDataDir,
        }),
      ]),
      bridgeGetSourceDetail: vi.fn().mockReturnValue({
        source: makeSource({ id: "broken" }),
        files: [],
      } as SourceDetailInfo),
    };
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    const report = (await handler({})) as SourceHealthReport;

    expect(report.sources.map((s) => s.health).sort()).toEqual([
      "error",
      "error",
    ]);
  });

  it("classifies indexing sources as warning", async () => {
    stubBridge = {
      bridgeListSources: vi.fn().mockReturnValue([
        makeSource({ id: "ix", status: "indexing", path: userDataDir }),
      ]),
      bridgeGetSourceDetail: vi.fn().mockReturnValue({
        source: makeSource({ id: "ix" }),
        files: [],
      } as SourceDetailInfo),
    };
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    const report = (await handler({})) as SourceHealthReport;

    expect(report.sources[0].health).toBe("warning");
  });

  it("classifies sources with no lastIndexed as warning", async () => {
    stubBridge = {
      bridgeListSources: vi.fn().mockReturnValue([
        makeSource({
          id: "fresh",
          status: "connected",
          lastIndexed: null,
          path: userDataDir,
        }),
      ]),
      bridgeGetSourceDetail: vi.fn().mockReturnValue({
        source: makeSource({ id: "fresh" }),
        files: [],
      } as SourceDetailInfo),
    };
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    const report = (await handler({})) as SourceHealthReport;

    expect(report.sources[0].health).toBe("warning");
  });

  it("isolates per-source bridge errors and surfaces other rows", async () => {
    const f = path.join(userDataDir, "x.md");
    fs.writeFileSync(f, "hello");

    let callCount = 0;
    stubBridge = {
      bridgeListSources: vi.fn().mockReturnValue([
        makeSource({ id: "good", path: userDataDir }),
        makeSource({ id: "bad", path: userDataDir }),
      ]),
      bridgeGetSourceDetail: vi.fn((id: string) => {
        callCount += 1;
        if (id === "bad") {
          throw new Error("source vanished");
        }
        return {
          source: makeSource({ id }),
          files: [{ path: f, hash: "h", lastModified: "x", chunkCount: 1 }],
        };
      }),
    };
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    const report = (await handler({})) as SourceHealthReport;

    expect(callCount).toBe(2);
    expect(report.sources).toHaveLength(2);
    const good = report.sources.find((s) => s.sourceId === "good");
    const bad = report.sources.find((s) => s.sourceId === "bad");
    expect(good?.health).toBe("healthy");
    expect(good?.chunkCount).toBe(1);
    expect(bad?.health).toBe("error");
    expect(bad?.chunkCount).toBe(0);
    expect(bad?.storageBytes).toBe(0);
  });

  it("returns an ISO-8601 generatedAt timestamp", async () => {
    stubBridge = {
      bridgeListSources: vi.fn().mockReturnValue([]),
    };
    registerSourcesHandlers();
    const handler = getHandler("sources:healthReport");
    const report = (await handler({})) as SourceHealthReport;
    expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
