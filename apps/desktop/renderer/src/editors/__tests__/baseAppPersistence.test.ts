import { describe, it, expect } from "vitest";
import {
  parseBaseDocument,
  serializeBaseDocument,
  singleTableDocument,
} from "../baseDocumentHelpers";
import type { BaseAppConfig, BaseContent } from "../baseEditorTypes";

const legacy: BaseContent = {
  fields: [
    { name: "Name", type: "text" },
    { name: "Stage", type: "select", options: ["Lead", "Won"] },
  ],
  records: [
    { id: "r1", Name: "A", Stage: "Lead" },
    { id: "r2", Name: "B", Stage: "Won" },
  ],
};

const meaningfulApp: BaseAppConfig = {
  name: "Deals app",
  defaultMode: "app",
  forms: [{ id: "f1", name: "Intake", tableId: "t1", fieldNames: ["Name"] }],
  dashboard: {
    title: "Overview",
    widgets: [{ id: "w1", kind: "count", tableId: "t1" }],
  },
};

describe("app config persistence — backward compatibility", () => {
  it("a single-table base with NO app config stays byte-identical legacy", () => {
    const doc = parseBaseDocument(JSON.stringify(legacy));
    expect(doc.app).toBeUndefined();
    expect(JSON.parse(serializeBaseDocument(doc))).toEqual(legacy);
  });

  it("an empty/builder-default app config is NOT persisted", () => {
    const doc = singleTableDocument(legacy);
    const withEmpty = {
      ...doc,
      app: { forms: [], dashboard: { widgets: [] } },
    };
    const parsed = JSON.parse(serializeBaseDocument(withEmpty));
    expect(parsed.app).toBeUndefined();
    expect(Object.keys(parsed).sort()).toEqual(["fields", "records"]);
  });

  it("a legacy body that gains a meaningful app sibling opens in app mode", () => {
    // Simulate a stored single-table body that ALSO carries an additive
    // `app` key (as serializeBaseDocument would now emit once app config
    // is meaningful) — but here in the legacy `{fields,records,app}` form.
    const stored = JSON.stringify({ ...legacy, app: meaningfulApp });
    const doc = parseBaseDocument(stored);
    expect(doc.app).toBeDefined();
    expect(doc.app?.defaultMode).toBe("app");
  });
});

describe("app config persistence — round trip", () => {
  it("serializes the full multi-table shape once app config is meaningful", () => {
    const base = singleTableDocument(legacy);
    const tableId = base.tables[0].id;
    const app: BaseAppConfig = {
      ...meaningfulApp,
      forms: [{ id: "f1", name: "Intake", tableId, fieldNames: ["Name"] }],
      dashboard: {
        title: "Overview",
        widgets: [{ id: "w1", kind: "count", tableId }],
      },
    };
    const doc = { ...base, app };
    const json = serializeBaseDocument(doc);
    const parsed = JSON.parse(json);
    expect(Array.isArray(parsed.tables)).toBe(true);
    expect(parsed.activeTableId).toBe(tableId);
    expect(parsed.app.name).toBe("Deals app");

    // Re-parsing preserves the config and keeps refs valid.
    const round = parseBaseDocument(json);
    expect(round.app?.forms[0].fieldNames).toEqual(["Name"]);
    expect(round.app?.dashboard.widgets[0].kind).toBe("count");
    expect(round.app?.forms[0].tableId).toBe(round.tables[0].id);
  });

  it("reconciles a dangling field ref away on load", () => {
    const base = singleTableDocument(legacy);
    const tableId = base.tables[0].id;
    const app: BaseAppConfig = {
      forms: [
        { id: "f1", name: "Intake", tableId, fieldNames: ["Name", "Ghost"] },
      ],
      dashboard: {
        widgets: [
          {
            id: "w1",
            kind: "group",
            tableId,
            groupByField: "Ghost",
          },
        ],
      },
    };
    const json = serializeBaseDocument({ ...base, app });
    const round = parseBaseDocument(json);
    expect(round.app?.forms[0].fieldNames).toEqual(["Name"]);
    expect(round.app?.dashboard.widgets[0].groupByField).toBeUndefined();
  });

  it("ignores a malformed app key without throwing", () => {
    const stored = JSON.stringify({ ...legacy, app: "garbage" });
    const doc = parseBaseDocument(stored);
    expect(doc.app).toBeUndefined();
    expect(doc.tables).toHaveLength(1);
  });
});
