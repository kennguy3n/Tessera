/**
 * Unit tests for slideLayouts.ts — layout catalogue, validation,
 * inference, and resolution.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLIDE_LAYOUT,
  SLIDE_LAYOUTS,
  getSlideLayout,
  inferLayoutFromBlocks,
  isKnownSlideLayout,
  resolveSlideLayout,
} from "../editors/slideLayouts";
import type { Slide, SlideLayout } from "../editors/slideEditorTypes";

function slide(
  title: string,
  blocks: Array<{ type: string; content: string; slot?: string }>,
  layout?: SlideLayout,
): Slide {
  return {
    id: "test-s",
    title,
    blocks: blocks.map((b, i) => ({
      id: `test-b-${i}`,
      type: b.type as Slide["blocks"][0]["type"],
      content: b.content,
      slot: b.slot,
    })),
    notes: "",
    layout,
  };
}

describe("SLIDE_LAYOUTS catalogue", () => {
  it("contains at least 9 curated layouts", () => {
    expect(SLIDE_LAYOUTS.length).toBeGreaterThanOrEqual(9);
  });

  it("has unique ids", () => {
    const ids = SLIDE_LAYOUTS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes titleContent as the default", () => {
    expect(DEFAULT_SLIDE_LAYOUT).toBe("titleContent");
    expect(SLIDE_LAYOUTS[0].id).toBe("titleContent");
  });

  it("every layout has a non-empty label, description, glyph, and marpClass", () => {
    for (const l of SLIDE_LAYOUTS) {
      expect(l.label).toBeTruthy();
      expect(l.description).toBeTruthy();
      expect(l.glyph).toBeTruthy();
      expect(l.marpClass).toMatch(/^layout-/);
    }
  });
});

describe("isKnownSlideLayout", () => {
  it("returns true for every catalogue id", () => {
    for (const l of SLIDE_LAYOUTS) {
      expect(isKnownSlideLayout(l.id)).toBe(true);
    }
  });

  it("returns false for unknown / null / undefined", () => {
    expect(isKnownSlideLayout("nope")).toBe(false);
    expect(isKnownSlideLayout(null)).toBe(false);
    expect(isKnownSlideLayout(undefined)).toBe(false);
    expect(isKnownSlideLayout("")).toBe(false);
  });
});

describe("getSlideLayout", () => {
  it("resolves known ids", () => {
    const tc = getSlideLayout("titleContent");
    expect(tc.id).toBe("titleContent");
    const q = getSlideLayout("quote");
    expect(q.id).toBe("quote");
  });

  it("falls back to the default for unknown / null / undefined", () => {
    expect(getSlideLayout("bogus").id).toBe(DEFAULT_SLIDE_LAYOUT);
    expect(getSlideLayout(null).id).toBe(DEFAULT_SLIDE_LAYOUT);
    expect(getSlideLayout(undefined).id).toBe(DEFAULT_SLIDE_LAYOUT);
  });
});

describe("inferLayoutFromBlocks", () => {
  it("infers 'title' for slides with no blocks", () => {
    expect(inferLayoutFromBlocks(slide("Hello", []))).toBe("title");
  });

  it("infers 'imageCaption' for a single image block", () => {
    expect(
      inferLayoutFromBlocks(
        slide("Photo", [{ type: "image", content: "data:image/png;..." }]),
      ),
    ).toBe("imageCaption");
  });

  it("infers 'imageLeft' when image is first + text second", () => {
    expect(
      inferLayoutFromBlocks(
        slide("Pic", [
          { type: "image", content: "img" },
          { type: "text", content: "caption" },
        ]),
      ),
    ).toBe("imageLeft");
  });

  it("infers 'imageRight' when text is first + image second", () => {
    expect(
      inferLayoutFromBlocks(
        slide("Pic", [
          { type: "text", content: "caption" },
          { type: "image", content: "img" },
        ]),
      ),
    ).toBe("imageRight");
  });

  it("infers 'twoColumn' for two text blocks", () => {
    expect(
      inferLayoutFromBlocks(
        slide("Compare", [
          { type: "text", content: "left" },
          { type: "text", content: "right" },
        ]),
      ),
    ).toBe("twoColumn");
  });

  it("infers 'bigNumber' for a single short numeric text", () => {
    expect(
      inferLayoutFromBlocks(slide("Stat", [{ type: "text", content: "42%" }])),
    ).toBe("bigNumber");
  });

  it("infers 'titleContent' for one text block with content", () => {
    expect(
      inferLayoutFromBlocks(
        slide("Topic", [
          { type: "text", content: "A paragraph of text here." },
        ]),
      ),
    ).toBe("titleContent");
  });

  it("infers 'titleContent' for a bullets block", () => {
    expect(
      inferLayoutFromBlocks(
        slide("Items", [{ type: "bullets", content: "a\nb\nc" }]),
      ),
    ).toBe("titleContent");
  });

  it("infers 'titleContent' for empty text block with title", () => {
    expect(
      inferLayoutFromBlocks(
        slide("Title Only", [{ type: "text", content: "" }]),
      ),
    ).toBe("titleContent");
  });
});

describe("resolveSlideLayout", () => {
  it("returns persisted layout when known", () => {
    expect(resolveSlideLayout(slide("X", [], "twoColumn"))).toBe("twoColumn");
    expect(resolveSlideLayout(slide("X", [], "quote"))).toBe("quote");
  });

  it("infers layout when layout is missing", () => {
    expect(resolveSlideLayout(slide("X", []))).toBe("title");
  });

  it("infers layout when layout is unknown", () => {
    expect(resolveSlideLayout(slide("X", [], "bogus" as SlideLayout))).toBe(
      "title",
    );
  });
});
