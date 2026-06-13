import { describe, expect, it } from "vitest";
import {
  MAX_BULLETS_PER_SLIDE,
  MAX_DECK_SLIDES,
  MAX_LINE_LENGTH,
  MIN_DECK_SLIDES,
  applyBulletsToSlide,
  buildDeckPrompt,
  buildImagePromptSuggestion,
  buildNotesPrompt,
  buildRewritePrompt,
  clampDeckSlideCount,
  cleanModelLine,
  outlineToSlides,
  parseBulletResponse,
  parseDeckOutline,
  parseHeadingLine,
  parseImagePromptResponse,
  parseNotesResponse,
  slideToContext,
} from "../editors/slideAiHelpers";
import { buildBlock } from "../editors/slideEditorHelpers";
import type { Slide } from "../editors/slideEditorTypes";

function makeSlide(partial: Partial<Slide>): Slide {
  return {
    id: "slide-test",
    title: "",
    blocks: [],
    notes: "",
    ...partial,
  };
}

describe("clampDeckSlideCount", () => {
  it("clamps into the supported range", () => {
    expect(clampDeckSlideCount(0)).toBe(MIN_DECK_SLIDES);
    expect(clampDeckSlideCount(1000)).toBe(MAX_DECK_SLIDES);
    expect(clampDeckSlideCount(7)).toBe(7);
  });

  it("rounds finite input and collapses non-finite input to the minimum", () => {
    expect(clampDeckSlideCount(5.6)).toBe(6);
    // NaN / ±Infinity collapse to the minimum so a bad <input> value
    // can never escape the bounds into a huge deck.
    expect(clampDeckSlideCount(Number.NaN)).toBe(MIN_DECK_SLIDES);
    expect(clampDeckSlideCount(Infinity)).toBe(MIN_DECK_SLIDES);
  });
});

describe("cleanModelLine", () => {
  it("strips list markers, emphasis, quotes and collapses whitespace", () => {
    expect(cleanModelLine("- hello   world")).toBe("hello world");
    expect(cleanModelLine("**bold**")).toBe("bold");
    expect(cleanModelLine("*ital*")).toBe("ital");
    expect(cleanModelLine("`code`")).toBe("code");
    expect(cleanModelLine('"quoted"')).toBe("quoted");
    expect(cleanModelLine("1. numbered")).toBe("numbered");
  });

  it("returns empty string for blank input", () => {
    expect(cleanModelLine("   ")).toBe("");
  });

  it("caps overly long lines", () => {
    const long = "x".repeat(MAX_LINE_LENGTH + 50);
    expect(cleanModelLine(long).length).toBe(MAX_LINE_LENGTH);
  });
});

describe("parseHeadingLine", () => {
  it("recognises markdown, slide-label and numbered headings", () => {
    expect(parseHeadingLine("## Intro")).toBe("Intro");
    expect(parseHeadingLine("Slide 2: Market")).toBe("Market");
    expect(parseHeadingLine("3) Summary")).toBe("Summary");
  });

  it("returns null for non-heading lines", () => {
    expect(parseHeadingLine("- a bullet")).toBeNull();
    expect(parseHeadingLine("plain text")).toBeNull();
    expect(parseHeadingLine("3.")).toBeNull();
  });
});

describe("parseDeckOutline", () => {
  it("parses title, headings, bullets and notes", () => {
    const raw = [
      "TITLE: Q3 Review",
      "## Overview",
      "- Revenue up 12%",
      "- New markets",
      "NOTES: Open with the headline number.",
      "## Risks",
      "- Supply chain",
    ].join("\n");
    const outline = parseDeckOutline(raw);
    expect(outline.title).toBe("Q3 Review");
    expect(outline.slides).toHaveLength(2);
    expect(outline.slides[0]).toEqual({
      title: "Overview",
      bullets: ["Revenue up 12%", "New markets"],
      notes: "Open with the headline number.",
    });
    expect(outline.slides[1].bullets).toEqual(["Supply chain"]);
  });

  it("strips code fences and ignores preamble before the first heading", () => {
    const raw = [
      "```",
      "Sure! Here is your outline:",
      "## Only Slide",
      "- one",
      "```",
    ].join("\n");
    const outline = parseDeckOutline(raw);
    // The preamble line becomes an untitled slide's bullet (captured,
    // not dropped), then the real heading slide follows.
    const titled = outline.slides.find((s) => s.title === "Only Slide");
    expect(titled).toBeDefined();
    expect(titled?.bullets).toEqual(["one"]);
  });

  it("caps slides and bullets at the configured bounds", () => {
    const lines: string[] = [];
    for (let i = 0; i < MAX_DECK_SLIDES + 10; i++) {
      lines.push(`## Slide ${i}`);
      for (let b = 0; b < MAX_BULLETS_PER_SLIDE + 5; b++) {
        lines.push(`- bullet ${b}`);
      }
    }
    const outline = parseDeckOutline(lines.join("\n"));
    expect(outline.slides.length).toBeLessThanOrEqual(MAX_DECK_SLIDES);
    for (const slide of outline.slides) {
      expect(slide.bullets.length).toBeLessThanOrEqual(MAX_BULLETS_PER_SLIDE);
    }
  });

  it("treats marker-less prose lines as bullets", () => {
    const outline = parseDeckOutline("## Topic\nFirst point\nSecond point");
    expect(outline.slides[0].bullets).toEqual(["First point", "Second point"]);
  });
});

