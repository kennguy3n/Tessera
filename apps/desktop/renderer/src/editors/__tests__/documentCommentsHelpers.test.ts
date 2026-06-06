/**
 * Unit tests for the DOM-free document-comment helpers.
 *
 * Pins the pure algorithms used by the comments side panel:
 *   - `makeCommentId` is unique even across same-ms calls.
 *   - `normalizeCommentText` trims, rejects empties, and caps length.
 *   - `sortComments` puts open threads before resolved ones and orders
 *     each group oldest-first (stable by id on timestamp ties).
 *   - `countOpenComments` counts only unresolved threads.
 *   - `formatCommentTimestamp` falls back to the raw string on garbage.
 */
import { describe, it, expect } from "vitest";
import {
  MAX_COMMENT_LEN,
  countOpenComments,
  formatCommentTimestamp,
  makeCommentId,
  normalizeCommentText,
  sortComments,
  type DocumentComment,
} from "../documentCommentsHelpers";

function comment(over: Partial<DocumentComment>): DocumentComment {
  return {
    id: "c1",
    author: "Ada",
    createdAt: "2024-01-01T00:00:00.000Z",
    text: "body",
    resolved: false,
    quotedText: "anchored",
    from: 1,
    to: 5,
    ...over,
  };
}

describe("makeCommentId", () => {
  it("returns a unique id on every call, even in a tight loop", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) ids.add(makeCommentId());
    expect(ids.size).toBe(1000);
  });

  it("prefixes ids with `cmt-`", () => {
    expect(makeCommentId().startsWith("cmt-")).toBe(true);
  });
});

describe("normalizeCommentText", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeCommentText("  hi  ")).toBe("hi");
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeCommentText("")).toBeNull();
    expect(normalizeCommentText("   \n\t ")).toBeNull();
  });

  it("caps the body at MAX_COMMENT_LEN", () => {
    const huge = "x".repeat(MAX_COMMENT_LEN + 50);
    expect(normalizeCommentText(huge)?.length).toBe(MAX_COMMENT_LEN);
  });
});

describe("sortComments", () => {
  it("orders open before resolved, then oldest-first", () => {
    const input = [
      comment({ id: "b", createdAt: "2024-03-01T00:00:00.000Z" }),
      comment({ id: "r", resolved: true, createdAt: "2024-01-01T00:00:00.000Z" }),
      comment({ id: "a", createdAt: "2024-02-01T00:00:00.000Z" }),
    ];
    expect(sortComments(input).map((c) => c.id)).toEqual(["a", "b", "r"]);
  });

  it("is stable by id when timestamps tie", () => {
    const ts = "2024-01-01T00:00:00.000Z";
    const input = [
      comment({ id: "z", createdAt: ts }),
      comment({ id: "a", createdAt: ts }),
    ];
    expect(sortComments(input).map((c) => c.id)).toEqual(["a", "z"]);
  });

  it("does not mutate its input", () => {
    const input = [
      comment({ id: "b" }),
      comment({ id: "a" }),
    ];
    const snapshot = input.map((c) => c.id);
    sortComments(input);
    expect(input.map((c) => c.id)).toEqual(snapshot);
  });
});

describe("countOpenComments", () => {
  it("counts only unresolved threads", () => {
    expect(
      countOpenComments([
        comment({ resolved: false }),
        comment({ resolved: true }),
        comment({ resolved: false }),
      ]),
    ).toBe(2);
  });
});

describe("formatCommentTimestamp", () => {
  it("returns an empty string for an empty input", () => {
    expect(formatCommentTimestamp("")).toBe("");
  });

  it("echoes the raw string when it cannot be parsed", () => {
    expect(formatCommentTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("formats a valid ISO timestamp into a non-empty label", () => {
    expect(formatCommentTimestamp("2024-01-01T12:34:00.000Z").length).toBeGreaterThan(
      0,
    );
  });
});
