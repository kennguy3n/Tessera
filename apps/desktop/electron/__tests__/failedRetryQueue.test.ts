/**
 * Unit tests for the cross-connector failed-retry queue helper in
 * `ipc/connectors/syncDir.ts`. This helper is the building block for
 * the Notion / Jira / Figma fix to the wave-5 Devin Review finding
 * about watermark advancement past transiently-failed items.
 *
 * The behavior we care about:
 *   1. A failed item enters the queue with `failureCount: 1`.
 *   2. A subsequent failure on the same id bumps the count.
 *   3. A success removes the item from the queue.
 *   4. After `FAILED_RETRY_MAX_ATTEMPTS` consecutive failures the
 *      item is dropped (we give up on it).
 *   5. The queue is FIFO-bounded by `FAILED_RETRY_QUEUE_MAX` so a
 *      pathological run can't grow the state file unboundedly.
 */
import { describe, it, expect } from "vitest";

import {
  FAILED_RETRY_MAX_ATTEMPTS,
  FAILED_RETRY_QUEUE_MAX,
  isAfterWatermark,
  maxWatermark,
  nextFailedRetryQueue,
  parseWatermarkIso,
  type FailedRetryEntry,
} from "../ipc/connectors/syncDir";

describe("nextFailedRetryQueue", () => {
  it("inserts a brand-new failure with failureCount=1", () => {
    const next = nextFailedRetryQueue([], {
      succeeded: [],
      failed: [{ remoteId: "a", remoteModifiedAt: "2024-06-01T00:00:00Z" }],
    });
    expect(next).toEqual([
      { remoteId: "a", remoteModifiedAt: "2024-06-01T00:00:00Z", failureCount: 1 },
    ]);
  });

  it("bumps failureCount on a repeated failure", () => {
    const previous: FailedRetryEntry[] = [
      { remoteId: "a", remoteModifiedAt: "2024-06-01T00:00:00Z", failureCount: 2 },
    ];
    const next = nextFailedRetryQueue(previous, {
      succeeded: [],
      failed: [{ remoteId: "a", remoteModifiedAt: "2024-06-02T00:00:00Z" }],
    });
    expect(next).toEqual([
      {
        remoteId: "a",
        // Prefers the most recent observed modification time
        remoteModifiedAt: "2024-06-02T00:00:00Z",
        failureCount: 3,
      },
    ]);
  });

  it("removes an item from the queue once it succeeds", () => {
    const previous: FailedRetryEntry[] = [
      { remoteId: "a", remoteModifiedAt: null, failureCount: 1 },
      { remoteId: "b", remoteModifiedAt: null, failureCount: 3 },
    ];
    const next = nextFailedRetryQueue(previous, {
      succeeded: ["b"],
      failed: [],
    });
    expect(next.map((e) => e.remoteId)).toEqual(["a"]);
  });

  it(
    `drops an item after ${FAILED_RETRY_MAX_ATTEMPTS} consecutive failures (perma-broken)`,
    () => {
      const previous: FailedRetryEntry[] = [
        {
          remoteId: "a",
          remoteModifiedAt: null,
          failureCount: FAILED_RETRY_MAX_ATTEMPTS,
        },
      ];
      const next = nextFailedRetryQueue(previous, {
        succeeded: [],
        failed: [{ remoteId: "a", remoteModifiedAt: null }],
      });
      // After the bump we'd hit MAX_ATTEMPTS + 1 → dropped.
      expect(next).toEqual([]);
    },
  );

  it(
    `bounds the queue at FAILED_RETRY_QUEUE_MAX (${FAILED_RETRY_QUEUE_MAX}) entries, FIFO`,
    () => {
      const previous: FailedRetryEntry[] = [];
      const failed = Array.from({ length: FAILED_RETRY_QUEUE_MAX + 25 }, (_, i) => ({
        remoteId: `id-${i}`,
        remoteModifiedAt: null,
      }));
      const next = nextFailedRetryQueue(previous, {
        succeeded: [],
        failed,
      });
      expect(next).toHaveLength(FAILED_RETRY_QUEUE_MAX);
      // The earliest-inserted ids are evicted; the most recent should
      // remain.
      expect(next[next.length - 1].remoteId).toBe(`id-${FAILED_RETRY_QUEUE_MAX + 24}`);
      expect(next[0].remoteId).toBe(`id-25`);
    },
  );

  it("preserves prior failureCount when the same item fails again", () => {
    const previous: FailedRetryEntry[] = [
      { remoteId: "a", remoteModifiedAt: "2024-06-01T00:00:00Z", failureCount: 3 },
      { remoteId: "b", remoteModifiedAt: "2024-06-01T00:00:00Z", failureCount: 1 },
    ];
    const next = nextFailedRetryQueue(previous, {
      succeeded: ["b"],
      failed: [{ remoteId: "a", remoteModifiedAt: null }],
    });
    expect(next).toEqual([
      // a is retained with bumped count + falls back to existing
      // remoteModifiedAt since the new event reported null.
      { remoteId: "a", remoteModifiedAt: "2024-06-01T00:00:00Z", failureCount: 4 },
    ]);
  });

  it(
    "handles the same id appearing in both succeeded and failed " +
      "(treats failed as authoritative — the more conservative choice)",
    () => {
      const next = nextFailedRetryQueue([], {
        succeeded: ["a"],
        failed: [{ remoteId: "a", remoteModifiedAt: null }],
      });
      // After delete-succeeded then insert-failed, the item ends up
      // in the queue. This is the correct conservative behavior: if
      // the *same pass* both succeeded and failed for one id (rare
      // but possible via Notion's Phase-1 retry + Phase-2 watermark
      // scan being de-duped post-hoc), we'd rather over-retry than
      // silently drop.
      expect(next).toHaveLength(1);
      expect(next[0].remoteId).toBe("a");
      expect(next[0].failureCount).toBe(1);
    },
  );
});

