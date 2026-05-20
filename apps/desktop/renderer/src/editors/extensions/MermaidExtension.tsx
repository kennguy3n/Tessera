/**
 * TipTap node extension for Mermaid diagram blocks.
 *
 * Renders a `mermaid` node that stores the DSL as a node attribute and
 * displays a live SVG preview underneath an editable code area. Edits are
 * debounced before re-rendering to avoid trampling the parser on every
 * keystroke.
 *
 * Also installs an input rule so typing ` ```mermaid ` and then enter on a
 * blank line converts the surrounding code block into a mermaid node — this
 * preserves the user's muscle memory of fenced code blocks while letting us
 * own the rendering pipeline.
 */
import { Node, mergeAttributes, type CommandProps } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper } from "@tiptap/react";
import type { NodeViewProps } from "@tiptap/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  renderMermaid,
  MermaidRenderError,
  MermaidEnvironmentError,
  detectDiagramType,
} from "../../services/mermaidRenderer";

export interface MermaidNodeAttrs {
  dsl: string;
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    mermaidBlock: {
      insertMermaid: (dsl?: string) => ReturnType;
      updateMermaidDsl: (dsl: string) => ReturnType;
    };
  }
}

const DEFAULT_DSL = `flowchart TD
  A[Start] --> B{Decision?}
  B -- Yes --> C[OK]
  B -- No  --> D[Stop]`;

export const MermaidNode = Node.create({
  name: "mermaid",
  group: "block",
  // The DSL lives entirely in node attrs; the editable surface is rendered
  // inside the React node view, not as ProseMirror content, so this is a
  // leaf from ProseMirror's perspective.
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      dsl: {
        default: DEFAULT_DSL,
        parseHTML: (el) => el.getAttribute("data-dsl") ?? DEFAULT_DSL,
        renderHTML: (attrs) => ({
          "data-dsl": (attrs as MermaidNodeAttrs).dsl,
        }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="mermaid"]',
        getAttrs: (el) => {
          if (!(el instanceof HTMLElement)) return false;
          return { dsl: el.getAttribute("data-dsl") ?? "" };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, { "data-type": "mermaid" }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MermaidNodeView);
  },

  addCommands() {
    return {
      insertMermaid:
        (dsl?: string) =>
        ({ commands }: CommandProps) =>
          commands.insertContent({
            type: this.name,
            attrs: { dsl: dsl ?? DEFAULT_DSL },
          }),
      updateMermaidDsl:
        (dsl: string) =>
        ({ commands }: CommandProps) =>
          commands.updateAttributes(this.name, { dsl }),
    };
  },
});

const DEBOUNCE_MS = 250;

function MermaidNodeView({ node, updateAttributes, editor }: NodeViewProps) {
  const attrs = node.attrs as MermaidNodeAttrs;
  const [draft, setDraft] = useState(attrs.dsl);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const renderTokenRef = useRef(0);
  const detected = useMemo(() => detectDiagramType(draft), [draft]);

  useEffect(() => {
    setDraft(attrs.dsl);
  }, [attrs.dsl]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const token = ++renderTokenRef.current;
      renderMermaid(draft)
        .then((result) => {
          if (token !== renderTokenRef.current) return;
          setSvg(result.svg);
          setError(null);
        })
        .catch((err) => {
          if (token !== renderTokenRef.current) return;
          if (err instanceof MermaidEnvironmentError) {
            setError("Diagram preview is unavailable in this context.");
          } else if (err instanceof MermaidRenderError) {
            setError(err.message);
          } else {
            setError(String(err));
          }
          setSvg("");
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [draft]);

  return (
    <NodeViewWrapper
      className="tessera-mermaid-block"
      data-diagram-type={detected}
      contentEditable={false}
    >
      <div className="tessera-mermaid-toolbar">
        <span className="tessera-mermaid-kind">
          Mermaid · {detected === "unknown" ? "auto" : detected}
        </span>
        <button
          type="button"
          className="toolbar-btn"
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? "Hide source" : "Edit source"}
        </button>
        <button
          type="button"
          className="toolbar-btn"
          disabled={!editor.isEditable}
          onClick={() => {
            updateAttributes({ dsl: draft });
          }}
          title="Save the current source into the document"
        >
          Save
        </button>
      </div>
      {showSource && (
        <textarea
          className="tessera-mermaid-source"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          rows={Math.min(20, Math.max(4, draft.split("\n").length + 1))}
        />
      )}
      <div className="tessera-mermaid-preview">
        {error ? (
          <div className="tessera-mermaid-error" role="alert">
            <strong>Diagram error:</strong> {error}
          </div>
        ) : svg ? (
          <div
            className="tessera-mermaid-svg"
            // SVG output is sanitized by mermaid's strict security mode
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div className="tessera-mermaid-placeholder">Rendering…</div>
        )}
      </div>
    </NodeViewWrapper>
  );
}

export const __testing = {
  DEFAULT_DSL,
  DEBOUNCE_MS,
};
