/**
 * inline-comment mark extension.
 *
 * Anchors a comment thread to a document range by wrapping the
 * selected text in a `<span class="doc-comment" …>` mark. Every piece
 * of comment metadata (author, creation timestamp, resolved state, and
 * the comment body text) rides on the mark's attributes, so a comment
 * round-trips through the editor's HTML-only persistence layer
 * (`DocumentEditor` only ever calls `onSave(editor.getHTML())`) without
 * needing a side-channel store. The renderer-facing side panel
 * (`CommentsPanel`) reads the live set of comments back out of the doc
 * via {@link collectCommentsFromDoc}.
 *
 * Design choice (mirrors `FindReplaceExtension`): the doc-walking
 * helper that turns marks back into a flat `DocumentComment[]` lives in
 * this file and is exported so the React panel and the unit tests can
 * call it without booting a full editor. The pure, DOM-free helpers
 * (id generation, sorting, input validation, timestamp formatting) live
 * in `../documentCommentsHelpers` so they stay testable in isolation.
 */

import { Mark, mergeAttributes } from "@tiptap/core";
import type {
  Mark as ProseMirrorMark,
  Node as ProseMirrorNode,
} from "@tiptap/pm/model";
import type { DocumentComment } from "../documentCommentsHelpers";

/** Attributes persisted on every `comment` mark. */
export interface CommentMarkAttributes {
  commentId: string;
  author: string;
  createdAt: string;
  text: string;
  resolved: boolean;
}

declare module "@tiptap/core" {
  // Augment TipTap's command registry so the React panel + toolbar get
  // type-safe access to the comment commands.
  interface Commands<ReturnType> {
    comment: {
      /**
       * Wrap the current selection in a fresh comment mark. No-op when
       * the selection is empty (a comment must anchor to a range).
       */
      addComment: (attrs: CommentMarkAttributes) => ReturnType;
      /** Flip the `resolved` flag on every range carrying `commentId`. */
      setCommentResolved: (commentId: string, resolved: boolean) => ReturnType;
      /** Strip the comment mark for `commentId` from the whole doc. */
      removeComment: (commentId: string) => ReturnType;
    };
  }
}

/**
 * Walk a ProseMirror doc and collect one {@link DocumentComment} per
 * distinct `commentId`. The quoted text is the concatenation of every
 * text node carrying that comment's mark (in document order); the
 * `from`/`to` range spans the first and last such positions so the
 * panel can scroll/select the anchored text.
 *
 * Marks for the same `commentId` are expected to share identical
 * metadata attributes (the commands below always rewrite the whole
 * range together), so we take the author/timestamp/text/resolved values
 * from the first mark encountered and ignore any later divergence.
 */
export function collectCommentsFromDoc(
  doc: ProseMirrorNode,
): DocumentComment[] {
  // Preserve first-seen order so the panel's secondary sort (by
  // timestamp) is stable for comments created within the same ms.
  const order: string[] = [];
  const byId = new Map<
    string,
    {
      comment: DocumentComment;
      quoted: string[];
    }
  >();

  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const from = pos;
    const to = pos + node.nodeSize;
    // A single text node can carry MULTIPLE distinct comment marks
    // (the mark `excludes` nothing, so comments may overlap or nest).
    // Visit every one so a fully-nested comment is never swallowed by
    // the comment it sits inside.
    for (const mark of node.marks) {
      if (mark.type.name !== "comment") continue;
      const attrs = mark.attrs as Partial<CommentMarkAttributes>;
      const commentId = attrs.commentId;
      if (!commentId) continue;
      const existing = byId.get(commentId);
      if (existing) {
        existing.quoted.push(node.text);
        existing.comment.to = to;
      } else {
        order.push(commentId);
        byId.set(commentId, {
          quoted: [node.text],
          comment: {
            id: commentId,
            author: attrs.author ?? "",
            createdAt: attrs.createdAt ?? "",
            text: attrs.text ?? "",
            resolved: attrs.resolved === true,
            quotedText: "",
            from,
            to,
          },
        });
      }
    }
  });

  return order.map((id) => {
    const entry = byId.get(id)!;
    entry.comment.quotedText = entry.quoted.join("");
    return entry.comment;
  });
}

