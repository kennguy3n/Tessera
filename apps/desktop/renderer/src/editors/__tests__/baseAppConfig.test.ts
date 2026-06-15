import { describe, it, expect } from "vitest";
import {
  emptyAppConfig,
  sanitizeAppConfig,
  resolveTableId,
  reconcileAppConfig,
  isMeaningfulAppConfig,
  initialAppMode,
  formFields,
  titleFieldName,
  recordTitle,
  listFieldPreview,
  derivePages,
  createForm,
  createWidget,
  renameFieldInAppConfig,
  DASHBOARD_PAGE_ID,
  dataPageId,
  formPageId,
} from "../baseviews/appmode/appConfig";
import { makeTableResolver } from "../baseDocumentHelpers";
import type {
  BaseAppConfig,
  BaseDocument,
  BaseField,
  BaseRecord,
  BaseTable,
} from "../baseEditorTypes";

const table = (
  id: string,
  name: string,
  fields: BaseField[],
  records: BaseDocument["tables"][number]["records"] = [],
): BaseTable => ({ id, name, fields, records });

const peopleFields: BaseField[] = [
  { name: "Name", type: "text" },
  { name: "Stage", type: "select", options: ["Lead", "Won"] },
  { name: "Value", type: "currency" },
  { name: "Computed", type: "formula", formula: "1" },
];

const singleDoc = (): BaseDocument => ({
  tables: [table("t1", "People", peopleFields)],
  activeTableId: "t1",
});

const multiDoc = (): BaseDocument => ({
  tables: [
    table("t1", "People", peopleFields),
    table("t2", "Tasks", [{ name: "Title", type: "text" }]),
  ],
  activeTableId: "t1",
});

describe("sanitizeAppConfig", () => {
  it("returns undefined for non-record input (legacy stays app-less)", () => {
    expect(sanitizeAppConfig(undefined)).toBeUndefined();
    expect(sanitizeAppConfig(null)).toBeUndefined();
    expect(sanitizeAppConfig("nope")).toBeUndefined();
    expect(sanitizeAppConfig([1, 2])).toBeUndefined();
  });

  it("coerces a well-formed config and defaults missing collections", () => {
    const app = sanitizeAppConfig({});
    expect(app).toEqual(emptyAppConfig());
  });

  it("drops unknown widget kinds to 'count' and invalid aggregations", () => {
    const app = sanitizeAppConfig({
      dashboard: {
        widgets: [
          { id: "w1", kind: "pie", tableId: "t1" },
          { id: "w2", kind: "rollup", tableId: "t1", aggregation: "MODE" },
        ],
      },
    });
    expect(app?.dashboard.widgets[0].kind).toBe("count");
    expect(app?.dashboard.widgets[1].aggregation).toBeUndefined();
  });

  it("skips non-record forms/widgets and trims blank strings", () => {
    const app = sanitizeAppConfig({
      name: "  My App  ",
      defaultMode: "app",
      forms: [42, { id: "f1", name: "  Intake  ", tableId: "t1" }],
      dashboard: { title: "   ", widgets: ["x"] },
    });
    expect(app?.name).toBe("My App");
    expect(app?.defaultMode).toBe("app");
    expect(app?.forms).toHaveLength(1);
    expect(app?.forms[0].name).toBe("Intake");
    expect(app?.dashboard.title).toBeUndefined();
    expect(app?.dashboard.widgets).toHaveLength(0);
  });

  it("keeps only string field names and mints ids when missing", () => {
    const app = sanitizeAppConfig({
      forms: [{ tableId: "t1", fieldNames: ["Name", 7, "Value"] }],
    });
    expect(app?.forms[0].fieldNames).toEqual(["Name", "Value"]);
    expect(app?.forms[0].id).toBeTruthy();
    expect(app?.forms[0].name).toBe("Form 1");
  });

  it("ignores an unknown defaultMode value", () => {
    expect(
      sanitizeAppConfig({ defaultMode: "weird" })?.defaultMode,
    ).toBeUndefined();
  });
});

describe("resolveTableId", () => {
  it("returns an exact match", () => {
    expect(resolveTableId(multiDoc(), "t2")).toBe("t2");
  });
  it("heals a dangling id to the sole table for single-table docs", () => {
    expect(resolveTableId(singleDoc(), "stale-id")).toBe("t1");
  });
  it("returns undefined for a missing id in a multi-table doc", () => {
    expect(resolveTableId(multiDoc(), "ghost")).toBeUndefined();
  });
});

