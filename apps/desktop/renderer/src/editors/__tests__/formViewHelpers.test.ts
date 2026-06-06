/**
 * Unit tests for the Base form-view value helpers.
 *
 * Pins the coercion that turns raw form inputs into the typed record
 * prefill handed to `onAddRecordWith`:
 *   - computed/auto fields are excluded from the form entirely
 *   - numeric fields coerce to `number | null` (blank ⇒ null)
 *   - checkbox ⇒ boolean, array types ⇒ `string[]`
 *   - `formHasInput` recognises a pristine vs. dirty form
 */
import { describe, it, expect } from "vitest";
import type { BaseField } from "../baseEditorTypes";
import {
  buildRecordPrefill,
  coerceFormValue,
  fillableFields,
  formHasInput,
  initialFormValues,
  isFormEditableField,
} from "../baseviews/formViewHelpers";

const FIELDS: BaseField[] = [
  { name: "Title", type: "text" },
  { name: "Count", type: "number" },
  { name: "Done", type: "checkbox" },
  { name: "Tags", type: "multi_select", options: ["a", "b"] },
  { name: "Auto", type: "auto_number" },
  { name: "Calc", type: "formula", formula: "{Count} * 2" },
];

describe("isFormEditableField / fillableFields", () => {
  it("excludes computed and auto fields", () => {
    expect(isFormEditableField({ name: "x", type: "formula" })).toBe(false);
    expect(isFormEditableField({ name: "x", type: "rollup" })).toBe(false);
    expect(isFormEditableField({ name: "x", type: "lookup" })).toBe(false);
    expect(isFormEditableField({ name: "x", type: "auto_number" })).toBe(false);
    expect(isFormEditableField({ name: "x", type: "text" })).toBe(true);
  });

  it("fillableFields drops the non-editable ones in order", () => {
    expect(fillableFields(FIELDS).map((f) => f.name)).toEqual([
      "Title",
      "Count",
      "Done",
      "Tags",
    ]);
  });
});

describe("initialFormValues", () => {
  it("seeds blank inputs only for fillable fields", () => {
    expect(initialFormValues(FIELDS)).toEqual({
      Title: "",
      Count: "",
      Done: false,
      Tags: [],
    });
  });
});

describe("coerceFormValue", () => {
  it("parses numeric fields to number | null", () => {
    const f: BaseField = { name: "n", type: "number" };
    expect(coerceFormValue(f, "42")).toBe(42);
    expect(coerceFormValue(f, "")).toBeNull();
    expect(coerceFormValue(f, "  ")).toBeNull();
    expect(coerceFormValue(f, "abc")).toBeNull();
  });

  it("coerces checkbox to boolean", () => {
    const f: BaseField = { name: "c", type: "checkbox" };
    expect(coerceFormValue(f, true)).toBe(true);
    expect(coerceFormValue(f, false)).toBe(false);
  });

  it("keeps array values and splits comma strings for array types", () => {
    const f: BaseField = { name: "t", type: "multi_select" };
    expect(coerceFormValue(f, ["a", "b"])).toEqual(["a", "b"]);
    expect(coerceFormValue(f, "a, b , ,c")).toEqual(["a", "b", "c"]);
  });

  it("stringifies everything else", () => {
    const f: BaseField = { name: "t", type: "text" };
    expect(coerceFormValue(f, "hi")).toBe("hi");
    expect(coerceFormValue(f, undefined)).toBe("");
  });
});

describe("buildRecordPrefill", () => {
  it("includes only fillable fields, coerced to typed values", () => {
    const prefill = buildRecordPrefill(FIELDS, {
      Title: "Hello",
      Count: "7",
      Done: true,
      Tags: ["a"],
      // values for non-fillable fields are ignored even if present
      Auto: "999",
      Calc: "123",
    });
    expect(prefill).toEqual({
      Title: "Hello",
      Count: 7,
      Done: true,
      Tags: ["a"],
    });
    expect(prefill).not.toHaveProperty("Auto");
    expect(prefill).not.toHaveProperty("Calc");
  });
});

describe("formHasInput", () => {
  it("is false on a pristine form", () => {
    expect(formHasInput(FIELDS, initialFormValues(FIELDS))).toBe(false);
  });

  it("is true once any field has a value", () => {
    expect(
      formHasInput(FIELDS, { ...initialFormValues(FIELDS), Title: "x" }),
    ).toBe(true);
    expect(
      formHasInput(FIELDS, { ...initialFormValues(FIELDS), Done: true }),
    ).toBe(true);
    expect(
      formHasInput(FIELDS, { ...initialFormValues(FIELDS), Tags: ["a"] }),
    ).toBe(true);
  });
});
