/**
 * Tests for the Phase 17 PR 4 base-record formula engine. The engine
 * reuses the Phase 16 spreadsheet formula engine by mapping
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
