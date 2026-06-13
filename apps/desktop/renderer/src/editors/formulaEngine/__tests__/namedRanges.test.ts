/**
 * vitest coverage for named-range support:
 *   - `validateName` / `validateNamedRange` rules,
 *   - `buildNamesMap` compilation (skips invalid, last-wins),
 *   - evaluator resolution in scalar + aggregation contexts,
 *   - dependency extraction expanding a name to its cells.
 */
import { describe, expect, it } from "vitest";

import {
  buildNamesMap,
  defaultContext,
  evaluate,
  extractReferences,
  isFormulaError,
  parseFormula,
  validateName,
  validateNamedRange,
  type CellResolver,
  type FormulaValue,
} from "../";

function literalFromRaw(raw: string): FormulaValue {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  return raw;
}

function makeResolver(grid: string[][]): CellResolver {
  return {
    getRaw: (row, col) => grid[row]?.[col],
    getEvaluated: (row, col) => {
      const raw = grid[row]?.[col];
      if (raw === undefined || raw === "") return null;
      return literalFromRaw(raw);
    },
  };
}

function evalWithNames(
  expr: string,
  grid: string[][],
  ranges: { name: string; range: string }[],
): FormulaValue {
  const parsed = parseFormula(expr);
  if (!parsed.ok) return { kind: "error", code: parsed.code, message: parsed.message };
  const ctx = defaultContext(makeResolver(grid), {
    names: buildNamesMap(ranges),
  });
  return evaluate(parsed.ast, ctx);
}

describe("validateName", () => {
  it("accepts ordinary identifiers", () => {
    expect(validateName("Revenue")).toBeNull();
    expect(validateName("_total")).toBeNull();
    expect(validateName("Q1.sales")).toBeNull();
  });
  it("rejects empty, cell-shaped, reserved, and malformed names", () => {
    expect(validateName("")).not.toBeNull();
    expect(validateName("A1")).not.toBeNull();
    expect(validateName("$B$2")).not.toBeNull();
    expect(validateName("TRUE")).not.toBeNull();
    expect(validateName("has space")).not.toBeNull();
    expect(validateName("1stplace")).not.toBeNull();
  });
});

describe("validateNamedRange", () => {
  it("requires a parseable cell or range reference", () => {
    expect(validateNamedRange({ name: "R", range: "A1:B2" })).toBeNull();
    expect(validateNamedRange({ name: "R", range: "Sheet1!$A$1" })).toBeNull();
    expect(validateNamedRange({ name: "R", range: "1+2" })).not.toBeNull();
    expect(validateNamedRange({ name: "A1", range: "A1" })).not.toBeNull();
  });
});

describe("buildNamesMap", () => {
  it("skips invalid entries and upper-cases keys", () => {
    const map = buildNamesMap([
      { name: "Good", range: "A1:A3" },
      { name: "A1", range: "B1" }, // invalid name → skipped
      { name: "Bad", range: "not a ref" }, // invalid range → skipped
    ]);
    expect(map.has("GOOD")).toBe(true);
    expect(map.size).toBe(1);
  });
  it("last entry wins on a duplicate name", () => {
    const map = buildNamesMap([
      { name: "X", range: "A1" },
      { name: "x", range: "B2" },
    ]);
    const node = map.get("X");
    expect(node?.type).toBe("cell");
  });
});

describe("evaluator named-range resolution", () => {
  const GRID = [
    ["10", "100"],
    ["20", "200"],
    ["30", "300"],
  ];
  const RANGES = [
    { name: "Revenue", range: "A1:A3" },
    { name: "First", range: "A1" },
  ];

  it("aggregates a named range", () => {
    expect(evalWithNames("=SUM(Revenue)", GRID, RANGES)).toBe(60);
    expect(evalWithNames("=AVERAGE(Revenue)", GRID, RANGES)).toBe(20);
  });
  it("a name in scalar context collapses to its first cell", () => {
    expect(evalWithNames("=First+1", GRID, RANGES)).toBe(11);
    expect(evalWithNames("=Revenue", GRID, RANGES)).toBe(10);
  });
  it("an unknown name yields #NAME?", () => {
    const v = evalWithNames("=SUM(Unknown)", GRID, RANGES);
    expect(isFormulaError(v) && v.code).toBe("#NAME?");
  });
});

describe("dependency extraction with named ranges", () => {
  it("expands a name to the cells it covers", () => {
    const names = buildNamesMap([{ name: "Revenue", range: "A1:A3" }]);
    const parsed = parseFormula("=SUM(Revenue)");
    if (!parsed.ok) throw new Error("parse failed");
    const refs = extractReferences(parsed.ast, undefined, names);
    expect(refs.has("0,0")).toBe(true);
    expect(refs.has("1,0")).toBe(true);
    expect(refs.has("2,0")).toBe(true);
    expect(refs.size).toBe(3);
  });
  it("ignores an unknown name (no edges)", () => {
    const parsed = parseFormula("=SUM(Mystery)");
    if (!parsed.ok) throw new Error("parse failed");
    const refs = extractReferences(parsed.ast, undefined, new Map());
    expect(refs.size).toBe(0);
  });
});