describe("outlineToSlides", () => {
  it("returns [] for an empty outline", () => {
    expect(outlineToSlides({ slides: [] })).toEqual([]);
  });

  it("uses the deck title for the first slide and a bullets block", () => {
    const slides = outlineToSlides({
      title: "Deck Title",
      slides: [
        { title: "Cover", bullets: ["subtitle"] },
        { title: "Body", bullets: ["a", "b"] },
        { title: "Lonely", bullets: ["just one"] },
        { title: "Empty", bullets: [] },
      ],
    });
    expect(slides[0].title).toBe("Deck Title");
    // single bullet on title slide -> a text block
    expect(slides[0].blocks[0].type).toBe("text");
    // multi-bullet body -> bullets block
    expect(slides[1].blocks[0].type).toBe("bullets");
    expect(slides[1].blocks[0].content).toBe("a\nb");
    // single-bullet non-title -> text block
    expect(slides[2].blocks[0].type).toBe("text");
    // empty non-title -> empty text block so the canvas is editable
    expect(slides[3].blocks[0].type).toBe("text");
    expect(slides[3].blocks[0].content).toBe("");
  });

  it("gives every slide a unique id", () => {
    const slides = outlineToSlides({
      slides: [
        { title: "A", bullets: [] },
        { title: "B", bullets: [] },
      ],
    });
    expect(slides[0].id).not.toBe(slides[1].id);
  });
});

describe("slideToContext", () => {
  it("flattens title + text/bullets and placeholders for media", () => {
    const slide = makeSlide({
      title: "My Slide",
      blocks: [
        buildBlock({ type: "bullets", content: "one\ntwo" }),
        buildBlock({ type: "image", content: "data:...", alt: "a chart" }),
        buildBlock({ type: "diagram", content: "graph TD; A-->B" }),
      ],
    });
    expect(slideToContext(slide)).toBe(
      [
        "Title: My Slide",
        "- one",
        "- two",
        "[image: a chart]",
        "[diagram]",
      ].join("\n"),
    );
  });
});

describe("prompt builders", () => {
  it("buildDeckPrompt embeds the clamped count, topic, tone and audience", () => {
    const prompt = buildDeckPrompt({
      topic: "Solar adoption",
      slideCount: 999,
      audience: "City planners",
      tone: "persuasive",
    });
    expect(prompt).toContain(`exactly ${MAX_DECK_SLIDES} slides`);
    expect(prompt).toContain("Topic: Solar adoption");
    expect(prompt).toContain("Audience: City planners");
    expect(prompt).toMatch(/persuasive/i);
  });

  it("buildDeckPrompt omits the audience line when not provided", () => {
    const prompt = buildDeckPrompt({ topic: "X", slideCount: 5 });
    expect(prompt).not.toContain("Audience:");
  });

  it("rewrite prompts differ per mode and carry slide context", () => {
    const slide = makeSlide({
      title: "T",
      blocks: [buildBlock({ type: "bullets", content: "a\nb" })],
    });
    const concise = buildRewritePrompt(slide, "concise");
    const expand = buildRewritePrompt(slide, "expand");
    expect(concise).not.toBe(expand);
    expect(concise).toContain("Title: T");
    expect(concise).toContain("- a");
  });

  it("notes and image prompts carry slide context", () => {
    const slide = makeSlide({ title: "Topic" });
    expect(buildNotesPrompt(slide)).toContain("Title: Topic");
    expect(buildImagePromptSuggestion(slide)).toContain("Title: Topic");
  });
});

describe("response parsers", () => {
  it("parseBulletResponse cleans markers and caps count", () => {
    const raw = ["## stray heading", "- one", "* two", "3. three"].join("\n");
    expect(parseBulletResponse(raw)).toEqual(["one", "two", "three"]);
  });

  it("parseBulletResponse falls back to marker-less lines", () => {
    expect(parseBulletResponse("alpha\nbeta")).toEqual(["alpha", "beta"]);
  });

  it("parseNotesResponse collapses to one capped paragraph", () => {
    expect(parseNotesResponse("Line one.\n\nLine two.")).toBe(
      "Line one. Line two.",
    );
  });

  it("parseImagePromptResponse returns the first usable line", () => {
    expect(parseImagePromptResponse("\n\n- A vivid sunset over hills")).toBe(
      "A vivid sunset over hills",
    );
    expect(parseImagePromptResponse("   ")).toBe("");
  });
});

describe("applyBulletsToSlide", () => {
  it("returns the same slide reference for empty bullets", () => {
    const slide = makeSlide({ blocks: [] });
    expect(applyBulletsToSlide(slide, [])).toBe(slide);
  });

  it("replaces the first text/bullets block, preserving media blocks", () => {
    const slide = makeSlide({
      blocks: [
        buildBlock({ type: "image", content: "img", alt: "x" }),
        buildBlock({ type: "text", content: "old" }),
      ],
    });
    const next = applyBulletsToSlide(slide, ["new1", "new2"]);
    expect(next.blocks[0].type).toBe("image");
    expect(next.blocks[1].type).toBe("bullets");
    expect(next.blocks[1].content).toBe("new1\nnew2");
  });

  it("prepends a bullets block when the slide has no text block", () => {
    const slide = makeSlide({
      blocks: [buildBlock({ type: "image", content: "img", alt: "x" })],
    });
    const next = applyBulletsToSlide(slide, ["a"]);
    expect(next.blocks).toHaveLength(2);
    expect(next.blocks[0].type).toBe("bullets");
    expect(next.blocks[0].content).toBe("a");
    expect(next.blocks[1].type).toBe("image");
  });
});
