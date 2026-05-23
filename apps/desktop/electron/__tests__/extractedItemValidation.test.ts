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

import {
  escapeExtractedHtml,
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
// Phase 10 / Task 16 — XSS hardening at the validation seam
// =====================================================================
//
// `extractedItem.text` and `extractedItem.sourceCitation` are
// derived from LLM-extracted content, which is a known
// prompt-injection attack surface: malicious source data can
// instruct the model to embed `<script>` / `<img onerror=>` /
// `javascript:` payloads in the extracted fields. The renderer
// historically rendered these fields as React text (which React
// escapes), but the validation seam should NOT depend on the
// renderer's choice of render path. Pin the contract that every
// item returned from `validateExtractedItems` has HTML-safe
// `text` and `sourceCitation` regardless of what the renderer
// does with them.
describe("validateExtractedItems — XSS hardening (Phase 10 / Task 16)", () => {
  it("escapes <script> tags in the text field", () => {
    const out = validateExtractedItems(
      [
        {
          ...VALID,
          text: "<script>alert(1)</script>",
        },
      ],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    // No raw `<` survives — pin the security property structurally,
    // not just via the literal string match.
    expect(out[0].text).not.toMatch(/[<>]/);
  });

  it("escapes <img onerror=...> in the text field", () => {
    const out = validateExtractedItems(
      [
        {
          ...VALID,
          text: '<img src=x onerror="alert(\'pwn\')">',
        },
      ],
      opts(),
    );
    expect(out).toHaveLength(1);
    // Both the `<` / `>` and the embedded `"` / `'` are escaped,
    // because the field could land inside an HTML attribute via
    // a future renderer feature (e.g. tooltip / aria-label).
    expect(out[0].text).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;pwn&#39;)&quot;&gt;",
    );
    expect(out[0].text).not.toMatch(/[<>"']/);
  });

  it("escapes javascript: URI payloads in the text field", () => {
    // A `javascript:` URI is only dangerous when piped into an
    // `href` / `src` attribute, but we still escape the
    // surrounding HTML structure so an embedded
    // `<a href="javascript:...">` is rendered as inert text.
    const out = validateExtractedItems(
      [
        {
          ...VALID,
          text: '<a href="javascript:alert(1)">click</a>',
        },
      ],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(
      "&lt;a href=&quot;javascript:alert(1)&quot;&gt;click&lt;/a&gt;",
    );
    expect(out[0].text).not.toMatch(/<a /);
  });

  it("escapes data: URI payloads in the sourceCitation field", () => {
    // A `data:text/html;base64,...` URI in an iframe src is a
    // well-known XSS vector. Same defense as the javascript: case:
    // escape the HTML structure around it so the URI cannot reach
    // an actual `src` attribute on the renderer side.
    const out = validateExtractedItems(
      [
        {
          ...VALID,
          sourceCitation: '<iframe src="data:text/html,<script>1</script>">',
        },
      ],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].sourceCitation).toBe(
      "&lt;iframe src=&quot;data:text/html,&lt;script&gt;1&lt;/script&gt;&quot;&gt;",
    );
  });

  it("double-escapes pre-escaped HTML entities (input is treated as plain text)", () => {
    // Contract: the validation seam treats inputs as untrusted
    // plain text. A pre-existing `&amp;` in the input becomes
    // `&amp;amp;` on the way out — this is the SAFE behaviour
    // (idempotent under repeated escape). If we tried to be
    // "smart" and detect already-escaped content, an attacker
    // could craft an input that looks pre-escaped but bypasses
    // re-escaping (e.g. `&lt;script&gt;alert(1)&lt;/script&gt;`
    // would not be re-escaped, and a future renderer change to
    // `dangerouslySetInnerHTML` would then execute it).
    const out = validateExtractedItems(
      [{ ...VALID, text: "Tom & Jerry", sourceCitation: "AT&T memo" }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("Tom &amp; Jerry");
    expect(out[0].sourceCitation).toBe("AT&amp;T memo");

    // Now feed the previous output back in — pin that we double-escape.
    const second = validateExtractedItems(
      [
        {
          ...VALID,
          text: out[0].text,
          sourceCitation: out[0].sourceCitation,
        },
      ],
      opts(),
    );
    expect(second[0].text).toBe("Tom &amp;amp; Jerry");
    expect(second[0].sourceCitation).toBe("AT&amp;amp;T memo");
  });

  it("preserves plain (non-HTML) text unchanged", () => {
    // The happy path: ordinary text with no HTML metacharacters
    // is returned verbatim. Pins that we don't accidentally
    // mangle Unicode, emoji, RTL text, etc.
    const out = validateExtractedItems(
      [
        {
          ...VALID,
          text: "Plain ASCII text 🎉 with emoji and عربي RTL",
          sourceCitation: "Section 3.2 — para 4",
        },
      ],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(
      "Plain ASCII text 🎉 with emoji and عربي RTL",
    );
    expect(out[0].sourceCitation).toBe("Section 3.2 — para 4");
  });

  it("escapes the apostrophe so attribute-injection via <a title='..'> is blocked", () => {
    // Apostrophe escaping defends against `<a title='...'>`-style
    // attribute contexts where a stray `'` would close the
    // attribute and inject new attributes / handlers.
    const out = validateExtractedItems(
      [{ ...VALID, text: "It's a 'test' with quotes" }],
      opts(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe(
      "It&#39;s a &#39;test&#39; with quotes",
    );
    expect(out[0].text).not.toMatch(/'/);
  });

  it("logs warnings BEFORE escaping (so the operator sees the original payload)", () => {
    // Drop-reason logging must reflect the original input so an
    // operator debugging "why is this item dropping?" sees the
    // un-escaped value. The escape only applies to the surviving
    // items in the return path.
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
});

describe("escapeExtractedHtml — unit", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeExtractedHtml("&<>\"'")).toBe(
      "&amp;&lt;&gt;&quot;&#39;",
    );
  });

  it("processes & before < / > / \" / ' so emitted entities are not re-escaped", () => {
    // If `&` were replaced LAST, an input like `<` would first
    // become `&lt;`, then `&` would be replaced producing
    // `&amp;lt;`. Pin the correct ordering structurally — feed
    // an input whose escaped form would diverge under wrong
    // ordering.
    expect(escapeExtractedHtml("<")).toBe("&lt;");
    expect(escapeExtractedHtml("&lt;")).toBe("&amp;lt;");
  });

  it("returns the empty string unchanged", () => {
    expect(escapeExtractedHtml("")).toBe("");
  });

  it("is pure (no mutation of input string semantics)", () => {
    const original = "<b>hi</b>";
    const escaped = escapeExtractedHtml(original);
    expect(original).toBe("<b>hi</b>");
    expect(escaped).toBe("&lt;b&gt;hi&lt;/b&gt;");
  });
});
