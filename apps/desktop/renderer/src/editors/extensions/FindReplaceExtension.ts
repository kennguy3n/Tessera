/**
 * Phase 18 PR 6 — find-and-replace decoration extension.
 *
 * Renders persistent ProseMirror decorations for every match of the
 * current find-panel query so the user can see what they're navigating
 * across without losing their cursor.
 *
 * Design choice: the extension stores ONLY the latest highlight
 * descriptor (query + options + active index). React owns user-facing
 * state (text, matches array, replace input, etc.) and pushes
 * highlights via the `applyFindHighlight` command. The extension
 * doesn't need to know what a "match" is — it just paints. This keeps
 * the plugin's `apply` deterministic and trivially mappable through
 * concurrent edits.
 *
 * The match algorithm itself lives in
 * `documentEditorHelpers.findAllMatches` (and the position-map walk
 * lives in `buildDocText` below) so both are unit-tested without
 * booting the editor.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  findAllMatches,
  type FindMatch,
  type FindOptions,
} from "../documentEditorHelpers";

interface HighlightDescriptor {
  query: string;
  opts: FindOptions;
  /** -1 to render every match in the same "passive" colour. */
  activeIndex: number;
}

interface PluginState {
  highlight: HighlightDescriptor | null;
  decorations: DecorationSet;
}

const PLUGIN_KEY = new PluginKey<PluginState>("findReplace");

const EMPTY_OPTS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
};

export interface DocTextSnapshot {
  /** Concatenated visible text with `\n` between block boundaries. */
  text: string;
  /**
   * Parallel array: for every UTF-16 code unit in `text`, the
   * ProseMirror document position immediately *before* that code unit
   * inside its node. Use to convert a plain-text index into a
   * `{from, to}` document range for a decoration or a replace.
   */
  positions: number[];
}

/**
 * Walk a ProseMirror doc and emit a flat string + parallel position
 * map. Block boundaries are joined with `\n` so a query like
 * `Hello World` won't span two paragraphs invisibly — matching
 * Chromium's Ctrl+F.
 *
 * Exported because the React panel needs to call it to translate
 * `findAllMatches` indices back into PM positions for the replace
 * command.
 */
export function buildDocText(doc: ProseMirrorNode): DocTextSnapshot {
  const text: string[] = [];
  const positions: number[] = [];
  let needsBreak = false;
  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (needsBreak) {
        text.push("\n");
        positions.push(pos);
        needsBreak = false;
      }
      for (let i = 0; i < node.text.length; i += 1) {
        text.push(node.text[i]);
        positions.push(pos + i);
      }
    } else if (node.isBlock && text.length > 0) {
      needsBreak = true;
    }
  });
  return { text: text.join(""), positions };
}

/**
 * Translate a `FindMatch` (plain-text indices) into a `{from, to}`
 * document range. Returns null if the indices are out of bounds (a
 * defensive guard for the unlikely case where the React layer
 * dispatches with a stale snapshot relative to the live doc).
 */
export function matchToDocRange(
  snapshot: DocTextSnapshot,
  match: FindMatch,
): { from: number; to: number } | null {
  const { start, end } = match;
  if (start >= snapshot.positions.length) return null;
  const fromPos = snapshot.positions[start];
  const toEndIndex = Math.min(end - 1, snapshot.positions.length - 1);
  const toPos = snapshot.positions[toEndIndex] + 1;
  return { from: fromPos, to: toPos };
}

function buildDecorations(
  doc: ProseMirrorNode,
  highlight: HighlightDescriptor,
): DecorationSet {
  if (!highlight.query) return DecorationSet.empty;
  const snapshot = buildDocText(doc);
  const matches = findAllMatches(snapshot.text, highlight.query, highlight.opts);
  if (matches.length === 0) return DecorationSet.empty;
  const decos: Decoration[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const range = matchToDocRange(snapshot, matches[i]);
    if (!range) continue;
    decos.push(
      Decoration.inline(range.from, range.to, {
        class:
          i === highlight.activeIndex
            ? "find-match find-match-active"
            : "find-match",
      }),
    );
  }
  return DecorationSet.create(doc, decos);
}

declare module "@tiptap/core" {
  // Augment TipTap's command registry so the React panel gets type-
  // safe access to the extension's command.
  interface Commands<ReturnType> {
    findReplace: {
      applyFindHighlight: (
        query: string,
        opts: FindOptions,
        activeIndex: number,
      ) => ReturnType;
      clearFindHighlight: () => ReturnType;
    };
  }
}

export const FindReplaceExtension = Extension.create({
  name: "findReplace",

  addProseMirrorPlugins() {
    return [
      new Plugin<PluginState>({
        key: PLUGIN_KEY,
        state: {
          init(): PluginState {
            return { highlight: null, decorations: DecorationSet.empty };
          },
          apply(tr, prev): PluginState {
            const meta = tr.getMeta(PLUGIN_KEY) as
              | { highlight: HighlightDescriptor | null }
              | undefined;
            let next = prev;
            if (tr.docChanged && next.decorations !== DecorationSet.empty) {
              next = {
                ...next,
                decorations: next.decorations.map(tr.mapping, tr.doc),
              };
            }
            if (meta) {
              const highlight = meta.highlight;
              const decorations = highlight
                ? buildDecorations(tr.doc, highlight)
                : DecorationSet.empty;
              next = { highlight, decorations };
            } else if (tr.docChanged && next.highlight) {
              // Edit mid-search → recompute against the new doc.
              next = {
                ...next,
                decorations: buildDecorations(tr.doc, next.highlight),
              };
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            return PLUGIN_KEY.getState(state)?.decorations ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },

  addCommands() {
    return {
      applyFindHighlight:
        (query, opts, activeIndex) =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            const highlight: HighlightDescriptor = { query, opts, activeIndex };
            dispatch(tr.setMeta(PLUGIN_KEY, { highlight }));
          }
          return true;
        },
      clearFindHighlight:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) {
            dispatch(tr.setMeta(PLUGIN_KEY, { highlight: null }));
          }
          return true;
        },
    };
  },
});

export { PLUGIN_KEY as FindReplacePluginKey, EMPTY_OPTS as DEFAULT_FIND_OPTIONS };
