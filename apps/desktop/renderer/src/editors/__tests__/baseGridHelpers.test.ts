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
