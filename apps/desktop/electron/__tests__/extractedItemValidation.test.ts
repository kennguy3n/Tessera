/**
 * Tests for the extractTasksDecisions IPC validator.
 *
 * The validator runs at the IPC boundary so a misbehaving Rust bridge
 * never ships shape-violating data into the renderer. The behaviours
 * covered here:
 *
 *   1. Non-array input → throw immediately.
 *   2. All-valid input → return all items, no warn, no throw.
 *   3. Mixed valid + invalid → return valid items, log a summary, do
 *      NOT throw. (Per-item confidence/text outliers are tolerated.)
 *   4. All-invalid input against non-empty payload → throw with the
 *      drop reasons in the message, so the renderer's existing
 *      IPC-error path surfaces "Bridge schema mismatch …" in the UI
 *      instead of silently rendering an empty result.
 *   5. Empty input → return empty array, no warn, no throw.
 *   6. Each invalid-field branch (bad itemType, missing text, missing
 *      sourceCitation, bad confidence, non-object items, infinite
 *      confidence) is exercised so a future refactor can't silently
 *      drop a validator branch.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  validateExtractedItems,
  type ExtractedItem,
} from "../extractedItemValidation";

const VALID: ExtractedItem = {
  itemType: "task",
  text: "Send the design doc to legal",
  sourceCitation: "meeting-notes-2026-05-19#para-12",
  confidence: 0.87,
};

function opts(warn = vi.fn()) {
  return { context: "source-abc123", warn };
}

describe("validateExtractedItems", () => {
  it("returns all items when every payload item is valid", () => {
    const warn = vi.fn();
    const out = validateExtractedItems(
      [
        VALID,
        { ...VALID, itemType: "decision", confidence: 0.4 },
      ],
      opts(warn),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(VALID);
    expect(out[1].itemType).toBe("decision");
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns [] for an empty input without warning or throwing", () => {
    const warn = vi.fn();
    const out = validateExtractedItems([], opts(warn));
    expect(out).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("throws when the bridge returns a non-array payload", () => {
    expect(() =>
      validateExtractedItems({ items: [VALID] }, opts()),
    ).toThrowError(/non-array payload/);
    expect(() => validateExtractedItems(null, opts())).toThrowError(
      /non-array payload/,
    );
    expect(() => validateExtractedItems("oops", opts())).toThrowError(
      /non-array payload/,
    );
  });

  it("drops mixed invalid items but returns valid ones, logging once", () => {
    const warn = vi.fn();
    const out = validateExtractedItems(
      [
        VALID,
        { ...VALID, itemType: "TASK" }, // bad enum value
        { ...VALID, confidence: "0.9" as unknown as number }, // bad type
        { ...VALID, text: 42 as unknown as string }, // bad type
        { ...VALID, itemType: "decision" }, // valid
      ],
      opts(warn),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(VALID);
    expect(out[1].itemType).toBe("decision");
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("dropped 3/5");
    expect(msg).toContain("source-abc123");
    expect(msg).toContain("itemType=\"TASK\"");
    expect(msg).toContain("bad-confidence=\"0.9\"");
  });

  it("throws when 100% of items fail validation against non-empty input", () => {
    // A silent empty-result IPC reply reads to the user as "the model
    // found nothing", so a wholesale schema break must escalate to an
    // error rather than collapsing into a zero-item success.
    const warn = vi.fn();
    expect(() =>
      validateExtractedItems(
        [
          { item_type: "task", text: "x", sourceCitation: "s", confidence: 1 }, // snake_case rename
          { item_type: "task", text: "y", sourceCitation: "s", confidence: 1 },
          { item_type: "task", text: "z", sourceCitation: "s", confidence: 1 },
        ],
        opts(warn),
      ),
    ).toThrowError(/all 3 item\(s\) failed validation/);
    // Even when we throw we MUST log first, so an operator inspecting
    // the main-process console gets the same diagnostic as the user
    // sees in the UI.
    expect(warn).toHaveBeenCalledTimes(1);
    const errMsg = (() => {
      try {
        validateExtractedItems(
          [{ item_type: "task", text: "x", sourceCitation: "s", confidence: 1 }],
          opts(),
        );
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(errMsg).toContain("bridge schema mismatch");
    expect(errMsg).toContain("Rust bridge contract");
  });

  it("does NOT throw on partial drop (tolerates per-item outliers)", () => {
    const warn = vi.fn();
    // 2/3 invalid is not 100%, so we keep the valid one and log.
    const out = validateExtractedItems(
      [
        { ...VALID, confidence: NaN },
        VALID,
        { ...VALID, sourceCitation: undefined as unknown as string },
      ],
      opts(warn),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(VALID);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects each invalid-field branch explicitly", () => {
    // One bad item per branch to lock down the contract.
    const cases: Array<{ name: string; bad: unknown }> = [
      { name: "non-object", bad: 42 },
      { name: "null item", bad: null },
      { name: "missing itemType", bad: { ...VALID, itemType: undefined } },
      { name: "bad itemType", bad: { ...VALID, itemType: "note" } },
      { name: "missing text", bad: { ...VALID, text: undefined } },
      { name: "bad text type", bad: { ...VALID, text: 0 } },
      {
        name: "missing sourceCitation",
        bad: { ...VALID, sourceCitation: undefined },
      },
      {
        name: "bad sourceCitation type",
        bad: { ...VALID, sourceCitation: ["a"] },
      },
      { name: "missing confidence", bad: { ...VALID, confidence: undefined } },
      { name: "bad confidence type", bad: { ...VALID, confidence: "0.5" } },
      { name: "NaN confidence", bad: { ...VALID, confidence: NaN } },
      {
        name: "Infinity confidence",
        bad: { ...VALID, confidence: Number.POSITIVE_INFINITY },
      },
    ];
    for (const c of cases) {
      // Pair the bad case with at least one valid item so we exercise
      // the partial-drop path (not the throw-on-100%-drop path).
      const warn = vi.fn();
      const out = validateExtractedItems([VALID, c.bad], opts(warn));
      expect(out, c.name).toHaveLength(1);
      expect(out[0], c.name).toEqual(VALID);
      expect(warn, c.name).toHaveBeenCalledTimes(1);
    }
  });

  it("truncates the drop-reasons summary when there are many", () => {
    const warn = vi.fn();
    const bads = Array.from({ length: 8 }, (_, i) => ({
      ...VALID,
      itemType: `bad${i}`,
    }));
    expect(() =>
      validateExtractedItems(bads, opts(warn)),
    ).toThrowError(/all 8 item\(s\) failed/);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain("dropped 8/8");
    // Logger summary head shows the first 5 reasons; tail says "...".
    expect(msg).toContain("...");
  });
});

// =====================================================================
// / Task 16 — XSS / prompt-injection handling
// =====================================================================
//
// `extractedItem.text` and `extractedItem.sourceCitation` are
// derived from LLM-extracted content, which is a known
// prompt-injection attack surface: malicious source data can
// instruct the model to embed `<script>` / `<img onerror=>` /
// `javascript:` payloads in the extracted fields.
//
// The validator returns the raw extracted strings unchanged —
// pre-escaping at the validation seam would double-escape in every
// current renderer (which uses JSX text expressions, auto-escaped
// by React). See the doc block at the top of
// `extractedItemValidation.ts` for the full rationale. These tests
// pin two invariants:
//   (a) the validator passes strings through untouched, even for
//       known XSS payloads;
//   (b) when those payloads are rendered via the actual JSX text
//       expression used in `SourceDetailPage.tsx`, no executable
//       HTML materialises (no `<script>` / `<img>` / `<iframe>`
//       elements in the rendered DOM).
describe("validateExtractedItems — XSS pass-through + render-time safety", () => {
  it("passes <script> tags through unchanged (renderer auto-escapes)", () => {
    const payload = "<script>alert(1)</script>";
    const out = validateExtractedItems(
      [{ ...VALID, text: payload }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(payload);
  });

  it("passes <img onerror=...> through unchanged", () => {
    const payload = '<img src=x onerror="alert(\'pwn\')">';
    const out = validateExtractedItems(
      [{ ...VALID, text: payload }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(payload);
  });

  it("passes javascript: URI payloads through unchanged", () => {
    const payload = '<a href="javascript:alert(1)">click</a>';
    const out = validateExtractedItems(
      [{ ...VALID, text: payload }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(payload);
  });

  it("passes data: URI payloads through unchanged in sourceCitation", () => {
    const payload = '<iframe src="data:text/html,<script>1</script>">';
    const out = validateExtractedItems(
      [{ ...VALID, sourceCitation: payload }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].sourceCitation).toBe(payload);
  });

  it("does NOT escape ampersands / apostrophes (avoids double-escape in React JSX text)", () => {
    // The previous implementation pre-escaped these characters at
    // the validation seam, which caused visible double-escape
    // artifacts in the renderer (`AT&T memo` → displayed as
    // `AT&amp;T memo`). Pin the corrected pass-through behaviour
    // so a future regression to the pre-escape design fails CI.
    const out = validateExtractedItems(
      [
        {
          ...VALID,
          text: "Tom & Jerry & friends",
          sourceCitation: "AT&T memo, Johnson & Johnson Q4'25",
        },
      ],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Tom & Jerry & friends");
    expect(out[0].sourceCitation).toBe(
      "AT&T memo, Johnson & Johnson Q4'25",
    );
  });

  it("preserves plain (non-HTML) text unchanged (Unicode / emoji / RTL)", () => {
    const text = "Plain ASCII text 🎉 with emoji and عربي RTL";
    const sourceCitation = "Section 3.2 — para 4";
    const out = validateExtractedItems(
      [{ ...VALID, text, sourceCitation }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(text);
    expect(out[0].sourceCitation).toBe(sourceCitation);
  });

  it("logs warnings with the original (unmangled) payload", () => {
    // Drop-reason logging reflects the original input so an
    // operator debugging "why is this item dropping?" sees the
    // un-mangled value.
    const warn = vi.fn();
    validateExtractedItems(
      [
        { ...VALID, itemType: "<script>" }, // bad enum
        VALID,
      ],
      opts(warn),
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0] as string;
    expect(msg).toContain('itemType="<script>"');
  });

  it("renders XSS payloads as inert text via React JSX (render-site auto-escape)", () => {
    // Mirror the SourceDetailPage render path exactly: render the
    // validated item's `text` and `sourceCitation` as JSX text
    // expressions. This pins the actual XSS defense (React's
    // auto-escape) without depending on `dangerouslySetInnerHTML`
    // or any other code that bypasses the safe text path.
    const payloads = [
      "<script>alert(1)</script>",
      '<img src=x onerror="alert(\'pwn\')">',
      '<iframe src="data:text/html,<script>1</script>">',
      '<a href="javascript:alert(1)">click</a>',
      "<svg onload=alert(1)>",
    ];
    for (const payload of payloads) {
      const out = validateExtractedItems(
        [{ ...VALID, text: payload, sourceCitation: payload }],
        opts(),
      );
      const html = renderToStaticMarkup(
        React.createElement(
          "li",
          null,
          out[0].text,
          " (",
          out[0].sourceCitation,
          ")",
        ),
      );
      // No executable element materialises in the rendered DOM —
      // every angle bracket is escaped to its entity form by React.
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<img[\s>]/i);
      expect(html).not.toMatch(/<iframe/i);
      expect(html).not.toMatch(/<svg/i);
      // And the inner `<a href=javascript:...>` cannot escape its
      // JSX text context either.
      expect(html).not.toMatch(/<a\s/i);
      // The escape entities ARE present, proving React did the
      // escaping (so the contract relies on a verifiable mechanism,
      // not just absence of evidence).
      expect(html).toMatch(/&lt;/);
    }
  });
});
