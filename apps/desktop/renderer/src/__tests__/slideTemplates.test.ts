import { describe, expect, it } from "vitest";
import {
  SLIDE_TEMPLATES,
  INSERT_CARD_PRESETS,
  TEMPLATE_CATEGORIES,
  ALL_TEMPLATES_CATEGORY,
  getSlideTemplate,
  getInsertCardPreset,
  filterSlideTemplates,
  type TemplateCategory,
} from "../editors/slideTemplates";
import { isKnownSlideLayout } from "../editors/slideLayouts";
import { isKnownSlideThemeId } from "../editors/slideThemes";
import {
  buildDeckFromTemplate,
  buildSlideFromPreset,
} from "../editors/slideEditorHelpers";

// ---------------------------------------------------------------------------
// Template catalogue
// ---------------------------------------------------------------------------

describe("SLIDE_TEMPLATES catalogue", () => {
  it("exposes a non-empty, id-unique catalogue", () => {
    expect(SLIDE_TEMPLATES.length).toBeGreaterThan(0);
    const ids = SLIDE_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every template has at least one slide", () => {
    for (const template of SLIDE_TEMPLATES) {
      expect(template.slides.length).toBeGreaterThan(0);
    }
  });

  it("every template slide uses a known layout", () => {
    for (const template of SLIDE_TEMPLATES) {
      for (const slide of template.slides) {
        expect(isKnownSlideLayout(slide.layout)).toBe(true);
      }
    }
  });

  it("every template has required metadata fields", () => {
    for (const template of SLIDE_TEMPLATES) {
      expect(template.id).toBeTruthy();
      expect(template.label).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.icon).toBeTruthy();
    }
  });

  it("suggested themes reference known theme ids", () => {
    for (const template of SLIDE_TEMPLATES) {
      if (template.suggestedTheme) {
        expect(isKnownSlideThemeId(template.suggestedTheme)).toBe(true);
      }
    }
  });
});

