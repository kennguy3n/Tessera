/**
 * vitest coverage for the logic functions added in the
 * Google-Sheets-parity pass: TRUE/FALSE (callable form), XOR, IFNA, N,
 * and the IS* classification family. The pre-existing IF / AND / OR /
 * IFERROR / IFS / SWITCH are covered by `evaluator.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  evaluateFormulaString,
  isFormulaError,
  type CellResolver,
  type FormulaValue,
} from "../";

/** Grid where A1 is blank, A2=number, A3=text, A4 holds a #DIV/0! formula. */
function makeResolver(): CellResolver {
  const grid: Record<string, string> = {
    "1,0": "42",
    "2,0": "hello",
    "3,0": "=1/0",
    "4,0": "=NA()",
  };
  const cache = new Map<string, FormulaValue>();
  const r: CellResolver = {
    getRaw(row, col) {
      return grid[`${row},${col}`];
    },
    getEvaluated(row, col) {
      const key = `${row},${col}`;
      if (cache.has(key)) return cache.get(key)!;
      const raw = grid[key];
      if (raw === undefined || raw === "") {
        cache.set(key, null);
        return null;
      }
      let v: FormulaValue;
      if (raw.startsWith("=")) v = evaluateFormulaString(raw, r);
      else {
        const n = Number(raw);
        v = Number.isFinite(n) && raw.trim() !== "" ? n : raw;
      }
      cache.set(key, v);
      return v;
    },
  };
  return r;
}

function evalFormula(expr: string): FormulaValue {
  return evaluateFormulaString(expr, makeResolver());
}

describe("TRUE() / FALSE()", () => {
  it("callable forms return booleans", () => {
    expect(evalFormula("=TRUE()")).toBe(true);
    expect(evalFormula("=FALSE()")).toBe(false);
  });
  it("bare TRUE / FALSE still parse as literals", () => {
    expect(evalFormula("=IF(TRUE, 1, 2)")).toBe(1);
    expect(evalFormula("=IF(FALSE, 1, 2)")).toBe(2);
  });
});

describe("XOR", () => {
  it("is true for an odd number of true arguments", () => {
    expect(evalFormula("=XOR(TRUE, FALSE, FALSE)")).toBe(true);
    expect(evalFormula("=XOR(TRUE, TRUE, FALSE)")).toBe(false);
    expect(evalFormula("=XOR(TRUE, TRUE, TRUE)")).toBe(true);
  });
});

describe("IFNA", () => {
  it("substitutes only for #N/A", () => {
    expect(evalFormula("=IFNA(NA(), 99)")).toBe(99);
    expect(evalFormula("=IFNA(5, 99)")).toBe(5);
  });
  it("passes through non-#N/A errors", () => {
    const v = evalFormula("=IFNA(1/0, 99)");
    expect(isFormulaError(v) && v.code).toBe("#DIV/0!");
  });
});

describe("N", () => {
  it("coerces numbers, booleans, and text", () => {
    expect(evalFormula("=N(7)")).toBe(7);
    expect(evalFormula("=N(TRUE)")).toBe(1);
    expect(evalFormula('=N("text")')).toBe(0);
  });
});

describe("IS* family", () => {
  it("ISBLANK / ISNUMBER / ISTEXT classify cells", () => {
    expect(evalFormula("=ISBLANK(A1)")).toBe(true);
    expect(evalFormula("=ISNUMBER(A2)")).toBe(true);
    expect(evalFormula("=ISTEXT(A3)")).toBe(true);
    expect(evalFormula("=ISNONTEXT(A2)")).toBe(true);
  });
  it("ISLOGICAL detects booleans", () => {
    expect(evalFormula("=ISLOGICAL(TRUE)")).toBe(true);
    expect(evalFormula("=ISLOGICAL(1)")).toBe(false);
  });
  it("ISERROR / ISERR / ISNA discriminate error kinds", () => {
    // A4 = NA() → #N/A ; A4... we use direct expressions for clarity.
    expect(evalFormula("=ISERROR(1/0)")).toBe(true);
    expect(evalFormula("=ISERR(1/0)")).toBe(true);
    expect(evalFormula("=ISNA(1/0)")).toBe(false);
    expect(evalFormula("=ISERROR(NA())")).toBe(true);
    expect(evalFormula("=ISERR(NA())")).toBe(false);
    expect(evalFormula("=ISNA(NA())")).toBe(true);
    expect(evalFormula("=ISERROR(5)")).toBe(false);
  });
});
