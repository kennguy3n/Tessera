import { describe, it, expect } from "vitest";
import {
  parseSlideContent,
  slidesToMarpMarkdown,
  type SlideContent,
} from "../editors/SlideEditor";

describe("parseSlideContent", () => {
  it("returns the empty-default shape for empty input", () => {
    const parsed = parseSlideContent("");
    expect(parsed.slides).toHaveLength(1);
    expect(parsed.slides[0].title).toBe("Title Slide");
    expect(parsed.marpMode).toBe(false);
    expect(parsed.marpSource).toBe("");
    expect(parsed.marpTheme).toBeUndefined();
  });

  it("falls back to a single text slide when the content is not JSON", () => {
    const parsed = parseSlideContent("Just some text");
    expect(parsed.slides).toHaveLength(1);
    expect(parsed.slides[0].blocks[0].content).toBe("Just some text");
    expect(parsed.marpMode).toBe(false);
    expect(parsed.marpTheme).toBeUndefined();
  });

  it("restores marp.theme alongside marp.enabled and marp.source", () => {
    const payload: SlideContent = {
      slides: [
        { title: "Hello", blocks: [{ type: "text", content: "body" }], notes: "" },
      ],
      marp: {
        enabled: true,
        source: "---\nmarp: true\ntheme: gaia\n---\n# Hello",
        theme: "gaia",
      },
    };
    const parsed = parseSlideContent(JSON.stringify(payload));
    expect(parsed.marpMode).toBe(true);
    expect(parsed.marpSource).toContain("# Hello");
    // This is the round-trip we want — the previously hardcoded "default"
    // must now be replaced by whatever the JSON carried.
    expect(parsed.marpTheme).toBe("gaia");
  });

  it("leaves marpTheme undefined when the saved JSON has no marp block", () => {
    const payload: SlideContent = {
      slides: [
        { title: "Hello", blocks: [{ type: "text", content: "body" }], notes: "" },
      ],
    };
    const parsed = parseSlideContent(JSON.stringify(payload));
    expect(parsed.marpMode).toBe(false);
    expect(parsed.marpTheme).toBeUndefined();
  });
});

describe("slidesToMarpMarkdown", () => {
  it("emits a valid Marp front-matter header", () => {
    const out = slidesToMarpMarkdown([
      { title: "T", blocks: [{ type: "text", content: "x" }], notes: "" },
    ]);
    expect(out.startsWith("---\nmarp: true\n")).toBe(true);
    expect(out).toMatch(/^---\nmarp: true\ntheme: default\npaginate: true\n---/);
  });

  it("respects a non-default theme override", () => {
    const out = slidesToMarpMarkdown(
      [{ title: "T", blocks: [{ type: "text", content: "x" }], notes: "" }],
      { theme: "uncover" },
    );
    expect(out).toContain("theme: uncover");
  });

  it("converts bullets, diagrams, and notes into Marp-friendly syntax", () => {
    const out = slidesToMarpMarkdown([
      {
        title: "Roadmap",
        blocks: [
          { type: "text", content: "Intro paragraph" },
          { type: "bullets", content: "alpha\n- beta\n* gamma" },
          { type: "diagram", content: "graph TD; A-->B" },
        ],
        notes: "Slide presenter notes",
      },
    ]);
    expect(out).toContain("# Roadmap");
    expect(out).toContain("Intro paragraph");
    expect(out).toContain("- alpha");
    expect(out).toContain("- beta");
    expect(out).toContain("- gamma");
    expect(out).toContain("```mermaid\ngraph TD; A-->B\n```");
    expect(out).toContain("<!-- Slide presenter notes -->");
  });

  it("skips empty blocks and slides without titles cleanly", () => {
    const out = slidesToMarpMarkdown([
      { title: "", blocks: [{ type: "text", content: "" }], notes: "" },
      {
        title: "Second",
        blocks: [{ type: "text", content: "body" }],
        notes: "",
      },
    ]);
    expect(out).toContain("# Second");
    expect(out).toContain("body");
    // No empty headings left over from the first slide.
    expect(out).not.toMatch(/#\s*\n/);
  });
});
