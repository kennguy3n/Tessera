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
  pruneViewStateAgainstFields,
  VIEW_CONFIG_FIELD_POINTERS,
  parseDurationFilterOperand,
} from "../baseEditorHelpers";
import type { BaseField, BaseRecord } from "../baseEditorTypes";
import type { BaseViewConfig } from "../baseviews/types";

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

  it("drops null / primitive / array elements from the fields array (defensive against hand-edited JSON)", () => {
    // Devin Review round-5 finding — `parsed.fields` is array-checked
    // but individual elements are unvalidated. `sanitizeBaseField(null)`
    // would crash on `field.percentPrecision`. The parser must
    // filter these out at the per-element level so the editor mounts
    // cleanly instead of unmounting with a TypeError.
    const json = JSON.stringify({
      fields: [
        null,
        42,
        "oops",
        [],
        { name: "Good", type: "text" },
        { name: "AlsoGood", type: "number" },
      ],
      records: [{ Good: "value", AlsoGood: 5 }],
    });
    const parsed = parseBaseContent(json);
    expect(parsed.fields).toHaveLength(2);
    expect(parsed.fields[0].name).toBe("Good");
    expect(parsed.fields[1].name).toBe("AlsoGood");
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

  // BUG_pr-review-job-b04adfa7…-0001: `Number(null) === 0` causes
  // every empty numeric cell to match a filter typed as "0", "=0",
  // ">=0", "<=0", or "<1". The old filter code (pre-PR-5) had an
  // explicit `if (val == null) return false;` that this matcher must
  // preserve.
  it("numeric: stored null / undefined / '' never matches a numeric filter (BUG-0001)", () => {
    for (const filter of ["0", "=0", ">=0", "<=0", "<1", ">-1", ">=-99"]) {
      expect(matchesFilter("number", null, filter)).toBe(false);
      expect(matchesFilter("number", undefined, filter)).toBe(false);
      expect(matchesFilter("number", "", filter)).toBe(false);
      expect(matchesFilter("currency", null, filter)).toBe(false);
      expect(matchesFilter("rating", null, filter)).toBe(false);
      expect(matchesFilter("duration", null, filter)).toBe(false);
      expect(matchesFilter("percent", null, filter)).toBe(false);
    }
    // Sanity: a populated cell still matches the same filters.
    expect(matchesFilter("number", 0, "0")).toBe(true);
    expect(matchesFilter("number", 5, "<10")).toBe(true);
  });

  // ANALYSIS_pr-review-job-b04adfa7…-0001: the computed-type branch
  // has the same `Number("") === 0` foot-gun as the numeric branch —
  // an empty display string would otherwise match "0", ">=0", etc.
  // The fix short-circuits any numeric comparison when the display
  // is empty / whitespace-only.
  it("computed: empty display never matches a numeric filter (ANALYSIS-0001)", () => {
    for (const filter of ["0", "=0", ">=0", "<=0", "<1", ">-1"]) {
      expect(matchesFilter("formula", "ignored", filter, "")).toBe(false);
      expect(matchesFilter("formula", "ignored", filter, " ")).toBe(false);
      expect(matchesFilter("rollup", "ignored", filter, "\t")).toBe(false);
      expect(matchesFilter("lookup", "ignored", filter)).toBe(false); // no display passed
      expect(matchesFilter("auto_number", null, filter, "")).toBe(false);
    }
    // Sanity: non-empty display still matches.
    expect(matchesFilter("formula", "ignored", "0", "0")).toBe(true);
    expect(matchesFilter("auto_number", null, ">5", "7")).toBe(true);
  });

  // ANALYSIS_pr-review-job-b04adfa7…-0006: percent stores fractions
  // but the user sees percentages. `>10` on a stored `0.5` (= 50%)
  // must match (50% > 10%), not return false because `0.5 > 10`.
  it("percent: filter operand is interpreted as a display percentage (ANALYSIS-0006)", () => {
    // `>10` means ">10%". Stored 0.5 (50%) matches; stored 0.05 (5%)
    // does not.
    expect(matchesFilter("percent", 0.5, ">10")).toBe(true);
    expect(matchesFilter("percent", 0.05, ">10")).toBe(false);
    // Boundary checks for `=` / `>=` / `<=` / `<`.
    expect(matchesFilter("percent", 0.5, "=50")).toBe(true);
    expect(matchesFilter("percent", 0.5, ">=50")).toBe(true);
    expect(matchesFilter("percent", 0.5, "<=50")).toBe(true);
    expect(matchesFilter("percent", 0.5, "<50")).toBe(false);
    expect(matchesFilter("percent", 0.4, "<50")).toBe(true);
    // Bare numeric → equals (also rescaled).
    expect(matchesFilter("percent", 0.25, "25")).toBe(true);
    expect(matchesFilter("percent", 0.25, "30")).toBe(false);
    // Non-numeric filter (free text) still falls back to substring
    // on the rendered stored value — no rescaling because there is
    // no operand to rescale.
    expect(matchesFilter("percent", 0.5, "0.5")).toBe(false); // not "50" → no match
    // Other numeric types are NOT rescaled — `currency` stored as
    // `100` matches `>50` literally (not >0.5).
    expect(matchesFilter("currency", 100, ">50")).toBe(true);
    expect(matchesFilter("currency", 100, "<50")).toBe(false);
    expect(matchesFilter("number", 100, ">50")).toBe(true);
    expect(matchesFilter("rating", 4, ">3")).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────
  // Percent operand may carry a trailing `%` (round 10 — ANALYSIS_…_0004)
  // ────────────────────────────────────────────────────────────────
  it("percent accepts a trailing `%` on the user's operand (ANALYSIS-0004 round 10)", () => {
    // The displayed value carries a `%` (`50%`), so the most natural
    // thing a user types is `>50%` not `>50`. Before round 10 the
    // regex rejected the `%`, then `Number("50%") = NaN` silently
    // dropped the filter into substring mode against `"0.5"`,
    // returning nothing. Now the percent branch strips a trailing
    // `%` from the operand before parsing.
    expect(matchesFilter("percent", 0.5, ">50%")).toBe(false);
    expect(matchesFilter("percent", 0.6, ">50%")).toBe(true);
    expect(matchesFilter("percent", 0.5, ">=50%")).toBe(true);
    expect(matchesFilter("percent", 0.5, "<=50%")).toBe(true);
    expect(matchesFilter("percent", 0.4, "<50%")).toBe(true);
    expect(matchesFilter("percent", 0.5, "=50%")).toBe(true);
    // Bare numeric with `%` also works (e.g. user just types `50%`).
    expect(matchesFilter("percent", 0.5, "50%")).toBe(true);
    expect(matchesFilter("percent", 0.5, "60%")).toBe(false);
    // Suffix is whitespace-tolerant — `50 %` reads as natural English.
    expect(matchesFilter("percent", 0.5, ">=50 %")).toBe(true);
    // The `%` strip is gated on `fieldType === "percent"` so other
    // numeric types still preserve the explicit-type contract: `>50%`
    // against a plain `number` falls through to substring (no implicit
    // rescaling).
    expect(matchesFilter("number", 75, ">50%")).toBe(false);
    expect(matchesFilter("currency", 75, ">50%")).toBe(false);
  });

  it("percent: lone `%` (or whitespace-only after strip) never matches (ANALYSIS-0004 round 11)", () => {
    // After stripping the trailing `%`, the operand is empty.
    // Without the empty-after-strip guard, `Number("") === 0` would
    // silently turn the filter into `= 0%` and match every zero-valued
    // row — a confusing footgun on a half-typed filter. The guard
    // returns false so rows are hidden instead of mass-matched against
    // an accidental zero.
    expect(matchesFilter("percent", 0, "%")).toBe(false);
    expect(matchesFilter("percent", 0.0, "%")).toBe(false);
    expect(matchesFilter("percent", 0.5, "%")).toBe(false);
    // Whitespace + lone `%` collapses to the same case.
    expect(matchesFilter("percent", 0, "  %  ")).toBe(false);
    // Sanity: a real numeric operand with `%` still works (the guard
    // only short-circuits the empty-after-strip case).
    expect(matchesFilter("percent", 0, "0%")).toBe(true);
    expect(matchesFilter("percent", 0.5, "50%")).toBe(true);
  });

  // ────────────────────────────────────────────────────────────────
  // Float-safe equality (PR #79 round 8 — ANALYSIS_…_0001)
  // ────────────────────────────────────────────────────────────────
  it("percent `=N` matches non-representable fractions like 33.3% (ANALYSIS-0001)", () => {
    // The stored value is the literal fraction the user can type
    // into a percent cell — `0.333` for 33.3%. The user's filter
    // operand is `33.3` which we rescale to `33.3 / 100`. That
    // rescale lands at `0.33300000000000002` in IEEE-754, so a
    // strict `===` comparison would silently match zero rows.
    // numbersApproxEqual collapses the rounding error so the
    // intuitive equality fires.
    expect(matchesFilter("percent", 0.333, "=33.3")).toBe(true);
    expect(matchesFilter("percent", 0.333, "33.3")).toBe(true); // bare numeric
    // 16.7% — another common non-representable percentage.
    expect(matchesFilter("percent", 0.167, "=16.7")).toBe(true);
    // Sanity: clearly distinct values still compare unequal — the
    // epsilon is small enough that `0.333` does NOT match `33.4`.
    expect(matchesFilter("percent", 0.333, "=33.4")).toBe(false);
  });

  it("number / currency `=N.M` is robust against any single multiply rounding error (ANALYSIS-0001)", () => {
    // A user storing the result of a single multiply (e.g. tax = price * 0.07)
    // can hit non-representable values on plain numeric columns too.
    // Verify the comparator applies symmetrically to every numeric type.
    expect(matchesFilter("number", 0.1 + 0.2, "=0.3")).toBe(true);
    expect(matchesFilter("number", 0.1 + 0.2, "0.3")).toBe(true);
    expect(matchesFilter("currency", 0.1 + 0.2, "=0.3")).toBe(true);
    // Clearly distinct values still compare unequal.
    expect(matchesFilter("number", 0.3001, "=0.3")).toBe(false);
  });

  // ────────────────────────────────────────────────────────────────
  // Duration filter accepts h:mm (round 12 — ANALYSIS_…_0003)
  //
  // Duration values are stored as integer minutes (`65` = 1h05m) but
  // the cell renders as `h:mm` (`1:05`). Before round 12 the filter
  // only accepted raw minutes, so a user looking at `1:05` and typing
  // `>1` got ">1 minute" (every non-empty row matches) instead of the
  // obviously-intended ">1 hour". The fix accepts BOTH formats — h:mm
  // (matches the display) AND raw minutes (power users).
  // ────────────────────────────────────────────────────────────────
  it("duration accepts both h:mm and raw-minutes operands (ANALYSIS-0003 round 12)", () => {
    // Stored 65 minutes (= 1:05). Operator + h:mm.
    expect(matchesFilter("duration", 65, ">1:00")).toBe(true);
    expect(matchesFilter("duration", 65, ">=1:05")).toBe(true);
    expect(matchesFilter("duration", 65, "<=1:05")).toBe(true);
    expect(matchesFilter("duration", 65, "<1:30")).toBe(true);
    expect(matchesFilter("duration", 65, "=1:05")).toBe(true);
    expect(matchesFilter("duration", 65, ">1:30")).toBe(false);
    // Bare h:mm → equality.
    expect(matchesFilter("duration", 65, "1:05")).toBe(true);
    expect(matchesFilter("duration", 65, "1:06")).toBe(false);
    // Raw minutes still work for backward compatibility / power users.
    // `>1` against a 1:05 cell now means ">1 minute" still (raw
    // minutes treat the bare integer as minutes — explicit choice),
    // but `>60` and `>1:00` both mean ">1 hour" and agree.
    expect(matchesFilter("duration", 65, ">60")).toBe(true);
    expect(matchesFilter("duration", 65, ">1:00")).toBe(true);
    expect(matchesFilter("duration", 65, "<70")).toBe(true);
    expect(matchesFilter("duration", 65, "=65")).toBe(true);
    expect(matchesFilter("duration", 65, "65")).toBe(true);
    // A user typing the cell display verbatim filters as expected
    // (the original UX failure: `>1:30` previously fell into substring
    // mode against `"90"` and silently matched nothing).
    expect(matchesFilter("duration", 90, ">1:30")).toBe(false);
    expect(matchesFilter("duration", 91, ">1:30")).toBe(true);
    expect(matchesFilter("duration", 120, ">=2:00")).toBe(true);
    // Multi-hour clock format: minutes >= 60 in the second segment is
    // rejected as malformed (`1:60` is not a real h:mm). Falls back
    // to substring on `String(value) = "120"` which doesn't include
    // `1:60`, so no match.
    expect(matchesFilter("duration", 120, "=1:60")).toBe(false);
    // Empty cell is still hidden by any numeric filter (same null /
    // empty guard as the other numeric types).
    expect(matchesFilter("duration", null, ">0")).toBe(false);
    expect(matchesFilter("duration", null, ">0:00")).toBe(false);
  });

  it("parseDurationFilterOperand round-trips h:mm and raw minutes", () => {
    // h:mm → minutes.
    expect(parseDurationFilterOperand("1:30")).toBe(90);
    expect(parseDurationFilterOperand("0:45")).toBe(45);
    expect(parseDurationFilterOperand("10:00")).toBe(600);
    expect(parseDurationFilterOperand("  1:05  ")).toBe(65);
    // Raw minutes pass through unchanged.
    expect(parseDurationFilterOperand("90")).toBe(90);
    expect(parseDurationFilterOperand("0")).toBe(0);
    expect(parseDurationFilterOperand("-15")).toBe(-15);
    // Invalid h:mm (minutes >= 60) → NaN so the caller falls through
    // to substring matching instead of silently treating `1:60` as
    // `2:00`.
    expect(Number.isNaN(parseDurationFilterOperand("1:60"))).toBe(true);
    expect(Number.isNaN(parseDurationFilterOperand("1:99"))).toBe(true);
    // Malformed / non-numeric → NaN.
    expect(Number.isNaN(parseDurationFilterOperand(""))).toBe(true);
    expect(Number.isNaN(parseDurationFilterOperand("abc"))).toBe(true);
    expect(Number.isNaN(parseDurationFilterOperand("1.5"))).toBe(true); // fractional minutes not accepted
    expect(Number.isNaN(parseDurationFilterOperand("1:"))).toBe(true);
    expect(Number.isNaN(parseDurationFilterOperand(":30"))).toBe(true);
    expect(Number.isNaN(parseDurationFilterOperand("1:2:3"))).toBe(true);
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

describe("pruneViewStateAgainstFields — drop stale references after import", () => {
  // The helper is the single source of truth for which view-state
  // domains we clean up on schema replacement. Devin Review flagged
  // a gap in the viewConfig cleanup on PR #79; these tests pin the
  // contract so future regressions can't slip past.
  const fields = (...names: string[]): BaseField[] =>
    names.map((name) => ({ name, type: "text" }));

  const viewConfigWith = (
    overrides: Partial<BaseViewConfig> = {},
  ): BaseViewConfig => ({
    kanbanGroupField: null,
    calendarDateField: null,
    timelineStartField: null,
    timelineEndField: null,
    galleryCoverField: null,
    titleField: null,
    ...overrides,
  });

  it("VIEW_CONFIG_FIELD_POINTERS enumerates every field-name pointer in BaseViewConfig", () => {
    // Anti-bitrot guard: if a new pointer is added to BaseViewConfig
    // (or one is removed), `VIEW_CONFIG_FIELD_POINTERS` must be
    // updated in lock-step or the rename / import cleanup paths will
    // silently drift.
    const sample = viewConfigWith();
    const expected = new Set(Object.keys(sample));
    const actual = new Set(VIEW_CONFIG_FIELD_POINTERS as readonly string[]);
    expect(actual).toEqual(expected);
  });

  it("drops sortField when its target no longer exists", () => {
    const out = pruneViewStateAgainstFields(fields("A", "B"), {
      sortField: "Removed",
      filters: {},
      viewConfig: viewConfigWith(),
    });
    expect(out.sortField).toBe(null);
  });

  it("keeps sortField when its target still exists (referential equality)", () => {
    const prev = {
      sortField: "A",
      filters: {},
      viewConfig: viewConfigWith(),
    };
    const out = pruneViewStateAgainstFields(fields("A", "B"), prev);
    expect(out.sortField).toBe("A");
    // Object reused when nothing changed.
    expect(out.filters).toBe(prev.filters);
    expect(out.viewConfig).toBe(prev.viewConfig);
  });

  it("removes filter entries whose key was dropped, keeps survivors", () => {
    const out = pruneViewStateAgainstFields(fields("A", "C"), {
      sortField: null,
      filters: { A: "foo", B: "bar", C: "baz" },
      viewConfig: viewConfigWith(),
    });
    expect(out.filters).toEqual({ A: "foo", C: "baz" });
  });

  it("nulls out kanban / calendar / timeline / gallery / title pointers when their target is gone (ANALYSIS-0002)", () => {
    const out = pruneViewStateAgainstFields(fields("Title"), {
      sortField: null,
      filters: {},
      viewConfig: viewConfigWith({
        kanbanGroupField: "Status",
        calendarDateField: "DueDate",
        timelineStartField: "Start",
        timelineEndField: "End",
        galleryCoverField: "Cover",
        titleField: "Title",
      }),
    });
    // Every pointer except Title is gone; Title survives.
    expect(out.viewConfig.kanbanGroupField).toBe(null);
    expect(out.viewConfig.calendarDateField).toBe(null);
    expect(out.viewConfig.timelineStartField).toBe(null);
    expect(out.viewConfig.timelineEndField).toBe(null);
    expect(out.viewConfig.galleryCoverField).toBe(null);
    expect(out.viewConfig.titleField).toBe("Title");
  });

  it("returns the input viewConfig by-reference when nothing needs nulling", () => {
    const prev = {
      sortField: null,
      filters: {},
      viewConfig: viewConfigWith({
        kanbanGroupField: "Status",
        titleField: "Name",
      }),
    };
    const out = pruneViewStateAgainstFields(
      fields("Status", "Name", "Other"),
      prev,
    );
    // No-op cleanup must preserve referential equality so React skips
    // the re-render. (`setViewConfig(prev => prev)` is a documented
    // bail-out path; the helper is consumed by exactly that pattern.)
    expect(out.viewConfig).toBe(prev.viewConfig);
  });

  it("handles all three domains in one pass when the schema changed completely", () => {
    const out = pruneViewStateAgainstFields(fields("New1", "New2"), {
      sortField: "OldSort",
      filters: { OldFilter: "x", New1: "keep" },
      viewConfig: viewConfigWith({
        kanbanGroupField: "OldStatus",
        titleField: "OldTitle",
      }),
    });
    expect(out.sortField).toBe(null);
    expect(out.filters).toEqual({ New1: "keep" });
    expect(out.viewConfig.kanbanGroupField).toBe(null);
    expect(out.viewConfig.titleField).toBe(null);
  });
});
