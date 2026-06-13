import { describe, it, expect } from "vitest";
import {
  buildGroups,
  groupValueLabel,
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
});

describe("colorForLabel / rowColor", () => {
  it("is deterministic and stable for the same label", () => {
    expect(colorForLabel("Lead")).toBe(colorForLabel("Lead"));
    expect(colorForLabel("Lead")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("returns null for empty-ish labels", () => {
    expect(colorForLabel("")).toBeNull();
    expect(colorForLabel(EMPTY_GROUP_LABEL)).toBeNull();
  });

  it("rowColor reads the field value", () => {
    expect(rowColor({ id: "1", S: "Won" }, "S")).toBe(colorForLabel("Won"));
    expect(rowColor({ id: "1", S: "" }, "S")).toBeNull();
    expect(rowColor({ id: "1" }, null)).toBeNull();
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
