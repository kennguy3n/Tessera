/**
 * Phase 16 Task 13 — multi-sheet model + cross-sheet formula tests.
 *
 * Covers:
 *   - `toWorkbook` wraps legacy single-sheet content into one tab
 *   - `fromWorkbook` preserves the compact legacy shape when the
 *     workbook has exactly one default-named sheet
 *   - cross-sheet references (`Sheet2!A1`) evaluate correctly
 *   - quoted sheet names with spaces (`'My Sheet'!A1`) parse and
 *     resolve
 *   - missing-sheet refs return `#REF!`
 *   - the dependency graph qualifies keys with the sheet name
 */
import { describe, expect, it } from "vitest";

import {
  buildWorkbookDependencyGraph,
  dependenciesOfCell,
  evaluateWorkbookFormula,
  fromWorkbook,
  toWorkbook,
  type Workbook,
} from "../sheetEditorHelpers";
import { isFormulaError } from "../formulaEngine";
import type { SheetContent } from "../sheetEditorTypes";

function legacy(): SheetContent {
  return {
    columns: ["A", "B"],
    rows: [
      ["1", "2"],
      ["3", "4"],
    ],
  };
}

describe("toWorkbook / fromWorkbook backward-compat", () => {
  it("wraps legacy content in a single Sheet1 tab", () => {
    const wb = toWorkbook(legacy());
    expect(wb.sheets).toHaveLength(1);
    expect(wb.sheets[0].name).toBe("Sheet1");
    expect(wb.activeSheetIndex).toBe(0);
    expect(wb.sheets[0].rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("round-trips legacy content without introducing a `sheets` field", () => {
    const out = fromWorkbook(toWorkbook(legacy()));
    expect(out.sheets).toBeUndefined();
    expect(out.activeSheetIndex).toBeUndefined();
    expect(out.formats).toBeUndefined();
    expect(out.rows).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("preserves the `sheets` field when there is more than one tab", () => {
    const wb: Workbook = {
      activeSheetIndex: 0,
      sheets: [
        { name: "Sheet1", columns: ["A"], rows: [["1"]] },
        { name: "Sheet2", columns: ["A"], rows: [["2"]] },
      ],
    };
    const out = fromWorkbook(wb);
    expect(out.sheets).toHaveLength(2);
    expect(out.activeSheetIndex).toBe(0);
  });

  it("preserves the `sheets` field when the single sheet has a non-default name", () => {
    const wb: Workbook = {
      activeSheetIndex: 0,
      sheets: [{ name: "Inventory", columns: ["A"], rows: [["1"]] }],
    };
    const out = fromWorkbook(wb);
    expect(out.sheets).toHaveLength(1);
    expect(out.sheets?.[0].name).toBe("Inventory");
  });
});

describe("cross-sheet formula evaluation", () => {
  const workbook: Workbook = {
    activeSheetIndex: 0,
    sheets: [
      {
        name: "Sheet1",
        columns: ["A", "B"],
        rows: [
          ["10", "20"],
          ["30", "40"],
        ],
      },
      {
        name: "Sheet2",
        columns: ["A", "B"],
        rows: [
          ["100", "200"],
          ["300", "400"],
        ],
      },
      {
        name: "My Data",
        columns: ["A"],
        rows: [["7"]],
      },
    ],
  };

  it("resolves a bare cross-sheet ref", () => {
    expect(evaluateWorkbookFormula("=Sheet2!A1", workbook)).toBe(100);
  });

  it("resolves a cross-sheet range in a function", () => {
    expect(evaluateWorkbookFormula("=SUM(Sheet2!A1:B2)", workbook)).toBe(1000);
  });

  it("supports cross-sheet arithmetic mixing two sheets", () => {
    expect(evaluateWorkbookFormula("=Sheet1!A1 + Sheet2!A1", workbook)).toBe(
      110,
    );
  });

  it("supports quoted sheet names with spaces", () => {
    expect(evaluateWorkbookFormula("='My Data'!A1", workbook)).toBe(7);
  });

  it("returns #REF! for a missing sheet", () => {
    const v = evaluateWorkbookFormula("=Ghost!A1", workbook);
    expect(isFormulaError(v) && v.code).toBe("#REF!");
  });

  it("unqualified refs in cross-sheet formulas stay local to the owning sheet", () => {
    // Sheet2!A2 contains "=A1" (unqualified) → should resolve to
    // Sheet2!A1 = 100, not Sheet1!A1 = 10.
    const wb: Workbook = {
      activeSheetIndex: 0,
      sheets: [
        {
          name: "Sheet1",
          columns: ["A"],
          rows: [["10"], ["=Sheet2!A2"]],
        },
        {
          name: "Sheet2",
          columns: ["A"],
          rows: [["100"], ["=A1"]],
        },
      ],
    };
    expect(evaluateWorkbookFormula("=Sheet1!A2", wb)).toBe(100);
  });

  it("cross-sheet self-loop does not false-positive as a cycle", () => {
    // Sheet1!A1 references Sheet2!A1 and vice versa with different
    // coordinates — should evaluate to a real number, not #CIRCULAR!.
    const wb: Workbook = {
      activeSheetIndex: 0,
      sheets: [
        {
          name: "Sheet1",
          columns: ["A"],
          rows: [["=Sheet2!A1 + 1"]],
        },
        {
          name: "Sheet2",
          columns: ["A"],
          rows: [["41"]],
        },
      ],
    };
    expect(evaluateWorkbookFormula("=Sheet1!A1", wb)).toBe(42);
  });

  it("detects a real cross-sheet circular reference", () => {
    const wb: Workbook = {
      activeSheetIndex: 0,
      sheets: [
        {
          name: "Sheet1",
          columns: ["A"],
          rows: [["=Sheet2!A1"]],
        },
        {
          name: "Sheet2",
          columns: ["A"],
          rows: [["=Sheet1!A1"]],
        },
      ],
    };
    const v = evaluateWorkbookFormula("=Sheet1!A1", wb);
    expect(isFormulaError(v) && v.code).toBe("#CIRCULAR!");
  });
});

describe("workbook dependency graph", () => {
  it("emits sheet-qualified keys", () => {
    const wb: Workbook = {
      activeSheetIndex: 0,
      sheets: [
        {
          name: "Sheet1",
          columns: ["A", "B"],
          rows: [
            ["1", "=Sheet2!A1"],
            ["", ""],
          ],
        },
        {
          name: "Sheet2",
          columns: ["A"],
          rows: [["10"]],
        },
      ],
    };
    const graph = buildWorkbookDependencyGraph(wb);
    // Keys are sheet-qualified AND case-folded — `cellKey()` lowercases
    // the sheet name for case-insensitive reference handling.
    const deps = graph.dependsOn("sheet1!0,1");
    expect(deps.has("sheet2!0,0")).toBe(true);
    // And the reverse index works too.
    expect(graph.usedBy("sheet2!0,0").has("sheet1!0,1")).toBe(true);
  });
});

describe("dependenciesOfCell", () => {
  it("qualifies unqualified refs with the active sheet", () => {
    const deps = dependenciesOfCell("=A1+B2", "Sheet1");
    expect(deps.has("sheet1!0,0")).toBe(true);
    expect(deps.has("sheet1!1,1")).toBe(true);
  });
  it("returns empty for non-formula text", () => {
    expect(dependenciesOfCell("hello").size).toBe(0);
  });
});
