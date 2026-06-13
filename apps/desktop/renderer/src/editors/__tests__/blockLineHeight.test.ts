/**
 * Integration tests for the custom {@link BlockLineHeight} extension.
 *
 * The bug this extension fixes is subtle: TipTap's stock `LineHeight`
 * command writes to the `textStyle` *mark* even when the attribute is
 * registered on block nodes, so the control silently does nothing. These
 * tests boot a headless `@tiptap/core` Editor and assert the value lands
 * on the *paragraph / heading node* (the thing that actually controls
 * line spacing), round-trips through HTML, and refuses unsafe values that
 * would otherwise be interpolated into an inline `style`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import { BlockLineHeight } from "../extensions/BlockLineHeight";

const liveEditors: Editor[] = [];

function makeEditor(initialContent = "<p>Hello</p>") {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TextStyle,
      BlockLineHeight.configure({ types: ["paragraph", "heading"] }),
    ],
    content: initialContent,
  });
  liveEditors.push(editor);
  return editor;
}

afterEach(() => {
  while (liveEditors.length > 0) liveEditors.pop()?.destroy();
});

describe("BlockLineHeight — block-level line spacing", () => {
  it("writes the value onto the paragraph node, not the textStyle mark", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.selectAll();
    const ok = editor.commands.setLineHeight("1.5");
    expect(ok).toBe(true);
    // The attribute lands on the block node (what actually controls
    // spacing) — this is exactly what the read path in TypographyControls
    // queries, and what the stock extension failed to update.
    expect(editor.getAttributes("paragraph").lineHeight).toBe("1.5");
    expect(editor.getAttributes("textStyle").lineHeight).toBeUndefined();
    expect(editor.getHTML()).toContain("line-height: 1.5");
  });

  it("applies to headings too", () => {
    const editor = makeEditor("<h1>Title</h1>");
    editor.commands.selectAll();
    expect(editor.commands.setLineHeight("2")).toBe(true);
    expect(editor.getAttributes("heading").lineHeight).toBe("2");
    expect(editor.getHTML()).toContain("line-height: 2");
  });

  it("unsetLineHeight clears the attribute and the rendered style", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.selectAll();
    editor.commands.setLineHeight("1.8");
    expect(editor.getHTML()).toContain("line-height: 1.8");
    const cleared = editor.commands.unsetLineHeight();
    expect(cleared).toBe(true);
    expect(editor.getAttributes("paragraph").lineHeight ?? null).toBeNull();
    expect(editor.getHTML()).not.toContain("line-height");
  });

  it("accepts unit-bearing values within the safe grammar", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.selectAll();
    for (const value of ["24px", "1.5em", "150%", "2rem"]) {
      expect(editor.commands.setLineHeight(value)).toBe(true);
      expect(editor.getAttributes("paragraph").lineHeight).toBe(value);
    }
  });

  it("accepts leading-dot decimals pasted from other editors", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.selectAll();
    for (const value of [".5", ".75em"]) {
      expect(editor.commands.setLineHeight(value)).toBe(true);
      expect(editor.getAttributes("paragraph").lineHeight).toBe(value);
    }
  });

  it("stores the trimmed value so it matches the validated/preset form", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.selectAll();
    // A programmatic caller may pass surrounding whitespace; the stored
    // attribute is trimmed so it matches the toolbar's preset option value.
    expect(editor.commands.setLineHeight("  1.5  ")).toBe(true);
    expect(editor.getAttributes("paragraph").lineHeight).toBe("1.5");
    expect(editor.getHTML()).toContain("line-height: 1.5");
  });

  it("rejects unsafe values so nothing leaks into the inline style", () => {
    const editor = makeEditor("<p>Hello</p>");
    editor.commands.selectAll();
    // A CSS-injection attempt and a nonsense unit are both refused; the
    // command returns false and the node keeps no lineHeight.
    expect(editor.commands.setLineHeight("1; background:url(x)")).toBe(false);
    expect(editor.commands.setLineHeight("expression(alert(1))")).toBe(false);
    expect(editor.getAttributes("paragraph").lineHeight ?? null).toBeNull();
    expect(editor.getHTML()).not.toContain("line-height");
  });

  it("parses a safe pasted line-height and ignores sibling declarations", () => {
    const safe = makeEditor('<p style="line-height: 1.5">Pasted</p>');
    expect(safe.getAttributes("paragraph").lineHeight).toBe("1.5");

    // The CSS parser keeps each declaration separate, so a malicious
    // sibling can never bleed into `style.lineHeight` — only the bare
    // `1` survives, which is a safe value.
    const sibling = makeEditor(
      '<p style="line-height: 1; background:url(x)">Pasted</p>',
    );
    expect(sibling.getAttributes("paragraph").lineHeight).toBe("1");
  });

  it("drops a pasted line-height that falls outside the safe grammar", () => {
    const editor = makeEditor(
      '<p style="line-height: calc(100% + 2px)">Pasted</p>',
    );
    expect(editor.getAttributes("paragraph").lineHeight ?? null).toBeNull();
  });

  it("applies to every block in a multi-paragraph selection", () => {
    const editor = makeEditor("<p>One</p><h2>Two</h2><p>Three</p>");
    // Select the whole document so the range spans all three blocks.
    editor.commands.selectAll();
    expect(editor.commands.setLineHeight("1.5")).toBe(true);

    // Every configured block node — not just the anchor — carries the value.
    const lineHeights: (string | null)[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph" || node.type.name === "heading") {
        lineHeights.push((node.attrs.lineHeight as string | null) ?? null);
      }
    });
    expect(lineHeights).toEqual(["1.5", "1.5", "1.5"]);
    // The serialised HTML therefore carries the style on all three blocks.
    expect(editor.getHTML().match(/line-height: 1\.5/g)).toHaveLength(3);
  });

  it("clears the line height on every block in a multi-paragraph selection", () => {
    const editor = makeEditor("<p>One</p><p>Two</p><p>Three</p>");
    editor.commands.selectAll();
    editor.commands.setLineHeight("2");
    expect(editor.getHTML().match(/line-height: 2/g)).toHaveLength(3);

    expect(editor.commands.unsetLineHeight()).toBe(true);
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") {
        expect((node.attrs.lineHeight as string | null) ?? null).toBeNull();
      }
    });
    expect(editor.getHTML()).not.toContain("line-height");
  });

  it("stays correct when chained after a structural edit that shifts positions", () => {
    const editor = makeEditor("<p>One</p><p>Two</p>");
    // In a single chain, insert a new first paragraph (which shifts every
    // later block position by its node size) and *then* apply the line
    // height across the whole document. Reading positions from the live
    // transaction keeps them valid; the pre-command document would address
    // now-shifted nodes and miss/mis-target a block.
    const ok = editor
      .chain()
      .insertContentAt(0, "<p>Zero</p>")
      .selectAll()
      .setLineHeight("1.5")
      .run();
    expect(ok).toBe(true);

    const lineHeights: (string | null)[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === "paragraph") {
        lineHeights.push((node.attrs.lineHeight as string | null) ?? null);
      }
    });
    // All three paragraphs — including the freshly inserted one — carry it.
    expect(lineHeights).toEqual(["1.5", "1.5", "1.5"]);
    expect(editor.getHTML().match(/line-height: 1\.5/g)).toHaveLength(3);
  });
});
