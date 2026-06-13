/**
 * TipTap node extension for collapsible "toggle" blocks (Notion's
 * toggle list / disclosure).
 *
 * A toggle has a plain-text summary line and editable block content
 * (`block+`) that collapses when closed. The summary is a node
 * attribute (kept plain so the schema stays a single node — no
 * fragile multi-node summary/content split) edited via an inline
 * input in the node view; the body is real editable content.
 *
 * Serialisation uses semantic `<details>` / `<summary>` so the block
 * round-trips losslessly through HTML persistence and is preserved
 * verbatim by the Markdown exporter. In HTML export
 * (`crates/tessera_export/src/html.rs`) it is inlined as-is, so it
 * renders as a real native disclosure widget — preserving the
 * open/closed state from the `open` attribute — with matching CSS.
 */
import { Node, mergeAttributes, type CommandProps } from "@tiptap/core";
import {
  ReactNodeViewRenderer,
  NodeViewWrapper,
  NodeViewContent,
} from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

export interface ToggleAttrs {
  open: boolean;
  summary: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    toggleBlock: {
      insertToggle: (attrs?: Partial<ToggleAttrs>) => ReturnType;
      setToggleOpen: (open: boolean) => ReturnType;
    };
  }
}

export const ToggleNode = Node.create({
  name: "toggle",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.hasAttribute("open"),
        renderHTML: (attrs) =>
          (attrs as ToggleAttrs).open ? { open: "open" } : {},
      },
      summary: {
        default: "",
        parseHTML: (el) =>
          el.querySelector(":scope > summary")?.textContent ?? "",
        // The summary is rendered as a real <summary> child in
        // renderHTML, not as an attribute, so nothing to add here.
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'details[data-type="toggle"]',
        contentElement: 'div[data-type="toggle-body"]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const summary = (node.attrs as ToggleAttrs).summary ?? "";
    return [
      "details",
      mergeAttributes(HTMLAttributes, { "data-type": "toggle" }),
      ["summary", {}, summary],
      ["div", { "data-type": "toggle-body" }, 0],
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ToggleNodeView);
  },

  addCommands() {
    return {
      insertToggle:
        (attrs?: Partial<ToggleAttrs>) =>
        ({ commands }: CommandProps) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              open: attrs?.open ?? true,
              summary: attrs?.summary ?? "",
            },
            content: [{ type: "paragraph" }],
          }),
      setToggleOpen:
        (open: boolean) =>
        ({ commands }: CommandProps) =>
          commands.updateAttributes(this.name, { open }),
    };
  },
});

function ToggleNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const attrs = node.attrs as ToggleAttrs;

  return (
    <NodeViewWrapper
      className="doc-toggle"
      data-type="toggle"
      data-open={attrs.open ? "true" : "false"}
    >
      <div className="doc-toggle-header" contentEditable={false}>
        <button
          type="button"
          className="doc-toggle-caret"
          onClick={() => updateAttributes({ open: !attrs.open })}
          aria-expanded={attrs.open}
          aria-label={attrs.open ? "Collapse" : "Expand"}
          title={attrs.open ? "Collapse" : "Expand"}
        >
          ▶
        </button>
        <input
          className="doc-toggle-summary"
          type="text"
          value={attrs.summary}
          placeholder="Toggle"
          disabled={!editor.isEditable}
          onChange={(e) => updateAttributes({ summary: e.target.value })}
          aria-label="Toggle summary"
        />
      </div>
      <NodeViewContent className="doc-toggle-body" />
    </NodeViewWrapper>
  );
}
