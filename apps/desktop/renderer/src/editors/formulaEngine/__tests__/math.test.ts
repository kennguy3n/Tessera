/**
 * vitest coverage for the expanded `functions/math.ts` surface.
 *
 * Only the functions added in the Google-Sheets-parity pass are
 * exercised here; the pre-existing SUM / AVERAGE / ROUND / etc. are
 * covered transitively by `evaluator.test.ts`. Expected values are
 * hand-computed (or pinned against the JS Math reference) rather than
 * recomputed with the implementation under test.
 */
import { describe, expect, it } from "vitest";

import {
  defaultContext,
  evaluate,
  evaluateFormulaString,
  isFormulaError,
  parseFormula,
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

function evalFormula(expr: string, grid: string[][] = []): FormulaValue {
  return evaluateFormulaString(expr, makeResolver(grid));
}

function code(v: FormulaValue): string | false {
  return isFormulaError(v) && v.code;
}

describe("rounding / sign family", () => {
  it("TRUNC drops the fractional part toward zero", () => {
    expect(evalFormula("=TRUNC(3.99)")).toBe(3);
    expect(evalFormula("=TRUNC(-3.99)")).toBe(-3);
    expect(evalFormula("=TRUNC(3.14159, 2)")).toBe(3.14);
  });
  it("SIGN returns -1, 0, 1", () => {
    expect(evalFormula("=SIGN(-42)")).toBe(-1);
    expect(evalFormula("=SIGN(0)")).toBe(0);
    expect(evalFormula("=SIGN(0.001)")).toBe(1);
  });
  it("EVEN / ODD round away from zero", () => {
    expect(evalFormula("=EVEN(3)")).toBe(4);
    expect(evalFormula("=EVEN(2)")).toBe(2);
    expect(evalFormula("=EVEN(-1)")).toBe(-2);
    expect(evalFormula("=ODD(2)")).toBe(3);
    expect(evalFormula("=ODD(3)")).toBe(3);
    expect(evalFormula("=ODD(-2)")).toBe(-3);
    expect(evalFormula("=ODD(0)")).toBe(1);
  });
  it("MROUND rounds to the nearest multiple", () => {
    expect(evalFormula("=MROUND(10, 3)")).toBe(9);
    expect(evalFormula("=MROUND(11, 3)")).toBe(12);
    expect(code(evalFormula("=MROUND(5, -2)"))).toBe("#NUM!");
  });
  it("QUOTIENT truncates the integer division", () => {
    expect(evalFormula("=QUOTIENT(7, 2)")).toBe(3);
    expect(evalFormula("=QUOTIENT(-7, 2)")).toBe(-3);
    expect(code(evalFormula("=QUOTIENT(1, 0)"))).toBe("#DIV/0!");
  });
});

describe("logarithm / exponential family", () => {
  it("EXP and LN are inverses", () => {
    expect(evalFormula("=LN(EXP(1))") as number).toBeCloseTo(1, 12);
  });
  it("LOG defaults to base 10 and accepts a base", () => {
    expect(evalFormula("=LOG(1000)") as number).toBeCloseTo(3, 12);
    expect(evalFormula("=LOG(8, 2)") as number).toBeCloseTo(3, 12);
  });
  it("LOG10 matches Math.log10", () => {
    expect(evalFormula("=LOG10(100)") as number).toBeCloseTo(2, 12);
  });
  it("LN of a non-positive value is #NUM!", () => {
    expect(code(evalFormula("=LN(0)"))).toBe("#NUM!");
    expect(code(evalFormula("=LN(-1)"))).toBe("#NUM!");
  });
});

describe("trigonometry", () => {
  it("PI returns Math.PI", () => {
    expect(evalFormula("=PI()")).toBe(Math.PI);
  });
  it("SIN/COS/TAN evaluate at common angles", () => {
    expect(evalFormula("=SIN(0)")).toBe(0);
    expect(evalFormula("=COS(0)")).toBe(1);
    expect(evalFormula("=SIN(PI()/2)") as number).toBeCloseTo(1, 12);
  });
  it("RADIANS / DEGREES round-trip", () => {
    expect(evalFormula("=RADIANS(180)") as number).toBeCloseTo(Math.PI, 12);
    expect(evalFormula("=DEGREES(PI())") as number).toBeCloseTo(180, 12);
  });
  it("ASIN/ACOS guard their domain", () => {
    expect(code(evalFormula("=ASIN(2)"))).toBe("#NUM!");
    expect(code(evalFormula("=ACOS(-2)"))).toBe("#NUM!");
  });
  it("ATAN2 uses Excel (x, y) argument order", () => {
    // ATAN2(1, 1) → 45° in radians.
    expect(evalFormula("=ATAN2(1, 1)") as number).toBeCloseTo(Math.PI / 4, 12);
    expect(code(evalFormula("=ATAN2(0, 0)"))).toBe("#DIV/0!");
  });
});

describe("number theory & combinatorics", () => {
  it("GCD / LCM over multiple arguments", () => {
    expect(evalFormula("=GCD(12, 18)")).toBe(6);
    expect(evalFormula("=GCD(12, 18, 30)")).toBe(6);
    expect(evalFormula("=LCM(4, 6)")).toBe(12);
    expect(evalFormula("=LCM(3, 4, 5)")).toBe(60);
  });
  it("FACT computes factorials and guards range", () => {
    expect(evalFormula("=FACT(5)")).toBe(120);
    expect(evalFormula("=FACT(0)")).toBe(1);
    expect(code(evalFormula("=FACT(-1)"))).toBe("#NUM!");
  });
  it("COMBIN computes binomial coefficients", () => {
    expect(evalFormula("=COMBIN(5, 2)")).toBe(10);
    expect(evalFormula("=COMBIN(52, 5)")).toBe(2598960);
    expect(code(evalFormula("=COMBIN(2, 5)"))).toBe("#NUM!");
  });
});

describe("array aggregations", () => {
  const GRID = [
    ["1", "4"],
    ["2", "5"],
    ["3", "6"],
  ];
  it("SUMSQ sums the squares", () => {
    expect(evalFormula("=SUMSQ(A1:A3)", GRID)).toBe(14);
    expect(evalFormula("=SUMSQ(3, 4)")).toBe(25);
  });
  it("SUMPRODUCT multiplies parallel ranges and sums", () => {
    // 1*4 + 2*5 + 3*6 = 4 + 10 + 18 = 32
    expect(evalFormula("=SUMPRODUCT(A1:A3, B1:B3)", GRID)).toBe(32);
  });
  it("SUMPRODUCT of a single range degenerates to SUM", () => {
    expect(evalFormula("=SUMPRODUCT(A1:A3)", GRID)).toBe(6);
  });
  it("SUMPRODUCT rejects mismatched shapes", () => {
    expect(code(evalFormula("=SUMPRODUCT(A1:A3, B1:B2)", GRID))).toBe(
      "#VALUE!",
    );
  });
});

describe("RAND / RANDBETWEEN determinism", () => {
  it("RANDBETWEEN honours the injected RNG and is inclusive", () => {
    const resolver = makeResolver([]);
    const parsed = parseFormula("=RANDBETWEEN(1, 6)");
    if (!parsed.ok) throw new Error("parse failed");
    // random()=0 → low endpoint, random()→1⁻ → high endpoint.
    expect(
      evaluate(parsed.ast, defaultContext(resolver, { random: () => 0 })),
    ).toBe(1);
    expect(
      evaluate(
        parsed.ast,
        defaultContext(resolver, { random: () => 0.999999 }),
      ),
    ).toBe(6);
    expect(code(evalFormula("=RANDBETWEEN(6, 1)"))).toBe("#NUM!");
  });
});

describe("error propagation", () => {
  it("propagates errors from inner expressions", () => {
    expect(code(evalFormula("=SIN(1/0)"))).toBe("#DIV/0!");
    expect(code(evalFormula("=GCD(SQRT(-1))"))).toBe("#NUM!");
  });
});
