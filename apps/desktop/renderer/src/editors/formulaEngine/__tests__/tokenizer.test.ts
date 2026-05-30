/**
 * Phase 16 Task 1 — tokenizer tests.
 *
 * 30+ explicit cases pinning the documented grammar:
 *   - numbers (integer, decimal, leading-dot, scientific notation,
 *     scientific notation with explicit sign)
 *   - strings (plain, doubled-quote escape, internal newline)
 *   - booleans (case-insensitive)
 *   - cell references (relative, absolute-col, absolute-row,
 *     fully-absolute, multi-letter columns AA1, ZZ100)
 *   - range punctuation (`:`) emitted as a COLON token
 *   - function names (identifier followed by `(`, with optional
 *     whitespace between)
 *   - operators (single and multi-character)
 *   - whitespace handling
 *   - error tokens for unterminated string and illegal character
 *   - that the leading `=` is stripped
 */
import { describe, it, expect } from "vitest";

import { tokenize, type Token } from "../tokenizer";

function types(input: string): string[] {
  return tokenize(input)
    .filter((t) => t.type !== "EOF")
    .map((t) => t.type);
}

function firstNonEof(input: string): Token {
  const ts = tokenize(input).filter((t) => t.type !== "EOF");
  return ts[0];
}

describe("tokenize — numbers", () => {
  it("scans an integer literal", () => {
    const t = firstNonEof("12");
    expect(t.type).toBe("NUMBER");
    expect(t.value).toBe(12);
  });
  it("scans a decimal literal", () => {
    expect(firstNonEof("12.5").value).toBe(12.5);
  });
  it("scans a leading-dot decimal", () => {
    expect(firstNonEof(".25").value).toBe(0.25);
  });
  it("scans scientific notation", () => {
    expect(firstNonEof("1e3").value).toBe(1000);
  });
  it("scans scientific notation with explicit + sign in exponent", () => {
    expect(firstNonEof("2.5E+2").value).toBe(250);
  });
  it("scans scientific notation with negative exponent", () => {
    expect(firstNonEof("1.5e-2").value).toBe(0.015);
  });
  it("does NOT consume a leading minus into the number", () => {
    expect(types("-1")).toEqual(["OPERATOR", "NUMBER"]);
  });
  it("flags an exponent with no digits as an ERROR", () => {
    expect(types("1e")).toContain("ERROR");
  });
});

describe("tokenize — strings", () => {
  it("scans a plain string literal", () => {
    expect(firstNonEof('"hello"').value).toBe("hello");
  });
  it("decodes doubled-quote escapes", () => {
    expect(firstNonEof('"He said ""hi"""').value).toBe('He said "hi"');
  });
  it("preserves embedded newlines", () => {
    expect(firstNonEof('"a\nb"').value).toBe("a\nb");
  });
  it("flags an unterminated string as ERROR", () => {
    expect(types('"unterminated')).toContain("ERROR");
  });
});

describe("tokenize — booleans", () => {
  it("scans TRUE", () => {
    expect(firstNonEof("TRUE").value).toBe(true);
  });
  it("scans FALSE case-insensitively", () => {
    expect(firstNonEof("False").value).toBe(false);
  });
});

describe("tokenize — cell references", () => {
  it("scans a relative A1 reference", () => {
    const t = firstNonEof("A1");
    expect(t.type).toBe("CELL_REF");
    expect(t.cellRef).toEqual({
      absoluteCol: false,
      absoluteRow: false,
      col: 0,
      row: 0,
    });
  });
  it("scans an absolute $A$1 reference", () => {
    const t = firstNonEof("$A$1");
    expect(t.cellRef).toEqual({
      absoluteCol: true,
      absoluteRow: true,
      col: 0,
      row: 0,
    });
  });
  it("scans a mixed $A1 reference", () => {
    const t = firstNonEof("$A1");
    expect(t.cellRef).toEqual({
      absoluteCol: true,
      absoluteRow: false,
      col: 0,
      row: 0,
    });
  });
  it("scans a mixed A$1 reference", () => {
    const t = firstNonEof("A$1");
    expect(t.cellRef).toEqual({
      absoluteCol: false,
      absoluteRow: true,
      col: 0,
      row: 0,
    });
  });
  it("scans a multi-letter column AA1", () => {
    expect(firstNonEof("AA1").cellRef).toMatchObject({ col: 26, row: 0 });
  });
  it("scans ZZ100", () => {
    expect(firstNonEof("ZZ100").cellRef).toMatchObject({ col: 701, row: 99 });
  });
  it("uppercases lower-case column letters", () => {
    expect(firstNonEof("aa1").cellRef).toMatchObject({ col: 26, row: 0 });
  });
});

