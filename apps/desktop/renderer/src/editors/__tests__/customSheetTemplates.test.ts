import { beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_SHEET_TEMPLATES_STORAGE_KEY,
  CUSTOM_SHEET_TEMPLATE_ID_PREFIX,
  MAX_CUSTOM_SHEET_TEMPLATES,
  MAX_TEMPLATE_DESCRIPTION,
  MAX_TEMPLATE_LABEL,
  SHEET_TEMPLATE_FORMAT,
  SHEET_TEMPLATE_VERSION,
  buildCustomSheetTemplate,
  customSheetTemplateToDraft,
  duplicateSheetTemplateDraft,
  emptySheetTemplateDraft,
  findCustomSheetTemplate,
  isCustomSheetTemplateId,
  loadCustomSheetTemplates,
  newCustomSheetTemplateId,
  normalizeSheetContent,
  parseCustomSheetTemplateStore,
  parseSheetTemplate,
  parseStoredSheetTemplate,
  removeCustomSheetTemplate,
  saveCustomSheetTemplates,
  serializeCustomSheetTemplateStore,
  serializeSheetTemplate,
  sheetTemplateFilename,
  upsertCustomSheetTemplate,
  type CustomSheetTemplate,
  type CustomSheetTemplateDraft,
} from "../customSheetTemplates";
import type { SheetTemplateContent } from "../sheetTemplates";

/** A minimal, fully-valid sheet; override fields per-test. */
function sheet(
  overrides: Partial<SheetTemplateContent> = {},
): SheetTemplateContent {
  return {
    columns: ["Item", "Amount"],
    rows: [
      ["Rent", "1200"],
      ["Food", "450"],
    ],
    ...overrides,
  };
}

/** A minimal valid draft; override fields per-test. */
function draft(
  overrides: Partial<CustomSheetTemplateDraft> = {},
): CustomSheetTemplateDraft {
  return {
    label: "Monthly budget",
    description: "",
    category: "",
    content: sheet(),
    ...overrides,
  };
}

