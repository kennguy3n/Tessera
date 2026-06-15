/**
 * Built-in document-template catalogue tests.
 *
 * Two layers:
 *   - Pure metadata + filter + preview assertions (no DOM editor needed).
 *   - A headless round-trip: every built-in's authored HTML is loaded
 *     into a real `@tiptap/core` Editor configured with the same node
 *     extensions the Document editor uses, then re-serialised. This is the
 *     guarantee that each template parses losslessly through TipTap's
 *     schema (no node silently dropped) — the headless-editor pattern is
 *     the one `documentEditorExtensions.test.ts` already proves works in
 *     jsdom (DOMRect shim + liveEditors teardown).
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Table } from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import {
  ALL_DOCUMENT_TEMPLATES_CATEGORY,
  DOCUMENT_TEMPLATES,
  DOCUMENT_TEMPLATE_CATEGORIES,
  documentTemplatePreviewText,
  filterDocumentTemplates,
  type DocumentTemplate,
} from "../documentTemplates";

const CATEGORY_SET = new Set<string>(DOCUMENT_TEMPLATE_CATEGORIES);

describe("DOCUMENT_TEMPLATES catalogue integrity", () => {
  it("ships a non-trivial curated set", () => {
    expect(DOCUMENT_TEMPLATES.length).toBeGreaterThanOrEqual(8);
  });

  it("every template has a unique, built-in-namespaced id", () => {
    const ids = DOCUMENT_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith("doc-")).toBe(true);
      // Built-in ids must never collide with the custom namespace.
      expect(id.startsWith("doctpl-")).toBe(false);
    }
  });

  it("every template has label, description, icon, and a known category", () => {
    for (const t of DOCUMENT_TEMPLATES) {
      expect(t.label.trim().length).toBeGreaterThan(0);
      expect(t.description.trim().length).toBeGreaterThan(0);
      expect(t.icon.trim().length).toBeGreaterThan(0);
      expect(t.category && CATEGORY_SET.has(t.category)).toBe(true);
    }
  });

  it("every template's content begins with a heading (trusted leading tag)", () => {
    for (const t of DOCUMENT_TEMPLATES) {
      expect(t.content.trimStart()).toMatch(/^<h1[\s>]/i);
    }
  });
});

describe("filterDocumentTemplates", () => {
  it("the 'All' sentinel returns every template, order preserved", () => {
    const out = filterDocumentTemplates(
      DOCUMENT_TEMPLATES,
      ALL_DOCUMENT_TEMPLATES_CATEGORY,
      "",
    );
    expect(out).toEqual([...DOCUMENT_TEMPLATES]);
  });

  it("narrows by category", () => {
    const out = filterDocumentTemplates(DOCUMENT_TEMPLATES, "Meetings", "");
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((t) => t.category === "Meetings")).toBe(true);
  });

  it("matches the free-text query against label / description / category", () => {
    const byLabel = filterDocumentTemplates(
      DOCUMENT_TEMPLATES,
      ALL_DOCUMENT_TEMPLATES_CATEGORY,
      "meeting",
    );
    expect(byLabel.some((t) => t.id === "doc-meeting-notes")).toBe(true);

    // Case-insensitive + matches the category token too.
    const byCategory = filterDocumentTemplates(
      DOCUMENT_TEMPLATES,
      ALL_DOCUMENT_TEMPLATES_CATEGORY,
      "ENGINEERING",
    );
    expect(byCategory.every((t) => t.category === "Engineering")).toBe(true);
    expect(byCategory.length).toBeGreaterThan(0);
  });

  it("returns nothing for a query that matches no template", () => {
    expect(
      filterDocumentTemplates(
        DOCUMENT_TEMPLATES,
        ALL_DOCUMENT_TEMPLATES_CATEGORY,
        "zzzznomatch",
      ),
    ).toEqual([]);
  });

  it("does not mutate the source array", () => {
    const snapshot = [...DOCUMENT_TEMPLATES];
    filterDocumentTemplates(DOCUMENT_TEMPLATES, "Meetings", "notes");
    expect([...DOCUMENT_TEMPLATES]).toEqual(snapshot);
  });
});

describe("documentTemplatePreviewText", () => {
  it("strips tags, decodes entities, and collapses whitespace to plain text", () => {
    const out = documentTemplatePreviewText(
      "<h1>Title</h1>\n<p>A &amp; B &lt;tag&gt;</p>",
    );
    // Real tags are stripped; entities are decoded to their literal text.
    // The decoded `<tag>` is harmless: the gallery renders this value as a
    // React text node, so React escapes it — there is no innerHTML path.
    expect(out).toBe("Title A & B <tag>");
  });

  it("bounds the excerpt with an ellipsis", () => {
    const long = `<p>${"word ".repeat(100)}</p>`;
    const out = documentTemplatePreviewText(long, 40);
    expect(out.length).toBeLessThanOrEqual(41); // 40 chars + ellipsis
    expect(out.endsWith("…")).toBe(true);
  });

  it("produces a usable preview for every built-in", () => {
    for (const t of DOCUMENT_TEMPLATES) {
      const preview = documentTemplatePreviewText(t.content);
      expect(preview.length).toBeGreaterThan(0);
      expect(preview).not.toMatch(/<[^>]+>/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Headless round-trip — each template parses losslessly through TipTap.
// ─────────────────────────────────────────────────────────────────────

beforeAll(() => {
  // jsdom lacks DOMRect; the table column-resizing plugin constructs one.
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

function makeDocEditor(content: string): Editor {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      TaskList,
      TaskItem.configure({ nested: true }),
    ],
    content,
  });
  liveEditors.push(editor);
  return editor;
}

afterEach(() => {
  while (liveEditors.length > 0) {
    liveEditors.pop()?.destroy();
  }
});

describe("built-in templates round-trip through the editor schema", () => {
  it.each(DOCUMENT_TEMPLATES.map((t): [string, DocumentTemplate] => [t.id, t]))(
    "%s parses to a non-empty document",
    (_id, template) => {
      const editor = makeDocEditor(template.content);
      expect(editor.isEmpty).toBe(false);
      // The first heading's text survives the parse.
      const firstHeading = template.label;
      expect(editor.state.doc.textContent.length).toBeGreaterThan(
        firstHeading.length,
      );
      // Re-serialising yields real block markup, not a blank paragraph.
      const html = editor.getHTML();
      expect(html).not.toBe("<p></p>");
      expect(html).toMatch(/<h1[\s>]/i);
    },
  );

  it("preserves task-list nodes for templates that use them", () => {
    const withTasks = DOCUMENT_TEMPLATES.filter((t) =>
      t.content.includes('data-type="taskList"'),
    );
    expect(withTasks.length).toBeGreaterThan(0);
    for (const t of withTasks) {
      const editor = makeDocEditor(t.content);
      expect(editor.getHTML()).toContain('data-type="taskList"');
    }
  });

  it("preserves table nodes for templates that use them", () => {
    const withTables = DOCUMENT_TEMPLATES.filter((t) =>
      t.content.includes("<table"),
    );
    expect(withTables.length).toBeGreaterThan(0);
    for (const t of withTables) {
      const editor = makeDocEditor(t.content);
      expect(editor.getHTML()).toContain("<table");
    }
  });
});
