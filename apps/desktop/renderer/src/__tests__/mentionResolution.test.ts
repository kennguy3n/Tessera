/**
 * Unit tests for the KChat @mention pure helpers (Session 8 Task 2):
 * trigger detection (`matchMentionQuery`), canonical text rendering
 * (`mentionToText`), and share-time resolution
 * (`resolveMentionsInHtml`).
 */
import { describe, it, expect } from "vitest";
import {
  matchMentionQuery,
  mentionToText,
  resolveMentionsInHtml,
  MENTION_DATA_TYPE,
} from "../editors/extensions/mentionResolution";

describe("mentionToText", () => {
  it("renders a single leading @", () => {
    expect(mentionToText("alice")).toBe("@alice");
  });

  it("does not duplicate an existing leading @", () => {
    expect(mentionToText("@bob")).toBe("@bob");
    expect(mentionToText("@@carol")).toBe("@carol");
  });

  it("trims surrounding whitespace", () => {
    expect(mentionToText("  dave  ")).toBe("@dave");
  });
});

describe("matchMentionQuery", () => {
  it("matches @ at the start of a block", () => {
    expect(matchMentionQuery("@al")).toEqual({ query: "al", atOffset: 0 });
  });

  it("matches @ preceded by whitespace", () => {
    expect(matchMentionQuery("hey @bo")).toEqual({ query: "bo", atOffset: 4 });
  });

  it("matches the empty query right after @", () => {
    expect(matchMentionQuery("ping @")).toEqual({ query: "", atOffset: 5 });
  });

  it("does NOT trigger on an email-like @ (no preceding boundary)", () => {
    expect(matchMentionQuery("email@domain")).toBeNull();
  });

  it("does NOT trigger once whitespace follows the @ run", () => {
    expect(matchMentionQuery("@alice ")).toBeNull();
    expect(matchMentionQuery("@alice and")).toBeNull();
  });

  it("uses the last @ when several appear", () => {
    expect(matchMentionQuery("@a @b")).toEqual({ query: "b", atOffset: 3 });
  });

  it("returns null when there is no @", () => {
    expect(matchMentionQuery("plain text")).toBeNull();
  });

  it("guards against an absurdly long token", () => {
    expect(matchMentionQuery(`@${"x".repeat(61)}`)).toBeNull();
  });

  it("returns null for non-string input", () => {
    // @ts-expect-error exercising the runtime guard
    expect(matchMentionQuery(undefined)).toBeNull();
  });
});

describe("resolveMentionsInHtml", () => {
  it("replaces a mention span with @username from data-label", () => {
    const html = `<p>hi <span data-type="${MENTION_DATA_TYPE}" data-id="u1" data-label="alice">@alice</span>!</p>`;
    expect(resolveMentionsInHtml(html)).toBe("<p>hi @alice!</p>");
  });

  it("is tolerant of attribute ordering", () => {
    const html = `<span data-id="u2" class="x" data-label="bob" data-type="${MENTION_DATA_TYPE}">@bob</span>`;
    expect(resolveMentionsInHtml(html)).toBe("@bob");
  });

  it("falls back to inner text when data-label is absent", () => {
    const html = `<span data-type="${MENTION_DATA_TYPE}" data-id="u3">@carol</span>`;
    expect(resolveMentionsInHtml(html)).toBe("@carol");
  });

  it("falls back to data-id when neither label nor inner text exist", () => {
    const html = `<span data-type="${MENTION_DATA_TYPE}" data-id="u4"></span>`;
    expect(resolveMentionsInHtml(html)).toBe("@u4");
  });

  it("resolves multiple mentions in one document", () => {
    const html = `<span data-type="${MENTION_DATA_TYPE}" data-label="a">@a</span> and <span data-type="${MENTION_DATA_TYPE}" data-label="b">@b</span>`;
    expect(resolveMentionsInHtml(html)).toBe("@a and @b");
  });

  it("leaves non-mention spans untouched", () => {
    const html = `<span class="hl">plain</span>`;
    expect(resolveMentionsInHtml(html)).toBe(html);
  });

  it("returns the input unchanged for empty / non-string values", () => {
    expect(resolveMentionsInHtml("")).toBe("");
    // @ts-expect-error exercising the runtime guard
    expect(resolveMentionsInHtml(null)).toBe(null);
  });
});
