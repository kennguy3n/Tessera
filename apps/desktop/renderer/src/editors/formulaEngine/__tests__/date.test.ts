/**
 * vitest coverage for `functions/date.ts`.
 *
 * Tests pin `EvaluationContext.now` to a fixed instant so
 * `TODAY()` / `NOW()` assertions are stable, and exercise the
 * Excel-1900-epoch serial-number arithmetic.
 */
import { describe, expect, it } from "vitest";

import {
  dateToSerial,
  evaluateFormulaString,
  isFormulaError,
  serialToDate,
  type CellResolver,
  type FormulaValue,
} from "../";

function emptyResolver(): CellResolver {
  return { getRaw: () => undefined, getEvaluated: () => null };
}

function evalAt(expr: string, when?: Date): FormulaValue {
  return evaluateFormulaString(expr, emptyResolver(), {
    now: when ? () => when : undefined,
  });
}

describe("Excel serial conversion", () => {
  it("dateToSerial round-trips through serialToDate", () => {
    const d = new Date(Date.UTC(2024, 0, 15, 12, 30, 0));
    const s = dateToSerial(d);
    const back = serialToDate(s);
    expect(back.toISOString()).toBe(d.toISOString());
  });
  it("serial 1 is 1900-01-01 (Excel epoch)", () => {
    expect(serialToDate(1).toISOString()).toBe("1900-01-01T00:00:00.000Z");
  });
  it("serial 60 collapses to 1900-02-28 (phantom day)", () => {
    // Excel pretends 1900 has a leap day at serial 60 — JS can't
    // represent the impossible 1900-02-29, so the phantom collapses
    // onto the real 1900-02-28 (matches OOXML reader convention).
    expect(serialToDate(60).toISOString()).toBe("1900-02-28T00:00:00.000Z");
  });
  it("serial 61 is real 1900-03-01 (post-leap-bug compensation)", () => {
    expect(serialToDate(61).toISOString()).toBe("1900-03-01T00:00:00.000Z");
  });
});

describe("TODAY / NOW", () => {
  it("TODAY returns midnight UTC of the pinned clock", () => {
    const fixed = new Date(Date.UTC(2024, 0, 15, 18, 45, 0));
    const v = evalAt("=TODAY()", fixed);
    expect(typeof v).toBe("number");
    const back = serialToDate(v as number);
    expect(back.toISOString()).toBe("2024-01-15T00:00:00.000Z");
  });
  it("NOW preserves full precision", () => {
    const fixed = new Date(Date.UTC(2024, 0, 15, 18, 45, 30));
    const v = evalAt("=NOW()", fixed);
    expect(typeof v).toBe("number");
    const back = serialToDate(v as number);
    expect(back.toISOString()).toBe("2024-01-15T18:45:30.000Z");
  });
});

describe("DATE / YEAR / MONTH / DAY", () => {
  it("DATE builds the right serial", () => {
    const v = evalAt("=DATE(2024,1,15)");
    expect(serialToDate(v as number).toISOString()).toBe(
      "2024-01-15T00:00:00.000Z",
    );
  });
  it("DATE rolls overflow months", () => {
    const v = evalAt("=DATE(2024,13,1)");
    expect(serialToDate(v as number).toISOString()).toBe(
      "2025-01-01T00:00:00.000Z",
    );
  });
  it("YEAR / MONTH / DAY pull the components", () => {
    expect(evalAt("=YEAR(DATE(2024,3,9))")).toBe(2024);
    expect(evalAt("=MONTH(DATE(2024,3,9))")).toBe(3);
    expect(evalAt("=DAY(DATE(2024,3,9))")).toBe(9);
  });
});

describe("DATEDIF", () => {
  it("Y unit returns whole years", () => {
    expect(evalAt('=DATEDIF(DATE(2020,3,1), DATE(2024,2,28), "Y")')).toBe(3);
  });
  it("M unit returns whole months", () => {
    expect(evalAt('=DATEDIF(DATE(2024,1,1), DATE(2024,4,15), "M")')).toBe(3);
  });
  it("D unit returns whole days", () => {
    expect(evalAt('=DATEDIF(DATE(2024,1,1), DATE(2024,1,11), "D")')).toBe(10);
  });
  it("rejects unknown unit", () => {
    const v = evalAt('=DATEDIF(DATE(2024,1,1), DATE(2024,1,2), "Q")');
    expect(isFormulaError(v) && v.code).toBe("#VALUE!");
  });
});

describe("DATEVALUE", () => {
  it("parses ISO format", () => {
    const v = evalAt('=DATEVALUE("2024-01-15")');
    expect(serialToDate(v as number).toISOString()).toBe(
      "2024-01-15T00:00:00.000Z",
    );
  });
  it("returns #VALUE! on garbage", () => {
    const v = evalAt('=DATEVALUE("not a date")');
    expect(isFormulaError(v) && v.code).toBe("#VALUE!");
  });
});

describe("Date arithmetic via serial", () => {
  it("=DATE(2024,1,1)+30 advances 30 days", () => {
    const v = evalAt("=DATE(2024,1,1)+30");
    expect(serialToDate(v as number).toISOString()).toBe(
      "2024-01-31T00:00:00.000Z",
    );
  });
});
