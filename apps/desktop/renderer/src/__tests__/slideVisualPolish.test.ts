import { describe, expect, it } from "vitest";
import {
  SLIDE_LAYOUTS,
  getSlideLayout,
  isKnownSlideLayout,
  resolveSlideLayout,
} from "../editors/slideLayouts";
import {
  INSERT_CARD_PRESETS,
  getInsertCardPreset,
} from "../editors/slideTemplates";
import {
  parseSlideContent,
  resolveAspectRatio,
  DEFAULT_ASPECT_RATIO,
  buildSlideFromLayout,
  buildSlideFromPreset,
  duplicateSlideAt,
} from "../editors/slideEditorHelpers";
import {
  SLIDE_BG_STYLES,
  isKnownSlideBgStyle,
  type SlideBgStyle,
} from "../editors/slideThemes";
import type {
  Slide,
  SlideContent,
  SlideLayout,
  SlideAspectRatio,
} from "../editors/slideEditorTypes";

// The five smart layouts S6 adds on top of the original ten. These ids
// are stable and must round-trip through every layout helper.
const NEW_LAYOUTS = [
  "timeline",
  "process",
  "comparison",
  "gallery",
  "metricRow",
] as const satisfies readonly SlideLayout[];

// Insert-card presets that surface the new layouts in the "+ insert"
// menu. `comparison` (the original two-column preset id) is intentionally
// left untouched; the new comparison layout ships as `comparison-split`.
const NEW_PRESET_IDS: readonly string[] = [
  "timeline-card",
  "process-card",
  "comparison-split",
  "gallery-card",
  "metric-row",
];

// ---------------------------------------------------------------------------
// New smart layouts
// ---------------------------------------------------------------------------

