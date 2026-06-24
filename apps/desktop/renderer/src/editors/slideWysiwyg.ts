/**
 * Pure, framework-free helpers backing the Slide editor's WYSIWYG
 * "Design view" (see `SlideDesignCanvas`).
 *
 * Why a separate pure module
 * --------------------------
 * The Design view edits a `bullets` block as a real, themed list where
 * each bullet is its own inline field — pressing Enter splits a bullet,
 * Backspace at the start of a bullet merges it into the previous one,
 * and Delete at the end merges the next one up. Those caret-aware list
 * transforms are the bug-prone part of an inline list editor, so they
 * live here as small pure functions over a `string[]` of bullet lines
 * (plus a caret offset) and are unit-tested exhaustively, independent
 * of React, the DOM, or `contenteditable` quirks. The component only
 * has to wire `selectionStart` → these helpers → the resulting content
 * and focus target.
 *
 * Content model
 * -------------
 * A `bullets` block stores one bullet per line, newline-separated (the
 * same on-disk shape the structured editor and the Marp export already
 * use). `contentToBulletLines` / `bulletLinesToContent` convert between
 * that flat string and the per-bullet array the Design view renders,
 * with the invariant that an empty block is a single empty bullet (so
 * the list always shows at least one editable row).
 */

/**
 * The result of a caret-aware bullet transform: the new bullet lines
 * plus where focus/caret should land afterwards so the inline editor
 * can restore the cursor on the right row without a visible jump.
 */
export interface BulletEdit {
  lines: string[];
  /** Index of the bullet that should receive focus after the edit. */
  focusIndex: number;
  /** Caret offset (within that bullet's text) after the edit. */
  focusCaret: number;
}

/**
 * Split a block's stored `content` into one entry per bullet. An empty
 * string yields a single empty bullet so the rendered list is never
 * truly empty (there's always one row to type into); any other value
 * splits on `\n` verbatim, preserving interior blank bullets the user
 * deliberately created.
 */
export function contentToBulletLines(content: string): string[] {
  if (content === "") return [""];
  return content.split("\n");
}

/** Join per-bullet lines back into the newline-separated stored form. */
export function bulletLinesToContent(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Split the bullet at `index` at caret offset `caret`, producing two
 * bullets (the text before the caret stays in place; the text after it
 * becomes a new bullet directly below). Focus moves to the start of the
 * new bullet. Mirrors pressing Enter in a list item.
 *
 * `caret` is clamped to the bullet's bounds so an out-of-range offset
 * (e.g. a stale selection) can't slice outside the string.
 */
export function splitBulletAt(
  lines: readonly string[],
  index: number,
  caret: number,
): BulletEdit {
  const current = lines[index] ?? "";
  const at = clamp(caret, 0, current.length);
  const before = current.slice(0, at);
  const after = current.slice(at);
  const next = [
    ...lines.slice(0, index),
    before,
    after,
    ...lines.slice(index + 1),
  ];
  return { lines: next, focusIndex: index + 1, focusCaret: 0 };
}

/**
 * Merge the bullet at `index` into the previous bullet (the inverse of
 * a split), as when pressing Backspace with the caret at the start of a
 * bullet. Focus lands at the join seam in the merged bullet. Returns
 * `null` for the first bullet (nothing to merge into) so the caller can
 * fall through to the browser's default Backspace.
 */
export function mergeBulletBackward(
  lines: readonly string[],
  index: number,
): BulletEdit | null {
  if (index <= 0 || index >= lines.length) return null;
  const prev = lines[index - 1] ?? "";
  const current = lines[index] ?? "";
  const merged = prev + current;
  const next = [
    ...lines.slice(0, index - 1),
    merged,
    ...lines.slice(index + 1),
  ];
  return { lines: next, focusIndex: index - 1, focusCaret: prev.length };
}

/**
 * Merge the bullet after `index` into this bullet, as when pressing
 * Delete with the caret at the end of a bullet. Focus stays in place at
 * the join seam. Returns `null` for the last bullet (nothing to pull
 * up) so the caller can fall through to the default Delete behaviour.
 */
export function mergeBulletForward(
  lines: readonly string[],
  index: number,
): BulletEdit | null {
  if (index < 0 || index >= lines.length - 1) return null;
  const current = lines[index] ?? "";
  const nextLine = lines[index + 1] ?? "";
  const merged = current + nextLine;
  const next = [...lines.slice(0, index), merged, ...lines.slice(index + 2)];
  return { lines: next, focusIndex: index, focusCaret: current.length };
}

function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}
