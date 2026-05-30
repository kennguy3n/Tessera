/**
 * Phase 15 Task 24 — unit tests for the line-level LCS diff used by
 * `VersionHistory`'s Compare view. Tests cover:
 *
 *   1. identity (same content → no add/remove rows)
 *   2. pure add / pure remove
 *   3. interleaved add/remove (the canonical LCS case)
 *   4. CRLF vs LF normalisation (Windows ↔ Linux files compare equal)
 *   5. empty input (one side empty)
 *   6. pathological-input bypass (cap honoured, summary still correct)
 *   7. summary counts match the entries array
 */

import { describe, it, expect } from "vitest";
import { diffLines, splitLines } from "../lineDiff";

describe("diffLines", () => {
  it("returns all `equal` ops when before === after", () => {
    const text = "alpha\nbeta\ngamma";
    const { entries, summary } = diffLines(text, text);
    expect(summary).toEqual({ added: 0, removed: 0, unchanged: 3 });
    expect(entries.every((e) => e.op === "equal")).toBe(true);
    expect(entries.map((e) => e.text)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("classifies pure additions", () => {
    const before = "alpha";
    const after = "alpha\nbeta\ngamma";
    const { entries, summary } = diffLines(before, after);
    expect(summary).toEqual({ added: 2, removed: 0, unchanged: 1 });
    expect(entries[0]).toMatchObject({ op: "equal", text: "alpha" });
    expect(entries[1]).toMatchObject({ op: "add", text: "beta" });
    expect(entries[2]).toMatchObject({ op: "add", text: "gamma" });
  });

  it("classifies pure removals", () => {
    const before = "alpha\nbeta\ngamma";
    const after = "alpha";
    const { entries, summary } = diffLines(before, after);
    expect(summary).toEqual({ added: 0, removed: 2, unchanged: 1 });
    expect(entries.filter((e) => e.op === "remove").map((e) => e.text)).toEqual(
      ["beta", "gamma"],
    );
  });

  it("interleaves adds and removes in document order via LCS", () => {
    // Classical Hunt-McIlroy example. LCS of "ABCABBA" / "CBABAC" is
    // "CABA" of length 4 (one of several optimal LCSes); we don't
    // pin the exact path but require:
    //   - summary.unchanged === 4
    //   - summary.added === a.length - 4 === 3
    //   - summary.removed === b.length - 4 === 2
    const a = ["A", "B", "C", "A", "B", "B", "A"].join("\n");
    const b = ["C", "B", "A", "B", "A", "C"].join("\n");
    const { summary } = diffLines(a, b);
    expect(summary.unchanged).toBe(4);
    expect(summary.added).toBe(6 - 4);
    expect(summary.removed).toBe(7 - 4);
  });

  it("normalises CRLF / LF so cross-platform diffs compare equal", () => {
    const linux = "line1\nline2\nline3";
    const windows = "line1\r\nline2\r\nline3";
    const { summary } = diffLines(linux, windows);
    expect(summary).toEqual({ added: 0, removed: 0, unchanged: 3 });
  });

  it("handles empty input on either side", () => {
    const emptyToContent = diffLines("", "alpha");
    // splitLines("") -> [""], so an empty doc has one (blank) line.
    // Diff against "alpha" should show 1 equal-blank or 1 remove + 1 add;
    // either is acceptable as long as the summary is consistent with
    // the entries.
    expect(emptyToContent.summary.unchanged + emptyToContent.summary.removed)
      .toBe(1);
    expect(emptyToContent.summary.added + emptyToContent.summary.unchanged)
      .toBe(1);

    const contentToEmpty = diffLines("alpha", "");
    expect(contentToEmpty.summary.removed + contentToEmpty.summary.unchanged)
      .toBe(1);
  });

  it("falls back to a single replace block past the line cap", () => {
    // Build inputs just over the cap. We don't import MAX_LINES;
    // 60K lines is comfortably over the 50K guard documented in the
    // source. Build via repeat to avoid timing out from the actual
    // DP table allocation (the bypass should keep this snappy).
    const cap = 60_000;
    const a = Array.from({ length: cap }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: cap }, (_, i) => `b${i}`).join("\n");
    const { entries, summary } = diffLines(a, b);
    expect(summary.unchanged).toBe(0);
    expect(summary.added).toBe(cap);
    expect(summary.removed).toBe(cap);
    // First entry should be a remove (we emit removes before adds in
    // the bypass path).
    expect(entries[0].op).toBe("remove");
  });

  it("entries length equals added + removed + unchanged", () => {
    const a = "one\ntwo\nthree\nfour";
    const b = "one\ntwo\nfour\nfive";
    const { entries, summary } = diffLines(a, b);
    expect(entries.length).toBe(
      summary.added + summary.removed + summary.unchanged,
    );
  });
});

describe("splitLines", () => {
  it("normalises CR-only to LF-only", () => {
    expect(splitLines("a\rb\rc")).toEqual(["a", "b", "c"]);
  });

  it("normalises CRLF to LF", () => {
    expect(splitLines("a\r\nb\r\nc")).toEqual(["a", "b", "c"]);
  });

  it("emits a single blank row for empty input", () => {
    expect(splitLines("")).toEqual([""]);
  });

  it("preserves trailing newline as a final empty row", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b", ""]);
  });
});