describe("smart layouts (S6)", () => {
  it("registers every new layout id in the catalogue", () => {
    const ids = new Set(SLIDE_LAYOUTS.map((l) => l.id));
    for (const id of NEW_LAYOUTS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("is known to isKnownSlideLayout", () => {
    for (const id of NEW_LAYOUTS) {
      expect(isKnownSlideLayout(id)).toBe(true);
    }
  });

  it("resolves through getSlideLayout to a def with the same id", () => {
    for (const id of NEW_LAYOUTS) {
      expect(getSlideLayout(id).id).toBe(id);
    }
  });

  it("carries a polished marpClass and lucide iconName", () => {
    for (const id of NEW_LAYOUTS) {
      const def = getSlideLayout(id);
      expect(def.marpClass).toBe(`layout-${id}`);
      expect(def.iconName).toBeTruthy();
      expect(def.glyph).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(def.regions.length).toBeGreaterThan(0);
    }
  });

  it("keeps the whole catalogue id-unique after the additions", () => {
    const ids = SLIDE_LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("treats a persisted new layout as authoritative in resolveSlideLayout", () => {
    for (const id of NEW_LAYOUTS) {
      const slide: Slide = {
        id: "s1",
        title: "T",
        blocks: [{ id: "b1", type: "text", content: "" }],
        notes: "",
        layout: id,
      };
      expect(resolveSlideLayout(slide)).toBe(id);
    }
  });
});

// ---------------------------------------------------------------------------
// buildSlideFromLayout — block scaffolding for the new layouts
// ---------------------------------------------------------------------------

describe("buildSlideFromLayout (S6 layouts)", () => {
  it("produces a slide that keeps its layout and has fresh, unique block ids", () => {
    for (const id of NEW_LAYOUTS) {
      const slide = buildSlideFromLayout(id);
      expect(slide.id).toBeTruthy();
      expect(slide.layout).toBe(id);
      expect(slide.blocks.length).toBeGreaterThan(0);
      const blockIds = slide.blocks.map((b) => b.id);
      expect(blockIds.every((bid) => bid.length > 0)).toBe(true);
      expect(new Set(blockIds).size).toBe(blockIds.length);
    }
  });

  it("gives image blocks an explicit empty alt and omits it on text blocks", () => {
    for (const id of NEW_LAYOUTS) {
      for (const block of buildSlideFromLayout(id).blocks) {
        if (block.type === "image") {
          expect(block.alt).toBe("");
        } else {
          expect(block.alt).toBeUndefined();
        }
      }
    }
  });

  it("scaffolds the expected slots per layout", () => {
    const expected: Record<
      (typeof NEW_LAYOUTS)[number],
      { count: number; type: "text" | "image"; slots: string[] }
    > = {
      timeline: { count: 3, type: "text", slots: ["event", "event", "event"] },
      process: { count: 3, type: "text", slots: ["step", "step", "step"] },
      comparison: { count: 2, type: "text", slots: ["left", "right"] },
      gallery: {
        count: 3,
        type: "image",
        slots: ["image", "image", "image"],
      },
      metricRow: {
        count: 3,
        type: "text",
        slots: ["metric", "metric", "metric"],
      },
    };
    for (const id of NEW_LAYOUTS) {
      const slide = buildSlideFromLayout(id);
      const spec = expected[id];
      expect(slide.blocks.length).toBe(spec.count);
      expect(slide.blocks.map((b) => b.slot)).toEqual(spec.slots);
      expect(slide.blocks.every((b) => b.type === spec.type)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// New insert-card presets
// ---------------------------------------------------------------------------

describe("smart-layout insert presets (S6)", () => {
  it("registers every new preset id", () => {
    const ids = new Set(INSERT_CARD_PRESETS.map((p) => p.id));
    for (const id of NEW_PRESET_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("does not clobber the original `comparison` preset id", () => {
    expect(getInsertCardPreset("comparison")).toBeDefined();
    expect(getInsertCardPreset("comparison-split")).toBeDefined();
  });

  it("targets a known smart layout and materialises cleanly", () => {
    for (const id of NEW_PRESET_IDS) {
      const preset = getInsertCardPreset(id);
      expect(preset).toBeDefined();
      if (!preset) continue;
      expect(isKnownSlideLayout(preset.layout)).toBe(true);
      const slide = buildSlideFromPreset(preset);
      expect(slide.layout).toBe(preset.layout);
      expect(slide.blocks.length).toBe(preset.blocks.length);
      for (const block of slide.blocks) {
        expect(block.id).toBeTruthy();
        if (block.type === "image") {
          expect(block.alt).toBe("");
        } else {
          expect(block.alt).toBeUndefined();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Aspect ratio
// ---------------------------------------------------------------------------

describe("aspect ratio resolution", () => {
  it("defaults to the legacy 16:9", () => {
    expect(DEFAULT_ASPECT_RATIO).toBe("16:9");
  });

  it("passes known ratios through unchanged", () => {
    const known: SlideAspectRatio[] = ["16:9", "4:3", "1:1"];
    for (const ratio of known) {
      expect(resolveAspectRatio(ratio)).toBe(ratio);
    }
  });

  it("coerces unknown / nullish ratios to the default", () => {
    expect(resolveAspectRatio("21:9")).toBe(DEFAULT_ASPECT_RATIO);
    expect(resolveAspectRatio("")).toBe(DEFAULT_ASPECT_RATIO);
    expect(resolveAspectRatio(null)).toBe(DEFAULT_ASPECT_RATIO);
    expect(resolveAspectRatio(undefined)).toBe(DEFAULT_ASPECT_RATIO);
  });
});

describe("parseSlideContent aspectRatio handling", () => {
  it("round-trips a persisted, known aspect ratio", () => {
    const content: SlideContent = {
      slides: [{ id: "s1", title: "A", blocks: [], notes: "" }],
      aspectRatio: "1:1",
    };
    expect(parseSlideContent(JSON.stringify(content)).aspectRatio).toBe("1:1");
  });

  it("defaults a legacy deck without an aspect ratio to 16:9", () => {
    const legacy = {
      slides: [{ id: "s1", title: "A", blocks: [], notes: "" }],
    };
    expect(parseSlideContent(JSON.stringify(legacy)).aspectRatio).toBe(
      DEFAULT_ASPECT_RATIO,
    );
  });

  it("coerces a hand-edited unknown aspect ratio to the default", () => {
    const content = {
      slides: [{ id: "s1", title: "A", blocks: [], notes: "" }],
      aspectRatio: "totally-made-up",
    };
    expect(parseSlideContent(JSON.stringify(content)).aspectRatio).toBe(
      DEFAULT_ASPECT_RATIO,
    );
  });

  it("defaults the empty / unparseable cases to 16:9", () => {
    expect(parseSlideContent("").aspectRatio).toBe(DEFAULT_ASPECT_RATIO);
    expect(parseSlideContent("not json at all").aspectRatio).toBe(
      DEFAULT_ASPECT_RATIO,
    );
  });
});

// ---------------------------------------------------------------------------
// Per-slide background
// ---------------------------------------------------------------------------

describe("per-slide background style guard", () => {
  it("exposes a non-empty, self-consistent catalogue", () => {
    expect(SLIDE_BG_STYLES.length).toBeGreaterThan(0);
    for (const style of SLIDE_BG_STYLES) {
      expect(isKnownSlideBgStyle(style)).toBe(true);
    }
  });

  it("rejects unknown / nullish values", () => {
    expect(isKnownSlideBgStyle("plaid")).toBe(false);
    expect(isKnownSlideBgStyle("")).toBe(false);
    expect(isKnownSlideBgStyle(null)).toBe(false);
    expect(isKnownSlideBgStyle(undefined)).toBe(false);
  });
});

describe("parseSlideContent per-slide background handling", () => {
  it("preserves a persisted per-slide background override", () => {
    const background: SlideBgStyle = "gradient";
    const content: SlideContent = {
      slides: [
        {
          id: "s1",
          title: "A",
          blocks: [{ id: "b1", type: "text", content: "" }],
          notes: "",
          background,
        },
      ],
    };
    const parsed = parseSlideContent(JSON.stringify(content));
    expect(parsed.slides[0].background).toBe(background);
  });

  it("leaves a legacy slide without an override undefined (inherits the deck)", () => {
    const legacy = {
      slides: [
        {
          id: "s1",
          title: "A",
          blocks: [{ id: "b1", type: "text", content: "" }],
          notes: "",
        },
      ],
    };
    const parsed = parseSlideContent(JSON.stringify(legacy));
    expect(parsed.slides[0].background).toBeUndefined();
  });
});

describe("duplicateSlideAt background propagation", () => {
  const baseSlide = (background?: SlideBgStyle): Slide => ({
    id: "s1",
    title: "Original",
    blocks: [{ id: "b1", type: "text", content: "hello" }],
    notes: "",
    layout: "titleContent",
    ...(background ? { background } : {}),
  });

  it("copies an explicit background onto the duplicate", () => {
    const { slides, insertedAt } = duplicateSlideAt([baseSlide("dots")], 0);
    expect(insertedAt).toBe(1);
    expect(slides[insertedAt].background).toBe("dots");
    // The clone is a real copy with its own id.
    expect(slides[insertedAt].id).not.toBe(slides[0].id);
  });

  it("does not add a background key when the original has none", () => {
    const { slides, insertedAt } = duplicateSlideAt([baseSlide()], 0);
    expect(insertedAt).toBe(1);
    expect(slides[insertedAt].background).toBeUndefined();
    expect("background" in slides[insertedAt]).toBe(false);
  });
});
