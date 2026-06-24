/**
 * Tests for the base-record formula engine. The engine
 * reuses the spreadsheet formula engine by mapping
 * Airtable-style `{FieldName}` references onto synthetic single-row
 * cell references. These tests assert the rewrite layer works for
 * every supported field type and that the evaluator returns the
 * right value + display string.
 */
import { describe, it, expect } from "vitest";
import {
  rewriteFieldRefs,
  extractFieldRefs,
  evaluateBaseFormula,
  formatFormulaResult,
  renameFieldInFormula,
} from "../baseFormulaEngine";
import type { BaseField, BaseRecord } from "../baseEditorTypes";

const FIELDS: BaseField[] = [
  { name: "Price", type: "number" },
  { name: "Quantity", type: "number" },
  { name: "Title", type: "text" },
];

describe("rewriteFieldRefs", () => {
  it("replaces {FieldName} with a synthetic A1-style cell reference", () => {
    const out = rewriteFieldRefs("{Price} * {Quantity}", FIELDS);
    expect(out.rewritten).toBe("A1 * B1");
    expect(out.indexByName.get("Price")).toBe(0);
    expect(out.indexByName.get("Quantity")).toBe(1);
  });

  it("uses Z, AA, AB letter sequence for >26 fields", () => {
    const many: BaseField[] = Array.from({ length: 30 }, (_, i) => ({
      name: `F${i}`,
      type: "number",
    }));
    const out = rewriteFieldRefs("{F25} + {F26} + {F27}", many);
    expect(out.rewritten).toBe("Z1 + AA1 + AB1");
  });

  it("leaves unrelated text alone", () => {
    const out = rewriteFieldRefs("SUM({Price}, 10)", FIELDS);
    expect(out.rewritten).toBe("SUM(A1, 10)");
  });
});

describe("extractFieldRefs", () => {
  it("collects every {FieldName} reference in source order, de-duplicated", () => {
    // The helper deduplicates so downstream dirty-tracking only
    // registers each field once even if a formula references the
    // same field multiple times.
    expect(extractFieldRefs("{Price} + {Quantity} - {Price}")).toEqual([
      "Price",
      "Quantity",
    ]);
  });

  it("returns [] when the source has no references", () => {
    expect(extractFieldRefs("1 + 2")).toEqual([]);
  });

  it("ignores braces inside string literals", () => {
    expect(extractFieldRefs('"{NotAField}" + {RealField}')).toEqual([
      "RealField",
    ]);
  });

  it("keeps a brace-pair that begins inside a quoted string but the embedded quote is doubled per RFC-4180", () => {
    // The formula tokenizer uses Excel/RFC-4180 escape semantics:
    // an embedded `"` inside `"…"` is written as `""`. The first
    // `""` is a doubled-quote escape (the literal stays open), so
    // `{Fake}` is still inside the string and `{Real}` outside is
    // the only real reference. The scanner stays aligned with the
    // evaluator on what counts as "inside a literal".
    expect(extractFieldRefs('"open ""{Fake}"" still open" + {Real}')).toEqual([
      "Real",
    ]);
  });

  it("treats a backslash as a literal character (formula engine has no backslash escapes)", () => {
    // `\\"` is *not* an escape for the formula engine — the `"`
    // after the backslash closes the literal. This documents that
    // the scanner intentionally diverges from C-style string
    // semantics and stays in lock-step with the underlying
    // tokenizer (`formulaEngine/tokenizer.ts`).
    expect(extractFieldRefs('"open \\" + {ClosedRef} + "reopen"')).toEqual([
      "ClosedRef",
    ]);
  });
});

