import { describe, it, expect } from "vitest";
import {
  parseBaseDocument,
  serializeBaseDocument,
  singleTableDocument,
  getActiveTable,
  updateActiveTable,
  addTable,
  renameTable,
  removeTable,
  setActiveTable,
  uniqueTableName,
  makeTableResolver,
  linkTargetRecords,
  linkTargetFields,
} from "../baseDocumentHelpers";
import type {
  BaseContent,
  BaseDocument,
  BaseField,
} from "../baseEditorTypes";

const legacy: BaseContent = {
  fields: [
    { name: "Name", type: "text" },
    { name: "Done", type: "checkbox" },
  ],
  records: [
    { id: "r1", Name: "A", Done: true },
    { id: "r2", Name: "B", Done: false },
  ],
};

describe("parseBaseDocument — legacy single-table shape", () => {
  it("wraps a legacy { fields, records } body into one table", () => {
    const doc = parseBaseDocument(JSON.stringify(legacy));
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].fields.map((f) => f.name)).toEqual(["Name", "Done"]);
    expect(doc.tables[0].records).toHaveLength(2);
    expect(doc.activeTableId).toBe(doc.tables[0].id);
  });

  it("seeds defaults for an empty body (delegates to parseBaseContent)", () => {
    const doc = parseBaseDocument("");
    expect(doc.tables).toHaveLength(1);
    expect(doc.tables[0].fields.length).toBeGreaterThan(0);
  });

  it("falls back to single-table for non-JSON input", () => {
    const doc = parseBaseDocument("}{ not json");
    expect(doc.tables).toHaveLength(1);
  });
});

describe("parseBaseDocument — multi-table shape", () => {
  it("parses { tables, activeTableId } and keeps the active pointer", () => {
    const docIn: BaseDocument = {
      tables: [
        { id: "t1", name: "People", fields: [{ name: "Name", type: "text" }], records: [] },
        { id: "t2", name: "Tasks", fields: [{ name: "Title", type: "text" }], records: [] },
      ],
      activeTableId: "t2",
    };
    const doc = parseBaseDocument(JSON.stringify(docIn));
    expect(doc.tables.map((t) => t.name)).toEqual(["People", "Tasks"]);
    expect(doc.activeTableId).toBe("t2");
  });

  it("repairs a stale activeTableId to the first table", () => {
    const docIn = {
      tables: [
        { id: "t1", name: "People", fields: [{ name: "Name", type: "text" }], records: [] },
      ],
      activeTableId: "does-not-exist",
    };
    const doc = parseBaseDocument(JSON.stringify(docIn));
    expect(doc.activeTableId).toBe("t1");
  });

  it("trims a padded persisted table name (matching renameTable)", () => {
    const docIn = {
      tables: [
        { id: "t1", name: "  Tasks  ", fields: [{ name: "Title", type: "text" }], records: [] },
      ],
      activeTableId: "t1",
    };
    const doc = parseBaseDocument(JSON.stringify(docIn));
    expect(doc.tables[0].name).toBe("Tasks");
  });

  it("falls back to the positional name when the persisted name is blank", () => {
    const docIn = {
      tables: [
        { id: "t1", name: "   ", fields: [{ name: "Title", type: "text" }], records: [] },
      ],
      activeTableId: "t1",
    };
    const doc = parseBaseDocument(JSON.stringify(docIn));
    expect(doc.tables[0].name).toBe("Table 1");
  });
});

describe("serializeBaseDocument — backward compatibility", () => {
  it("emits the legacy shape for a single-table document", () => {
    const doc = singleTableDocument(legacy);
    const json = serializeBaseDocument(doc);
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual(["fields", "records"]);
    expect(parsed.tables).toBeUndefined();
  });

  it("round-trips a single-table base byte-for-byte through the legacy parser", () => {
    const doc = parseBaseDocument(JSON.stringify(legacy));
    const json = serializeBaseDocument(doc);
    expect(JSON.parse(json)).toEqual(legacy);
  });

  it("emits the multi-table shape once a second table exists", () => {
    const doc = addTable(singleTableDocument(legacy), "Tasks");
    const parsed = JSON.parse(serializeBaseDocument(doc));
    expect(Array.isArray(parsed.tables)).toBe(true);
    expect(parsed.tables).toHaveLength(2);
    expect(parsed.activeTableId).toBeTruthy();
  });
});

