/**
 * Coverage for the manual per-cell formatting helpers: patch merge,
 * empty-collapse, boolean toggle semantics.
 */
import { describe, expect, it } from "vitest";

import type { CellCoord } from "../sheetSelection";
import {
  ALL_NUMBER_FORMAT_PRESETS,
  NUMBER_FORMAT_PRESETS,
  allCellsHave,
  applyFormatPatch,
  getCellFormat,
  groupedNumberFormatPresets,
  presetIdForPattern,
  presetPattern,
  toggleBoolFormat,
} from "../sheetFormatting";
import {
  LOCALE_CURRENCY_GROUP,
  LOCALE_DATE_GROUP,
} from "../localeNumberFormats";

const cells = (...pairs: [number, number][]): CellCoord[] =>
  pairs.map(([row, col]) => ({ row, col }));

describe("applyFormatPatch", () => {
  it("sets a format on each targeted cell", () => {
    const out = applyFormatPatch(undefined, cells([0, 0], [1, 2]), {
      bold: true,
    });
    expect(getCellFormat(out, 0, 0)).toEqual({ bold: true });
    expect(getCellFormat(out, 1, 2)).toEqual({ bold: true });
  });

  it("merges onto an existing format", () => {
    const a = applyFormatPatch(undefined, cells([0, 0]), { bold: true });
    const b = applyFormatPatch(a, cells([0, 0]), { italic: true });
    expect(getCellFormat(b, 0, 0)).toEqual({ bold: true, italic: true });
  });

  it("clears a field and removes a now-empty cell entry", () => {
    const a = applyFormatPatch(undefined, cells([0, 0]), { bold: true });
    const b = applyFormatPatch(a, cells([0, 0]), { bold: false });
    expect(getCellFormat(b, 0, 0)).toBeUndefined();
    // Whole map collapses to undefined when nothing remains.
    expect(b).toBeUndefined();
  });

  it("sets a number format and clears it via undefined", () => {
    const a = applyFormatPatch(undefined, cells([2, 3]), {
      numberFormat: "$#,##0.00",
    });
    expect(getCellFormat(a, 2, 3)?.numberFormat).toBe("$#,##0.00");
    const b = applyFormatPatch(a, cells([2, 3]), { numberFormat: undefined });
    expect(b).toBeUndefined();
  });

  it("is a no-op for an empty cell list", () => {
    const a = applyFormatPatch(undefined, [], { bold: true });
    expect(a).toBeUndefined();
  });
});

describe("toggleBoolFormat / allCellsHave", () => {
  it("turns the format ON when not all cells have it", () => {
    const start = applyFormatPatch(undefined, cells([0, 0]), { bold: true });
    const out = toggleBoolFormat(start, cells([0, 0], [0, 1]), "bold");
    expect(allCellsHave(out, cells([0, 0], [0, 1]), "bold")).toBe(true);
  });

  it("turns the format OFF when every cell already has it", () => {
    const start = applyFormatPatch(undefined, cells([0, 0], [0, 1]), {
      italic: true,
    });
    const out = toggleBoolFormat(start, cells([0, 0], [0, 1]), "italic");
    expect(allCellsHave(out, cells([0, 0], [0, 1]), "italic")).toBe(false);
  });

  it("allCellsHave is false for an empty selection", () => {
    expect(allCellsHave(undefined, [], "bold")).toBe(false);
  });
});

describe("number-format presets", () => {
  it("the base set is the prefix of the full set", () => {
    // The formula-engine test renders NUMBER_FORMAT_PRESETS exhaustively,
    // so the base set must stay the canonical, unextended menu.
    expect(
      ALL_NUMBER_FORMAT_PRESETS.slice(0, NUMBER_FORMAT_PRESETS.length),
    ).toEqual(NUMBER_FORMAT_PRESETS);
    expect(ALL_NUMBER_FORMAT_PRESETS.length).toBeGreaterThan(
      NUMBER_FORMAT_PRESETS.length,
    );
  });

  it("all preset ids are unique across the full menu", () => {
    const ids = ALL_NUMBER_FORMAT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every defined preset pattern is distinct (reverse-lookup is total)", () => {
    const patterns = ALL_NUMBER_FORMAT_PRESETS.map((p) => p.pattern).filter(
      (p): p is string => p !== undefined,
    );
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("presetPattern resolves base and locale ids, undefined for General", () => {
    expect(presetPattern("integer")).toBe("#,##0");
    expect(presetPattern("general")).toBeUndefined();
    // A locale preset id resolves to its built pattern too.
    const locale = ALL_NUMBER_FORMAT_PRESETS.find((p) => p.id === "date-eu");
    expect(locale?.pattern).toBe("dd/mm/yyyy");
    expect(presetPattern("date-eu")).toBe(locale?.pattern);
  });
});

describe("presetIdForPattern", () => {
  it("maps unset / empty to General", () => {
    expect(presetIdForPattern(undefined)).toBe("general");
    expect(presetIdForPattern("")).toBe("general");
  });

  it("reverse-maps a known preset pattern to its id", () => {
    expect(presetIdForPattern("#,##0")).toBe("integer");
    expect(presetIdForPattern("$#,##0.00")).toBe("currency");
  });

  it("falls back to custom for a hand-entered pattern", () => {
    expect(presetIdForPattern('0.0"x"')).toBe("custom");
  });

  it("round-trips every preset id ↔ pattern across the full menu", () => {
    for (const preset of ALL_NUMBER_FORMAT_PRESETS) {
      if (preset.pattern === undefined) continue;
      expect(presetIdForPattern(preset.pattern)).toBe(preset.id);
    }
  });
});

describe("groupedNumberFormatPresets", () => {
  it("clusters by group with the ungrouped common presets first", () => {
    const groups = groupedNumberFormatPresets();
    expect(groups[0].label).toBeUndefined();
    expect(groups[0].presets.some((p) => p.id === "general")).toBe(true);

    const labels = groups.map((g) => g.label);
    expect(labels).toContain(LOCALE_CURRENCY_GROUP);
    expect(labels).toContain(LOCALE_DATE_GROUP);
  });

  it("preserves every preset exactly once across the groups", () => {
    const groups = groupedNumberFormatPresets();
    const flat = groups.flatMap((g) => g.presets);
    expect(flat).toHaveLength(ALL_NUMBER_FORMAT_PRESETS.length);
    expect(new Set(flat.map((p) => p.id)).size).toBe(
      ALL_NUMBER_FORMAT_PRESETS.length,
    );
  });

  it("emits each group label only once", () => {
    const labels = groupedNumberFormatPresets().map((g) => g.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("groups a custom preset list independently of the default", () => {
    const groups = groupedNumberFormatPresets([
      { id: "a", label: "A", pattern: "0" },
      { id: "b", label: "B", pattern: "0.0", group: "G" },
      { id: "c", label: "C", pattern: "0.00", group: "G" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBeUndefined();
    expect(groups[0].presets.map((p) => p.id)).toEqual(["a"]);
    expect(groups[1].label).toBe("G");
    expect(groups[1].presets.map((p) => p.id)).toEqual(["b", "c"]);
  });
});
