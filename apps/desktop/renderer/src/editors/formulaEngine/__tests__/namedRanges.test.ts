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

  it("ROWS/COLUMNS/ROW/COLUMN resolve a named range", () => {
    expect(evalWithNames("=ROWS(Revenue)", GRID, RANGES)).toBe(3);
    expect(evalWithNames("=COLUMNS(Revenue)", GRID, RANGES)).toBe(1);
    expect(evalWithNames("=ROW(Revenue)", GRID, RANGES)).toBe(1);
    expect(evalWithNames("=COLUMN(Revenue)", GRID, RANGES)).toBe(1);
    // A name pointing at a single cell behaves like that cell.
    expect(evalWithNames("=ROWS(First)", GRID, RANGES)).toBe(1);
    expect(evalWithNames("=COLUMN(First)", GRID, RANGES)).toBe(1);
  });

  it("a named range skips text cells in aggregation, like a literal range", () => {
    const grid = [["10"], ["abc"], ["30"]];
    const ranges = [{ name: "Vals", range: "A1:A3" }];
    // The semantically-equivalent literal range and named range must
    // agree: both skip the text cell rather than erroring on it.
    expect(evalWithNames("=SUM(A1:A3)", grid, ranges)).toBe(40);
    expect(evalWithNames("=SUM(Vals)", grid, ranges)).toBe(40);
    expect(evalWithNames("=AVERAGE(Vals)", grid, ranges)).toBe(20);
    expect(evalWithNames("=MEDIAN(Vals)", grid, ranges)).toBe(20);
  });
});

describe("conditional aggregation over a named range", () => {
  // SUMIF/COUNTIF/AVERAGEIF must expand a named range to every cell it
  // covers — not collapse it to its first cell via implicit
  // intersection — so a name behaves exactly like the literal range it
  // points at.
  const GRID = [
    ["paid", "10"],
    ["unpaid", "20"],
    ["paid", "30"],
    ["paid", "40"],
  ];
  const RANGES = [
    { name: "Status", range: "A1:A4" },
    { name: "Amount", range: "B1:B4" },
    { name: "FirstAmount", range: "B1" },
  ];

  it("SUMIF tests every cell of a named criteria/sum range", () => {
    // paid rows are 10 + 30 + 40 = 80; the named-range and literal forms agree.
    expect(evalWithNames('=SUMIF(Status,"paid",Amount)', GRID, RANGES)).toBe(80);
    expect(evalWithNames('=SUMIF(A1:A4,"paid",B1:B4)', GRID, RANGES)).toBe(80);
  });
  it("SUMIF with a numeric criterion over a named range", () => {
    expect(evalWithNames('=SUMIF(Amount,">=30")', GRID, RANGES)).toBe(70);
  });
  it("COUNTIF counts every matching cell of a named range", () => {
    expect(evalWithNames('=COUNTIF(Status,"paid")', GRID, RANGES)).toBe(3);
  });
  it("AVERAGEIF averages every matching cell of a named range", () => {
    // (10 + 30 + 40) / 3
    expect(
      evalWithNames('=AVERAGEIF(Status,"paid",Amount)', GRID, RANGES),
    ).toBeCloseTo(80 / 3);
  });
  it("a single-cell named range still behaves like that one cell", () => {
    // FirstAmount = B1 (value 10); only matches the ">=10" criterion once.
    expect(evalWithNames('=SUMIF(FirstAmount,">=10")', GRID, RANGES)).toBe(10);
    expect(evalWithNames('=COUNTIF(FirstAmount,">=10")', GRID, RANGES)).toBe(1);
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
