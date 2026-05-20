import { describe, it, expect } from "vitest";
import {
  parseSlideContent,
  slidesToMarpMarkdown,
  escapeHtmlComment,
  extractFrontmatterTheme,
  setFrontmatterTheme,
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
    // Regression test for BUG_pr-review-job-32bf2b2f08cc44939a2d7cd9b9a9d396_0001:
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

  it("escapes `-->` in speaker notes so the HTML comment cannot be terminated early (regression for ANALYSIS_pr-review-job-0364b468c3654054ad83fe2599369c02_0005)", () => {
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
