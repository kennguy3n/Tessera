/**
 * Unit tests for the AI writing-assistant mutation layer
 * (`editors/ai/documentAiApply.ts`).
 *
 * Headless `@tiptap/core` Editor only — no React rendering — mirroring
 * `documentBlocksOutline.test.ts`. Exercises the apply modes and, in
 * particular, the defensive clamping that keeps a STALE captured range
 * (one that points past a since-shrunk document) from throwing inside
 * `insertContentAt`.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  applyAiResult,
  captureAiContext,
  blockEndAfter,
} from "../ai/documentAiApply";

const liveEditors: Editor[] = [];

function makeEditor(initialContent = "<p>Hello world</p>") {
  const editor = new Editor({
    extensions: [StarterKit.configure({ horizontalRule: false })],
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

describe("applyAiResult — apply modes", () => {
  it("replace overwrites the captured range", () => {
    const editor = makeEditor("<p>Hello world</p>");
    // Select "world" (positions are 1-based inside the paragraph).
    editor.commands.setTextSelection({ from: 7, to: 12 });
    const ctx = captureAiContext(editor);
    expect(ctx.range).not.toBeNull();

    const ok = applyAiResult(editor, ctx.range, "replace", "there", "improve");
    expect(ok).toBe(true);
    // The captured "world" range is overwritten by the result text.
    expect(editor.getText()).toContain("Hello");
    expect(editor.getText()).toContain("there");
    expect(editor.getText()).not.toContain("world");
  });

  it("replace returns false (and no-ops) when there is no range", () => {
    const editor = makeEditor("<p>Hello world</p>");
    const before = editor.getHTML();
    expect(applyAiResult(editor, null, "replace", "x", "improve")).toBe(false);
    expect(editor.getHTML()).toBe(before);
  });

  it("append inserts the result at the end of the document", () => {
    const editor = makeEditor("<p>First</p>");
    const ok = applyAiResult(editor, null, "append", "Appended", "continue");
    expect(ok).toBe(true);
    const text = editor.getText();
    expect(text).toContain("First");
    expect(text.trimEnd().endsWith("Appended")).toBe(true);
  });

  it("insert-below drops the result into a new block after the selection", () => {
    const editor = makeEditor("<p>Para one</p><p>Para two</p>");
    editor.commands.setTextSelection({ from: 2, to: 5 });
    const ctx = captureAiContext(editor);
    const ok = applyAiResult(editor, ctx.range, "insert-below", "Inserted", "summarize");
    expect(ok).toBe(true);
    expect(editor.getText()).toContain("Inserted");
  });
});

describe("applyAiResult — stale range hardening", () => {
  it("clamps a range that points past a shrunk document instead of throwing", () => {
    const editor = makeEditor("<p>A reasonably long paragraph of text</p>");
    // Capture a range near the end of the original doc.
    editor.commands.setTextSelection({ from: 20, to: 35 });
    const staleRange = captureAiContext(editor).range;
    expect(staleRange).not.toBeNull();

    // Now shrink the document well below the captured positions.
    editor.commands.setContent("<p>Hi</p>");

    // Applying with the stale range must NOT throw; it either replaces a
    // clamped sub-range or rejects when the clamp collapses.
    expect(() =>
      applyAiResult(editor, staleRange, "replace", "X", "improve"),
    ).not.toThrow();
  });

  it("rejects a fully out-of-bounds range whose clamp collapses to empty", () => {
    const editor = makeEditor("<p>Hi</p>");
    const docSize = editor.state.doc.content.size;
    // Both ends sit past the end of the doc, so clamping collapses them.
    const ok = applyAiResult(
      editor,
      { from: docSize + 50, to: docSize + 80 },
      "replace",
      "X",
      "improve",
    );
    expect(ok).toBe(false);
  });
});

describe("blockEndAfter", () => {
  it("clamps an out-of-range position to the document end", () => {
    const editor = makeEditor("<p>One</p><p>Two</p>");
    const size = editor.state.doc.content.size;
    expect(blockEndAfter(editor, size + 1000)).toBeLessThanOrEqual(size);
  });
});
