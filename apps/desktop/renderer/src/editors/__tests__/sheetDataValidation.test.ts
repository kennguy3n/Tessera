import { describe, expect, it } from "vitest";

import {
  CHECKBOX_FALSE,
  CHECKBOX_TRUE,
  getColumnValidation,
  isValueAllowed,
  parseListValues,
  setColumnValidation,
} from "../sheetDataValidation";
import type { DataValidation, ValidationMap } from "../sheetEditorTypes";

describe("getColumnValidation", () => {
  it("reads a column's validation, or undefined", () => {
    const map: ValidationMap = { "1": { kind: "checkbox" } };
    expect(getColumnValidation(map, 1)).toEqual({ kind: "checkbox" });
    expect(getColumnValidation(map, 0)).toBeUndefined();
    expect(getColumnValidation(undefined, 1)).toBeUndefined();
  });
});

describe("setColumnValidation", () => {
  it("adds a validation immutably", () => {
    const map: ValidationMap = { "0": { kind: "checkbox" } };
    const next = setColumnValidation(map, 1, {
      kind: "list",
      values: ["a", "b"],
    });
    expect(next).toEqual({
      "0": { kind: "checkbox" },
      "1": { kind: "list", values: ["a", "b"] },
    });
    // original untouched
    expect(map).toEqual({ "0": { kind: "checkbox" } });
  });

  it("clears a validation and returns undefined when the map empties", () => {
    const map: ValidationMap = { "0": { kind: "checkbox" } };
    expect(setColumnValidation(map, 0, null)).toBeUndefined();
    expect(setColumnValidation(undefined, 0, null)).toBeUndefined();
  });

  it("keeps other columns when clearing one", () => {
    const map: ValidationMap = {
      "0": { kind: "checkbox" },
      "1": { kind: "checkbox" },
    };
    expect(setColumnValidation(map, 0, null)).toEqual({
      "1": { kind: "checkbox" },
    });
  });
});

describe("parseListValues", () => {
  it("splits, trims, drops empties, and de-duplicates preserving order", () => {
    expect(parseListValues(" Paid , Unpaid ,Paid,, Pending ")).toEqual([
      "Paid",
      "Unpaid",
      "Pending",
    ]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseListValues("   ")).toEqual([]);
    expect(parseListValues("")).toEqual([]);
  });
});

describe("isValueAllowed", () => {
  it("always allows a blank cell", () => {
    expect(isValueAllowed({ kind: "checkbox" }, "")).toBe(true);
    expect(isValueAllowed({ kind: "list", values: ["a"] }, "")).toBe(true);
  });

  it("checks list membership (case-sensitive)", () => {
    const v: DataValidation = { kind: "list", values: ["Paid", "Unpaid"] };
    expect(isValueAllowed(v, "Paid")).toBe(true);
    expect(isValueAllowed(v, "paid")).toBe(false);
    expect(isValueAllowed(v, "Other")).toBe(false);
  });

  it("accepts only TRUE/FALSE for a checkbox", () => {
    const v = { kind: "checkbox" } as const;
    expect(isValueAllowed(v, CHECKBOX_TRUE)).toBe(true);
    expect(isValueAllowed(v, CHECKBOX_FALSE)).toBe(true);
    expect(isValueAllowed(v, "yes")).toBe(false);
  });
});