describe("renameFieldInFormula", () => {
  // The helper is the single source of truth for `{oldName}` →
  // `{newName}` rewriting. It is shared between `rewriteFieldRefs`,
  // `extractFieldRefs`, and `BaseEditor.renameField` so the rules
  // never drift between scanners. Each test below pins one rule.

  it("replaces every occurrence of the referenced field name", () => {
    expect(renameFieldInFormula("{Price} + {Price}", "Price", "Cost")).toBe(
      "{Cost} + {Cost}",
    );
  });

  it("leaves unrelated references untouched", () => {
    expect(renameFieldInFormula("{Price} + {Quantity}", "Price", "Cost")).toBe(
      "{Cost} + {Quantity}",
    );
  });

  it("never touches a `{oldName}` inside a single-quoted string literal", () => {
    expect(renameFieldInFormula("'{Price}' + {Price}", "Price", "Cost")).toBe(
      "'{Price}' + {Cost}",
    );
  });

  it("never touches a `{oldName}` inside a double-quoted string literal", () => {
    expect(renameFieldInFormula('"{Price}" + {Price}', "Price", "Cost")).toBe(
      '"{Price}" + {Cost}',
    );
  });

  it("handles doubled-quote escapes inside a string literal — the `{Price}` between the doubled quotes stays inside the string", () => {
    // RFC-4180 / Excel doubled-quote escape: `""` inside `"…"` is
    // an embedded `"` and the literal stays open. The first
    // `{Price}` is inside the literal and must be left alone; the
    // second is real code and must be renamed. All three rewrite
    // paths (extract / rewrite / rename) share the same scanner so
    // they cannot disagree.
    const src = '"prefix ""{Price}"" suffix" + {Price}';
    expect(renameFieldInFormula(src, "Price", "Cost")).toBe(
      '"prefix ""{Price}"" suffix" + {Cost}',
    );
  });

  it("leaves an unmatched opening `{` alone (no closer means no reference)", () => {
    expect(renameFieldInFormula("{Price", "Price", "Cost")).toBe("{Price");
  });

  it("is a no-op when the source has no references to oldName", () => {
    expect(renameFieldInFormula("1 + 2", "Price", "Cost")).toBe("1 + 2");
  });

  it("passes undefined / empty source through unchanged", () => {
    expect(renameFieldInFormula(undefined, "Price", "Cost")).toBeUndefined();
    expect(renameFieldInFormula("", "Price", "Cost")).toBe("");
  });
});

describe("evaluateBaseFormula", () => {
  const record: BaseRecord = {
    id: "r1",
    Price: 25,
    Quantity: 4,
    Title: "Widget",
  };

  it("evaluates simple arithmetic over field references", () => {
    const v = evaluateBaseFormula("{Price} * {Quantity}", FIELDS, record);
    expect(formatFormulaResult(v)).toBe("100");
  });

  it("supports formula functions over field references", () => {
    const v = evaluateBaseFormula(
      'CONCATENATE({Title}, " x ", {Quantity})',
      FIELDS,
      record,
    );
    expect(formatFormulaResult(v)).toBe("Widget x 4");
  });

  it("surfaces an engine error when an unknown field is referenced", () => {
    // Unknown fields are preserved verbatim in the rewritten source
    // so the user sees the bad name in error messages rather than a
    // silent zero substitution. The engine then surfaces an error
    // value (which our wrapper catches and re-codes as #ERR!).
    const v = evaluateBaseFormula("{Missing} + 0", FIELDS, record);
    const rendered = formatFormulaResult(v);
    expect(rendered.startsWith("#")).toBe(true);
  });

  it("returns an error value for divide-by-zero", () => {
    const v = evaluateBaseFormula("{Price} / 0", FIELDS, record);
    expect(formatFormulaResult(v)).toBe("#DIV/0!");
  });

  it("handles boolean-returning formulas", () => {
    const v = evaluateBaseFormula(
      "IF({Quantity} > 0, TRUE, FALSE)",
      FIELDS,
      record,
    );
    expect(formatFormulaResult(v)).toBe("TRUE");
  });
});

describe("evaluateBaseFormula — cycle detection", () => {
  it("returns #CIRCULAR! for a direct self-reference (formula field references itself)", () => {
    const fields: BaseField[] = [
      { name: "Self", type: "formula", formula: "{Self} + 1" },
    ];
    const record: BaseRecord = { id: "r1", Self: null };
    // Seeding the visiting set with the current field name is what
    // the FormulaCell does in practice; without the seed a direct
    // self-reference would recurse via getEvaluated.
    const v = evaluateBaseFormula("{Self} + 1", fields, record, "Self");
    expect(formatFormulaResult(v)).toBe("#CIRCULAR!");
  });

  it("returns #CIRCULAR! for mutual references between two formula fields", () => {
    const fields: BaseField[] = [
      { name: "A", type: "formula", formula: "{B} + 1" },
      { name: "B", type: "formula", formula: "{A} + 1" },
    ];
    const record: BaseRecord = { id: "r1", A: null, B: null };
    const v = evaluateBaseFormula("{B} + 1", fields, record, "A");
    expect(formatFormulaResult(v)).toBe("#CIRCULAR!");
  });

  it("does NOT report a cycle for a diamond dependency that re-visits a leaf", () => {
    // A and B both reference Leaf (non-formula). This is not a
    // cycle; the visiting set only tracks formula fields on the
    // current path, so revisiting Leaf via two different parents
    // must still evaluate cleanly.
    const fields: BaseField[] = [
      { name: "Leaf", type: "number" },
      { name: "A", type: "formula", formula: "{Leaf} * 2" },
      { name: "B", type: "formula", formula: "{A} + {Leaf}" },
    ];
    const record: BaseRecord = { id: "r1", Leaf: 5, A: null, B: null };
    const v = evaluateBaseFormula("{A} + {Leaf}", fields, record, "B");
    expect(formatFormulaResult(v)).toBe("15");
  });
});
