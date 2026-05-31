/**
 * Unit tests for the Phase 17 PR 5 base import/export module.
 *
 * Scope:
 *   - `csvEscapeCell` — RFC-4180 quoting rules
 *   - `parseCsv` — RFC-4180 grammar, CRLF/LF/CR row separators,
 *     embedded commas/quotes/newlines, doubled quotes, trailing
 *     newline behavior, unterminated-quote error
 *   - `formatValueForCsv` — per-field-type formatters for every
 *     variant in `FieldType`, including computed fields (formula,
 *     rollup, lookup) evaluated against the live records
 *   - `exportBaseCsv` / `exportBaseJson` — full round-trip serializers
 *   - `coerceCsvCellToFieldValue` — type-aware string→runtime
 *     coercion, including symbol-stripping for currency and
 *     percent-as-fraction storage
 *   - `parseCsvToBase` — full CSV → BaseContent import with optional
 *     schema reuse and `id` column passthrough
 *   - `parseJsonToBase` — both supported shapes
 *
 * Tests exercise the real code paths — no mocks, no stubs.
 */
import { describe, it, expect } from "vitest";
import {
  csvEscapeCell,
  parseCsv,
  formatValueForCsv,
  exportBaseCsv,
  exportBaseJson,
  coerceCsvCellToFieldValue,
  parseCsvToBase,
  parseJsonToBase,
} from "../baseImportExport";
import type { BaseField, BaseRecord } from "../baseEditorTypes";

describe("csvEscapeCell — RFC-4180 quoting", () => {
  it("returns empty input unchanged", () => {
    expect(csvEscapeCell("")).toBe("");
  });

  it("leaves a plain string unquoted", () => {
    expect(csvEscapeCell("hello world")).toBe("hello world");
  });

  it("quotes a cell containing a comma", () => {
    expect(csvEscapeCell("a,b")).toBe('"a,b"');
  });

  it("quotes a cell containing CR or LF", () => {
    expect(csvEscapeCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscapeCell("line1\rline2")).toBe('"line1\rline2"');
  });

  it("quotes a cell containing a double quote and doubles the embedded quote", () => {
    expect(csvEscapeCell('say "hi"')).toBe('"say ""hi"""');
  });

  it("quotes a cell containing multiple specials in one pass", () => {
    expect(csvEscapeCell('a, "b" \n c')).toBe('"a, ""b"" \n c"');
  });
});

