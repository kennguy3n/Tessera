/**
 * Unit tests for the Phase 17 PR 4 field-type helpers. These cover
 * the pure-function layer that BaseEditor cell components delegate
 * to: record-id minting and migration, link resolution, rollup
 * aggregation, lookup pull-through, auto-numbering, and the inverse
 * find-records-linking-to query.
 *
 * Tests intentionally use fixed inputs (no random fixtures) so that
 * the assertions exercise the real arithmetic / string-building
 * paths rather than self-validated values computed by the helper
 * under test.
 */
import { describe, it, expect } from "vitest";
import {
  makeRecordId,
  ensureRecordIds,
  parseBaseContent,
  resolveLinkedRecords,
  aggregateValues,
  lookupValues,
  computeAutoNumber,
  findRecordsLinkingTo,
  isReservedFieldName,
  RESERVED_FIELD_NAMES,
  sanitizeBaseField,
  matchesFilter,
  applyFieldRename,
  isComputedFieldType,
} from "../baseEditorHelpers";
import type { BaseField, BaseRecord } from "../baseEditorTypes";

describe("makeRecordId", () => {
  it("produces a 16-character lowercase hex id", () => {
    const id = makeRecordId();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns distinct ids on successive calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(makeRecordId());
    // Birthday-paradox-safe upper bound for 16 hex chars (~2^64 space).
    expect(seen.size).toBe(200);
  });
});

describe("ensureRecordIds", () => {
  it("populates ids on records missing them", () => {
    const records: BaseRecord[] = [
      { id: "", Name: "A" },
      { id: "", Name: "B" },
    ];
    const out = ensureRecordIds(records);
    expect(out[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(out[1].id).toMatch(/^[0-9a-f]{16}$/);
    expect(out[0].id).not.toBe(out[1].id);
  });

  it("preserves the existing id when one is set", () => {
    const records: BaseRecord[] = [
      { id: "deadbeefcafebabe", Name: "Kept" },
    ];
    const out = ensureRecordIds(records);
    expect(out[0].id).toBe("deadbeefcafebabe");
  });

  it("returns the input array reference when nothing changed", () => {
    const records: BaseRecord[] = [
      { id: "abcdef0123456789", Name: "Stable" },
    ];
    const out = ensureRecordIds(records);
    expect(out).toBe(records);
  });

  it("drops primitives, null, and arrays — only keeps plain objects", () => {
    // Devin Review ANALYSIS_0004 — hand-edited JSON like
    // `records: [null, 42, "oops", [], { Name: "ok" }]` would
    // previously crash on `null.id` (TypeError on the spread).
    // The defensive path filters such elements out and re-keys
    // the survivors.
    const out = ensureRecordIds([
      null,
      42,
      "oops",
      ["array-elem"],
      { id: "kept0000kept0000", Name: "Kept" },
      { Name: "FreshId" },
    ] as unknown[]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "kept0000kept0000", Name: "Kept" });
    expect(out[1].Name).toBe("FreshId");
    expect(out[1].id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns [] when EVERY element is invalid", () => {
    const out = ensureRecordIds([null, undefined, 0, ""] as unknown[]);
    expect(out).toEqual([]);
  });
});

describe("parseBaseContent — record id integration", () => {
  it("auto-assigns ids to legacy records on parse", () => {
    const json = JSON.stringify({
      fields: [{ name: "Name", type: "text" }],
      records: [{ Name: "Legacy 1" }, { Name: "Legacy 2" }],
    });
    const parsed = parseBaseContent(json);
    expect(parsed.records[0].id).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.records[1].id).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.records[0].id).not.toBe(parsed.records[1].id);
  });

  it("coerces non-array records to []", () => {
    // Devin Review ANALYSIS_0006 — hand-edited JSON can ship
    // records that don't satisfy the type contract; the parser
    // must not blow up.
    const cases = [
      JSON.stringify({ fields: [{ name: "Name", type: "text" }], records: null }),
      JSON.stringify({ fields: [{ name: "Name", type: "text" }], records: "oops" }),
      JSON.stringify({
        fields: [{ name: "Name", type: "text" }],
        records: { 0: { Name: "A" } },
      }),
    ];
    for (const c of cases) {
      const parsed = parseBaseContent(c);
      expect(Array.isArray(parsed.records)).toBe(true);
      expect(parsed.records).toHaveLength(0);
    }
  });

  it("clamps a malformed percentPrecision into the safe range", () => {
    // Devin Review BUG_0001 — a hand-edited percentPrecision of
    // -1 (or NaN, or 999) used to crash PercentCell with a
    // RangeError on `Number.toFixed`. After sanitization the
    // value must be in [0,20] or be removed entirely.
    const json = JSON.stringify({
      fields: [
        { name: "Pct", type: "percent", percentPrecision: -1 },
        { name: "Big", type: "percent", percentPrecision: 999 },
        { name: "Bogus", type: "percent", percentPrecision: "abc" },
      ],
      records: [{ Pct: 0.5, Big: 0.5, Bogus: 0.5 }],
    });
    const parsed = parseBaseContent(json);
    expect(parsed.fields[0].percentPrecision).toBe(0);
    expect(parsed.fields[1].percentPrecision).toBe(20);
    // Non-numeric values are stripped so downstream defaults
    // ((value ?? 0) at the renderer) take effect.
    expect(parsed.fields[2].percentPrecision).toBeUndefined();
  });
});

