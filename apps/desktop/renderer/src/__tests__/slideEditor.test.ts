import { describe, it, expect } from "vitest";
import {
  parseSlideContent,
  slidesToMarpMarkdown,
  escapeHtmlComment,
  extractFrontmatterTheme,
  setFrontmatterTheme,
  buildSlideFromLayout,
  duplicateSlideAt,
  moveBlock,
  removeBlock,
  appendBlock,
  replaceBlock,
  slideWordCount,
  deckWordCount,
  findInSlides,
  nextBlockForTypeChange,
  DEFAULT_DIAGRAM_DSL,
} from "../editors/slideEditorHelpers";
import type { Slide, SlideBlock, SlideContent } from "../editors/slideEditorTypes";

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
        { id: "test-s-1", title: "Hello", blocks: [{ id: "test-b-1", type: "text", content: "body" }], notes: "" },
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
        { id: "test-s-2", title: "Hello", blocks: [{ id: "test-b-2", type: "text", content: "body" }], notes: "" },
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
      { id: "test-s-3", title: "T", blocks: [{ id: "test-b-3", type: "text", content: "x" }], notes: "" },
    ]);
    expect(out.startsWith("---\nmarp: true\n")).toBe(true);
    expect(out).toMatch(/^---\nmarp: true\ntheme: 'default'\npaginate: true\n---/);
  });

  it("respects a non-default theme override", () => {
    const out = slidesToMarpMarkdown(
      [{ id: "test-s-4", title: "T", blocks: [{ id: "test-b-4", type: "text", content: "x" }], notes: "" }],
      { theme: "uncover" },
    );
    expect(out).toContain("theme: 'uncover'");
  });

  it("converts bullets, diagrams, and notes into Marp-friendly syntax", () => {
    const out = slidesToMarpMarkdown([
      {
        id: "test-ms-1",
        title: "Roadmap",
        blocks: [
          { id: "test-b-5", type: "text", content: "Intro paragraph" },
          { id: "test-b-6", type: "bullets", content: "alpha\n- beta\n* gamma" },
          { id: "test-b-7", type: "diagram", content: "graph TD; A-->B" },
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

  it("renders image blocks as Markdown image syntax (not raw data URLs)", () => {
    // Regression test for BUG_0001 (Devin Review on PR #81):
    //
    // Before this fix, image blocks fell through to the catch-all
    // `else { parts.push(content); }` branch in `renderSlideAsMarp`,
    // so an image block's data URL was emitted as a bare paragraph in
    // the Marp source. The PPTX export pipeline (Marp CLI) then
    // rendered it as visible text instead of an `<img>` element, and
    // the data URL leaked into the slide body. Rendering the block as
    // `![alt](<url>)` (CommonMark angle-bracket link-destination form)
    // lets Marp emit a real image and is robust to URLs containing
    // characters that would otherwise terminate the `()` group (e.g.
    // `(`, `)`, spaces — common in Wikipedia / Mediawiki URLs).
    // Brackets in alt text are stripped because the `[...]` group has
    // no angle-bracket escape hatch.
    const out = slidesToMarpMarkdown([
      {
        id: "test-ms-2",
        title: "Cover",
        blocks: [
          {
            id: "test-mb-1",
            type: "image",
            content: "data:image/png;base64,iVBORw0KGgo=",
            alt: "Company logo [v2]",
          },
          { id: "test-b-8", type: "image", content: "https://example.com/x.png" },
        ],
        notes: "",
      },
    ]);
    expect(out).toContain(
      "![Company logo v2](<data:image/png;base64,iVBORw0KGgo=>)",
    );
    expect(out).toContain("![](<https://example.com/x.png>)");
    // The raw data URL must never appear outside the image-syntax
    // angle-bracket / parentheses (i.e. no standalone paragraph dump).
    expect(out).not.toMatch(/^data:image\//m);
  });

  it("renders image URLs containing parens via CommonMark angle-bracket form", () => {
    // Regression test for ANALYSIS_0001 (Devin Review on PR #81
    // round 2): Wikipedia / Mediawiki / SharePoint URLs commonly
    // contain unescaped `(` and `)` characters (e.g.
    // `C_(programming_language).png`). Emitting these inside the
    // CommonMark `()` link-destination group truncates the URL at the
    // first `)`. Switching to the angle-bracket form `<url>` accepts
    // any character except `<`, `>`, or newline — none of which can
    // appear in a valid HTTP URL — so paren-bearing URLs survive the
    // export pipeline intact.
    const out = slidesToMarpMarkdown([
      {
        id: "test-ms-3",
        title: "Refs",
        blocks: [
          {
            id: "test-mb-2",
            type: "image",
            content: "https://example.com/C_(lang).png",
            alt: "C",
          },
          {
            id: "test-mb-3",
            type: "image",
            content: "https://example.com/path with spaces.png",
            alt: "",
          },
        ],
        notes: "",
      },
    ]);
    expect(out).toContain("![C](<https://example.com/C_(lang).png>)");
    expect(out).toContain(
      "![](<https://example.com/path with spaces.png>)",
    );
  });

  it("skips empty blocks and slides without titles cleanly", () => {
    const out = slidesToMarpMarkdown([
      { id: "test-s-5", title: "", blocks: [{ id: "test-b-9", type: "text", content: "" }], notes: "" },
      {
        id: "test-ms-4",
        title: "Second",
        blocks: [{ id: "test-b-10", type: "text", content: "body" }],
        notes: "",
      },
    ]);
    expect(out).toContain("# Second");
    expect(out).toContain("body");
    // No empty headings left over from the first slide.
    expect(out).not.toMatch(/#\s*\n/);
  });

  it("emits `---` separators between slides so multi-slide PPTX exports keep their slide boundaries", () => {
    // Regression test:
    // without `---` separators Marp collapses every following slide into the
    // first one, producing a 1-slide PPTX no matter how many slides were
    // authored in the WYSIWYG editor.
    const out = slidesToMarpMarkdown([
      {
        id: "test-ms-5",
        title: "First",
        blocks: [{ id: "test-b-11", type: "text", content: "alpha" }],
        notes: "",
      },
      {
        id: "test-ms-6",
        title: "Second",
        blocks: [{ id: "test-b-12", type: "text", content: "beta" }],
        notes: "",
      },
      {
        id: "test-ms-7",
        title: "Third",
        blocks: [{ id: "test-b-13", type: "text", content: "gamma" }],
        notes: "",
      },
    ]);

    // The `\n---\n` pattern appears in: (a) the closing line of the
    // front-matter `---` block (newline before, newline after the first
    // separator), and (b) once between each pair of slides. With 3 slides
    // that's 1 (front-matter close) + 2 (between slides) = 3. We assert the
    // exact count so the test catches regressions in either direction
    // (missing separator AND accidental duplicate separator).
    const separatorCount = out.split(/\n---\n/).length - 1;
    expect(separatorCount).toBe(3);

    // Each slide's heading must follow a separator (or the opening header).
    expect(out).toMatch(/\n---\n\n# First\n/);
    expect(out).toMatch(/\n---\n\n# Second\n/);
    expect(out).toMatch(/\n---\n\n# Third\n/);

    // Sanity: slide bodies preserved in order.
    const firstIdx = out.indexOf("alpha");
    const secondIdx = out.indexOf("beta");
    const thirdIdx = out.indexOf("gamma");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });

  it("escapes `-->` in speaker notes so the HTML comment cannot be terminated early", () => {
    // Adversarial speaker notes carrying the HTML comment terminator. Before
    // the fix the resulting Marp markdown would contain
    // `<!-- close --> evil <script>alert(1)</script> -->`, which the HTML
    // tokenizer would parse as a closed comment followed by a literal
    // `<script>` tag — leaking into PPTX / PDF / HTML exports.
    const notes = "close --> evil <script>alert(1)</script>";
    const out = slidesToMarpMarkdown([
      {
        id: "test-ms-8",
        title: "Hostile",
        blocks: [{ id: "test-b-14", type: "text", content: "body" }],
        notes,
      },
    ]);
    // The dangerous `-->` substring must NOT appear anywhere except as the
    // explicit comment terminator we emit at the end of the notes line.
    const occurrences = (out.match(/-->/g) ?? []).length;
    expect(occurrences).toBe(1);
    // Sanity: the escaped form is present and the original payload survives
    // (we only insert a space, not strip characters).
    expect(out).toContain("close -- > evil");
    expect(out).toContain("<script>alert(1)</script>");
  });
});

describe("escapeHtmlComment", () => {
  it("leaves benign strings unchanged", () => {
    expect(escapeHtmlComment("just notes")).toBe("just notes");
    expect(escapeHtmlComment("a-b-c")).toBe("a-b-c");
    expect(escapeHtmlComment("dashes -- here")).toBe("dashes -- here");
  });

  it("breaks every `-->` sequence with a space (idempotent on already-safe text)", () => {
    expect(escapeHtmlComment("a --> b")).toBe("a -- > b");
    expect(escapeHtmlComment("--> at start")).toBe("-- > at start");
    expect(escapeHtmlComment("end with -->")).toBe("end with -- >");
    expect(escapeHtmlComment("multi --> --> hops")).toBe(
      "multi -- > -- > hops",
    );
    // After escape, running it again is a no-op (no `-->` left).
    const escaped = escapeHtmlComment("a --> b --> c");
    expect(escapeHtmlComment(escaped)).toBe(escaped);
  });
});

describe("extractFrontmatterTheme", () => {
  it("returns undefined when there is no frontmatter", () => {
    expect(extractFrontmatterTheme("")).toBeUndefined();
    expect(extractFrontmatterTheme("# Slide 1\n\nbody")).toBeUndefined();
  });

  it("returns undefined when frontmatter has no theme directive", () => {
    const src = "---\nmarp: true\npaginate: true\n---\n\n# Slide";
    expect(extractFrontmatterTheme(src)).toBeUndefined();
  });

  it("extracts an unquoted theme", () => {
    const src = "---\nmarp: true\ntheme: gaia\n---\n\n# Slide";
    expect(extractFrontmatterTheme(src)).toBe("gaia");
  });

  it("strips a single layer of surrounding single or double quotes", () => {
    expect(
      extractFrontmatterTheme("---\ntheme: 'uncover'\n---"),
    ).toBe("uncover");
    expect(
      extractFrontmatterTheme('---\ntheme: "default"\n---'),
    ).toBe("default");
  });

  it("does not include the `---` slide separators that follow the frontmatter", () => {
    // Regression: a naive greedy regex would match through multiple `---`
    // lines and pull a stray theme value from later in the document.
    const src =
      "---\nmarp: true\ntheme: gaia\n---\n\n# Slide 1\n\n---\n\n# Slide 2\ntheme: uncover";
    expect(extractFrontmatterTheme(src)).toBe("gaia");
  });
});

describe("setFrontmatterTheme", () => {
  it("rewrites an existing theme directive in place", () => {
    const src = "---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# Slide";
    const out = setFrontmatterTheme(src, "gaia");
    expect(out).toBe(
      "---\nmarp: true\ntheme: gaia\npaginate: true\n---\n\n# Slide",
    );
  });

  it("appends a theme directive when the frontmatter does not have one", () => {
    const src = "---\nmarp: true\npaginate: true\n---\n\n# Slide";
    const out = setFrontmatterTheme(src, "uncover");
    expect(out).toContain("theme: uncover");
    // Frontmatter block stays intact and closes properly.
    expect(out.startsWith("---\n")).toBe(true);
    expect(out).toContain("\n---\n\n# Slide");
  });

  it("prepends a minimal frontmatter when none exists", () => {
    const src = "# Slide 1\n\nbody";
    const out = setFrontmatterTheme(src, "gaia");
    expect(out.startsWith("---\nmarp: true\ntheme: gaia\n---\n\n")).toBe(
      true,
    );
    expect(out).toContain("# Slide 1");
  });

  it("round-trips with extractFrontmatterTheme", () => {
    const start = "---\nmarp: true\ntheme: default\n---\n\n# Slide";
    const after = setFrontmatterTheme(start, "uncover");
    expect(extractFrontmatterTheme(after)).toBe("uncover");
  });

  it("preserves frontmatter content containing `$`-sequences", () => {
    // Realistic example: a footer directive whose value happens to contain
    // `$50M` (or any other `$`-followed-by-character). The previous code
    // used `src.replace(whole, '<replacement-string>')`, which interprets
    // `$&`/`$'`/`$\``/`$$` in the *replacement* as regex backreferences and
    // would silently corrupt the frontmatter. The new slice-based splice
    // (and the function-replacer used inside the body rewrite) must be
    // immune to that — every `$`-sequence in the user's frontmatter has to
    // survive verbatim.
    const src =
      "---\nmarp: true\ntheme: default\nfooter: '$50M Q4 target'\nheader: 'A & B $& C'\n---\n\n# Slide";
    const out = setFrontmatterTheme(src, "gaia");
    // Theme is updated.
    expect(out).toContain("theme: gaia");
    expect(out).not.toContain("theme: default");
    // Every `$`-sequence in the user's frontmatter survives verbatim.
    expect(out).toContain("footer: '$50M Q4 target'");
    expect(out).toContain("header: 'A & B $& C'");
    // The frontmatter block is well-formed (open + close) and the body is
    // intact — no fragment of the matched frontmatter has been spliced into
    // itself (which is what `$&` expansion would produce).
    const fmCount = (out.match(/^---$/gm) ?? []).length;
    expect(fmCount).toBe(2); // open + close
    expect(out.endsWith("\n# Slide")).toBe(true);
  });

  it("preserves frontmatter when the *existing* theme line itself contains `$`-sequences (uses function replacer)", () => {
    // The body-internal replace also has to avoid $-pattern interpretation,
    // even though only the matched line is what gets rewritten — because
    // String.replace with a string replacement still interprets $ patterns.
    // Here the *replacement* is just `theme: gaia` (no $-chars), so the
    // immediate bug is on the outer splice; this test still pins the
    // behaviour by confirming a theme value containing `$` is overwritten
    // cleanly without any $-pattern leakage from the *old* line.
    const src = "---\nmarp: true\ntheme: 'My $1 Theme'\n---\n\n# Slide";
    const out = setFrontmatterTheme(src, "uncover");
    expect(out).toContain("theme: uncover");
    expect(out).not.toContain("My $1 Theme");
    expect(out).toContain("# Slide");
  });

  it("does not corrupt slide-body `---` separators", () => {
    // Set theme on a multi-slide source and confirm the bottom slides
    // still have their separators intact.
    const src =
      "---\nmarp: true\ntheme: default\n---\n\n# Slide 1\n\n---\n\n# Slide 2";
    const out = setFrontmatterTheme(src, "gaia");
    expect(out).toContain("theme: gaia");
    expect(out).toContain("\n# Slide 1\n");
    expect(out).toContain("\n# Slide 2");
    // Exactly one `---` separator between slide 1 and slide 2 (plus the
    // closing `---` of the frontmatter).
    const separators = (out.match(/^---$/gm) ?? []).length;
    expect(separators).toBe(3); // open, close, between-slides
  });
});

// ─────────────────────────────────────────────────────────────────────
// Phase 18 PR 7 — slide UX helpers
// ─────────────────────────────────────────────────────────────────────

let __slideOfCounter = 0;
function slideOf(title: string, content: string, notes = ""): Slide {
  __slideOfCounter += 1;
  return {
    id: `slideOf-s-${__slideOfCounter}`,
    title,
    blocks: [
      { id: `slideOf-b-${__slideOfCounter}`, type: "text", content },
    ],
    notes,
  };
}

describe("buildSlideFromLayout", () => {
  it("returns a single empty text block for the blank layout", () => {
    const s = buildSlideFromLayout("blank");
    expect(s.title).toBe("");
    expect(s.blocks).toEqual([
      { id: expect.any(String), type: "text", content: "" },
    ]);
    expect(s.notes).toBe("");
  });

  it("returns no blocks for the title layout", () => {
    const s = buildSlideFromLayout("title");
    expect(s.title).toBe("New Slide");
    expect(s.blocks).toEqual([]);
  });

  it("returns one text block for the titleContent layout", () => {
    const s = buildSlideFromLayout("titleContent");
    expect(s.title).toBe("New Slide");
    expect(s.blocks).toEqual([
      { id: expect.any(String), type: "text", content: "" },
    ]);
  });

  it("returns two text blocks for the twoColumn layout", () => {
    const s = buildSlideFromLayout("twoColumn");
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks.every((b) => b.type === "text")).toBe(true);
  });

  it("returns an image+caption pair for the imageCaption layout", () => {
    const s = buildSlideFromLayout("imageCaption");
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks[0]).toEqual({
      id: expect.any(String),
      type: "image",
      content: "",
      alt: "",
    });
    expect(s.blocks[1]).toEqual({
      id: expect.any(String),
      type: "text",
      content: "",
    });
  });

  it("returns a fresh object each call so multiple inserts don't alias", () => {
    const a = buildSlideFromLayout("titleContent");
    const b = buildSlideFromLayout("titleContent");
    expect(a).not.toBe(b);
    expect(a.blocks).not.toBe(b.blocks);
    a.blocks[0].content = "mutated";
    expect(b.blocks[0].content).toBe("");
  });
});

describe("duplicateSlideAt", () => {
  it("inserts a deep clone immediately after the source slide", () => {
    const a = slideOf("A", "alpha");
    const b = slideOf("B", "beta");
    const result = duplicateSlideAt([a, b], 0);
    expect(result.insertedAt).toBe(1);
    expect(result.slides).toHaveLength(3);
    expect(result.slides[0]).toBe(a);
    expect(result.slides[1]).not.toBe(a);
    expect(result.slides[1].title).toBe("A");
    expect(result.slides[2]).toBe(b);
  });

  it("deep-clones blocks so post-duplicate edits don't reach across", () => {
    const original = slideOf("A", "alpha");
    const result = duplicateSlideAt([original], 0);
    result.slides[1].blocks[0].content = "changed";
    expect(original.blocks[0].content).toBe("alpha");
  });

  it("is a no-op for an out-of-range index and reports insertedAt=-1", () => {
    const slides = [slideOf("A", "alpha")];
    const result = duplicateSlideAt(slides, 5);
    expect(result.insertedAt).toBe(-1);
    expect(result.slides).toBe(slides);
  });

  it("is a no-op for a negative index", () => {
    const slides = [slideOf("A", "alpha")];
    const result = duplicateSlideAt(slides, -1);
    expect(result.insertedAt).toBe(-1);
    expect(result.slides).toBe(slides);
  });

  it("appends at the end when duplicating the last slide", () => {
    const a = slideOf("A", "alpha");
    const b = slideOf("B", "beta");
    const result = duplicateSlideAt([a, b], 1);
    expect(result.insertedAt).toBe(2);
    expect(result.slides).toHaveLength(3);
    expect(result.slides[2].title).toBe("B");
  });
});

describe("moveBlock", () => {
  it("moves a block to a later position", () => {
    const slide: Slide = {
      id: "test-ms-9",
      title: "T",
      blocks: [
        { id: "test-b-20", type: "text", content: "a" },
        { id: "test-b-21", type: "text", content: "b" },
        { id: "test-b-22", type: "text", content: "c" },
      ],
      notes: "",
    };
    const next = moveBlock(slide, 0, 2);
    expect(next.blocks.map((b) => b.content)).toEqual(["b", "c", "a"]);
  });

  it("moves a block to an earlier position", () => {
    const slide: Slide = {
      id: "test-ms-10",
      title: "T",
      blocks: [
        { id: "test-b-23", type: "text", content: "a" },
        { id: "test-b-24", type: "text", content: "b" },
        { id: "test-b-25", type: "text", content: "c" },
      ],
      notes: "",
    };
    const next = moveBlock(slide, 2, 0);
    expect(next.blocks.map((b) => b.content)).toEqual(["c", "a", "b"]);
  });

  it("returns the same reference when from === to (no-op for setState)", () => {
    const slide: Slide = {
      id: "test-ms-11",
      title: "T",
      blocks: [{ id: "test-b-26", type: "text", content: "a" }],
      notes: "",
    };
    expect(moveBlock(slide, 0, 0)).toBe(slide);
  });

  it("returns the same reference for out-of-range indices", () => {
    const slide: Slide = {
      id: "test-ms-12",
      title: "T",
      blocks: [{ id: "test-b-27", type: "text", content: "a" }],
      notes: "",
    };
    expect(moveBlock(slide, -1, 0)).toBe(slide);
    expect(moveBlock(slide, 0, 5)).toBe(slide);
  });

  it("does not mutate the input array", () => {
    const slide: Slide = {
      id: "test-ms-13",
      title: "T",
      blocks: [
        { id: "test-b-28", type: "text", content: "a" },
        { id: "test-b-29", type: "text", content: "b" },
      ],
      notes: "",
    };
    moveBlock(slide, 0, 1);
    expect(slide.blocks.map((b) => b.content)).toEqual(["a", "b"]);
  });
});

describe("removeBlock", () => {
  it("removes the block at the given index", () => {
    const slide: Slide = {
      id: "test-ms-14",
      title: "T",
      blocks: [
        { id: "test-b-30", type: "text", content: "a" },
        { id: "test-b-31", type: "text", content: "b" },
      ],
      notes: "",
    };
    expect(removeBlock(slide, 0).blocks).toEqual([
      { id: "test-b-31", type: "text", content: "b" },
    ]);
  });

  it("allows the slide to end up with zero blocks", () => {
    const slide: Slide = {
      id: "test-ms-15",
      title: "T",
      blocks: [{ id: "test-b-33", type: "text", content: "only" }],
      notes: "",
    };
    expect(removeBlock(slide, 0).blocks).toEqual([]);
  });

  it("returns the same reference for out-of-range indices", () => {
    const slide: Slide = {
      id: "test-ms-16",
      title: "T",
      blocks: [{ id: "test-b-34", type: "text", content: "a" }],
      notes: "",
    };
    expect(removeBlock(slide, -1)).toBe(slide);
    expect(removeBlock(slide, 5)).toBe(slide);
  });
});

describe("appendBlock", () => {
  it("appends a block to the end", () => {
    const slide: Slide = {
      id: "test-ms-17",
      title: "T",
      blocks: [{ id: "test-b-35", type: "text", content: "a" }],
      notes: "",
    };
    const next = appendBlock(slide, {
      id: "test-b-36",
      type: "bullets",
      content: "b",
    });
    expect(next.blocks).toEqual([
      { id: "test-b-35", type: "text", content: "a" },
      { id: "test-b-36", type: "bullets", content: "b" },
    ]);
  });

  it("works on an empty slide", () => {
    const slide: Slide = { id: "test-s-6", title: "T", blocks: [], notes: "" };
    expect(
      appendBlock(slide, { id: "test-b-39", type: "text", content: "x" })
        .blocks,
    ).toEqual([{ id: "test-b-39", type: "text", content: "x" }]);
  });

  it("does not mutate the input blocks array", () => {
    const slide: Slide = { id: "test-s-7", title: "T", blocks: [], notes: "" };
    const originalBlocksRef = slide.blocks;
    appendBlock(slide, { id: "test-b-41", type: "text", content: "x" });
    expect(slide.blocks).toBe(originalBlocksRef);
    expect(slide.blocks).toEqual([]);
  });
});

describe("replaceBlock", () => {
  it("replaces the block at the given index", () => {
    const slide: Slide = {
      id: "test-ms-18",
      title: "T",
      blocks: [
        { id: "test-b-42", type: "text", content: "a" },
        { id: "test-b-43", type: "text", content: "b" },
      ],
      notes: "",
    };
    const next = replaceBlock(slide, 1, {
      id: "test-b-44",
      type: "bullets",
      content: "new",
    });
    expect(next.blocks).toEqual([
      { id: "test-b-42", type: "text", content: "a" },
      { id: "test-b-44", type: "bullets", content: "new" },
    ]);
  });

  it("returns the same reference for out-of-range indices", () => {
    const slide: Slide = {
      id: "test-ms-19",
      title: "T",
      blocks: [{ id: "test-b-47", type: "text", content: "a" }],
      notes: "",
    };
    expect(replaceBlock(slide, 5, { id: "test-b-48", type: "text", content: "x" })).toBe(slide);
    expect(replaceBlock(slide, -1, { id: "test-b-49", type: "text", content: "x" })).toBe(slide);
  });

  it("returns the same reference when the replacement is === the existing block", () => {
    // Pins the second short-circuit branch. Without this guard, the
    // `nextBlockForTypeChange` same-type optimisation (which returns
    // the input block unchanged when `block.type === nextType`)
    // would be defeated end-to-end: `replaceBlock` would still build
    // a fresh array and a fresh `Slide`, the parent component's
    // `if (updatedSlide === slide) return prev` short-circuit would
    // miss, and `debouncedSave` would fire on a no-op type-select.
    const existing: SlideBlock = {
      id: "test-b-id-existing",
      type: "text",
      content: "keep me",
    };
    const slide: Slide = {
      id: "test-s-id-rb",
      title: "T",
      blocks: [
        { id: "test-b-id-a", type: "bullets", content: "- a" },
        existing,
        { id: "test-b-id-c", type: "text", content: "z" },
      ],
      notes: "",
    };
    expect(replaceBlock(slide, 1, existing)).toBe(slide);
  });

  it("falls back to the existing block's id when the replacement omits one (PR #82 round 3 layer-2 defence)", () => {
    // The "second layer of defence" Devin Review called out
    // (ANALYSIS_0005): if a future call site builds a replacement
    // block by hand and forgets to carry the id forward (e.g. a
    // toolbar action that constructs a fresh block from a template),
    // `replaceBlock` still preserves the slot's identity by reading
    // the existing block's id. Without this fallback the React key
    // would change on every save and the `<textarea>` would lose
    // cursor/selection state.
    const slide: Slide = {
      id: "test-ms-rb-fallback",
      title: "T",
      blocks: [
        { id: "test-b-rb-keep", type: "text", content: "a" },
        { id: "test-b-rb-target", type: "text", content: "b" },
      ],
      notes: "",
    };
    // Cast through `unknown` because the public `SlideBlock` type
    // requires `id`; this test is exercising the runtime contract
    // for callers that construct a partial block without TS.
    const replacement = { type: "bullets", content: "new" } as unknown as SlideBlock;
    const next = replaceBlock(slide, 1, replacement);
    expect(next).not.toBe(slide);
    expect(next.blocks[1]).toEqual({
      id: "test-b-rb-target", // existing id carried forward
      type: "bullets",
      content: "new",
    });
    // Layer-1 (caller supplies id) still wins when present.
    const withId = replaceBlock(slide, 1, {
      id: "test-b-rb-explicit",
      type: "bullets",
      content: "new",
    });
    expect(withId.blocks[1].id).toBe("test-b-rb-explicit");
  });
});

describe("nextBlockForTypeChange", () => {
  // The type-select dropdown handler in `SlideEditor.tsx` delegates to
  // this pure helper. Tests pin the keep / seed / clear matrix so the
  // dropdown stays well-behaved when block types cross the `image`
  // boundary (BUG_0001 on PR #81 round 2) and when entering `diagram`
  // for the first time.

  it("clears content when switching FROM an image block (BUG_0001)", () => {
    // Regression: previously, switching FROM image → text|bullets|diagram
    // preserved `block.content`, which for an image block is a
    // multi-megabyte `data:image/...;base64,...` URL written by
    // `fileToDataUrl`. The new editor surface for those types is a
    // `<textarea>`, so the URL was being pasted into the textarea
    // (janking the renderer) instead of being cleared.
    const imageBlock: SlideBlock = {
      id: "test-mb-4",
      type: "image",
      content: "data:image/png;base64,AAAA",
      alt: "Logo",
    };
    expect(nextBlockForTypeChange(imageBlock, "text")).toEqual({
      id: "test-mb-4",
      type: "text",
      content: "",
      alt: undefined,
    });
    expect(nextBlockForTypeChange(imageBlock, "bullets")).toEqual({
      id: "test-mb-4",
      type: "bullets",
      content: "",
      alt: undefined,
    });
    // Switching image → diagram seeds the DSL starter because the
    // post-clear content is empty (the diagram-seed branch wins over
    // the image-clear branch when content would otherwise be `""`).
    expect(nextBlockForTypeChange(imageBlock, "diagram")).toEqual({
      id: "test-mb-4",
      type: "diagram",
      content: DEFAULT_DIAGRAM_DSL,
      alt: undefined,
    });
  });

  it("clears content when switching INTO an image block", () => {
    const textBlock: SlideBlock = {
      id: "test-b-50",
      type: "text",
      content: "hello",
    };
    expect(nextBlockForTypeChange(textBlock, "image")).toEqual({
      id: "test-b-50",
      type: "image",
      content: "",
      alt: "",
    });
    const bulletsBlock: SlideBlock = {
      id: "test-mb-5",
      type: "bullets",
      content: "- one\n- two",
    };
    expect(nextBlockForTypeChange(bulletsBlock, "image")).toEqual({
      id: "test-mb-5",
      type: "image",
      content: "",
      alt: "",
    });
    // Preserves a pre-existing alt when switching back to image.
    const wasImageEmpty: SlideBlock = {
      id: "test-mb-6",
      type: "text",
      content: "x",
      alt: "previous alt",
    };
    expect(nextBlockForTypeChange(wasImageEmpty, "image")).toEqual({
      id: "test-mb-6",
      type: "image",
      content: "",
      alt: "previous alt",
    });
  });

  it("seeds the diagram starter DSL only when content is empty", () => {
    const emptyText: SlideBlock = { id: "test-b-51", type: "text", content: "" };
    expect(nextBlockForTypeChange(emptyText, "diagram").content).toBe(
      DEFAULT_DIAGRAM_DSL,
    );
    // Existing content survives the text → diagram switch — the user
    // may have typed mermaid DSL inside a text block before realising
    // diagrams have a dedicated type, and reseeding would clobber
    // their work.
    const existingText: SlideBlock = {
      id: "test-mb-7",
      type: "text",
      content: "graph TD; A-->B",
    };
    expect(nextBlockForTypeChange(existingText, "diagram").content).toBe(
      "graph TD; A-->B",
    );
  });

  it("keeps content untouched on text ↔ bullets toggles", () => {
    // A common authoring workflow: write an outline as bullets, then
    // switch to text to flow it into prose, then back. The content
    // must round-trip verbatim so the user doesn't lose work.
    const bullets: SlideBlock = {
      id: "test-b-52",
      type: "bullets",
      content: "- a\n- b",
    };
    const toText = nextBlockForTypeChange(bullets, "text");
    expect(toText).toEqual({
      id: "test-b-52",
      type: "text",
      content: "- a\n- b",
      alt: undefined,
    });
    const back = nextBlockForTypeChange(toText, "bullets");
    expect(back).toEqual({
      id: "test-b-52",
      type: "bullets",
      content: "- a\n- b",
      alt: undefined,
    });
  });

  it("strips alt on non-image types and defaults alt to '' on image", () => {
    const imageBlock: SlideBlock = {
      id: "test-mb-8",
      type: "image",
      content: "data:image/png;base64,AAA",
      alt: "logo",
    };
    expect(nextBlockForTypeChange(imageBlock, "bullets").alt).toBe(undefined);
    const textWithoutAlt: SlideBlock = { id: "test-b-54", type: "text", content: "x" };
    expect(nextBlockForTypeChange(textWithoutAlt, "image").alt).toBe("");
  });

  it("returns the input reference unchanged when the type does not change", () => {
    // Pins the no-op contract: same-type re-selection is a no-op so
    // callers using `===` short-circuit a re-render (matches the
    // contract of `moveBlock` / `removeBlock` / `replaceBlock`). The
    // image-self case is the safety-critical one — without the
    // early-return, image→image would land in the boundary-clear
    // branch and destroy the uploaded data URL.
    const imageBlock: SlideBlock = {
      id: "noop-img",
      type: "image",
      content: "data:image/png;base64,KEEPME",
      alt: "logo",
    };
    expect(nextBlockForTypeChange(imageBlock, "image")).toBe(imageBlock);
    const textBlock: SlideBlock = {
      id: "noop-text",
      type: "text",
      content: "hello",
    };
    expect(nextBlockForTypeChange(textBlock, "text")).toBe(textBlock);
    const diagramBlock: SlideBlock = {
      id: "noop-diag",
      type: "diagram",
      content: "graph TD; A-->B",
    };
    expect(nextBlockForTypeChange(diagramBlock, "diagram")).toBe(diagramBlock);
    const bulletsBlock: SlideBlock = {
      id: "noop-bul",
      type: "bullets",
      content: "- one\n- two",
    };
    expect(nextBlockForTypeChange(bulletsBlock, "bullets")).toBe(bulletsBlock);
  });

  it("preserves block.id across every type transition (PR #82 round 3 spread-invariant)", () => {
    // Pins the "spread copies id, then named overrides only touch
    // type/content/alt" contract that Devin Review flagged
    // (ANALYSIS_0005). Without this regression, a future contributor
    // could accidentally add `id: newSlideId("block")` after the
    // spread in `nextBlockForTypeChange` and silently break React's
    // key stability across type changes (the `<textarea>` would lose
    // cursor / selection state on every type select).
    const types: SlideBlock["type"][] = [
      "text",
      "bullets",
      "image",
      "diagram",
    ];
    for (const from of types) {
      for (const to of types) {
        if (from === to) continue; // same-type is the ref-stable no-op branch
        const src: SlideBlock =
          from === "image"
            ? {
                id: `pin-id-${from}-${to}`,
                type: "image",
                content: "data:image/png;base64,AAAA",
                alt: "carry me",
              }
            : {
                id: `pin-id-${from}-${to}`,
                type: from,
                content: "anything",
              };
        const next = nextBlockForTypeChange(src, to);
        expect(next.id, `${from} → ${to} must preserve id`).toBe(
          `pin-id-${from}-${to}`,
        );
        expect(next.type).toBe(to);
      }
    }
  });
});

describe("slideWordCount", () => {
  it("sums words across title, blocks, and notes", () => {
    const slide: Slide = {
      id: "test-ms-20",
      title: "Hello world",
      blocks: [
        { id: "test-b-55", type: "text", content: "foo bar baz" },
        { id: "test-b-56", type: "bullets", content: "one two" },
      ],
      notes: "speaker note here",
    };
    // title=2 + text=3 + bullets=2 + notes=3 = 10
    expect(slideWordCount(slide)).toBe(10);
  });

  it("collapses runs of whitespace (does not over-count)", () => {
    const slide: Slide = {
      id: "test-ms-21",
      title: "foo  bar   baz",
      blocks: [],
      notes: "",
    };
    expect(slideWordCount(slide)).toBe(3);
  });

  it("counts image-block alt text, not the data URL", () => {
    const slide: Slide = {
      id: "test-ms-22",
      title: "",
      blocks: [
        {
          id: "test-mb-9",
          type: "image",
          content: "data:image/png;base64,iVBORw0KGgo=",
          alt: "Architecture diagram showing flow",
        },
      ],
      notes: "",
    };
    // alt = 4 words. content (data URL) MUST contribute 0.
    expect(slideWordCount(slide)).toBe(4);
  });

  it("returns 0 for an empty slide", () => {
    expect(
      slideWordCount({ id: "test-s-8", title: "", blocks: [], notes: "" }),
    ).toBe(0);
  });
});

describe("deckWordCount", () => {
  it("sums slideWordCount across the deck", () => {
    const a = slideOf("A B", "one two three");
    const b = slideOf("X", "", "speaker note");
    // a: title=2 + content=3 = 5; b: title=1 + notes=2 = 3 → total 8.
    expect(deckWordCount([a, b])).toBe(8);
  });

  it("returns 0 for an empty deck", () => {
    expect(deckWordCount([])).toBe(0);
  });
});

describe("findInSlides", () => {
  it("returns no matches for an empty query (avoids exponential blowup)", () => {
    const slide = slideOf("Hello", "world");
    expect(findInSlides([slide], "")).toEqual([]);
  });

  it("finds matches in title, blocks, and notes in deck order", () => {
    const slides: Slide[] = [
      {
        id: "test-ms-23",
        title: "foo bar",
        blocks: [
          { id: "test-b-57", type: "text", content: "foo block" },
          { id: "test-b-58", type: "bullets", content: "another foo here" },
        ],
        notes: "final foo in notes",
      },
      slideOf("second slide foo", "unrelated"),
    ];
    const matches = findInSlides(slides, "foo");
    expect(matches).toHaveLength(5);
    // First match is in slide 0 title.
    expect(matches[0]).toMatchObject({ slideIndex: 0, location: "title" });
    expect(matches[1]).toMatchObject({
      slideIndex: 0,
      location: { kind: "block", blockIndex: 0 },
    });
    expect(matches[2]).toMatchObject({
      slideIndex: 0,
      location: { kind: "block", blockIndex: 1 },
    });
    expect(matches[3]).toMatchObject({ slideIndex: 0, location: "notes" });
    expect(matches[4]).toMatchObject({ slideIndex: 1, location: "title" });
  });

  it("is case-insensitive by default", () => {
    const slide = slideOf("Hello", "world");
    const matches = findInSlides([slide], "HELLO");
    expect(matches).toHaveLength(1);
    expect(matches[0].length).toBe(5);
  });

  it("honors caseSensitive: true", () => {
    const slide = slideOf("Hello", "world");
    expect(findInSlides([slide], "HELLO", { caseSensitive: true })).toEqual([]);
    expect(
      findInSlides([slide], "Hello", { caseSensitive: true }),
    ).toHaveLength(1);
  });

  it("walks forward by needle.length so it never matches overlapping occurrences", () => {
    // Find/replace UX convention: matches do NOT overlap. 'aaa' inside
    // 'aaaaa' should produce exactly one match starting at 0 — the
    // remaining 'aa' is too short for another non-overlapping hit.
    // (An overlapping walk would have reported offsets [0, 1, 2] which
    // is never what a user wants from a find dialog.)
    const slide = slideOf("", "aaaaa");
    const matches = findInSlides([slide], "aaa");
    expect(matches.map((m) => m.offset)).toEqual([0]);
  });

  it("finds two non-overlapping matches when the haystack is long enough", () => {
    // 'aaa' inside 'aaaaaa' (6 chars) has room for two non-overlapping
    // hits at offsets 0 and 3.
    const slide = slideOf("", "aaaaaa");
    const matches = findInSlides([slide], "aaa");
    expect(matches.map((m) => m.offset)).toEqual([0, 3]);
  });

  it("searches image-block alt text, not the data URL", () => {
    const slide: Slide = {
      id: "test-ms-24",
      title: "",
      blocks: [
        {
          id: "test-mb-10",
          type: "image",
          content: "data:image/png;base64,iVBORw0KGgo=",
          alt: "architecture diagram",
        },
      ],
      notes: "",
    };
    // Match against alt — should hit
    expect(findInSlides([slide], "architecture")).toHaveLength(1);
    // Match against data URL substring — should NOT hit
    expect(findInSlides([slide], "base64")).toEqual([]);
  });

  it("returns multiple matches in a single field", () => {
    const slide = slideOf("foo and foo and foo", "");
    const matches = findInSlides([slide], "foo");
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.offset)).toEqual([0, 8, 16]);
    expect(matches.every((m) => m.location === "title")).toBe(true);
  });

  it("reports correct offset and length", () => {
    const slide = slideOf("", "xxx hello xxx");
    const matches = findInSlides([slide], "hello");
    expect(matches).toHaveLength(1);
    expect(matches[0].offset).toBe(4);
    expect(matches[0].length).toBe(5);
  });
});
