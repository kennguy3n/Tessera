import { describe, it, expect } from "vitest";
import {
  withCreatedMeta,
  touchModified,
  stampImportedMeta,
  getComments,
  addComment,
  removeComment,
  formatTimestamp,
} from "../baseRecordMeta";
import {
  RECORD_CREATED_KEY,
  RECORD_MODIFIED_KEY,
  RECORD_COMMENTS_KEY,
  type BaseRecord,
} from "../baseEditorTypes";

const ISO_A = "2024-01-01T10:00:00.000Z";
const ISO_B = "2024-06-15T18:30:00.000Z";

describe("withCreatedMeta", () => {
  it("stamps created + modified on a fresh record", () => {
    const out = withCreatedMeta({ id: "r1" }, ISO_A);
    expect(out[RECORD_CREATED_KEY]).toBe(ISO_A);
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_A);
  });

  it("never overwrites an existing creation time", () => {
    const out = withCreatedMeta(
      { id: "r1", [RECORD_CREATED_KEY]: ISO_A },
      ISO_B,
    );
    expect(out[RECORD_CREATED_KEY]).toBe(ISO_A);
    // modified always refreshes
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_B);
  });

  it("does not mutate the input", () => {
    const input: BaseRecord = { id: "r1" };
    withCreatedMeta(input, ISO_A);
    expect(input[RECORD_CREATED_KEY]).toBeUndefined();
  });
});

describe("stampImportedMeta", () => {
  it("stamps created + modified on rows that lack a creation time", () => {
    const out = stampImportedMeta(
      [{ id: "r1" }, { id: "r2", Name: "x" }],
      ISO_A,
    );
    expect(out[0][RECORD_CREATED_KEY]).toBe(ISO_A);
    expect(out[0][RECORD_MODIFIED_KEY]).toBe(ISO_A);
    expect(out[1][RECORD_CREATED_KEY]).toBe(ISO_A);
    expect(out[1][RECORD_MODIFIED_KEY]).toBe(ISO_A);
  });

  it("preserves both timestamps on rows that already carry __created", () => {
    const out = stampImportedMeta(
      [
        {
          id: "r1",
          [RECORD_CREATED_KEY]: ISO_A,
          [RECORD_MODIFIED_KEY]: ISO_A,
        },
      ],
      ISO_B,
    );
    // A canonical-JSON round-trip must keep its original created AND
    // modified, not get re-stamped to the import time.
    expect(out[0][RECORD_CREATED_KEY]).toBe(ISO_A);
    expect(out[0][RECORD_MODIFIED_KEY]).toBe(ISO_A);
  });

  it("shares one timestamp across the whole imported batch", () => {
    const out = stampImportedMeta([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const created = out.map((r) => r[RECORD_CREATED_KEY]);
    expect(new Set(created).size).toBe(1);
    expect(typeof created[0]).toBe("string");
  });

  it("does not mutate the input rows", () => {
    const input: BaseRecord = { id: "r1" };
    stampImportedMeta([input], ISO_A);
    expect(input[RECORD_CREATED_KEY]).toBeUndefined();
  });
});

describe("touchModified", () => {
  it("bumps modified and backfills a missing created", () => {
    const out = touchModified({ id: "r1" }, ISO_B);
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_B);
    expect(out[RECORD_CREATED_KEY]).toBe(ISO_B);
  });

  it("preserves an existing created timestamp", () => {
    const out = touchModified(
      { id: "r1", [RECORD_CREATED_KEY]: ISO_A },
      ISO_B,
    );
    expect(out[RECORD_CREATED_KEY]).toBe(ISO_A);
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_B);
  });
});