describe("sanitizeBaseField", () => {
  it("returns the same object reference when nothing needs clamping", () => {
    const original = {
      name: "Pct",
      type: "percent" as const,
      percentPrecision: 2,
    };
    expect(sanitizeBaseField(original)).toBe(original);
  });

  it("clamps negative percentPrecision to 0", () => {
    const out = sanitizeBaseField({
      name: "Pct",
      type: "percent",
      percentPrecision: -3,
    });
    expect(out.percentPrecision).toBe(0);
  });

  it("clamps oversized percentPrecision to 20", () => {
    const out = sanitizeBaseField({
      name: "Pct",
      type: "percent",
      percentPrecision: 50,
    });
    expect(out.percentPrecision).toBe(20);
  });

  it("removes percentPrecision when the value is non-finite", () => {
    const out = sanitizeBaseField({
      name: "Pct",
      type: "percent",
      // Trigger NaN via Number(undefined) — easier than embedding
      // NaN as a JSON-safe literal.
      percentPrecision: Number.NaN,
    });
    expect(out.percentPrecision).toBeUndefined();
  });

  it("floors a fractional precision so toFixed never sees a non-integer", () => {
    const out = sanitizeBaseField({
      name: "Pct",
      type: "percent",
      percentPrecision: 3.7,
    });
    expect(out.percentPrecision).toBe(3);
  });
});

describe("resolveLinkedRecords", () => {
  const records: BaseRecord[] = [
    { id: "r1", Name: "Alice" },
    { id: "r2", Name: "Bob" },
    { id: "r3", Name: "Carol" },
  ];

  it("returns records matching the supplied ids in order", () => {
    const out = resolveLinkedRecords(["r3", "r1"], records);
    expect(out.map((r) => r.id)).toEqual(["r3", "r1"]);
  });

  it("ignores ids that do not match any record", () => {
    const out = resolveLinkedRecords(["r1", "missing"], records);
    expect(out.map((r) => r.id)).toEqual(["r1"]);
  });

  it("returns [] when input is not an array", () => {
    expect(resolveLinkedRecords(null, records)).toEqual([]);
    expect(resolveLinkedRecords("r1", records)).toEqual([]);
    expect(resolveLinkedRecords({ r1: true }, records)).toEqual([]);
  });

  it("returns [] when no ids resolve", () => {
    expect(resolveLinkedRecords(["x", "y"], records)).toEqual([]);
  });
});

