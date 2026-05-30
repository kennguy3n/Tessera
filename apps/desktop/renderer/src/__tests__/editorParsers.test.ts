/**
 * Vitest coverage for the parser/serializer helpers each editor uses
 * to round-trip its content shape.
 *
 * Companion suites already cover:
 *   * BaseEditor view switching + record CRUD via end-to-end render
 *     in `baseViews.test.tsx`.
 *   * InfographicEditor preview HTML in `infographicEditor.test.tsx`.
 *   * LandingPageEditor preview HTML in `landingPageEditor.test.tsx`.
 *   * SlideEditor marp + parse/serialize in `slideEditor.test.ts`.
 *
 * This file pins the remaining helper surface area:
 *   * `parseDocumentContent` — plain-text → `<p>` wrapping vs.
 *     HTML pass-through.
 *   * `parseSheetContent` / `parseCSVLines` / `parseCellRef` /
 *     `evaluateFormula` — sheet content + CSV ingest + cell-ref
 *     decoding + formula evaluation.
 *   * `parseBaseContent` — default shape + JSON round-trip + invalid
 *     payload fallback.
 *
 * The runtime code paths above are exercised by every save/load in
 * the parent component, but they have no test coverage today — a
 * regression here would silently corrupt user data. Each test
 * targets a specific behavioural invariant (not just "function
 * returns something").
 */
import { describe, it, expect } from "vitest";

import { parseDocumentContent } from "../editors/documentEditorHelpers";
import {
  parseSheetContent,
  parseCSVLines,
  parseCellRef,
  evaluateFormula,
} from "../editors/sheetEditorHelpers";
import type { SheetContent } from "../editors/SheetEditor";
import { parseBaseContent } from "../editors/baseEditorHelpers";

// ---------------------------------------------------------------------------
// parseDocumentContent
// ---------------------------------------------------------------------------

describe("parseDocumentContent", () => {
  it("returns a single empty paragraph for empty input", () => {
    expect(parseDocumentContent("")).toBe("<p></p>");
  });

  it("returns HTML input verbatim when it already starts with a tag", () => {
    const html = "<h1>Hello</h1><p>World</p>";
    expect(parseDocumentContent(html)).toBe(html);
  });

  it("treats leading-whitespace HTML as HTML, not plain text", () => {
    const html = "   <h1>Trimmed</h1>";
    // Trimmed via .trim().startsWith — must pass through unmodified.
    expect(parseDocumentContent(html)).toBe(html);
  });

  it("wraps plain text in a single <p> when there are no blank-line separators", () => {
    expect(parseDocumentContent("Just one line.")).toBe("<p>Just one line.</p>");
  });

  it("splits paragraphs on blank-line separators", () => {
    const out = parseDocumentContent("Paragraph one.\n\nParagraph two.\n\nParagraph three.");
    expect(out).toBe(
      "<p>Paragraph one.</p><p>Paragraph two.</p><p>Paragraph three.</p>",
    );
  });

  it("turns single newlines inside a paragraph into <br> tags", () => {
    const out = parseDocumentContent("Line one.\nLine two.");
    expect(out).toBe("<p>Line one.<br>Line two.</p>");
  });

  it("preserves unicode body content verbatim", () => {
    const out = parseDocumentContent("日本語テスト — 中文 — 🔥");
    expect(out).toBe("<p>日本語テスト — 中文 — 🔥</p>");
  });
});

// ---------------------------------------------------------------------------
// parseSheetContent
// ---------------------------------------------------------------------------

