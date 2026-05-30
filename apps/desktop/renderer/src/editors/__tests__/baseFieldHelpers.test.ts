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
} from "../baseEditorHelpers";
import type { BaseRecord } from "../baseEditorTypes";

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
