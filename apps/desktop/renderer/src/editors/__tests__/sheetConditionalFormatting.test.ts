/**
 * Unit tests for Sheet conditional-formatting rule evaluation.
 *
 * Pins the pure matching + style-merge logic used by `SheetEditor` to
 * highlight cells by value:
 *   - numeric operators coerce + never match non-numeric cells
 *   - text operators (contains / equality) behave as written
 *   - empty / non-empty checks ignore the rule value
 *   - column scoping (`null` = all, otherwise exact index)
 *   - multiple matching rules cascade in array order (later wins)
 */
import { describe, it, expect } from "vitest";
import {
  cellMatchesRule,
  conditionalStyleForCell,
  defaultConditionalRule,
  makeRuleId,
  operatorTakesValue,
} from "../sheetConditionalFormatting";
import type {
  ConditionalFormatRule,
  ConditionalOperator,
} from "../sheetEditorTypes";

function rule(over: Partial<ConditionalFormatRule>): ConditionalFormatRule {
  return {
    id: "r1",
    column: null,
    operator: "gt",
    value: "0",
    style: { background: "#ff0000" },
    ...over,
  };
}

describe("cellMatchesRule — numeric operators", () => {
  it("gt / gte / lt / lte compare numerically", () => {
    expect(cellMatchesRule("10", rule({ operator: "gt", value: "5" }))).toBe(
      true,
    );
    expect(cellMatchesRule("5", rule({ operator: "gt", value: "5" }))).toBe(
      false,
    );
    expect(cellMatchesRule("5", rule({ operator: "gte", value: "5" }))).toBe(
      true,
    );
    expect(cellMatchesRule("3", rule({ operator: "lt", value: "5" }))).toBe(
      true,
    );
    expect(cellMatchesRule("5", rule({ operator: "lte", value: "5" }))).toBe(
      true,
    );
  });

  it("never matches a non-numeric cell with a numeric operator", () => {
    expect(cellMatchesRule("hello", rule({ operator: "gt", value: "5" }))).toBe(
      false,
    );
    expect(cellMatchesRule("", rule({ operator: "lt", value: "5" }))).toBe(
      false,
    );
  });

  it("never matches when the rule value is non-numeric", () => {
    expect(cellMatchesRule("10", rule({ operator: "gt", value: "x" }))).toBe(
      false,
    );
  });
});

describe("cellMatchesRule — equality", () => {
  it("eq is numeric-aware (5 equals 5.0)", () => {
    expect(cellMatchesRule("5", rule({ operator: "eq", value: "5.0" }))).toBe(
      true,
    );
  });

  it("eq falls back to string compare for non-numeric operands", () => {
    expect(
      cellMatchesRule("apple", rule({ operator: "eq", value: "apple" })),
    ).toBe(true);
    expect(
      cellMatchesRule("apple", rule({ operator: "eq", value: "orange" })),
    ).toBe(false);
  });

  it("neq is the negation of eq", () => {
    expect(cellMatchesRule("5", rule({ operator: "neq", value: "5" }))).toBe(
      false,
    );
    expect(cellMatchesRule("6", rule({ operator: "neq", value: "5" }))).toBe(
      true,
    );
  });
});

describe("cellMatchesRule — text + emptiness", () => {
  it("contains / notContains do substring checks", () => {
    expect(
      cellMatchesRule(
        "hello world",
        rule({ operator: "contains", value: "wor" }),
      ),
    ).toBe(true);
    expect(
      cellMatchesRule("hello", rule({ operator: "notContains", value: "zzz" })),
    ).toBe(true);
  });

  it("isEmpty / notEmpty ignore the rule value", () => {
    expect(cellMatchesRule("", rule({ operator: "isEmpty", value: "x" }))).toBe(
      true,
    );
    expect(
      cellMatchesRule("  ", rule({ operator: "isEmpty", value: "" })),
    ).toBe(true);
    expect(
      cellMatchesRule("data", rule({ operator: "notEmpty", value: "" })),
    ).toBe(true);
    expect(cellMatchesRule("", rule({ operator: "notEmpty", value: "" }))).toBe(
      false,
    );
  });
});

describe("conditionalStyleForCell — column scope + cascade", () => {
  it("returns {} when no rules are supplied", () => {
    expect(conditionalStyleForCell(undefined, 0, "10")).toEqual({});
    expect(conditionalStyleForCell([], 0, "10")).toEqual({});
  });

  it("applies an all-columns rule to every column", () => {
    const rules = [rule({ operator: "gt", value: "5" })];
    expect(conditionalStyleForCell(rules, 0, "10")).toEqual({
      background: "#ff0000",
    });
    expect(conditionalStyleForCell(rules, 3, "10")).toEqual({
      background: "#ff0000",
    });
  });

  it("scopes a column-specific rule to its column only", () => {
    const rules = [rule({ column: 1, operator: "gt", value: "5" })];
    expect(conditionalStyleForCell(rules, 1, "10")).toEqual({
      background: "#ff0000",
    });
    expect(conditionalStyleForCell(rules, 0, "10")).toEqual({});
  });

  it("cascades multiple matching rules, later overriding earlier", () => {
    const rules = [
      rule({
        id: "a",
        operator: "gt",
        value: "5",
        style: { background: "#aaa", bold: true },
      }),
      rule({
        id: "b",
        operator: "gt",
        value: "8",
        style: { background: "#bbb" },
      }),
    ];
    // value 10 matches both → background from the later rule, bold from earlier
    expect(conditionalStyleForCell(rules, 0, "10")).toEqual({
      background: "#bbb",
      bold: true,
    });
    // value 6 matches only the first rule
    expect(conditionalStyleForCell(rules, 0, "6")).toEqual({
      background: "#aaa",
      bold: true,
    });
  });
});

describe("helpers", () => {
  it("operatorTakesValue is false only for emptiness operators", () => {
    const withValue: ConditionalOperator[] = [
      "gt",
      "gte",
      "lt",
      "lte",
      "eq",
      "neq",
      "contains",
      "notContains",
    ];
    for (const op of withValue) expect(operatorTakesValue(op)).toBe(true);
    expect(operatorTakesValue("isEmpty")).toBe(false);
    expect(operatorTakesValue("notEmpty")).toBe(false);
  });

  it("makeRuleId is unique", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i += 1) ids.add(makeRuleId());
    expect(ids.size).toBe(500);
  });

  it("defaultConditionalRule is an all-columns gt rule with a fill", () => {
    const r = defaultConditionalRule();
    expect(r.column).toBeNull();
    expect(r.operator).toBe("gt");
    expect(r.style.background).toBeTruthy();
  });
});
