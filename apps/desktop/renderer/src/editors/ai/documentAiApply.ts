/**
 * Editor-mutation layer for the AI writing assistant.
 *
 * Separated from the React panel so the "where does the result go?"
 * logic is unit-testable against a headless TipTap `Editor` and the
 * panel stays a thin shell. Imports the `Editor` type (and so the
 * TipTap module graph) — keep PURE prompt/diff logic in
 * `documentAiHelpers.ts`, not here.
 */

import type { Editor } from "@tiptap/core";
import { aiResultToHtml } from "./documentAiHelpers";
import type {
  DocumentAiActionId,
  DocumentAiApplyMode,
} from "./documentAiTypes";

/** A captured document range (ProseMirror positions). */
export interface DocumentAiRange {
  from: number;
  to: number;
}

/** Snapshot of the editor state the AI panel needs at open time. */
export interface CapturedAiContext {
  selection: string;
  precedingText: string;
  range: DocumentAiRange | null;
}

/** Characters of upstream context handed to the `continue` action. */
const PRECEDING_WINDOW = 600;

/**
 * Capture the current selection text, a window of preceding text, and
 * the selection range from the live editor. Called when the AI panel
 * opens so the panel works against a stable snapshot even if focus
 * later moves into the panel's own inputs.
 */
export function captureAiContext(editor: Editor): CapturedAiContext {
  const { from, to } = editor.state.selection;
  const hasSelection = to > from;
  const selection = hasSelection
    ? editor.state.doc.textBetween(from, to, "\n", " ")
    : "";
  const precedingFrom = Math.max(0, from - PRECEDING_WINDOW);
  const precedingText = editor.state.doc.textBetween(
    precedingFrom,
    from,
    "\n",
    " ",
  );
  return {
    selection,
    precedingText,
    range: hasSelection ? { from, to } : null,
  };
}

/**
 * Resolve the position immediately after the top-level block that
 * contains `pos`, clamped to the document bounds. Used by the
 * `insert-below` apply mode to drop the result into a fresh block
 * after the user's current block rather than inside it.
 */
export function blockEndAfter(editor: Editor, pos: number): number {
  const { doc } = editor.state;
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const resolved = doc.resolve(clamped);
  // depth 0 == the doc node itself (cursor between top-level blocks):
  // fall back to the doc end so we still insert a valid block.
  if (resolved.depth === 0) return doc.content.size;
  // `after(1)` is the position just past the top-level ancestor block.
  return resolved.after(1);
}

/**
 * Apply a cleaned AI result to the editor.
 *
 *  - `replace`: requires a non-empty `range`; overwrites it.
 *  - `insert-below`: inserts a new block after the block containing
 *    `range.to` (or the current selection when `range` is null).
 *  - `append`: inserts at the end of the document.
 *
 * The `range` is a snapshot captured when the panel opened. The doc can
 * in principle shrink before the user applies (e.g. an async edit), which
 * would push the captured positions past the current end and make
 * `insertContentAt` throw a "Position out of range" error. We therefore
 * clamp the range to the live document bounds before using it — in the
 * normal (unchanged-doc) case this is a no-op, and if the snapshot has
 * gone stale we degrade safely (replace a valid sub-range, or reject when
 * it collapses) instead of crashing.
 *
 * Returns `true` when the mutation was dispatched, `false` when it was
 * rejected (e.g. `replace` with no selection) so the caller can keep
 * the preview open and surface a hint.
 */
export function applyAiResult(
  editor: Editor,
  range: DocumentAiRange | null,
  mode: DocumentAiApplyMode,
  text: string,
  action: DocumentAiActionId,
): boolean {
  const html = aiResultToHtml(text, action);
  const docSize = editor.state.doc.content.size;

  if (mode === "replace") {
    if (!range) return false;
    const from = Math.max(0, Math.min(range.from, docSize));
    const to = Math.max(from, Math.min(range.to, docSize));
    if (from >= to) return false;
    return editor.chain().focus().insertContentAt({ from, to }, html).run();
  }

  if (mode === "append") {
    const end = editor.state.doc.content.size;
    return editor.chain().focus().insertContentAt(end, html).run();
  }

  // insert-below
  const anchor = range ? range.to : editor.state.selection.to;
  const pos = blockEndAfter(editor, anchor);
  return editor.chain().focus().insertContentAt(pos, html).run();
}
