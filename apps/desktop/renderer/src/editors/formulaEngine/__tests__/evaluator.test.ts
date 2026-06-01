/**
 * evaluator tests.
 *
 * 30+ end-to-end cases asserting that
 *   parse → evaluate(against mock grid) → expected `FormulaValue`.
 *
 * Grid fixture is laid out as a small 2-D string array; values are
 * the raw cell text the user typed. Cells starting with `=` are
 * recursively evaluated (so dependency-chained cell refs are
 * tested implicitly).
 */
import { describe, it, expect } from "vitest";

import {
  defaultContext,
  evaluateFormulaString,
  isFormulaError,
  type CellResolver,
  type FormulaValue,
} from "..";

function makeResolver(grid: string[][]): CellResolver {
  // Cache so cell `=A1` doesn't re-evaluate `A1` on every read.
  const cache = new Map<string, FormulaValue>();
  const r: CellResolver = {
    getRaw(row, col) {
      return grid[row]?.[col];
    },
    getEvaluated(row, col): FormulaValue {
      const key = `${row},${col}`;
      if (cache.has(key)) return cache.get(key)!;
      const raw = grid[row]?.[col];
      if (raw === undefined || raw === "") return null;
      if (raw.startsWith("=")) {
        const v = evaluateFormulaString(raw, r);
        cache.set(key, v);
        return v;
      }
      const v = literalFromRaw(raw);
      cache.set(key, v);
      return v;
    },
  };
  return r;
}

/**
 * Mirror how a real spreadsheet UI promotes raw cell text to a
 * typed `FormulaValue`. Booleans are typed by name, numbers by
 * `Number.isFinite`, everything else stays a string. Quoted strings
 * (`"x"` etc.) are NOT unquoted — Excel/Sheets show quotes inline
 * when the user explicitly types them.
 */
function literalFromRaw(raw: string): FormulaValue {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase();
  if (upper === "TRUE") return true;
  if (upper === "FALSE") return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  const n = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(n)) return n;
  return raw;
}

function evalFormula(formula: string, grid: string[][]): FormulaValue {
  const resolver = makeResolver(grid);
  return evaluateFormulaString(formula, resolver);
}

describe("evaluator — arithmetic literals", () => {
  it("evaluates 1+2", () => expect(evalFormula("=1+2", [])).toBe(3));
  it("evaluates 10-3*2", () => expect(evalFormula("=10-3*2", [])).toBe(4));
  it("evaluates (10-3)*2", () => expect(evalFormula("=(10-3)*2", [])).toBe(14));
  it("evaluates 2^3", () => expect(evalFormula("=2^3", [])).toBe(8));
  it("evaluates 2^3^2 right-associative", () =>
    expect(evalFormula("=2^3^2", [])).toBe(512));
  it("evaluates 50% as 0.5", () => expect(evalFormula("=50%", [])).toBe(0.5));
});

describe("evaluator — coercion", () => {
  // C1 is a non-numeric, non-boolean raw text cell.
  const grid = [["1", "2", "hello", "", "TRUE"]];
  it("coerces blank cell to 0", () =>
    expect(evalFormula("=D1+1", grid)).toBe(1));
  it("coerces TRUE to 1", () =>
    expect(evalFormula("=E1+1", grid)).toBe(2));
  it("returns #VALUE! on non-numeric string in arithmetic", () => {
    const v = evalFormula("=C1+1", grid);
    expect(isFormulaError(v) && v.code).toBe("#VALUE!");
  });
  it("concatenates with &", () =>
    expect(evalFormula('="a"&"b"', [])).toBe("ab"));
  it("concatenates numbers via &", () =>
    expect(evalFormula('=1&"-"&2', [])).toBe("1-2"));
});

describe("evaluator — comparisons", () => {
  it("=1=1 → true", () => expect(evalFormula("=1=1", [])).toBe(true));
  it("=1<>2 → true", () => expect(evalFormula("=1<>2", [])).toBe(true));
  it("=3<5 → true", () => expect(evalFormula("=3<5", [])).toBe(true));
  it('="a"<"b" → true', () => expect(evalFormula('="a"<"b"', [])).toBe(true));
  it("blank equals 0", () =>
    expect(evalFormula("=A1=0", [[""]])).toBe(true));
});

describe("evaluator — cell and range references", () => {
  const grid = [
    ["1", "10"],
    ["2", "20"],
    ["3", "30"],
  ];
  it("reads a single cell", () =>
    expect(evalFormula("=A1", grid)).toBe(1));
  it("reads a chained cell", () => {
    expect(evalFormula("=B3", grid)).toBe(30);
  });
  it("sums a 1-D range", () =>
    expect(evalFormula("=SUM(A1:A3)", grid)).toBe(6));
  it("sums a 2-D range", () =>
    expect(evalFormula("=SUM(A1:B3)", grid)).toBe(66));
});

describe("evaluator — math functions", () => {
  it("SUM with literals + range", () =>
    expect(evalFormula("=SUM(1,2,A1:A2)", [["3"], ["4"]])).toBe(10));
  it("AVERAGE ignores text in a range", () =>
    expect(evalFormula("=AVERAGE(A1:A3)", [["1"], ["foo"], ["3"]])).toBe(2));
  it("COUNT counts only numerics", () =>
    expect(evalFormula("=COUNT(A1:A3)", [["1"], ["foo"], ["3"]])).toBe(2));
  it("COUNTA counts non-blank", () =>
    expect(evalFormula("=COUNTA(A1:A3)", [["1"], ["foo"], [""]])).toBe(2));
  it("MIN/MAX over a range", () => {
    const g = [["5"], ["2"], ["8"]];
    expect(evalFormula("=MIN(A1:A3)", g)).toBe(2);
    expect(evalFormula("=MAX(A1:A3)", g)).toBe(8);
  });
  it("ROUND(3.14159, 2)", () =>
    expect(evalFormula("=ROUND(3.14159,2)", [])).toBe(3.14));
  it("ABS(-5)", () => expect(evalFormula("=ABS(-5)", [])).toBe(5));
  it("POWER(2,10)", () => expect(evalFormula("=POWER(2,10)", [])).toBe(1024));
  it("SQRT(9)", () => expect(evalFormula("=SQRT(9)", [])).toBe(3));
  it("MOD(10,3)", () => expect(evalFormula("=MOD(10,3)", [])).toBe(1));
  it("MOD with negative divisor", () =>
    expect(evalFormula("=MOD(10,-3)", [])).toBe(-2));
});

