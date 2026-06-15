import { describe, expect, it } from "vitest";
import {
  BASE_TEMPLATES,
  BASE_TEMPLATE_CATEGORIES,
  findBaseTemplate,
  type BaseTemplateCategory,
} from "../baseTemplates";
import {
  parseBaseDocument,
  serializeBaseDocument,
} from "../baseDocumentHelpers";
import { isMeaningfulAppConfig } from "../baseviews/appmode/appConfig";
import type { BaseAppConfig, BaseDocument } from "../baseEditorTypes";

/** Collect every table-id referenced by an app config's forms + widgets. */
function referencedTableIds(app: BaseAppConfig): string[] {
  return [
    ...app.forms.map((f) => f.tableId),
    ...app.dashboard.widgets.map((w) => w.tableId),
  ];
}

describe("BASE_TEMPLATES built-in starters", () => {
  it("exposes the documented set of starters", () => {
    expect(BASE_TEMPLATES.map((t) => t.id)).toEqual([
      "crm",
      "project-tracker",
      "content-calendar",
      "applicant-tracker",
      "asset-inventory",
    ]);
  });

  it("gives every starter a non-empty label/description and a known category", () => {
    const categories = new Set<BaseTemplateCategory>(BASE_TEMPLATE_CATEGORIES);
    for (const template of BASE_TEMPLATES) {
      expect(template.label.trim().length).toBeGreaterThan(0);
      expect(template.description.trim().length).toBeGreaterThan(0);
      expect(categories.has(template.category)).toBe(true);
    }
  });

  it.each(BASE_TEMPLATES.map((t) => [t.id, t] as const))(
    "builds a coherent, app-wired document for %s",
    (_id, template) => {
      const doc = template.build();

      // A valid single document: at least one table, active id resolves.
      expect(doc.tables.length).toBeGreaterThan(0);
      const activeIds = new Set(doc.tables.map((t) => t.id));
      expect(activeIds.has(doc.activeTableId)).toBe(true);

      // Every table carries fields + sample records (a usable starter).
      for (const t of doc.tables) {
        expect(t.fields.length).toBeGreaterThan(0);
        expect(t.records.length).toBeGreaterThan(0);
      }

      // The embedded app config is meaningful and references only real
      // tables + fields (so app mode renders with no dangling pointers).
      expect(doc.app).toBeDefined();
      const app = doc.app as BaseAppConfig;
      expect(isMeaningfulAppConfig(app)).toBe(true);

      const tableById = new Map(doc.tables.map((t) => [t.id, t]));
      for (const tableId of referencedTableIds(app)) {
        expect(activeIds.has(tableId)).toBe(true);
      }
      for (const form of app.forms) {
        const fields = new Set(
          (tableById.get(form.tableId)?.fields ?? []).map((f) => f.name),
        );
        for (const name of form.fieldNames) {
          expect(fields.has(name)).toBe(true);
        }
      }
      for (const widget of app.dashboard.widgets) {
        const fields = new Set(
          (tableById.get(widget.tableId)?.fields ?? []).map((f) => f.name),
        );
        if (widget.groupByField)
          expect(fields.has(widget.groupByField)).toBe(true);
        if (widget.valueField) expect(fields.has(widget.valueField)).toBe(true);
      }
    },
  );

  it("does NOT force app mode — starters open in builder mode", () => {
    for (const template of BASE_TEMPLATES) {
      expect(template.build().app?.defaultMode).toBeUndefined();
    }
  });

  it("mints fresh table ids on every build (two inserts never collide)", () => {
    for (const template of BASE_TEMPLATES) {
      const a = template.build();
      const b = template.build();
      const aIds = a.tables.map((t) => t.id);
      const bIds = b.tables.map((t) => t.id);
      for (const id of aIds) expect(bIds).not.toContain(id);
    }
  });

  it("round-trips through the artifact codec unchanged in shape", () => {
    for (const template of BASE_TEMPLATES) {
      const doc = template.build();
      const reparsed: BaseDocument = parseBaseDocument(
        serializeBaseDocument(doc),
      );
      expect(reparsed.tables.length).toBe(doc.tables.length);
      expect(reparsed.activeTableId).toBe(doc.activeTableId);
      // App config survives the round-trip (it is meaningful).
      expect(reparsed.app).toBeDefined();
    }
  });
});

describe("findBaseTemplate", () => {
  it("resolves a known id", () => {
    expect(findBaseTemplate("crm")?.id).toBe("crm");
  });

  it("is total — null for unknown / absent ids", () => {
    expect(findBaseTemplate("nope")).toBeNull();
    expect(findBaseTemplate(undefined)).toBeNull();
    expect(findBaseTemplate(null)).toBeNull();
  });
});
