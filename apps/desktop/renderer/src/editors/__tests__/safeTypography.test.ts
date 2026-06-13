/**
 * Tests for the sanitised inline-typography extensions.
 *
 * The stock TipTap Color / FontFamily / FontSize / Highlight extensions
 * interpolate their stored value straight into an inline `style`, so a crafted
 * document attribute (`red; background: url(https://evil/x)`) would emit extra
 * CSS when rendered. The Safe* variants allow-list the value on both read and
 * write. These tests assert (1) the pure validators, and (2) that a headless
 * editor never serialises an injected declaration even when the malicious value
 * is forced onto the mark via a command (the stored-JSON vector).
 */
import { afterEach, describe, expect, it } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle } from "@tiptap/extension-text-style";
import {
  SafeColor,
  SafeFontFamily,
  SafeFontSize,
  SafeHighlight,
  isSafeCssColor,
  isSafeFontFamily,
  isSafeFontSize,
} from "../extensions/safeTypography";

describe("isSafeCssColor", () => {
  it("accepts hex, functional and keyword colours", () => {
    for (const v of [
      "#111827",
      "#abc",
      "#aabbccdd",
      "rgb(255, 0, 0)",
      "rgba(0,0,0,0.5)",
      "hsl(210, 50%, 40%)",
      "red",
      "transparent",
      "currentcolor",
    ]) {
      expect(isSafeCssColor(v)).toBe(true);
    }
  });

  it("rejects anything that could break out of the declaration", () => {
    for (const v of [
      "red; background:url(https://evil/x)",
      "url(https://evil/x)",
      "expression(alert(1))",
      "rgb(0,0,0); background:url(x)",
      "#ff0000;}",
      "12px",
      "",
      "  ",
      "a".repeat(200),
      42,
      null,
    ]) {
      expect(isSafeCssColor(v as unknown)).toBe(false);
    }
  });
});

describe("isSafeFontSize", () => {
  it("accepts a number with an allow-listed unit", () => {
    for (const v of ["12px", "16px", "1.5em", "2rem", "120%", "11pt"]) {
      expect(isSafeFontSize(v)).toBe(true);
    }
  });

  it("rejects unit-less, structural or oversized values", () => {
    for (const v of [
      "16", // no unit
      "16px; color:red",
      "16px}",
      "calc(1px + 1px)",
      "expression(1)",
      "",
    ]) {
      expect(isSafeFontSize(v)).toBe(false);
    }
  });
});

describe("isSafeFontFamily", () => {
  it("accepts the curated family stacks", () => {
    for (const v of [
      "Inter, system-ui, sans-serif",
      "Georgia, 'Times New Roman', serif",
      "'JetBrains Mono', 'Courier New', monospace",
      "Arial, Helvetica, sans-serif",
    ]) {
      expect(isSafeFontFamily(v)).toBe(true);
    }
  });

  it("rejects families carrying structural CSS characters", () => {
    for (const v of [
      "Arial; background:url(x)",
      "Arial; }",
      "x:y",
      "url(x)",
      "evil()",
      "",
    ]) {
      expect(isSafeFontFamily(v)).toBe(false);
    }
  });
});

const liveEditors: Editor[] = [];

function makeEditor(content = "<p>Hello</p>") {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TextStyle,
      SafeColor,
      SafeFontFamily,
      SafeFontSize,
      SafeHighlight.configure({ multicolor: true }),
    ],
    content,
  });
  liveEditors.push(editor);
  return editor;
}

afterEach(() => {
  while (liveEditors.length > 0) liveEditors.pop()?.destroy();
});

describe("SafeColor / SafeFontFamily / SafeFontSize — render path", () => {
  it("serialises legitimate toolbar values unchanged", () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    editor.chain().setColor("#ff0000").run();
    editor.chain().setFontFamily("Inter, system-ui, sans-serif").run();
    editor.chain().setFontSize("16px").run();
    const html = editor.getHTML();
    // The DOM serialiser canonicalises inline colours to `rgb(...)`, so accept
    // either form; the point is the legitimate value is NOT dropped. Font
    // family / size are not canonicalised and round-trip verbatim.
    expect(html).toMatch(/color:\s*(#ff0000|rgb\(255,\s*0,\s*0\))/i);
    expect(html).toContain("font-family: Inter, system-ui, sans-serif");
    expect(html).toContain("font-size: 16px");
  });

  it("drops an injected colour forced onto the mark (stored-JSON vector)", () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    // setColor stores whatever it is handed; the defense is that renderHTML
    // refuses to serialise a value outside the colour grammar.
    editor.chain().setColor("red; background:url(https://evil/x)").run();
    const html = editor.getHTML();
    expect(html).not.toContain("background");
    expect(html).not.toContain("url(");
  });

  it("drops an injected font-family and font-size", () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    editor.chain().setFontFamily("Arial; background:url(x)").run();
    editor.chain().setFontSize("16px; background:url(x)").run();
    const html = editor.getHTML();
    expect(html).not.toContain("background");
    expect(html).not.toContain("url(");
  });

  it("keeps a safe pasted colour and ignores sibling declarations", () => {
    // The CSS parser keeps declarations separate, so the malicious sibling
    // never reaches `style.color`; only the safe `#ff0000` survives.
    const editor = makeEditor(
      '<p><span style="color:#ff0000; background:url(x)">x</span></p>',
    );
    const html = editor.getHTML();
    expect(html).toMatch(/color:\s*(#ff0000|rgb\(255,\s*0,\s*0\))/i);
    expect(html).not.toContain("url(");
  });
});

describe("SafeHighlight — render path", () => {
  it("serialises a safe highlight colour", () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    editor.chain().setHighlight({ color: "#ffff00" }).run();
    const html = editor.getHTML();
    expect(html).toMatch(
      /background-color:\s*(#ffff00|rgb\(255,\s*255,\s*0\))/i,
    );
    // The lossless `data-color` round-trip preserves the original hex.
    expect(html).toContain('data-color="#ffff00"');
  });

  it("drops an injected highlight colour", () => {
    const editor = makeEditor();
    editor.commands.selectAll();
    editor.chain().setHighlight({ color: "yellow; background:url(x)" }).run();
    const html = editor.getHTML();
    expect(html).not.toContain("url(");
  });
});