describe("aggregateValues", () => {
  it("SUM adds numeric values, skipping non-numeric", () => {
    expect(aggregateValues([1, 2, 3, "x", null], "SUM")).toBe("6");
    expect(aggregateValues(["10", "20"], "SUM")).toBe("30");
  });

  it("AVG divides the sum by the count of numeric values", () => {
    expect(aggregateValues([2, 4, 6], "AVG")).toBe("4");
    expect(aggregateValues([1, "x", 5], "AVG")).toBe("3");
  });

  it("AVG returns \"0\" when no numeric values (degenerate average)", () => {
    // Match Airtable's behavior of treating an empty rollup as the
    // additive identity rather than rendering NaN or a sentinel.
    expect(aggregateValues(["x", null, undefined], "AVG")).toBe("0");
  });

  it("MIN/MAX return empty string when no numeric values", () => {
    expect(aggregateValues(["x", null], "MIN")).toBe("");
    expect(aggregateValues(["x", null], "MAX")).toBe("");
  });

  it("MIN and MAX pick numeric extremes", () => {
    expect(aggregateValues([5, 1, 3, 8, 2], "MIN")).toBe("1");
    expect(aggregateValues([5, 1, 3, 8, 2], "MAX")).toBe("8");
  });

  it("COUNT counts non-blank values regardless of type", () => {
    expect(aggregateValues([1, "", null, "x", undefined], "COUNT")).toBe("2");
  });

  it("CONCAT joins string representations with ', '", () => {
    expect(aggregateValues(["red", "green", "blue"], "CONCAT")).toBe(
      "red, green, blue",
    );
  });

  it("CONCAT skips null and empty values", () => {
    expect(aggregateValues(["a", null, "", "b"], "CONCAT")).toBe("a, b");
  });
});

describe("lookupValues", () => {
  it("joins target-field values from linked records", () => {
    const linked: BaseRecord[] = [
      { id: "r1", Name: "Alice" },
      { id: "r2", Name: "Bob" },
    ];
    expect(lookupValues(linked, "Name")).toBe("Alice, Bob");
  });

  it("expands array values inside the lookup field", () => {
    const linked: BaseRecord[] = [
      { id: "r1", Tags: ["urgent", "ops"] },
      { id: "r2", Tags: ["docs"] },
    ];
    expect(lookupValues(linked, "Tags")).toBe("urgent, ops, docs");
  });

  it("skips records missing the target field", () => {
    const linked: BaseRecord[] = [
      { id: "r1", Name: "Alice" },
      { id: "r2" },
      { id: "r3", Name: "Carol" },
    ];
    expect(lookupValues(linked, "Name")).toBe("Alice, Carol");
  });
});

describe("computeAutoNumber", () => {
  it("converts 0-based index to 1-based row number", () => {
    expect(computeAutoNumber(0)).toBe(1);
    expect(computeAutoNumber(41)).toBe(42);
  });
});

describe("findRecordsLinkingTo", () => {
  const records: BaseRecord[] = [
    { id: "r1", Name: "Project A", Tasks: ["t1", "t2"] },
    { id: "r2", Name: "Project B", Tasks: ["t2"] },
    { id: "r3", Name: "Project C", Tasks: [] },
  ];

  it("returns every record whose linkedField contains the target id", () => {
    expect(
      findRecordsLinkingTo(records, "Tasks", "t2").map((r) => r.id),
    ).toEqual(["r1", "r2"]);
    expect(
      findRecordsLinkingTo(records, "Tasks", "t1").map((r) => r.id),
    ).toEqual(["r1"]);
  });

  it("returns [] when the target id is not linked anywhere", () => {
    expect(findRecordsLinkingTo(records, "Tasks", "missing")).toEqual([]);
  });

  it("ignores records where the linkedField is not an array", () => {
    const mixed: BaseRecord[] = [
      { id: "r1", Tasks: ["t1"] },
      { id: "r2", Tasks: "t1" /* malformed */ },
    ];
    expect(findRecordsLinkingTo(mixed, "Tasks", "t1").map((r) => r.id)).toEqual([
      "r1",
    ]);
  });
});

describe("isReservedFieldName", () => {
  it("flags 'id' as reserved (it is the BaseRecord identifier key)", () => {
    expect(isReservedFieldName("id")).toBe(true);
  });

  it("flags whitespace-padded reserved names", () => {
    expect(isReservedFieldName("  id  ")).toBe(true);
  });

  it("is case-sensitive — 'ID' and 'Id' are NOT reserved", () => {
    // The data layer keys records by the literal string "id"; if a
    // future change wants to reserve case-insensitive variants we
    // should update this test deliberately.
    expect(isReservedFieldName("ID")).toBe(false);
    expect(isReservedFieldName("Id")).toBe(false);
  });

  it("does not flag ordinary user field names", () => {
    for (const name of ["Title", "id_old", "identifier", "primary_key", ""]) {
      expect(isReservedFieldName(name)).toBe(false);
    }
  });

  it("exposes RESERVED_FIELD_NAMES as a ReadonlySet containing 'id'", () => {
    expect(RESERVED_FIELD_NAMES.has("id")).toBe(true);
  });
});

