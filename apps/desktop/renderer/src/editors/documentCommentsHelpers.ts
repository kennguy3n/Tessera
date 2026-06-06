/**
 * Pure helpers + types for the document inline-comment feature.
 *
 * DOM-free and editor-free by design so they unit-test without booting
 * a TipTap `Editor` (the doc-walking that *does* need a ProseMirror doc
 * lives in `extensions/CommentMark.ts`). Covers comment id generation,
 * the display sort order, comment-input validation, and timestamp
 * formatting for the side panel.
 */

/**
 * A single comment thread anchored to a document range. Reconstructed
 * from the `comment` mark's attributes by
 * `collectCommentsFromDoc` — there is no separate persisted store; the
 * mark IS the store.
 */
export interface DocumentComment {
  /** Stable id shared by every mark fragment of this comment. */
  id: string;
  /** Display name of whoever authored the comment. */
  author: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** The comment body the author typed. */
  text: string;
  /** Whether the thread has been marked resolved. */
  resolved: boolean;
  /** The anchored document text the comment refers to. */
  quotedText: string;
  /** ProseMirror start position of the anchored range. */
  from: number;
  /** ProseMirror end position of the anchored range. */
  to: number;
}

/** Author label used when the editor has no signed-in user context. */
export const DEFAULT_COMMENT_AUTHOR = "You";

let commentIdCounter = 0;

/**
 * Generate a process-unique comment id. Combines a monotonic counter
 * (so two comments created in the same millisecond never collide) with
 * a timestamp + random suffix (so ids stay unique across reloads and
 * never accidentally re-use a counter value from a previous session).
 */
export function makeCommentId(): string {
  commentIdCounter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `cmt-${Date.now().toString(36)}-${commentIdCounter}-${rand}`;
}

/**
 * Trim + bound a raw comment-body string. Returns `null` when the body
 * is empty after trimming (callers should abort the add in that case).
 * The 10k cap mirrors the editor's other free-text limits and keeps a
 * runaway paste from bloating the persisted HTML attribute.
 */
export const MAX_COMMENT_LEN = 10_000;

export function normalizeCommentText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, MAX_COMMENT_LEN);
}

/**
 * Side-panel display order: open (unresolved) comments first, then
 * resolved ones; within each group, oldest first (by `createdAt`, then
 * by id as a stable tiebreaker). Pure + non-mutating — returns a new
 * array.
 */
export function sortComments(comments: DocumentComment[]): DocumentComment[] {
  return [...comments].sort((a, b) => {
    if (a.resolved !== b.resolved) return a.resolved ? 1 : -1;
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Count of unresolved comments — surfaced as the panel's badge. */
export function countOpenComments(comments: DocumentComment[]): number {
  return comments.reduce((n, c) => (c.resolved ? n : n + 1), 0);
}

/**
 * Render an ISO timestamp as a short, locale-aware label for the panel.
 * Falls back to the raw string when the timestamp can't be parsed so a
 * legacy/hand-edited value is still shown rather than "Invalid Date".
 */
export function formatCommentTimestamp(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
