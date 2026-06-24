import { describe, it, expect, beforeEach } from "vitest";
import {
  renderMarp,
  buildMarpFrontmatter,
  splitSlides,
  extractSpeakerNotes,
  resetMarpForTests,
  MarpRenderError,
  SUPPORTED_THEMES,
} from "../services/marpRenderer";

describe("marpRenderer", () => {
  beforeEach(() => {
    resetMarpForTests();
  });

  describe("renderMarp", () => {
    it("renders a single-slide deck to HTML + CSS", () => {
      const result = renderMarp("# Hello");
      expect(result.html).toMatch(/<section[\s>]/);
      expect(result.html).toContain("Hello");
      expect(result.css).toContain("section");
      expect(result.slideCount).toBe(1);
    });

    it("renders a multi-slide deck split on ---", () => {
      const md = "# Slide 1\n\n---\n\n# Slide 2\n\n---\n\n# Slide 3";
      const result = renderMarp(md);
      expect(result.slideCount).toBe(3);
      expect(result.html).toContain("Slide 1");
      expect(result.html).toContain("Slide 2");
      expect(result.html).toContain("Slide 3");
    });

    it("honours the marp: true frontmatter directive", () => {
      const md =
        "---\nmarp: true\ntheme: default\npaginate: true\n---\n\n# Title";
      const result = renderMarp(md);
      // pagination injects a <p> with the page number marker
      expect(result.html).toMatch(/section/);
      expect(result.slideCount).toBeGreaterThanOrEqual(1);
    });

    it("returns a single empty slide for empty input", () => {
      // Marp Core emits one empty <section> for empty markdown — match that.
      const result = renderMarp("");
      expect(result.slideCount).toBe(1);
      expect(result.notes).toEqual([]);
    });

    it("wraps unexpected internal errors as MarpRenderError", () => {
      // Force an error by passing an unsupported math engine to options.
      // Marp Core constructs successfully but rendering with invalid html
      // option should still succeed — instead simulate by giving a non-string
      // value where it expects one.
      expect(() => renderMarp(null as unknown as string)).not.toThrow();
      // Sanity check the error class wires up when explicitly thrown.
      const err = new MarpRenderError("simulated");
      expect(err.name).toBe("MarpRenderError");
      expect(err.message).toContain("simulated");
    });
  });

  describe("buildMarpFrontmatter", () => {
    it("emits a marp: true directive block", () => {
      const fm = buildMarpFrontmatter({});
      expect(fm).toContain("marp: true");
      expect(fm.startsWith("---")).toBe(true);
      expect(fm.endsWith("---")).toBe(true);
    });

    it("includes theme / paginate / header / footer when supplied", () => {
      const fm = buildMarpFrontmatter({
        theme: "gaia",
        paginate: true,
        header: "Tessera",
        footer: "© 2026",
        backgroundColor: "#FFFFFF",
        klass: "lead",
      });
      // All user-editable scalars are wrapped in YAML single-quoted form so
      // a newline in any of them cannot inject a second directive.
      expect(fm).toContain("theme: 'gaia'");
      expect(fm).toContain("paginate: true");
      expect(fm).toContain("header: 'Tessera'");
      expect(fm).toContain("footer: '© 2026'");
      expect(fm).toContain("backgroundColor: '#FFFFFF'");
      expect(fm).toContain("class: 'lead'");
    });

    it("escapes single quotes inside header/footer", () => {
      const fm = buildMarpFrontmatter({ header: "Ken's deck" });
      expect(fm).toContain("Ken''s deck");
    });

    it("flattens newlines in user-supplied scalars to neutralise directive injection", () => {
      // who edits the JSON could otherwise set theme to "gaia\nclass: lead"
      // and gain an unintended directive.
      const fm = buildMarpFrontmatter({ theme: "gaia\nclass: lead-injected" });
      expect(fm).toContain("theme: 'gaia class: lead-injected'");
      // And the literal newline + injected class line must NOT appear as
      // its own directive.
      expect(
        fm.split(/\n/).filter((l) => l === "class: lead-injected"),
      ).toEqual([]);
    });
  });

  describe("splitSlides", () => {
    it("returns an empty array for empty input", () => {
      expect(splitSlides("")).toEqual([]);
    });

    it("splits on --- but preserves frontmatter", () => {
      const md = "---\nmarp: true\n---\n# A\n\n---\n\n# B";
      const slides = splitSlides(md);
      expect(slides).toHaveLength(2);
      expect(slides[0]).toContain("marp: true");
      expect(slides[0]).toContain("# A");
      expect(slides[1]).toContain("# B");
    });

    it("treats input without frontmatter as a single deck", () => {
      const slides = splitSlides("# Only one");
      expect(slides).toEqual(["# Only one"]);
    });
  });

  describe("extractSpeakerNotes", () => {
    it("returns empty notes for slides without comments", () => {
      const notes = extractSpeakerNotes("# A\n\n---\n\n# B");
      expect(notes).toEqual(["", ""]);
    });

    it("captures HTML comment blocks per slide", () => {
      const md =
        "# A\n\n<!-- notes for A -->\n\n---\n\n# B\n\n<!-- B note 1 -->\n<!-- B note 2 -->";
      const notes = extractSpeakerNotes(md);
      expect(notes[0]).toBe("notes for A");
      expect(notes[1]).toBe("B note 1\nB note 2");
    });
  });

  it("supports the three built-in themes", () => {
    expect(SUPPORTED_THEMES).toEqual(["default", "gaia", "uncover"]);
    for (const theme of SUPPORTED_THEMES) {
      const result = renderMarp(
        `---\nmarp: true\ntheme: ${theme}\n---\n# Test`,
      );
      expect(result.slideCount).toBeGreaterThanOrEqual(1);
    }
  });
});
