import { describe, expect, it } from "vitest";
import {
  SLIDE_TEMPLATES,
  INSERT_CARD_PRESETS,
  getSlideTemplate,
  getInsertCardPreset,
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
});
