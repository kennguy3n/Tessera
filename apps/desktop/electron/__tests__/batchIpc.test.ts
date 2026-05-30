/**
 * Phase 15 Task 6 — `sources:batchReindex` / `artifacts:batchExport` regression
 * suite.
 *
 * Three concerns:
 *
 *   1. Per-item error isolation: one failing id MUST NOT abort the
 *      remaining items. The response must surface a per-item
 *      `{ ok: false, error }` shape rather than throw.
 *   2. Single-bridge-call amortisation: the batch path issues one
 *      bridge call per id, sequentially, against a single shared
 *      bridge handle. The test asserts the call count equals the
 *      input id count (not 2× as a regression would produce if the
 *      handler accidentally double-dispatched).
 *   3. Input validation: input array size cap, malformed ids
 *      reject up-front, empty arrays no-op cleanly.
 *
 * The tests drive the pure `runBatch` helper (no Electron IPC
 * surface needed) plus the validator wired in
 * `sources.ts` / `artifacts.ts`. Driving the helper directly keeps
 * the tests fast and removes the Electron mock surface area — the
 * IPC plumbing (`idempotentHandle` → `ipcMain.handle`) is already
 * exercised by the renderer's e2e suite; what we need to pin here
 * is the per-item semantics.
 */
import { describe, expect, it, vi } from "vitest";
import {
  BATCH_MAX_ITEMS,
  type BatchItemResult,
  runBatch,
} from "../ipc/batch";
import { assertStringArray } from "../ipc/validate";

