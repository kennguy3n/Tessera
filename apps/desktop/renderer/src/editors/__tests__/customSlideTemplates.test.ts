import { beforeEach, describe, expect, it } from "vitest";
import {
  CUSTOM_SLIDE_TEMPLATES_STORAGE_KEY,
  CUSTOM_SLIDE_TEMPLATE_ID_PREFIX,
  MAX_CUSTOM_SLIDE_TEMPLATES,
  MAX_TEMPLATE_DESCRIPTION,
  MAX_TEMPLATE_LABEL,
  SLIDE_TEMPLATE_FORMAT,
  SLIDE_TEMPLATE_VERSION,
  buildCustomSlideTemplate,
  customSlideTemplateToDraft,
  duplicateSlideTemplateDraft,
  emptySlideTemplateDraft,
  findCustomSlideTemplate,
  isCustomSlideTemplateId,
  loadCustomSlideTemplates,
  newCustomSlideTemplateId,
  normalizeSlideContent,
  parseCustomSlideTemplateStore,
  parseSlideTemplate,
  parseStoredSlideTemplate,
  removeCustomSlideTemplate,
  saveCustomSlideTemplates,
  serializeCustomSlideTemplateStore,
  serializeSlideTemplate,
  slideTemplateFilename,
  upsertCustomSlideTemplate,
  type CustomSlideTemplate,
  type CustomSlideTemplateDraft,
} from "../customSlideTemplates";
import type { SlideContent } from "../slideEditorTypes";

/** A minimal, fully-valid deck; override fields per-test. */
function deck(overrides: Partial<SlideContent> = {}): SlideContent {
  return {
    slides: [
      {
        id: "slide-1",
        title: "Hello",
        blocks: [{ id: "block-1", type: "text", content: "World" }],
        notes: "",
      },
    ],
    themeId: "editorial",
    aspectRatio: "4:3",
    ...overrides,
  };
}

/** A minimal valid draft; override fields per-test. */
function draft(
  overrides: Partial<CustomSlideTemplateDraft> = {},
): CustomSlideTemplateDraft {
  return {
    label: "Quarterly review",
    description: "",
    category: "",
    content: deck(),
    ...overrides,
  };
}