describe("getActiveTable / updateActiveTable", () => {
  it("returns the table matching activeTableId", () => {
    const doc = addTable(singleTableDocument(legacy, "People"), "Tasks");
    expect(getActiveTable(doc).name).toBe("Tasks");
  });

  it("updateActiveTable replaces only the active table's content", () => {
    const doc = addTable(singleTableDocument(legacy, "People"), "Tasks");
    const next = updateActiveTable(doc, {
      fields: [{ name: "Title", type: "text" }],
      records: [{ id: "x", Title: "hi" }],
    });
    // active (Tasks) changed
    expect(getActiveTable(next).records).toHaveLength(1);
    // other table (People) untouched
    const people = next.tables.find((t) => t.name === "People");
    expect(people?.records).toHaveLength(2);
  });
});

describe("addTable / uniqueTableName", () => {
  it("adds an empty table and makes it active", () => {
    const doc = addTable(singleTableDocument(legacy));
    expect(doc.tables).toHaveLength(2);
    expect(getActiveTable(doc).records).toHaveLength(0);
    expect(getActiveTable(doc).fields).toEqual([{ name: "Name", type: "text" }]);
  });

  it("generates a non-colliding default name", () => {
    let doc = singleTableDocument(legacy, "Table 2");
    const name = uniqueTableName(doc);
    expect(name).not.toBe("Table 2");
    doc = addTable(doc);
    const names = doc.tables.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("prefers the smallest available index rather than skipping ahead", () => {
    // A doc whose only table is "Table 2" should still offer the free
    // "Table 1" instead of jumping to "Table 3".
    const doc = singleTableDocument(legacy, "Table 2");
    expect(uniqueTableName(doc)).toBe("Table 1");
  });

  it("fills the first gap when lower indices are taken", () => {
    const doc = addTable(singleTableDocument(legacy, "Table 1"), "Table 3");
    expect(uniqueTableName(doc)).toBe("Table 2");
  });
});

describe("renameTable", () => {
  it("renames a table by id", () => {
    const doc = singleTableDocument(legacy, "Old");
    const id = doc.tables[0].id;
    const next = renameTable(doc, id, "New");
    expect(next.tables[0].name).toBe("New");
  });

  it("no-ops on empty, unchanged, or colliding names", () => {
    const doc = addTable(singleTableDocument(legacy, "People"), "Tasks");
    const peopleId = doc.tables[0].id;
    expect(renameTable(doc, peopleId, "  ")).toBe(doc);
    expect(renameTable(doc, peopleId, "People")).toBe(doc);
    expect(renameTable(doc, peopleId, "Tasks")).toBe(doc);
  });
});

describe("setActiveTable", () => {
  it("switches the active table", () => {
    const doc = addTable(singleTableDocument(legacy, "People"), "Tasks");
    const peopleId = doc.tables[0].id;
    const next = setActiveTable(doc, peopleId);
    expect(next.activeTableId).toBe(peopleId);
  });

  it("no-ops for an unknown id or the already-active id", () => {
    const doc = singleTableDocument(legacy);
    expect(setActiveTable(doc, "nope")).toBe(doc);
    expect(setActiveTable(doc, doc.activeTableId)).toBe(doc);
  });
});

describe("removeTable — table-aware link cleanup", () => {
  it("refuses to delete the last remaining table", () => {
    const doc = singleTableDocument(legacy);
    expect(removeTable(doc, doc.tables[0].id)).toBe(doc);
  });

  it("scrubs cross-table links pointing at the deleted table", () => {
    // People table links to Tasks.
    const peopleLink: BaseField = {
      name: "Tasks",
      type: "linked_record",
      linkedTableId: "t2",
      // Display the target table's "Title" column on each chip.
      linkedDisplayField: "Title",
    };
    const doc: BaseDocument = {
      tables: [
        {
          id: "t1",
          name: "People",
          fields: [{ name: "Name", type: "text" }, peopleLink],
          records: [{ id: "p1", Name: "Alice", Tasks: ["k1", "k2"] }],
        },
        {
          id: "t2",
          name: "Tasks",
          fields: [{ name: "Title", type: "text" }],
          records: [{ id: "k1", Title: "Do" }],
        },
      ],
      activeTableId: "t1",
    };
    const next = removeTable(doc, "t2");
    expect(next.tables).toHaveLength(1);
    const people = next.tables[0];
    const link = people.fields.find((f) => f.name === "Tasks");
    // linkedTableId pointer cleared, link arrays emptied
    expect(link?.linkedTableId).toBeUndefined();
    expect(people.records[0].Tasks).toEqual([]);
    // The display-field pointer named a column in the now-deleted target
    // table, so it must be cleared too — otherwise the degraded
    // same-table link would carry a stale pointer that renders the wrong
    // column (or a nonexistent one) the moment records are re-linked.
    expect(link?.linkedDisplayField).toBeUndefined();
  });

  it("resets rollup/lookup targets that followed a scrubbed cross-table link", () => {
    // People links to Tasks, and has a rollup (sum of Tasks.Hours) plus
    // a lookup (Tasks.Title) that BOTH traverse the link. Deleting Tasks
    // must strip the dangling `targetField` so neither field aggregates
    // a phantom column once the link degrades to same-table.
    const peopleLink: BaseField = {
      name: "Tasks",
      type: "linked_record",
      linkedTableId: "t2",
    };
    const rollup: BaseField = {
      name: "Total Hours",
      type: "rollup",
      linkedField: "Tasks",
      targetField: "Hours",
      aggregation: "SUM",
    };
    const lookup: BaseField = {
      name: "Task Titles",
      type: "lookup",
      linkedField: "Tasks",
      targetField: "Title",
    };
    const doc: BaseDocument = {
      tables: [
        {
          id: "t1",
          name: "People",
          fields: [{ name: "Name", type: "text" }, peopleLink, rollup, lookup],
          records: [{ id: "p1", Name: "Alice", Tasks: ["k1"] }],
        },
        {
          id: "t2",
          name: "Tasks",
          fields: [
            { name: "Title", type: "text" },
            { name: "Hours", type: "number" },
          ],
          records: [{ id: "k1", Title: "Do", Hours: 3 }],
        },
      ],
      activeTableId: "t1",
    };
    const next = removeTable(doc, "t2");
    const people = next.tables[0];
    const link = people.fields.find((f) => f.name === "Tasks");
    expect(link?.linkedTableId).toBeUndefined();
    // Both dependent computed fields lose their dangling target but keep
    // the (still-valid) linkedField reference.
    const r = people.fields.find((f) => f.name === "Total Hours");
    const l = people.fields.find((f) => f.name === "Task Titles");
    expect(r?.targetField).toBeUndefined();
    expect(r?.linkedField).toBe("Tasks");
    expect(r?.aggregation).toBe("SUM");
    expect(l?.targetField).toBeUndefined();
    expect(l?.linkedField).toBe("Tasks");
  });

  it("leaves rollup/lookup that follow an unaffected link untouched", () => {
    // Two link fields: one to the deleted table, one to a surviving
    // table. Only the rollup following the deleted link is reset.
    const doc: BaseDocument = {
      tables: [
        {
          id: "t1",
          name: "People",
          fields: [
            { name: "Name", type: "text" },
            { name: "Tasks", type: "linked_record", linkedTableId: "t2" },
            { name: "Orgs", type: "linked_record", linkedTableId: "t3" },
            {
              name: "Org Names",
              type: "lookup",
              linkedField: "Orgs",
              targetField: "OrgName",
            },
          ],
          records: [{ id: "p1", Name: "A", Tasks: ["k1"], Orgs: ["o1"] }],
        },
        {
          id: "t2",
          name: "Tasks",
          fields: [{ name: "Title", type: "text" }],
          records: [{ id: "k1", Title: "Do" }],
        },
        {
          id: "t3",
          name: "Orgs",
          fields: [{ name: "OrgName", type: "text" }],
          records: [{ id: "o1", OrgName: "Acme" }],
        },
      ],
      activeTableId: "t1",
    };
    const next = removeTable(doc, "t2");
    const people = next.tables.find((t) => t.id === "t1")!;
    const orgLookup = people.fields.find((f) => f.name === "Org Names");
    // The Orgs link survived, so its lookup keeps its target.
    expect(orgLookup?.targetField).toBe("OrgName");
  });

  it("moves the active pointer when the active table is removed", () => {
    const doc = addTable(singleTableDocument(legacy, "People"), "Tasks");
    // active is Tasks (t added last); remove it
    const tasksId = doc.activeTableId;
    const next = removeTable(doc, tasksId);
    expect(next.tables.some((t) => t.id === tasksId)).toBe(false);
    expect(next.tables.some((t) => t.id === next.activeTableId)).toBe(true);
  });

  it("falls back to a surviving table when the active FIRST table (idx===0) is removed", () => {
    // Build a two-table doc and make the first table active, exercising
    // the `doc.tables[idx - 1] ?? remaining[0]` branch where idx===0 and
    // `doc.tables[-1]` is undefined.
    const base = addTable(singleTableDocument(legacy, "People"), "Tasks");
    const firstId = base.tables[0].id;
    const doc = setActiveTable(base, firstId);
    expect(doc.activeTableId).toBe(firstId);
    const next = removeTable(doc, firstId);
    expect(next.tables.some((t) => t.id === firstId)).toBe(false);
    // The surviving table is chosen (never the removed one), and it is
    // always a real, present table.
    expect(next.activeTableId).toBe(next.tables[0].id);
    expect(next.tables.some((t) => t.id === next.activeTableId)).toBe(true);
  });
});

describe("linkTargetRecords / linkTargetFields", () => {
  const doc: BaseDocument = {
    tables: [
      {
        id: "t1",
        name: "People",
        fields: [{ name: "Name", type: "text" }],
        records: [{ id: "p1", Name: "Alice" }],
      },
      {
        id: "t2",
        name: "Tasks",
        fields: [{ name: "Title", type: "text" }],
        records: [{ id: "k1", Title: "Do" }, { id: "k2", Title: "Done" }],
      },
    ],
    activeTableId: "t1",
  };
  const resolver = makeTableResolver(doc);

  it("returns same-table records when no linkedTableId", () => {
    const field: BaseField = { name: "Self", type: "linked_record" };
    const same = doc.tables[0].records;
    expect(linkTargetRecords(field, same, resolver)).toBe(same);
  });

  it("resolves cross-table records via the resolver", () => {
    const field: BaseField = { name: "Tasks", type: "linked_record", linkedTableId: "t2" };
    const out = linkTargetRecords(field, doc.tables[0].records, resolver);
    expect(out.map((r) => r.id)).toEqual(["k1", "k2"]);
  });

  it("returns [] for a cross-table link with no resolver", () => {
    const field: BaseField = { name: "Tasks", type: "linked_record", linkedTableId: "t2" };
    expect(linkTargetRecords(field, doc.tables[0].records)).toEqual([]);
  });

  it("returns [] for a cross-table link to a deleted table", () => {
    const field: BaseField = { name: "Gone", type: "linked_record", linkedTableId: "missing" };
    expect(linkTargetRecords(field, doc.tables[0].records, resolver)).toEqual([]);
  });

  it("linkTargetFields resolves the target table's fields", () => {
    const field: BaseField = { name: "Tasks", type: "linked_record", linkedTableId: "t2" };
    const out = linkTargetFields(field, doc.tables[0].fields, resolver);
    expect(out.map((f) => f.name)).toEqual(["Title"]);
  });
});
