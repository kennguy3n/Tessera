import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CHARS_PER_TOKEN,
  estimateTokens,
  createEmptyTokenUsage,
  accumulateTokenUsage,
  type ExternalProviderTokenUsage,
} from "../tokenCounter";

describe("tokenCounter — estimateTokens", () => {
  it("returns 0 for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns at least 1 for any non-empty input", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("ab")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("uses the 4-chars-per-token rule for English prose", () => {
    // 16 chars of contiguous prose -> 4 tokens.
    expect(estimateTokens("hello world okay")).toBe(4);
  });

  it(`rounds up via ceil(length / ${CHARS_PER_TOKEN})`, () => {
    // 5 chars / 4 = 1.25 -> ceil -> 2.
    expect(estimateTokens("abcde")).toBe(2);
    // 9 chars / 4 = 2.25 -> ceil -> 3.
    expect(estimateTokens("aaaaaaaaa")).toBe(3);
  });

  it("collapses runs of whitespace before applying the divisor", () => {
    // Without whitespace collapse, this would be 12 chars / 4 = 3
    // tokens. With collapse to "ab cd ef" (8 chars) -> 2 tokens.
    expect(estimateTokens("ab    cd    ef")).toBe(2);
  });

  it("trims surrounding whitespace before applying the divisor", () => {
    // Leading/trailing whitespace shouldn't inflate the count.
    // "   hello   " -> "hello" -> 5 chars -> 2 tokens.
    expect(estimateTokens("   hello   ")).toBe(2);
  });

  it("returns 1 for input that is purely whitespace", () => {
    expect(estimateTokens("   ")).toBe(1);
    expect(estimateTokens("\n\n\n")).toBe(1);
    expect(estimateTokens(" \t\n ")).toBe(1);
  });

  it("handles a 4kb prompt without underflow", () => {
    const big = "x".repeat(4096);
    // 4096 / 4 = 1024.
    expect(estimateTokens(big)).toBe(1024);
  });

  it("handles Unicode characters as individual chars (heuristic underestimate is acknowledged)", () => {
    // Each emoji is one JS char-pair (length 2). The heuristic
    // doesn't try to recognise grapheme clusters; this test pins
    // the documented behaviour. "🚀🚀" -> length 4 -> 1 token.
    expect(estimateTokens("🚀🚀")).toBe(1);
  });
});

describe("tokenCounter — createEmptyTokenUsage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-23T14:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns zeroed counters and a current ISO timestamp", () => {
    const u = createEmptyTokenUsage();
    expect(u.totalPromptTokens).toBe(0);
    expect(u.totalCompletionTokens).toBe(0);
    expect(u.lastResetDate).toBe("2026-05-23T14:00:00.000Z");
  });

  it("does not return a frozen object (caller must spread defensively if needed)", () => {
    const u = createEmptyTokenUsage();
    expect(Object.isFrozen(u)).toBe(false);
  });
});

describe("tokenCounter — accumulateTokenUsage", () => {
  function make(
    p: number,
    c: number,
    iso = "2026-01-01T00:00:00.000Z",
  ): ExternalProviderTokenUsage {
    return {
      totalPromptTokens: p,
      totalCompletionTokens: c,
      lastResetDate: iso,
    };
  }

  it("adds the delta to both counters", () => {
    const prev = make(100, 200);
    const next = accumulateTokenUsage(prev, {
      promptTokens: 50,
      completionTokens: 75,
    });
    expect(next).toEqual({
      totalPromptTokens: 150,
      totalCompletionTokens: 275,
      lastResetDate: "2026-01-01T00:00:00.000Z",
    });
  });

  it("preserves the existing lastResetDate", () => {
    const prev = make(0, 0, "2025-12-31T23:59:59.999Z");
    const next = accumulateTokenUsage(prev, {
      promptTokens: 10,
      completionTokens: 20,
    });
    expect(next.lastResetDate).toBe("2025-12-31T23:59:59.999Z");
  });

  it("does not mutate the input record", () => {
    const prev = make(100, 200);
    const snapshot = { ...prev };
    accumulateTokenUsage(prev, { promptTokens: 1, completionTokens: 2 });
    expect(prev).toEqual(snapshot);
  });

  it("handles zero deltas as a no-op (return value still equals previous)", () => {
    const prev = make(42, 84);
    const next = accumulateTokenUsage(prev, {
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(next).toEqual(prev);
  });
});
