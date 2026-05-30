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
  // Mirror of `activeIndex` read inside `recompute` so the callback
  // does NOT depend on the state variable directly. If it did,
  // every `navigate()` (which calls `setActiveIndex(…)`) would
  // recreate `recompute`, retrigger the `useEffect([recompute])`
  // below, and double-dispatch the highlight command — wasted work
  // on every Prev / Next click. Devin Review PR #80 (BUG_…_0003)
  // flagged the redundant loop.
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
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
    // CRITICAL: do NOT call `editor.chain().focus(…)` here. The find
    // input is what owns DOM focus while this panel is mounted, and
    // `view.focus()` would yank focus to the editor on every
    // keystroke (because this callback fires from a `useEffect([
    // recompute])` keyed on `query`/`opts`). `applyFindHighlight`
    // and `clearFindHighlight` only dispatch meta transactions to
    // update the decoration plugin's state — ProseMirror does NOT
    // require editor focus to apply a meta-only transaction. Devin
    // Review PR #80 (BUG_…_0002 + ANALYSIS_…_0006) flagged this as
    // making the find input unusable.
    if (!query) {
      setMatches([]);
      setActiveIndex(-1);
      editor.chain().clearFindHighlight().run();
      return;
    }
    const snapshot = buildDocText(editor.state.doc);
    const next = findAllMatches(snapshot.text, query, opts);
    setMatches(next);
    // Read the *current* activeIndex via the ref so this callback's
    // identity doesn't change when navigation moves the index (see
    // `activeIndexRef` declaration above).
    const nextActive =
      next.length === 0
        ? -1
        : Math.max(0, Math.min(activeIndexRef.current, next.length - 1));
    setActiveIndex(nextActive);
    editor.chain().applyFindHighlight(query, opts, nextActive).run();
  }, [editor, query, opts]);

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
      // Rebuild the snapshot AND rerun the matcher inside `navigate`
      // so the position map, the match indices, and the caret
      // translation all come from the same doc revision. The
      // `matches` state mirror is updated by `recompute` and the
      // `editor.on("update")` handler, but those run on a different
      // cadence — a doc edit between recompute and a navigate click
      // would leave `matches` with stale indices that don't align
      // with the live position map. Reading them fresh here keeps
      // navigation deterministic. Devin Review PR #80
      // (ANALYSIS_…_0005) flagged the cross-snapshot race.
      const snapshot = buildDocText(editor.state.doc);
      const freshMatches = query
        ? findAllMatches(snapshot.text, query, opts)
        : [];
      if (freshMatches.length === 0) {
        setMatches([]);
        setActiveIndex(-1);
        return;
      }
      // Keep the panel's mirror in lock-step if the doc-update path
      // hasn't caught up yet — prevents the "1 of 17" counter from
      // momentarily showing a stale number after a navigation that
      // followed a quick edit.
      setMatches(freshMatches);
      const caret = editor.state.selection.from;
      let textCaret = 0;
      for (let i = 0; i < snapshot.positions.length; i += 1) {
        if (snapshot.positions[i] >= caret) {
          textCaret = i;
          break;
        }
        textCaret = i + 1;
      }
      const nextIdx = pickActiveMatch(freshMatches, textCaret, direction);
      setActiveIndex(nextIdx);
      editor.chain().applyFindHighlight(query, opts, nextIdx).run();
      // Scroll the match into view by setting the editor selection.
      const range = matchToDocRange(snapshot, freshMatches[nextIdx]);
      if (range) {
        editor.chain().setTextSelection(range).scrollIntoView().run();
      }
    },
    [editor, query, opts],
  );

  const doReplace = useCallback(() => {
    // Rebuild snapshot + matches from the live doc (same reasoning
    // as `navigate`: the closure-captured `matches`/`activeIndex`
    // could be from an earlier doc revision).
    const snapshot = buildDocText(editor.state.doc);
    const freshMatches = query
      ? findAllMatches(snapshot.text, query, opts)
      : [];
    const idx = activeIndexRef.current;
    if (idx < 0 || idx >= freshMatches.length) return;
    const range = matchToDocRange(snapshot, freshMatches[idx]);
    if (!range) return;
    // Drop the `.focus(…)` chain that was here: see the comment on
    // `recompute` above. `insertContentAt` doesn't require editor
    // focus, and pulling focus mid-replace would yank the caret out
    // of the Replace input on every click. Devin Review PR #80
    // (BUG_…_0002).
    editor.chain().insertContentAt(range, replacement).run();
    setTimeout(() => recompute(), 0);
  }, [editor, query, opts, replacement, recompute]);

  const doReplaceAll = useCallback(() => {
    const snapshot = buildDocText(editor.state.doc);
    const freshMatches = query
      ? findAllMatches(snapshot.text, query, opts)
      : [];
    if (freshMatches.length === 0) return;
    // Walk in reverse so each splice keeps the earlier indices valid.
    // No `.focus(…)` here either — same focus-theft rationale.
    const chain = editor.chain();
    for (let i = freshMatches.length - 1; i >= 0; i -= 1) {
      const range = matchToDocRange(snapshot, freshMatches[i]);
      if (!range) continue;
      chain.insertContentAt(range, replacement);
    }
    chain.run();
    setTimeout(() => recompute(), 0);
  }, [editor, query, opts, replacement, recompute]);

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