describe("getSlideTemplate", () => {
  it("returns the matching template for a known id", () => {
    const template = SLIDE_TEMPLATES[0];
    expect(getSlideTemplate(template.id)).toEqual(template);
  });

  it("returns undefined for unknown / nullish ids", () => {
    expect(getSlideTemplate("nonexistent")).toBeUndefined();
    expect(getSlideTemplate(null)).toBeUndefined();
    expect(getSlideTemplate(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Taxonomy + catalogue breadth
// ---------------------------------------------------------------------------

describe("template taxonomy", () => {
  it("exposes the 11 Gamma-style categories", () => {
    expect(TEMPLATE_CATEGORIES).toEqual([
      "Company",
      "Consulting",
      "Creative",
      "Education",
      "Fundraising",
      "Marketing",
      "People",
      "Project Management",
      "Reporting",
      "Sales",
      "Strategy",
    ]);
  });

  it('"All" is distinct from every real category', () => {
    expect(TEMPLATE_CATEGORIES).not.toContain(ALL_TEMPLATES_CATEGORY);
  });

  it("every template is tagged with a known category", () => {
    const known = new Set<string>(TEMPLATE_CATEGORIES);
    for (const template of SLIDE_TEMPLATES) {
      const category = template.category;
      expect(category).toBeDefined();
      expect(category !== undefined && known.has(category)).toBe(true);
    }
  });

  it("grows the catalogue to a professional breadth (>= 24)", () => {
    expect(SLIDE_TEMPLATES.length).toBeGreaterThanOrEqual(24);
  });

  it("offers at least two templates in every category", () => {
    const counts = new Map<TemplateCategory, number>();
    for (const template of SLIDE_TEMPLATES) {
      if (template.category) {
        counts.set(template.category, (counts.get(template.category) ?? 0) + 1);
      }
    }
    for (const category of TEMPLATE_CATEGORIES) {
      expect(counts.get(category) ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the six original template ids working", () => {
    for (const id of [
      "pitch",
      "status-report",
      "workshop",
      "project-proposal",
      "retrospective",
      "case-study",
    ]) {
      expect(getSlideTemplate(id)).toBeDefined();
    }
  });

  it("materialises every catalogue template into a real deck", () => {
    for (const template of SLIDE_TEMPLATES) {
      const slides = buildDeckFromTemplate(template);
      expect(slides.length).toBe(template.slides.length);
      expect(slides.length).toBeGreaterThan(0);
      for (const slide of slides) {
        expect(slide.id).toBeTruthy();
        expect(isKnownSlideLayout(slide.layout)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Gallery filtering: filterSlideTemplates
// ---------------------------------------------------------------------------

describe("filterSlideTemplates", () => {
  it('"All" + empty query returns the whole catalogue', () => {
    const result = filterSlideTemplates(
      SLIDE_TEMPLATES,
      ALL_TEMPLATES_CATEGORY,
      "",
    );
    expect(result).toEqual([...SLIDE_TEMPLATES]);
  });

  it("filters down to a single category", () => {
    const result = filterSlideTemplates(SLIDE_TEMPLATES, "Fundraising", "");
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t) => t.category === "Fundraising")).toBe(true);
  });

  it("matches by label, case-insensitively", () => {
    const result = filterSlideTemplates(
      SLIDE_TEMPLATES,
      ALL_TEMPLATES_CATEGORY,
      "PITCH",
    );
    expect(result.some((t) => t.id === "pitch")).toBe(true);
  });

  it("matches by description text", () => {
    const target = SLIDE_TEMPLATES[0];
    const word = target.description.split(/\s+/)[0];
    const result = filterSlideTemplates(
      SLIDE_TEMPLATES,
      ALL_TEMPLATES_CATEGORY,
      word,
    );
    expect(result.some((t) => t.id === target.id)).toBe(true);
  });

  it("matches by category name in free-text search", () => {
    const result = filterSlideTemplates(
      SLIDE_TEMPLATES,
      ALL_TEMPLATES_CATEGORY,
      "consulting",
    );
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((t) => t.category === "Consulting")).toBe(true);
  });

  it("intersects category + query", () => {
    const all = filterSlideTemplates(SLIDE_TEMPLATES, "Strategy", "");
    const narrowed = filterSlideTemplates(
      SLIDE_TEMPLATES,
      "Strategy",
      all[0].label,
    );
    expect(narrowed.length).toBeLessThanOrEqual(all.length);
    expect(narrowed.every((t) => t.category === "Strategy")).toBe(true);
  });

  it("treats a whitespace-only query as no query", () => {
    const result = filterSlideTemplates(
      SLIDE_TEMPLATES,
      ALL_TEMPLATES_CATEGORY,
      "   ",
    );
    expect(result).toEqual([...SLIDE_TEMPLATES]);
  });

  it("returns an empty list when nothing matches", () => {
    const result = filterSlideTemplates(
      SLIDE_TEMPLATES,
      ALL_TEMPLATES_CATEGORY,
      "zzz-no-such-template-zzz",
    );
    expect(result).toEqual([]);
  });

  it("does not mutate the source catalogue", () => {
    const before = SLIDE_TEMPLATES.length;
    filterSlideTemplates(SLIDE_TEMPLATES, "Sales", "deck");
    expect(SLIDE_TEMPLATES.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Insert-card presets
// ---------------------------------------------------------------------------

describe("INSERT_CARD_PRESETS catalogue", () => {
  it("exposes a non-empty, id-unique catalogue", () => {
    expect(INSERT_CARD_PRESETS.length).toBeGreaterThan(0);
    const ids = INSERT_CARD_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset uses a known layout", () => {
    for (const preset of INSERT_CARD_PRESETS) {
      expect(isKnownSlideLayout(preset.layout)).toBe(true);
    }
  });

  it("every preset has required metadata fields", () => {
    for (const preset of INSERT_CARD_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.label).toBeTruthy();
      expect(preset.description).toBeTruthy();
      expect(preset.icon).toBeTruthy();
    }
  });
});

describe("getInsertCardPreset", () => {
  it("returns the matching preset for a known id", () => {
    const preset = INSERT_CARD_PRESETS[0];
    expect(getInsertCardPreset(preset.id)).toEqual(preset);
  });

  it("returns undefined for unknown / nullish ids", () => {
    expect(getInsertCardPreset("nonexistent")).toBeUndefined();
    expect(getInsertCardPreset(null)).toBeUndefined();
    expect(getInsertCardPreset(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Materialisation: buildDeckFromTemplate + buildSlideFromPreset
// ---------------------------------------------------------------------------

describe("buildDeckFromTemplate", () => {
  it("materialises a template into real slides with fresh ids", () => {
    const template = SLIDE_TEMPLATES[0]; // pitch
    const slides = buildDeckFromTemplate(template);
    expect(slides.length).toBe(template.slides.length);

    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i];
      const blueprint = template.slides[i];
      expect(slide.id).toBeTruthy();
      expect(slide.title).toBe(blueprint.title);
      expect(slide.layout).toBe(blueprint.layout);
      expect(slide.blocks.length).toBe(blueprint.blocks.length);

      for (let j = 0; j < slide.blocks.length; j++) {
        const block = slide.blocks[j];
        expect(block.id).toBeTruthy();
        expect(block.type).toBe(blueprint.blocks[j].type);
        expect(block.content).toBe(blueprint.blocks[j].content);
        if (blueprint.blocks[j].slot) {
          expect(block.slot).toBe(blueprint.blocks[j].slot);
        }
      }
    }
  });

  it("generates unique slide ids (no collisions)", () => {
    const slides = buildDeckFromTemplate(SLIDE_TEMPLATES[0]);
    const ids = slides.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("generates unique block ids across all slides", () => {
    const slides = buildDeckFromTemplate(SLIDE_TEMPLATES[0]);
    const blockIds = slides.flatMap((s) => s.blocks.map((b) => b.id));
    expect(new Set(blockIds).size).toBe(blockIds.length);
  });

  it("preserves speaker notes from template blueprints", () => {
    const template = SLIDE_TEMPLATES[0]; // pitch — has notes on first slide
    const slides = buildDeckFromTemplate(template);
    const first = slides[0];
    expect(first.notes).toBe(template.slides[0].notes ?? "");
  });
});

describe("buildSlideFromPreset", () => {
  it("materialises a preset into a real slide with fresh id", () => {
    const preset = INSERT_CARD_PRESETS[0]; // stat-card
    const slide = buildSlideFromPreset(preset);
    expect(slide.id).toBeTruthy();
    expect(slide.title).toBe(preset.title);
    expect(slide.layout).toBe(preset.layout);
    expect(slide.blocks.length).toBe(preset.blocks.length);

    for (let i = 0; i < slide.blocks.length; i++) {
      const block = slide.blocks[i];
      expect(block.id).toBeTruthy();
      expect(block.type).toBe(preset.blocks[i].type);
      expect(block.content).toBe(preset.blocks[i].content);
    }
  });

  it("creates unique block ids within the slide", () => {
    const preset = INSERT_CARD_PRESETS[0];
    const slide = buildSlideFromPreset(preset);
    const blockIds = slide.blocks.map((b) => b.id);
    expect(new Set(blockIds).size).toBe(blockIds.length);
  });

  it("works for every preset in the catalogue", () => {
    for (const preset of INSERT_CARD_PRESETS) {
      const slide = buildSlideFromPreset(preset);
      expect(slide.layout).toBe(preset.layout);
      expect(slide.blocks.length).toBe(preset.blocks.length);
    }
  });

  it("gives image blocks an explicit empty alt and omits it elsewhere", () => {
    for (const preset of INSERT_CARD_PRESETS) {
      const slide = buildSlideFromPreset(preset);
      for (const block of slide.blocks) {
        if (block.type === "image") {
          expect(block.alt).toBe("");
        } else {
          expect(block.alt).toBeUndefined();
        }
      }
    }
  });

  it("template image blocks also carry an explicit empty alt", () => {
    for (const template of SLIDE_TEMPLATES) {
      for (const slide of buildDeckFromTemplate(template)) {
        for (const block of slide.blocks) {
          if (block.type === "image") {
            expect(block.alt).toBe("");
          } else {
            expect(block.alt).toBeUndefined();
          }
        }
      }
    }
  });
});
