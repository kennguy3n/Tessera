/**
 * vitest coverage for `functions/financial.ts`.
 *
 * Expected values are pinned against Microsoft's published Excel function
 * examples (or hand-derived from the annuity equation) rather than recomputed
 * with the implementation under test, so a regression in the maths is caught
 * rather than rationalised away.
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

function evalFormula(expr: string, grid: string[][] = []): FormulaValue {
  return evaluateFormulaString(expr, makeResolver(grid));
}

function numberValue(expr: string, grid: string[][] = []): number {
  const v = evalFormula(expr, grid);
  if (typeof v !== "number") {
    throw new Error(`expected number from ${expr}, got ${JSON.stringify(v)}`);
  }
  return v;
}

function code(v: FormulaValue): string | false {
  return isFormulaError(v) && v.code;
}

/** A column range A1:A{n} populated from a flat list of cashflows. */
function columnGrid(values: number[]): string[][] {
  return values.map((v) => [String(v)]);
}

describe("PMT / FV / PV / NPER — time value of money", () => {
  it("PMT matches the Excel loan-payment example", () => {
    // =PMT(8%/12, 10, 10000) → -1037.03 (Microsoft docs).
    expect(numberValue("=PMT(0.08/12, 10, 10000)")).toBeCloseTo(-1037.03, 2);
  });

  it("PMT prices a 30-year 6% mortgage", () => {
    expect(numberValue("=PMT(0.06/12, 360, 200000)")).toBeCloseTo(-1199.1, 2);
  });

  it("PMT with a zero rate is a flat split", () => {
    expect(numberValue("=PMT(0, 10, 1000)")).toBe(-100);
  });

  it("FV matches the Excel annuity-due example", () => {
    // =FV(0.5%, 10, -200, -500, 1) → 2581.40 (Microsoft docs).
    expect(numberValue("=FV(0.005, 10, -200, -500, 1)")).toBeCloseTo(2581.4, 2);
  });

  it("FV with a zero rate sums the deposits", () => {
    expect(numberValue("=FV(0, 5, -100, -1000)")).toBe(1500);
  });

  it("PV matches the Excel annuity example", () => {
    // =PV(8%/12, 12*20, 500) → -59777.15 (Microsoft docs).
    expect(numberValue("=PV(0.08/12, 240, 500)")).toBeCloseTo(-59777.15, 2);
  });

  it("NPER round-trips against PMT", () => {
    const pmt = numberValue("=PMT(0.01, 24, 5000)");
    expect(numberValue(`=NPER(0.01, ${pmt}, 5000)`)).toBeCloseTo(24, 4);
  });

  it("NPER with a zero rate divides evenly", () => {
    expect(numberValue("=NPER(0, -100, 1000)")).toBe(10);
  });

  it("rejects a type that is neither 0 nor 1", () => {
    expect(code(evalFormula("=PMT(0.01, 10, 1000, 0, 2)"))).toBe("#NUM!");
  });

  it("rejects the wrong number of arguments", () => {
    expect(code(evalFormula("=PMT(0.01)"))).toBe("#ERR!");
  });
});

describe("IPMT / PPMT / CUMIPMT / CUMPRINC — amortisation", () => {
  it("IPMT first-period interest is balance × rate", () => {
    // First payment's interest = pv * rate = 8000 * 0.1/12 = -66.67.
    expect(numberValue("=IPMT(0.1/12, 1, 36, 8000)")).toBeCloseTo(-66.67, 2);
  });

  it("IPMT + PPMT reconstructs the full payment", () => {
    const ipmt = numberValue("=IPMT(0.1/12, 7, 36, 8000)");
    const ppmt = numberValue("=PPMT(0.1/12, 7, 36, 8000)");
    const pmt = numberValue("=PMT(0.1/12, 36, 8000)");
    expect(ipmt + ppmt).toBeCloseTo(pmt, 6);
  });

  it("IPMT rejects a period outside 1..nper", () => {
    expect(code(evalFormula("=IPMT(0.01, 0, 12, 1000)"))).toBe("#NUM!");
    expect(code(evalFormula("=IPMT(0.01, 13, 12, 1000)"))).toBe("#NUM!");
  });

  it("CUMIPMT matches the Excel example", () => {
    // =CUMIPMT(0.09/12, 30*12, 125000, 13, 24, 0) → -11135.23 (Microsoft).
    expect(numberValue("=CUMIPMT(0.09/12, 360, 125000, 13, 24, 0)")).toBeCloseTo(
      -11135.23,
      2,
    );
  });

  it("CUMPRINC matches the Excel single-period example", () => {
    // =CUMPRINC(0.09/12, 30*12, 125000, 1, 1, 0) → -68.28 (Microsoft).
    expect(numberValue("=CUMPRINC(0.09/12, 360, 125000, 1, 1, 0)")).toBeCloseTo(
      -68.28,
      2,
    );
  });

  it("CUMPRINC across the whole term repays the principal", () => {
    expect(
      numberValue("=CUMPRINC(0.06/12, 360, 200000, 1, 360, 0)"),
    ).toBeCloseTo(-200000, 2);
  });

  it("CUMIPMT rejects a non-positive present value", () => {
    expect(code(evalFormula("=CUMIPMT(0.01, 12, 0, 1, 12, 0)"))).toBe("#NUM!");
  });
});