describe("getComments", () => {
  it("returns [] for a record with no comments", () => {
    expect(getComments({ id: "r1" })).toEqual([]);
  });

  it("tolerates a non-array / junk shape", () => {
    expect(getComments({ id: "r1", [RECORD_COMMENTS_KEY]: "nope" } as unknown as BaseRecord)).toEqual([]);
  });

  it("filters out malformed comment elements", () => {
    const rec = {
      id: "r1",
      [RECORD_COMMENTS_KEY]: [
        { id: "c1", author: "A", body: "hi", createdAt: ISO_A },
        { id: "c2" }, // missing body
        null,
        42,
      ],
    } as unknown as BaseRecord;
    const out = getComments(rec);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("c1");
  });
});

describe("addComment", () => {
  it("appends a comment and bumps modified", () => {
    const out = addComment({ id: "r1" }, "Alice", "First!", ISO_A);
    const comments = getComments(out);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      author: "Alice",
      body: "First!",
      createdAt: ISO_A,
    });
    expect(comments[0].id).toBeTruthy();
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_A);
  });

  it("rejects empty / whitespace bodies (returns input unchanged)", () => {
    const input: BaseRecord = { id: "r1" };
    expect(addComment(input, "Alice", "   ")).toBe(input);
  });

  it("defaults a blank author to 'You'", () => {
    const out = addComment({ id: "r1" }, "  ", "hello", ISO_A);
    expect(getComments(out)[0].author).toBe("You");
  });

  it("preserves an existing creation time while bumping modified", () => {
    const out = addComment(
      { id: "r1", [RECORD_CREATED_KEY]: ISO_A },
      "Alice",
      "hi",
      ISO_B,
    );
    expect(out[RECORD_CREATED_KEY]).toBe(ISO_A);
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_B);
  });

  it("appends without dropping prior comments", () => {
    const first = addComment({ id: "r1" }, "A", "one", ISO_A);
    const second = addComment(first, "B", "two", ISO_B);
    const comments = getComments(second);
    expect(comments.map((c) => c.body)).toEqual(["one", "two"]);
  });
});

describe("removeComment", () => {
  it("removes a comment by id", () => {
    const withTwo = addComment(addComment({ id: "r1" }, "A", "one", ISO_A), "B", "two", ISO_B);
    const [c1] = getComments(withTwo);
    const out = removeComment(withTwo, c1.id);
    const remaining = getComments(out);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].body).toBe("two");
  });

  it("bumps __modified when a comment is removed (symmetry with addComment)", () => {
    // Record last modified at ISO_A; removing a comment at ISO_B must
    // advance modified_time, mirroring addComment.
    const withOne = addComment({ id: "r1" }, "A", "one", ISO_A);
    const [c1] = getComments(withOne);
    const out = removeComment(withOne, c1.id, ISO_B);
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_B);
    expect(out[RECORD_CREATED_KEY]).toBe(ISO_A);
  });

  it("returns the same reference when nothing matched (no modified bump)", () => {
    const rec = addComment({ id: "r1" }, "A", "one", ISO_A);
    const out = removeComment(rec, "no-such-id", ISO_B);
    expect(out).toBe(rec);
    // A no-op must NOT touch modified_time.
    expect(out[RECORD_MODIFIED_KEY]).toBe(ISO_A);
  });
});

describe("formatTimestamp", () => {
  it("returns empty string for blank / non-string input", () => {
    expect(formatTimestamp("", true)).toBe("");
    expect(formatTimestamp(undefined, true)).toBe("");
    expect(formatTimestamp(null, false)).toBe("");
  });

  it("echoes a non-parseable string rather than 'Invalid Date'", () => {
    expect(formatTimestamp("not-a-date", true)).toBe("not-a-date");
  });

  it("formats a valid ISO date (date-only vs with time)", () => {
    const dateOnly = formatTimestamp(ISO_A, false);
    const withTime = formatTimestamp(ISO_A, true);
    // Locale-dependent exact text, but the time variant must be longer
    // (it includes a clock component the date-only form omits).
    expect(dateOnly).not.toBe("");
    expect(withTime.length).toBeGreaterThan(dateOnly.length);
  });
});