/** Build a template with a deterministic id so assertions are stable. */
function template(
  overrides: Partial<CustomSheetTemplateDraft> = {},
  id = "fixed",
): CustomSheetTemplate {
  const result = buildCustomSheetTemplate(
    draft(overrides),
    () => `${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}${id}`,
  );
  if (!result.ok) {
    throw new Error(`unexpected build failure: ${result.errors.join(", ")}`);
  }
  return result.template;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("newCustomSheetTemplateId / isCustomSheetTemplateId", () => {
  it("mints custom-namespaced ids that round-trip the guard", () => {
    const id = newCustomSheetTemplateId();
    expect(id.startsWith(CUSTOM_SHEET_TEMPLATE_ID_PREFIX)).toBe(true);
    expect(isCustomSheetTemplateId(id)).toBe(true);
  });

  it("rejects foreign / absent ids", () => {
    expect(isCustomSheetTemplateId("monthly-budget")).toBe(false);
    expect(isCustomSheetTemplateId("tpl-1")).toBe(false);
    expect(isCustomSheetTemplateId(undefined)).toBe(false);
    expect(isCustomSheetTemplateId(null)).toBe(false);
  });
});

describe("normalizeSheetContent", () => {
  it("preserves a valid sheet's columns and rows", () => {
    const normalized = normalizeSheetContent(sheet());
    expect(normalized.columns).toEqual(["Item", "Amount"]);
    expect(normalized.rows).toEqual([
      ["Rent", "1200"],
      ["Food", "450"],
    ]);
  });

  it("degrades a non-record value to a clean default grid", () => {
    for (const bad of [null, 42, "nope", true]) {
      const normalized = normalizeSheetContent(bad);
      expect(normalized.columns).toEqual(["A", "B", "C"]);
      expect(normalized.rows).toHaveLength(1);
      expect(normalized.rows[0]).toEqual(["", "", ""]);
    }
  });

  it("coerces non-string cells and drops non-array rows", () => {
    const normalized = normalizeSheetContent({
      columns: ["A", 7, true],
      rows: [["x", 12, false], "not-a-row", [null, undefined]],
    });
    expect(normalized.columns).toEqual(["A", "7", "TRUE"]);
    expect(normalized.rows).toEqual([
      ["x", "12", "FALSE"],
      ["", ""],
    ]);
  });

  it("keeps valid per-cell formats and drops malformed keys / styles", () => {
    const normalized = normalizeSheetContent({
      columns: ["A"],
      rows: [["1"]],
      formats: {
        "0,0": { numberFormat: "$#,##0.00", bold: true },
        "bad-key": { bold: true },
        "1,1": { nonsense: true },
      },
    });
    expect(normalized.formats).toEqual({
      "0,0": { numberFormat: "$#,##0.00", bold: true },
    });
  });

  it("keeps a valid chart and drops charts with a bad type or range", () => {
    const normalized = normalizeSheetContent({
      columns: ["A", "B"],
      rows: [["1", "2"]],
      charts: [
        { id: "c1", type: "bar", range: "A1:B2" },
        { id: "c2", type: "pyramid", range: "A1:B2" },
        { id: "c3", type: "line", range: "" },
        { type: "bar", range: "A1:B2" },
      ],
    });
    expect(normalized.charts).toEqual([
      { id: "c1", type: "bar", range: "A1:B2" },
    ]);
  });

  it("guards freeze counts: only positive integers survive", () => {
    expect(
      normalizeSheetContent({ columns: ["A"], rows: [["1"]], frozenRows: 2 })
        .frozenRows,
    ).toBe(2);
    for (const bad of [0, -1, 1.5, "2"]) {
      const out = normalizeSheetContent({
        columns: ["A"],
        rows: [["1"]],
        frozenRows: bad,
      });
      expect(out.frozenRows).toBeUndefined();
    }
  });

  it("omits empty optional collections so equal sheets serialise alike", () => {
    const normalized = normalizeSheetContent({
      columns: ["A"],
      rows: [["1"]],
      formats: { "bad-key": { bold: true } },
      charts: [],
      conditionalRules: [],
      namedRanges: [],
    });
    expect(normalized).toEqual({ columns: ["A"], rows: [["1"]] });
  });
});

describe("buildCustomSheetTemplate", () => {
  it("builds a valid template, minting a custom id", () => {
    const result = buildCustomSheetTemplate(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isCustomSheetTemplateId(result.template.id)).toBe(true);
    expect(result.template.label).toBe("Monthly budget");
    expect(result.template.content.columns).toEqual(["Item", "Amount"]);
  });

  it("rejects an empty / whitespace-only name", () => {
    for (const label of ["", "   ", "\t\n"]) {
      const result = buildCustomSheetTemplate(draft({ label }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContain("Give the template a name.");
    }
  });

  it("collapses whitespace and length-bounds the label + description", () => {
    const result = buildCustomSheetTemplate(
      draft({
        label: `  ${"a".repeat(200)}  `,
        description: `  ${"b".repeat(400)}  `,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.label).toHaveLength(MAX_TEMPLATE_LABEL);
    expect(result.template.description).toHaveLength(MAX_TEMPLATE_DESCRIPTION);
  });

  it("omits a blank description and an unknown category", () => {
    const result = buildCustomSheetTemplate(
      draft({ description: "   ", category: "Nonsense" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.description).toBeUndefined();
    expect(result.template.category).toBeUndefined();
  });

  it("keeps a known category", () => {
    const result = buildCustomSheetTemplate(draft({ category: "Finance" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.category).toBe("Finance");
  });

  it("edits in place when the draft carries a custom-namespaced id", () => {
    const id = `${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}keep-me`;
    const result = buildCustomSheetTemplate(draft({ id }), () => "tpl-other");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.id).toBe(id);
  });

  it("mints a fresh id when the draft id is foreign (non-destructive)", () => {
    const result = buildCustomSheetTemplate(
      draft({ id: "monthly-budget" }),
      () => `${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}fresh`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.id).toBe(`${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}fresh`);
  });
});

describe("draft helpers", () => {
  it("emptySheetTemplateDraft seeds a blank draft around a sheet", () => {
    const d = emptySheetTemplateDraft(sheet());
    expect(d).toEqual({
      label: "",
      description: "",
      category: "",
      content: sheet(),
    });
  });

  it("customSheetTemplateToDraft keeps the id for in-place editing", () => {
    const t = template({ description: "d", category: "Finance" });
    const d = customSheetTemplateToDraft(t);
    expect(d.id).toBe(t.id);
    expect(d.label).toBe(t.label);
    expect(d.description).toBe("d");
    expect(d.category).toBe("Finance");
  });

  it("duplicateSheetTemplateDraft drops the id and suffixes the label", () => {
    const t = template({ label: "Budget" });
    const d = duplicateSheetTemplateDraft(t);
    expect(d.id).toBeUndefined();
    expect(d.label).toBe("Budget (copy)");
  });
});

describe("list ops", () => {
  it("appends a new template and replaces an existing one in place", () => {
    const a = template({ label: "A" }, "a");
    const b = template({ label: "B" }, "b");
    let list = upsertCustomSheetTemplate([], a);
    list = upsertCustomSheetTemplate(list, b);
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);

    const aEdited: CustomSheetTemplate = { ...a, label: "A2" };
    list = upsertCustomSheetTemplate(list, aEdited);
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe("A2");
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("caps a new insert at the max by dropping the oldest", () => {
    let list: CustomSheetTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_SHEET_TEMPLATES + 5; i++) {
      list = upsertCustomSheetTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    expect(list).toHaveLength(MAX_CUSTOM_SHEET_TEMPLATES);
    expect(list[0].id).toBe(`${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}t5`);
    expect(list[list.length - 1].id).toBe(
      `${CUSTOM_SHEET_TEMPLATE_ID_PREFIX}t${MAX_CUSTOM_SHEET_TEMPLATES + 4}`,
    );
  });

  it("a replacement never trips the cap", () => {
    let list: CustomSheetTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_SHEET_TEMPLATES; i++) {
      list = upsertCustomSheetTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    const edited: CustomSheetTemplate = { ...list[0], label: "edited" };
    const next = upsertCustomSheetTemplate(list, edited);
    expect(next).toHaveLength(MAX_CUSTOM_SHEET_TEMPLATES);
    expect(next[0].label).toBe("edited");
  });

  it("removes by id and finds null-safely", () => {
    const a = template({ label: "A" }, "a");
    const b = template({ label: "B" }, "b");
    const list = [a, b];
    expect(removeCustomSheetTemplate(list, a.id).map((t) => t.id)).toEqual([
      b.id,
    ]);
    expect(removeCustomSheetTemplate(list, "stpl-missing")).toHaveLength(2);
    expect(findCustomSheetTemplate(list, b.id)?.id).toBe(b.id);
    expect(findCustomSheetTemplate(list, "stpl-missing")).toBeNull();
    expect(findCustomSheetTemplate(list, undefined)).toBeNull();
  });
});

describe("store round-trip + defensive parse", () => {
  it("serialize → parse preserves the list", () => {
    const list = [template({ label: "A" }, "a"), template({ label: "B" }, "b")];
    const parsed = parseCustomSheetTemplateStore(
      serializeCustomSheetTemplateStore(list),
    );
    expect(parsed?.map((t) => t.id)).toEqual([list[0].id, list[1].id]);
  });

  it("returns null for absent / bad JSON / wrong version / non-array", () => {
    expect(parseCustomSheetTemplateStore(null)).toBeNull();
    expect(parseCustomSheetTemplateStore("not json{")).toBeNull();
    expect(
      parseCustomSheetTemplateStore(
        JSON.stringify({ version: 999, templates: [] }),
      ),
    ).toBeNull();
    expect(
      parseCustomSheetTemplateStore(
        JSON.stringify({ version: 1, templates: "nope" }),
      ),
    ).toBeNull();
  });

  it("drops malformed, foreign-id, and duplicate-id entries", () => {
    const good = template({ label: "Keep" }, "keep");
    const raw = JSON.stringify({
      version: 1,
      templates: [
        good,
        { id: "monthly-budget", label: "foreign id" }, // not stpl- namespaced
        { id: "stpl-x" }, // missing label
        42, // not an object
        good, // duplicate id
      ],
    });
    const parsed = parseCustomSheetTemplateStore(raw);
    expect(parsed?.map((t) => t.id)).toEqual([good.id]);
  });

  it("caps the parsed list at the max", () => {
    const templates = Array.from(
      { length: MAX_CUSTOM_SHEET_TEMPLATES + 10 },
      (_, i) => template({ label: `T${i}` }, `t${i}`),
    );
    const parsed = parseCustomSheetTemplateStore(
      JSON.stringify({ version: 1, templates }),
    );
    expect(parsed).toHaveLength(MAX_CUSTOM_SHEET_TEMPLATES);
  });

  it("parseStoredSheetTemplate rejects a foreign id", () => {
    expect(
      parseStoredSheetTemplate({ id: "monthly-budget", label: "x" }),
    ).toBeNull();
    expect(parseStoredSheetTemplate(null)).toBeNull();
  });

  it("load / save go through localStorage and never throw", () => {
    expect(loadCustomSheetTemplates()).toEqual([]);
    const list = [template({ label: "A" }, "a")];
    saveCustomSheetTemplates(list);
    const raw = window.localStorage.getItem(CUSTOM_SHEET_TEMPLATES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ version: 1 });
    expect(loadCustomSheetTemplates().map((t) => t.id)).toEqual([list[0].id]);
  });
});

describe("portable template file", () => {
  it("filename is a slugged tessera-sheet-template-*.json", () => {
    expect(sheetTemplateFilename(template({ label: "Q3 Budget!" }))).toBe(
      "tessera-sheet-template-q3-budget.json",
    );
    expect(sheetTemplateFilename(template({ label: "***" }))).toBe(
      "tessera-sheet-template-template.json",
    );
  });

  it("serialize wraps the distinct {format,version,template} envelope", () => {
    const t = template({ label: "Budget" });
    const parsed: unknown = JSON.parse(serializeSheetTemplate(t));
    expect(parsed).toMatchObject({
      format: SHEET_TEMPLATE_FORMAT,
      version: SHEET_TEMPLATE_VERSION,
    });
  });

  it("export does not mutate the source template", () => {
    const t = template({
      label: "Budget",
      description: "d",
      category: "Finance",
    });
    const snapshot = JSON.stringify(t);
    serializeSheetTemplate(t);
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it("round-trips serialize → import, dropping the id (non-destructive)", () => {
    const t = template({ label: "Shareable", category: "Finance" });
    const result = parseSheetTemplate(serializeSheetTemplate(t));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.id).toBeUndefined();
    expect(result.draft.label).toBe("Shareable");
    expect(result.draft.category).toBe("Finance");
    expect(result.draft.content.columns).toEqual(["Item", "Amount"]);

    const rebuilt = buildCustomSheetTemplate(result.draft);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.template.id).not.toBe(t.id);
  });

  it("rejects invalid JSON", () => {
    const result = parseSheetTemplate("not json{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/i);
  });

  it("rejects a file without the sheet-template format tag", () => {
    // The store envelope ({version, templates}) has no `format`.
    const result = parseSheetTemplate(serializeCustomSheetTemplateStore([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Tessera sheet template file/i);
  });

  it("rejects a version newer than this build", () => {
    const blob = JSON.stringify({
      format: SHEET_TEMPLATE_FORMAT,
      version: SHEET_TEMPLATE_VERSION + 1,
      template: template({ label: "Future" }),
    });
    const result = parseSheetTemplate(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
  });

  it("rejects a below-first / non-integer / non-finite version as malformed", () => {
    for (const version of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const blob = JSON.stringify({
        format: SHEET_TEMPLATE_FORMAT,
        version,
        template: template({ label: "X" }),
      });
      const result = parseSheetTemplate(blob);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/valid Tessera sheet template file/i);
      expect(result.error).not.toMatch(/newer version/i);
    }
  });

  it("rejects a non-numeric version", () => {
    const blob = JSON.stringify({
      format: SHEET_TEMPLATE_FORMAT,
      version: "1",
      template: template({ label: "X" }),
    });
    expect(parseSheetTemplate(blob).ok).toBe(false);
  });

  it("rejects a file that contains no template", () => {
    const blob = JSON.stringify({
      format: SHEET_TEMPLATE_FORMAT,
      version: SHEET_TEMPLATE_VERSION,
      template: 123,
    });
    const result = parseSheetTemplate(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/doesn’t contain a sheet template/i);
  });

  it("imports a hand-written file with no content, degrading the grid", () => {
    const blob = JSON.stringify({
      format: SHEET_TEMPLATE_FORMAT,
      version: SHEET_TEMPLATE_VERSION,
      template: { label: "Bare" },
    });
    const result = parseSheetTemplate(blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.label).toBe("Bare");
    expect(result.draft.content.columns).toEqual(["A", "B", "C"]);
    expect(result.draft.content.rows).toHaveLength(1);
  });
});