describe("isComputedFieldType", () => {
  it("returns true exactly for the four computed types", () => {
    expect(isComputedFieldType("formula")).toBe(true);
    expect(isComputedFieldType("rollup")).toBe(true);
    expect(isComputedFieldType("lookup")).toBe(true);
    expect(isComputedFieldType("auto_number")).toBe(true);
  });

  it("returns false for every non-computed type", () => {
    // Spot-check the major non-computed buckets.
    expect(isComputedFieldType("text")).toBe(false);
    expect(isComputedFieldType("number")).toBe(false);
    expect(isComputedFieldType("checkbox")).toBe(false);
    expect(isComputedFieldType("multi_select")).toBe(false);
    expect(isComputedFieldType("linked_record")).toBe(false);
    expect(isComputedFieldType("currency")).toBe(false);
    expect(isComputedFieldType("percent")).toBe(false);
    expect(isComputedFieldType("rating")).toBe(false);
    expect(isComputedFieldType("duration")).toBe(false);
    expect(isComputedFieldType("attachment")).toBe(false);
    expect(isComputedFieldType("long_text")).toBe(false);
    expect(isComputedFieldType("date")).toBe(false);
    expect(isComputedFieldType("email")).toBe(false);
    expect(isComputedFieldType("phone")).toBe(false);
    expect(isComputedFieldType("url")).toBe(false);
    expect(isComputedFieldType("select")).toBe(false);
  });
});

