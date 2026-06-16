import { beforeEach, describe, expect, it } from "vitest";
import {
  BASE_TEMPLATE_FORMAT,
  BASE_TEMPLATE_VERSION,
  CUSTOM_BASE_TEMPLATES_STORAGE_KEY,
  CUSTOM_BASE_TEMPLATE_ID_PREFIX,
  MAX_BASE_TEMPLATE_DESCRIPTION,
  MAX_BASE_TEMPLATE_LABEL,
  MAX_CUSTOM_BASE_TEMPLATES,
  baseTemplateFilename,
  buildCustomBaseTemplate,
  coerceBaseDocument,
  duplicateBaseTemplateDraft,
  findCustomBaseTemplate,
  instantiateBaseDocument,
  isBaseTemplateCategory,
  isCustomBaseTemplateId,
  loadCustomBaseTemplates,
  newCustomBaseTemplateId,
  parseBaseTemplate,
  parseCustomBaseTemplateStore,
  parseStoredBaseTemplate,
  removeCustomBaseTemplate,
  saveCustomBaseTemplates,
  serializeBaseTemplate,
  serializeCustomBaseTemplateStore,
  upsertCustomBaseTemplate,
  type CustomBaseTemplate,
  type CustomBaseTemplateDraft,
} from "../customBaseTemplates";
import { parseBaseDocument } from "../baseDocumentHelpers";
import type { BaseDocument } from "../baseEditorTypes";

/** A minimal, fully-valid base; the single record lets us assert clones. */
function baseDoc(name = "Ada"): BaseDocument {
  return parseBaseDocument(
    JSON.stringify({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: name }],
    }),
  );
}

/** A minimal valid draft; override per-test. */
function draft(
  overrides: Partial<CustomBaseTemplateDraft> = {},
): CustomBaseTemplateDraft {
  return {
    label: "Sales pipeline",
    description: "",
    category: "",
    content: baseDoc(),
    ...overrides,
  };
}

