/**
 * Link editor popover.
 *
 * Replaces the old `window.prompt("Enter URL")` flow with a proper
 * Google-Docs / Notion-style popover anchored to the current
 * selection. Supports:
 *   - Adding a link to the selected text (or editing an existing one).
 *   - Visiting the current link in the OS browser.
 *   - Removing the link mark.
 *
 * All hrefs are run through `normalizeLinkHref` so `javascript:` and
 * other script-bearing schemes can never be written into the document.
 * The popover is keyboard-accessible (Enter applies, Esc closes) and
 * uses the existing floating-panel design tokens.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Editor } from "@tiptap/react";
import { normalizeLinkHref } from "../documentEditorHelpers";

export interface LinkPopoverProps {
  editor: Editor;
  onClose: () => void;
}

/** Position the popover just below the current selection. */
function useSelectionAnchor(editor: Editor): { top: number; left: number } {
  return useMemo(() => {
    try {
      const { from } = editor.state.selection;
      const coords = editor.view.coordsAtPos(from);
      return { top: coords.bottom + 6, left: coords.left };
    } catch {
      // coordsAtPos can throw if the position is momentarily invalid
      // (e.g. doc just changed). Fall back to a safe corner.
      return { top: 96, left: 96 };
    }
    // Recompute only on open — selection is snapshotted by the parent.
  }, [editor]);
}

export function LinkPopover({ editor, onClose }: LinkPopoverProps) {
  const existingHref = (editor.getAttributes("link").href as string) ?? "";
  const [value, setValue] = useState(existingHref);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const anchor = useSelectionAnchor(editor);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const apply = useCallback(() => {
    const href = normalizeLinkHref(value);
    if (href === null) {
      if (value.trim().length === 0) {
        // Empty → treat as "remove link".
        editor.chain().focus().extendMarkRange("link").unsetLink().run();
        onClose();
        return;
      }
      setError("That link can't be used (unsupported or unsafe URL).");
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    onClose();
  }, [editor, value, onClose]);

  const remove = useCallback(() => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
    onClose();
  }, [editor, onClose]);

  const visit = useCallback(() => {
    const href = normalizeLinkHref(value);
    if (href) window.open(href, "_blank", "noopener,noreferrer");
  }, [value]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [apply, onClose],
  );

  return (
    <div
      className="link-popover"
      role="dialog"
      aria-label="Edit link"
      style={{ position: "fixed", top: anchor.top, left: anchor.left }}
      onKeyDown={onKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        className="link-popover-input"
        placeholder="Paste or type a link"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        aria-label="Link URL"
      />
      <div className="link-popover-actions">
        <button
          type="button"
          className="link-popover-btn primary"
          onClick={apply}
        >
          {existingHref ? "Update" : "Apply"}
        </button>
        {existingHref && (
          <button type="button" className="link-popover-btn" onClick={visit}>
            Visit
          </button>
        )}
        {existingHref && (
          <button
            type="button"
            className="link-popover-btn danger"
            onClick={remove}
          >
            Remove
          </button>
        )}
        <button type="button" className="link-popover-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {error && (
        <div className="link-popover-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
