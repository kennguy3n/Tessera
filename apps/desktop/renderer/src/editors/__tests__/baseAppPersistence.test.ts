import { describe, it, expect } from "vitest";
import {
  addTable,
  parseBaseDocument,
  removeTable,
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

describe("addTable / removeTable — app config preservation", () => {
  it("addTable preserves the app config verbatim (no orphaning possible)", () => {
    const base = singleTableDocument(legacy);
    const t0 = base.tables[0].id;
    const app: BaseAppConfig = {
      name: "Deals app",
      defaultMode: "app",
      forms: [{ id: "f1", name: "Intake", tableId: t0, fieldNames: ["Name"] }],
      dashboard: {
        title: "Overview",
        widgets: [{ id: "w1", kind: "count", tableId: t0 }],
      },
    };
    const next = addTable({ ...base, app }, "Reps");
    expect(next.tables).toHaveLength(2);
    expect(next.activeTableId).not.toBe(t0); // the new table is active
    // The app block survives the add untouched — adding a table can never
    // orphan an existing reference, so nothing is reconciled away.
    expect(next.app).toEqual(app);
  });

  it("removeTable preserves the app config and prunes refs to the removed table", () => {
    const base = singleTableDocument(legacy);
    const t0 = base.tables[0].id;
    const d1 = addTable(base, "Reps");
    const t1 = d1.activeTableId;
    const d2 = addTable(d1, "Deals");
    const t2 = d2.activeTableId;
    const app: BaseAppConfig = {
      name: "CRM",
      forms: [
        { id: "f0", name: "Deal intake", tableId: t0, fieldNames: ["Name"] },
        { id: "f1", name: "Rep intake", tableId: t1, fieldNames: [] },
        { id: "f2", name: "Pipe intake", tableId: t2, fieldNames: [] },
      ],
      dashboard: {
        widgets: [
          { id: "w0", kind: "count", tableId: t0 },
          { id: "w1", kind: "count", tableId: t1 },
        ],
      },
    };
    // Three tables survive down to two, so refs to the removed table are
    // genuinely dropped (no single-table healing in play).
    const next = removeTable({ ...d2, app }, t1);
    expect(next.tables.map((t) => t.id).sort()).toEqual([t0, t2].sort());
    expect(next.app).toBeDefined();
    expect(next.app?.name).toBe("CRM");
    expect(next.app?.forms.map((f) => f.id)).toEqual(["f0", "f2"]);
    expect(next.app?.dashboard.widgets.map((w) => w.id)).toEqual(["w0"]);
  });

  it("removeTable down to a single table drops refs to the removed table (no healing onto the survivor)", () => {
    const base = singleTableDocument(legacy);
    const t0 = base.tables[0].id;
    const d1 = addTable(base, "Reps");
    const t1 = d1.activeTableId;
    const app: BaseAppConfig = {
      name: "CRM",
      forms: [
        {
          id: "fSurvivor",
          name: "Deal intake",
          tableId: t0,
          fieldNames: ["Name"],
        },
        { id: "fRemoved", name: "Rep intake", tableId: t1, fieldNames: [] },
      ],
      dashboard: {
        widgets: [
          { id: "wSurvivor", kind: "count", tableId: t0 },
          { id: "wRemoved", kind: "count", tableId: t1 },
        ],
      },
    };
    // 2 -> 1: `resolveTableId`'s single-table healing would otherwise
    // re-point the removed table's form/widget onto the sole survivor.
    // They must be dropped, and the survivor's refs kept on its own id.
    const next = removeTable({ ...d1, app }, t1);
    expect(next.tables).toHaveLength(1);
    expect(next.tables[0].id).toBe(t0);
    expect(next.app?.forms.map((f) => f.id)).toEqual(["fSurvivor"]);
    expect(next.app?.forms.every((f) => f.tableId === t0)).toBe(true);
    expect(next.app?.dashboard.widgets.map((w) => w.id)).toEqual(["wSurvivor"]);
    expect(next.app?.dashboard.widgets.every((w) => w.tableId === t0)).toBe(
      true,
    );
  });

  it("removeTable drops the app entirely when reconcile leaves nothing meaningful", () => {
    const base = singleTableDocument(legacy);
    const d1 = addTable(base, "Reps");
    const t1 = d1.activeTableId;
    const d2 = addTable(d1, "Deals");
    // The only app content points at the table we remove, and there is no
    // name / title / defaultMode — so after pruning the config is empty
    // and must be dropped (keeps the no-`app` serialization invariant).
    const app: BaseAppConfig = {
      forms: [{ id: "f1", name: "Rep intake", tableId: t1, fieldNames: [] }],
      dashboard: { widgets: [{ id: "w1", kind: "count", tableId: t1 }] },
    };
    const next = removeTable({ ...d2, app }, t1);
    expect(next.app).toBeUndefined();
  });

  it("removeTable on an app-less doc stays app-less and does not throw", () => {
    const base = singleTableDocument(legacy);
    const d1 = addTable(base, "Reps");
    const next = removeTable(d1, d1.activeTableId);
    expect(next.app).toBeUndefined();
    expect(next.tables).toHaveLength(1);
  });
});
