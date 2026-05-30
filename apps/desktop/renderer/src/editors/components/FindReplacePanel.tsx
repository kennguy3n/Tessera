/**
 * Phase 18 PR 6 — find-and-replace panel.
 *
 * Floating panel anchored to the document editor. Renders:
 *   - Find input (live-updates matches and highlights as the user types)
 *   - Replace input (only enabled when ≥1 match exists)
 *   - Prev / Next match navigation (j/k or Enter cycles)
 *   - "1 of 17" match counter (or "No matches")
 *   - Case-sensitive / whole-word / regex toggles
 *   - Replace / Replace All buttons (only enabled when matches exist)
 *   - Close button + Esc handler
 *
 * The matching is delegated to `findAllMatches` so the panel and the
 * `FindReplaceExtension` decoration plugin agree on what counts as a
 * match. Replace operations dispatch ProseMirror transactions via the
 * extension's storage-position-map for accurate splicing.
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
import {
  findAllMatches,
  pickActiveMatch,
  type FindMatch,
} from "../documentEditorHelpers";
import {
  buildDocText,
  matchToDocRange,
  DEFAULT_FIND_OPTIONS,
} from "../extensions/FindReplaceExtension";

export interface FindReplacePanelProps {
  editor: Editor;
  /** Called when the user dismisses the panel (Esc or close button). */
  onClose: () => void;
}

