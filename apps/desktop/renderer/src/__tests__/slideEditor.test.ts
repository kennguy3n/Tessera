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
  moveSlide,
  backfillSlideIds,
  removeBlock,
  discardUploadTokensForSlide,
  discardUploadTokensForBlock,
  uploadTokenKey,
  appendBlock,
  replaceBlock,
  buildBlock,
  slideWordCount,
  deckWordCount,
  computeDeckWordCounts,
  findInSlides,
  nextBlockForTypeChange,
  slideBodyLines,
  buildPresentationSlides,
  DEFAULT_DIAGRAM_DSL,
  DEFAULT_TABLE_MD,
  DEFAULT_CHART_DSL,
  parseSlideTable,
  tableToMarkdown,
  parseSlideChart,
  chartToMarkdownTable,
} from "../editors/slideEditorHelpers";
import type {
  Slide,
  SlideBlock,
  SlideContent,
} from "../editors/slideEditorTypes";

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
        {
          id: "test-s-1",
          title: "Hello",
          blocks: [{ id: "test-b-1", type: "text", content: "body" }],
          notes: "",
        },
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
        {
          id: "test-s-2",
          title: "Hello",
          blocks: [{ id: "test-b-2", type: "text", content: "body" }],
          notes: "",
        },
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
      {
        id: "test-s-3",
        title: "T",
        blocks: [{ id: "test-b-3", type: "text", content: "x" }],
        notes: "",
      },
    ]);
    expect(out.startsWith("---\nmarp: true\n")).toBe(true);
    expect(out).toMatch(
      /^---\nmarp: true\ntheme: 'default'\npaginate: true\n---/,
    );
  });

  it("respects a non-default theme override", () => {
    const out = slidesToMarpMarkdown(
      [
        {
          id: "test-s-4",
          title: "T",
          blocks: [{ id: "test-b-4", type: "text", content: "x" }],
          notes: "",
        },
      ],
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
          {
            id: "test-b-6",
            type: "bullets",
            content: "alpha\n- beta\n* gamma",
          },
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
    // Regression test for :
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
          {
            id: "test-b-8",
            type: "image",
            content: "https://example.com/x.png",
          },
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
    // Regression test for Wikipedia / Mediawiki / SharePoint URLs commonly
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
    expect(out).toContain("![](<https://example.com/path with spaces.png>)");
  });

  it("skips empty blocks and slides without titles cleanly", () => {
    const out = slidesToMarpMarkdown([
      {
        id: "test-s-5",
        title: "",
        blocks: [{ id: "test-b-9", type: "text", content: "" }],
        notes: "",
      },
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
    // Layout engine adds a <!-- _class: ... --> comment before each heading.
    expect(out).toMatch(/\n---\n\n<!-- _class: layout-\w+ -->\n\n# First\n/);
    expect(out).toMatch(/\n---\n\n<!-- _class: layout-\w+ -->\n\n# Second\n/);
    expect(out).toMatch(/\n---\n\n<!-- _class: layout-\w+ -->\n\n# Third\n/);

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
    // The layout comment emits one `-->` per slide (from `<!-- _class: ... -->`).
    // The ONLY additional `-->` should be the notes comment terminator.
    // Count layout-class `-->` and the notes terminator separately.
    const layoutCommentCount = (out.match(/<!-- _class: layout-\w+ -->/g) ?? [])
      .length;
    const totalArrows = (out.match(/-->/g) ?? []).length;
    // Exactly one notes `-->` beyond the per-slide layout comments.
    expect(totalArrows - layoutCommentCount).toBe(1);
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
    expect(extractFrontmatterTheme("---\ntheme: 'uncover'\n---")).toBe(
      "uncover",
    );
    expect(extractFrontmatterTheme('---\ntheme: "default"\n---')).toBe(
      "default",
    );
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
    const src =
      "---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# Slide";
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
    expect(out.startsWith("---\nmarp: true\ntheme: gaia\n---\n\n")).toBe(true);
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
// slide UX helpers
// ─────────────────────────────────────────────────────────────────────

let __slideOfCounter = 0;
function slideOf(title: string, content: string, notes = ""): Slide {
  __slideOfCounter += 1;
  return {
    id: `slideOf-s-${__slideOfCounter}`,
    title,
    blocks: [{ id: `slideOf-b-${__slideOfCounter}`, type: "text", content }],
    notes,
  };
}

describe("buildSlideFromLayout", () => {
  it("returns a single empty text block for the blank layout", () => {
    const s = buildSlideFromLayout("blank");
    expect(s.title).toBe("");
    expect(s.blocks).toEqual([
      { id: expect.any(String), type: "text", content: "", slot: "body" },
    ]);
    expect(s.notes).toBe("");
    expect(s.layout).toBe("blank");
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
      { id: expect.any(String), type: "text", content: "", slot: "body" },
    ]);
    expect(s.layout).toBe("titleContent");
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
      slot: "image",
    });
    expect(s.blocks[1]).toEqual({
      id: expect.any(String),
      type: "text",
      content: "",
      slot: "caption",
    });
    expect(s.layout).toBe("imageCaption");
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

describe("moveSlide", () => {
  // Devin Review PR #82 round 5 — `moveSlide` lacks
  // dedicated unit tests. The helper has non-trivial logic
  // (bounds checking, splice-based reorder, reference-stable
  // no-op contract) that SlideEditor.tsx relies on; pin it.
  const sampleSlides = (): Slide[] => [
    { id: "slide-a", title: "A", blocks: [], notes: "" },
    { id: "slide-b", title: "B", blocks: [], notes: "" },
    { id: "slide-c", title: "C", blocks: [], notes: "" },
    { id: "slide-d", title: "D", blocks: [], notes: "" },
  ];

  it("moves a slide to a later position", () => {
    const next = moveSlide(sampleSlides(), 0, 2);
    expect(next.map((s) => s.id)).toEqual([
      "slide-b",
      "slide-c",
      "slide-a",
      "slide-d",
    ]);
  });

  it("moves a slide to an earlier position", () => {
    const next = moveSlide(sampleSlides(), 3, 0);
    expect(next.map((s) => s.id)).toEqual([
      "slide-d",
      "slide-a",
      "slide-b",
      "slide-c",
    ]);
  });

  it("returns the same reference when from === to (no-op for setState)", () => {
    const slides = sampleSlides();
    expect(moveSlide(slides, 1, 1)).toBe(slides);
  });

  it("returns the same reference for out-of-range from index", () => {
    const slides = sampleSlides();
    expect(moveSlide(slides, -1, 0)).toBe(slides);
    expect(moveSlide(slides, 99, 0)).toBe(slides);
  });

  it("returns the same reference for out-of-range to index", () => {
    const slides = sampleSlides();
    expect(moveSlide(slides, 0, -1)).toBe(slides);
    expect(moveSlide(slides, 0, 99)).toBe(slides);
  });

  it("does not mutate the input array", () => {
    const slides = sampleSlides();
    moveSlide(slides, 0, 3);
    expect(slides.map((s) => s.id)).toEqual([
      "slide-a",
      "slide-b",
      "slide-c",
      "slide-d",
    ]);
  });

  it("preserves slide object identity for slides that don't move", () => {
    const slides = sampleSlides();
    const next = moveSlide(slides, 0, 1);
    // slide-c and slide-d aren't involved in the swap so their
    // object references should pass through unchanged.
    expect(next[2]).toBe(slides[2]);
    expect(next[3]).toBe(slides[3]);
  });
});

describe("backfillSlideIds", () => {
  // Devin Review PR #82 round 5 — companion to the
  // `moveSlide` pin. `backfillSlideIds` is exercised indirectly
  // through `parseSlideContent`, but the migration / lazy-clone
  // contract is worth pinning directly so future refactors
  // can't silently break the "already-migrated decks return the
  // input reference" optimisation that React relies on.

  it("returns the input reference when every slide and block already has an id", () => {
    const slides: Slide[] = [
      {
        id: "slide-a",
        title: "A",
        blocks: [{ id: "block-1", type: "text", content: "hello" }],
        notes: "",
      },
      {
        id: "slide-b",
        title: "B",
        blocks: [],
        notes: "",
      },
    ];
    expect(backfillSlideIds(slides)).toBe(slides);
  });

  it("mints ids for slides missing them while preserving slides that already have one", () => {
    const slides = [
      { id: "slide-a", title: "A", blocks: [], notes: "" },
      { id: "", title: "B", blocks: [], notes: "" },
      { id: "slide-c", title: "C", blocks: [], notes: "" },
    ] as unknown as Slide[];
    const next = backfillSlideIds(slides);
    expect(next).not.toBe(slides);
    expect(next[0].id).toBe("slide-a");
    expect(next[1].id).toMatch(/^slide-/);
    expect(next[1].id).not.toBe("");
    expect(next[2].id).toBe("slide-c");
    // Slides that already had ids should pass through unchanged.
    expect(next[0]).toBe(slides[0]);
    expect(next[2]).toBe(slides[2]);
  });

  it("mints ids for blocks missing them while preserving blocks that already have one", () => {
    const slides = [
      {
        id: "slide-a",
        title: "A",
        blocks: [
          { id: "block-1", type: "text", content: "a" },
          { id: "", type: "text", content: "b" },
          { id: "block-3", type: "text", content: "c" },
        ],
        notes: "",
      },
    ] as unknown as Slide[];
    const next = backfillSlideIds(slides);
    expect(next).not.toBe(slides);
    expect(next[0].blocks[0].id).toBe("block-1");
    expect(next[0].blocks[1].id).toMatch(/^block-/);
    expect(next[0].blocks[1].id).not.toBe("");
    expect(next[0].blocks[2].id).toBe("block-3");
    // Blocks that already had ids should pass through unchanged.
    expect(next[0].blocks[0]).toBe(slides[0].blocks[0]);
    expect(next[0].blocks[2]).toBe(slides[0].blocks[2]);
  });

  it("does not mutate the input array or input slides", () => {
    const slides = [
      { id: "", title: "A", blocks: [], notes: "" },
    ] as unknown as Slide[];
    const inputCopyId = slides[0].id;
    backfillSlideIds(slides);
    // The original slide must still have its empty id — the
    // function returns a new array with the migrated slide,
    // it does not mutate the source.
    expect(slides[0].id).toBe(inputCopyId);
  });

  it("backfills nested blocks even when the parent slide has an id", () => {
    // The lazy-clone contract has to handle the case where the
    // outer array doesn't need to clone but an inner block does
    // — verify the slide is still cloned (because its `.blocks`
    // changed) but the outer `nextSlides` array clones only as
    // needed.
    const slides = [
      { id: "slide-ok", title: "OK", blocks: [], notes: "" },
      {
        id: "slide-mixed",
        title: "Mixed",
        blocks: [{ id: "", type: "text", content: "needs id" }],
        notes: "",
      },
    ] as unknown as Slide[];
    const next = backfillSlideIds(slides);
    expect(next).not.toBe(slides);
    expect(next[0]).toBe(slides[0]);
    expect(next[1]).not.toBe(slides[1]);
    expect(next[1].blocks[0].id).toMatch(/^block-/);
  });

  it("returns the input reference when given an empty array", () => {
    const slides: Slide[] = [];
    expect(backfillSlideIds(slides)).toBe(slides);
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

describe("uploadTokenKey / discardUploadTokensForSlide / discardUploadTokensForBlock", () => {
  // PR #82 round 7 ANALYSIS_…_0003: `SlideEditor` keeps a
  // `Map<"${slideId}|${blockId}", number>` to disambiguate concurrent
  // FileReader reads (race-guard pattern: latest token wins, stale
  // completions drop). Without an explicit cleanup path the Map grew
  // forever — a long edit session that added & deleted many image
  // blocks would let it accumulate dead entries. These tests pin the
  // helper contract so a future refactor can't silently re-introduce
  // the leak by reverting the wiring in `removeSlide` / `onBlockRemove`.

  it("uploadTokenKey concatenates slide + block ids with the | sentinel", () => {
    expect(uploadTokenKey("slide-1", "block-2")).toBe("slide-1|block-2");
  });

  it("uploadTokenKey accepts any string \u2014 callers pass raw ids without sanitising", () => {
    // The keys are internal Map keys, not URL-safe slugs. We only need
    // the encoding to be injective per (slideId, blockId) pair, which
    // the | sentinel achieves because the id generator (`newSlideId`)
    // never emits |.
    expect(uploadTokenKey("a", "b")).not.toBe(uploadTokenKey("ab", ""));
    expect(uploadTokenKey("", "ab")).not.toBe(uploadTokenKey("a", "b"));
  });

  it("discardUploadTokensForSlide drops every block-keyed entry for the slide", () => {
    const tokens = new Map<string, number>([
      [uploadTokenKey("s-1", "b-1"), 1],
      [uploadTokenKey("s-1", "b-2"), 2],
      [uploadTokenKey("s-2", "b-3"), 3],
    ]);
    const slide: Slide = {
      id: "s-1",
      title: "T",
      blocks: [
        { id: "b-1", type: "image", content: "data:image/png;base64,..." },
        { id: "b-2", type: "image", content: "data:image/png;base64,..." },
      ],
      notes: "",
    };
    discardUploadTokensForSlide(tokens, slide.id, slide.blocks);
    // Entries for slide s-1 are gone; the unrelated s-2 entry survives.
    expect(tokens.has(uploadTokenKey("s-1", "b-1"))).toBe(false);
    expect(tokens.has(uploadTokenKey("s-1", "b-2"))).toBe(false);
    expect(tokens.has(uploadTokenKey("s-2", "b-3"))).toBe(true);
    expect(tokens.size).toBe(1);
  });

  it("discardUploadTokensForSlide ignores blocks that never had a token", () => {
    // The race-guard Map only gets an entry when an upload starts, so a
    // text-only slide can hit the cleanup path with zero matching keys.
    // Cleanup must be a silent no-op in that case (no throw).
    const tokens = new Map<string, number>([[uploadTokenKey("other", "x"), 7]]);
    const slide: Slide = {
      id: "s-empty",
      title: "T",
      blocks: [{ id: "b-text", type: "text", content: "no upload here" }],
      notes: "",
    };
    expect(() =>
      discardUploadTokensForSlide(tokens, slide.id, slide.blocks),
    ).not.toThrow();
    expect(tokens.size).toBe(1);
    expect(tokens.get(uploadTokenKey("other", "x"))).toBe(7);
  });

  it("discardUploadTokensForSlide on a slide with zero blocks is a no-op", () => {
    // `removeBlock` is allowed to leave a slide with `blocks: []`
    // (title-only layout). When that empty slide is later deleted,
    // cleanup must not throw on the empty iterable.
    const tokens = new Map<string, number>([[uploadTokenKey("other", "x"), 1]]);
    discardUploadTokensForSlide(tokens, "s-empty", []);
    expect(tokens.size).toBe(1);
  });

  it("discardUploadTokensForBlock drops only the targeted block's entry", () => {
    const tokens = new Map<string, number>([
      [uploadTokenKey("s-1", "b-1"), 1],
      [uploadTokenKey("s-1", "b-2"), 2],
      [uploadTokenKey("s-1", "b-3"), 3],
    ]);
    const slide: Slide = {
      id: "s-1",
      title: "T",
      blocks: [
        { id: "b-1", type: "text", content: "" },
        { id: "b-2", type: "image", content: "data:image/png;..." },
        { id: "b-3", type: "text", content: "" },
      ],
      notes: "",
    };
    discardUploadTokensForBlock(tokens, slide, 1);
    // Only the middle block's token is freed; siblings survive.
    expect(tokens.has(uploadTokenKey("s-1", "b-1"))).toBe(true);
    expect(tokens.has(uploadTokenKey("s-1", "b-2"))).toBe(false);
    expect(tokens.has(uploadTokenKey("s-1", "b-3"))).toBe(true);
  });

  it("discardUploadTokensForBlock is a silent no-op for out-of-range indices", () => {
    // Defence-in-depth: even though the caller in `SlideEditor.tsx`
    // already early-returns on `removeBlockHelper(slide, …) === slide`,
    // the helper itself must tolerate a stale index without throwing
    // (e.g. a future caller that calls the helper before the helper
    // runs the bounds check).
    const tokens = new Map<string, number>([[uploadTokenKey("s-1", "b-1"), 1]]);
    const slide: Slide = {
      id: "s-1",
      title: "T",
      blocks: [{ id: "b-1", type: "text", content: "" }],
      notes: "",
    };
    expect(() => discardUploadTokensForBlock(tokens, slide, -1)).not.toThrow();
    expect(() => discardUploadTokensForBlock(tokens, slide, 99)).not.toThrow();
    expect(tokens.size).toBe(1);
  });

  it("discardUploadTokensForBlock on a block that never had a token is a no-op", () => {
    const tokens = new Map<string, number>([[uploadTokenKey("other", "x"), 5]]);
    const slide: Slide = {
      id: "s-1",
      title: "T",
      blocks: [{ id: "b-text", type: "text", content: "" }],
      notes: "",
    };
    discardUploadTokensForBlock(tokens, slide, 0);
    expect(tokens.size).toBe(1);
    expect(tokens.get(uploadTokenKey("other", "x"))).toBe(5);
  });
});

describe("buildBlock", () => {
  // Harmonisation regression:
  // `buildBlock`, `appendBlock`, and `replaceBlock` must all treat
  // empty-string id the same way (= "missing"), so the id-injection
  // policy is uniform from construction through mutation. Without
  // alignment, `buildBlock` would have used `??` and kept "" while
  // `appendBlock`/`replaceBlock` (truthiness) would have regenerated
  // it — a surprising mid-pipeline mutation that breaks ref equality.

  it("preserves a non-empty id supplied by the caller", () => {
    const block = buildBlock({
      id: "caller-supplied-1",
      type: "text",
      content: "hi",
    });
    expect(block.id).toBe("caller-supplied-1");
  });

  it("mints a new id when the caller omits one", () => {
    const block = buildBlock({ type: "text", content: "hi" });
    expect(block.id).toMatch(/^block-/);
    expect(block.id.length).toBeGreaterThan(6);
  });

  it("mints a new id when the caller passes an empty-string id (harmonised with appendBlock/replaceBlock)", () => {
    const block = buildBlock({ id: "", type: "text", content: "hi" });
    expect(block.id).not.toBe("");
    expect(block.id).toMatch(/^block-/);
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
    expect(
      replaceBlock(slide, 5, { id: "test-b-48", type: "text", content: "x" }),
    ).toBe(slide);
    expect(
      replaceBlock(slide, -1, { id: "test-b-49", type: "text", content: "x" }),
    ).toBe(slide);
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
    // The "second layer of defence" Devin Review called out: if a future call site builds a replacement
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
    const replacement = {
      type: "bullets",
      content: "new",
    } as unknown as SlideBlock;
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
  // boundary on PR #81 round 2) and when entering `diagram`
  // for the first time.

  it("clears content when switching FROM an image block", () => {
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
    const emptyText: SlideBlock = {
      id: "test-b-51",
      type: "text",
      content: "",
    };
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

  it("seeds the table / chart starters only when content is empty", () => {
    const emptyText: SlideBlock = { id: "seed-t", type: "text", content: "" };
    expect(nextBlockForTypeChange(emptyText, "table").content).toBe(
      DEFAULT_TABLE_MD,
    );
    expect(nextBlockForTypeChange(emptyText, "chart").content).toBe(
      DEFAULT_CHART_DSL,
    );
    // Existing prose survives the switch — never clobber the user's work.
    const existing: SlideBlock = {
      id: "seed-t2",
      type: "text",
      content: "Q1 10 Q2 14",
    };
    expect(nextBlockForTypeChange(existing, "table").content).toBe(
      "Q1 10 Q2 14",
    );
    expect(nextBlockForTypeChange(existing, "chart").content).toBe(
      "Q1 10 Q2 14",
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
    const textWithoutAlt: SlideBlock = {
      id: "test-b-54",
      type: "text",
      content: "x",
    };
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
    // type/content/alt" contract that Devin Review flagged. Without this regression, a future contributor
    // could accidentally add `id: newSlideId("block")` after the
    // spread in `nextBlockForTypeChange` and silently break React's
    // key stability across type changes (the `<textarea>` would lose
    // cursor / selection state on every type select).
    const types: SlideBlock["type"][] = [
      "text",
      "bullets",
      "image",
      "diagram",
      "table",
      "chart",
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

describe("computeDeckWordCounts", () => {
  // perf helper. The SlideEditor toolbar reads
  // `<active> / <total>` on every render, which previously walked
  // every slide twice per keystroke. `computeDeckWordCounts` is the
  // single-pass replacement with optional WeakMap caching.

  it("returns per-slide AND deck-total counts in one pass", () => {
    const a = slideOf("A B", "one two three");
    const b = slideOf("X", "", "speaker note");
    const c = slideOf("", "foo bar baz quux");
    const result = computeDeckWordCounts([a, b, c]);
    // a=5, b=3, c=4 → total 12.
    expect(result.perSlide).toEqual([5, 3, 4]);
    expect(result.total).toBe(12);
  });

  it("matches `slideWordCount` per slide AND `deckWordCount` total exactly", () => {
    // Pin: the new helper MUST agree with the existing helpers slot-by-slot.
    // Otherwise a switch to it would cause the user-visible toolbar number
    // to disagree with itself across the change. Property-style cross-check
    // over a 4-slide deck.
    const slides: Slide[] = [
      slideOf("Alpha", "one two"),
      slideOf("Beta gamma", "three four five", "a note"),
      slideOf("", "", "only notes here"),
      slideOf("D", ""),
    ];
    const result = computeDeckWordCounts(slides);
    for (let i = 0; i < slides.length; i += 1) {
      expect(result.perSlide[i]).toBe(slideWordCount(slides[i]));
    }
    expect(result.total).toBe(deckWordCount(slides));
  });

  it("returns empty perSlide + total=0 for an empty deck", () => {
    const result = computeDeckWordCounts([]);
    expect(result.perSlide).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("hits the cache for unchanged Slide references across renders", () => {
    // The whole point of the optional cache is that an immutable
    // update which keeps unchanged Slide objects by reference can
    // skip re-walking them. Counter pattern: wrap `slideWordCount`
    // behaviour by inserting bogus cache entries and verifying the
    // returned counts come from the cache (not from a fresh walk).
    const a: Slide = { id: "a", title: "a b", blocks: [], notes: "" }; // real = 2
    const b: Slide = { id: "b", title: "c d", blocks: [], notes: "" }; // real = 2
    const cache = new WeakMap<Slide, number>();
    // Pre-seed with a deliberately wrong count so we can observe the
    // helper returning the cached value rather than recomputing.
    cache.set(a, 999);
    const result = computeDeckWordCounts([a, b], cache);
    expect(result.perSlide[0]).toBe(999); // came from the cache
    expect(result.perSlide[1]).toBe(2); // freshly computed + stored
    expect(result.total).toBe(1001);
    // After the run, b should now be cached at the freshly-computed
    // value so a second run is fully cache-served.
    expect(cache.get(b)).toBe(2);
  });

  it("computes and caches new Slide references encountered on subsequent calls", () => {
    // Simulates the keystroke-on-deck pattern: render N=1 with a
    // single slide → second render the user adds a slide → only the
    // new slide must be walked.
    const a: Slide = { id: "a", title: "alpha beta", blocks: [], notes: "" }; // 2 words
    const cache = new WeakMap<Slide, number>();
    computeDeckWordCounts([a], cache);
    expect(cache.get(a)).toBe(2);

    // New slide added.
    const b: Slide = { id: "b", title: "x y z", blocks: [], notes: "" }; // 3 words
    const result = computeDeckWordCounts([a, b], cache);
    expect(result.perSlide).toEqual([2, 3]);
    expect(result.total).toBe(5);
    expect(cache.get(b)).toBe(3);
  });

  it("does not poison the cache when called WITHOUT a cache (cache arg optional)", () => {
    const slide: Slide = {
      id: "x",
      title: "alpha",
      blocks: [],
      notes: "",
    };
    const result = computeDeckWordCounts([slide]); // no cache passed
    expect(result.perSlide).toEqual([1]);
    expect(result.total).toBe(1);
  });

  it("treats a cached value of 0 as a hit (defensive against `=== undefined` regression)", () => {
    // round 3 — pinning test for.
    // `slideWordCount({ title:'', blocks:[], notes:'' })` legitimately
    // returns 0, so the cache lookup must distinguish "not in cache"
    // (undefined) from "cached value is zero". A falsy check (`!count`)
    // would silently treat the zero as a miss and recompute every
    // render, defeating the optimisation on every empty slide in the
    // deck.
    const empty: Slide = { id: "e", title: "", blocks: [], notes: "" }; // real = 0
    const full: Slide = { id: "f", title: "a b c", blocks: [], notes: "" }; // real = 3
    const cache = new WeakMap<Slide, number>();
    // Pre-seed the empty slide's REAL value (0) — same shape as what
    // a previous render would have stored. Pre-seed the full slide
    // with a deliberately-wrong value so we can distinguish "the
    // helper hit our cache for empty" from "the helper recomputed
    // and happened to get 0 anyway".
    cache.set(empty, 0);
    cache.set(full, 42); // wrong on purpose
    const result = computeDeckWordCounts([empty, full], cache);
    // If the helper used a falsy check, it would have recomputed
    // `empty` and gotten 0 — same value, indistinguishable from a
    // cache hit. The `full` slot disambiguates: a hit on `full`
    // returns 42 (the seeded value), proving the cache is being
    // consulted via `=== undefined` (not falsy).
    expect(result.perSlide[0]).toBe(0); // hit on cache, not recompute
    expect(result.perSlide[1]).toBe(42); // hit on cache (deliberately wrong seed)
    expect(result.total).toBe(42);
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

describe("slideBodyLines / buildPresentationSlides", () => {
  const slide = (over: Partial<Slide>): Slide => ({
    id: "s1",
    title: "Title",
    blocks: [],
    notes: "",
    ...over,
  });

  it("flattens text and bullets to one line per non-blank source line", () => {
    const s = slide({
      blocks: [
        { id: "b1", type: "text", content: "one\n\ntwo" },
        { id: "b2", type: "bullets", content: "a\nb\n" },
      ],
    });
    expect(slideBodyLines(s)).toEqual(["one", "two", "a", "b"]);
  });

  it("labels diagram and image blocks (with alt) as placeholders", () => {
    const s = slide({
      blocks: [
        { id: "b1", type: "diagram", content: "flowchart LR\nA-->B" },
        {
          id: "b2",
          type: "image",
          content: "data:image/png;base64,xxx",
          alt: "Chart",
        },
        { id: "b3", type: "image", content: "data:image/png;base64,yyy" },
      ],
    });
    expect(slideBodyLines(s)).toEqual([
      "[Diagram]",
      "[Image: Chart]",
      "[Image]",
    ]);
  });

  it("labels table and chart blocks as placeholders, not raw DSL", () => {
    const s = slide({
      blocks: [
        { id: "b1", type: "table", content: "| a | b |\n| --- | --- |" },
        {
          id: "b2",
          type: "chart",
          content: "type: bar\ntitle: Revenue\nlabels: Q1\nR: 1",
        },
        { id: "b3", type: "chart", content: "labels: Q1\nR: 1" },
      ],
    });
    expect(slideBodyLines(s)).toEqual([
      "[Table]",
      "[Chart: Revenue]",
      "[Chart]",
    ]);
  });

  it("builds the IPC payload preserving title, lines, and notes", () => {
    const deck = [
      slide({
        title: "Intro",
        notes: "hi",
        blocks: [{ id: "b", type: "text", content: "x" }],
      }),
      slide({ id: "s2", title: "End", notes: "" }),
    ];
    expect(buildPresentationSlides(deck)).toEqual([
      { title: "Intro", lines: ["x"], notes: "hi" },
      { title: "End", lines: [], notes: "" },
    ]);
  });
});

describe("parseSlideTable", () => {
  it("parses a GFM pipe table and drops the alignment separator", () => {
    const table = parseSlideTable(
      "| Metric | Q1 | Q2 |\n| --- | :--: | --: |\n| Revenue | 10 | 14 |",
    );
    expect(table).toEqual({
      header: ["Metric", "Q1", "Q2"],
      rows: [["Revenue", "10", "14"]],
    });
  });

  it("tolerates missing outer pipes and a missing separator row", () => {
    const table = parseSlideTable("a | b\n1 | 2");
    expect(table).toEqual({ header: ["a", "b"], rows: [["1", "2"]] });
  });

  it("pads ragged rows to the widest row width", () => {
    const table = parseSlideTable("| a | b | c |\n| 1 | 2 |");
    expect(table?.header).toEqual(["a", "b", "c"]);
    expect(table?.rows).toEqual([["1", "2", ""]]);
  });

  it("unescapes a backslash-escaped pipe inside a cell", () => {
    const table = parseSlideTable("| a \\| b | c |");
    expect(table?.header).toEqual(["a | b", "c"]);
  });

  it("keeps an escaped pipe ending a row with no terminator pipe", () => {
    // `a | b \|` ends with an escaped literal pipe, not a terminator, so
    // the trailing strip must not eat it (the second cell is `b |`).
    const table = parseSlideTable("a | b \\|");
    expect(table?.header).toEqual(["a", "b |"]);
  });

  it("preserves a genuinely empty trailing cell", () => {
    // `| a | |` is two cells (the last empty); only the terminator pipe
    // is dropped, not the legitimately empty cell before it.
    const table = parseSlideTable("| a | |");
    expect(table?.header).toEqual(["a", ""]);
  });

  it("returns null for content with no usable row", () => {
    expect(parseSlideTable("")).toBeNull();
    expect(parseSlideTable("   \n  ")).toBeNull();
    // A lone separator row carries no data.
    expect(parseSlideTable("| --- | --- |")).toBeNull();
  });

  it("round-trips through tableToMarkdown back to the same table", () => {
    const table = parseSlideTable("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(table).not.toBeNull();
    const md = tableToMarkdown(table!);
    expect(parseSlideTable(md)).toEqual(table);
  });

  it("re-escapes a literal pipe when serialising", () => {
    const md = tableToMarkdown({ header: ["a | b"], rows: [] });
    expect(md.split("\n")[0]).toBe("| a \\| b |");
  });

  it("parses the DEFAULT_TABLE_MD starter", () => {
    const table = parseSlideTable(DEFAULT_TABLE_MD);
    expect(table?.header).toEqual(["Metric", "Q1", "Q2"]);
    expect(table?.rows).toEqual([["Revenue", "10", "14"]]);
  });
});

describe("parseSlideChart", () => {
  it("parses type, title, labels and numeric series", () => {
    const spec = parseSlideChart(
      "type: line\ntitle: Growth\nlabels: Q1, Q2, Q3\nRevenue: 10, 20, 30\nCost: 5, 8, 12",
    );
    expect(spec).toEqual({
      type: "line",
      title: "Growth",
      data: {
        labels: ["Q1", "Q2", "Q3"],
        series: [
          { name: "Revenue", values: [10, 20, 30] },
          { name: "Cost", values: [5, 8, 12] },
        ],
      },
    });
  });

  it("defaults to a bar chart when type is absent or unknown", () => {
    expect(parseSlideChart("labels: A\nX: 1")?.type).toBe("bar");
    expect(parseSlideChart("type: donut\nlabels: A\nX: 1")?.type).toBe("bar");
  });

  it("coerces blanks and tolerates a currency/percent suffix", () => {
    const spec = parseSlideChart("labels: A, B, C\nSales: $1200, , 3.5%");
    expect(spec?.data.series[0].values).toEqual([1200, null, 3.5]);
  });

  it("pads labels to the widest series so every value has a slot", () => {
    const spec = parseSlideChart("labels: A\nX: 1, 2, 3");
    expect(spec?.data.labels).toEqual(["A", "", ""]);
  });

  it("pads short series with nulls so geometry never reads undefined", () => {
    // More labels than values: the series must be padded to the label
    // count with `null`, otherwise the layout helpers read `undefined`
    // and emit NaN SVG coordinates.
    const spec = parseSlideChart("labels: Q1, Q2, Q3, Q4\nRevenue: 10, 14");
    expect(spec?.data.labels).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    expect(spec?.data.series[0].values).toEqual([10, 14, null, null]);
  });

  it("normalises ragged series to a common rectangular width", () => {
    const spec = parseSlideChart("labels: A, B\nX: 1\nY: 1, 2, 3");
    expect(spec?.data.labels).toEqual(["A", "B", ""]);
    expect(spec?.data.series[0].values).toEqual([1, null, null]);
    expect(spec?.data.series[1].values).toEqual([1, 2, 3]);
  });

  it("treats type/title/labels as reserved directives (case-insensitive)", () => {
    // Documents the DSL trade-off: a series may NOT be named after a
    // reserved keyword. The match is case-insensitive, so `Type`,
    // `TITLE`, and `Labels` are all consumed as directives rather than
    // plotted as series — there is no escape that rescues the name; the
    // user must pick a different one. This pins the limitation flagged
    // in review so a future change can't silently alter it.
    const spec = parseSlideChart(
      ["Type: line", "TITLE: Q3", "Labels: A, B", "Revenue: 1, 2"].join("\n"),
    );
    expect(spec?.type).toBe("line");
    expect(spec?.title).toBe("Q3");
    expect(spec?.data.labels).toEqual(["A", "B"]);
    // Only the non-reserved line became a series.
    expect(spec?.data.series).toEqual([{ name: "Revenue", values: [1, 2] }]);
    // Reserved words are matched on the unescaped, lowercased key, so a
    // bare `Labels:` is always the directive — there is no way to plot a
    // series named exactly `labels` / `type` / `title`.
    expect(parseSlideChart("Labels: 10, 20\nX: 1, 2")?.data.series).toEqual([
      { name: "X", values: [1, 2] },
    ]);
    // A leading backslash doesn't recover the name `Labels`: `\L` isn't
    // an escape sequence (only `\,` / `\:` are), so the key stays
    // `\Labels`, lowercases to `\labels`, misses the reservation, and
    // becomes a (differently-named) series rather than the directive.
    // `X` is padded to the 2-wide rectangle (the `\Labels` series sets
    // the width since there's no `labels:` directive here).
    expect(parseSlideChart("\\Labels: 10, 20\nX: 1")?.data.series).toEqual([
      { name: "\\Labels", values: [10, 20] },
      { name: "X", values: [1, null] },
    ]);
  });

  it("treats an escaped comma as a literal inside a label", () => {
    const spec = parseSlideChart("labels: Revenue\\, FY24, Costs\nX: 1, 2");
    expect(spec?.data.labels).toEqual(["Revenue, FY24", "Costs"]);
    expect(spec?.data.series[0].values).toEqual([1, 2]);
  });

  it("treats an escaped colon as a literal inside a series name", () => {
    const spec = parseSlideChart("labels: A, B\nEMEA\\: West: 10, 12");
    expect(spec?.data.series).toEqual([
      { name: "EMEA: West", values: [10, 12] },
    ]);
  });

  it("supports an escaped comma as a thousands separator in a value", () => {
    const spec = parseSlideChart("labels: A, B\nRevenue: 1\\,000, 2\\,500");
    expect(spec?.data.series[0].values).toEqual([1000, 2500]);
  });

  it("unescapes a comma/colon in the title", () => {
    expect(parseSlideChart("title: Q3\\: EMEA\\, West\nX: 1")?.title).toBe(
      "Q3: EMEA, West",
    );
  });

  it("returns null when there is no series line", () => {
    expect(parseSlideChart("type: bar\nlabels: A, B")).toBeNull();
    expect(parseSlideChart("")).toBeNull();
  });

  it("parses the DEFAULT_CHART_DSL starter", () => {
    const spec = parseSlideChart(DEFAULT_CHART_DSL);
    expect(spec?.type).toBe("bar");
    expect(spec?.title).toBe("Quarterly revenue");
    expect(spec?.data.series[0]).toEqual({
      name: "Revenue",
      values: [10, 14, 12, 18],
    });
  });
});

describe("chartToMarkdownTable", () => {
  it("serialises a chart's data to a labelled GFM table", () => {
    const spec = parseSlideChart(
      "type: bar\ntitle: Sales\nlabels: Q1, Q2\nRevenue: 10, 14",
    );
    expect(spec).not.toBeNull();
    const md = chartToMarkdownTable(spec!);
    expect(md).toBe(
      [
        "**Sales**",
        "",
        "|  | Q1 | Q2 |",
        "| --- | --- | --- |",
        "| Revenue | 10 | 14 |",
      ].join("\n"),
    );
  });

  it("emits an empty cell for null values and omits the title row when absent", () => {
    const spec = parseSlideChart("labels: A, B\nX: 1, ");
    const md = chartToMarkdownTable(spec!);
    expect(md.startsWith("|")).toBe(true);
    expect(md).toContain("| X | 1 |  |");
  });

  it("escapes a literal pipe in a label or series name", () => {
    const md = chartToMarkdownTable({
      type: "bar",
      data: {
        labels: ["a | b"],
        series: [{ name: "x | y", values: [1] }],
      },
    });
    expect(md).toContain("|  | a \\| b |");
    expect(md).toContain("| x \\| y | 1 |");
  });

  it("escapes emphasis markers in the title so the bold wrapper survives", () => {
    const md = chartToMarkdownTable({
      type: "bar",
      title: "Revenue **FY24**",
      data: { labels: ["Q1"], series: [{ name: "R", values: [1] }] },
    });
    expect(md.split("\n")[0]).toBe("**Revenue \\*\\*FY24\\*\\***");
  });
});

describe("slidesToMarpMarkdown — table and chart blocks", () => {
  it("emits a table block as a normalised GFM table", () => {
    const out = slidesToMarpMarkdown([
      {
        id: "s1",
        title: "Data",
        notes: "",
        blocks: [{ id: "b1", type: "table", content: "a | b\n1 | 2" }],
      },
    ]);
    expect(out).toContain("| a | b |");
    expect(out).toContain("| --- | --- |");
    expect(out).toContain("| 1 | 2 |");
  });

  it("exports a chart block as its underlying data table", () => {
    const out = slidesToMarpMarkdown([
      {
        id: "s1",
        title: "Trend",
        notes: "",
        blocks: [
          {
            id: "b1",
            type: "chart",
            content: "type: bar\ntitle: Rev\nlabels: Q1, Q2\nR: 3, 7",
          },
        ],
      },
    ]);
    expect(out).toContain("**Rev**");
    expect(out).toContain("| R | 3 | 7 |");
  });

  it("falls back to the raw DSL when a chart block does not parse", () => {
    const out = slidesToMarpMarkdown([
      {
        id: "s1",
        title: "Trend",
        notes: "",
        // No series line — parseSlideChart returns null; content must
        // still survive into the export rather than being dropped.
        blocks: [{ id: "b1", type: "chart", content: "type: bar\nlabels: A" }],
      },
    ]);
    expect(out).toContain("type: bar");
    expect(out).toContain("labels: A");
  });
});
