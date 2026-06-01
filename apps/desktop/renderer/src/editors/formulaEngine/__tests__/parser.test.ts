/**
 * parser tests.
 *
 * 20+ formulas asserting the produced AST follows the documented
 * precedence ladder. We use `JSON.stringify` to make the assertions
 * compact and easy to read; for property-level checks (e.g.
 * `range.start.row`) we navigate the AST manually.
 */
import { describe, it, expect } from "vitest";

import { parseFormula, type AstNode } from "../parser";

function parse(src: string): AstNode {
  const r = parseFormula(src);
  if (!r.ok) throw new Error(`parse failed: ${r.code} ${r.message}`);
  return r.ast;
}

describe("parser — literals", () => {
  it("parses a number literal", () => {
    expect(parse("42")).toEqual({ type: "number", value: 42 });
  });
  it("parses a string literal", () => {
    expect(parse('"hi"')).toEqual({ type: "string", value: "hi" });
  });
  it("parses a boolean", () => {
    expect(parse("TRUE")).toEqual({ type: "boolean", value: true });
  });
  it("treats an empty formula as 0", () => {
    expect(parse("")).toEqual({ type: "number", value: 0 });
  });
});

describe("parser — arithmetic precedence", () => {
  it("multiplies before adding", () => {
    expect(parse("1+2*3")).toEqual({
      type: "binary",
      op: "+",
      left: { type: "number", value: 1 },
      right: {
        type: "binary",
        op: "*",
        left: { type: "number", value: 2 },
        right: { type: "number", value: 3 },
      },
    });
  });
  it("respects parentheses", () => {
    expect(parse("(1+2)*3")).toEqual({
      type: "binary",
      op: "*",
      left: {
        type: "binary",
        op: "+",
        left: { type: "number", value: 1 },
        right: { type: "number", value: 2 },
      },
      right: { type: "number", value: 3 },
    });
  });
  it("power is right-associative", () => {
    // `2^3^2` should parse as `2^(3^2) = 2^9 = 512`, not `(2^3)^2 = 64`.
    expect(parse("2^3^2")).toEqual({
      type: "binary",
      op: "^",
      left: { type: "number", value: 2 },
      right: {
        type: "binary",
        op: "^",
        left: { type: "number", value: 3 },
        right: { type: "number", value: 2 },
      },
    });
  });
  it("subtraction is left-associative", () => {
    expect(parse("10-3-2")).toEqual({
      type: "binary",
      op: "-",
      left: {
        type: "binary",
        op: "-",
        left: { type: "number", value: 10 },
        right: { type: "number", value: 3 },
      },
      right: { type: "number", value: 2 },
    });
  });
  it("parses unary minus", () => {
    expect(parse("-5")).toEqual({
      type: "unary",
      op: "-",
      operand: { type: "number", value: 5 },
    });
  });
  it("parses postfix percent", () => {
    expect(parse("50%")).toEqual({
      type: "unary",
      op: "%",
      operand: { type: "number", value: 50 },
    });
  });
});

describe("parser — concatenation and comparison", () => {
  it("concatenation binds looser than addition", () => {
    expect(parse('"a"&1+2')).toEqual({
      type: "binary",
      op: "&",
      left: { type: "string", value: "a" },
      right: {
        type: "binary",
        op: "+",
        left: { type: "number", value: 1 },
        right: { type: "number", value: 2 },
      },
    });
  });
  it("comparison binds looser than concatenation", () => {
    expect(parse('"a"&1=2')).toMatchObject({
      type: "binary",
      op: "=",
      left: { type: "binary", op: "&" },
      right: { type: "number", value: 2 },
    });
  });
});

describe("parser — cell and range references", () => {
  it("parses a cell reference", () => {
    expect(parse("$A$1")).toEqual({
      type: "cell",
      row: 0,
      col: 0,
      absoluteRow: true,
      absoluteCol: true,
    });
  });
  it("parses a range reference and normalises endpoints", () => {
    const ast = parse("B5:A1");
    expect(ast).toMatchObject({
      type: "range",
      start: { row: 0, col: 0 },
      end: { row: 4, col: 1 },
    });
  });
  it("rejects a colon without a second cell ref", () => {
    const r = parseFormula("A1:");
    expect(r.ok).toBe(false);
  });
});

describe("parser — function calls", () => {
  it("parses zero-arg function call", () => {
    expect(parse("TODAY()")).toEqual({
      type: "function",
      name: "TODAY",
      args: [],
    });
  });
  it("parses single-arg function call", () => {
    expect(parse("ABS(-5)")).toMatchObject({
      type: "function",
      name: "ABS",
      args: [{ type: "unary", op: "-" }],
    });
  });
  it("parses multi-arg function call", () => {
    const ast = parse("IF(A1>0, A1, -A1)");
    expect(ast.type).toBe("function");
    if (ast.type === "function") {
      expect(ast.name).toBe("IF");
      expect(ast.args).toHaveLength(3);
    }
  });
  it("parses nested function calls", () => {
    const ast = parse("SUM(A1:A5, IF(B1>0, 1, 0))");
    expect(ast.type).toBe("function");
    if (ast.type === "function") {
      expect(ast.name).toBe("SUM");
      expect(ast.args[1].type).toBe("function");
    }
  });
});

describe("parser — error reporting", () => {
  it("reports a #ERR on unbalanced parens", () => {
    const r = parseFormula("(1+2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("#ERR!");
  });
  it("reports a #ERR on consecutive operators", () => {
    const r = parseFormula("1++");
    expect(r.ok).toBe(false);
  });
  it("reports trailing garbage", () => {
    const r = parseFormula("1+2 3");
    expect(r.ok).toBe(false);
  });
});
