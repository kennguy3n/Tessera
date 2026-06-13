/**
 * Integration + unit tests for the Notion/GDocs gap-close blocks and
 * the outline helpers.
 *
 *  - Callout / Toggle / TableOfContents extensions: command dispatch +
 *    HTML round-trip (parseHTML → renderHTML) so persistence and the
 *    export pipeline keep the blocks intact.
 *  - documentOutlineHelpers: heading collection, slugs, reading-time,
 *    and the active-heading picker (all pure).
 *
 * Headless `@tiptap/core` Editor only — no React rendering — mirroring
 * `documentEditorExtensions.test.ts`.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { CalloutNode } from "../extensions/CalloutExtension";
import { ToggleNode } from "../extensions/ToggleExtension";
import { TableOfContentsNode } from "../extensions/TableOfContentsExtension";
import {
  collectHeadings,
  slugifyHeading,
  estimateReadingTimeMinutes,
  formatReadingTime,
  pickActiveHeadingIndex,
  READING_WPM,
} from "../documentOutlineHelpers";

beforeAll(() => {
  if (typeof DOMRect === "undefined") {
    (globalThis as Record<string, unknown>).DOMRect = class {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
      ) {}
      get left() {
        return this.x;
      }
      get top() {
        return this.y;
      }
      get right() {
        return this.x + this.width;
      }
      get bottom() {
        return this.y + this.height;
      }
    };
  }
});

const liveEditors: Editor[] = [];

function makeEditor(initialContent = "<p></p>") {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ horizontalRule: false }),
      CalloutNode,
      ToggleNode,
      TableOfContentsNode,
    ],
    content: initialContent,
  });
  liveEditors.push(editor);
  return editor;
}

afterEach(() => {
  while (liveEditors.length > 0) {
    liveEditors.pop()?.destroy();
  }
});

describe("CalloutNode", () => {
  it("wraps the current block in a callout with the default info variant", () => {
    const editor = makeEditor("<p>Heads up</p>");
    editor.chain().setTextSelection(2).toggleCallout().run();
    expect(editor.isActive("callout")).toBe(true);
    const html = editor.getHTML();
    expect(html).toContain('data-type="callout"');
    expect(html).toContain('data-variant="info"');
  });

  it("round-trips a callout's variant + icon through parse/render", () => {
    const editor = makeEditor(
      '<div data-type="callout" data-variant="warning" data-icon="⚠️"><p>Careful</p></div>',
    );
    const html = editor.getHTML();
    expect(html).toContain('data-variant="warning"');
    expect(html).toContain("Careful");
  });

  it("toggling a callout off lifts the content back out", () => {
    const editor = makeEditor("<p>Plain</p>");
    editor.chain().setTextSelection(2).toggleCallout().run();
    expect(editor.isActive("callout")).toBe(true);
    editor.chain().setTextSelection(2).toggleCallout().run();
    expect(editor.isActive("callout")).toBe(false);
  });

  it("updateCalloutVariant swaps the variant + matching icon", () => {
    const editor = makeEditor("<p>Tip</p>");
    editor.chain().setTextSelection(2).toggleCallout().run();
    editor.chain().updateCalloutVariant("danger").run();
    expect(editor.getHTML()).toContain('data-variant="danger"');
  });
});

describe("ToggleNode", () => {
  it("inserts a collapsible toggle with a paragraph body", () => {
    const editor = makeEditor("<p></p>");
    editor.chain().insertToggle({ summary: "More" }).run();
    const html = editor.getHTML();
    expect(html).toContain('data-type="toggle"');
    expect(html).toContain("<summary");
    expect(html).toContain("More");
  });

  it("round-trips a <details> toggle through parse/render with open state", () => {
    const editor = makeEditor(
      '<details data-type="toggle" open><summary>Q</summary><div data-type="toggle-body"><p>A</p></div></details>',
    );
    const html = editor.getHTML();
    expect(html).toContain('data-type="toggle"');
    expect(html).toContain("Q");
    expect(html).toContain("A");
  });

  it("setToggleOpen toggles the open attribute", () => {
    const editor = makeEditor("<p></p>");
    editor.chain().insertToggle({ summary: "X" }).run();
    editor.chain().setTextSelection(2).setToggleOpen(false).run();
    // When closed the `open` attribute is dropped from the markup.
    expect(editor.getHTML()).not.toMatch(/<details[^>]*\sopen/);
  });
});

describe("TableOfContentsNode", () => {
  it("inserts a table-of-contents marker block", () => {
    const editor = makeEditor("<p></p>");
    editor.chain().insertTableOfContents().run();
    expect(editor.getHTML()).toContain('data-type="table-of-contents"');
  });

  it("round-trips through parse/render", () => {
    const editor = makeEditor(
      '<div data-type="table-of-contents"></div><p>body</p>',
    );
    expect(editor.getHTML()).toContain('data-type="table-of-contents"');
  });
});

describe("collectHeadings", () => {
  it("returns every heading in document order with level + text + pos", () => {
    const editor = makeEditor(
      "<h1>Title</h1><p>x</p><h2>Sub</h2><h3>Deep</h3>",
    );
    const headings = collectHeadings(editor.state.doc);
    expect(headings.map((h) => h.level)).toEqual([1, 2, 3]);
    expect(headings.map((h) => h.text)).toEqual(["Title", "Sub", "Deep"]);
    // Positions strictly increase in document order.
    for (let i = 1; i < headings.length; i += 1) {
      expect(headings[i].pos).toBeGreaterThan(headings[i - 1].pos);
    }
  });

  it("produces unique ids even when two headings share text", () => {
    const editor = makeEditor("<h2>Intro</h2><h2>Intro</h2>");
    const headings = collectHeadings(editor.state.doc);
    expect(headings).toHaveLength(2);
    expect(headings[0].id).not.toBe(headings[1].id);
  });

  it("returns an empty array for a doc with no headings", () => {
    const editor = makeEditor("<p>just text</p>");
    expect(collectHeadings(editor.state.doc)).toEqual([]);
  });
});

describe("slugifyHeading", () => {
  it("lowercases, trims, and dash-separates", () => {
    expect(slugifyHeading("  Hello World  ")).toBe("hello-world");
  });
  it("strips punctuation and collapses repeats", () => {
    expect(slugifyHeading("A, B & C!!")).toBe("a-b-c");
  });
  it("returns empty string for punctuation-only input", () => {
    expect(slugifyHeading("!!!")).toBe("");
  });
  it("keeps Unicode letters/digits so non-Latin headings get real slugs (parity with the Rust exporter)", () => {
    // Mirrors crates/tessera_export/src/html.rs::slugify, which keeps
    // Unicode alphanumerics. A pure-ASCII slugifier would mangle these.
    expect(slugifyHeading("Café Crème")).toBe("café-crème");
    expect(slugifyHeading("概述")).toBe("概述");
    expect(slugifyHeading("Q3 — Metrics")).toBe("q3-metrics");
    // Underscores and other separators collapse to a single dash.
    expect(slugifyHeading("Hello_World")).toBe("hello-world");
  });
});

describe("reading time", () => {
  it("is at least 1 minute for any non-empty doc", () => {
    expect(estimateReadingTimeMinutes(1)).toBe(1);
  });
  it("scales with the WPM baseline (ceil)", () => {
    expect(estimateReadingTimeMinutes(READING_WPM * 2)).toBe(2);
    expect(estimateReadingTimeMinutes(READING_WPM * 2 + 1)).toBe(3);
  });
  it("is 0 for an empty doc", () => {
    expect(estimateReadingTimeMinutes(0)).toBe(0);
  });
  it("formats with the unit", () => {
    expect(formatReadingTime(1)).toBe("1 min read");
    expect(formatReadingTime(0)).toBe("0 min read");
  });
});

describe("pickActiveHeadingIndex", () => {
  it("returns -1 with no headings", () => {
    expect(pickActiveHeadingIndex([], 0)).toBe(-1);
  });
  it("picks the last heading at or above the scroll position", () => {
    // Offsets relative to the scroll container; bias defaults to 24.
    const offsets = [-100, -10, 200, 500];
    // Heading 1 (offset -10) is the last one within bias of the top.
    expect(pickActiveHeadingIndex(offsets, 0)).toBe(1);
  });
  it("keeps the first heading active while scrolled to the top", () => {
    const offsets = [0, 300, 600];
    expect(pickActiveHeadingIndex(offsets, 0)).toBe(0);
  });
  it("advances as the user scrolls down", () => {
    const offsets = [10, 20, 30];
    // With a large scrollTop every heading is above → last one active.
    expect(pickActiveHeadingIndex(offsets, 1000)).toBe(2);
  });
});
