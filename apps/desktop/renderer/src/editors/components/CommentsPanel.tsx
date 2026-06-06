/**
 * document comments side panel.
 *
 * Floating panel anchored to the document editor (same placement family
 * as `FindReplacePanel`). Lists every inline comment in the doc — open
 * threads first, then resolved — and offers resolve / unresolve / delete
 * per comment plus a click-to-jump that selects the anchored range.
 *
 * The panel is a pure presentation layer over `DocumentComment[]`: it
 * neither walks the doc nor mutates marks directly. The parent
 * (`DocumentEditor`) collects comments via `collectCommentsFromDoc` and
 * passes the callbacks that dispatch the `comment` mark commands.
 */

import { useMemo } from "react";
import {
  type DocumentComment,
  countOpenComments,
  formatCommentTimestamp,
  sortComments,
} from "../documentCommentsHelpers";

export interface CommentsPanelProps {
  comments: DocumentComment[];
  /** Toggle a comment's resolved state. */
  onToggleResolved: (comment: DocumentComment) => void;
  /** Delete a comment thread (removes the anchoring mark). */
  onRemove: (comment: DocumentComment) => void;
  /** Select the anchored range so the user can see what's referenced. */
  onJumpTo: (comment: DocumentComment) => void;
  /** Dismiss the panel. */
  onClose: () => void;
}

export function CommentsPanel({
  comments,
  onToggleResolved,
  onRemove,
  onJumpTo,
  onClose,
}: CommentsPanelProps) {
  const sorted = useMemo(() => sortComments(comments), [comments]);
  const openCount = countOpenComments(comments);

  return (
    <aside
      className="comments-panel"
      data-testid="comments-panel"
      aria-label="Document comments"
    >
      <div className="comments-panel-header">
        <span className="comments-panel-title">
          Comments{" "}
          <span className="comments-panel-count" data-testid="comments-open-count">
            {openCount} open
          </span>
        </span>
        <button
          type="button"
          className="find-replace-btn"
          onClick={onClose}
          aria-label="Close comments panel"
          title="Close comments"
        >
          ×
        </button>
      </div>

      {sorted.length === 0 ? (
        <p className="comments-panel-empty" data-testid="comments-empty">
          No comments yet. Select text and choose “Comment” to add one.
        </p>
      ) : (
        <ul className="comments-list">
          {sorted.map((comment) => (
            <li
              key={comment.id}
              className={
                comment.resolved
                  ? "comment-item comment-item-resolved"
                  : "comment-item"
              }
              data-testid={`comment-item-${comment.id}`}
              data-resolved={comment.resolved ? "true" : "false"}
            >
              <div className="comment-item-meta">
                <span className="comment-item-author">
                  {comment.author || "Unknown"}
                </span>
                <span className="comment-item-time">
                  {formatCommentTimestamp(comment.createdAt)}
                </span>
              </div>
              {comment.quotedText && (
                <button
                  type="button"
                  className="comment-item-quote"
                  onClick={() => onJumpTo(comment)}
                  title="Jump to the commented text"
                >
                  “{comment.quotedText}”
                </button>
              )}
              <p className="comment-item-body">{comment.text}</p>
              <div className="comment-item-actions">
                <button
                  type="button"
                  className="find-replace-btn"
                  onClick={() => onToggleResolved(comment)}
                  aria-label={
                    comment.resolved
                      ? `Reopen comment by ${comment.author || "Unknown"}`
                      : `Resolve comment by ${comment.author || "Unknown"}`
                  }
                >
                  {comment.resolved ? "Reopen" : "Resolve"}
                </button>
                <button
                  type="button"
                  className="find-replace-btn"
                  onClick={() => onRemove(comment)}
                  aria-label={`Delete comment by ${comment.author || "Unknown"}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