describe("parseCsv — RFC-4180 grammar", () => {
  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("parses a single unquoted row", () => {
    expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]]);
  });

  it("parses multiple rows separated by LF", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses multiple rows separated by CRLF", () => {
    expect(parseCsv("a,b\r\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("parses multiple rows separated by CR alone (legacy Mac)", () => {
    expect(parseCsv("a,b\rc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("does not emit a trailing empty row when input ends with a newline", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("unquotes quoted fields", () => {
    expect(parseCsv('"a","b","c"')).toEqual([["a", "b", "c"]]);
  });

  it("recovers commas embedded inside a quoted field", () => {
    expect(parseCsv('"a,b",c')).toEqual([["a,b", "c"]]);
  });

  it("recovers newlines embedded inside a quoted field", () => {
    expect(parseCsv('"line1\nline2",c')).toEqual([["line1\nline2", "c"]]);
  });

  it("recovers double quotes via the doubled-quote escape", () => {
    expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', "x"]]);
  });

  it("handles a mix of quoted and unquoted cells in the same row", () => {
    expect(parseCsv('plain,"with,comma",alsoPlain')).toEqual([
      ["plain", "with,comma", "alsoPlain"],
    ]);
  });

  it("preserves empty cells between commas", () => {
    expect(parseCsv("a,,b")).toEqual([["a", "", "b"]]);
  });

  it("throws on an unterminated quoted field", () => {
    expect(() => parseCsv('"never closes')).toThrowError(/Unterminated/);
  });
});

describe("formatValueForCsv — per-field-type formatters", () => {
  const allFields: BaseField[] = [];
  const _empty: BaseRecord = { id: "r1" };

  it("text / long_text / email / phone / url / date / select pass through as string", () => {
    const cases: Array<[BaseField["type"], unknown, string]> = [
      ["text", "hello", "hello"],
      ["long_text", "para", "para"],
      ["email", "x@y", "x@y"],
      ["phone", "+1-555", "+1-555"],
      ["url", "https://a", "https://a"],
      ["date", "2025-01-01", "2025-01-01"],
      ["select", "Option A", "Option A"],
    ];
    for (const [type, value, expected] of cases) {
      const f: BaseField = { name: "f", type } as BaseField;
      const r: BaseRecord = { id: "r1", f: value };
      expect(formatValueForCsv(f, r, [r], allFields)).toBe(expected);
    }
  });

  it("number formats finite values; blanks and non-numeric to empty", () => {
    const f: BaseField = { name: "n", type: "number" };
    expect(formatValueForCsv(f, { id: "r1", n: 42 }, [], [])).toBe("42");
    expect(formatValueForCsv(f, { id: "r1", n: null }, [], [])).toBe("");
    expect(formatValueForCsv(f, { id: "r1", n: "abc" }, [], [])).toBe("");
  });

  it("checkbox emits true/false strings", () => {
    const f: BaseField = { name: "c", type: "checkbox" };
    expect(formatValueForCsv(f, { id: "r1", c: true }, [], [])).toBe("true");
    expect(formatValueForCsv(f, { id: "r1", c: false }, [], [])).toBe("false");
  });

  it("currency prefixes the symbol and fixes to 2 decimals", () => {
    const f: BaseField = {
      name: "p",
      type: "currency",
      currencySymbol: "€",
    };
    expect(formatValueForCsv(f, { id: "r1", p: 1234.5 }, [], [])).toBe(
      "€1234.50",
    );
  });

  it("currency defaults to $ when no symbol is configured", () => {
    const f: BaseField = { name: "p", type: "currency" };
    expect(formatValueForCsv(f, { id: "r1", p: 9.9 }, [], [])).toBe("$9.90");
  });

  it("percent multiplies by 100, fixes decimals, appends '%'", () => {
    const f: BaseField = { name: "p", type: "percent", percentPrecision: 1 };
    expect(formatValueForCsv(f, { id: "r1", p: 0.123 }, [], [])).toBe("12.3%");
  });

  it("rating clamps to integer floor", () => {
    const f: BaseField = { name: "r", type: "rating" };
    expect(formatValueForCsv(f, { id: "r1", r: 4.7 }, [], [])).toBe("4");
    expect(formatValueForCsv(f, { id: "r1", r: -1 }, [], [])).toBe("0");
  });

  it("duration formats h:mm minutes", () => {
    const f: BaseField = { name: "d", type: "duration" };
    expect(formatValueForCsv(f, { id: "r1", d: 65 }, [], [])).toBe("1:05");
    expect(formatValueForCsv(f, { id: "r1", d: 120 }, [], [])).toBe("2:00");
  });

  it("auto_number renders the 1-based row position", () => {
    const f: BaseField = { name: "a", type: "auto_number" };
    const r1: BaseRecord = { id: "r1" };
    const r2: BaseRecord = { id: "r2" };
    expect(formatValueForCsv(f, r1, [r1, r2], [])).toBe("1");
    expect(formatValueForCsv(f, r2, [r1, r2], [])).toBe("2");
  });

  it("multi_select / attachment join with '; '", () => {
    const m: BaseField = { name: "tags", type: "multi_select" };
    expect(
      formatValueForCsv(m, { id: "r1", tags: ["a", "b", "c"] }, [], []),
    ).toBe("a; b; c");
    const a: BaseField = { name: "files", type: "attachment" };
    expect(
      formatValueForCsv(a, { id: "r1", files: ["x.png", "y.png"] }, [], []),
    ).toBe("x.png; y.png");
  });

  it("linked_record renders the display field of the linked records", () => {
    const fields: BaseField[] = [
      { name: "Title", type: "text" },
      { name: "Refs", type: "linked_record", linkedDisplayField: "Title" },
    ];
    const records: BaseRecord[] = [
      { id: "id_alpha", Title: "Alpha", Refs: [] },
      { id: "id_beta", Title: "Beta", Refs: [] },
      { id: "id_gamma", Title: "Gamma", Refs: ["id_alpha", "id_beta"] },
    ];
    expect(
      formatValueForCsv(
        fields[1],
        records[2],
        records,
        fields,
      ),
    ).toBe("Alpha; Beta");
  });

  it("linked_record falls back to id slice if no display field configured", () => {
    const fields: BaseField[] = [
      { name: "Title", type: "text" },
      { name: "Refs", type: "linked_record" },
    ];
    const records: BaseRecord[] = [
      { id: "abcdef0123", Title: "Alpha", Refs: [] },
      { id: "ffffeeee01", Title: "Beta", Refs: ["abcdef0123"] },
    ];
    expect(formatValueForCsv(fields[1], records[1], records, fields)).toBe(
      "abcdef",
    );
  });

  it("formula evaluates the live formula and renders the result", () => {
    const fields: BaseField[] = [
      { name: "Price", type: "number" },
      { name: "Tax", type: "formula", formula: "{Price} * 0.1" },
    ];
    const records: BaseRecord[] = [{ id: "r1", Price: 100, Tax: null }];
    expect(formatValueForCsv(fields[1], records[0], records, fields)).toBe(
      "10",
    );
  });

  it("rollup aggregates the target field from linked records", () => {
    const fields: BaseField[] = [
      { name: "Title", type: "text" },
      { name: "Price", type: "number" },
      { name: "Refs", type: "linked_record" },
      {
        name: "Total",
        type: "rollup",
        linkedField: "Refs",
        targetField: "Price",
        aggregation: "SUM",
      },
    ];
    const records: BaseRecord[] = [
      { id: "a", Title: "Item A", Price: 10, Refs: [] },
      { id: "b", Title: "Item B", Price: 20, Refs: [] },
      { id: "c", Title: "Sum", Price: null, Refs: ["a", "b"] },
    ];
    expect(formatValueForCsv(fields[3], records[2], records, fields)).toBe(
      "30",
    );
  });

  it("rollup surfaces #REF! when linkedField is misconfigured", () => {
    const fields: BaseField[] = [
      { name: "Title", type: "text" },
      {
        name: "Total",
        type: "rollup",
        linkedField: "DoesNotExist",
        targetField: "Title",
        aggregation: "CONCAT",
      },
    ];
    const records: BaseRecord[] = [{ id: "r1", Title: "A", Total: null }];
    expect(formatValueForCsv(fields[1], records[0], records, fields)).toBe(
      "#REF!",
    );
  });

  it("lookup renders the comma-separated values of the target field across linked records", () => {
    const fields: BaseField[] = [
      { name: "Title", type: "text" },
      { name: "Refs", type: "linked_record" },
      {
        name: "Titles",
        type: "lookup",
        linkedField: "Refs",
        targetField: "Title",
      },
    ];
    const records: BaseRecord[] = [
      { id: "a", Title: "Alpha", Refs: [] },
      { id: "b", Title: "Beta", Refs: [] },
      { id: "c", Title: null, Refs: ["a", "b"] },
    ];
    expect(formatValueForCsv(fields[2], records[2], records, fields)).toBe(
      "Alpha, Beta",
    );
  });
});

describe("exportBaseCsv — full base → CSV serialization", () => {
  it("emits a header row + one row per record, CRLF-separated", () => {
    const data = {
      fields: [
        { name: "Name", type: "text" as const },
        { name: "Score", type: "number" as const },
      ],
      records: [
        { id: "r1", Name: "Alice", Score: 10 },
        { id: "r2", Name: "Bob", Score: 20 },
      ],
    };
    const csv = exportBaseCsv(data);
    expect(csv).toBe("Name,Score\r\nAlice,10\r\nBob,20");
  });

  it("escapes header and cell values that contain CSV-meta characters", () => {
    const data = {
      fields: [
        { name: "Field, comma", type: "text" as const },
        { name: 'Field "quote"', type: "text" as const },
      ],
      records: [
        {
          id: "r1",
          "Field, comma": "a, b",
          'Field "quote"': 'say "hi"',
        },
      ],
    };
    const csv = exportBaseCsv(data);
    expect(csv).toBe(
      '"Field, comma","Field ""quote"""\r\n"a, b","say ""hi"""',
    );
  });
});

describe("exportBaseJson — pretty-printed JSON", () => {
  it("emits the canonical { fields, records } shape with 2-space indentation", () => {
    const data = {
      fields: [{ name: "Name", type: "text" as const }],
      records: [{ id: "r1", Name: "Alice" }],
    };
    const json = exportBaseJson(data);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(data);
    expect(json).toContain('  "fields"');
  });
});

describe("coerceCsvCellToFieldValue — string → runtime type coercion", () => {
  it("strings: trims and returns null for empty", () => {
    expect(coerceCsvCellToFieldValue("  hello  ", "text")).toBe("hello");
    expect(coerceCsvCellToFieldValue("", "text")).toBe(null);
    expect(coerceCsvCellToFieldValue("   ", "long_text")).toBe(null);
  });

  it("number: returns finite Number or null", () => {
    expect(coerceCsvCellToFieldValue("42", "number")).toBe(42);
    expect(coerceCsvCellToFieldValue("3.14", "number")).toBe(3.14);
    expect(coerceCsvCellToFieldValue("abc", "number")).toBe(null);
    expect(coerceCsvCellToFieldValue("", "number")).toBe(null);
    expect(coerceCsvCellToFieldValue("Infinity", "number")).toBe(null);
  });

  it("checkbox: accepts true/yes/1 in any case as true", () => {
    expect(coerceCsvCellToFieldValue("true", "checkbox")).toBe(true);
    expect(coerceCsvCellToFieldValue("TRUE", "checkbox")).toBe(true);
    expect(coerceCsvCellToFieldValue("yes", "checkbox")).toBe(true);
    expect(coerceCsvCellToFieldValue("1", "checkbox")).toBe(true);
    expect(coerceCsvCellToFieldValue("false", "checkbox")).toBe(false);
    expect(coerceCsvCellToFieldValue("0", "checkbox")).toBe(false);
    expect(coerceCsvCellToFieldValue("", "checkbox")).toBe(false);
  });

  it("currency: strips leading symbol and grouping commas, returns the raw number", () => {
    expect(coerceCsvCellToFieldValue("$1,234.56", "currency")).toBe(1234.56);
    expect(coerceCsvCellToFieldValue("€42.00", "currency")).toBe(42);
    expect(coerceCsvCellToFieldValue("", "currency")).toBe(null);
  });

  it("percent: strips trailing % and stores as 0..1 fraction", () => {
    expect(coerceCsvCellToFieldValue("50%", "percent")).toBe(0.5);
    expect(coerceCsvCellToFieldValue("12.5%", "percent")).toBe(0.125);
    expect(coerceCsvCellToFieldValue("", "percent")).toBe(null);
  });

  it("rating: floors and clamps non-negative integer", () => {
    expect(coerceCsvCellToFieldValue("3.7", "rating")).toBe(3);
    expect(coerceCsvCellToFieldValue("-1", "rating")).toBe(0);
    expect(coerceCsvCellToFieldValue("", "rating")).toBe(null);
  });

  it("duration: parses h:mm into minutes; rejects malformed", () => {
    expect(coerceCsvCellToFieldValue("1:05", "duration")).toBe(65);
    expect(coerceCsvCellToFieldValue("2:00", "duration")).toBe(120);
    expect(coerceCsvCellToFieldValue("1:99", "duration")).toBe(null);
    expect(coerceCsvCellToFieldValue("bogus", "duration")).toBe(null);
  });

  it("multi_select / attachment: splits on ';' and trims", () => {
    expect(coerceCsvCellToFieldValue("a; b; c", "multi_select")).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(coerceCsvCellToFieldValue("", "multi_select")).toEqual([]);
    expect(coerceCsvCellToFieldValue("x.png; y.png", "attachment")).toEqual([
      "x.png",
      "y.png",
    ]);
  });

  it("linked_record / auto_number / formula / rollup / lookup: ignored on import", () => {
    expect(coerceCsvCellToFieldValue("anything", "linked_record")).toEqual([]);
    expect(coerceCsvCellToFieldValue("99", "auto_number")).toBe(null);
    expect(coerceCsvCellToFieldValue("x", "formula")).toBe(null);
    expect(coerceCsvCellToFieldValue("x", "rollup")).toBe(null);
    expect(coerceCsvCellToFieldValue("x", "lookup")).toBe(null);
  });
});

describe("parseCsvToBase — CSV → BaseContent", () => {
  it("returns empty content for empty input", () => {
    expect(parseCsvToBase("")).toEqual({ fields: [], records: [] });
  });

  it("infers text fields from headers when no schema is supplied", () => {
    const csv = "Name,Score\r\nAlice,42\r\nBob,17";
    const result = parseCsvToBase(csv);
    expect(result.fields).toEqual([
      { name: "Name", type: "text" },
      { name: "Score", type: "text" }, // no schema → text fallback
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].Name).toBe("Alice");
    expect(result.records[0].Score).toBe("42"); // coerced as text
  });

  it("reuses schema field configs when header names match", () => {
    const schema: BaseField[] = [
      { name: "Name", type: "text" },
      { name: "Score", type: "number" },
    ];
    const csv = "Name,Score\r\nAlice,42\r\nBob,17";
    const result = parseCsvToBase(csv, schema);
    expect(result.fields).toEqual(schema);
    expect(result.records[0].Score).toBe(42); // coerced as number
    expect(result.records[1].Score).toBe(17);
  });

  it("adds unknown columns as fresh text fields without dropping data", () => {
    const schema: BaseField[] = [{ name: "Name", type: "text" }];
    const csv = "Name,Extra\r\nAlice,hello";
    const result = parseCsvToBase(csv, schema);
    expect(result.fields).toHaveLength(2);
    expect(result.fields[1]).toEqual({ name: "Extra", type: "text" });
    expect(result.records[0].Extra).toBe("hello");
  });

  it("excludes the reserved `id` column from the field list and routes it to record.id", () => {
    const csv = "id,Name\r\ncustom_id_1,Alice";
    const result = parseCsvToBase(csv);
    expect(result.fields.map((f) => f.name)).toEqual(["Name"]);
    expect(result.records[0].id).toBe("custom_id_1");
  });

  it("mints a fresh id when the `id` column is missing or empty", () => {
    const csv1 = "Name\r\nAlice";
    const result1 = parseCsvToBase(csv1);
    expect(typeof result1.records[0].id).toBe("string");
    expect(result1.records[0].id.length).toBeGreaterThan(0);

    const csv2 = "id,Name\r\n,Alice";
    const result2 = parseCsvToBase(csv2);
    expect(typeof result2.records[0].id).toBe("string");
    expect(result2.records[0].id.length).toBeGreaterThan(0);
  });

  it("skips entirely-blank rows (trailing empty lines from Excel exports)", () => {
    const csv = "Name\r\nAlice\r\n\r\nBob\r\n";
    const result = parseCsvToBase(csv);
    expect(result.records).toHaveLength(2);
    expect(result.records.map((r) => r.Name)).toEqual(["Alice", "Bob"]);
  });

  it("disambiguates duplicate CSV headers with ` (2)`, ` (3)` suffixes (ANALYSIS-0004)", () => {
    // The simple-collision case: two identical headers, no
    // pre-existing suffixed names anywhere in the row. The second
    // `Name` becomes `Name (2)`. Downstream code keys filters,
    // sort, record JSON keys, and the `renameField` uniqueness
    // guard by field name, so silently importing duplicates would
    // break the editor.
    const csv = "Name,Name,Age\r\nAlice,A1,30\r\nBob,B1,40";
    const result = parseCsvToBase(csv);
    expect(result.fields.map((f) => f.name)).toEqual([
      "Name",
      "Name (2)",
      "Age",
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].Name).toBe("Alice");
    expect(result.records[0]["Name (2)"]).toBe("A1");
    expect(result.records[0].Age).toBe("30");
  });

  it("preserves a deliberately-named ` (N)` header that appears later in the row (look-ahead disambiguation)", () => {
    // Trickier case: the third column is a deliberate `Name (2)`.
    // If the dedup pass only looked at names already taken, the
    // duplicate at column 1 would steal `Name (2)` and the
    // deliberate one at column 2 would get bumped to `Name (2)
    // (2)`. The look-ahead at every header name lets us skip
    // `(2)` for the auto-rename and pick `(3)` instead, so the
    // user's deliberate naming wins.
    const csv = "Name,Name,Name (2)\r\nAlice,A1,X\r\nBob,B1,Y";
    const result = parseCsvToBase(csv);
    expect(result.fields.map((f) => f.name)).toEqual([
      "Name",
      "Name (3)",
      "Name (2)",
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].Name).toBe("Alice");
    expect(result.records[0]["Name (3)"]).toBe("A1");
    expect(result.records[0]["Name (2)"]).toBe("X");
    expect(result.records[1].Name).toBe("Bob");
    expect(result.records[1]["Name (3)"]).toBe("B1");
    expect(result.records[1]["Name (2)"]).toBe("Y");
  });

  it("does not re-use the schema field config for a column that was renamed for uniqueness", () => {
    // The schema has a single `Name` field of type `number`. If the
    // CSV has two `Name` columns, only the first one is *logically*
    // that field — the second is a fresh column whose type we know
    // nothing about, so it must fall back to `text` rather than
    // adopt the schema's `number` config (which would silently lose
    // every non-numeric cell).
    const csv = "Name,Name\r\n1,hello\r\n2,world";
    const result = parseCsvToBase(csv, [{ name: "Name", type: "number" }]);
    expect(result.fields).toEqual([
      { name: "Name", type: "number" },
      { name: "Name (2)", type: "text" },
    ]);
    expect(result.records[0].Name).toBe(1);
    expect(result.records[0]["Name (2)"]).toBe("hello");
  });

  it("round-trips a real export through exportBaseCsv → parseCsvToBase", () => {
    const original = {
      fields: [
        { name: "Title", type: "text" as const },
        { name: "Score", type: "number" as const },
        { name: "Active", type: "checkbox" as const },
      ],
      records: [
        { id: "r1", Title: "Alpha", Score: 10, Active: true },
        { id: "r2", Title: "Bravo, with comma", Score: 20, Active: false },
      ],
    };
    const csv = exportBaseCsv(original);
    // Re-import with the same schema so types are recovered.
    const reimported = parseCsvToBase(csv, original.fields);
    expect(reimported.fields).toEqual(original.fields);
    expect(reimported.records).toHaveLength(2);
    expect(reimported.records[0].Title).toBe("Alpha");
    expect(reimported.records[0].Score).toBe(10);
    expect(reimported.records[0].Active).toBe(true);
    expect(reimported.records[1].Title).toBe("Bravo, with comma");
    expect(reimported.records[1].Active).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────
  // Empty-CSV-header coverage (PR #79 round 8 — ANALYSIS_…_0004)
  // ────────────────────────────────────────────────────────────────
  it("auto-names blank CSV headers as `Column N` (1-based) so the column is still visible (ANALYSIS-0004)", () => {
    // Excel happily emits `Name,,Score` when a middle column is
    // empty / unnamed. Previously the trimmed empty string passed
    // `isReservedFieldName` and became a field literally named `""`,
    // which rendered as a blank column header / blank filter label /
    // blank JSON key in every record — confusing the user.
    const csv = "Name,,Score\r\nAlice,X,10\r\nBob,Y,20";
    const result = parseCsvToBase(csv);
    expect(result.fields.map((f) => f.name)).toEqual([
      "Name",
      "Column 2",
      "Score",
    ]);
    // The mid-column data must land under the auto-named field — the
    // column index must be preserved, NOT shifted, after the rename.
    expect(result.records[0].Name).toBe("Alice");
    expect(result.records[0]["Column 2"]).toBe("X");
    // Score column is auto-typed as `text` (no schema supplied), so the
    // cell stays as the raw string the CSV emitted.
    expect(result.records[0].Score).toBe("10");
  });

  it("auto-names multiple blank headers with distinct 1-based indices (Column 2, Column 4)", () => {
    // Two blank columns: each gets a unique deterministic placeholder
    // based on its 1-based CSV column index — NOT incremental
    // `(2)` / `(3)` suffixes, which would lose the column's identity
    // across re-exports.
    const csv = "A,,B,\r\nx,1,y,2";
    const result = parseCsvToBase(csv);
    expect(result.fields.map((f) => f.name)).toEqual([
      "A",
      "Column 2",
      "B",
      "Column 4",
    ]);
    expect(result.records[0]["Column 2"]).toBe("1");
    expect(result.records[0]["Column 4"]).toBe("2");
  });

  it("uniquifies an auto-named blank header that collides with a deliberate `Column 1` (` (2)` suffix)", () => {
    // If a user already has a column literally named `Column 1` AND
    // there is *also* a blank column at index 0, the auto-rename
    // pass would try to name the blank slot `Column 1` and collide
    // with the deliberate header. The same `uniquify` dedup the
    // duplicate-header path uses must kick in and bump the auto-
    // named slot to `Column 1 (2)`. The deliberate `Column 1` keeps
    // its name (look-ahead reservation) and the auto-named slot
    // takes the suffix.
    const csv = ",Column 1\r\nx,y";
    const result = parseCsvToBase(csv);
    expect(result.fields.map((f) => f.name)).toEqual([
      "Column 1 (2)",
      "Column 1",
    ]);
    expect(result.records[0]["Column 1 (2)"]).toBe("x");
    expect(result.records[0]["Column 1"]).toBe("y");
  });

  it("does NOT treat blank headers as the reserved `id` column (record id is still auto-minted)", () => {
    // Sanity check: the blank-header branch must not accidentally
    // route blanks through the reserved-id pathway. Every row should
    // get a fresh `makeRecordId()` id.
    const csv = ",Name\r\nx,Alice";
    const result = parseCsvToBase(csv);
    // The blank column became `Column 1`, NOT `id`.
    expect(result.fields.map((f) => f.name)).toContain("Column 1");
    expect(result.fields.map((f) => f.name)).not.toContain("id");
    // Record id is fresh, not the literal `x` from the blank-header
    // column.
    expect(result.records[0].id).not.toBe("x");
    expect((result.records[0].id as string).length).toBeGreaterThan(0);
  });

  it("clones reused schema fields so caller can mutate the result without corrupting the schema (and vice-versa)", () => {
    // Regression guard for Devin Review PR #79 round 9
    // (ANALYSIS_…_0002). Before the cloneBaseField helper, the
    // imported `BaseContent.fields[i]` was the SAME object reference
    // as `schema[i]`, so an in-place `options.push(…)` mutation on
    // the imported field would silently bleed back into the schema
    // (and vice versa). This test pins the lifecycle separation.
    const schema = [
      {
        name: "Tags",
        type: "multi_select" as const,
        options: ["red", "green", "blue"],
      },
    ];
    const csv = "Tags\nred";
    const result = parseCsvToBase(csv, schema);
    // The imported field has the same *values* as the schema entry
    // (so column type/options/etc. flow through) …
    expect(result.fields[0].name).toBe("Tags");
    expect(result.fields[0].type).toBe("multi_select");
    expect(result.fields[0].options).toEqual(["red", "green", "blue"]);
    // … but it's a NEW object (not `===` to the schema entry) …
    expect(result.fields[0]).not.toBe(schema[0]);
    // … and its `options` array is a NEW array.
    expect(result.fields[0].options).not.toBe(schema[0].options);
    // Mutating either side does not affect the other.
    (result.fields[0].options as string[]).push("purple");
    expect(schema[0].options).toEqual(["red", "green", "blue"]);
    schema[0].options.push("orange");
    expect(result.fields[0].options).toEqual(["red", "green", "blue", "purple"]);
  });

  // Devin Review PR #82 (ANALYSIS_…_0005): `parseCsvToBase` reuses
  // schema field configs but historically did NOT run them through
  // `sanitizeBaseField`, while `parseJsonToBase` did. The asymmetry
  // was harmless because the only caller passes already-sanitised
  // `data.fields`, but any future caller handing in an un-sanitised
  // schema (CLI importer, paste-from-external-source, hand-rolled
  // schema) would leak e.g. a `percentPrecision: 200` through to the
  // next export and crash with `RangeError: toFixed() digits must be
  // between 0 and 100`. The fix funnels every cloned-schema and
  // auto-`text` field through `sanitizeBaseField` so the contract
  // matches `parseJsonToBase`.
  it("sanitizes percentPrecision on cloned schema fields (matches parseJsonToBase contract)", () => {
    // Hostile schema: percentPrecision above the 20-cap that
    // `Number.prototype.toFixed` accepts.
    const schema: BaseField[] = [
      {
        name: "Score",
        type: "percent",
        // 200 is way beyond `toFixed`'s 0..100 range and the [0,20]
        // cap `sanitizeBaseField` enforces. If the CSV-import path
        // didn't sanitise, this would survive into the resulting
        // BaseContent and crash the next `exportBaseCsv` (which calls
        // `n.toFixed(digits)`).
        percentPrecision: 200,
      } as BaseField,
    ];
    const csv = "Score\r\n0.5";
    const result = parseCsvToBase(csv, schema);
    expect(result.fields).toHaveLength(1);
    // Sanitiser caps percentPrecision at 20.
    expect(result.fields[0].percentPrecision).toBe(20);
  });
});

describe("parseJsonToBase — JSON → BaseContent", () => {
  it("accepts the canonical { fields, records } shape", () => {
    const json = JSON.stringify({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Alice" }],
    });
    const result = parseJsonToBase(json);
    expect(result.fields).toEqual([{ name: "Name", type: "text" }]);
    expect(result.records[0].id).toBe("r1");
    expect(result.records[0].Name).toBe("Alice");
  });

  it("accepts a bare array of objects and infers text fields from the keys", () => {
    const json = JSON.stringify([
      { Name: "Alice", Score: 10 },
      { Name: "Bob", Score: 20 },
    ]);
    const result = parseJsonToBase(json);
    expect(result.fields.map((f) => f.name).sort()).toEqual(["Name", "Score"]);
    expect(result.fields.every((f) => f.type === "text")).toBe(true);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].Name).toBe("Alice");
    expect(result.records[1].Score).toBe(20);
    // Every record should have a freshly-minted id.
    expect(typeof result.records[0].id).toBe("string");
    expect(typeof result.records[1].id).toBe("string");
  });

  it("preserves explicit ids on the input array shape", () => {
    const json = JSON.stringify([
      { id: "carried_1", Name: "Alice" },
      { id: "carried_2", Name: "Bob" },
    ]);
    const result = parseJsonToBase(json);
    expect(result.records[0].id).toBe("carried_1");
    expect(result.records[1].id).toBe("carried_2");
  });

  it("mints a new id when the canonical shape's record is missing one", () => {
    const json = JSON.stringify({
      fields: [{ name: "Name", type: "text" }],
      records: [{ Name: "Alice" }],
    });
    const result = parseJsonToBase(json);
    expect(typeof result.records[0].id).toBe("string");
    expect(result.records[0].id.length).toBeGreaterThan(0);
  });

  it("returns an empty content for an empty array", () => {
    const json = JSON.stringify([]);
    const result = parseJsonToBase(json);
    expect(result).toEqual({ fields: [], records: [] });
  });

  it("throws on a bare array of non-objects (every element invalid)", () => {
    expect(() => parseJsonToBase(JSON.stringify([1, 2, 3]))).toThrowError(
      /at least one object record/,
    );
  });

  it("accepts a mixed array where only some elements are objects (round 10 ANALYSIS_…_0005)", () => {
    // Previously the bare-array path checked `parsed[0]` and threw if
    // the *first* element wasn't an object — even though every later
    // element was a perfectly valid record. The canonical-shape path
    // silently filters non-objects via `ensureRecordIds`, so the two
    // paths now agree: a mixed array imports the surviving records.
    const json = JSON.stringify([null, { Name: "Alice" }, 42, { Name: "Bob" }]);
    const result = parseJsonToBase(json);
    expect(result.fields).toEqual([{ name: "Name", type: "text" }]);
    expect(result.records.map((r) => r.Name)).toEqual(["Alice", "Bob"]);
  });

  it("throws on a non-object/non-array top-level value", () => {
    expect(() => parseJsonToBase(JSON.stringify("string"))).toThrowError(
      /object or an array/,
    );
  });

  it("throws on the canonical shape if fields/records are missing", () => {
    expect(() =>
      parseJsonToBase(JSON.stringify({ fields: [] /* no records */ })),
    ).toThrowError(/fields.+records/);
  });

  it("round-trips a real export through exportBaseJson → parseJsonToBase", () => {
    const original = {
      fields: [
        { name: "Title", type: "text" as const },
        { name: "Score", type: "number" as const },
      ],
      records: [
        { id: "r1", Title: "Alpha", Score: 10 },
        { id: "r2", Title: "Bravo", Score: 20 },
      ],
    };
    const json = exportBaseJson(original);
    const reimported = parseJsonToBase(json);
    expect(reimported.fields).toEqual(original.fields);
    expect(reimported.records).toEqual(original.records);
  });

  it("filters non-object records in the canonical shape without throwing (BUG-0004)", () => {
    // Defensive: a hand-edited / third-party canonical-JSON could
    // land with `null` (or another primitive) in `records`. Before
    // the round-7 fix the canonical path did `(obj.records as
    // BaseRecord[]).map((r) => ({ ...r, id: ... }))`, which threw
    // `TypeError: Cannot read properties of null (reading 'id')`
    // and surfaced a useless stack trace in the import dialog.
    // After: `ensureRecordIds` drops the bad slots and re-stamps
    // IDs, matching what `parseBaseContent` does for the artifact
    // loader. The valid record survives unchanged.
    const json = JSON.stringify({
      fields: [{ name: "Title", type: "text" }],
      records: [{ id: "r1", Title: "Alpha" }, null, "not-an-object", 42],
    });
    const result = parseJsonToBase(json);
    expect(result.fields).toEqual([{ name: "Title", type: "text" }]);
    expect(result.records).toEqual([{ id: "r1", Title: "Alpha" }]);
  });

  it("filters non-object rows in the bare-array shape without throwing (BUG-0004)", () => {
    // Symmetric to the canonical-shape test — the array shape's
    // record-build `.map` also previously accessed `row.id` without
    // re-filtering, even though the field-harvest loop had a guard.
    // After the round-7 fix both loops share a single up-front
    // filter, so a `[validObj, null, validObj]` payload no longer
    // crashes during import.
    const json = JSON.stringify([
      { id: "r1", Title: "Alpha" },
      null,
      { id: "r2", Title: "Bravo" },
    ]);
    const result = parseJsonToBase(json);
    expect(result.fields).toEqual([{ name: "Title", type: "text" }]);
    expect(result.records).toEqual([
      { id: "r1", Title: "Alpha" },
      { id: "r2", Title: "Bravo" },
    ]);
  });

  it("mints a fresh id when a canonical record has a non-string id (BUG-0004)", () => {
    // `ensureRecordIds` also covers the related "wrong-typed id"
    // case: a record with `id: 42` or `id: null` gets a fresh
    // makeRecordId() so downstream linked_record lookups keep
    // working. Previously the canonical path's truthy check happened
    // to do the right thing here, but routing through
    // `ensureRecordIds` makes the contract explicit and shared with
    // the artifact loader.
    const json = JSON.stringify({
      fields: [{ name: "Title", type: "text" }],
      records: [
        { id: 42, Title: "BadId" },
        { id: "", Title: "Empty" },
      ],
    });
    const result = parseJsonToBase(json);
    expect(result.records).toHaveLength(2);
    for (const r of result.records) {
      expect(typeof r.id).toBe("string");
      expect((r.id as string).length).toBeGreaterThan(0);
    }
  });

  it("sanitises every imported field via sanitizeBaseField — out-of-range percentPrecision is clamped (BUG-0001)", () => {
    // A hand-crafted JSON with `percentPrecision: 200` would crash the
    // very next CSV export (`Number.prototype.toFixed` throws for
    // arguments outside [0, 100]). The fix runs every imported field
    // through `sanitizeBaseField`, the same pass `parseBaseContent`
    // uses on the artifact's stored JSON, so the export-side defence
    // never has to fire on the happy path.
    const json = JSON.stringify({
      fields: [{ name: "Pct", type: "percent", percentPrecision: 200 }],
      records: [{ id: "r1", Pct: 0.5 }],
    });
    const result = parseJsonToBase(json);
    // sanitizeBaseField caps percentPrecision at 20 (`toFixed`'s
    // domain plus an extra safety margin).
    expect(result.fields).toEqual([
      { name: "Pct", type: "percent", percentPrecision: 20 },
    ]);
    // Re-exporting the sanitised field must not throw — proof the
    // sanitisation actually unblocks the export path.
    const csv = exportBaseCsv(result);
    expect(csv).toContain("50.");
  });
});

describe("formatValueForCsv defensive clamp", () => {
  it("clamps percentPrecision above 20 so a stale field config can't throw RangeError on export (BUG-0002)", () => {
    // Defence-in-depth: even if `parseJsonToBase`'s sanitisation is
    // bypassed (e.g. a future call site bypasses the parser, or
    // `data.fields` is hand-mutated by another editor flow), the
    // export path must not throw. Without the upper clamp,
    // `Number.prototype.toFixed(200)` raises `RangeError` and the
    // user's export silently fails. With the clamp we get harmless
    // extra precision instead.
    const field: BaseField = {
      name: "Pct",
      type: "percent",
      percentPrecision: 200,
    };
    const record: BaseRecord = { id: "r1", Pct: 0.5 };
    // Must not throw.
    const cell = formatValueForCsv(field, record, [record], [field]);
    // 50% rendered with the clamped precision (20 digits).
    expect(cell).toMatch(/^50\.0{20}%$/);
  });

  it("clamps negative percentPrecision to zero so a stale field config can't throw RangeError on export", () => {
    // Same shape as the upper-bound test but on the lower bound —
    // `Math.max(0, …)` and `Math.floor(…)` together turn a negative
    // input into 0 (the previous lower-clamp test), but combine with
    // a non-integer to confirm `Math.floor` runs.
    const field: BaseField = {
      name: "Pct",
      type: "percent",
      percentPrecision: -3.7,
    };
    const record: BaseRecord = { id: "r1", Pct: 0.25 };
    expect(formatValueForCsv(field, record, [record], [field])).toBe("25%");
  });
});
