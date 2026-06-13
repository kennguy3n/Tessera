/**
 * TipTap node extension for a live table-of-contents block.
 *
 * An atom block that renders the document's current headings as a
 * clickable, auto-numbered outline. The list re-derives from the doc
 * on every editor update (debounced by React's batching) so it stays
 * in sync as headings are added, edited, or removed — clicking an
 * entry scrolls to and selects that heading.
 *
 * Serialisation emits `<div data-type="table-of-contents"></div>` as a
 * bare marker (the live heading list is a node-view-only affordance and
 * is intentionally not persisted, so it can never go stale). The marker
 * round-trips through HTML persistence and Markdown export; the HTML
 * exporter (`crates/tessera_export/src/html.rs`) expands it into a real
 * `<nav>` by scanning the document's headings at export time, so the
 * exported artifact carries a freshly-derived, anchor-linked outline.
 */
import { Node, mergeAttributes, type CommandProps } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { collectHeadings, type HeadingEntry } from "../documentOutlineHelpers";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableOfContents: {
      insertTableOfContents: () => ReturnType;
    };
  }
}

export const TableOfContentsNode = Node.create({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  parseHTML() {
    return [{ tag: 'div[data-type="table-of-contents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "table-of-contents" }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TableOfContentsNodeView);
  },

  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ commands }: CommandProps) =>
          commands.insertContent({ type: this.name }),
    };
  },
});

function TableOfContentsNodeView({ editor }: NodeViewProps) {
  const [headings, setHeadings] = useState<HeadingEntry[]>(() =>
    collectHeadings(editor.state.doc),
  );

  useEffect(() => {
    const update = () => setHeadings(collectHeadings(editor.state.doc));
    editor.on("update", update);
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("update", update);
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  const jumpTo = (pos: number) => {
    editor.chain().focus().setTextSelection(pos + 1).run();
    const dom = editor.view.nodeDOM(pos);
    if (dom instanceof HTMLElement) {
      dom.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <NodeViewWrapper
      className="doc-toc"
      data-type="table-of-contents"
      contentEditable={false}
    >
      <div className="doc-toc-title">Table of contents</div>
      {headings.length === 0 ? (
        <p className="doc-toc-empty">Add headings to build the outline.</p>
      ) : (
        <ul className="doc-toc-list">
          {headings.map((h) => (
            <li
              key={h.id}
              className="doc-toc-item"
              style={{ paddingInlineStart: `${(h.level - 1) * 14}px` }}
            >
              <button
                type="button"
                className="doc-toc-link"
                onClick={() => jumpTo(h.pos)}
              >
                {h.text || "Untitled heading"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </NodeViewWrapper>
  );
}
