import { beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_DOCUMENT_TEMPLATES_STORAGE_KEY,
  CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX,
  DOCUMENT_TEMPLATE_FORMAT,
  DOCUMENT_TEMPLATE_VERSION,
  MAX_CUSTOM_DOCUMENT_TEMPLATES,
  MAX_DOCUMENT_TEMPLATE_DESCRIPTION,
  MAX_DOCUMENT_TEMPLATE_LABEL,
  buildCustomDocumentTemplate,
  customDocumentTemplateToDraft,
  documentTemplateFilename,
  duplicateDocumentTemplateDraft,
  emptyDocumentTemplateDraft,
  findCustomDocumentTemplate,
  isCustomDocumentTemplateId,
  isDocumentTemplateCategory,
  loadCustomDocumentTemplates,
  newCustomDocumentTemplateId,
  normalizeDocumentTemplateContent,
  parseCustomDocumentTemplateStore,
  parseDocumentTemplate,
  parseStoredDocumentTemplate,
  removeCustomDocumentTemplate,
  saveCustomDocumentTemplates,
  serializeCustomDocumentTemplateStore,
  serializeDocumentTemplate,
  upsertCustomDocumentTemplate,
  type CustomDocumentTemplate,
  type CustomDocumentTemplateDraft,
} from "../customDocumentTemplates";

const SAMPLE_HTML = "<h1>Status report</h1><p>Body copy.</p>";

/** A minimal valid draft; override fields per-test. */
function draft(
  overrides: Partial<CustomDocumentTemplateDraft> = {},
): CustomDocumentTemplateDraft {
  return {
    label: "Weekly status",
    description: "",
    category: "",
    content: SAMPLE_HTML,
    ...overrides,
  };
}

