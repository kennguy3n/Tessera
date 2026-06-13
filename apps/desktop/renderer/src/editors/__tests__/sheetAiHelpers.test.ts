/**
 * Coverage for the on-device AI assistant's pure helpers: prompt
 * construction (bounded context), formula extraction from messy model
 * output, and the validate-before-insert chokepoint.
 */
import { describe, expect, it } from "vitest";

import {
  buildContext,
  buildExplainPrompt,
  buildFixPrompt,
  buildFormulaPrompt,
  buildSummarizePrompt,
  columnLetter,
  ensureLeadingEquals,
  extractFormula,
  MAX_CELL_CHARS,
  MAX_SAMPLE_ROWS,
  renderContextTable,
  validateGeneratedFormula,
} from "../sheetAiHelpers";

describe("columnLetter", () => {
  it("maps indices to spreadsheet letters", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
  });
});

describe("buildContext", () => {
  it("bounds the sample to MAX_SAMPLE_ROWS", () => {
    const rows = Array.from({ length: 100 }, (_, i) => [String(i)]);
    const ctx = buildContext(["A"], rows);
    expect(ctx.sampleRows.length).toBe(MAX_SAMPLE_ROWS);
  });
});

describe("renderContextTable", () => {
  it("labels columns with letter + header and clamps long cells", () => {
    const long = "x".repeat(200);
    const ctx = buildContext(["Name", "Amount"], [["Alice", long]], {});
    const table = renderContextTable(ctx);
    expect(table).toContain("A (Name)");
    expect(table).toContain("B (Amount)");
    // The 200-char cell must be truncated to the cap.
    expect(table).not.toContain(long);
    expect(table.includes("…")).toBe(true);
    expect(table.length).toBeLessThan(long.length + MAX_CELL_CHARS);
  });
  it("handles an empty sheet", () => {
    expect(renderContextTable(buildContext([], []))).toBe("(empty sheet)");
  });
});

describe("prompt builders", () => {
  const ctx = buildContext(["Item", "Status", "Amount"], [["a", "paid", "10"]], {
    activeCellRef: "D2",
    selectionRef: "A1:C10",
  });
  it("formula prompt embeds request, context and the bare-formula rule", () => {
    const p = buildFormulaPrompt("sum amount where status is paid", ctx);
    expect(p).toContain("sum amount where status is paid");
    expect(p).toContain("D2");
    expect(p).toContain("Status");
    expect(p).toMatch(/single line/i);
  });
  it("explain prompt includes the formula with a leading =", () => {
    expect(buildExplainPrompt("SUM(A1:A3)")).toContain("=SUM(A1:A3)");
  });
  it("fix prompt mentions the error code when supplied", () => {
    expect(buildFixPrompt("=A1/B1", "#DIV/0!")).toContain("#DIV/0!");
    expect(buildFixPrompt("=A1")).toMatch(/not behaving/i);
  });
  it("summarize prompt references the selection range", () => {
    expect(buildSummarizePrompt(ctx)).toContain("A1:C10");
  });
});

describe("ensureLeadingEquals", () => {
  it("adds = only when missing", () => {
    expect(ensureLeadingEquals("A1+1")).toBe("=A1+1");
    expect(ensureLeadingEquals("=A1+1")).toBe("=A1+1");
    expect(ensureLeadingEquals("  SUM(A1:A2) ")).toBe("=SUM(A1:A2)");
  });
});

describe("extractFormula", () => {
  it("returns the bare formula line", () => {
    expect(extractFormula("=SUM(A1:A10)")).toBe("=SUM(A1:A10)");
  });
  it("unwraps a fenced code block", () => {
    expect(extractFormula("```\n=AVERAGE(B1:B5)\n```")).toBe("=AVERAGE(B1:B5)");
    expect(extractFormula("```excel\n=A1*B1\n```")).toBe("=A1*B1");
  });
  it("skips leading prose and finds the formula line", () => {
    const out = "Here is the formula you asked for:\n=SUMIF(C:C,\"paid\",B:B)";
    expect(extractFormula(out)).toBe('=SUMIF(C:C,"paid",B:B)');
  });
  it("prepends = to a bare expression answer", () => {
    expect(extractFormula("SUM(A1:A3)")).toBe("=SUM(A1:A3)");
  });
  it("returns null for #UNSUPPORTED and pure prose", () => {
    expect(extractFormula("#UNSUPPORTED")).toBeNull();
    expect(extractFormula("I cannot do that. Try rephrasing.")).toBeNull();
    expect(extractFormula("")).toBeNull();
  });
});

describe("validateGeneratedFormula", () => {
  it("accepts a parseable formula and normalises the leading =", () => {
    const r = validateGeneratedFormula("SUM(A1:A10)");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.formula).toBe("=SUM(A1:A10)");
  });
  it("rejects an unparseable formula with a reason", () => {
    const r = validateGeneratedFormula("=SUM(A1:");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});
