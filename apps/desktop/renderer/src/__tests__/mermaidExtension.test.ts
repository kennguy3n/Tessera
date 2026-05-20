import { describe, it, expect, beforeAll } from "vitest";
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { MermaidNode, __testing } from "../editors/extensions/MermaidExtension";

beforeAll(() => {
  // jsdom doesn't have DOMRect; mermaid is not invoked in these structural
  // tests, but TipTap touches a few DOM measurement APIs during creation.
  if (typeof DOMRect === "undefined") {
    (globalThis as Record<string, unknown>).DOMRect = class {
      constructor(
        public x = 0,
        public y = 0,
        public width = 0,
        public height = 0,
      ) {}
    };
  }
});

function makeEditor() {
  return new Editor({
    extensions: [Document, Paragraph, Text, MermaidNode],
  });
}

describe("MermaidNode TipTap extension", () => {
  it("exposes the expected name and group", () => {
    expect(MermaidNode.name).toBe("mermaid");
    expect(MermaidNode.config.group).toBe("block");
  });

  it("provides a sensible default DSL", () => {
    expect(__testing.DEFAULT_DSL).toMatch(/flowchart/);
  });

  it("debounces re-renders to avoid trampling the parser", () => {
    expect(__testing.DEBOUNCE_MS).toBeGreaterThanOrEqual(100);
    expect(__testing.DEBOUNCE_MS).toBeLessThanOrEqual(1000);
  });

  it("insertMermaid command inserts a node with the default DSL", () => {
    const editor = makeEditor();
    editor.commands.insertMermaid();
    let foundDsl: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mermaid") {
        foundDsl = (node.attrs as { dsl: string }).dsl;
      }
    });
    expect(foundDsl).toBe(__testing.DEFAULT_DSL);
  });

  it("insertMermaid command accepts a custom DSL", () => {
    const editor = makeEditor();
    editor.commands.insertMermaid("pie\ntitle Test\nA: 1");
    let foundDsl: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mermaid") {
        foundDsl = (node.attrs as { dsl: string }).dsl;
      }
    });
    expect(foundDsl).toBe("pie\ntitle Test\nA: 1");
  });

  it("updateMermaidDsl mutates an existing node's DSL attribute", () => {
    const editor = makeEditor();
    editor.commands.insertMermaid("flowchart TD\nA-->B");
    let mermaidPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "mermaid") mermaidPos = pos;
    });
    expect(mermaidPos).toBeGreaterThanOrEqual(0);
    editor.commands.setNodeSelection(mermaidPos);
    editor.commands.updateMermaidDsl("flowchart LR\nX-->Y");
    let nextDsl: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mermaid") nextDsl = (node.attrs as { dsl: string }).dsl;
    });
    expect(nextDsl).toBe("flowchart LR\nX-->Y");
  });

  it("serializes the DSL into a data-dsl attribute on round-trip", () => {
    const editor = makeEditor();
    editor.commands.insertMermaid("graph TD\nfoo-->bar");
    const html = editor.getHTML();
    expect(html).toContain('data-type="mermaid"');
    expect(html).toContain('data-dsl="graph TD');
  });

  it("parses HTML containing a mermaid div back into a node", () => {
    const editor = makeEditor();
    editor.commands.setContent(
      `<div data-type="mermaid" data-dsl="pie&#10;title Roundtrip&#10;A: 2"></div>`,
    );
    let parsedDsl: string | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "mermaid") parsedDsl = (node.attrs as { dsl: string }).dsl;
    });
    expect(parsedDsl).toBe("pie\ntitle Roundtrip\nA: 2");
  });
});