describe("runBatch (Phase 15 Task 6 — IPC bulk operation primitive)", () => {
  it("returns one ok-true entry per id when every handler succeeds", async () => {
    const handler = vi.fn(async (id: string) => `result:${id}`);
    const ids = ["a", "b", "c", "d"];
    const res = await runBatch(ids, handler);

    expect(handler).toHaveBeenCalledTimes(4);
    expect(res.total).toBe(4);
    expect(res.succeeded).toBe(4);
    expect(res.failed).toBe(0);
    expect(res.results.map((r) => r.id)).toEqual(ids);
    res.results.forEach((r, i) => {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe(`result:${ids[i]}`);
      }
    });
  });

  it("isolates per-item failures and surfaces them in the result vector", async () => {
    const handler = vi.fn(async (id: string) => {
      if (id === "bad") {
        throw new Error("synthetic failure");
      }
      return `result:${id}`;
    });
    const ids = ["a", "bad", "c"];
    const res = await runBatch(ids, handler);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(res.total).toBe(3);
    expect(res.succeeded).toBe(2);
    expect(res.failed).toBe(1);
    expect(res.results[0]).toEqual({
      id: "a",
      ok: true,
      value: "result:a",
    });
    expect(res.results[1]).toEqual({
      id: "bad",
      ok: false,
      error: "synthetic failure",
    });
    expect(res.results[2]).toEqual({
      id: "c",
      ok: true,
      value: "result:c",
    });
  });

  it("coerces non-Error thrown values to a string error", async () => {
    const handler = vi.fn(async (id: string) => {
      if (id === "thrown-string") {
        throw "plain-string-rejection";
      }
      if (id === "thrown-null") {
        throw null;
      }
      return id;
    });
    const ids = ["ok-1", "thrown-string", "thrown-null", "ok-2"];
    const res = await runBatch(ids, handler);
    expect(res.results[1]).toEqual({
      id: "thrown-string",
      ok: false,
      error: "plain-string-rejection",
    });
    expect(res.results[2].ok).toBe(false);
    if (!res.results[2].ok) {
      // `String(null)` is `"null"`; we just need a stable string.
      expect(res.results[2].error.length).toBeGreaterThan(0);
    }
  });

  it("preserves input order in the results vector even with mixed outcomes", async () => {
    const handler = vi.fn(async (id: string) => {
      // odd ids fail, even ids succeed
      const n = Number.parseInt(id, 10);
      if (n % 2 === 1) {
        throw new Error(`odd-${n}`);
      }
      return `even-${n}`;
    });
    const ids = ["0", "1", "2", "3", "4", "5"];
    const res = await runBatch(ids, handler);
    expect(res.results.map((r) => r.id)).toEqual(ids);
    expect(res.succeeded).toBe(3);
    expect(res.failed).toBe(3);
  });

  it("issues exactly one handler call per id (no double-dispatch regression)", async () => {
    const handler = vi.fn(async (id: string) => id);
    const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    await runBatch(ids, handler);
    expect(handler).toHaveBeenCalledTimes(ids.length);
    // Every call argument should appear exactly once in the
    // handler call log — no id should be retried, swallowed, or
    // double-counted.
    const seen = new Set<string>();
    for (const call of handler.mock.calls) {
      const arg = call[0] as string;
      expect(seen.has(arg)).toBe(false);
      seen.add(arg);
    }
    expect(seen.size).toBe(ids.length);
  });

  it("returns an empty response shape for an empty input array", async () => {
    const handler = vi.fn(async (id: string) => id);
    const res = await runBatch([], handler);
    expect(handler).not.toHaveBeenCalled();
    expect(res).toEqual({
      total: 0,
      succeeded: 0,
      failed: 0,
      results: [],
    });
  });

  it("runs handlers sequentially, not in parallel (single-bridge invariant)", async () => {
    // A truly-parallel implementation would interleave the
    // delays. Sequential execution means start-i+1 happens AFTER
    // end-i, so the recorded events alternate (start, end) for
    // every id without overlap.
    const events: string[] = [];
    const handler = vi.fn(async (id: string) => {
      events.push(`start:${id}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      events.push(`end:${id}`);
      return id;
    });
    const ids = ["a", "b", "c"];
    await runBatch(ids, handler);
    expect(events).toEqual([
      "start:a",
      "end:a",
      "start:b",
      "end:b",
      "start:c",
      "end:c",
    ]);
  });
});

describe("batch validators (input sanitization)", () => {
  it("BATCH_MAX_ITEMS guard rejects oversized inputs at the validator boundary", () => {
    const oversized: string[] = Array.from(
      { length: BATCH_MAX_ITEMS + 1 },
      (_, i) => `id-${i}`,
    );
    expect(() =>
      assertStringArray(oversized, "sourceIds", { maxLen: BATCH_MAX_ITEMS }),
    ).toThrowError(/too many entries/);
  });

  it("accepts an array exactly at BATCH_MAX_ITEMS", () => {
    const atMax: string[] = Array.from(
      { length: BATCH_MAX_ITEMS },
      (_, i) => `id-${i}`,
    );
    const out = assertStringArray(atMax, "sourceIds", { maxLen: BATCH_MAX_ITEMS });
    expect(out).toHaveLength(BATCH_MAX_ITEMS);
  });

  it("rejects non-array inputs", () => {
    expect(() => assertStringArray("not-an-array", "sourceIds")).toThrowError(
      /must be an array of strings/,
    );
    expect(() => assertStringArray({ length: 3 }, "sourceIds")).toThrowError(
      /must be an array of strings/,
    );
    expect(() => assertStringArray(null, "sourceIds")).toThrowError(
      /must be an array of strings/,
    );
  });

  it("rejects arrays containing non-string entries", () => {
    expect(() =>
      assertStringArray(["a", 42, "c"], "sourceIds"),
    ).toThrowError(/sourceIds\[1\]/);
  });
});

describe("batch result type narrowing (TS contract)", () => {
  it("BatchItemResult discriminates on ok for type-safe value access", async () => {
    const res = await runBatch(["ok", "fail"], async (id) => {
      if (id === "fail") {
        throw new Error("nope");
      }
      return { payload: id } as const;
    });
    const [okResult, failResult] = res.results as [
      BatchItemResult<{ payload: string }>,
      BatchItemResult<{ payload: string }>,
    ];
    if (okResult.ok) {
      // `value` is accessible only on the ok branch
      expect(okResult.value.payload).toBe("ok");
    } else {
      throw new Error("expected ok-branch entry to be ok");
    }
    if (!failResult.ok) {
      expect(failResult.error).toBe("nope");
    } else {
      throw new Error("expected fail-branch entry to be !ok");
    }
  });
});
