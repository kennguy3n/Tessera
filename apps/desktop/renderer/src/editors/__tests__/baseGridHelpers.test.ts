import { describe, it, expect } from "vitest";
import {
  buildGroups,
  groupValueLabel,
  isEmptyGroupValue,
  colorForLabel,
  rowColor,
  clampFrozenCount,
  frozenLeftOffsets,
  EMPTY_GROUP_LABEL,
  EMPTY_GROUP_KEY,
  FROZEN_COL_WIDTH,
  SELECT_COL_WIDTH,
  ROWNUM_COL_WIDTH,
  cycleSort,
  sortRecordsByRules,
  pruneSorts,
  renameSortField,
  summaryKindsForFieldType,
  formatSummaryValue,
  formatDurationMinutes,
  pruneColumnSummaries,
  renameColumnSummaryKey,
  type SortRule,
} from "../baseGridHelpers";
import type { BaseRecord } from "../baseEditorTypes";

describe("groupValueLabel", () => {
  it("renders scalars and arrays, collapsing empties", () => {
    expect(groupValueLabel("Lead")).toBe("Lead");
    expect(groupValueLabel(42)).toBe("42");
    expect(groupValueLabel(["a", "b"])).toBe("a, b");
    expect(groupValueLabel(null)).toBe(EMPTY_GROUP_LABEL);
    expect(groupValueLabel("")).toBe(EMPTY_GROUP_LABEL);
    expect(groupValueLabel([])).toBe(EMPTY_GROUP_LABEL);
    expect(groupValueLabel("   ")).toBe(EMPTY_GROUP_LABEL);
  });
});

describe("buildGroups", () => {
  const recs: BaseRecord[] = [
    { id: "1", Stage: "Lead" },
    { id: "2", Stage: "Won" },
    { id: "3", Stage: "Lead" },
    { id: "4", Stage: "" },
    { id: "5", Stage: "Won" },
  ];

  it("returns one anonymous group when no field", () => {
    const g = buildGroups(recs, null);
    expect(g).toHaveLength(1);
    expect(g[0].records).toHaveLength(5);
  });

  it("partitions preserving first-appearance order", () => {
    const g = buildGroups(recs, "Stage");
    expect(g.map((x) => x.label)).toEqual(["Lead", "Won", EMPTY_GROUP_LABEL]);
    expect(g[0].records.map((r) => r.id)).toEqual(["1", "3"]);
    expect(g[1].records.map((r) => r.id)).toEqual(["2", "5"]);
  });

  it("sinks the empty group to the end and keys it with the sentinel", () => {
    const g = buildGroups(
      [
        { id: "1", Stage: "" },
        { id: "2", Stage: "Lead" },
      ],
      "Stage",
    );
    expect(g.map((x) => x.label)).toEqual(["Lead", EMPTY_GROUP_LABEL]);
    expect(g[g.length - 1].key).toBe(EMPTY_GROUP_KEY);
  });

  it("does not conflate a literal 'Empty' value with genuine blanks", () => {
    // A select option literally named "Empty" must form its OWN group,
    // keyed off the value (not sunk into the blank catch-all). Genuine
    // blanks still land in the trailing sentinel group.
    const g = buildGroups(
      [
        { id: "1", Stage: "Empty" }, // real value that happens to read "Empty"
        { id: "2", Stage: "Lead" },
        { id: "3", Stage: null }, // genuine blank
        { id: "4", Stage: "Empty" },
      ],
      "Stage",
    );
    // Two groups labelled "Empty" — the real-value one (in first-
    // appearance order) and the trailing blank sentinel — kept distinct
    // by their keys.
    const real = g.find((x) => x.key === EMPTY_GROUP_LABEL);
    const blank = g.find((x) => x.key === EMPTY_GROUP_KEY);
    expect(real?.records.map((r) => r.id)).toEqual(["1", "4"]);
    expect(blank?.records.map((r) => r.id)).toEqual(["3"]);
    // The blank sentinel group is sunk to the very end.
    expect(g[g.length - 1].key).toBe(EMPTY_GROUP_KEY);
    expect(g.map((x) => x.label)).toEqual([
      EMPTY_GROUP_LABEL,
      "Lead",
      EMPTY_GROUP_LABEL,
    ]);
  });
});

