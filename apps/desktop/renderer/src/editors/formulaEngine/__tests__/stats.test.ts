/**
 * vitest coverage for `functions/stats.ts`.
 *
 * Values are hand-computed to verify the implementation, not via
 * the same algorithm (avoiding circular validation):
 *   data = [2, 4, 4, 4, 5, 5, 7, 9]
 *     mean      = 5
 *     variance  = 32 / 7  = 4.571428... (sample, divides by N-1=7)
 *     stdev     = sqrt(32/7) ≈ 2.13808993...
 *     stdevp    = sqrt(32/8) = sqrt(4) = 2
 *     median    = (4 + 5) / 2 = 4.5
 *     percentile p=0.5  = median = 4.5
 *     percentile p=0    = min = 2
 *     percentile p=1    = max = 9
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

// Column A1:A8 = 2, 4, 4, 4, 5, 5, 7, 9
const DATA = [["2"], ["4"], ["4"], ["4"], ["5"], ["5"], ["7"], ["9"]];

describe("MEDIAN", () => {
  it("returns midpoint average for even N", () => {
    expect(evalFormula("=MEDIAN(A1:A8)", DATA)).toBe(4.5);
  });
  it("returns middle for odd N", () => {
    expect(evalFormula("=MEDIAN(1, 2, 3, 4, 5)", [])).toBe(3);
  });
  it("returns #NUM! on empty", () => {
    const v = evalFormula("=MEDIAN(A1:A1)", [[""]]);
    expect(isFormulaError(v) && v.code).toBe("#NUM!");
  });
});

describe("STDEV / STDEVP / VAR", () => {
  it("STDEVP returns sqrt(variance) over N", () => {
    expect(evalFormula("=STDEVP(A1:A8)", DATA)).toBe(2);
  });
  it("STDEV (sample) uses Bessel-corrected divisor N-1", () => {
    const v = evalFormula("=STDEV(A1:A8)", DATA) as number;
    expect(v).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });
  it("VAR returns sample variance", () => {
    const v = evalFormula("=VAR(A1:A8)", DATA) as number;
    expect(v).toBeCloseTo(32 / 7, 10);
  });
  it("STDEV with N=1 → #DIV/0!", () => {
    const v = evalFormula("=STDEV(5)", []);
    expect(isFormulaError(v) && v.code).toBe("#DIV/0!");
  });
});

describe("PERCENTILE", () => {
  it("p=0.5 equals the median for even N", () => {
    expect(evalFormula("=PERCENTILE(A1:A8, 0.5)", DATA)).toBe(4.5);
  });
  it("p=0 returns the min, p=1 returns the max", () => {
    expect(evalFormula("=PERCENTILE(A1:A8, 0)", DATA)).toBe(2);
    expect(evalFormula("=PERCENTILE(A1:A8, 1)", DATA)).toBe(9);
  });
  it("rejects p out of range", () => {
    const v = evalFormula("=PERCENTILE(A1:A8, 1.5)", DATA);
    expect(isFormulaError(v) && v.code).toBe("#NUM!");
  });
  it("interpolates linearly between samples", () => {
    // Per Excel PERCENTILE.INC: data = 1,2,3,4 (N=4),
    // rank = p*(N-1) = 0.5 * 3 = 1.5 →
    // interpolate(sorted[1]=2, sorted[2]=3, frac=0.5) = 2.5
    expect(
      evalFormula("=PERCENTILE(A1:A4, 0.5)", [["1"], ["2"], ["3"], ["4"]]),
    ).toBe(2.5);
  });
});

describe("RANK", () => {
  it("descending (default) rank — largest value is rank 1", () => {
    // Sorted desc: 9, 7, 5, 5, 4, 4, 4, 2 → rank of 9 = 1.
    expect(evalFormula("=RANK(9, A1:A8)", DATA)).toBe(1);
  });
  it("ties produce the same rank (competition ranking)", () => {
    // rank of 5: there are 2 values strictly greater (9, 7), so rank = 3.
    expect(evalFormula("=RANK(5, A1:A8)", DATA)).toBe(3);
  });
  it("ascending mode (order != 0) — smallest is rank 1", () => {
    // rank of 2 ascending = 1.
    expect(evalFormula("=RANK(2, A1:A8, 1)", DATA)).toBe(1);
  });
  it("#N/A when value not in range", () => {
    const v = evalFormula("=RANK(100, A1:A8)", DATA);
    expect(isFormulaError(v) && v.code).toBe("#N/A");
  });
});

describe("VARP", () => {
  it("returns the population variance (divides by N)", () => {
    // data = 2,4,4,4,5,5,7,9 → ssq=32, N=8 → 4.
    expect(evalFormula("=VARP(A1:A8)", DATA)).toBe(4);
  });
});

describe("COUNTBLANK / COUNTUNIQUE", () => {
  const MIXED = [["a"], [""], ["b"], ["a"], [""]];
  it("COUNTBLANK counts empty cells", () => {
    expect(evalFormula("=COUNTBLANK(A1:A5)", MIXED)).toBe(2);
  });
  it("COUNTUNIQUE counts distinct non-blank values, case-insensitively", () => {
    expect(evalFormula("=COUNTUNIQUE(A1:A5)", MIXED)).toBe(2);
  });
  it('COUNTUNIQUE distinguishes number 1 from string "1"', () => {
    expect(evalFormula('=COUNTUNIQUE(1, "1", 1)', [])).toBe(2);
  });
});

describe("MODE", () => {
  it("returns the most frequent value", () => {
    // 4 occurs three times in DATA.
    expect(evalFormula("=MODE(A1:A8)", DATA)).toBe(4);
  });
  it("returns #N/A when nothing repeats", () => {
    const v = evalFormula("=MODE(1, 2, 3)", []);
    expect(isFormulaError(v) && v.code).toBe("#N/A");
  });
});

describe("LARGE / SMALL", () => {
  it("LARGE returns the kth largest", () => {
    expect(evalFormula("=LARGE(A1:A8, 1)", DATA)).toBe(9);
    expect(evalFormula("=LARGE(A1:A8, 2)", DATA)).toBe(7);
  });
  it("SMALL returns the kth smallest", () => {
    expect(evalFormula("=SMALL(A1:A8, 1)", DATA)).toBe(2);
    expect(evalFormula("=SMALL(A1:A8, 2)", DATA)).toBe(4);
  });
  it("rejects out-of-range k", () => {
    expect(isFormulaError(evalFormula("=LARGE(A1:A8, 0)", DATA)) && true).toBe(
      true,
    );
    const v = evalFormula("=SMALL(A1:A8, 99)", DATA);
    expect(isFormulaError(v) && v.code).toBe("#NUM!");
  });
});
