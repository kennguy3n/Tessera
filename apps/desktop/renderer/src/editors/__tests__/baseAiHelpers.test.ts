import { describe, it, expect } from "vitest";
import {
  AI_SCHEMA_FIELD_TYPES,
  normalizeAiFieldType,
  extractJson,
  buildSchemaPrompt,
  parseSchemaResponse,
  buildFormulaPrompt,
  parseFormulaResponse,
  recordContext,
  buildFillPrompt,
  parseFillResponse,
  buildSummarizePrompt,
  parseTextResponse,
} from "../baseAiHelpers";
import type { BaseField } from "../baseEditorTypes";

describe("normalizeAiFieldType", () => {
  it("maps common aliases to canonical types", () => {
    expect(normalizeAiFieldType("string")).toBe("text");
    expect(normalizeAiFieldType("Integer")).toBe("number");
    expect(normalizeAiFieldType("money")).toBe("currency");
    expect(normalizeAiFieldType("single select")).toBe("select");
    expect(normalizeAiFieldType("multi-select")).toBe("multi_select");
    expect(normalizeAiFieldType("tags")).toBe("multi_select");
    expect(normalizeAiFieldType("assignee")).toBe("user");
  });

  it("returns null for unknown / non-string / disallowed types", () => {
    expect(normalizeAiFieldType("formula")).toBeNull();
    expect(normalizeAiFieldType("linked_record")).toBeNull();
    expect(normalizeAiFieldType("wat")).toBeNull();
    expect(normalizeAiFieldType(42)).toBeNull();
    expect(normalizeAiFieldType(null)).toBeNull();
  });

  it("never maps to a type outside the whitelist", () => {
    for (const alias of ["string", "money", "tags", "rating", "duration"]) {
      const t = normalizeAiFieldType(alias);
      expect(t).not.toBeNull();
      expect(AI_SCHEMA_FIELD_TYPES.has(t!)).toBe(true);
    }
  });
});

describe("extractJson", () => {
  it("extracts a bare JSON object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("ignores prose around the JSON", () => {
    expect(extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.')).toEqual({
      a: 1,
    });
  });

  it("strips ```json fences", () => {
    expect(extractJson('```json\n{"a":[1,2]}\n```')).toEqual({ a: [1, 2] });
  });

  it("balances nested braces and ignores braces inside strings", () => {
    const out = extractJson('{"name":"a}b","nested":{"x":1}}');
    expect(out).toEqual({ name: "a}b", nested: { x: 1 } });
  });

  it("extracts a top-level array", () => {
    expect(extractJson("[1, 2, 3] trailing")).toEqual([1, 2, 3]);
  });

  it("returns null when there is no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson("{ unbalanced")).toBeNull();
  });
});

describe("buildSchemaPrompt", () => {
  it("includes the description and the allowed types", () => {
    const p = buildSchemaPrompt("a CRM of customers");
    expect(p).toContain("a CRM of customers");
    expect(p).toContain("text");
    expect(p).toContain("multi_select");
  });
});

