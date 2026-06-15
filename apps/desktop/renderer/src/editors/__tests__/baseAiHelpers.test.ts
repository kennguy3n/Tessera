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
  parseSchemaMarkdown,
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
    expect(
      extractJson('Sure! Here you go:\n{"a":1}\nHope that helps.'),
    ).toEqual({
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

  it("skips a non-JSON balanced candidate and parses a later one", () => {
    // The model emitted prose with braces ("{ like this }") before the
    // real payload. The first balanced slice fails JSON.parse, so the
    // scanner must resume and find the actual object.
    const out = extractJson(
      'Here is the schema { like this } now the JSON: {"tableName":"Tasks"}',
    );
    expect(out).toEqual({ tableName: "Tasks" });
  });

  it("skips a malformed leading object and parses a trailing array", () => {
    const out = extractJson("{nope not json} then [1,2,3]");
    expect(out).toEqual([1, 2, 3]);
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

  it("asks for yes/no for checkbox targets so the response is parseable", () => {
    const p = buildFillPrompt(
      "is it done",
      { name: "Done", type: "checkbox" },
      [{ name: "Status", type: "text" }],
      { id: "r1", Status: "shipped" },
    );
    expect(p).toContain("yes or no");
    // The hint must elicit a value parseFillResponse actually accepts.
    expect(
      parseFillResponse("yes", { name: "Done", type: "checkbox" }),
    ).toEqual({
      ok: true,
      value: true,
    });
    expect(parseFillResponse("no", { name: "Done", type: "checkbox" })).toEqual(
      {
        ok: true,
        value: false,
      },
    );
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
    expect(parseFillResponse("No", { name: "Done", type: "checkbox" })).toEqual(
      {
        ok: true,
        value: false,
      },
    );
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

describe("parseSchemaMarkdown", () => {
  it("parses multiple tables with their fields and types", () => {
    const md = [
      "## Companies",
      "- name: text",
      "- revenue: currency",
      "",
      "## Deals",
      "- title: text",
      "- amount: currency",
      "- stage: single select",
    ].join("\n");
    const res = parseSchemaMarkdown(md);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(2);
    const [companies, deals] = res.value;
    expect(companies.tableName).toBe("Companies");
    expect(companies.fields).toEqual([
      { name: "name", type: "text" },
      { name: "revenue", type: "currency" },
    ]);
    expect(deals.tableName).toBe("Deals");
    expect(deals.fields).toEqual([
      { name: "title", type: "text" },
      { name: "amount", type: "currency" },
      { name: "stage", type: "select", options: [] },
    ]);
  });

  it("materialises link relationships (→, ->, bare) as plain text", () => {
    const md = [
      "## Contacts",
      "- name: text",
      "- company: link → Companies",
      "- account: link -> Companies",
      "- manager: link",
    ].join("\n");
    const res = parseSchemaMarkdown(md);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0].fields).toEqual([
      { name: "name", type: "text" },
      { name: "company", type: "text" },
      { name: "account", type: "text" },
      { name: "manager", type: "text" },
    ]);
  });

  it("gives select / multi_select fields an empty option list", () => {
    const res = parseSchemaMarkdown(
      "## T\n- status: select\n- tags: multi-select",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0].fields).toEqual([
      { name: "status", type: "select", options: [] },
      { name: "tags", type: "multi_select", options: [] },
    ]);
  });

  it("dedupes field names case-insensitively, keeping the first", () => {
    const res = parseSchemaMarkdown(
      "## T\n- Name: text\n- name: currency\n- amount: number",
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0].fields).toEqual([
      { name: "Name", type: "text" },
      { name: "amount", type: "number" },
    ]);
  });

  it("drops reserved field names", () => {
    const res = parseSchemaMarkdown("## T\n- id: text\n- title: text");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0].fields).toEqual([{ name: "title", type: "text" }]);
  });

  it("falls back to text for unrecognised types", () => {
    const res = parseSchemaMarkdown("## T\n- where: geolocation");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0].fields).toEqual([{ name: "where", type: "text" }]);
  });

  it("skips tables that have no usable fields", () => {
    const md = ["## Empty", "(no fields here)", "## Real", "- a: text"].join(
      "\n",
    );
    const res = parseSchemaMarkdown(md);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toHaveLength(1);
    expect(res.value[0].tableName).toBe("Real");
  });

  it("strips surrounding code fences", () => {
    const res = parseSchemaMarkdown("```markdown\n## T\n- a: text\n```");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value[0].fields).toEqual([{ name: "a", type: "text" }]);
  });

  it("fails on empty input and on schemas with zero usable tables", () => {
    expect(parseSchemaMarkdown("").ok).toBe(false);
    expect(parseSchemaMarkdown("   ").ok).toBe(false);
    // A heading with no parseable field lines yields no table.
    expect(parseSchemaMarkdown("## Only a heading\njust prose").ok).toBe(false);
  });
});
