/**
 * Phase 18 PR 6 — integration tests for the DocumentEditor's TipTap
 * extensions + helpers.
 *
 * Unlike `documentEditorHelpers.test.ts` (which pins the pure
 * algorithms), this file stands up a real `Editor` with the two
 * custom extensions (`FindReplaceExtension`, `SlashCommandExtension`)
 * loaded, then exercises:
 *
 *   - `buildDocText` produces a flat string + parallel position map
 *     across paragraph boundaries (`\n` separator).
 *   - `matchToDocRange` translates plain-text indices back into PM
 *     positions that the editor accepts in a `setTextSelection`.
 *   - `applyFindHighlight` / `clearFindHighlight` round-trip through
 *     the plugin (state survives a doc edit; clearing wipes it).
 *   - The slash extension publishes a `visible: true` state when the
 *     user types `/` at the start of an empty paragraph, and
 *     `deleteSlashTrigger` removes the trigger text.
 *
 * No React rendering — we use the headless `@tiptap/core` `Editor`
 * directly so jsdom only needs the small DOM-measurement surface
 * Mermaid's tests already proved works.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  FindReplaceExtension,
  buildDocText,
  matchToDocRange,
} from "../extensions/FindReplaceExtension";
import {
  SlashCommandExtension,
  type SlashTriggerState,
} from "../extensions/SlashCommandExtension";
import { findAllMatches } from "../documentEditorHelpers";

beforeAll(() => {
  // jsdom doesn't ship DOMRect; the slash extension's view handler
  // constructs one when reporting the trigger character's viewport
  // position. Mermaid's test does the same shim.
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

// Mirror MermaidExtension test teardown pattern: track every editor
// and destroy it in afterEach so ProseMirror's DOMObserver doesn't
// fire its pending setTimeout against the torn-down jsdom document.
const liveEditors: Editor[] = [];

function makeEditor(
  options: {
    onSlashState?: (state: SlashTriggerState) => void;
    initialContent?: string;
  } = {},
) {
  const editor = new Editor({
    extensions: [
      StarterKit,
      FindReplaceExtension,
      SlashCommandExtension.configure({
        onStateChange: options.onSlashState,
      }),
    ],
    content: options.initialContent ?? "<p></p>",
  });
  liveEditors.push(editor);
  return editor;
}

afterEach(() => {
  while (liveEditors.length > 0) {
    const editor = liveEditors.pop();
    editor?.destroy();
  }
});

describe("buildDocText — ProseMirror doc → flat text + position map", () => {
  it("concatenates a single paragraph and emits one position per char", () => {
    const editor = makeEditor({ initialContent: "<p>Hello</p>" });
    const snapshot = buildDocText(editor.state.doc);
    expect(snapshot.text).toBe("Hello");
    expect(snapshot.positions.length).toBe(5);
    // Every position is monotonically increasing.
    for (let i = 1; i < snapshot.positions.length; i += 1) {
      expect(snapshot.positions[i]).toBeGreaterThan(snapshot.positions[i - 1]);
    }
  });

  it("joins multiple block nodes with a single `\\n` so cross-block searches don't false-match", () => {
    const editor = makeEditor({
      initialContent: "<p>Alpha</p><p>Beta</p>",
    });
    const snapshot = buildDocText(editor.state.doc);
    // The two paragraphs are separated by exactly one `\n` — that
    // way `findAllMatches("AlphaBeta", …)` cannot accidentally
    // collapse the boundary into a single token.
    expect(snapshot.text).toBe("Alpha\nBeta");
    // The `\n` carries the position of the second paragraph's
    // opening boundary so a decoration on it is mappable.
    const newlineIdx = snapshot.text.indexOf("\n");
    expect(snapshot.positions[newlineIdx]).toBeGreaterThan(0);
  });
});

describe("matchToDocRange — plain-text indices → PM positions", () => {
  it("returns a {from, to} range that the editor accepts in setTextSelection", () => {
    const editor = makeEditor({ initialContent: "<p>Hello world</p>" });
    const snapshot = buildDocText(editor.state.doc);
    const matches = findAllMatches(snapshot.text, "world", {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
    });
    expect(matches).toHaveLength(1);
    const range = matchToDocRange(snapshot, matches[0]);
    expect(range).not.toBeNull();
    // Dispatch the range — if matchToDocRange returned a bad pair,
    // setTextSelection would clamp / fail silently and the
    // selection wouldn't carry the expected text.
    editor.commands.setTextSelection(range!);
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe("world");
  });

  it("returns null on a stale snapshot whose indices outrun the live doc", () => {
    const editor = makeEditor({ initialContent: "<p>short</p>" });
    const snapshot = buildDocText(editor.state.doc);
    // Synthesise a match whose start index is past the snapshot's
    // last position — emulates "user typed Backspace between the
    // panel computing matches and the panel dispatching a replace".
    const bogus = matchToDocRange(snapshot, {
      start: snapshot.positions.length + 5,
      end: snapshot.positions.length + 10,
    });
    expect(bogus).toBeNull();
  });
});

describe("FindReplaceExtension — applyFindHighlight / clearFindHighlight", () => {
  it("paints inline decorations on every match (and an active class on the chosen index)", () => {
    const editor = makeEditor({
      initialContent: "<p>foo bar foo baz foo</p>",
    });
    editor.commands.applyFindHighlight(
      "foo",
      { caseSensitive: false, wholeWord: false, regex: false },
      1,
    );
    // Inspect the DOM the EditorView renders to confirm three
    // decorations were painted with the correct class on the
    // second one (activeIndex = 1).
    const dom = editor.view.dom as HTMLElement;
    const matches = dom.querySelectorAll(".find-match");
    expect(matches.length).toBe(3);
    const actives = dom.querySelectorAll(".find-match-active");
    expect(actives.length).toBe(1);
  });

  it("clearFindHighlight removes every decoration", () => {
    const editor = makeEditor({
      initialContent: "<p>find me find me</p>",
    });
    editor.commands.applyFindHighlight(
      "find",
      { caseSensitive: false, wholeWord: false, regex: false },
      0,
    );
    expect(
      (editor.view.dom as HTMLElement).querySelectorAll(".find-match").length,
    ).toBeGreaterThan(0);
    editor.commands.clearFindHighlight();
    expect(
      (editor.view.dom as HTMLElement).querySelectorAll(".find-match").length,
    ).toBe(0);
  });

  it("recomputes decorations mid-search when the doc changes (typing into an active find)", () => {
    const editor = makeEditor({ initialContent: "<p>cat dog</p>" });
    editor.commands.applyFindHighlight(
      "cat",
      { caseSensitive: false, wholeWord: false, regex: false },
      0,
    );
    expect(
      (editor.view.dom as HTMLElement).querySelectorAll(".find-match").length,
    ).toBe(1);
    // Append another 'cat' — the plugin's `apply` should re-run
    // buildDecorations because tr.docChanged && highlight !== null.
    editor.commands.insertContent(" cat");
    expect(
      (editor.view.dom as HTMLElement).querySelectorAll(".find-match").length,
    ).toBe(2);
  });
});

describe("SlashCommandExtension — trigger state lifecycle", () => {
  it("publishes `visible: true` with the live query when the user types `/foo` at paragraph start", () => {
    const onSlashState = vi.fn();
    const editor = makeEditor({ onSlashState });
    // Type `/list` into the empty paragraph.
    editor.commands.insertContent("/list");
    // The most recent publish should be visible:true with query="list".
    const calls = onSlashState.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const last = calls.at(-1)![0] as SlashTriggerState;
    expect(last.visible).toBe(true);
    expect(last.query).toBe("list");
    expect(last.range).not.toBeNull();
  });

  it("cancels the trigger when the user types whitespace inside it", () => {
    const onSlashState = vi.fn();
    const editor = makeEditor({ onSlashState });
    editor.commands.insertContent("/list");
    onSlashState.mockClear();
    editor.commands.insertContent(" ");
    // The very next publish should flip visible back to false.
    const last = onSlashState.mock.calls.at(-1)![0] as SlashTriggerState;
    expect(last.visible).toBe(false);
  });

  it("does not fire inside a heading (only paragraph nodes open the menu)", () => {
    const onSlashState = vi.fn();
    const editor = makeEditor({
      onSlashState,
      initialContent: "<h1></h1>",
    });
    onSlashState.mockClear();
    editor.commands.insertContent("/foo");
    // No publish with visible:true should have happened.
    const visibleCalls = onSlashState.mock.calls.filter(
      (c) => (c[0] as SlashTriggerState).visible,
    );
    expect(visibleCalls.length).toBe(0);
  });

  it("deleteSlashTrigger removes the `/<query>` text from the document", () => {
    const editor = makeEditor();
    editor.commands.insertContent("/heading");
    expect(editor.getText()).toBe("/heading");
    editor.commands.deleteSlashTrigger();
    expect(editor.getText()).toBe("");
  });

  it("publishes a `visible: false` when the user backspaces past the `/`", () => {
    const onSlashState = vi.fn();
    const editor = makeEditor({ onSlashState });
    editor.commands.insertContent("/h");
    onSlashState.mockClear();
    // Delete two chars — the `h` then the `/` — so the paragraph
    // no longer starts with `/`.
    editor.commands.setTextSelection(editor.state.selection.from);
    editor.commands.deleteRange({
      from: editor.state.selection.from - 2,
      to: editor.state.selection.from,
    });
    const last = onSlashState.mock.calls.at(-1)![0] as SlashTriggerState;
    expect(last.visible).toBe(false);
  });
});