describe("reconcileAppConfig", () => {
  it("heals single-table refs and prunes invalid field names", () => {
    const app: BaseAppConfig = {
      forms: [
        {
          id: "f1",
          name: "Intake",
          tableId: "stale",
          fieldNames: ["Name", "Ghost", "Computed"],
        },
      ],
      dashboard: {
        widgets: [
          {
            id: "w1",
            kind: "group",
            tableId: "stale",
            groupByField: "Stage",
            valueField: "Ghost",
          },
        ],
      },
    };
    const out = reconcileAppConfig(app, singleDoc());
    expect(out.forms[0].tableId).toBe("t1");
    // "Computed" is a formula (not fillable) and "Ghost" is missing.
    expect(out.forms[0].fieldNames).toEqual(["Name"]);
    expect(out.dashboard.widgets[0].tableId).toBe("t1");
    expect(out.dashboard.widgets[0].groupByField).toBe("Stage");
    expect(out.dashboard.widgets[0].valueField).toBeUndefined();
  });

  it("drops forms/widgets whose table is gone in a multi-table doc", () => {
    const app: BaseAppConfig = {
      forms: [{ id: "f1", name: "X", tableId: "ghost", fieldNames: [] }],
      dashboard: {
        widgets: [{ id: "w1", kind: "count", tableId: "ghost" }],
      },
    };
    const out = reconcileAppConfig(app, multiDoc());
    expect(out.forms).toHaveLength(0);
    expect(out.dashboard.widgets).toHaveLength(0);
  });

  it("preserves name/defaultMode/title metadata", () => {
    const app: BaseAppConfig = {
      name: "CRM",
      defaultMode: "app",
      forms: [],
      dashboard: { title: "Overview", widgets: [] },
    };
    const out = reconcileAppConfig(app, singleDoc());
    expect(out.name).toBe("CRM");
    expect(out.defaultMode).toBe("app");
    expect(out.dashboard.title).toBe("Overview");
  });
});

describe("isMeaningfulAppConfig", () => {
  it("is false for undefined and an empty config", () => {
    expect(isMeaningfulAppConfig(undefined)).toBe(false);
    expect(isMeaningfulAppConfig(emptyAppConfig())).toBe(false);
  });
  it("is true when any meaningful slot is populated", () => {
    expect(isMeaningfulAppConfig({ ...emptyAppConfig(), name: "X" })).toBe(
      true,
    );
    expect(
      isMeaningfulAppConfig({ ...emptyAppConfig(), defaultMode: "app" }),
    ).toBe(true);
    expect(
      isMeaningfulAppConfig({
        forms: [{ id: "f", name: "n", tableId: "t1", fieldNames: [] }],
        dashboard: { widgets: [] },
      }),
    ).toBe(true);
    expect(
      isMeaningfulAppConfig({
        forms: [],
        dashboard: { title: "T", widgets: [] },
      }),
    ).toBe(true);
  });
  it("treats a builder default with no content as not meaningful", () => {
    expect(
      isMeaningfulAppConfig({
        ...emptyAppConfig(),
        defaultMode: "builder",
      }),
    ).toBe(false);
  });
});

describe("initialAppMode", () => {
  it("opens in app mode only when defaultMode is 'app'", () => {
    const doc = singleDoc();
    expect(initialAppMode(doc)).toBe("builder");
    expect(
      initialAppMode({
        ...doc,
        app: { ...emptyAppConfig(), defaultMode: "app" },
      }),
    ).toBe("app");
    expect(
      initialAppMode({
        ...doc,
        app: { ...emptyAppConfig(), defaultMode: "builder" },
      }),
    ).toBe("builder");
  });
});

describe("formFields", () => {
  const t = table("t1", "People", peopleFields);
  it("returns all fillable fields when no subset is chosen", () => {
    const form = createForm(t);
    expect(formFields(t, form).map((f) => f.name)).toEqual([
      "Name",
      "Stage",
      "Value",
    ]);
  });
  it("returns the chosen subset in stored order, skipping unknowns", () => {
    const fields = formFields(t, {
      id: "f",
      name: "n",
      tableId: "t1",
      fieldNames: ["Value", "Ghost", "Name"],
    });
    expect(fields.map((f) => f.name)).toEqual(["Value", "Name"]);
  });
  it("never includes computed fields even if named", () => {
    const fields = formFields(t, {
      id: "f",
      name: "n",
      tableId: "t1",
      fieldNames: ["Computed", "Name"],
    });
    expect(fields.map((f) => f.name)).toEqual(["Name"]);
  });
});