export const CommentMark = Mark.create({
  name: "comment",

  // Comments are metadata wrappers, not styling — they must survive
  // around other inline marks (bold/italic/links) without merging into
  // them, and two adjacent but DISTINCT comments must never collapse
  // into one. `inclusive: false` keeps typing at a comment's edge from
  // silently extending the anchored range.
  inclusive: false,
  excludes: "",

  addAttributes() {
    return {
      commentId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-comment-id"),
        renderHTML: (attrs) =>
          attrs.commentId
            ? { "data-comment-id": attrs.commentId as string }
            : {},
      },
      author: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-comment-author") ?? "",
        renderHTML: (attrs) => ({
          "data-comment-author": (attrs.author as string) ?? "",
        }),
      },
      createdAt: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-comment-created") ?? "",
        renderHTML: (attrs) => ({
          "data-comment-created": (attrs.createdAt as string) ?? "",
        }),
      },
      text: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-comment-text") ?? "",
        renderHTML: (attrs) => ({
          "data-comment-text": (attrs.text as string) ?? "",
        }),
      },
      resolved: {
        default: false,
        parseHTML: (el) => el.getAttribute("data-comment-resolved") === "true",
        renderHTML: (attrs) => ({
          "data-comment-resolved": attrs.resolved ? "true" : "false",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-comment-id]" }];
  },

  renderHTML({ HTMLAttributes, mark }) {
    const resolved = mark.attrs.resolved === true;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        class: resolved ? "doc-comment doc-comment-resolved" : "doc-comment",
      }),
      0,
    ];
  },

  addCommands() {
    return {
      addComment:
        (attrs) =>
        ({ state, dispatch }) => {
          const { from, to } = state.selection;
          // A comment must anchor to a non-empty range.
          if (from >= to) return false;
          if (dispatch) {
            const tr = state.tr.addMark(
              from,
              to,
              this.type.create({ ...attrs }),
            );
            dispatch(tr);
          }
          return true;
        },

      setCommentResolved:
        (commentId, resolved) =>
        ({ state, dispatch }) => {
          const ranges = findCommentRanges(state.doc, commentId);
          if (ranges.length === 0) return false;
          if (dispatch) {
            const { tr } = state;
            for (const range of ranges) {
              // Re-create the mark with every attribute preserved so the
              // author/timestamp/body survive a resolve toggle — only
              // `resolved` flips. Remove the SPECIFIC mark instance (not
              // the whole `comment` type) so an overlapping comment's
              // mark in the same range is left untouched.
              tr.removeMark(range.from, range.to, range.mark);
              tr.addMark(
                range.from,
                range.to,
                this.type.create({ ...range.attrs, resolved }),
              );
            }
            dispatch(tr);
          }
          return true;
        },

      removeComment:
        (commentId) =>
        ({ state, dispatch }) => {
          const ranges = findCommentRanges(state.doc, commentId);
          if (ranges.length === 0) return false;
          if (dispatch) {
            const { tr } = state;
            for (const range of ranges) {
              // Remove only this comment's mark instance; a different
              // comment overlapping the same range keeps its mark.
              tr.removeMark(range.from, range.to, range.mark);
            }
            dispatch(tr);
          }
          return true;
        },
    };
  },
});

interface CommentRange {
  from: number;
  to: number;
  attrs: CommentMarkAttributes;
  /** The exact mark instance, so callers can remove just this comment. */
  mark: ProseMirrorMark;
}

/**
 * Every contiguous `(from, to)` run carrying the comment mark for
 * `commentId`. Used by the resolve / remove commands to rewrite the
 * whole anchored range as one transaction.
 */
function findCommentRanges(
  doc: ProseMirrorNode,
  commentId: string,
): CommentRange[] {
  const ranges: CommentRange[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find(
      (m) => m.type.name === "comment" && m.attrs.commentId === commentId,
    );
    if (!mark) return;
    ranges.push({
      from: pos,
      to: pos + node.nodeSize,
      attrs: mark.attrs as CommentMarkAttributes,
      mark,
    });
  });
  return ranges;
}