describe("isEmptyGroupValue", () => {
  it("treats null/blank/empty-array as empty and real values as non-empty", () => {
    expect(isEmptyGroupValue(null)).toBe(true);
    expect(isEmptyGroupValue(undefined)).toBe(true);
    expect(isEmptyGroupValue("")).toBe(true);
    expect(isEmptyGroupValue("   ")).toBe(true);
    expect(isEmptyGroupValue([])).toBe(true);
    expect(isEmptyGroupValue([null, ""])).toBe(true);
    // The literal string "Empty" is a real value, NOT a blank.
    expect(isEmptyGroupValue("Empty")).toBe(false);
    expect(isEmptyGroupValue(0)).toBe(false);
    expect(isEmptyGroupValue(false)).toBe(false);
    expect(isEmptyGroupValue(["a"])).toBe(false);
  });
});

describe("colorForLabel / rowColor", () => {
  it("is deterministic and stable for the same label", () => {
    expect(colorForLabel("Lead")).toBe(colorForLabel("Lead"));
    expect(colorForLabel("Lead")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns null only for genuinely empty label strings (not the literal 'Empty')", () => {
    expect(colorForLabel("")).toBeNull();
    // The label string "Empty" is a real option, so colorForLabel gives
    // it a stable color — emptiness gating happens upstream in rowColor.
    expect(colorForLabel(EMPTY_GROUP_LABEL)).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("rowColor reads the field value and gates emptiness off the RAW value", () => {
    expect(rowColor({ id: "1", S: "Won" }, "S")).toBe(colorForLabel("Won"));
    expect(rowColor({ id: "1", S: "" }, "S")).toBeNull();
    expect(rowColor({ id: "1", S: null }, "S")).toBeNull();
    expect(rowColor({ id: "1", S: [] }, "S")).toBeNull();
    expect(rowColor({ id: "1" }, null)).toBeNull();
  });

  it("does not strip the color from a record whose value is literally 'Empty'", () => {
    // Regression: a select option named "Empty" must get a real color
    // strip, distinct from genuine blanks (which get none).
    const real = rowColor({ id: "1", S: "Empty" }, "S");
    const blank = rowColor({ id: "2", S: null }, "S");
    expect(real).toBe(colorForLabel("Empty"));
    expect(real).toMatch(/^#[0-9a-f]{6}$/i);
    expect(blank).toBeNull();
  });
});

describe("clampFrozenCount", () => {
  it("clamps to [0, fieldCount-1] and floors", () => {
    expect(clampFrozenCount(0, 5)).toBe(0);
    expect(clampFrozenCount(-3, 5)).toBe(0);
    expect(clampFrozenCount(2, 5)).toBe(2);
    expect(clampFrozenCount(2.9, 5)).toBe(2);
    expect(clampFrozenCount(10, 5)).toBe(4);
    expect(clampFrozenCount(1, 1)).toBe(0);
    expect(clampFrozenCount(1, 0)).toBe(0);
  });
});

describe("frozenLeftOffsets", () => {
  it("returns [] when nothing frozen", () => {
    expect(frozenLeftOffsets(0)).toEqual([]);
  });

  it("accumulates select + rownum + frozen data column widths", () => {
    const offsets = frozenLeftOffsets(2);
    expect(offsets[0]).toBe(0); // select
    expect(offsets[1]).toBe(SELECT_COL_WIDTH); // rownum
    expect(offsets[2]).toBe(SELECT_COL_WIDTH + ROWNUM_COL_WIDTH); // col 1
    expect(offsets[3]).toBe(
      SELECT_COL_WIDTH + ROWNUM_COL_WIDTH + FROZEN_COL_WIDTH,
    ); // col 2
    expect(offsets).toHaveLength(4);
  });
});

describe("cycleSort", () => {
  it("a plain click on an unsorted column sets a single ascending sort", () => {
    expect(cycleSort([], "A", false)).toEqual([{ field: "A", dir: "asc" }]);
  });

  it("a plain re-click on the lone sorted column toggles its direction", () => {
    expect(cycleSort([{ field: "A", dir: "asc" }], "A", false)).toEqual([
      { field: "A", dir: "desc" },
    ]);
    expect(cycleSort([{ field: "A", dir: "desc" }], "A", false)).toEqual([
      { field: "A", dir: "asc" },
    ]);
  });

  it("a plain click on a DIFFERENT column collapses to a single sort", () => {
    expect(
      cycleSort(
        [
          { field: "A", dir: "desc" },
          { field: "B", dir: "asc" },
        ],
        "C",
        false,
      ),
    ).toEqual([{ field: "C", dir: "asc" }]);
  });

  it("a plain click while multi-sorted on that same column still collapses to a single asc sort", () => {
    // Two levels active; plain-clicking the primary should NOT just
    // toggle it in place — it collapses the whole multi-sort to a single
    // ascending sort on that column (Airtable behaviour).
    expect(
      cycleSort(
        [
          { field: "A", dir: "asc" },
          { field: "B", dir: "asc" },
        ],
        "A",
        false,
      ),
    ).toEqual([{ field: "A", dir: "asc" }]);
  });

  it("an additive (shift) click appends a new tie-break level", () => {
    expect(cycleSort([{ field: "A", dir: "asc" }], "B", true)).toEqual([
      { field: "A", dir: "asc" },
      { field: "B", dir: "asc" },
    ]);
  });

  it("an additive click on an existing level toggles only that level, preserving order", () => {
    expect(
      cycleSort(
        [
          { field: "A", dir: "asc" },
          { field: "B", dir: "asc" },
        ],
        "A",
        true,
      ),
    ).toEqual([
      { field: "A", dir: "desc" },
      { field: "B", dir: "asc" },
    ]);
  });
});

describe("sortRecordsByRules", () => {
  type Row = { id: string; a: string; b: string };
  const key = (r: Row, f: string): string =>
    f === "a" ? r.a : f === "b" ? r.b : "";
  const rows: Row[] = [
    { id: "1", a: "Apple", b: "2" },
    { id: "2", a: "Apple", b: "10" },
    { id: "3", a: "Banana", b: "1" },
  ];

  it("returns a copy in incoming order when no rules", () => {
    const out = sortRecordsByRules(rows, [], key);
    expect(out.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(out).not.toBe(rows);
  });

  it("sorts by a single rule with numeric-aware compare", () => {
    const out = sortRecordsByRules(rows, [{ field: "b", dir: "asc" }], key);
    // numeric collation: 1 < 2 < 10 (not lexicographic 1 < 10 < 2)
    expect(out.map((r) => r.id)).toEqual(["3", "1", "2"]);
  });

  it("applies the second rule only to break ties on the first", () => {
    const out = sortRecordsByRules(
      rows,
      [
        { field: "a", dir: "asc" },
        { field: "b", dir: "asc" },
      ],
      key,
    );
    // Both Apples first (b: 2 then 10), then Banana.
    expect(out.map((r) => r.id)).toEqual(["1", "2", "3"]);
  });

  it("honours descending direction per level", () => {
    const out = sortRecordsByRules(
      rows,
      [
        { field: "a", dir: "asc" },
        { field: "b", dir: "desc" },
      ],
      key,
    );
    expect(out.map((r) => r.id)).toEqual(["2", "1", "3"]);
  });
});

describe("pruneSorts", () => {
  it("drops rules whose field no longer exists, preserving order", () => {
    const sorts: SortRule[] = [
      { field: "A", dir: "asc" },
      { field: "B", dir: "desc" },
      { field: "C", dir: "asc" },
    ];
    expect(pruneSorts(sorts, new Set(["A", "C"]))).toEqual([
      { field: "A", dir: "asc" },
      { field: "C", dir: "asc" },
    ]);
  });

  it("returns the same reference when nothing is pruned", () => {
    const sorts: SortRule[] = [{ field: "A", dir: "asc" }];
    expect(pruneSorts(sorts, new Set(["A"]))).toBe(sorts);
  });
});

describe("renameSortField", () => {
  it("rewrites the field across every level it appears in", () => {
    const sorts: SortRule[] = [
      { field: "Old", dir: "desc" },
      { field: "B", dir: "asc" },
    ];
    expect(renameSortField(sorts, "Old", "New")).toEqual([
      { field: "New", dir: "desc" },
      { field: "B", dir: "asc" },
    ]);
  });

  it("returns the same reference when the field is absent", () => {
    const sorts: SortRule[] = [{ field: "A", dir: "asc" }];
    expect(renameSortField(sorts, "Old", "New")).toBe(sorts);
  });
});

describe("summaryKindsForFieldType", () => {
  it("offers the full numeric aggregation set for numeric types", () => {
    expect(summaryKindsForFieldType("number")).toEqual([
      "SUM",
      "AVG",
      "MIN",
      "MAX",
      "COUNT",
    ]);
    expect(summaryKindsForFieldType("currency")).toContain("SUM");
    expect(summaryKindsForFieldType("auto_number")).toContain("AVG");
  });

  it("offers only COUNT for non-numeric types", () => {
    expect(summaryKindsForFieldType("text")).toEqual(["COUNT"]);
    expect(summaryKindsForFieldType("select")).toEqual(["COUNT"]);
    expect(summaryKindsForFieldType("date")).toEqual(["COUNT"]);
  });
});

describe("formatSummaryValue", () => {
  it("passes COUNT / CONCAT through verbatim", () => {
    expect(formatSummaryValue("COUNT", "7")).toBe("7");
    expect(formatSummaryValue("CONCAT", "a, b")).toBe("a, b");
  });

  it("renders an empty numeric result as an em dash", () => {
    expect(formatSummaryValue("MIN", "")).toBe("—");
    expect(formatSummaryValue("MAX", "")).toBe("—");
  });

  it("rounds noisy floats to at most two fraction digits", () => {
    // Parse the (possibly locale-grouped) output back to a number so the
    // assertion is locale-independent.
    const out = formatSummaryValue("AVG", "0.30000000000000004");
    expect(Number(out.replace(/[^0-9.-]/g, ""))).toBeCloseTo(0.3, 5);
  });

  it("keeps integer sums intact", () => {
    const out = formatSummaryValue("SUM", "1000");
    expect(Number(out.replace(/[^0-9.-]/g, ""))).toBe(1000);
  });

  it("passes non-finite raw values through unchanged", () => {
    expect(formatSummaryValue("SUM", "NaN")).toBe("NaN");
  });

  // Type-aware display: a numeric aggregation must read the same as the
  // column's cells (Devin Review #179 — a SUM of "50%" + "30%" cells
  // should show "80%", not the raw fraction "0.8").
  it("formats a currency aggregation with the field symbol", () => {
    expect(
      formatSummaryValue("SUM", "1234.5", { type: "currency" }),
    ).toBe("$1,234.50");
    expect(
      formatSummaryValue("SUM", "1234.5", {
        type: "currency",
        currencySymbol: "€",
      }),
    ).toBe("€1,234.50");
  });

  it("formats a percent aggregation as a percentage with the configured precision", () => {
    expect(formatSummaryValue("SUM", "0.8", { type: "percent" })).toBe("80%");
    expect(
      formatSummaryValue("AVG", "0.1234", {
        type: "percent",
        percentPrecision: 2,
      }),
    ).toBe("12.34%");
  });

  it("formats a duration aggregation as h:mm", () => {
    expect(formatSummaryValue("SUM", "150", { type: "duration" })).toBe("2:30");
    // A fractional AVG floors to whole minutes.
    expect(formatSummaryValue("AVG", "90.5", { type: "duration" })).toBe("1:30");
  });

  it("never type-formats COUNT — a filled-cell count stays a bare integer", () => {
    expect(formatSummaryValue("COUNT", "6", { type: "currency" })).toBe("6");
    expect(formatSummaryValue("COUNT", "6", { type: "percent" })).toBe("6");
  });

  it("falls back to grouped numeric formatting for plain number columns", () => {
    expect(formatSummaryValue("SUM", "1000", { type: "number" })).toBe(
      (1000).toLocaleString(undefined, { maximumFractionDigits: 2 }),
    );
  });
});

describe("formatDurationMinutes", () => {
  it("renders whole minutes as h:mm with a zero-padded minute", () => {
    expect(formatDurationMinutes(0)).toBe("0:00");
    expect(formatDurationMinutes(5)).toBe("0:05");
    expect(formatDurationMinutes(150)).toBe("2:30");
  });

  it("clamps negatives to 0 and floors fractional minutes", () => {
    expect(formatDurationMinutes(-30)).toBe("0:00");
    expect(formatDurationMinutes(90.9)).toBe("1:30");
  });

  it("returns empty for nullish / non-finite input", () => {
    expect(formatDurationMinutes(null)).toBe("");
    expect(formatDurationMinutes(undefined)).toBe("");
    expect(formatDurationMinutes(NaN)).toBe("");
  });
});

describe("pruneColumnSummaries", () => {
  it("drops summaries for removed fields and keeps the rest", () => {
    expect(
      pruneColumnSummaries({ A: "SUM", B: "COUNT" }, new Set(["A"])),
    ).toEqual({ A: "SUM" });
  });

  it("returns the same reference when nothing is pruned", () => {
    const summaries = { A: "SUM" as const };
    expect(pruneColumnSummaries(summaries, new Set(["A"]))).toBe(summaries);
  });
});

describe("renameColumnSummaryKey", () => {
  it("moves the summary onto the renamed key", () => {
    expect(renameColumnSummaryKey({ Old: "SUM", B: "COUNT" }, "Old", "New")).toEqual(
      { B: "COUNT", New: "SUM" },
    );
  });

  it("returns the same reference when the field had no summary", () => {
    const summaries = { A: "SUM" as const };
    expect(renameColumnSummaryKey(summaries, "Old", "New")).toBe(summaries);
  });
});