describe("evaluator — conditional aggregation", () => {
  const grid = [
    ["apple", "10"],
    ["banana", "20"],
    ["apple", "30"],
    ["cherry", "5"],
  ];
  it("SUMIF with text criterion", () =>
    expect(evalFormula('=SUMIF(A1:A4,"apple",B1:B4)', grid)).toBe(40));
  it("SUMIF with numeric criterion", () =>
    expect(evalFormula('=SUMIF(B1:B4,">=10")', grid)).toBe(60));
  it("COUNTIF with wildcard", () =>
    expect(evalFormula('=COUNTIF(A1:A4,"a*")', grid)).toBe(2));
  it("AVERAGEIF text criterion", () =>
    expect(evalFormula('=AVERAGEIF(A1:A4,"apple",B1:B4)', grid)).toBe(20));
  it("SUMIFS with two ranges", () =>
    expect(
      evalFormula('=SUMIFS(B1:B4,A1:A4,"apple",B1:B4,">15")', grid),
    ).toBe(30));
});

describe("evaluator — logic", () => {
  it("IF true branch", () =>
    expect(evalFormula("=IF(TRUE,1,2)", [])).toBe(1));
  it("IF false branch", () =>
    expect(evalFormula("=IF(FALSE,1,2)", [])).toBe(2));
  it("nested IF", () =>
    expect(evalFormula("=IF(1>2,1,IF(2>1,3,4))", [])).toBe(3));
  it("AND short-circuits to FALSE", () =>
    expect(evalFormula("=AND(TRUE,FALSE,TRUE)", [])).toBe(false));
  it("OR short-circuits to TRUE", () =>
    expect(evalFormula("=OR(FALSE,TRUE,FALSE)", [])).toBe(true));
  it("NOT", () => expect(evalFormula("=NOT(TRUE)", [])).toBe(false));
  it("IFERROR catches division by zero", () =>
    expect(evalFormula('=IFERROR(1/0,"fallback")', [])).toBe("fallback"));
  it("IFERROR passes through non-errors", () =>
    expect(evalFormula("=IFERROR(2+2,99)", [])).toBe(4));
  it("IFS picks first match", () =>
    expect(evalFormula('=IFS(1>2,"a",2>1,"b",3>1,"c")', [])).toBe("b"));
  it("SWITCH matches a case", () =>
    expect(evalFormula('=SWITCH(2,1,"a",2,"b","default")', [])).toBe("b"));
  it("SWITCH falls through to default", () =>
    expect(evalFormula('=SWITCH(99,1,"a",2,"b","default")', [])).toBe("default"));
});

describe("evaluator — errors", () => {
  it("divides by zero", () => {
    const v = evalFormula("=1/0", []);
    expect(isFormulaError(v) && v.code).toBe("#DIV/0!");
  });
  it("propagates errors through addition", () => {
    const v = evalFormula("=1/0+1", []);
    expect(isFormulaError(v) && v.code).toBe("#DIV/0!");
  });
  it("returns #NAME? for unknown function", () => {
    const v = evalFormula("=BOGUS(1)", []);
    expect(isFormulaError(v) && v.code).toBe("#NAME?");
  });
  it("returns #ERR! on syntax error", () => {
    const v = evalFormula("=(1", []);
    expect(isFormulaError(v) && v.code).toBe("#ERR!");
  });
});

describe("evaluator — circular references", () => {
  it("detects a direct A1 → A1 cycle", () => {
    // Resolver that returns a self-reference: looking up A1 evaluates
    // `=A1` which re-enters the cell. We simulate by manually adding
    // to `visiting` to mimic the depGraph driver.
    const resolver: CellResolver = {
      getRaw: () => "=A1",
      getEvaluated: (r, c) =>
        evaluateFormulaString("=A1", resolver, {
          visiting: new Set([`${r},${c}`]),
        }),
    };
    const v = evaluateFormulaString("=A1", resolver, {
      visiting: new Set(["0,0"]),
    });
    expect(isFormulaError(v) && v.code).toBe("#CIRCULAR!");
  });
});

describe("evaluator — defaultContext sanity", () => {
  it("exposes the standard registry", () => {
    const resolver: CellResolver = {
      getRaw: () => undefined,
      getEvaluated: () => null,
    };
    const ctx = defaultContext(resolver);
    expect(ctx.functions.has("SUM")).toBe(true);
    expect(ctx.functions.has("IF")).toBe(true);
    // (Tasks 9–12) added text/lookup/date/stats fns —
    // assert one representative member from each new group.
    expect(ctx.functions.has("VLOOKUP")).toBe(true);
    expect(ctx.functions.has("CONCATENATE")).toBe(true);
    expect(ctx.functions.has("TODAY")).toBe(true);
    expect(ctx.functions.has("MEDIAN")).toBe(true);
    // Bogus name still misses.
    expect(ctx.functions.has("NOT_A_REAL_FN")).toBe(false);
  });
});
