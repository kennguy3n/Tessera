import { describe, expect, it } from "vitest";
import {
  ALL_SHEET_TEMPLATES_CATEGORY,
  SHEET_TEMPLATES,
  SHEET_TEMPLATE_CATEGORIES,
  filterSheetTemplates,
  getSheetTemplate,
  sheetContentFromTemplate,
  type FilterableSheetTemplate,
  type SheetTemplate,
  type SheetTemplateContent,
} from "../sheetTemplates";

const CATEGORY_SET = new Set<string>(SHEET_TEMPLATE_CATEGORIES);
const FORMAT_KEY_RE = /^\d+,\d+$/;

describe("SHEET_TEMPLATES integrity", () => {
  it("ships several templates with unique ids", () => {
    expect(SHEET_TEMPLATES.length).toBeGreaterThanOrEqual(7);
    const ids = SHEET_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template carries complete, in-range metadata + content", () => {
    for (const t of SHEET_TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.icon.length).toBeGreaterThan(0);
      expect(CATEGORY_SET.has(t.category)).toBe(true);

      expect(t.content.columns.length).toBeGreaterThan(0);
      expect(t.content.rows.length).toBeGreaterThan(0);
      for (const row of t.content.rows) {
        expect(Array.isArray(row)).toBe(true);
        expect(row.length).toBeLessThanOrEqual(t.content.columns.length);
        for (const cell of row) expect(typeof cell).toBe("string");
      }
    }
  });

  it("every per-cell format key is a valid in-range row,col", () => {
    for (const t of SHEET_TEMPLATES) {
      if (!t.content.formats) continue;
      for (const key of Object.keys(t.content.formats)) {
        expect(key).toMatch(FORMAT_KEY_RE);
        const [row, col] = key.split(",").map(Number);
        expect(row).toBeLessThan(t.content.rows.length);
        expect(col).toBeLessThan(t.content.columns.length);
      }
    }
  });

  it("every chart / pivot carries a non-empty range string", () => {
    for (const t of SHEET_TEMPLATES) {
      for (const chart of t.content.charts ?? []) {
        expect(typeof chart.range).toBe("string");
        expect(chart.range.length).toBeGreaterThan(0);
      }
      for (const pivot of t.content.pivots ?? []) {
        expect(typeof pivot.range).toBe("string");
        expect(pivot.range.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("getSheetTemplate", () => {
  it("resolves a known id and returns undefined for an unknown one", () => {
    expect(getSheetTemplate("monthly-budget")?.id).toBe("monthly-budget");
    expect(getSheetTemplate("does-not-exist")).toBeUndefined();
  });
});

describe("filterSheetTemplates", () => {
  const items: FilterableSheetTemplate[] = [
    {
      label: "Monthly budget",
      description: "track spend",
      category: "Finance",
    },
    { label: "Sales forecast", description: "pipeline", category: "Sales" },
    {
      label: "Project tracker",
      description: "tasks",
      category: "Project Management",
    },
  ];

  it("returns everything for the All sentinel + empty query", () => {
    expect(
      filterSheetTemplates(items, ALL_SHEET_TEMPLATES_CATEGORY, ""),
    ).toHaveLength(3);
  });

  it("filters by category", () => {
    const out = filterSheetTemplates(items, "Finance", "");
    expect(out.map((t) => t.label)).toEqual(["Monthly budget"]);
  });

  it("matches the query against label, description, and category", () => {
    expect(
      filterSheetTemplates(items, ALL_SHEET_TEMPLATES_CATEGORY, "pipeline").map(
        (t) => t.label,
      ),
    ).toEqual(["Sales forecast"]);
    expect(
      filterSheetTemplates(items, ALL_SHEET_TEMPLATES_CATEGORY, "project").map(
        (t) => t.label,
      ),
    ).toEqual(["Project tracker"]);
  });

  it("is case-insensitive and trims the query", () => {
    expect(
      filterSheetTemplates(items, ALL_SHEET_TEMPLATES_CATEGORY, "  BUDGET  "),
    ).toHaveLength(1);
  });

  it("applies category and query together", () => {
    expect(filterSheetTemplates(items, "Sales", "budget")).toHaveLength(0);
  });

  it("filters the real built-in catalogue without throwing", () => {
    for (const category of SHEET_TEMPLATE_CATEGORIES) {
      const out = filterSheetTemplates(SHEET_TEMPLATES, category, "");
      for (const t of out) expect(t.category).toBe(category);
    }
  });
});

describe("sheetContentFromTemplate", () => {
  function pick(id: string): SheetTemplate {
    const t = getSheetTemplate(id);
    if (!t) throw new Error(`missing built-in: ${id}`);
    return t;
  }

  it("deep-copies columns + rows so edits never touch the built-in", () => {
    const template = pick("monthly-budget");
    const content = sheetContentFromTemplate(template.content);
    expect(content.columns).toEqual(template.content.columns);
    expect(content.columns).not.toBe(template.content.columns);
    expect(content.rows).not.toBe(template.content.rows);
    content.rows[0][0] = "MUTATED";
    expect(template.content.rows[0][0]).not.toBe("MUTATED");
  });

  it("deep-copies every nested collection so edits never touch the source", () => {
    const source: SheetTemplateContent = {
      columns: ["A", "B"],
      rows: [["1", "2"]],
      formats: { "0,0": { bold: true, numberFormat: "#,##0.00" } },
      conditionalRules: [
        {
          id: "r1",
          column: 0,
          operator: "gt",
          value: "0",
          style: { background: "#fee2e2", color: "#991b1b" },
        },
      ],
      validations: { "1": { kind: "list", values: ["x", "y"] } },
      charts: [{ id: "c1", type: "bar", range: "A1:B1" }],
      pivots: [
        { id: "p1", range: "A1:B2", rowField: 0, valueField: 1, agg: "sum" },
      ],
      namedRanges: [{ name: "Region", range: "A1:A2" }],
      columnWidths: [80, 120],
      rowHeights: [24],
    };
    const content = sheetContentFromTemplate(source);

    // Every nested container (and its elements) is a fresh reference.
    expect(content.formats).not.toBe(source.formats);
    expect(content.formats?.["0,0"]).not.toBe(source.formats?.["0,0"]);
    expect(content.conditionalRules).not.toBe(source.conditionalRules);
    expect(content.conditionalRules?.[0]).not.toBe(
      source.conditionalRules?.[0],
    );
    expect(content.conditionalRules?.[0]?.style).not.toBe(
      source.conditionalRules?.[0]?.style,
    );
    expect(content.validations).not.toBe(source.validations);
    expect(content.validations?.["1"]).not.toBe(source.validations?.["1"]);
    expect(content.charts).not.toBe(source.charts);
    expect(content.charts?.[0]).not.toBe(source.charts?.[0]);
    expect(content.pivots).not.toBe(source.pivots);
    expect(content.pivots?.[0]).not.toBe(source.pivots?.[0]);
    expect(content.namedRanges).not.toBe(source.namedRanges);
    expect(content.namedRanges?.[0]).not.toBe(source.namedRanges?.[0]);
    expect(content.columnWidths).not.toBe(source.columnWidths);
    expect(content.rowHeights).not.toBe(source.rowHeights);

    // Mutating the clone leaves the source built-in pristine.
    const cloneFmt = content.formats?.["0,0"];
    if (cloneFmt) cloneFmt.bold = false;
    expect(source.formats?.["0,0"]?.bold).toBe(true);

    const cloneRule = content.conditionalRules?.[0];
    if (cloneRule) cloneRule.style.background = "#000000";
    expect(source.conditionalRules?.[0]?.style.background).toBe("#fee2e2");

    const cloneVal = content.validations?.["1"];
    if (cloneVal && cloneVal.kind === "list") cloneVal.values.push("z");
    const srcVal = source.validations?.["1"];
    expect(srcVal && srcVal.kind === "list" ? srcVal.values.length : -1).toBe(
      2,
    );

    const cloneChart = content.charts?.[0];
    if (cloneChart) cloneChart.range = "ZZ1";
    expect(source.charts?.[0]?.range).toBe("A1:B1");

    const clonePivot = content.pivots?.[0];
    if (clonePivot) clonePivot.agg = "count";
    expect(source.pivots?.[0]?.agg).toBe("sum");

    const cloneNamed = content.namedRanges?.[0];
    if (cloneNamed) cloneNamed.range = "ZZ1";
    expect(source.namedRanges?.[0]?.range).toBe("A1:A2");

    if (content.columnWidths) content.columnWidths[0] = 999;
    expect(source.columnWidths?.[0]).toBe(80);

    if (content.rowHeights) content.rowHeights[0] = 999;
    expect(source.rowHeights?.[0]).toBe(24);
  });

  it("scores the KPI scorecard churn metric as lower-is-better", () => {
    const kpi = pick("kpi-scorecard");
    const churn = kpi.content.rows.find((row) => row[0] === "Churn");
    expect(churn).toBeDefined();
    // Attainment inverts to target / actual (column D), so beating the
    // lower churn target reads as >= 1 ("On track").
    expect(churn?.[3]).toBe("=B4/C4");
  });

  it("carries non-empty optional collections through", () => {
    const withFormats = SHEET_TEMPLATES.find(
      (t) => t.content.formats && Object.keys(t.content.formats).length > 0,
    );
    expect(withFormats).toBeDefined();
    if (!withFormats) return;
    const content = sheetContentFromTemplate(withFormats.content);
    expect(content.formats).toBeDefined();
  });

  it("omits empty optional collections (byte-identical to legacy JSON)", () => {
    const content = sheetContentFromTemplate({
      columns: ["A", "B"],
      rows: [["1", "2"]],
      charts: [],
      formats: {},
    });
    expect(content).toEqual({ columns: ["A", "B"], rows: [["1", "2"]] });
    expect("charts" in content).toBe(false);
    expect("formats" in content).toBe(false);
  });
});
