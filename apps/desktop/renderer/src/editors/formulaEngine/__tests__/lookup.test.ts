/**
 * vitest coverage for `functions/lookup.ts`.
 *
 * Lookup functions operate on RANGE references, so tests rely on a
 * mock `CellResolver` that materialises 2-D string arrays into
 * typed `FormulaValue`s on demand. The mock matches the strategy
 * used in `evaluator.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  evaluateFormulaString,
  isFormulaError,
  type CellResolver,
  type FormulaValue,
} from "../";

function literalFromRaw(raw: string): FormulaValue {
  const t = raw.trim();
  if (t === "") return null;
  if (t.toUpperCase() === "TRUE") return true;
  if (t.toUpperCase() === "FALSE") return false;
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    return t.slice(1, -1);
  }
  const n = Number(t);
  if (Number.isFinite(n)) return n;
  return raw;
}

function makeResolver(grid: string[][]): CellResolver {
  const cache = new Map<string, FormulaValue>();
  const r: CellResolver = {
    getRaw(row, col) {
      return grid[row]?.[col];
    },
    getEvaluated(row, col) {
      const key = `${row},${col}`;
      if (cache.has(key)) return cache.get(key)!;
      const raw = grid[row]?.[col];
      if (raw === undefined || raw === "") {
        cache.set(key, null);
        return null;
      }
      const v = raw.startsWith("=")
        ? evaluateFormulaString(raw, r)
        : literalFromRaw(raw);
      cache.set(key, v);
      return v;
    },
  };
  return r;
}

function evalFormula(expr: string, grid: string[][]): FormulaValue {
  return evaluateFormulaString(expr, makeResolver(grid));
}

// id | name  | price
// 1  | apple | 10
// 2  | pear  | 20
// 3  | plum  | 30
const PRICE_TABLE = [
  ["1", "apple", "10"],
  ["2", "pear", "20"],
  ["3", "plum", "30"],
];

describe("VLOOKUP", () => {
  it("unsorted exact match returns the right cell", () => {
    // VLOOKUP searches the FIRST column of the range, so we
    // anchor at B (the name column) and return column 2 (price).
    expect(evalFormula('=VLOOKUP("pear", B1:C3, 2, FALSE)', PRICE_TABLE)).toBe(
      20,
    );
  });
  it("sorted (default) returns largest ≤ key", () => {
    // Ascending IDs 1,2,3 — VLOOKUP(2.5) returns the row with ID 2.
    expect(evalFormula("=VLOOKUP(2.5, A1:C3, 2)", PRICE_TABLE)).toBe("pear");
  });
  it("returns #N/A when no match (unsorted)", () => {
    const v = evalFormula('=VLOOKUP("kiwi", A1:C3, 3, FALSE)', PRICE_TABLE);
    expect(isFormulaError(v) && v.code).toBe("#N/A");
  });
  it("returns #REF! when column out of range", () => {
    const v = evalFormula('=VLOOKUP("pear", A1:C3, 9, FALSE)', PRICE_TABLE);
    expect(isFormulaError(v) && v.code).toBe("#REF!");
  });
});

describe("HLOOKUP", () => {
  // Q1 Q2 Q3
  // 10 20 30
  const sales = [
    ["Q1", "Q2", "Q3"],
    ["10", "20", "30"],
  ];
  it("exact match returns the cell below", () => {
    expect(evalFormula('=HLOOKUP("Q2", A1:C2, 2, FALSE)', sales)).toBe(20);
  });
  it("#N/A on miss", () => {
    const v = evalFormula('=HLOOKUP("Q9", A1:C2, 2, FALSE)', sales);
    expect(isFormulaError(v) && v.code).toBe("#N/A");
  });
});

describe("INDEX", () => {
  it("returns the cell at (row, col)", () => {
    expect(evalFormula("=INDEX(A1:C3, 2, 2)", PRICE_TABLE)).toBe("pear");
  });
  it("with single-column range, second arg is the only index", () => {
    expect(evalFormula("=INDEX(B1:B3, 3)", PRICE_TABLE)).toBe("plum");
  });
  it("returns #REF! when out of range", () => {
    const v = evalFormula("=INDEX(A1:C3, 9, 9)", PRICE_TABLE);
    expect(isFormulaError(v) && v.code).toBe("#REF!");
  });
});

describe("MATCH", () => {
  it("exact match (type=0) returns 1-based position", () => {
    expect(evalFormula('=MATCH("plum", B1:B3, 0)', PRICE_TABLE)).toBe(3);
  });
  it("ascending (type=1, default) returns largest ≤ key index", () => {
    // 1, 2, 3 — MATCH(2.5) → 2 (the row with 2).
    expect(evalFormula("=MATCH(2.5, A1:A3)", PRICE_TABLE)).toBe(2);
  });
  it("#N/A when nothing matches exactly", () => {
    const v = evalFormula('=MATCH("kiwi", B1:B3, 0)', PRICE_TABLE);
    expect(isFormulaError(v) && v.code).toBe("#N/A");
  });
});

describe("XLOOKUP", () => {
  it("exact match returns the parallel cell in return range", () => {
    expect(
      evalFormula('=XLOOKUP("pear", B1:B3, C1:C3)', PRICE_TABLE),
    ).toBe(20);
  });
  it("returns the not_found fallback when missing", () => {
    expect(
      evalFormula(
        '=XLOOKUP("kiwi", B1:B3, C1:C3, "n/a")',
        PRICE_TABLE,
      ),
    ).toBe("n/a");
  });
  it("match_mode = 2 supports wildcards", () => {
    // Match "p*" → first row where the name starts with "p": pear.
    expect(
      evalFormula('=XLOOKUP("p*", B1:B3, C1:C3, "miss", 2)', PRICE_TABLE),
    ).toBe(20);
  });
  it("search_mode = -1 searches bottom-up", () => {
    // Add a duplicate "apple" at the bottom and search reverse.
    const dup = [...PRICE_TABLE, ["4", "apple", "99"]];
    expect(
      evalFormula(
        '=XLOOKUP("apple", B1:B4, C1:C4, "miss", 0, -1)',
        dup,
      ),
    ).toBe(99);
  });
});