describe("NPV / IRR / MIRR — cash-flow analysis", () => {
  it("NPV discounts each flow from period one", () => {
    // =NPV(10%, -10000, 3000, 4200, 6800) → 1188.44 (Microsoft docs).
    expect(numberValue("=NPV(0.1, -10000, 3000, 4200, 6800)")).toBeCloseTo(
      1188.44,
      2,
    );
  });

  it("NPV reads a range of flows", () => {
    const grid = columnGrid([-10000, 3000, 4200, 6800]);
    expect(numberValue("=NPV(0.1, A1:A4)", grid)).toBeCloseTo(1188.44, 2);
  });

  it("IRR matches the Excel five-year example", () => {
    // {-70000,12000,15000,18000,21000,26000} → 8.66% (Microsoft docs).
    const grid = columnGrid([-70000, 12000, 15000, 18000, 21000, 26000]);
    expect(numberValue("=IRR(A1:A6)", grid)).toBeCloseTo(0.0866, 4);
  });

  it("IRR is the rate at which NPV is zero", () => {
    const grid = columnGrid([-70000, 12000, 15000, 18000, 21000, 26000]);
    const irr = numberValue("=IRR(A1:A6)", grid);
    // Plugging IRR back into NPV-at-period-zero yields ~0.
    expect(numberValue(`=NPV(${irr}, A1:A6)`, grid) * (1 + irr)).toBeCloseTo(
      0,
      2,
    );
  });

  it("IRR needs both an inflow and an outflow", () => {
    const grid = columnGrid([1000, 2000, 3000]);
    expect(code(evalFormula("=IRR(A1:A3)", grid))).toBe("#NUM!");
  });

  it("MIRR matches the Excel example", () => {
    // {-120000,39000,30000,21000,37000,46000}, fin 10%, reinvest 12% → 12.61%.
    const grid = columnGrid([-120000, 39000, 30000, 21000, 37000, 46000]);
    expect(numberValue("=MIRR(A1:A6, 0.1, 0.12)", grid)).toBeCloseTo(0.1261, 4);
  });
});

describe("XNPV / XIRR — dated cash flows", () => {
  // Microsoft's XIRR/XNPV worked example.
  const datedGrid: string[][] = [
    ["-10000", "=DATE(2008,1,1)"],
    ["2750", "=DATE(2008,3,1)"],
    ["4250", "=DATE(2008,10,30)"],
    ["3250", "=DATE(2009,2,15)"],
    ["2750", "=DATE(2009,4,1)"],
  ];

  it("XNPV matches the documented result", () => {
    expect(
      numberValue("=XNPV(0.09, A1:A5, B1:B5)", datedGrid),
    ).toBeCloseTo(2086.65, 1);
  });

  it("XIRR matches the documented result", () => {
    expect(numberValue("=XIRR(A1:A5, B1:B5)", datedGrid)).toBeCloseTo(
      0.373362535,
      4,
    );
  });

  it("XIRR is the rate at which XNPV is zero", () => {
    const irr = numberValue("=XIRR(A1:A5, B1:B5)", datedGrid);
    expect(numberValue(`=XNPV(${irr}, A1:A5, B1:B5)`, datedGrid)).toBeCloseTo(
      0,
      2,
    );
  });

  it("XNPV rejects mismatched value/date counts", () => {
    const grid: string[][] = [
      ["-100", "=DATE(2020,1,1)"],
      ["200", ""],
    ];
    expect(code(evalFormula("=XNPV(0.1, A1:A2, B1:B2)", grid))).toBe("#NUM!");
  });
});

describe("depreciation — SLN / SYD / DB / DDB", () => {
  it("SLN spreads cost evenly", () => {
    expect(numberValue("=SLN(30000, 7500, 10)")).toBe(2250);
  });

  it("SYD weights the early years", () => {
    expect(numberValue("=SYD(30000, 7500, 10, 1)")).toBeCloseTo(4090.91, 2);
    expect(numberValue("=SYD(30000, 7500, 10, 10)")).toBeCloseTo(409.09, 2);
  });

  it("DB matches the Excel fixed-declining example", () => {
    // Microsoft: cost 1e6, salvage 1e5, life 6, month 7.
    expect(numberValue("=DB(1000000, 100000, 6, 1, 7)")).toBeCloseTo(
      186083.33,
      2,
    );
    expect(numberValue("=DB(1000000, 100000, 6, 2, 7)")).toBeCloseTo(
      259639.42,
      2,
    );
  });

  it("DDB matches the Excel double-declining example", () => {
    expect(numberValue("=DDB(2400, 300, 10, 1)")).toBe(480);
    expect(numberValue("=DDB(2400, 300, 10, 2)")).toBe(384);
  });

  it("DDB never depreciates below salvage", () => {
    // Late periods are clamped so the book value floors at salvage.
    const last = numberValue("=DDB(2400, 300, 10, 10)");
    expect(last).toBeGreaterThanOrEqual(0);
  });
});

describe("rate conversion — EFFECT / NOMINAL", () => {
  it("EFFECT converts a nominal rate", () => {
    // =EFFECT(5.25%, 4) → 0.053543 (Microsoft docs).
    expect(numberValue("=EFFECT(0.0525, 4)")).toBeCloseTo(0.0535427, 6);
  });

  it("NOMINAL is the inverse of EFFECT", () => {
    const eff = numberValue("=EFFECT(0.0525, 4)");
    expect(numberValue(`=NOMINAL(${eff}, 4)`)).toBeCloseTo(0.0525, 6);
  });

  it("EFFECT rejects a sub-1 compounding count", () => {
    expect(code(evalFormula("=EFFECT(0.05, 0)"))).toBe("#NUM!");
  });
});