describe("parseSchemaResponse", () => {
  it("parses a well-formed schema", () => {
    const res = parseSchemaResponse(
      JSON.stringify({
        tableName: "Customers",
        fields: [
          { name: "Name", type: "text" },
          { name: "Stage", type: "single select", options: ["Lead", "Won"] },
          { name: "Value", type: "money" },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.tableName).toBe("Customers");
    expect(res.value.fields).toHaveLength(3);
    expect(res.value.fields[1]).toMatchObject({
      name: "Stage",
      type: "select",
      options: ["Lead", "Won"],
    });
    expect(res.value.fields[2].type).toBe("currency");
  });

  it("falls back unknown types to text", () => {
    const res = parseSchemaResponse(
      JSON.stringify({ fields: [{ name: "X", type: "quantum" }] }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fields[0].type).toBe("text");
  });

  it("dedupes field names case-insensitively and strips reserved names", () => {
    const res = parseSchemaResponse(
      JSON.stringify({
        fields: [
          { name: "Title", type: "text" },
          { name: "title", type: "text" },
          { name: "id", type: "text" },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const names = res.value.fields.map((f) => f.name);
    expect(names).toEqual(["Title"]);
  });

  it("dedupes select options preserving order", () => {
    const res = parseSchemaResponse(
      JSON.stringify({
        fields: [
          { name: "S", type: "select", options: ["a", "b", "a", "", "c"] },
        ],
      }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fields[0].options).toEqual(["a", "b", "c"]);
  });

  it("defaults a missing table name to 'Table'", () => {
    const res = parseSchemaResponse(
      JSON.stringify({ fields: [{ name: "X", type: "text" }] }),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.tableName).toBe("Table");
  });

  it("fails when there is no JSON or no usable fields", () => {
    expect(parseSchemaResponse("nope").ok).toBe(false);
    expect(parseSchemaResponse(JSON.stringify({ fields: [] })).ok).toBe(false);
    expect(
      parseSchemaResponse(JSON.stringify({ fields: [{ type: "text" }] })).ok,
    ).toBe(false);
  });
});

describe("buildFormulaPrompt", () => {
  it("lists available non-formula fields with braces", () => {
    const fields: BaseField[] = [
      { name: "Price", type: "number" },
      { name: "Qty", type: "number" },
      { name: "Total", type: "formula" },
    ];
    const p = buildFormulaPrompt("multiply price by quantity", fields);
    expect(p).toContain("{Price}");
    expect(p).toContain("{Qty}");
    expect(p).not.toContain("{Total}");
    expect(p).toContain("multiply price by quantity");
  });
});

describe("parseFormulaResponse", () => {
  it("extracts a single-line formula", () => {
    const res = parseFormulaResponse("{Price} * {Qty}");
    expect(res).toEqual({ ok: true, value: "{Price} * {Qty}" });
  });

  it("strips a leading '=' and code fences", () => {
    expect(parseFormulaResponse("```\n= {A} + {B}\n```")).toEqual({
      ok: true,
      value: "{A} + {B}",
    });
  });

  it("takes the first non-empty line", () => {
    const res = parseFormulaResponse("\n\n{A}\nsome explanation");
    expect(res).toEqual({ ok: true, value: "{A}" });
  });

  it("fails on empty content", () => {
    expect(parseFormulaResponse("   ").ok).toBe(false);
  });
});

describe("recordContext", () => {
  it("includes only populated source fields", () => {
    const fields: BaseField[] = [
      { name: "A", type: "text" },
      { name: "B", type: "text" },
      { name: "Tags", type: "multi_select" },
    ];
    const ctx = recordContext(
      { id: "r1", A: "hello", B: "", Tags: ["x", "y"] },
      fields,
    );
    expect(ctx).toContain("A: hello");
    expect(ctx).not.toContain("B:");
    expect(ctx).toContain("Tags: x, y");
  });
});

describe("buildFillPrompt", () => {
  it("adds a numeric hint for number targets", () => {
    const p = buildFillPrompt(
      "",
      { name: "Score", type: "number" },
      [{ name: "Notes", type: "text" }],
      { id: "r1", Notes: "great" },
    );
    expect(p).toContain("ONLY a number");
    expect(p).toContain("Notes: great");
  });

  it("lists options for a select target", () => {
    const p = buildFillPrompt(
      "pick a stage",
      { name: "Stage", type: "select", options: ["Lead", "Won"] },
      [{ name: "Notes", type: "text" }],
      { id: "r1", Notes: "signed" },
    );
    expect(p).toContain("Lead, Won");
  });

  it("asks for a comma-separated list for multi_select targets", () => {
    const p = buildFillPrompt(
      "tag it",
      { name: "Tags", type: "multi_select", options: ["A", "B", "C"] },
      [{ name: "Notes", type: "text" }],
      { id: "r1", Notes: "x" },
    );
    expect(p).toContain("A, B, C");
    expect(p).toContain("separated by commas");
  });

  it("asks for h:mm or minutes for duration targets", () => {
    const p = buildFillPrompt(
      "",
      { name: "Effort", type: "duration" },
      [{ name: "Notes", type: "text" }],
      { id: "r1", Notes: "x" },
    );
    expect(p).toContain("h:mm");
  });
});

describe("parseFillResponse", () => {
  it("extracts a number for numeric fields", () => {
    expect(
      parseFillResponse("The score is 42.5 out of 100", {
        name: "S",
        type: "number",
      }),
    ).toEqual({ ok: true, value: 42.5 });
  });

  it("rejects non-numeric for numeric fields", () => {
    expect(
      parseFillResponse("no number here", { name: "S", type: "number" }).ok,
    ).toBe(false);
  });

  it("maps truthy/falsy words for checkbox", () => {
    expect(
      parseFillResponse("yes", { name: "Done", type: "checkbox" }),
    ).toEqual({ ok: true, value: true });
    expect(parseFillResponse("No", { name: "Done", type: "checkbox" })).toEqual({
      ok: true,
      value: false,
    });
    expect(
      parseFillResponse("maybe", { name: "Done", type: "checkbox" }).ok,
    ).toBe(false);
  });

  it("snaps select to an existing option (case-insensitive) or rejects", () => {
    const field: BaseField = {
      name: "Stage",
      type: "select",
      options: ["Lead", "Won"],
    };
    expect(parseFillResponse("won", field)).toEqual({ ok: true, value: "Won" });
    expect(parseFillResponse("Closed", field).ok).toBe(false);
  });

  it("parses multi_select into a deduped string[] snapped to options", () => {
    const field: BaseField = {
      name: "Tags",
      type: "multi_select",
      options: ["Urgent", "Bug", "Feature"],
    };
    expect(parseFillResponse("bug, urgent; bug", field)).toEqual({
      ok: true,
      value: ["Bug", "Urgent"],
    });
  });

  it("rejects multi_select tokens that are not options", () => {
    const field: BaseField = {
      name: "Tags",
      type: "multi_select",
      options: ["Urgent", "Bug"],
    };
    const r = parseFillResponse("Bug, Nope", field);
    expect(r.ok).toBe(false);
  });

  it("keeps free-entry multi_select values when the field is unconstrained", () => {
    expect(
      parseFillResponse("alpha, beta , alpha", {
        name: "Tags",
        type: "multi_select",
      }),
    ).toEqual({ ok: true, value: ["alpha", "beta"] });
  });

  it("parses duration h:mm into minutes before falling back to a number", () => {
    expect(
      parseFillResponse("1:30", { name: "Effort", type: "duration" }),
    ).toEqual({ ok: true, value: 90 });
    expect(
      parseFillResponse("45", { name: "Effort", type: "duration" }),
    ).toEqual({ ok: true, value: 45 });
  });

  it("returns trimmed text for text fields", () => {
    expect(
      parseFillResponse("  hello world  \nextra", { name: "T", type: "text" }),
    ).toEqual({ ok: true, value: "hello world" });
  });
});

describe("buildSummarizePrompt / parseTextResponse", () => {
  it("includes record rows and caps at 50", () => {
    const fields: BaseField[] = [{ name: "Name", type: "text" }];
    const records = Array.from({ length: 60 }, (_, i) => ({
      id: `r${i}`,
      Name: `Item ${i}`,
    }));
    const p = buildSummarizePrompt(records, fields);
    expect(p).toContain("Item 0");
    expect(p).toContain("50.");
    expect(p).not.toContain("Item 55");
  });

  it("parseTextResponse strips fences and trims", () => {
    expect(parseTextResponse("```\nA summary.\n```")).toEqual({
      ok: true,
      value: "A summary.",
    });
    expect(parseTextResponse("   ").ok).toBe(false);
  });
});
