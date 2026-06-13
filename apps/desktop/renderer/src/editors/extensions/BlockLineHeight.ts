/**
 * Block-level line-height extension.
 *
 * TipTap's stock `LineHeight` (from `@tiptap/extension-text-style`) stores
 * the value on the `textStyle` *mark* and its `setLineHeight` command is
 * hardcoded to `setMark("textStyle", { lineHeight })`. Pointing that
 * extension at block node types only moves where the *attribute* is
 * registered — the command still writes to the mark, where the attribute
 * no longer exists, so ProseMirror silently drops it and the control is a
 * no-op.
 *
 * Line spacing is a paragraph-level property (it is in Word/Google Docs),
 * so we register `lineHeight` as a global attribute on the configured
 * block nodes and provide commands that mutate those nodes via
 * `updateAttributes` / `resetAttributes` — exactly the pattern TipTap's
 * own `TextAlign` uses. `DocumentEditor`'s read path already reads
 * `editor.getAttributes("paragraph").lineHeight`, so it now round-trips.
 *
 * Security: the rendered value is emitted into an inline `style`, so it is
 * constrained to a strict numeric / unit grammar. Anything else (e.g. a
 * pasted `1; background:url(x)`) is dropped rather than written back out.
 */
import { Extension } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";

export interface BlockLineHeightOptions {
  /** Block node types that may carry a `lineHeight` attribute. */
  types: string[];
  /** The implicit value; never serialised so the theme default wins. */
  defaultLineHeight: string | null;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    blockLineHeight: {
      /** Set the line height on every configured block in the selection. */
      setLineHeight: (lineHeight: string) => ReturnType;
      /** Clear the line height, restoring the theme default. */
      unsetLineHeight: () => ReturnType;
    };
  }
}

/**
 * A unit-less multiplier (`1.5`) or a length with an allow-listed unit
 * (`24px`, `1.5em`, `150%`, `2rem`). The mantissa also accepts a leading-dot
 * form (`.5`, `.75em`) so values pasted from other editors aren't dropped.
 * Deliberately strict otherwise: the value is interpolated into a `style`
 * attribute, so anything outside this grammar is treated as untrusted and
 * ignored.
 */
const SAFE_LINE_HEIGHT = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|%)?$/;

function isSafeLineHeight(value: unknown): value is string {
  return typeof value === "string" && SAFE_LINE_HEIGHT.test(value.trim());
}

/**
 * Set `lineHeight` to `value` on every block of a configured `type` that
 * intersects the current selection, in a single transaction. Returns whether
 * at least one block was touched (so the command reports success). When
 * `dispatch` is absent (a dry run, e.g. `editor.can()`) the transaction is
 * built but not applied. `null` clears the attribute back to the theme
 * default.
 */
function applyToBlocks(
  types: string[],
  state: EditorState,
  tr: Transaction,
  dispatch: ((tr: Transaction) => void) | undefined,
  value: string | null,
): boolean {
  const typeSet = new Set(types);
  const { from, to } = state.selection;
  let applied = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!typeSet.has(node.type.name)) return;
    tr.setNodeAttribute(pos, "lineHeight", value);
    applied = true;
  });
  if (applied && dispatch) dispatch(tr);
  return applied;
}

export const BlockLineHeight = Extension.create<BlockLineHeightOptions>({
  name: "blockLineHeight",

  addOptions() {
    return {
      types: ["paragraph", "heading"],
      defaultLineHeight: null,
    };
  },

  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          lineHeight: {
            default: this.options.defaultLineHeight,
            parseHTML: (element) => {
              const raw = element.style.lineHeight?.trim();
              return raw && isSafeLineHeight(raw)
                ? raw
                : this.options.defaultLineHeight;
            },
            renderHTML: (attributes) => {
              const value = attributes.lineHeight as unknown;
              if (
                !isSafeLineHeight(value) ||
                value === this.options.defaultLineHeight
              ) {
                return {};
              }
              // `isSafeLineHeight` validates the trimmed value, so emit the
              // trimmed form too — keeps render/parse byte-identical even if a
              // raw value ever reaches here via direct ProseMirror manipulation.
              return { style: `line-height: ${value.trim()}` };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setLineHeight:
        (lineHeight) =>
        ({ state, tr, dispatch }) => {
          if (!isSafeLineHeight(lineHeight)) return false;
          // Store the trimmed value so what we persist always matches what
          // we validated (and the toolbar's preset `<option>` values).
          const trimmed = lineHeight.trim();
          // Apply to *every* configured block intersecting the selection, not
          // just the anchor block. TipTap's `updateAttributes` only touches the
          // node at the selection anchor, so a multi-paragraph selection would
          // leave all but one paragraph unchanged — surprising next to
          // Word/Google Docs. Walking the range with `setNodeAttribute` gives
          // the expected "format everything I selected" behaviour.
          return applyToBlocks(this.options.types, state, tr, dispatch, trimmed);
        },
      unsetLineHeight:
        () =>
        ({ state, tr, dispatch }) => {
          // Same range-wide pass as `setLineHeight`: clear the line height on
          // every selected block back to the theme default.
          const def = this.options.defaultLineHeight;
          return applyToBlocks(this.options.types, state, tr, dispatch, def);
        },
    };
  },
});
