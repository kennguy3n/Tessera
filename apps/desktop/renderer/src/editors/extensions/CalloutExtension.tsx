/**
 * TipTap node extension for Notion-style callout blocks.
 *
 * A callout is a coloured container with an icon and editable block
 * content (`block+`) — perfect for tips, warnings, and notes. The
 * variant drives the colour + default icon; the icon is itself
 * editable (click to cycle through a small emoji set) so users can
 * pick their own marker without a separate picker dependency.
 *
 * Serialisation: `renderHTML` emits
 * `<div data-type="callout" data-variant="…" data-icon="…">…</div>`
 * with a content hole, so the block round-trips losslessly through the
 * editor's HTML persistence and is preserved verbatim by the Markdown
 * exporter. The HTML exporter (`crates/tessera_export/src/html.rs`)
 * inlines the block as-is and ships matching CSS (the `data-icon`
 * surfaces via a `::before` pseudo). DOCX/PDF use a Markdown-oriented
 * line converter that keeps the text but flattens the container — a
 * pre-existing limitation shared by all rich blocks.
 */
import { Node, mergeAttributes, type CommandProps } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";

export type CalloutVariant = "info" | "success" | "warning" | "danger" | "note";

export interface CalloutAttrs {
  variant: CalloutVariant;
  icon: string;
}

/** Default icon for each variant, used when none is explicitly set. */
const CALLOUT_VARIANT_ICONS: Record<CalloutVariant, string> = {
  info: "💡",
  success: "✅",
  warning: "⚠️",
  danger: "🛑",
  note: "📝",
};

/** Variant cycle order for the in-place toggle. */
const CALLOUT_VARIANTS: readonly CalloutVariant[] = [
  "info",
  "success",
  "warning",
  "danger",
  "note",
];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (attrs?: Partial<CalloutAttrs>) => ReturnType;
      toggleCallout: (attrs?: Partial<CalloutAttrs>) => ReturnType;
      updateCalloutVariant: (variant: CalloutVariant) => ReturnType;
    };
  }
}

function normalizeVariant(value: string | null): CalloutVariant {
  return (CALLOUT_VARIANTS as readonly string[]).includes(value ?? "")
    ? (value as CalloutVariant)
    : "info";
}

export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      variant: {
        default: "info" as CalloutVariant,
        parseHTML: (el) => normalizeVariant(el.getAttribute("data-variant")),
        renderHTML: (attrs) => ({
          "data-variant": (attrs as CalloutAttrs).variant,
        }),
      },
      icon: {
        default: CALLOUT_VARIANT_ICONS.info,
        parseHTML: (el) =>
          el.getAttribute("data-icon") ?? CALLOUT_VARIANT_ICONS.info,
        renderHTML: (attrs) => ({ "data-icon": (attrs as CalloutAttrs).icon }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "callout" }),
      0,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutNodeView);
  },

  addCommands() {
    return {
      setCallout:
        (attrs?: Partial<CalloutAttrs>) =>
        ({ commands }: CommandProps) =>
          commands.wrapIn(this.name, resolveAttrs(attrs)),
      toggleCallout:
        (attrs?: Partial<CalloutAttrs>) =>
        ({ commands, editor }: CommandProps) => {
          if (editor.isActive(this.name)) {
            return commands.lift(this.name);
          }
          return commands.wrapIn(this.name, resolveAttrs(attrs));
        },
      updateCalloutVariant:
        (variant: CalloutVariant) =>
        ({ commands }: CommandProps) =>
          commands.updateAttributes(this.name, {
            variant,
            icon: CALLOUT_VARIANT_ICONS[variant],
          }),
    };
  },
});

function resolveAttrs(attrs?: Partial<CalloutAttrs>): CalloutAttrs {
  const variant = normalizeVariant(attrs?.variant ?? "info");
  return {
    variant,
    icon: attrs?.icon ?? CALLOUT_VARIANT_ICONS[variant],
  };
}

function CalloutNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const attrs = node.attrs as CalloutAttrs;

  const cycleVariant = () => {
    if (!editor.isEditable) return;
    const idx = CALLOUT_VARIANTS.indexOf(attrs.variant);
    const next = CALLOUT_VARIANTS[(idx + 1) % CALLOUT_VARIANTS.length];
    updateAttributes({ variant: next, icon: CALLOUT_VARIANT_ICONS[next] });
  };

  return (
    <NodeViewWrapper
      className="doc-callout"
      data-variant={attrs.variant}
      data-type="callout"
    >
      <button
        type="button"
        className="doc-callout-icon"
        contentEditable={false}
        onClick={cycleVariant}
        title="Change callout style"
        aria-label={`Callout style: ${attrs.variant}. Click to change.`}
        tabIndex={-1}
      >
        {attrs.icon}
      </button>
      <NodeViewContent className="doc-callout-content" />
    </NodeViewWrapper>
  );
}
