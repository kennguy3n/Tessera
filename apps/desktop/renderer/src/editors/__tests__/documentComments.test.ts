/**
 * Integration tests for the `CommentMark` TipTap extension.
 *
 * Stands up a headless `@tiptap/core` Editor with `StarterKit` +
 * `CommentMark` loaded (same harness shape as
 * `documentEditorExtensions.test.ts`) and exercises the full comment
 * lifecycle through the public commands:
 *
 *   - `addComment` wraps the current selection and `collectCommentsFromDoc`
 *     reads it back with author/timestamp/body/resolved + quoted text.
 *   - `addComment` is a no-op on an empty selection (nothing to anchor).
 *   - `setCommentResolved` flips `resolved` while preserving every other
 *     attribute.
 *   - `removeComment` strips the mark (comment disappears from the doc).
 *   - Comments survive an HTML round-trip (`getHTML` → re-parse), proving
 *     the mark IS the persistence store.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  CommentMark,
  collectCommentsFromDoc,
} from "../extensions/CommentMark";

const liveEditors: Editor[] = [];

function makeEditor(initialContent = "<p>Hello world</p>") {
  const editor = new Editor({
    extensions: [StarterKit, CommentMark],
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

function attrs(over: Partial<Record<string, unknown>> = {}) {
  return {
    commentId: "cmt-1",
    author: "Ada",
    createdAt: "2024-01-01T00:00:00.000Z",
    text: "Needs a citation",
    resolved: false,
    ...over,
  } as Parameters<Editor["commands"]["addComment"]>[0];
}

describe("CommentMark — add + collect", () => {
  it("anchors a comment to the selected range and reads it back", () => {
    const editor = makeEditor("<p>Hello world</p>");
    // Select "Hello" (positions 1..6 in a single leading paragraph).
    editor.commands.setTextSelection({ from: 1, to: 6 });
    const ok = editor.commands.addComment(attrs());
    expect(ok).toBe(true);

    const comments = collectCommentsFromDoc(editor.state.doc);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: "cmt-1",
      author: "Ada",
      text: "Needs a citation",
      resolved: false,
      quotedText: "Hello",
    });
    expect(comments[0].to).toBeGreaterThan(comments[0].from);
  });

  it("is a no-op when the selection is empty", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 1 });
    const ok = editor.commands.addComment(attrs());
    expect(ok).toBe(false);
    expect(collectCommentsFromDoc(editor.state.doc)).toHaveLength(0);
  });

  it("collects multiple distinct comments in document order", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.addComment(attrs({ commentId: "cmt-1" }));
    editor.commands.setTextSelection({ from: 7, to: 12 });
    editor.commands.addComment(attrs({ commentId: "cmt-2", text: "second" }));

    const comments = collectCommentsFromDoc(editor.state.doc);
    expect(comments.map((c) => c.id)).toEqual(["cmt-1", "cmt-2"]);
    expect(comments[1].quotedText).toBe("world");
  });
});

describe("CommentMark — resolve + remove", () => {
  it("flips resolved while preserving the other attributes", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.addComment(attrs());

    const ok = editor.commands.setCommentResolved("cmt-1", true);
    expect(ok).toBe(true);

    const [comment] = collectCommentsFromDoc(editor.state.doc);
    expect(comment.resolved).toBe(true);
    expect(comment).toMatchObject({
      author: "Ada",
      text: "Needs a citation",
      quotedText: "Hello",
    });
  });

  it("returns false when resolving an unknown comment id", () => {
    const editor = makeEditor("<p>Hello world</p>");
    expect(editor.commands.setCommentResolved("missing", true)).toBe(false);
  });

  it("removes the comment mark from the doc", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.addComment(attrs());
    expect(collectCommentsFromDoc(editor.state.doc)).toHaveLength(1);

    const ok = editor.commands.removeComment("cmt-1");
    expect(ok).toBe(true);
    expect(collectCommentsFromDoc(editor.state.doc)).toHaveLength(0);
  });
});

describe("CommentMark — HTML persistence round-trip", () => {
  it("survives serialization to HTML and back", () => {
    const editor = makeEditor("<p>Hello world</p>");
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.addComment(attrs());
    const html = editor.getHTML();
    expect(html).toContain('data-comment-id="cmt-1"');

    const reopened = makeEditor(html);
    const comments = collectCommentsFromDoc(reopened.state.doc);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: "cmt-1",
      author: "Ada",
      text: "Needs a citation",
      resolved: false,
      quotedText: "Hello",
    });
  });
});