describe("tokenize — function calls and identifiers", () => {
  it("recognises an identifier followed by `(` as FUNCTION_NAME", () => {
    expect(types("SUM(1,2)")).toEqual([
      "FUNCTION_NAME",
      "LPAREN",
      "NUMBER",
      "COMMA",
      "NUMBER",
      "RPAREN",
    ]);
  });
  it("tolerates whitespace between name and `(`", () => {
    expect(firstNonEof("SUM (1)").type).toBe("FUNCTION_NAME");
  });
  it("uppercases the function name", () => {
    expect(firstNonEof("sum(1)").value).toBe("SUM");
  });
  it("emits bare identifiers when no `(` follows", () => {
    expect(firstNonEof("MyRange").type).toBe("IDENTIFIER");
  });
});

describe("tokenize — operators", () => {
  it("scans single-character operators", () => {
    expect(types("+ - * / ^ & =")).toEqual(Array(7).fill("OPERATOR"));
  });
  it("scans <>, <=, >= as one token each", () => {
    expect(types("<>")).toEqual(["OPERATOR"]);
    expect(types("<=")).toEqual(["OPERATOR"]);
    expect(types(">=")).toEqual(["OPERATOR"]);
  });
  it("scans bare < and > as one token each", () => {
    expect(types("< >")).toEqual(["OPERATOR", "OPERATOR"]);
  });
  it("scans % as its own PERCENT token", () => {
    expect(types("50%")).toEqual(["NUMBER", "PERCENT"]);
  });
});

describe("tokenize — punctuation and ranges", () => {
  it("emits LPAREN, RPAREN, COMMA, COLON", () => {
    expect(types("(,):")).toEqual(["LPAREN", "COMMA", "RPAREN", "COLON"]);
  });
  it("scans a range expression as CELL_REF COLON CELL_REF", () => {
    expect(types("A1:B5")).toEqual(["CELL_REF", "COLON", "CELL_REF"]);
  });
});

describe("tokenize — whitespace and prefix", () => {
  it("strips a leading =", () => {
    expect(types("=1+2")).toEqual(["NUMBER", "OPERATOR", "NUMBER"]);
  });
  it("ignores interior whitespace", () => {
    expect(types("  1  +  2  ")).toEqual(["NUMBER", "OPERATOR", "NUMBER"]);
  });
});

describe("tokenize — error recovery", () => {
  it("emits an ERROR token on an illegal character, followed by EOF", () => {
    // The tokenizer halts on the first illegal character but still
    // appends an EOF sentinel so downstream `peek()`/`expect()` style
    // helpers don't index past the array (parser short-circuits on
    // ERROR before the EOF matters, but defensive consumers such as
    // the formula-bar autocomplete benefit from the invariant).
    const ts = tokenize("1 ` 2");
    expect(ts[ts.length - 2].type).toBe("ERROR");
    expect(ts[ts.length - 1].type).toBe("EOF");
  });

  it("appends EOF after an unterminated string literal's ERROR", () => {
    const ts = tokenize('"unterminated');
    expect(ts[ts.length - 2].type).toBe("ERROR");
    expect(ts[ts.length - 1].type).toBe("EOF");
  });

  it("appends EOF after an unterminated sheet-quoted literal's ERROR", () => {
    const ts = tokenize("'Sheet without close!A1");
    expect(ts[ts.length - 2].type).toBe("ERROR");
    expect(ts[ts.length - 1].type).toBe("EOF");
  });

  it("appends EOF after a row-zero cell-ref's ERROR", () => {
    const ts = tokenize("A0");
    expect(ts[ts.length - 2].type).toBe("ERROR");
    expect(ts[ts.length - 1].type).toBe("EOF");
  });
});
