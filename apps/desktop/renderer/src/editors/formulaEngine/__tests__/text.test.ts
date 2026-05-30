/**
 * Phase 16 Task 9 — vitest coverage for `functions/text.ts`.
 *
 * Each function has at least two cases: a happy path plus an edge
 * case (boundary, error, optional arg). Tests evaluate full
 * formulas through the public `evaluateFormulaString` facade so
 * the parser, evaluator, and registry merge are all exercised.
 */
import { describe, expect, it } from "vitest";

import {
  evaluateFormulaString,
  isFormulaError,
  type CellResolver,
  type FormulaValue,
} from "../";

function emptyResolver(): CellResolver {
  return { getRaw: () => undefined, getEvaluated: () => null };
}

function evalFormula(expr: string): FormulaValue {
  return evaluateFormulaString(expr, emptyResolver());
}

describe("CONCATENATE / CONCAT", () => {
  it("concatenates strings and numbers", () => {
    expect(evalFormula('=CONCATENATE("a", 1, "b")')).toBe("a1b");
  });
  it("rejects ranges (Excel 2010+)", () => {
    const res = evaluateFormulaString("=CONCATENATE(A1:A2)", emptyResolver());
    expect(isFormulaError(res) && res.code).toBe("#VALUE!");
  });
  it("CONCAT flattens single-cell args", () => {
    expect(evalFormula('=CONCAT("x", "y", "z")')).toBe("xyz");
  });
});

describe("LEFT / RIGHT / MID", () => {
  it("LEFT with explicit count", () => {
    expect(evalFormula('=LEFT("hello", 3)')).toBe("hel");
  });
  it("LEFT defaults to 1 character", () => {
    expect(evalFormula('=LEFT("hello")')).toBe("h");
  });
  it("RIGHT respects count larger than string length", () => {
    expect(evalFormula('=RIGHT("abc", 99)')).toBe("abc");
  });
  it("MID extracts substring", () => {
    expect(evalFormula('=MID("abcdef", 2, 3)')).toBe("bcd");
  });
  it("MID returns empty when start past end", () => {
    expect(evalFormula('=MID("abc", 10, 3)')).toBe("");
  });
});

describe("LEN / UPPER / LOWER / TRIM", () => {
  it("LEN counts UTF-16 code units", () => {
    expect(evalFormula('=LEN("hello")')).toBe(5);
  });
  it("UPPER folds case", () => {
    expect(evalFormula('=UPPER("Hello")')).toBe("HELLO");
  });
  it("LOWER folds case", () => {
    expect(evalFormula('=LOWER("HELLO")')).toBe("hello");
  });
  it("TRIM collapses internal whitespace", () => {
    expect(evalFormula('=TRIM("  hello   world  ")')).toBe("hello world");
  });
});

describe("SUBSTITUTE", () => {
  it("replaces all occurrences by default", () => {
    expect(evalFormula('=SUBSTITUTE("a.b.c", ".", "/")')).toBe("a/b/c");
  });
  it("replaces only the nth occurrence", () => {
    expect(evalFormula('=SUBSTITUTE("a.b.c", ".", "/", 2)')).toBe("a.b/c");
  });
});

describe("FIND / SEARCH", () => {
  it("FIND is case-sensitive and 1-based", () => {
    expect(evalFormula('=FIND("b", "abc")')).toBe(2);
  });
  it("FIND returns #VALUE! when missing", () => {
    const res = evalFormula('=FIND("z", "abc")');
    expect(isFormulaError(res) && res.code).toBe("#VALUE!");
  });
  it("SEARCH is case-insensitive", () => {
    expect(evalFormula('=SEARCH("B", "abc")')).toBe(2);
  });
  it("SEARCH respects ? wildcard", () => {
    expect(evalFormula('=SEARCH("a?c", "xabcy")')).toBe(2);
  });
});

describe("TEXT", () => {
  it("formats integers with thousands separator", () => {
    expect(evalFormula('=TEXT(1234567, "#,##0")')).toBe("1,234,567");
  });
  it("formats decimals", () => {
    expect(evalFormula('=TEXT(3.14159, "0.00")')).toBe("3.14");
  });
  it("renders percentages", () => {
    expect(evalFormula('=TEXT(0.25, "0%")')).toBe("25%");
  });
  it("renders Excel dates", () => {
    // 45292 = 2024-01-01 in Excel serial. DATE() converts at the
    // edge so the test stays readable.
    expect(evalFormula('=TEXT(DATE(2024,1,15), "yyyy-mm-dd")')).toBe(
      "2024-01-15",
    );
  });
  // Regression: PR 76 review flagged that the standalone formatDate
  // in text.ts had no `sawHour` flag, so `mm` after `hh` rendered the
  // month instead of the minute. We now delegate to the shared
  // engine in `format.ts` which disambiguates correctly.
  it("disambiguates mm as minutes after an hour token", () => {
    // 2024-03-15 14:07:09 UTC → Excel serial with a fractional day.
    // DATE+ fractional time built via TIME-equivalent literal arithmetic:
    // 14:07:09 = (14*3600 + 7*60 + 9) / 86400.
    const time = (14 * 3600 + 7 * 60 + 9) / 86400;
    const out = evalFormula(`=TEXT(DATE(2024,3,15)+${time}, "hh:mm:ss")`);
    expect(out).toBe("14:07:09");
  });
  it("preserves mm as month when not preceded by hour", () => {
    expect(evalFormula('=TEXT(DATE(2024,3,15), "yyyy-mm-dd")')).toBe(
      "2024-03-15",
    );
  });
  it("renders AM/PM tokens", () => {
    const morning = (9 * 3600) / 86400;
    const evening = (21 * 3600) / 86400;
    expect(evalFormula(`=TEXT(DATE(2024,1,1)+${morning}, "h AM/PM")`)).toBe(
      "9 AM",
    );
    expect(evalFormula(`=TEXT(DATE(2024,1,1)+${evening}, "h AM/PM")`)).toBe(
      "21 PM",
    );
  });
});

describe("VALUE", () => {
  it("parses a numeric string", () => {
    expect(evalFormula('=VALUE("123.45")')).toBe(123.45);
  });
  it("strips $ and , and parses %", () => {
    expect(evalFormula('=VALUE("$1,234")')).toBe(1234);
    expect(evalFormula('=VALUE("50%")')).toBe(0.5);
  });
  it("returns #VALUE! on garbage", () => {
    const res = evalFormula('=VALUE("abc")');
    expect(isFormulaError(res) && res.code).toBe("#VALUE!");
  });
});