describe("titleFieldName / recordTitle", () => {
  it("prefers a field literally named title/name/label/subject", () => {
    expect(
      titleFieldName([
        { name: "Value", type: "currency" },
        { name: "Name", type: "text" },
      ]),
    ).toBe("Name");
  });
  it("falls back to the first text field, then the first field", () => {
    expect(
      titleFieldName([
        { name: "Value", type: "currency" },
        { name: "Notes", type: "long_text" },
      ]),
    ).toBe("Notes");
    expect(
      titleFieldName([
        { name: "Value", type: "currency" },
        { name: "Count", type: "number" },
      ]),
    ).toBe("Value");
  });
  it("returns null for an empty schema", () => {
    expect(titleFieldName([])).toBeNull();
  });
  it("recordTitle renders the labelled value or 'Untitled'", () => {
    const fields: BaseField[] = [{ name: "Name", type: "text" }];
    expect(recordTitle(fields, { Name: "  Alice  " })).toBe("Alice");
    expect(recordTitle(fields, { Name: "" })).toBe("Untitled");
    expect(recordTitle(fields, {})).toBe("Untitled");
  });
});

describe("listFieldPreview", () => {
  const reps: BaseRecord[] = [
    { id: "rec-rep-0", Name: "A. Okafor" },
    { id: "rec-rep-1", Name: "B. Lee" },
    { id: "rec-rep-2" }, // no display value
  ];
  const repsTable = table("t2", "Reps", [{ name: "Name", type: "text" }], reps);
  const doc: BaseDocument = {
    tables: [table("t1", "Accounts", peopleFields), repsTable],
    activeTableId: "t1",
  };
  const resolver = makeTableResolver(doc);

  const ownerField: BaseField = {
    name: "Owner",
    type: "linked_record",
    linkedTableId: "t2",
    linkedDisplayField: "Name",
  };

  it("resolves a cross-table linked_record to its display labels", () => {
    const preview = listFieldPreview(
      ownerField,
      { id: "a1", Owner: ["rec-rep-0", "rec-rep-1"] },
      [],
      resolver,
    );
    expect(preview).toBe("A. Okafor, B. Lee");
  });

  it("falls back to a short id slice when the display value is missing", () => {
    const noDisplay: BaseField = {
      ...ownerField,
      linkedDisplayField: undefined,
    };
    expect(
      listFieldPreview(
        noDisplay,
        { id: "a1", Owner: ["rec-rep-0"] },
        [],
        resolver,
      ),
    ).toBe("rec-re");
    // Display field declared but the linked record lacks it.
    expect(
      listFieldPreview(
        ownerField,
        { id: "a1", Owner: ["rec-rep-2"] },
        [],
        resolver,
      ),
    ).toBe("rec-re");
  });

  it("resolves a same-table link against the passed records", () => {
    const selfLink: BaseField = {
      name: "Related",
      type: "linked_record",
      linkedDisplayField: "Name",
    };
    const sameTable: BaseRecord[] = [{ id: "x1", Name: "Self Ref" }];
    expect(
      listFieldPreview(
        selfLink,
        { id: "x2", Related: ["x1"] },
        sameTable,
        resolver,
      ),
    ).toBe("Self Ref");
  });

  it("degrades to empty for an unresolvable cross-table link", () => {
    const ghost: BaseField = { ...ownerField, linkedTableId: "ghost" };
    expect(
      listFieldPreview(ghost, { id: "a1", Owner: ["rec-rep-0"] }, [], resolver),
    ).toBe("");
  });

  it("formats booleans, arrays, blanks and clamps long strings", () => {
    expect(
      listFieldPreview(
        { name: "Active", type: "checkbox" },
        { id: "a", Active: true },
        [],
        resolver,
      ),
    ).toBe("Yes");
    expect(
      listFieldPreview(
        { name: "Active", type: "checkbox" },
        { id: "a", Active: false },
        [],
        resolver,
      ),
    ).toBe("No");
    expect(
      listFieldPreview(
        { name: "Tags", type: "multi_select" },
        { id: "a", Tags: ["x", "y"] },
        [],
        resolver,
      ),
    ).toBe("x, y");
    expect(
      listFieldPreview(
        { name: "Value", type: "currency" },
        { id: "a" },
        [],
        resolver,
      ),
    ).toBe("");
    const long = "x".repeat(60);
    const clamped = listFieldPreview(
      { name: "Notes", type: "text" },
      { id: "a", Notes: long },
      [],
      resolver,
    );
    expect(clamped).toHaveLength(40);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("previews computed (unstored) fields as empty", () => {
    // Formula values aren't stored on the record, so the list shows them
    // empty (the detail page computes them in full).
    expect(
      listFieldPreview(
        { name: "Computed", type: "formula", formula: "1" },
        { id: "a" },
        [],
        resolver,
      ),
    ).toBe("");
  });
});

describe("derivePages", () => {
  it("always yields a dashboard + one data page per table, then forms", () => {
    const doc = multiDoc();
    const app: BaseAppConfig = {
      forms: [
        { id: "f1", name: "Intake", tableId: "t1", fieldNames: [] },
        { id: "f2", name: "  ", tableId: "t2", fieldNames: [] },
      ],
      dashboard: { title: "Overview", widgets: [] },
    };
    const pages = derivePages(doc, app);
    expect(pages.map((p) => p.kind)).toEqual([
      "dashboard",
      "data",
      "data",
      "form",
      "form",
    ]);
    expect(pages[0].id).toBe(DASHBOARD_PAGE_ID);
    expect(pages[0].label).toBe("Overview");
    expect(pages[1].id).toBe(dataPageId("t1"));
    expect(pages[3].id).toBe(formPageId("f1"));
    // Blank form name falls back to a placeholder label.
    expect(pages[4].label).toBe("Untitled form");
  });
});

describe("createForm / createWidget", () => {
  const t = table("t1", "Deals", peopleFields);
  it("createForm targets the table and shows all fields by default", () => {
    const form = createForm(t);
    expect(form.tableId).toBe("t1");
    expect(form.fieldNames).toEqual([]);
    expect(form.name).toBe("Deals form");
    expect(createForm(t, "  Custom  ").name).toBe("Custom");
  });
  it("createWidget picks sensible group/value defaults", () => {
    expect(createWidget("count", t)).toMatchObject({
      kind: "count",
      tableId: "t1",
    });
    // First groupable field (text counts as groupable) is "Name".
    const group = createWidget("group", t);
    expect(group.groupByField).toBe("Name");
    const rollup = createWidget("rollup", t);
    expect(rollup.aggregation).toBe("SUM");
    expect(rollup.valueField).toBe("Value");
    const chart = createWidget("chart", t);
    expect(chart.aggregation).toBe("COUNT");
    expect(chart.groupByField).toBe("Name");
    expect(chart.valueField).toBe("Value");
  });
});

describe("renameFieldInAppConfig", () => {
  const doc = singleDoc();
  const app: BaseAppConfig = {
    forms: [
      {
        id: "f1",
        name: "Intake",
        tableId: "t1",
        fieldNames: ["Name", "Value"],
      },
    ],
    dashboard: {
      widgets: [
        {
          id: "w1",
          kind: "chart",
          tableId: "t1",
          groupByField: "Stage",
          valueField: "Value",
        },
      ],
    },
  };

  it("returns the same reference when nothing matches", () => {
    expect(renameFieldInAppConfig(app, doc, "t1", "Missing", "X")).toBe(app);
    expect(renameFieldInAppConfig(app, doc, "t1", "Name", "Name")).toBe(app);
  });

  it("remaps form field subsets and widget group/value refs", () => {
    const out = renameFieldInAppConfig(app, doc, "t1", "Value", "Amount");
    expect(out).not.toBe(app);
    expect(out.forms[0].fieldNames).toEqual(["Name", "Amount"]);
    expect(out.dashboard.widgets[0].valueField).toBe("Amount");
    // Unrelated ref untouched.
    expect(out.dashboard.widgets[0].groupByField).toBe("Stage");
  });

  it("ignores fields on a different table", () => {
    const md = multiDoc();
    const a: BaseAppConfig = {
      forms: [{ id: "f", name: "n", tableId: "t2", fieldNames: ["Title"] }],
      dashboard: { widgets: [] },
    };
    // Renaming People.Value must not touch the Tasks form.
    expect(renameFieldInAppConfig(a, md, "t1", "Value", "Amount")).toBe(a);
  });
});