/** Build a template with a deterministic id so assertions are stable. */
function template(
  overrides: Partial<CustomDocumentTemplateDraft> = {},
  id = "fixed",
): CustomDocumentTemplate {
  const result = buildCustomDocumentTemplate(
    draft(overrides),
    () => `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}${id}`,
  );
  if (!result.ok) {
    throw new Error(`unexpected build failure: ${result.errors.join(", ")}`);
  }
  return result.template;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("newCustomDocumentTemplateId / isCustomDocumentTemplateId", () => {
  it("mints custom-namespaced ids that round-trip the guard", () => {
    const id = newCustomDocumentTemplateId();
    expect(id.startsWith(CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX)).toBe(true);
    expect(isCustomDocumentTemplateId(id)).toBe(true);
  });

  it("rejects foreign / absent ids (incl. a built-in doc- id)", () => {
    expect(isCustomDocumentTemplateId("doc-meeting-notes")).toBe(false);
    expect(isCustomDocumentTemplateId("tpl-x")).toBe(false);
    expect(isCustomDocumentTemplateId(undefined)).toBe(false);
    expect(isCustomDocumentTemplateId(null)).toBe(false);
  });
});

describe("isDocumentTemplateCategory", () => {
  it("narrows known categories and rejects everything else", () => {
    expect(isDocumentTemplateCategory("Meetings")).toBe(true);
    expect(isDocumentTemplateCategory("Engineering")).toBe(true);
    expect(isDocumentTemplateCategory("Nonsense")).toBe(false);
    expect(isDocumentTemplateCategory("")).toBe(false);
    expect(isDocumentTemplateCategory(42)).toBe(false);
    expect(isDocumentTemplateCategory(null)).toBe(false);
  });
});

describe("normalizeDocumentTemplateContent", () => {
  it("returns trusted-tag-leading HTML unchanged", () => {
    expect(normalizeDocumentTemplateContent(SAMPLE_HTML)).toBe(SAMPLE_HTML);
  });

  it("degrades a non-string value to a clean empty paragraph", () => {
    for (const bad of [null, undefined, 42, { content: "x" }, []]) {
      expect(normalizeDocumentTemplateContent(bad)).toBe("<p></p>");
    }
  });

  it("escapes + wraps plain text that does not start with a trusted tag", () => {
    const out = normalizeDocumentTemplateContent("hello <script>x</script>");
    // Plain-text branch escapes angle brackets so no live markup survives.
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });
});

describe("buildCustomDocumentTemplate", () => {
  it("builds a valid template, minting a custom id and keeping content", () => {
    const result = buildCustomDocumentTemplate(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isCustomDocumentTemplateId(result.template.id)).toBe(true);
    expect(result.template.label).toBe("Weekly status");
    expect(result.template.content).toBe(SAMPLE_HTML);
  });

  it("rejects an empty / whitespace-only name", () => {
    for (const label of ["", "   ", "\t\n"]) {
      const result = buildCustomDocumentTemplate(draft({ label }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContain("Give the template a name.");
    }
  });

  it("collapses whitespace and length-bounds the label + description", () => {
    const result = buildCustomDocumentTemplate(
      draft({
        label: `  ${"a".repeat(200)}  `,
        description: `  ${"b".repeat(400)}  `,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.label).toHaveLength(MAX_DOCUMENT_TEMPLATE_LABEL);
    expect(result.template.description).toHaveLength(
      MAX_DOCUMENT_TEMPLATE_DESCRIPTION,
    );
  });

  it("omits a blank description and an unknown category", () => {
    const result = buildCustomDocumentTemplate(
      draft({ description: "   ", category: "Nonsense" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.description).toBeUndefined();
    expect(result.template.category).toBeUndefined();
  });

  it("keeps a known category", () => {
    const result = buildCustomDocumentTemplate(draft({ category: "Meetings" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.category).toBe("Meetings");
  });

  it("edits in place when the draft carries a custom-namespaced id", () => {
    const id = `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}keep-me`;
    const result = buildCustomDocumentTemplate(
      draft({ id }),
      () => "doctpl-other",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.id).toBe(id);
  });

  it("mints a fresh id when the draft id is foreign (non-destructive)", () => {
    const result = buildCustomDocumentTemplate(
      draft({ id: "doc-meeting-notes" }),
      () => `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}fresh`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.id).toBe(
      `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}fresh`,
    );
  });
});

describe("draft helpers", () => {
  it("emptyDocumentTemplateDraft seeds a blank draft around the content", () => {
    expect(emptyDocumentTemplateDraft(SAMPLE_HTML)).toEqual({
      label: "",
      description: "",
      category: "",
      content: SAMPLE_HTML,
    });
  });

  it("customDocumentTemplateToDraft keeps the id for in-place editing", () => {
    const t = template({ description: "d", category: "Meetings" });
    const d = customDocumentTemplateToDraft(t);
    expect(d.id).toBe(t.id);
    expect(d.label).toBe(t.label);
    expect(d.description).toBe("d");
    expect(d.category).toBe("Meetings");
    expect(d.content).toBe(t.content);
  });

  it("duplicateDocumentTemplateDraft drops the id and suffixes the label", () => {
    const t = template({ label: "Plan" });
    const d = duplicateDocumentTemplateDraft(t);
    expect(d.id).toBeUndefined();
    expect(d.label).toBe("Plan (copy)");
    expect(d.content).toBe(t.content);
  });
});

describe("list ops", () => {
  it("appends a new template and replaces an existing one in place", () => {
    const a = template({ label: "A" }, "a");
    const b = template({ label: "B" }, "b");
    let list = upsertCustomDocumentTemplate([], a);
    list = upsertCustomDocumentTemplate(list, b);
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);

    const aEdited: CustomDocumentTemplate = { ...a, label: "A2" };
    list = upsertCustomDocumentTemplate(list, aEdited);
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe("A2");
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("caps a new insert at the max by dropping the oldest", () => {
    let list: CustomDocumentTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_DOCUMENT_TEMPLATES + 5; i++) {
      list = upsertCustomDocumentTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    expect(list).toHaveLength(MAX_CUSTOM_DOCUMENT_TEMPLATES);
    expect(list[0].id).toBe(`${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}t5`);
    expect(list[list.length - 1].id).toBe(
      `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}t${MAX_CUSTOM_DOCUMENT_TEMPLATES + 4}`,
    );
  });

  it("a replacement never trips the cap", () => {
    let list: CustomDocumentTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_DOCUMENT_TEMPLATES; i++) {
      list = upsertCustomDocumentTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    const edited: CustomDocumentTemplate = { ...list[0], label: "edited" };
    const next = upsertCustomDocumentTemplate(list, edited);
    expect(next).toHaveLength(MAX_CUSTOM_DOCUMENT_TEMPLATES);
    expect(next[0].label).toBe("edited");
  });

  it("removes by id and finds null-safely", () => {
    const a = template({ label: "A" }, "a");
    const b = template({ label: "B" }, "b");
    const list = [a, b];
    expect(removeCustomDocumentTemplate(list, a.id).map((t) => t.id)).toEqual([
      b.id,
    ]);
    expect(removeCustomDocumentTemplate(list, "doctpl-missing")).toHaveLength(
      2,
    );
    expect(findCustomDocumentTemplate(list, b.id)?.id).toBe(b.id);
    expect(findCustomDocumentTemplate(list, "doctpl-missing")).toBeNull();
    expect(findCustomDocumentTemplate(list, undefined)).toBeNull();
  });
});

describe("store round-trip + defensive parse", () => {
  it("serialize → parse preserves the list", () => {
    const list = [template({ label: "A" }, "a"), template({ label: "B" }, "b")];
    const parsed = parseCustomDocumentTemplateStore(
      serializeCustomDocumentTemplateStore(list),
    );
    expect(parsed?.map((t) => t.id)).toEqual([list[0].id, list[1].id]);
  });

  it("returns null for absent / bad JSON / wrong version / non-array", () => {
    expect(parseCustomDocumentTemplateStore(null)).toBeNull();
    expect(parseCustomDocumentTemplateStore("not json{")).toBeNull();
    expect(
      parseCustomDocumentTemplateStore(
        JSON.stringify({ version: 999, templates: [] }),
      ),
    ).toBeNull();
    expect(
      parseCustomDocumentTemplateStore(
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
        { id: "doc-meeting-notes", label: "foreign id" }, // not doctpl-
        { id: "doctpl-x" }, // missing label
        42, // not an object
        good, // duplicate id
      ],
    });
    const parsed = parseCustomDocumentTemplateStore(raw);
    expect(parsed?.map((t) => t.id)).toEqual([good.id]);
  });

  it("caps the parsed list at the max", () => {
    const templates = Array.from(
      { length: MAX_CUSTOM_DOCUMENT_TEMPLATES + 10 },
      (_, i) => template({ label: `T${i}` }, `t${i}`),
    );
    const parsed = parseCustomDocumentTemplateStore(
      JSON.stringify({ version: 1, templates }),
    );
    expect(parsed).toHaveLength(MAX_CUSTOM_DOCUMENT_TEMPLATES);
  });

  it("parseStoredDocumentTemplate rejects a foreign id / non-object", () => {
    expect(
      parseStoredDocumentTemplate({ id: "doc-meeting-notes", label: "x" }),
    ).toBeNull();
    expect(parseStoredDocumentTemplate(null)).toBeNull();
  });

  it("load / save go through localStorage and never throw", () => {
    expect(loadCustomDocumentTemplates()).toEqual([]);
    const list = [template({ label: "A" }, "a")];
    saveCustomDocumentTemplates(list);
    const raw = window.localStorage.getItem(
      CUSTOM_DOCUMENT_TEMPLATES_STORAGE_KEY,
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ version: 1 });
    expect(loadCustomDocumentTemplates().map((t) => t.id)).toEqual([
      list[0].id,
    ]);
  });
});

describe("portable template file", () => {
  it("filename is a slugged tessera-doc-template-*.json", () => {
    expect(documentTemplateFilename(template({ label: "Q3 Review!" }))).toBe(
      "tessera-doc-template-q3-review.json",
    );
    expect(documentTemplateFilename(template({ label: "***" }))).toBe(
      "tessera-doc-template-template.json",
    );
  });

  it("serialize wraps the distinct {format,version,template} envelope", () => {
    const t = template({ label: "Doc" });
    const parsed: unknown = JSON.parse(serializeDocumentTemplate(t));
    expect(parsed).toMatchObject({
      format: DOCUMENT_TEMPLATE_FORMAT,
      version: DOCUMENT_TEMPLATE_VERSION,
    });
  });

  it("export does not mutate the source template", () => {
    const t = template({
      label: "Doc",
      description: "d",
      category: "Meetings",
    });
    const snapshot = JSON.stringify(t);
    serializeDocumentTemplate(t);
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it("round-trips serialize → import, dropping the id (non-destructive)", () => {
    const t = template({ label: "Shareable", category: "Meetings" });
    const result = parseDocumentTemplate(serializeDocumentTemplate(t));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.id).toBeUndefined();
    expect(result.draft.label).toBe("Shareable");
    expect(result.draft.category).toBe("Meetings");
    expect(result.draft.content).toBe(SAMPLE_HTML);

    const rebuilt = buildCustomDocumentTemplate(result.draft);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.template.id).not.toBe(t.id);
  });

  it("rejects invalid JSON", () => {
    const result = parseDocumentTemplate("not json{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/i);
  });

  it("rejects a file without the document-template format tag", () => {
    const result = parseDocumentTemplate(
      serializeCustomDocumentTemplateStore([]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Tessera document template file/i);
  });

  it("rejects a version newer than this build", () => {
    const blob = JSON.stringify({
      format: DOCUMENT_TEMPLATE_FORMAT,
      version: DOCUMENT_TEMPLATE_VERSION + 1,
      template: template({ label: "Future" }),
    });
    const result = parseDocumentTemplate(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
  });

  it("rejects a below-first / non-integer / non-finite version as malformed", () => {
    for (const version of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const blob = JSON.stringify({
        format: DOCUMENT_TEMPLATE_FORMAT,
        version,
        template: template({ label: "X" }),
      });
      const result = parseDocumentTemplate(blob);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/valid Tessera document template file/i);
      expect(result.error).not.toMatch(/newer version/i);
    }
  });

  it("rejects a non-numeric version", () => {
    const blob = JSON.stringify({
      format: DOCUMENT_TEMPLATE_FORMAT,
      version: "1",
      template: template({ label: "X" }),
    });
    expect(parseDocumentTemplate(blob).ok).toBe(false);
  });

  it("rejects a file that contains no template", () => {
    const blob = JSON.stringify({
      format: DOCUMENT_TEMPLATE_FORMAT,
      version: DOCUMENT_TEMPLATE_VERSION,
      template: 123,
    });
    const result = parseDocumentTemplate(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/doesn’t contain a document template/i);
  });

  it("imports a hand-written file with no content, degrading the body", () => {
    const blob = JSON.stringify({
      format: DOCUMENT_TEMPLATE_FORMAT,
      version: DOCUMENT_TEMPLATE_VERSION,
      template: { label: "Bare" },
    });
    const result = parseDocumentTemplate(blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.label).toBe("Bare");
    expect(result.draft.content).toBe("<p></p>");
  });

  it("rejects a file whose template has no usable name", () => {
    const blob = JSON.stringify({
      format: DOCUMENT_TEMPLATE_FORMAT,
      version: DOCUMENT_TEMPLATE_VERSION,
      template: { label: "   ", content: SAMPLE_HTML },
    });
    const result = parseDocumentTemplate(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/name/i);
  });
});