describe("parseSheetContent", () => {
  it("returns a 3×3 empty grid for empty input", () => {
    const out = parseSheetContent("");
    expect(out.columns).toEqual(["A", "B", "C"]);
    expect(out.rows).toHaveLength(3);
    expect(out.rows.every((r) => r.length === 3 && r.every((c) => c === ""))).toBe(true);
  });

  it("falls back to the empty grid for non-JSON input", () => {
    const out = parseSheetContent("not json {{{");
    expect(out.columns).toEqual(["A", "B", "C"]);
  });

  it("falls back when JSON is missing the columns key", () => {
    const out = parseSheetContent(JSON.stringify({ rows: [["x"]] }));
    expect(out.columns).toEqual(["A", "B", "C"]);
  });

  it("round-trips a serialized SheetContent", () => {
    const original: SheetContent = {
      columns: ["Owner", "Status", "Due"],
      rows: [
        ["Alice", "Open", "2024-12-01"],
        ["Bob", "Done", "2024-11-15"],
      ],
    };
    const reparsed = parseSheetContent(JSON.stringify(original));
    expect(reparsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// parseCSVLines — RFC 4180 quoting
// ---------------------------------------------------------------------------

describe("parseCSVLines", () => {
  it("parses a single unquoted row into fields", () => {
    expect(parseCSVLines("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("parses multiple rows split on \\n", () => {
    expect(parseCSVLines("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("respects CRLF line endings (Excel default)", () => {
    // The parser stops cleanly at EOF — a trailing CRLF does NOT
    // produce an empty fourth row. This is the documented behaviour
    // for files saved by Excel (which always emits trailing CRLF);
    // a noisy empty row would corrupt downstream column-count
    // checks. Pinned so a future change is forced to update tests.
    expect(parseCSVLines("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("preserves commas inside quoted fields", () => {
    expect(parseCSVLines('"a, b",c')).toEqual([["a, b", "c"]]);
  });

  it("interprets doubled quotes inside a quoted field as a literal quote", () => {
    expect(parseCSVLines('"He said ""hi""",ok')).toEqual([
      ['He said "hi"', "ok"],
    ]);
  });

  it("handles newlines inside a quoted field", () => {
    expect(parseCSVLines('"line one\nline two",x')).toEqual([
      ["line one\nline two", "x"],
    ]);
  });

  it("handles empty fields between commas but drops the post-trailing-comma slot at EOF", () => {
    // Interior empty fields (between two commas) are preserved.
    // A trailing comma immediately followed by EOF is consumed by
    // the field-loop's `i++` but the outer `while (i < text.length)`
    // then exits before a final empty push runs. We pin this
    // behaviour so any future re-implementation matches user data
    // exactly: pasting `a,,b,` into a sheet must NOT silently add an
    // extra trailing column. (CSV producers that need a trailing
    // empty field emit `a,,b,\n` or quote it as `a,,b,""`.)
    expect(parseCSVLines("a,,b,")).toEqual([["a", "", "b"]]);
  });

  it("preserves the trailing empty field when terminated by a newline", () => {
    // Same input shape as above but with an explicit newline after
    // the trailing comma — now the field-loop hits the newline
    // branch and a final empty field is pushed.
    expect(parseCSVLines("a,,b,\n")).toEqual([["a", "", "b", ""]]);
  });
});

// ---------------------------------------------------------------------------
// parseCellRef — A1-style references
// ---------------------------------------------------------------------------

describe("parseCellRef", () => {
  it("decodes A1 to (0,0)", () => {
    expect(parseCellRef("A1")).toEqual({ row: 0, col: 0 });
  });

  it("decodes B2 to (1,1)", () => {
    expect(parseCellRef("B2")).toEqual({ row: 1, col: 1 });
  });

  it("decodes Z10 to (9,25)", () => {
    expect(parseCellRef("Z10")).toEqual({ row: 9, col: 25 });
  });

  it("decodes AA1 to (0,26)", () => {
    expect(parseCellRef("AA1")).toEqual({ row: 0, col: 26 });
  });

  it("decodes AZ100 to (99,51)", () => {
    expect(parseCellRef("AZ100")).toEqual({ row: 99, col: 51 });
  });

  it("returns null for malformed refs", () => {
    expect(parseCellRef("1A")).toBeNull();
    expect(parseCellRef("AA")).toBeNull();
    expect(parseCellRef("99")).toBeNull();
    expect(parseCellRef("a1")).toBeNull(); // lowercase rejected
  });
});

// ---------------------------------------------------------------------------
// evaluateFormula — SUM/AVERAGE/COUNT/MIN/MAX
// ---------------------------------------------------------------------------

describe("evaluateFormula", () => {
  const sheet: SheetContent = {
    columns: ["A", "B"],
    rows: [
      ["1", "10"],
      ["2", "20"],
      ["3", "30"],
      ["bad", "40"],
    ],
  };

  it("computes SUM over a column range", () => {
    expect(evaluateFormula("=SUM(A1:A3)", sheet)).toBe(6);
  });

  it("computes AVERAGE ignoring non-numeric cells", () => {
    // A1..A4 = 1, 2, 3, "bad". Average over the 3 numeric cells = 2.
    expect(evaluateFormula("=AVERAGE(A1:A4)", sheet)).toBe(2);
  });

  it("computes COUNT of numeric cells in a range", () => {
    expect(evaluateFormula("=COUNT(A1:A4)", sheet)).toBe(3);
  });

  it("computes MIN over a 2D range", () => {
    expect(evaluateFormula("=MIN(A1:B3)", sheet)).toBe(1);
  });

  it("computes MAX over a 2D range", () => {
    expect(evaluateFormula("=MAX(A1:B3)", sheet)).toBe(30);
  });

  // The following cases pin the documented behaviour of the real
  // tokenizer → parser → evaluator pipeline (Phase 16 PR 1). The
  // earlier regex-based evaluator returned the broader `#ERR`
  // sentinel for every failure mode; the new engine emits the
  // specific Excel-compatible error codes so the formula bar can
  // surface a useful diagnostic.

  it("returns #NAME? for an unknown function", () => {
    expect(evaluateFormula("=NOPE(A1:A2)", sheet)).toBe("#NAME?");
  });

  it("accepts SUM over a single cell (matching Excel)", () => {
    // The legacy regex required an A1:B5 range; the real engine
    // accepts any expression list, so SUM of a single cell returns
    // that cell's value.
    expect(evaluateFormula("=SUM(A1)", sheet)).toBe(1);
  });

  it("returns #ERR! for an unparseable formula", () => {
    expect(evaluateFormula("=SUM A1:A2", sheet)).toBe("#ERR!");
  });

  it("returns #DIV/0! for AVERAGE over a range with no numeric cells", () => {
    // Out-of-range rows resolve to blanks, so AVERAGE has zero
    // numeric inputs and surfaces the standard division-by-zero
    // sentinel — matching Excel and Google Sheets.
    expect(evaluateFormula("=AVERAGE(C99:C100)", sheet)).toBe("#DIV/0!");
  });

  it("returns 0 when SUM has no numeric values", () => {
    const noNums: SheetContent = {
      columns: ["A"],
      rows: [["x"], ["y"]],
    };
    expect(evaluateFormula("=SUM(A1:A2)", noNums)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// parseBaseContent
// ---------------------------------------------------------------------------

describe("parseBaseContent", () => {
  it("returns a Name/Status default for empty input", () => {
    const out = parseBaseContent("");
    expect(out.fields).toHaveLength(2);
    expect(out.fields[0]).toEqual({ name: "Name", type: "text" });
    expect(out.fields[1]).toEqual({ name: "Status", type: "text" });
    // ensureRecordIds populates a stable opaque id on every record —
    // strip it before comparing the user-visible fields.
    expect(out.records).toHaveLength(1);
    expect(typeof out.records[0].id).toBe("string");
    expect(out.records[0].id).toMatch(/^[0-9a-f]{16}$/);
    const { id: _id, ...rest } = out.records[0];
    void _id;
    expect(rest).toEqual({ Name: "", Status: "" });
  });

  it("round-trips a serialized BaseContent", () => {
    const original = {
      fields: [
        { name: "Title", type: "text" as const },
        { name: "Done", type: "checkbox" as const },
        { name: "Priority", type: "select" as const, options: ["Low", "High"] },
      ],
      records: [
        { Title: "Buy milk", Done: false, Priority: "High" },
        { Title: "Stand-up", Done: true, Priority: "Low" },
      ],
    };
    const reparsed = parseBaseContent(JSON.stringify(original));
    expect(reparsed.fields).toEqual(original.fields);
    expect(reparsed.records).toHaveLength(2);
    // IDs are injected on legacy records but the user-visible payload
    // is preserved exactly.
    for (let i = 0; i < original.records.length; i++) {
      expect(reparsed.records[i].id).toMatch(/^[0-9a-f]{16}$/);
      const { id: _id, ...rest } = reparsed.records[i];
      void _id;
      expect(rest).toEqual(original.records[i]);
    }
  });

  it("preserves a record id when one is already present", () => {
    const original = {
      fields: [{ name: "Name", type: "text" as const }],
      records: [{ id: "abcdef0123456789", Name: "Pinned" }],
    };
    const reparsed = parseBaseContent(JSON.stringify(original));
    expect(reparsed.records[0].id).toBe("abcdef0123456789");
  });

  it("falls back to a single Name record when JSON has no fields[]", () => {
    const out = parseBaseContent("free-form plain text");
    expect(out.fields).toEqual([{ name: "Name", type: "text" }]);
    expect(out.records).toHaveLength(1);
    expect(out.records[0].id).toMatch(/^[0-9a-f]{16}$/);
    const { id: _id, ...rest } = out.records[0];
    void _id;
    expect(rest).toEqual({ Name: "free-form plain text" });
  });

  it("falls back when JSON parses but the fields array is missing", () => {
    const out = parseBaseContent(JSON.stringify({ records: [{ Name: "x" }] }));
    expect(out.fields).toEqual([{ name: "Name", type: "text" }]);
  });
});