describe("matchesFilter — per-type filtering", () => {
  it("empty filter always matches (so a half-typed input doesn't hide rows)", () => {
    expect(matchesFilter("text", "anything", "")).toBe(true);
    expect(matchesFilter("text", "anything", "   ")).toBe(true);
    expect(matchesFilter("number", 42, "")).toBe(true);
  });

  it("text/select: case-insensitive substring on the stored string", () => {
    expect(matchesFilter("text", "Hello World", "WORLD")).toBe(true);
    expect(matchesFilter("text", "Hello World", "xyz")).toBe(false);
    expect(matchesFilter("email", "alice@example.com", "EXAMPLE")).toBe(true);
    expect(matchesFilter("select", "Open", "ope")).toBe(true);
    expect(matchesFilter("text", null, "anything")).toBe(false);
  });

  it("numeric: bare number means equality", () => {
    expect(matchesFilter("number", 42, "42")).toBe(true);
    expect(matchesFilter("number", 42, "43")).toBe(false);
    expect(matchesFilter("currency", 1234.5, "1234.5")).toBe(true);
  });

  it("numeric: > / >= / < / <= / = operators", () => {
    expect(matchesFilter("number", 5, ">3")).toBe(true);
    expect(matchesFilter("number", 5, ">=5")).toBe(true);
    expect(matchesFilter("number", 5, ">5")).toBe(false);
    expect(matchesFilter("number", 5, "<=5")).toBe(true);
    expect(matchesFilter("number", 5, "<5")).toBe(false);
    expect(matchesFilter("number", 5, "=5")).toBe(true);
    expect(matchesFilter("rating", 4, ">=3")).toBe(true);
    expect(matchesFilter("rating", 2, ">=3")).toBe(false);
  });

  it("numeric on non-numeric value returns false", () => {
    expect(matchesFilter("number", "notanumber", ">0")).toBe(false);
    expect(matchesFilter("number", null, ">0")).toBe(false);
  });

  it("checkbox: literal true/false/1/0/yes/no", () => {
    expect(matchesFilter("checkbox", true, "true")).toBe(true);
    expect(matchesFilter("checkbox", true, "yes")).toBe(true);
    expect(matchesFilter("checkbox", true, "1")).toBe(true);
    expect(matchesFilter("checkbox", false, "false")).toBe(true);
    expect(matchesFilter("checkbox", false, "no")).toBe(true);
    expect(matchesFilter("checkbox", true, "false")).toBe(false);
    expect(matchesFilter("checkbox", false, "true")).toBe(false);
    // Non-boolean filter: no match.
    expect(matchesFilter("checkbox", true, "maybe")).toBe(false);
  });

  it("multi-valued: ANY array element substring-matches the filter", () => {
    expect(matchesFilter("multi_select", ["red", "blue", "green"], "blu")).toBe(
      true,
    );
    expect(matchesFilter("multi_select", ["red", "blue", "green"], "yellow")).toBe(
      false,
    );
    expect(matchesFilter("linked_record", ["abc123", "def456"], "DEF")).toBe(
      true,
    );
    expect(matchesFilter("attachment", ["foo.png", "bar.pdf"], "PDF")).toBe(
      true,
    );
    // Wrong-type input on a multi-valued column.
    expect(matchesFilter("multi_select", "not-an-array", "x")).toBe(false);
  });

  it("computed types substring-match the supplied displayValue", () => {
    expect(matchesFilter("formula", "ignored", "USD", "$1,234.56 USD")).toBe(
      true,
    );
    expect(matchesFilter("rollup", "ignored", "sum", "total: 42")).toBe(false);
    expect(matchesFilter("lookup", "ignored", "alice", "Alice")).toBe(true);
    // Missing displayValue (defensive default) matches empty string only.
    expect(matchesFilter("formula", "ignored", "x")).toBe(false);
  });

  // ──────────────────────────────────────────────────────────────────
  // auto_number
  //
  // `auto_number` columns store `null` for every record (the display
  // value is computed from the row position at render time).  Devin
  // Review PR #79 caught the filter path comparing the stored `null`
  // — coerced to `0` via `Number(null)` — against the user's input,
  // which always hid every row. The fix routes `auto_number` through
  // the same display-value path as formula / rollup / lookup, but
  // also keeps the operator-prefix grammar so the placeholder text
  // (`e.g. >10`) actually works.
  // ──────────────────────────────────────────────────────────────────
  it("auto_number: bare numeric filter equality against the display string", () => {
    expect(matchesFilter("auto_number", null, "3", "3")).toBe(true);
    expect(matchesFilter("auto_number", null, "3", "4")).toBe(false);
  });

  it("auto_number: > / >= / < / <= operators parse the display string as a number", () => {
    expect(matchesFilter("auto_number", null, ">5", "7")).toBe(true);
    expect(matchesFilter("auto_number", null, ">5", "5")).toBe(false);
    expect(matchesFilter("auto_number", null, ">=5", "5")).toBe(true);
    expect(matchesFilter("auto_number", null, "<3", "2")).toBe(true);
    expect(matchesFilter("auto_number", null, "<=3", "3")).toBe(true);
  });

  it("auto_number: stored null does NOT short-circuit to a numeric-zero match", () => {
    // The pre-fix code path did `Number(null) === 0` and matched
    // `=0` for every row. Pinning this case ensures we don't
    // regress: a row whose displayed value is 5 should NOT match
    // `=0`.
    expect(matchesFilter("auto_number", null, "=0", "5")).toBe(false);
    expect(matchesFilter("auto_number", null, ">0", "5")).toBe(true);
  });

  it("auto_number: non-numeric filter falls back to substring on the display string", () => {
    // Defensive: a user could type a non-numeric search string;
    // the matcher should still find a row whose display contains it.
    expect(matchesFilter("auto_number", null, "1", "10")).toBe(false); // bare-numeric branch — strict equality
    expect(matchesFilter("auto_number", null, "10", "10")).toBe(true);
  });

  it("computed types: numeric-operator filter on a non-numeric display string returns false", () => {
    // `>10` against a formula returning "hello" should hide the row
    // (not silently fall through to substring matching), so a
    // numeric filter on a text-valued formula behaves predictably.
    expect(matchesFilter("formula", "ignored", ">10", "hello")).toBe(false);
    expect(matchesFilter("rollup", "ignored", ">=5", "")).toBe(false);
  });

  it("falls back to substring on the raw value for a non-numeric filter on a numeric column", () => {
    // A bare numeric filter triggers equality (123 !== 234) — the
    // fallback only kicks in when the filter itself isn't numeric.
    // Useful for free-typed text like "ab" against a column that
    // happens to store numeric ids.
    expect(matchesFilter("number", "12abc34", "ABC")).toBe(true);
    expect(matchesFilter("number", "12abc34", "xyz")).toBe(false);
  });
});