describe("parseWatermarkIso", () => {
  it("returns null for null / undefined / empty input", () => {
    expect(parseWatermarkIso(null)).toBeNull();
    expect(parseWatermarkIso(undefined)).toBeNull();
    expect(parseWatermarkIso("")).toBeNull();
  });

  it("returns null for unparsable garbage", () => {
    expect(parseWatermarkIso("not-a-timestamp")).toBeNull();
    expect(parseWatermarkIso("2024-99-99T99:99:99Z")).toBeNull();
  });

  it("parses `Z`-suffixed UTC timestamps", () => {
    expect(parseWatermarkIso("2024-06-01T12:00:00Z")).toBe(
      Date.UTC(2024, 5, 1, 12, 0, 0),
    );
  });

  it("returns the same epoch ms for equivalent `Z` and `+00:00` " +
    "suffixes (regression: Devin Review wave 7 ANALYSIS_0001 — " +
    "lexicographic compare used to give the wrong answer here)", () => {
    const z = parseWatermarkIso("2024-06-01T12:00:00Z");
    const plusZero = parseWatermarkIso("2024-06-01T12:00:00+00:00");
    expect(z).not.toBeNull();
    expect(z).toBe(plusZero);
  });

  it("handles fractional seconds + non-UTC offsets equivalently", () => {
    const a = parseWatermarkIso("2024-06-01T12:00:00.500Z");
    const b = parseWatermarkIso("2024-06-01T13:00:00.500+01:00");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});

describe("isAfterWatermark", () => {
  it("returns true when there is no previous watermark", () => {
    expect(isAfterWatermark("2024-06-01T12:00:00Z", null)).toBe(true);
    expect(isAfterWatermark("2024-06-01T12:00:00Z", undefined)).toBe(true);
  });

  it("returns false when candidate is unparsable", () => {
    expect(isAfterWatermark("garbage", "2024-06-01T12:00:00Z")).toBe(false);
    expect(isAfterWatermark(null, "2024-06-01T12:00:00Z")).toBe(false);
  });

  it("returns true only for strictly-newer candidates", () => {
    const w = "2024-06-01T12:00:00Z";
    expect(isAfterWatermark("2024-06-01T12:00:01Z", w)).toBe(true);
    expect(isAfterWatermark("2024-06-01T12:00:00Z", w)).toBe(false);
    expect(isAfterWatermark("2024-06-01T11:59:59Z", w)).toBe(false);
  });

  it(
    "agrees regardless of timezone suffix mixing (regression: " +
      "Devin Review wave 7 ANALYSIS_0001 — lexicographic compare " +
      "of `Z` vs `+00:00` used to produce the wrong order)",
    () => {
      // The two values represent the *same instant* — `isAfterWatermark`
      // must therefore return `false` for "newer-than-itself".
      expect(
        isAfterWatermark("2024-06-01T12:00:00Z", "2024-06-01T12:00:00+00:00"),
      ).toBe(false);
      expect(
        isAfterWatermark("2024-06-01T12:00:00+00:00", "2024-06-01T12:00:00Z"),
      ).toBe(false);
      // Strictly-newer should still be detected across suffixes.
      expect(
        isAfterWatermark("2024-06-01T12:00:01Z", "2024-06-01T12:00:00+00:00"),
      ).toBe(true);
    },
  );
});

describe("maxWatermark", () => {
  it("returns null when both inputs are null / unparsable", () => {
    expect(maxWatermark(null, null)).toBeNull();
    expect(maxWatermark("garbage", undefined)).toBeNull();
  });

  it("returns the non-null input when only one is parsable", () => {
    expect(maxWatermark(null, "2024-06-01T12:00:00Z")).toBe(
      "2024-06-01T12:00:00Z",
    );
    expect(maxWatermark("2024-06-01T12:00:00Z", null)).toBe(
      "2024-06-01T12:00:00Z",
    );
  });

  it("returns the later of two parsable timestamps verbatim", () => {
    expect(
      maxWatermark("2024-06-01T12:00:00Z", "2024-07-01T00:00:00Z"),
    ).toBe("2024-07-01T00:00:00Z");
    expect(
      maxWatermark("2024-07-01T00:00:00Z", "2024-06-01T12:00:00Z"),
    ).toBe("2024-07-01T00:00:00Z");
  });

  it("preserves the original ISO string (not the parsed epoch ms)", () => {
    // The persistence path stores whichever string the provider gave
    // us so the saved watermark is round-trippable as a human-readable
    // value in diagnostics. Verify we don't accidentally re-emit a
    // normalised form.
    expect(
      maxWatermark("2024-06-01T12:00:00+00:00", "2024-05-01T00:00:00Z"),
    ).toBe("2024-06-01T12:00:00+00:00");
  });
});
