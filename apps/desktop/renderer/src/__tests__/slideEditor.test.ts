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
} from "../editors/slideEditorHelpers";
import type { Slide, SlideContent } from "../editors/slideEditorTypes";

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
    expect(out).toMatch(/^---\nmarp: true\ntheme: 'default'\npaginate: true\n---/);
  });

  it("respects a non-default theme override", () => {
    const out = slidesToMarpMarkdown(
      [{ title: "T", blocks: [{ type: "text", content: "x" }], notes: "" }],
      { theme: "uncover" },
    );
    expect(out).toContain("theme: 'uncover'");
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

  it("renders image blocks as Markdown image syntax (not raw data URLs)", () => {
    // Regression test for BUG_0001 (Devin Review on PR #81):
    //
    // Before this fix, image blocks fell through to the catch-all
    // `else { parts.push(content); }` branch in `renderSlideAsMarp`,
    // so an image block's data URL was emitted as a bare paragraph in
    // the Marp source. The PPTX export pipeline (Marp CLI) then
    // rendered it as visible text instead of an `<img>` element, and
    // the data URL leaked into the slide body. Rendering the block as
    // `![alt](url)` lets Marp emit a real image. Brackets in alt text
    // are stripped so they cannot prematurely close the `[...]` group.
    const out = slidesToMarpMarkdown([
      {
        title: "Cover",
        blocks: [
          {
            type: "image",
            content: "data:image/png;base64,iVBORw0KGgo=",
            alt: "Company logo [v2]",
          },
          { type: "image", content: "https://example.com/x.png" },
        ],
        notes: "",
      },
    ]);
    expect(out).toContain(
      "![Company logo v2](data:image/png;base64,iVBORw0KGgo=)",
    );
    expect(out).toContain("![](https://example.com/x.png)");
    // The raw data URL must never appear outside the image-syntax
    // parentheses (i.e. no standalone paragraph dump).
    expect(out).not.toMatch(/^data:image\//m);
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

  it("emits `---` separators between slides so multi-slide PPTX exports keep their slide boundaries", () => {
    // Regression test:
    // without `---` separators Marp collapses every following slide into the
    // first one, producing a 1-slide PPTX no matter how many slides were
    // authored in the WYSIWYG editor.
    const out = slidesToMarpMarkdown([
      {
        title: "First",
        blocks: [{ type: "text", content: "alpha" }],
        notes: "",
      },
      {
        title: "Second",
        blocks: [{ type: "text", content: "beta" }],
        notes: "",
      },
      {
        title: "Third",
        blocks: [{ type: "text", content: "gamma" }],
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
        title: "Hostile",
        blocks: [{ type: "text", content: "body" }],
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

function slideOf(title: string, content: string, notes = ""): Slide {
  return { title, blocks: [{ type: "text", content }], notes };
}

describe("buildSlideFromLayout", () => {
  it("returns a single empty text block for the blank layout", () => {
    const s = buildSlideFromLayout("blank");
    expect(s.title).toBe("");
    expect(s.blocks).toEqual([{ type: "text", content: "" }]);
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
    expect(s.blocks).toEqual([{ type: "text", content: "" }]);
  });

  it("returns two text blocks for the twoColumn layout", () => {
    const s = buildSlideFromLayout("twoColumn");
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks.every((b) => b.type === "text")).toBe(true);
  });

  it("returns an image+caption pair for the imageCaption layout", () => {
    const s = buildSlideFromLayout("imageCaption");
    expect(s.blocks).toHaveLength(2);
    expect(s.blocks[0]).toEqual({ type: "image", content: "", alt: "" });
    expect(s.blocks[1]).toEqual({ type: "text", content: "" });
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
      title: "T",
      blocks: [
        { type: "text", content: "a" },
        { type: "text", content: "b" },
        { type: "text", content: "c" },
      ],
      notes: "",
    };
    const next = moveBlock(slide, 0, 2);
    expect(next.blocks.map((b) => b.content)).toEqual(["b", "c", "a"]);
  });

  it("moves a block to an earlier position", () => {
    const slide: Slide = {
      title: "T",
      blocks: [
        { type: "text", content: "a" },
        { type: "text", content: "b" },
        { type: "text", content: "c" },
      ],
      notes: "",
    };
    const next = moveBlock(slide, 2, 0);
    expect(next.blocks.map((b) => b.content)).toEqual(["c", "a", "b"]);
  });

  it("returns the same reference when from === to (no-op for setState)", () => {
    const slide: Slide = {
      title: "T",
      blocks: [{ type: "text", content: "a" }],
      notes: "",
    };
    expect(moveBlock(slide, 0, 0)).toBe(slide);
  });

  it("returns the same reference for out-of-range indices", () => {
    const slide: Slide = {
      title: "T",
      blocks: [{ type: "text", content: "a" }],
      notes: "",
    };
    expect(moveBlock(slide, -1, 0)).toBe(slide);
    expect(moveBlock(slide, 0, 5)).toBe(slide);
  });

  it("does not mutate the input array", () => {
    const slide: Slide = {
      title: "T",
      blocks: [
        { type: "text", content: "a" },
        { type: "text", content: "b" },
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
      title: "T",
      blocks: [
        { type: "text", content: "a" },
        { type: "text", content: "b" },
      ],
      notes: "",
    };
    expect(removeBlock(slide, 0).blocks).toEqual([{ type: "text", content: "b" }]);
  });

  it("allows the slide to end up with zero blocks", () => {
    const slide: Slide = {
      title: "T",
      blocks: [{ type: "text", content: "only" }],
      notes: "",
    };
    expect(removeBlock(slide, 0).blocks).toEqual([]);
  });

  it("returns the same reference for out-of-range indices", () => {
    const slide: Slide = {
      title: "T",
      blocks: [{ type: "text", content: "a" }],
      notes: "",
    };
    expect(removeBlock(slide, -1)).toBe(slide);
    expect(removeBlock(slide, 5)).toBe(slide);
  });
});

describe("appendBlock", () => {
  it("appends a block to the end", () => {
    const slide: Slide = {
      title: "T",
      blocks: [{ type: "text", content: "a" }],
      notes: "",
    };
    const next = appendBlock(slide, { type: "bullets", content: "b" });
    expect(next.blocks).toEqual([
      { type: "text", content: "a" },
      { type: "bullets", content: "b" },
    ]);
  });

  it("works on an empty slide", () => {
    const slide: Slide = { title: "T", blocks: [], notes: "" };
    expect(appendBlock(slide, { type: "text", content: "x" }).blocks).toEqual([
      { type: "text", content: "x" },
    ]);
  });

  it("does not mutate the input blocks array", () => {
    const slide: Slide = { title: "T", blocks: [], notes: "" };
    const originalBlocksRef = slide.blocks;
    appendBlock(slide, { type: "text", content: "x" });
    expect(slide.blocks).toBe(originalBlocksRef);
    expect(slide.blocks).toEqual([]);
  });
});

describe("replaceBlock", () => {
  it("replaces the block at the given index", () => {
    const slide: Slide = {
      title: "T",
      blocks: [
        { type: "text", content: "a" },
        { type: "text", content: "b" },
      ],
      notes: "",
    };
    const next = replaceBlock(slide, 1, { type: "bullets", content: "new" });
    expect(next.blocks).toEqual([
      { type: "text", content: "a" },
      { type: "bullets", content: "new" },
    ]);
  });

  it("returns the same reference for out-of-range indices", () => {
    const slide: Slide = {
      title: "T",
      blocks: [{ type: "text", content: "a" }],
      notes: "",
    };
    expect(replaceBlock(slide, 5, { type: "text", content: "x" })).toBe(slide);
    expect(replaceBlock(slide, -1, { type: "text", content: "x" })).toBe(slide);
  });
});

describe("slideWordCount", () => {
  it("sums words across title, blocks, and notes", () => {
    const slide: Slide = {
      title: "Hello world",
      blocks: [
        { type: "text", content: "foo bar baz" },
        { type: "bullets", content: "one two" },
      ],
      notes: "speaker note here",
    };
    // title=2 + text=3 + bullets=2 + notes=3 = 10
    expect(slideWordCount(slide)).toBe(10);
  });

  it("collapses runs of whitespace (does not over-count)", () => {
    const slide: Slide = {
      title: "foo  bar   baz",
      blocks: [],
      notes: "",
    };
    expect(slideWordCount(slide)).toBe(3);
  });

  it("counts image-block alt text, not the data URL", () => {
    const slide: Slide = {
      title: "",
      blocks: [
        {
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
      slideWordCount({ title: "", blocks: [], notes: "" }),
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
        title: "foo bar",
        blocks: [
          { type: "text", content: "foo block" },
          { type: "bullets", content: "another foo here" },
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
      title: "",
      blocks: [
        {
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