describe("applyFieldRename — atomic cross-pointer rename", () => {
  // `BaseEditor.renameField` is meant to be atomic across every place
  // a field name lives on a `BaseField`:
  //   • `name`                  (the column label)
  //   • `linkedField`           (rollup / lookup → linked_record source)
  //   • `targetField`           (rollup / lookup → target column)
  //   • `linkedDisplayField`    (linked_record → display column)
  // The pre-fix `renameField` only patched pointers on **other** fields.
  // A self-referential pointer on the renamed field itself would survive
  // with the old name still embedded, which is the bug `BUG_0001` flagged.
  // These tests pin the post-fix contract.

  it("rewrites the field's own name", () => {
    const f: BaseField = { name: "Price", type: "number" };
    expect(applyFieldRename(f, "Price", "Cost").name).toBe("Cost");
  });

  it("rewrites linkedField when it points at the renamed name", () => {
    const f: BaseField = {
      name: "Total",
      type: "rollup",
      linkedField: "Links",
      targetField: "Amount",
      aggregation: "SUM",
    };
    expect(applyFieldRename(f, "Links", "Refs").linkedField).toBe("Refs");
  });

  it("rewrites targetField on a different field referencing the renamed column", () => {
    const f: BaseField = {
      name: "Total",
      type: "rollup",
      linkedField: "Links",
      targetField: "Price",
      aggregation: "SUM",
    };
    expect(applyFieldRename(f, "Price", "Cost").targetField).toBe("Cost");
  });

  it("rewrites linkedDisplayField for a linked_record field", () => {
    const f: BaseField = {
      name: "Refs",
      type: "linked_record",
      linkedDisplayField: "Title",
    };
    expect(applyFieldRename(f, "Title", "Name").linkedDisplayField).toBe(
      "Name",
    );
  });

  it("patches a self-referential pointer on the renamed field itself", () => {
    // The bug `BUG_0001` was: when renaming the field that owns the
    // self-reference (here, "Foo" → "Bar" on a rollup whose
    // `targetField` was also "Foo"), the rename atomicity broke
    // because only the `name` was rewritten — `targetField` kept the
    // stale "Foo". After the fix both must flip together.
    const f: BaseField = {
      name: "Foo",
      type: "rollup",
      linkedField: "Foo",
      targetField: "Foo",
      aggregation: "SUM",
    };
    const out = applyFieldRename(f, "Foo", "Bar");
    expect(out.name).toBe("Bar");
    expect(out.linkedField).toBe("Bar");
    expect(out.targetField).toBe("Bar");
  });

  it("does not touch pointers that reference a different name", () => {
    const f: BaseField = {
      name: "Total",
      type: "rollup",
      linkedField: "Links",
      targetField: "Amount",
      aggregation: "SUM",
    };
    const out = applyFieldRename(f, "Unrelated", "Renamed");
    expect(out.name).toBe("Total");
    expect(out.linkedField).toBe("Links");
    expect(out.targetField).toBe("Amount");
  });

  it("returns the same reference when nothing matched (React skips re-render)", () => {
    const f: BaseField = { name: "Price", type: "number" };
    expect(applyFieldRename(f, "Unrelated", "Renamed")).toBe(f);
  });

  it("returns a fresh object when at least one pointer changed", () => {
    const f: BaseField = {
      name: "Price",
      type: "number",
    };
    const out = applyFieldRename(f, "Price", "Cost");
    expect(out).not.toBe(f);
    // Original input must be untouched (no mutation in place).
    expect(f.name).toBe("Price");
  });

  it("leaves `formula` source untouched — that path goes through renameFieldInFormula", () => {
    // The helper deliberately does NOT touch `formula` so the call
    // chain in `BaseEditor.renameField` can route formula rewrites
    // through the shared escape-aware scanner in baseFormulaEngine.
    const f: BaseField = {
      name: "Total",
      type: "formula",
      formula: "{Price} + {Tax}",
    };
    const out = applyFieldRename(f, "Price", "Cost");
    // Field name moved, but formula source is byte-for-byte the same.
    expect(out.formula).toBe("{Price} + {Tax}");
  });
});
