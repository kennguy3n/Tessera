import { describe, it, expect } from "vitest";
import { computeWidget } from "../baseviews/appmode/dashboardData";
import type {
  BaseAppWidget,
  BaseDocument,
  BaseField,
} from "../baseEditorTypes";

const fields: BaseField[] = [
  { name: "Name", type: "text" },
  { name: "Stage", type: "select", options: ["Lead", "Won", "Lost"] },
  { name: "Value", type: "currency" },
];

const doc: BaseDocument = {
  tables: [
    {
      id: "t1",
      name: "Deals",
      fields,
      records: [
        { id: "r1", Name: "A", Stage: "Lead", Value: 100 },
        { id: "r2", Name: "B", Stage: "Won", Value: 200 },
        { id: "r3", Name: "C", Stage: "Won", Value: 50 },
        { id: "r4", Name: "D", Stage: "Lead", Value: 0 },
      ],
    },
  ],
  activeTableId: "t1",
};

const widget = (patch: Partial<BaseAppWidget>): BaseAppWidget => ({
  id: "w",
  kind: "count",
  tableId: "t1",
  ...patch,
});

describe("computeWidget — invalid table", () => {
  it("returns an invalid view when the table is gone", () => {
    const view = computeWidget(widget({ tableId: "ghost" }), doc);
    expect(view.kind).toBe("invalid");
    if (view.kind === "invalid") {
      expect(view.reason).toMatch(/no longer exists/i);
    }
  });
});

describe("computeWidget — count", () => {
  it("counts the table's records", () => {
    const view = computeWidget(widget({ kind: "count" }), doc);
    expect(view.kind).toBe("count");
    if (view.kind === "count") {
      expect(view.count).toBe(4);
      expect(view.title).toBe("Deals count");
    }
  });
});

describe("computeWidget — rollup", () => {
  it("sums a numeric field", () => {
    const view = computeWidget(
      widget({ kind: "rollup", valueField: "Value", aggregation: "SUM" }),
      doc,
    );
    expect(view.kind).toBe("rollup");
    if (view.kind === "rollup") {
      expect(view.display).toBe("350");
      expect(view.caption).toBe("Sum of Value");
    }
  });

  it("counts records when aggregation is COUNT without a value field", () => {
    const view = computeWidget(
      widget({ kind: "rollup", aggregation: "COUNT" }),
      doc,
    );
    expect(view.kind).toBe("rollup");
    if (view.kind === "rollup") {
      expect(view.display).toBe("4");
      expect(view.caption).toBe("Count of records");
    }
  });

  it("is invalid when a non-COUNT rollup has no value field", () => {
    const view = computeWidget(
      widget({ kind: "rollup", aggregation: "SUM" }),
      doc,
    );
    expect(view.kind).toBe("invalid");
  });
});

describe("computeWidget — group", () => {
  it("groups record counts by a field", () => {
    const view = computeWidget(
      widget({ kind: "group", groupByField: "Stage" }),
      doc,
    );
    expect(view.kind).toBe("group");
    if (view.kind === "group") {
      const byLabel = Object.fromEntries(
        view.rows.map((r) => [r.label, r.value]),
      );
      expect(byLabel["Lead"]).toBe(2);
      expect(byLabel["Won"]).toBe(2);
      expect(view.total).toBe(4);
    }
  });

  it("aggregates a value field per group when requested", () => {
    const view = computeWidget(
      widget({
        kind: "group",
        groupByField: "Stage",
        valueField: "Value",
        aggregation: "SUM",
      }),
      doc,
    );
    if (view.kind === "group") {
      const byLabel = Object.fromEntries(
        view.rows.map((r) => [r.label, r.value]),
      );
      expect(byLabel["Lead"]).toBe(100);
      expect(byLabel["Won"]).toBe(250);
    }
  });

  it("is invalid without a group-by field", () => {
    expect(computeWidget(widget({ kind: "group" }), doc).kind).toBe("invalid");
  });
});

describe("computeWidget — chart", () => {
  it("returns rows sorted by value descending", () => {
    const view = computeWidget(
      widget({
        kind: "chart",
        groupByField: "Stage",
        valueField: "Value",
        aggregation: "SUM",
      }),
      doc,
    );
    expect(view.kind).toBe("chart");
    if (view.kind === "chart") {
      expect(view.rows[0].label).toBe("Won");
      expect(view.rows[0].value).toBe(250);
      expect(view.seriesName).toBe("Sum of Value");
    }
  });

  it("defaults to a Count series when aggregation is COUNT", () => {
    const view = computeWidget(
      widget({ kind: "chart", groupByField: "Stage", aggregation: "COUNT" }),
      doc,
    );
    if (view.kind === "chart") {
      expect(view.seriesName).toBe("Count");
    }
  });

  it("is invalid without a group-by field", () => {
    expect(computeWidget(widget({ kind: "chart" }), doc).kind).toBe("invalid");
  });
});