/** Build a template with a deterministic id so assertions are stable. */
function template(
  overrides: Partial<CustomBaseTemplateDraft> = {},
  id = "fixed",
): CustomBaseTemplate {
  const result = buildCustomBaseTemplate(
    draft(overrides),
    () => `${CUSTOM_BASE_TEMPLATE_ID_PREFIX}${id}`,
  );
  if (!result.ok) throw new Error(`fixture build failed: ${result.errors}`);
  return result.template;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("category + id guards", () => {
  it("recognises only known categories", () => {
    expect(isBaseTemplateCategory("Sales")).toBe(true);
    expect(isBaseTemplateCategory("Nope")).toBe(false);
    expect(isBaseTemplateCategory(7)).toBe(false);
    expect(isBaseTemplateCategory(null)).toBe(false);
  });

  it("recognises custom-namespaced ids only", () => {
    expect(isCustomBaseTemplateId(`${CUSTOM_BASE_TEMPLATE_ID_PREFIX}x`)).toBe(
      true,
    );
    expect(isCustomBaseTemplateId("crm")).toBe(false);
    expect(isCustomBaseTemplateId(undefined)).toBe(false);
    expect(isCustomBaseTemplateId(null)).toBe(false);
  });

  it("mints prefixed, distinct ids", () => {
    const a = newCustomBaseTemplateId();
    const b = newCustomBaseTemplateId();
    expect(a.startsWith(CUSTOM_BASE_TEMPLATE_ID_PREFIX)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("coerceBaseDocument / instantiateBaseDocument", () => {
  it("parses a raw artifact-body string", () => {
    const doc = coerceBaseDocument(
      JSON.stringify({
        fields: [{ name: "Name", type: "text" }],
        records: [{ id: "r1", Name: "Grace" }],
      }),
    );
    expect(doc.tables[0].records[0].Name).toBe("Grace");
  });

  it("deep-clones a document (no shared record references)", () => {
    const src = baseDoc("Ada");
    const clone = coerceBaseDocument(src);
    expect(clone).not.toBe(src);
    expect(clone.tables[0].records).not.toBe(src.tables[0].records);
    expect(clone.tables[0].records[0].Name).toBe("Ada");
    // Mutating the source must not leak into the clone.
    src.tables[0].records[0].Name = "changed";
    expect(clone.tables[0].records[0].Name).toBe("Ada");
  });

  it("degrades a non-object to the default seed base instead of throwing", () => {
    expect(() => coerceBaseDocument(42)).not.toThrow();
    const doc = coerceBaseDocument(42);
    expect(doc.tables.length).toBeGreaterThan(0);
  });

  it("instantiateBaseDocument returns a fresh independent document", () => {
    const src = baseDoc();
    const fresh = instantiateBaseDocument(src);
    expect(fresh).not.toBe(src);
    expect(fresh.tables[0].records[0].Name).toBe("Ada");
  });
});

describe("buildCustomBaseTemplate", () => {
  it("rejects a blank / whitespace-only label", () => {
    const a = buildCustomBaseTemplate(draft({ label: "" }));
    const b = buildCustomBaseTemplate(draft({ label: "   " }));
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (!a.ok) expect(a.errors).toContain("Give the template a name.");
  });

  it("mints a fresh id when the draft has none or a foreign id", () => {
    const minted = buildCustomBaseTemplate(draft());
    const foreign = buildCustomBaseTemplate(draft({ id: "crm" }));
    expect(minted.ok && isCustomBaseTemplateId(minted.template.id)).toBe(true);
    expect(foreign.ok && isCustomBaseTemplateId(foreign.template.id)).toBe(
      true,
    );
  });

  it("reuses a custom-namespaced id (edit in place)", () => {
    const id = `${CUSTOM_BASE_TEMPLATE_ID_PREFIX}keep`;
    const result = buildCustomBaseTemplate(draft({ id }));
    expect(result.ok && result.template.id).toBe(id);
  });

  it("collapses + length-bounds the label and description", () => {
    const result = buildCustomBaseTemplate(
      draft({
        label: `  ${"L".repeat(MAX_BASE_TEMPLATE_LABEL + 20)}  `,
        description: `  ${"D".repeat(MAX_BASE_TEMPLATE_DESCRIPTION + 20)}  `,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.template.label.length).toBe(MAX_BASE_TEMPLATE_LABEL);
      expect(result.template.description?.length).toBe(
        MAX_BASE_TEMPLATE_DESCRIPTION,
      );
    }
  });

  it("omits a blank description and keeps only a valid category", () => {
    const ok = buildCustomBaseTemplate(
      draft({ description: "   ", category: "Projects" }),
    );
    const bad = buildCustomBaseTemplate(draft({ category: "Nonsense" }));
    expect(ok.ok && "description" in ok.template).toBe(false);
    expect(ok.ok && ok.template.category).toBe("Projects");
    expect(bad.ok && "category" in bad.template).toBe(false);
  });

  it("validates the embedded base through the codec", () => {
    const result = buildCustomBaseTemplate(draft());
    expect(result.ok && result.template.content.tables.length).toBeGreaterThan(
      0,
    );
  });
});

describe("duplicateBaseTemplateDraft", () => {
  it("drops the id and suffixes the label", () => {
    const d = duplicateBaseTemplateDraft(template({ label: "CRM" }));
    expect(d.id).toBeUndefined();
    expect(d.label).toBe("CRM (copy)");
  });
});

describe("list ops", () => {
  it("appends new templates and replaces in place by id", () => {
    const a = template({ label: "A" }, "a");
    const b = template({ label: "B" }, "b");
    const list = upsertCustomBaseTemplate([a], b);
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);

    const a2 = template({ label: "A2" }, "a");
    const replaced = upsertCustomBaseTemplate(list, a2);
    expect(replaced.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(replaced[0].label).toBe("A2");
  });

  it("drops the oldest when a NEW template overflows the cap", () => {
    let list: CustomBaseTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_BASE_TEMPLATES; i++) {
      list = upsertCustomBaseTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    expect(list.length).toBe(MAX_CUSTOM_BASE_TEMPLATES);
    const overflow = template({ label: "new" }, "overflow");
    const next = upsertCustomBaseTemplate(list, overflow);
    expect(next.length).toBe(MAX_CUSTOM_BASE_TEMPLATES);
    expect(
      next.find((t) => t.id === `${CUSTOM_BASE_TEMPLATE_ID_PREFIX}t0`),
    ).toBe(undefined);
    expect(next[next.length - 1].id).toBe(overflow.id);
  });

  it("a replacement never trips the cap", () => {
    let list: CustomBaseTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_BASE_TEMPLATES; i++) {
      list = upsertCustomBaseTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    const replaced = upsertCustomBaseTemplate(
      list,
      template({ label: "edited" }, "t0"),
    );
    expect(replaced.length).toBe(MAX_CUSTOM_BASE_TEMPLATES);
    expect(replaced[0].label).toBe("edited");
  });

  it("removes by id and finds (null-safe)", () => {
    const a = template({ label: "A" }, "a");
    expect(removeCustomBaseTemplate([a], a.id)).toEqual([]);
    expect(removeCustomBaseTemplate([a], "missing")).toEqual([a]);
    expect(findCustomBaseTemplate([a], a.id)?.id).toBe(a.id);
    expect(findCustomBaseTemplate([a], null)).toBeNull();
    expect(findCustomBaseTemplate([a], "missing")).toBeNull();
  });
});

describe("store parse / serialize", () => {
  it("rejects stored entries with a foreign id or non-string label", () => {
    expect(parseStoredBaseTemplate({ id: "crm", label: "x" })).toBeNull();
    expect(
      parseStoredBaseTemplate({
        id: `${CUSTOM_BASE_TEMPLATE_ID_PREFIX}x`,
        label: 7,
      }),
    ).toBeNull();
  });

  it("round-trips a list through serialize → parse", () => {
    const list = [template({ label: "A" }, "a"), template({ label: "B" }, "b")];
    const parsed = parseCustomBaseTemplateStore(
      serializeCustomBaseTemplateStore(list),
    );
    expect(parsed?.map((t) => t.id)).toEqual([list[0].id, list[1].id]);
  });

  it("returns null on bad JSON / wrong version / non-array", () => {
    expect(parseCustomBaseTemplateStore(null)).toBeNull();
    expect(parseCustomBaseTemplateStore("{not json")).toBeNull();
    expect(
      parseCustomBaseTemplateStore(
        JSON.stringify({ version: 999, templates: [] }),
      ),
    ).toBeNull();
    expect(
      parseCustomBaseTemplateStore(
        JSON.stringify({ version: 1, templates: "nope" }),
      ),
    ).toBeNull();
  });

  it("drops duplicate-id and unusable entries", () => {
    const good = template({ label: "A" }, "a");
    const raw = JSON.stringify({
      version: 1,
      templates: [good, good, { id: "crm", label: "foreign" }, 42],
    });
    const parsed = parseCustomBaseTemplateStore(raw);
    expect(parsed?.map((t) => t.id)).toEqual([good.id]);
  });

  it("persists + reloads through localStorage", () => {
    const list = [template({ label: "A" }, "a")];
    saveCustomBaseTemplates(list);
    expect(
      window.localStorage.getItem(CUSTOM_BASE_TEMPLATES_STORAGE_KEY),
    ).not.toBe(null);
    expect(loadCustomBaseTemplates().map((t) => t.id)).toEqual([list[0].id]);
  });

  it("loads [] when nothing is stored", () => {
    expect(loadCustomBaseTemplates()).toEqual([]);
  });
});

describe("portable file", () => {
  it("names the export file from a slug of the label", () => {
    expect(baseTemplateFilename(template({ label: "My CRM!" }))).toBe(
      "tessera-base-template-my-crm.json",
    );
    expect(baseTemplateFilename(template({ label: "***" }))).toBe(
      "tessera-base-template-template.json",
    );
  });

  it("wraps export in the {format,version,template} envelope", () => {
    const body = serializeBaseTemplate(template({ label: "A" }, "a"));
    const parsed: unknown = JSON.parse(body);
    expect(parsed).toMatchObject({
      format: BASE_TEMPLATE_FORMAT,
      version: BASE_TEMPLATE_VERSION,
    });
  });

  it("imports a valid file and ALWAYS drops the id (non-destructive)", () => {
    const original = template({ label: "Shared", description: "hi" }, "orig");
    const result = parseBaseTemplate(serializeBaseTemplate(original));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.id).toBeUndefined();
      expect(result.draft.label).toBe("Shared");
      // Saving mints a brand-new custom id, never the original's.
      const built = buildCustomBaseTemplate(result.draft);
      expect(built.ok && built.template.id).not.toBe(original.id);
      expect(built.ok && isCustomBaseTemplateId(built.template.id)).toBe(true);
    }
  });

  it("rejects bad JSON / wrong format / missing template", () => {
    expect(parseBaseTemplate("{nope").ok).toBe(false);
    expect(
      parseBaseTemplate(JSON.stringify({ format: "other", version: 1 })).ok,
    ).toBe(false);
    expect(
      parseBaseTemplate(
        JSON.stringify({ format: BASE_TEMPLATE_FORMAT, version: 1 }),
      ).ok,
    ).toBe(false);
  });

  it("hardened version guard: rejects non-integer / < 1 BEFORE newer", () => {
    const tpl = { label: "x" };
    for (const version of [0, -1, 0.5, "1", null]) {
      const body = JSON.stringify({
        format: BASE_TEMPLATE_FORMAT,
        version,
        template: tpl,
      });
      const result = parseBaseTemplate(body);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toBe(
          "This isn’t a valid Tessera base template file.",
        );
    }
  });

  it("rejects a file from a newer version", () => {
    const body = JSON.stringify({
      format: BASE_TEMPLATE_FORMAT,
      version: BASE_TEMPLATE_VERSION + 1,
      template: { label: "x" },
    });
    const result = parseBaseTemplate(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/newer version/);
  });
});
