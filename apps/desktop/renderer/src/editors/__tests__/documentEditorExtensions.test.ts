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

  it("returns null on a zero-width match instead of producing NaN positions (BUG_0001)", () => {
    // Regex anchors like `^`, `$`, `\b`, and zero-width lookaheads
    // produce matches where `end === start`. The previous
    // implementation calculated `toEndIndex = end - 1` which for
    // `start === 0` was `-1`, made `positions[-1]` `undefined`, and
    // returned `to = undefined + 1 = NaN`. Every downstream
    // PM call (setTextSelection, insertContentAt, Decoration.inline)
    // would silently corrupt because NaN compares false to every
    // integer. The fix short-circuits zero-width matches to null
    // so the decoration plugin / replace path simply skips them.
    const editor = makeEditor({ initialContent: "<p>abc</p>" });
    const snapshot = buildDocText(editor.state.doc);
    expect(matchToDocRange(snapshot, { start: 0, end: 0 })).toBeNull();
    expect(matchToDocRange(snapshot, { start: 1, end: 1 })).toBeNull();
    // Sanity: a one-char match still works.
    const single = matchToDocRange(snapshot, { start: 1, end: 2 });
    expect(single).not.toBeNull();
    expect(single!.to).toBeGreaterThan(single!.from);
    expect(Number.isFinite(single!.from)).toBe(true);
    expect(Number.isFinite(single!.to)).toBe(true);
  });

  it("returns null when a match would span a block boundary instead of producing an unrenderable cross-block decoration (ANALYSIS_0003)", () => {
    // `buildDocText` emits a synthesized `\n` between adjacent block
    // nodes so cross-block searches don't false-match. The `\n` and
    // the first char of the next block end up mapped to the same PM
    // position, which would otherwise produce a Decoration.inline
    // whose from→to straddles a block close + next-block open — PM
    // logs a console warning and refuses to render it. The fix
    // detects an embedded `\n` in [start, end) and returns null so
    // the highlight plugin skips cross-block matches.
    const editor = makeEditor({
      initialContent: "<p>Alpha</p><p>Beta</p>",
    });
    const snapshot = buildDocText(editor.state.doc);
    expect(snapshot.text).toBe("Alpha\nBeta");
    const newlineIdx = snapshot.text.indexOf("\n");
    // A would-be regex match spanning "ha\nBe" (e.g. /a.B/s) crosses
    // the block. matchToDocRange must refuse it.
    const crossBlock = matchToDocRange(snapshot, {
      start: newlineIdx - 2,
      end: newlineIdx + 3,
    });
    expect(crossBlock).toBeNull();
    // Sanity: a match wholly inside one block is unaffected.
    const insideBlock = matchToDocRange(snapshot, {
      start: 0,
      end: 5,
    });
    expect(insideBlock).not.toBeNull();
  });

  it("returns null when the synthesized `\\n` is the FINAL character of the match (BUG_0001 off-by-one round 2)", () => {
    // Round 1 added the cross-block guard but the loop bound was
    // `i < toEndIndex` — toEndIndex = end - 1 is itself the LAST
    // character of the match, so a match that ends exactly on the
    // synthesized newline (e.g. /a\n/ matching the boundary between
    // "Alpha" and "Beta") fell through the guard. The decoration
    // plugin then asked PM to paint an inline range from inside
    // paragraph 1 to a position that PM treats as the open token of
    // paragraph 2 — PM logs "RangeError: Position N out of range" or
    // silently renders the highlight onto an unrelated block.
    // Devin Review PR #80 round 2 (BUG_0001) flagged the case.
    const editor = makeEditor({
      initialContent: "<p>Alpha</p><p>Beta</p>",
    });
    const snapshot = buildDocText(editor.state.doc);
    expect(snapshot.text).toBe("Alpha\nBeta");
    const newlineIdx = snapshot.text.indexOf("\n");
    // Match `a\n` — start at the `a` of "Alpha" (index 4) through
    // the `\n` at `newlineIdx` (inclusive in the half-open `end`
    // sense, so end = newlineIdx + 1).
    const endsOnNewline = matchToDocRange(snapshot, {
      start: newlineIdx - 1,
      end: newlineIdx + 1,
    });
    expect(endsOnNewline).toBeNull();
    // Match `\nB` (starts ON the newline) — also has a `\n` inside,
    // must also reject.
    const startsOnNewline = matchToDocRange(snapshot, {
      start: newlineIdx,
      end: newlineIdx + 2,
    });
    expect(startsOnNewline).toBeNull();
    // Sanity: a same-block match adjacent to (but not containing)
    // the boundary still works.
    const adjacent = matchToDocRange(snapshot, {
      start: newlineIdx - 2,
      end: newlineIdx,
    });
    expect(adjacent).not.toBeNull();
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

  it("dismissSlashMenu latches `suppressed` so the menu stays hidden on subsequent keystrokes (ANALYSIS_0001 round 2)", () => {
    // Round 1 closed the menu by clearing React state in the
    // DocumentEditor's `dismissSlash` callback, but the PM plugin
    // still observed a paragraph starting with `/` on the very next
    // transaction and republished `visible: true` — the popup
    // bounced back. The fix exposes a `dismissSlashMenu` command
    // that sets a `suppressed` latch on the plugin state; the
    // latch is cleared only when the trigger conditions themselves
    // stop holding (e.g. the `/` is deleted or a space is typed).
    const onSlashState = vi.fn();
    const editor = makeEditor({ onSlashState });
    editor.commands.insertContent("/list");
    // Sanity: menu is open.
    expect(
      (onSlashState.mock.calls.at(-1)![0] as SlashTriggerState).visible,
    ).toBe(true);
    onSlashState.mockClear();
    // Dismiss via the new command — equivalent to user pressing Esc.
    editor.commands.dismissSlashMenu();
    expect(
      (onSlashState.mock.calls.at(-1)![0] as SlashTriggerState).visible,
    ).toBe(false);
    expect(
      (onSlashState.mock.calls.at(-1)![0] as SlashTriggerState).suppressed,
    ).toBe(true);
    onSlashState.mockClear();
    // Now extend the query: paragraph becomes `/lists` — trigger
    // conditions STILL hold, but the latch must keep the menu
    // closed. Crucially, the plugin should NOT publish a new
    // `visible: true` state.
    editor.commands.insertContent("s");
    const visibleAfterTyping = onSlashState.mock.calls.some(
      (c) => (c[0] as SlashTriggerState).visible,
    );
    expect(visibleAfterTyping).toBe(false);
    onSlashState.mockClear();
    // Clear the trigger entirely (delete the whole `/lists`),
    // then re-enter `/`. The menu must reopen fresh.
    const end = editor.state.selection.from;
    editor.commands.deleteRange({ from: end - 6, to: end });
    editor.commands.insertContent("/");
    const last = onSlashState.mock.calls.at(-1)![0] as SlashTriggerState;
    expect(last.visible).toBe(true);
    expect(last.suppressed).toBe(false);
  });
});
