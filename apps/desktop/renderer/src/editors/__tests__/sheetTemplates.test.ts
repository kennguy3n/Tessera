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