/** Build a template with a deterministic id so assertions are stable. */
function template(
  overrides: Partial<CustomSlideTemplateDraft> = {},
  id = "fixed",
): CustomSlideTemplate {
  const result = buildCustomSlideTemplate(
    draft(overrides),
    () => `${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}${id}`,
  );
  if (!result.ok) {
    throw new Error(`unexpected build failure: ${result.errors.join(", ")}`);
  }
  return result.template;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("newCustomSlideTemplateId / isCustomSlideTemplateId", () => {
  it("mints custom-namespaced ids that round-trip the guard", () => {
    const id = newCustomSlideTemplateId();
    expect(id.startsWith(CUSTOM_SLIDE_TEMPLATE_ID_PREFIX)).toBe(true);
    expect(isCustomSlideTemplateId(id)).toBe(true);
  });

  it("rejects foreign / absent ids", () => {
    expect(isCustomSlideTemplateId("pitch")).toBe(false);
    expect(isCustomSlideTemplateId("brand-1")).toBe(false);
    expect(isCustomSlideTemplateId(undefined)).toBe(false);
    expect(isCustomSlideTemplateId(null)).toBe(false);
  });
});

describe("normalizeSlideContent", () => {
  it("preserves a valid deck's slides, theme, and aspect ratio", () => {
    const normalized = normalizeSlideContent(deck());
    expect(normalized.slides).toHaveLength(1);
    expect(normalized.slides[0].title).toBe("Hello");
    expect(normalized.themeId).toBe("editorial");
    expect(normalized.aspectRatio).toBe("4:3");
  });

  it("degrades a non-deck value to a clean single-slide default", () => {
    for (const bad of [null, 42, "nope", { slides: "no" }, []]) {
      const normalized = normalizeSlideContent(bad);
      expect(normalized.slides.length).toBeGreaterThanOrEqual(1);
      // Unknown/missing deck-level fields resolve to the catalogue defaults.
      expect(normalized.themeId).toBe("aurora");
      expect(normalized.aspectRatio).toBe("16:9");
    }
  });

  it("degrades an unknown theme id to the default", () => {
    const normalized = normalizeSlideContent(deck({ themeId: "not-a-theme" }));
    expect(normalized.themeId).toBe("aurora");
  });

  it("carries marp state when enabled, sourced, or themed", () => {
    expect(normalizeSlideContent(deck()).marp).toBeUndefined();
    const withMarp = normalizeSlideContent(
      deck({ marp: { enabled: true, source: "# Hi", theme: "default" } }),
    );
    expect(withMarp.marp?.enabled).toBe(true);
    expect(withMarp.marp?.source).toBe("# Hi");
  });

  it("preserves a dormant marp theme so the deck round-trips faithfully", () => {
    // Marp off + empty source but a non-default theme chosen earlier: the
    // editor persists this, so capturing the deck as a template must keep it.
    const normalized = normalizeSlideContent(
      deck({ marp: { enabled: false, source: "", theme: "gaia" } }),
    );
    expect(normalized.marp?.enabled).toBe(false);
    expect(normalized.marp?.source).toBe("");
    expect(normalized.marp?.theme).toBe("gaia");
  });

  it("preserves a brand-namespaced kit id and drops a foreign one", () => {
    expect(
      normalizeSlideContent(deck({ brandKitId: "brand-abc" })).brandKitId,
    ).toBe("brand-abc");
    expect(
      normalizeSlideContent(deck({ brandKitId: "garbage" })).brandKitId,
    ).toBeUndefined();
  });
});

describe("buildCustomSlideTemplate", () => {
  it("builds a valid template, minting a custom id", () => {
    const result = buildCustomSlideTemplate(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isCustomSlideTemplateId(result.template.id)).toBe(true);
    expect(result.template.label).toBe("Quarterly review");
    expect(result.template.content.themeId).toBe("editorial");
  });

  it("rejects an empty / whitespace-only name", () => {
    for (const label of ["", "   ", "\t\n"]) {
      const result = buildCustomSlideTemplate(draft({ label }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toContain("Give the template a name.");
    }
  });

  it("collapses whitespace and length-bounds the label + description", () => {
    const result = buildCustomSlideTemplate(
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
    const result = buildCustomSlideTemplate(
      draft({ description: "   ", category: "Nonsense" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.description).toBeUndefined();
    expect(result.template.category).toBeUndefined();
  });

  it("keeps a known category", () => {
    const result = buildCustomSlideTemplate(draft({ category: "Sales" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.category).toBe("Sales");
  });

  it("edits in place when the draft carries a custom-namespaced id", () => {
    const id = `${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}keep-me`;
    const result = buildCustomSlideTemplate(draft({ id }), () => "tpl-other");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.id).toBe(id);
  });

  it("mints a fresh id when the draft id is foreign (non-destructive)", () => {
    const result = buildCustomSlideTemplate(
      draft({ id: "pitch" }),
      () => `${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}fresh`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.template.id).toBe(`${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}fresh`);
  });
});

describe("draft helpers", () => {
  it("emptySlideTemplateDraft seeds a blank draft around a deck", () => {
    const d = emptySlideTemplateDraft(deck());
    expect(d).toEqual({
      label: "",
      description: "",
      category: "",
      content: deck(),
    });
  });

  it("customSlideTemplateToDraft keeps the id for in-place editing", () => {
    const t = template({ description: "d", category: "Sales" });
    const d = customSlideTemplateToDraft(t);
    expect(d.id).toBe(t.id);
    expect(d.label).toBe(t.label);
    expect(d.description).toBe("d");
    expect(d.category).toBe("Sales");
  });

  it("duplicateSlideTemplateDraft drops the id and suffixes the label", () => {
    const t = template({ label: "Deck" });
    const d = duplicateSlideTemplateDraft(t);
    expect(d.id).toBeUndefined();
    expect(d.label).toBe("Deck (copy)");
  });
});

describe("list ops", () => {
  it("appends a new template and replaces an existing one in place", () => {
    const a = template({ label: "A" }, "a");
    const b = template({ label: "B" }, "b");
    let list = upsertCustomSlideTemplate([], a);
    list = upsertCustomSlideTemplate(list, b);
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);

    const aEdited: CustomSlideTemplate = { ...a, label: "A2" };
    list = upsertCustomSlideTemplate(list, aEdited);
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe("A2");
    expect(list.map((t) => t.id)).toEqual([a.id, b.id]);
  });

  it("caps a new insert at the max by dropping the oldest", () => {
    let list: CustomSlideTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_SLIDE_TEMPLATES + 5; i++) {
      list = upsertCustomSlideTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    expect(list).toHaveLength(MAX_CUSTOM_SLIDE_TEMPLATES);
    // The five oldest were evicted; the newest survives.
    expect(list[0].id).toBe("tpl-t5");
    expect(list[list.length - 1].id).toBe(
      `tpl-t${MAX_CUSTOM_SLIDE_TEMPLATES + 4}`,
    );
  });

  it("a replacement never trips the cap", () => {
    let list: CustomSlideTemplate[] = [];
    for (let i = 0; i < MAX_CUSTOM_SLIDE_TEMPLATES; i++) {
      list = upsertCustomSlideTemplate(
        list,
        template({ label: `T${i}` }, `t${i}`),
      );
    }
    const edited: CustomSlideTemplate = { ...list[0], label: "edited" };
    const next = upsertCustomSlideTemplate(list, edited);
    expect(next).toHaveLength(MAX_CUSTOM_SLIDE_TEMPLATES);
    expect(next[0].label).toBe("edited");
  });

  it("removes by id and finds null-safely", () => {
    const a = template({ label: "A" }, "a");
    const b = template({ label: "B" }, "b");
    const list = [a, b];
    expect(removeCustomSlideTemplate(list, a.id).map((t) => t.id)).toEqual([
      b.id,
    ]);
    expect(removeCustomSlideTemplate(list, "tpl-missing")).toHaveLength(2);
    expect(findCustomSlideTemplate(list, b.id)?.id).toBe(b.id);
    expect(findCustomSlideTemplate(list, "tpl-missing")).toBeNull();
    expect(findCustomSlideTemplate(list, undefined)).toBeNull();
  });
});

describe("store round-trip + defensive parse", () => {
  it("serialize → parse preserves the list", () => {
    const list = [template({ label: "A" }, "a"), template({ label: "B" }, "b")];
    const parsed = parseCustomSlideTemplateStore(
      serializeCustomSlideTemplateStore(list),
    );
    expect(parsed?.map((t) => t.id)).toEqual([list[0].id, list[1].id]);
  });

  it("returns null for absent / bad JSON / wrong version / non-array", () => {
    expect(parseCustomSlideTemplateStore(null)).toBeNull();
    expect(parseCustomSlideTemplateStore("not json{")).toBeNull();
    expect(
      parseCustomSlideTemplateStore(
        JSON.stringify({ version: 999, templates: [] }),
      ),
    ).toBeNull();
    expect(
      parseCustomSlideTemplateStore(
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
        { id: "pitch", label: "foreign id" }, // not tpl- namespaced
        { id: "tpl-x" }, // missing label
        42, // not an object
        good, // duplicate id
      ],
    });
    const parsed = parseCustomSlideTemplateStore(raw);
    expect(parsed?.map((t) => t.id)).toEqual([good.id]);
  });

  it("caps the parsed list at the max", () => {
    const templates = Array.from(
      { length: MAX_CUSTOM_SLIDE_TEMPLATES + 10 },
      (_, i) => template({ label: `T${i}` }, `t${i}`),
    );
    const parsed = parseCustomSlideTemplateStore(
      JSON.stringify({ version: 1, templates }),
    );
    expect(parsed).toHaveLength(MAX_CUSTOM_SLIDE_TEMPLATES);
  });

  it("parseStoredSlideTemplate rejects a foreign id", () => {
    expect(parseStoredSlideTemplate({ id: "pitch", label: "x" })).toBeNull();
    expect(parseStoredSlideTemplate(null)).toBeNull();
  });

  it("load / save go through localStorage and never throw", () => {
    expect(loadCustomSlideTemplates()).toEqual([]);
    const list = [template({ label: "A" }, "a")];
    saveCustomSlideTemplates(list);
    // The store envelope is versioned JSON (distinct from the portable
    // file's `{ format, version, template }`); it round-trips through
    // localStorage under the namespaced key.
    const raw = window.localStorage.getItem(CUSTOM_SLIDE_TEMPLATES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toMatchObject({ version: 1 });
    expect(loadCustomSlideTemplates().map((t) => t.id)).toEqual([list[0].id]);
  });
});

describe("portable template file", () => {
  it("filename is a slugged tessera-slide-template-*.json", () => {
    expect(slideTemplateFilename(template({ label: "Q3 Review!" }))).toBe(
      "tessera-slide-template-q3-review.json",
    );
    expect(slideTemplateFilename(template({ label: "***" }))).toBe(
      "tessera-slide-template-template.json",
    );
  });

  it("serialize wraps the distinct {format,version,template} envelope", () => {
    const t = template({ label: "Deck" });
    const parsed: unknown = JSON.parse(serializeSlideTemplate(t));
    expect(parsed).toMatchObject({
      format: SLIDE_TEMPLATE_FORMAT,
      version: SLIDE_TEMPLATE_VERSION,
    });
  });

  it("export does not mutate the source template", () => {
    const t = template({ label: "Deck", description: "d", category: "Sales" });
    const snapshot = JSON.stringify(t);
    serializeSlideTemplate(t);
    expect(JSON.stringify(t)).toBe(snapshot);
  });

  it("round-trips serialize → import, dropping the id (non-destructive)", () => {
    const t = template({ label: "Shareable", category: "Sales" });
    const result = parseSlideTemplate(serializeSlideTemplate(t));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Import never keeps the id — a fresh one is minted on save.
    expect(result.draft.id).toBeUndefined();
    expect(result.draft.label).toBe("Shareable");
    expect(result.draft.category).toBe("Sales");
    expect(result.draft.content.themeId).toBe("editorial");

    const rebuilt = buildCustomSlideTemplate(result.draft);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect(rebuilt.template.id).not.toBe(t.id);
  });

  it("rejects invalid JSON", () => {
    const result = parseSlideTemplate("not json{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/i);
  });

  it("rejects a file without the slide-template format tag", () => {
    // The store envelope ({version, templates}) has no `format`.
    const result = parseSlideTemplate(serializeCustomSlideTemplateStore([]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Tessera slide template file/i);
  });

  it("rejects a version newer than this build", () => {
    const blob = JSON.stringify({
      format: SLIDE_TEMPLATE_FORMAT,
      version: SLIDE_TEMPLATE_VERSION + 1,
      template: template({ label: "Future" }),
    });
    const result = parseSlideTemplate(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
  });

  it("rejects a below-first / non-integer / non-finite version as malformed", () => {
    for (const version of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const blob = JSON.stringify({
        format: SLIDE_TEMPLATE_FORMAT,
        version,
        template: template({ label: "X" }),
      });
      const result = parseSlideTemplate(blob);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/valid Tessera slide template file/i);
      expect(result.error).not.toMatch(/newer version/i);
    }
  });

  it("rejects a non-numeric version", () => {
    const blob = JSON.stringify({
      format: SLIDE_TEMPLATE_FORMAT,
      version: "1",
      template: template({ label: "X" }),
    });
    expect(parseSlideTemplate(blob).ok).toBe(false);
  });

  it("rejects a file that contains no template", () => {
    const blob = JSON.stringify({
      format: SLIDE_TEMPLATE_FORMAT,
      version: SLIDE_TEMPLATE_VERSION,
      template: 123,
    });
    const result = parseSlideTemplate(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/doesn’t contain a slide template/i);
  });

  it("imports a hand-written file with no deck, degrading the content", () => {
    const blob = JSON.stringify({
      format: SLIDE_TEMPLATE_FORMAT,
      version: SLIDE_TEMPLATE_VERSION,
      template: { label: "Bare" },
    });
    const result = parseSlideTemplate(blob);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.label).toBe("Bare");
    expect(result.draft.content.slides.length).toBeGreaterThanOrEqual(1);
  });
});
