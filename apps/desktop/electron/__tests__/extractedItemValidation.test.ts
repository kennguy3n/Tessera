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
