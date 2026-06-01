/**
 * `failedExportQueue.ts` regression suite.
 *
 * The queue's value proposition is "no failed export is ever
 * silently lost." Every test below pins one of the failure modes
 * that property protects against:
 *
 *   * Fresh install: file doesn't exist → list returns `[]`.
 *   * Atomic write: a write committed with `fsync` + `rename`
 *     leaves no `.tmp-*` debris and the next read sees the new
 *     content byte-for-byte.
 *   * FIFO eviction at the 100-entry cap.
 *   * `bumpRetryCount` increments without changing other fields.
 *   * `removeFailedExport` is idempotent against duplicate calls.
 *   * Serialised writes: two concurrent enqueues land BOTH entries
 *     (no lost-update from interleaved read/mutate/write paths).
 *   * Malformed on-disk file → list returns `[]` instead of
 *     throwing — the renderer must NEVER see the queue crash.
 *
 * Note on the override: the production queue path is rooted at
 * `app.getPath("userData")`. Tests redirect via
 * `setFailedExportsPathOverrideForTests` so they can write into a
 * fresh tempfile per test and assert on it directly without
 * mocking Electron's app object.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  enqueueFailedExport,
  listFailedExports,
  removeFailedExport,
  bumpRetryCount,
  getFailedExport,
  setFailedExportsPathOverrideForTests,
  clearAllFailedExportsForTests,
  FAILED_EXPORTS_MAX,
} from "../failedExportQueue";

let tempDir: string;
let queuePath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-fxq-"));
  queuePath = path.join(tempDir, "failed-exports.json");
  setFailedExportsPathOverrideForTests(queuePath);
});

afterEach(async () => {
  clearAllFailedExportsForTests();
  setFailedExportsPathOverrideForTests(null);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("failedExportQueue: fresh install", () => {
  it("returns an empty list when the file does not exist", async () => {
    const entries = await listFailedExports();
    expect(entries).toEqual([]);
  });
});

describe("failedExportQueue: write-side path validation", () => {
  // Devin Review PR #69: regression coverage for the
  // write-time absolute-path guard in `enqueueFailedExport`. Before
  // the guard, a relative path would land on disk and then silently
  // disappear from the renderer on the next `listFailedExports`
  // because the read side already required absoluteness. The
  // failure mode (phantom write, no error) was effectively
  // unloggable; failing fast at the enqueue boundary surfaces the
  // caller bug.
  it("rejects a relative filePath at enqueue time", async () => {
    await expect(
      enqueueFailedExport({
        artifactId: "art1",
        format: "pdf",
        filePath: "exports/foo.pdf",
        errorMessage: "x",
      }),
    ).rejects.toThrow(/filePath must be absolute/);
    // And the on-disk file must not have been created — if the
    // throw happened after the write the guard would be useless.
    await expect(fs.access(queuePath)).rejects.toThrow();
  });

  it("rejects an empty filePath at enqueue time", async () => {
    await expect(
      enqueueFailedExport({
        artifactId: "art1",
        format: "pdf",
        filePath: "",
        errorMessage: "x",
      }),
    ).rejects.toThrow(/non-empty string/);
    await expect(fs.access(queuePath)).rejects.toThrow();
  });
});

describe("failedExportQueue: round-trip", () => {
  it("persists an entry through enqueue / list", async () => {
    const entry = await enqueueFailedExport({
      artifactId: "art1",
      format: "pdf",
      filePath: "/tmp/x.pdf",
      errorMessage: "disk full",
    });
    expect(entry.artifactId).toBe("art1");
    expect(entry.format).toBe("pdf");
    expect(entry.filePath).toBe("/tmp/x.pdf");
    expect(entry.errorMessage).toBe("disk full");
    expect(entry.retryCount).toBe(0);
    expect(entry.id).toMatch(/^fx_/);
    const listed = await listFailedExports();
    expect(listed).toEqual([entry]);
  });

  it("does not leak a `.tmp-*` file after a successful enqueue", async () => {
    await enqueueFailedExport({
      artifactId: "art1",
      format: "pdf",
      filePath: "/tmp/x.pdf",
      errorMessage: "x",
    });
    const entries = await fs.readdir(tempDir);
    const tmps = entries.filter((e) => e.includes(".tmp-"));
    expect(tmps).toEqual([]);
  });

  it("appends multiple entries in insertion order", async () => {
    const e1 = await enqueueFailedExport({
      artifactId: "art1",
      format: "pdf",
      filePath: "/tmp/1.pdf",
      errorMessage: "x",
    });
    const e2 = await enqueueFailedExport({
      artifactId: "art2",
      format: "docx",
      filePath: "/tmp/2.docx",
      errorMessage: "y",
    });
    const listed = await listFailedExports();
    expect(listed.map((e) => e.id)).toEqual([e1.id, e2.id]);
  });
});

describe("failedExportQueue: dequeue", () => {
  it("removes the named entry", async () => {
    const e1 = await enqueueFailedExport({
      artifactId: "a",
      format: "pdf",
      filePath: "/tmp/1.pdf",
      errorMessage: "x",
    });
    const e2 = await enqueueFailedExport({
      artifactId: "b",
      format: "pdf",
      filePath: "/tmp/2.pdf",
      errorMessage: "x",
    });
    const removed = await removeFailedExport(e1.id);
    expect(removed).toBe(true);
    const listed = await listFailedExports();
    expect(listed.map((e) => e.id)).toEqual([e2.id]);
  });

  it("is idempotent against a duplicate dequeue", async () => {
    const e1 = await enqueueFailedExport({
      artifactId: "a",
      format: "pdf",
      filePath: "/tmp/1.pdf",
      errorMessage: "x",
    });
    expect(await removeFailedExport(e1.id)).toBe(true);
    expect(await removeFailedExport(e1.id)).toBe(false);
  });
});

describe("failedExportQueue: bumpRetryCount", () => {
  it("increments retryCount in place without disturbing other fields", async () => {
    const e1 = await enqueueFailedExport({
      artifactId: "a",
      format: "pdf",
      filePath: "/tmp/1.pdf",
      errorMessage: "x",
    });
    const bumped = await bumpRetryCount(e1.id);
    expect(bumped).not.toBeNull();
    expect(bumped!.retryCount).toBe(1);
    expect(bumped!.artifactId).toBe(e1.artifactId);
    expect(bumped!.filePath).toBe(e1.filePath);
    const bumpedAgain = await bumpRetryCount(e1.id);
    expect(bumpedAgain!.retryCount).toBe(2);
  });

  it("returns null when the id is no longer in the queue", async () => {
    expect(await bumpRetryCount("fx_does_not_exist")).toBeNull();
  });
});

describe("failedExportQueue: getFailedExport", () => {
  it("returns the entry by id", async () => {
    const e1 = await enqueueFailedExport({
      artifactId: "a",
      format: "pdf",
      filePath: "/tmp/1.pdf",
      errorMessage: "x",
    });
    const got = await getFailedExport(e1.id);
    expect(got).toEqual(e1);
  });
  it("returns null for a missing id", async () => {
    expect(await getFailedExport("fx_missing")).toBeNull();
  });
});

describe("failedExportQueue: FIFO eviction at the cap", () => {
  it(`drops the oldest entry when the cap (${FAILED_EXPORTS_MAX}) is exceeded`, async () => {
    // Insert FAILED_EXPORTS_MAX + 1 entries and verify the first
    // one is evicted while the last `FAILED_EXPORTS_MAX` stay in
    // insertion order.
    const ids: string[] = [];
    for (let i = 0; i < FAILED_EXPORTS_MAX + 1; i += 1) {
      const entry = await enqueueFailedExport({
        artifactId: `art${i}`,
        format: "pdf",
        filePath: `/tmp/${i}.pdf`,
        errorMessage: "x",
      });
      ids.push(entry.id);
    }
    const listed = await listFailedExports();
    expect(listed.length).toBe(FAILED_EXPORTS_MAX);
    // First id should have been evicted; second-through-last
    // should be present in order.
    expect(listed.map((e) => e.id)).toEqual(ids.slice(1));
  });
});

describe("failedExportQueue: concurrency", () => {
  it("serialises concurrent enqueues so neither write is lost", async () => {
    // Issue 10 enqueues in parallel; without the serialiser, a
    // few would race and stomp the on-disk array. All 10 must
    // appear.
    const ops = Array.from({ length: 10 }, (_, i) =>
      enqueueFailedExport({
        artifactId: `art${i}`,
        format: "pdf",
        filePath: `/tmp/${i}.pdf`,
        errorMessage: `x${i}`,
      }),
    );
    const inserted = await Promise.all(ops);
    const listed = await listFailedExports();
    expect(listed.length).toBe(10);
    // Each enqueue must produce a distinct id.
    const ids = new Set(inserted.map((e) => e.id));
    expect(ids.size).toBe(10);
  });
});

describe("failedExportQueue: malformed on-disk file", () => {
  it("returns [] on JSON parse failure (renderer must never crash)", async () => {
    await fs.writeFile(queuePath, "not valid json", "utf-8");
    const listed = await listFailedExports();
    expect(listed).toEqual([]);
  });

  it("returns [] when the version is unknown", async () => {
    await fs.writeFile(
      queuePath,
      JSON.stringify({ version: 99, entries: [] }),
      "utf-8",
    );
    const listed = await listFailedExports();
    expect(listed).toEqual([]);
  });

  it("drops individual entries that fail structural validation", async () => {
    await fs.writeFile(
      queuePath,
      JSON.stringify({
        version: 1,
        entries: [
          {
            id: "fx_good",
            artifactId: "art1",
            format: "pdf",
            filePath: "/tmp/x.pdf",
            errorMessage: "x",
            failedAt: Date.now(),
            retryCount: 0,
          },
          { id: "fx_bad" }, // missing required fields
          null,
          "not an object",
        ],
      }),
      "utf-8",
    );
    const listed = await listFailedExports();
    expect(listed.length).toBe(1);
    expect(listed[0].id).toBe("fx_good");
  });
});
