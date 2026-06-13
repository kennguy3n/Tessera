import { describe, expect, it } from "vitest";
import {
  AI_DECK_LAYOUTS,
  MAX_BULLETS_PER_SLIDE,
  MAX_DECK_SLIDES,
  MAX_LINE_LENGTH,
  MIN_DECK_SLIDES,
  applyBulletsToSlide,
  buildDeckPrompt,
  buildImagePromptSuggestion,
  buildLayoutSuggestionPrompt,
  buildNotesPrompt,
  buildRewritePrompt,
  clampDeckSlideCount,
  cleanModelLine,
  outlineToSlides,
  parseBulletResponse,
  parseDeckOutline,
  parseHeadingLine,
  parseImagePromptResponse,
  parseLayoutSuggestion,
  parseNotesResponse,
  resolveGeneratedSlideLayout,
  slideToContext,
  splitLayoutHint,
} from "../editors/slideAiHelpers";
import { buildBlock } from "../editors/slideEditorHelpers";
import { SLIDE_LAYOUTS } from "../editors/slideLayouts";
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

  it("uses the deck title for the first slide and selects layouts per content", () => {
    const slides = outlineToSlides({
      title: "Deck Title",
      slides: [
        { title: "Cover", bullets: ["subtitle"] },
        { title: "Body", bullets: ["a", "b"] },
        { title: "Lonely", bullets: ["just one"] },
        { title: "Middle", bullets: ["x", "y", "z"] },
        { title: "Empty", bullets: [] },
      ],
    });
    // slide[0]: first slide → title layout, deck title overrides
    expect(slides[0].title).toBe("Deck Title");
    expect(slides[0].layout).toBe("title");
    // single bullet on title slide → text block in subtitle slot
    expect(slides[0].blocks[0].type).toBe("text");
    expect(slides[0].blocks[0].slot).toBe("subtitle");

    // slide[1]: 2 bullets → twoColumn layout
    expect(slides[1].layout).toBe("twoColumn");
    expect(slides[1].blocks).toHaveLength(2);
    expect(slides[1].blocks[0].slot).toBe("left");
    expect(slides[1].blocks[0].content).toBe("a");
    expect(slides[1].blocks[1].slot).toBe("right");
    expect(slides[1].blocks[1].content).toBe("b");

    // slide[2]: single bullet → titleContent layout
    expect(slides[2].layout).toBe("titleContent");
    expect(slides[2].blocks[0].type).toBe("text");
    expect(slides[2].blocks[0].slot).toBe("body");

    // slide[3]: 3+ bullets → titleContent layout with bullets block
    expect(slides[3].layout).toBe("titleContent");
    expect(slides[3].blocks[0].type).toBe("bullets");
    expect(slides[3].blocks[0].content).toBe("x\ny\nz");

    // slide[4]: closing slide, no bullets → sectionHeader layout
    expect(slides[4].layout).toBe("sectionHeader");
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

describe("splitLayoutHint", () => {
  it("extracts a leading [layout] tag and the bare title", () => {
    expect(splitLayoutHint("[twoColumn] Market vs Cost")).toEqual({
      layoutHint: "twoColumn",
      title: "Market vs Cost",
    });
    expect(splitLayoutHint("[ bigNumber ]  42% growth")).toEqual({
      layoutHint: "bigNumber",
      title: "42% growth",
    });
  });

  it("returns the heading unchanged when there is no tag", () => {
    expect(splitLayoutHint("Plain Heading")).toEqual({
      title: "Plain Heading",
    });
    // A bracketed phrase that isn't a single alpha token is left intact.
    expect(splitLayoutHint("[Q3 2025] Results")).toEqual({
      title: "[Q3 2025] Results",
    });
  });
});

describe("resolveGeneratedSlideLayout", () => {
  it("always makes the first slide the cover (title)", () => {
    expect(
      resolveGeneratedSlideLayout(
        { title: "Cover", bullets: [], layoutHint: "twoColumn" },
        0,
        5,
      ),
    ).toBe("title");
  });

  it("honours a supported model hint on non-first slides", () => {
    expect(
      resolveGeneratedSlideLayout(
        { title: "S", bullets: ["a", "b", "c"], layoutHint: "twoColumn" },
        1,
        5,
      ),
    ).toBe("twoColumn");
    expect(
      resolveGeneratedSlideLayout(
        { title: "S", bullets: ["x"], layoutHint: "quote" },
        2,
        5,
      ),
    ).toBe("quote");
  });

  it("ignores an unknown or unsupported hint and falls back to the heuristic", () => {
    // "imageLeft" is a real layout but NOT in the deck-generation set,
    // so it must be rejected in favour of the content heuristic.
    expect(AI_DECK_LAYOUTS.has("imageLeft")).toBe(false);
    expect(
      resolveGeneratedSlideLayout(
        { title: "S", bullets: ["a", "b"], layoutHint: "imageLeft" },
        1,
        5,
      ),
    ).toBe("twoColumn");
    // A garbage hint also falls back.
    expect(
      resolveGeneratedSlideLayout(
        { title: "S", bullets: ["one"], layoutHint: "nonsense" },
        1,
        5,
      ),
    ).toBe("titleContent");
  });
});

describe("parseDeckOutline with layout hints", () => {
  it("captures the layout hint from a tagged heading", () => {
    const raw = [
      "TITLE: Q3 Review",
      "## Overview",
      "- intro",
      "## [twoColumn] Compare",
      "- left",
      "- right",
    ].join("\n");
    const outline = parseDeckOutline(raw);
    expect(outline.slides[0].layoutHint).toBeUndefined();
    expect(outline.slides[1].layoutHint).toBe("twoColumn");
    expect(outline.slides[1].title).toBe("Compare");
  });
});

describe("outlineToSlides honours model layout hints", () => {
  it("uses a quote hint and splits quote / attribution", () => {
    const slides = outlineToSlides({
      title: "Deck",
      slides: [
        { title: "Cover", bullets: [] },
        {
          title: "Voice",
          bullets: ["Stay hungry, stay foolish", "Steve Jobs"],
          layoutHint: "quote",
        },
      ],
    });
    expect(slides[1].layout).toBe("quote");
    expect(slides[1].blocks[0].slot).toBe("quote");
    expect(slides[1].blocks[0].content).toBe("Stay hungry, stay foolish");
    expect(slides[1].blocks[1].slot).toBe("attribution");
    expect(slides[1].blocks[1].content).toBe("Steve Jobs");
  });

  it("falls back to the heuristic when the hint is unsupported", () => {
    const slides = outlineToSlides({
      slides: [
        { title: "Cover", bullets: [] },
        { title: "Body", bullets: ["a", "b"], layoutHint: "imageRight" },
      ],
    });
    // imageRight is not a deck-gen layout → 2 bullets → twoColumn.
    expect(slides[1].layout).toBe("twoColumn");
  });
});

describe("buildLayoutSuggestionPrompt", () => {
  it("lists every catalogue layout id and the slide context", () => {
    const slide = makeSlide({
      title: "Pricing",
      blocks: [buildBlock({ type: "bullets", content: "Basic\nPro" })],
    });
    const prompt = buildLayoutSuggestionPrompt(slide);
    for (const layout of SLIDE_LAYOUTS) {
      expect(prompt).toContain(layout.id);
    }
    expect(prompt).toContain("Title: Pricing");
    expect(prompt).toContain("Output ONLY the layout id");
  });
});

describe("parseLayoutSuggestion", () => {
  it("recognises a bare layout id", () => {
    expect(parseLayoutSuggestion("twoColumn")).toBe("twoColumn");
  });

  it("recognises the id inside prose, code fences, or with punctuation", () => {
    expect(parseLayoutSuggestion("```\nbigNumber\n```")).toBe("bigNumber");
    expect(
      parseLayoutSuggestion("The best layout is quote."),
    ).toBe("quote");
  });

  it("recognises the human label and hyphenated forms", () => {
    expect(parseLayoutSuggestion("Two Columns")).toBe("twoColumn");
    expect(parseLayoutSuggestion("two-column")).toBe("twoColumn");
  });

  it("returns null when no known layout is named", () => {
    expect(parseLayoutSuggestion("I am not sure")).toBeNull();
    expect(parseLayoutSuggestion("")).toBeNull();
  });
});

describe("buildDeckPrompt layout contract", () => {
  it("documents the [layout] heading convention and the layout vocabulary", () => {
    const prompt = buildDeckPrompt({ topic: "X", slideCount: 5 });
    expect(prompt).toContain("## [layout] <slide title>");
    expect(prompt).toContain("twoColumn");
    expect(prompt).toContain("bigNumber");
    expect(prompt).toContain("quote");
  });
});