export function FindReplacePanel({ editor, onClose }: FindReplacePanelProps) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const findInputRef = useRef<HTMLInputElement>(null);

  const opts = useMemo(
    () => ({ caseSensitive, wholeWord, regex }),
    [caseSensitive, wholeWord, regex],
  );

  // Recompute matches whenever the query, opts, or doc text changes.
  // We use a `useState` mirror of the matches so children re-render
  // when navigation moves the active index.
  const [matches, setMatches] = useState<FindMatch[]>([]);

  const recompute = useCallback(() => {
    if (!query) {
      setMatches([]);
      setActiveIndex(-1);
      editor.chain().focus(undefined, { scrollIntoView: false }).clearFindHighlight().run();
      return;
    }
    const snapshot = buildDocText(editor.state.doc);
    const next = findAllMatches(snapshot.text, query, opts);
    setMatches(next);
    const nextActive = next.length === 0 ? -1 : Math.max(0, Math.min(activeIndex, next.length - 1));
    setActiveIndex(nextActive);
    editor.chain().focus(undefined, { scrollIntoView: false }).applyFindHighlight(query, opts, nextActive).run();
  }, [editor, query, opts, activeIndex]);

  // Run on mount + on every query/opts change.
  useEffect(() => {
    recompute();
  }, [recompute]);

  // Re-run when the doc changes mid-search so the count stays accurate.
  useEffect(() => {
    if (!query) return;
    const handler = () => {
      const snapshot = buildDocText(editor.state.doc);
      setMatches(findAllMatches(snapshot.text, query, opts));
    };
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor, query, opts]);

  // Focus the find input on mount so the user can start typing.
  useEffect(() => {
    findInputRef.current?.focus();
  }, []);

  // Clear highlights when the panel unmounts.
  useEffect(() => {
    return () => {
      editor.chain().clearFindHighlight().run();
    };
  }, [editor]);

  const navigate = useCallback(
    (direction: "next" | "previous") => {
      if (matches.length === 0) return;
      const caret = editor.state.selection.from;
      // Translate caret (doc position) back to a plain-text index
      // using the same snapshot the matcher used.
      const snapshot = buildDocText(editor.state.doc);
      let textCaret = 0;
      for (let i = 0; i < snapshot.positions.length; i += 1) {
        if (snapshot.positions[i] >= caret) {
          textCaret = i;
          break;
        }
        textCaret = i + 1;
      }
      const nextIdx = pickActiveMatch(matches, textCaret, direction);
      setActiveIndex(nextIdx);
      editor.chain().applyFindHighlight(query, opts, nextIdx).run();
      // Scroll the match into view by setting the editor selection.
      const range = matchToDocRange(snapshot, matches[nextIdx]);
      if (range) {
        editor.chain().setTextSelection(range).scrollIntoView().run();
      }
    },
    [editor, matches, query, opts],
  );

  const doReplace = useCallback(() => {
    if (activeIndex < 0 || activeIndex >= matches.length) return;
    const snapshot = buildDocText(editor.state.doc);
    const range = matchToDocRange(snapshot, matches[activeIndex]);
    if (!range) return;
    editor
      .chain()
      .focus(undefined, { scrollIntoView: false })
      .insertContentAt(range, replacement)
      .run();
    // After splice, recompute matches and keep the active index
    // pointing at the same logical position (or clamp).
    setTimeout(() => recompute(), 0);
  }, [editor, matches, activeIndex, replacement, recompute]);

  const doReplaceAll = useCallback(() => {
    if (matches.length === 0) return;
    // Walk in reverse so each splice keeps the earlier indices valid.
    const snapshot = buildDocText(editor.state.doc);
    const chain = editor.chain().focus(undefined, { scrollIntoView: false });
    for (let i = matches.length - 1; i >= 0; i -= 1) {
      const range = matchToDocRange(snapshot, matches[i]);
      if (!range) continue;
      chain.insertContentAt(range, replacement);
    }
    chain.run();
    setTimeout(() => recompute(), 0);
  }, [editor, matches, replacement, recompute]);

  const onFindKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        navigate(e.shiftKey ? "previous" : "next");
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
    [navigate, onClose],
  );

  const status =
    query === ""
      ? ""
      : matches.length === 0
        ? "No matches"
        : `${activeIndex + 1} of ${matches.length}`;

  return (
    <div
      className="find-replace-panel"
      role="dialog"
      aria-label="Find and replace"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="find-replace-row">
        <input
          ref={findInputRef}
          type="text"
          className="find-replace-input"
          value={query}
          placeholder="Find"
          aria-label="Find"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFindKeyDown}
        />
        <span className="find-replace-status" aria-live="polite">
          {status}
        </span>
        <button
          type="button"
          className="find-replace-btn"
          onClick={() => navigate("previous")}
          disabled={matches.length === 0}
          title="Previous match (Shift+Enter)"
          aria-label="Previous match"
        >
          ‹
        </button>
        <button
          type="button"
          className="find-replace-btn"
          onClick={() => navigate("next")}
          disabled={matches.length === 0}
          title="Next match (Enter)"
          aria-label="Next match"
        >
          ›
        </button>
        <button
          type="button"
          className="find-replace-btn"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close find panel"
        >
          ×
        </button>
      </div>
      <div className="find-replace-row">
        <input
          type="text"
          className="find-replace-input"
          value={replacement}
          placeholder="Replace"
          aria-label="Replace with"
          onChange={(e) => setReplacement(e.target.value)}
        />
        <button
          type="button"
          className="find-replace-btn"
          onClick={doReplace}
          disabled={matches.length === 0 || activeIndex < 0}
        >
          Replace
        </button>
        <button
          type="button"
          className="find-replace-btn"
          onClick={doReplaceAll}
          disabled={matches.length === 0}
        >
          Replace all
        </button>
      </div>
      <div className="find-replace-row find-replace-options">
        <label className="find-replace-toggle">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.target.checked)}
          />
          Aa
        </label>
        <label className="find-replace-toggle">
          <input
            type="checkbox"
            checked={wholeWord}
            onChange={(e) => setWholeWord(e.target.checked)}
          />
          W
        </label>
        <label className="find-replace-toggle">
          <input
            type="checkbox"
            checked={regex}
            onChange={(e) => setRegex(e.target.checked)}
          />
          .*
        </label>
      </div>
    </div>
  );
}

export { DEFAULT_FIND_OPTIONS };
