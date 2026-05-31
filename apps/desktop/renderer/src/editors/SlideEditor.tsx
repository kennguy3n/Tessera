import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useId,
  useMemo,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  renderMermaid,
  MermaidEnvironmentError,
  MermaidRenderError,
} from "../services/mermaidRenderer";
import {
  renderMarp,
  MarpRenderError,
  type MarpRenderOptions,
} from "../services/marpRenderer";
import {
  applyMarpToShadow,
  extractFrontmatterTheme,
  parseSlideContent,
  setFrontmatterTheme,
  buildSlideFromLayout,
  buildBlock,
  duplicateSlideAt,
  moveSlide as moveSlideHelper,
  moveBlock,
  removeBlock as removeBlockHelper,
  discardUploadTokensForSlide,
  discardUploadTokensForBlock,
  uploadTokenKey,
  appendBlock,
  replaceBlock,
  computeDeckWordCounts,
  findInSlides,
  fileToDataUrl,
  nextBlockForTypeChange,
  type ParsedSlideContent,
  type SlideFindMatch,
} from "./slideEditorHelpers";
import type {
  MarpModeState,
  Slide,
  SlideBlock,
  SlideBlockType,
  SlideContent,
  SlideLayout,
} from "./slideEditorTypes";

export type {
  SlideBlockType,
  SlideBlock,
  Slide,
  MarpModeState,
  SlideContent,
} from "./slideEditorTypes";

interface SlideEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
}

/**
 * Local helper component for the Speaker Notes textarea. Lives at a
 * separate component scope so we can call `useId()` to wire the
 * sibling-pattern `<label>` to the `<textarea>` via htmlFor /
 * matching id, satisfying the WCAG SC 1.3.1 / SC 4.1.2 requirement
 * that every form control has a programmatically associated label.
 */
function SpeakerNotesField({
  notes,
  onChange,
}: {
  notes: string;
  onChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <div className="slide-notes">
      <label htmlFor={id} className="slide-notes-label">
        Speaker Notes
      </label>
      <textarea
        id={id}
        className="slide-notes-input"
        value={notes}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Speaker notes for this slide..."
        rows={3}
      />
    </div>
  );
}

/**
 * Human-readable label for each layout choice in the Add Slide menu.
 * Kept here (rather than in `slideEditorTypes.ts`) so the helpers
 * module stays display-string-free — those types are consumed by
 * non-UI callers (e.g. the future export pipeline) and shouldn't ship
 * a hard dependency on English labels.
 */
const LAYOUT_LABELS: Record<SlideLayout, string> = {
  blank: "Blank",
  title: "Title only",
  titleContent: "Title + content",
  twoColumn: "Two columns",
  imageCaption: "Image + caption",
};

const LAYOUT_ORDER: SlideLayout[] = [
  "blank",
  "title",
  "titleContent",
  "twoColumn",
  "imageCaption",
];

export default function SlideEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
}: SlideEditorProps) {
  // Parse the initial content exactly once. Subsequent prop-driven changes
  // are handled by the sync effect below; recomputing on every keystroke
  // (via useMemo on `content`) would re-parse for nothing — the result is
  // only ever read by the useState initializers, which run on mount.
  const initialRef = useRef<ParsedSlideContent | null>(null);
  if (initialRef.current === null) {
    initialRef.current = parseSlideContent(content);
  }
  const initial = initialRef.current;
  const [slides, setSlides] = useState<Slide[]>(() => initial.slides);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const [marpMode, setMarpMode] = useState<boolean>(() => initial.marpMode);
  const [marpSource, setMarpSource] = useState<string>(() => initial.marpSource);
  const [marpTheme, setMarpTheme] = useState<MarpRenderOptions["theme"]>(
    () => initial.marpTheme ?? "default",
  );
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [findPanelOpen, setFindPanelOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  // Drag-and-drop reorder state. We track IDs (not indices) so the
  // dragged item survives a setState that re-renders the list with a
  // different array order — the source's index could change between
  // dragStart and drop, but its id can't.
  const [draggedSlideId, setDraggedSlideId] = useState<string | null>(null);
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  // Track the current Marp state in a ref so the save path can read the
  // latest value at *flush* time rather than capturing it at callback
  // creation time. This eliminates a closure-capture hazard where mutators
  // like `updateSlide` would otherwise serialise stale marp state when
  // Marp Mode / theme / source had been changed between callback creation
  // and the debounce timer firing.
  const marpStateRef = useRef<MarpModeState>({
    enabled: marpMode,
    source: marpSource,
    theme: marpTheme,
  });
  useEffect(() => {
    marpStateRef.current = {
      enabled: marpMode,
      source: marpSource,
      theme: marpTheme,
    };
  }, [marpMode, marpSource, marpTheme]);

  // Refs for the "+ Add Slide" trigger button and its layout-picker
  // popover. The click-outside effect below uses these to discriminate
  // "click inside the menu / on the toggle button" (which it must
  // ignore, since the toggle and the menu items handle their own
  // state) from "click outside" (which should dismiss the popover).
  const layoutMenuRef = useRef<HTMLDivElement | null>(null);
  const layoutButtonRef = useRef<HTMLButtonElement | null>(null);

  // Close the layout picker when the user clicks anywhere outside it.
  // We listen on `mousedown` (not `click`) so the dismiss happens
  // before any focused control inside the popover loses focus on
  // another input, matching the dismiss model used by other native
  // popovers (the menu button itself toggles state via its own
  // onClick, so we deliberately skip events originating from the
  // button to avoid the "open → outside-handler-closes → button
  // onClick-reopens" double-toggle).
  useEffect(() => {
    if (!layoutMenuOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (layoutMenuRef.current?.contains(target)) return;
      if (layoutButtonRef.current?.contains(target)) return;
      setLayoutMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLayoutMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [layoutMenuOpen]);

  // Global Ctrl+PageUp / Ctrl+PageDown — navigate to the previous /
  // next slide regardless of which control inside the editor has
  // focus. Matches Google Slides / LibreOffice Impress / Keynote and
  // mirrors the document-editor's `Ctrl+F` find shortcut wiring
  // (DocumentEditor.tsx: same global-listener pattern).
  //
  // Behaviour notes:
  //   * `PageUp` / `PageDown` aren't text-editing keys in any
  //     browser-shipped textarea / input, so swallowing them with
  //     `preventDefault()` doesn't conflict with native edit gestures.
  //   * Cmd is treated identically to Ctrl so macOS users get the
  //     same shortcut without a separate code path. The browser
  //     itself doesn't reserve `Cmd+PageUp/Dn` on macOS (it's not a
  //     tab-switch chord like `Cmd+Opt+Arrow`), so there's no
  //     accelerator collision.
  //   * The listener is attached ONCE for the component lifetime
  //     and reads the latest `navigateBy` via a ref. This avoids
  //     detaching / re-attaching the document-level listener every
  //     time `slides.length` changes (which is every keystroke
  //     that adds/removes a slide). The `navigateByRef` is updated
  //     inline below `navigateBy`'s declaration so the listener
  //     always sees the freshest closure without being recreated.
  const navigateByRef = useRef<(delta: number) => void>(() => {});
  useEffect(() => {
    const onNavKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.key === "PageUp") {
        event.preventDefault();
        navigateByRef.current(-1);
      } else if (event.key === "PageDown") {
        event.preventDefault();
        navigateByRef.current(1);
      }
    };
    document.addEventListener("keydown", onNavKey);
    return () => document.removeEventListener("keydown", onNavKey);
  }, []);

  const debouncedSave = useCallback(
    (updatedSlides: Slide[], marpState?: MarpModeState) => {
      // Serialise eagerly so onDraftChange fires with the same payload
      // the debounced onSave will commit. Doing it here (rather than
      // inside the timer) also avoids reading marpStateRef twice and
      // potentially seeing different state.
      const data: SlideContent = {
        slides: updatedSlides,
        marp: marpState ?? marpStateRef.current,
      };
      const json = JSON.stringify(data);
      // Publish the draft immediately (no debounce) so exporting before
      // the auto-save fires still captures the live editor state.
      onDraftChange?.(json);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, onDraftChange, autoSaveMs],
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Sync external content prop changes (e.g., version restore).
  //
  // A version restore is a hard swap of the deck — every per-slide /
  // per-block piece of in-flight state attached to the *old* deck has
  // to be torn down or it ends up pointing at slides / blocks that no
  // longer exist:
  //
  //   * `activeIndex` is clamped against the new deck length, mirroring
  //     the careful index-management `removeSlide` already does. Without
  //     this, restoring an older version with fewer slides leaves the
  //     canvas blank (the JSX guards on `activeSlide &&` so we don't
  //     crash, but the user has to manually click a thumbnail to recover).
  //     Devin Review PR #82 (ANALYSIS_…_0001) flagged the asymmetry with
  //     `removeSlide`.
  //   * `draggedSlideId` / `draggedBlockId` cleared so an in-flight drag
  //     started before the restore can't fall through to `onDrop` with a
  //     dead source id (the source slide / block has been swapped out
  //     from under the drag).
  //   * `uploadTokensRef` cleared because every entry is keyed by
  //     `(slideId|blockId)` and those ids no longer resolve to anything
  //     in the new deck. Leaving stale tokens means a late-resolving
  //     `fileToDataUrl` from before the restore would see a
  //     `currentToken !== ownToken` mismatch (good, it bails) but the
  //     entry itself would persist forever — same leak the round 7 fix
  //     closed for block deletion, just at the deck level.
  useEffect(() => {
    if (content !== lastSavedRef.current) {
      const parsed = parseSlideContent(content);
      setSlides(parsed.slides);
      setActiveIndex((prev) =>
        Math.min(prev, Math.max(0, parsed.slides.length - 1)),
      );
      setMarpMode(parsed.marpMode);
      setMarpSource(parsed.marpSource);
      setMarpTheme(parsed.marpTheme ?? "default");
      setDraggedSlideId(null);
      setDraggedBlockId(null);
      uploadTokensRef.current.clear();
      lastSavedRef.current = content;
    }
  }, [content]);

  const updateSlide = useCallback(
    (index: number, patch: Partial<Slide>) => {
      setSlides((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], ...patch };
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  /**
   * Add a new slide using the given layout. The new slide is inserted
   * at the end of the deck and becomes the active slide; this matches
   * the prior single-button "+ Add Slide" behaviour for users who don't
   * care about layout, while letting power-users pre-populate the
   * block skeleton in one click.
   */
  const addSlide = useCallback(
    (layout: SlideLayout) => {
      setSlides((prev) => {
        const updated = [...prev, buildSlideFromLayout(layout)];
        setActiveIndex(updated.length - 1);
        debouncedSave(updated);
        return updated;
      });
      setLayoutMenuOpen(false);
    },
    [debouncedSave],
  );

  const duplicateSlide = useCallback(
    (index: number) => {
      setSlides((prev) => {
        const { slides: next, insertedAt } = duplicateSlideAt(prev, index);
        // `duplicateSlideAt` returns the input array unchanged + `-1` on an
        // out-of-range index. Bail out of the setState so React doesn't
        // commit an identical reference (which would still trigger
        // child reconciliation if we let the new array escape).
        if (insertedAt < 0) return prev;
        setActiveIndex(insertedAt);
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const removeSlide = useCallback(
    (index: number) => {
      setSlides((prev) => {
        if (prev.length <= 1) return prev;
        if (index < 0 || index >= prev.length) return prev;
        // Free upload-race tokens for every block in the slide we're
        // about to drop. The `uploadTokensRef` Map otherwise accumulates
        // dead `${slideId}|${blockId}` entries for the lifetime of the
        // editor (Devin Review PR #82 round 7 ANALYSIS_…_0003). The
        // entries are tiny (a string key + small int) but a long
        // editing session that adds/removes many slides would let the
        // Map grow without bound. We delete based on the OUTGOING slide
        // (read from `prev[index]` not `slides`) so this is safe inside
        // a `setSlides` updater even if React batches multiple removes.
        const removed = prev[index];
        if (removed) {
          discardUploadTokensForSlide(
            uploadTokensRef.current,
            removed.id,
            removed.blocks,
          );
        }
        const updated = prev.filter((_, i) => i !== index);
        // Adjust the active pointer relative to the deletion point so the
        // user stays anchored on roughly the same slide:
        //   • deleting *before* active → all surviving slides shift left
        //     by one, so the active index must decrement to track the
        //     same content.
        //   • deleting *at* active → keep the index but clamp to the new
        //     last slide so we never point past the end (this leaves the
        //     focus on what was the next slide; if we deleted the last
        //     slide, we fall back to the new last slide).
        //   • deleting *after* active → the active slide is untouched and
        //     stays at its original index.
        setActiveIndex((current) => {
          let next: number;
          if (index < current) {
            next = current - 1;
          } else if (index === current) {
            next = Math.min(current, updated.length - 1);
          } else {
            next = current;
          }
          return Math.max(0, Math.min(next, updated.length - 1));
        });
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const moveSlide = useCallback(
    (from: number, to: number) => {
      setSlides((prev) => {
        const updated = moveSlideHelper(prev, from, to);
        // `moveSlideHelper` is reference-stable on out-of-range / same-
        // position moves, so React skips the re-render entirely when
        // the user drag-drops a slide back onto itself.
        if (updated === prev) return prev;
        // Keep the active pointer anchored to the moved slide so the
        // canvas continues to render what the user just dragged.
        // `setActiveIndex` receives the *new* index because the helper
        // already placed the moved slide at `to` in the next array.
        setActiveIndex(to);
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  // Pure navigation — change which slide is active without touching
  // the deck order. Phase 19 PR 11 introduces this as the canonical
  // "navigate by N slides" primitive, shared by:
  //
  //   * the toolbar Prev / Next buttons,
  //   * the `Ctrl+PageUp` / `Ctrl+PageDown` global keyboard shortcuts,
  //   * the sidebar Arrow-Up / Arrow-Down handler.
  //
  // Uses the functional `setActiveIndex` form so the closure doesn't
  // capture a stale `activeIndex`, and reads `slides.length` from the
  // dep array so a rapid sequence of navigates during a deck-size
  // change clamps against the current length, not a captured one.
  // Clamping (rather than wrapping or no-oping past the edge) matches
  // LibreOffice Impress and Google Slides behaviour: holding the key
  // at the last slide is a no-op, not a wrap-to-first.
  const navigateBy = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        if (slides.length === 0) return current;
        const next = current + delta;
        return Math.max(0, Math.min(slides.length - 1, next));
      });
    },
    [slides.length],
  );
  // Keep `navigateByRef` pointed at the latest `navigateBy` closure
  // so the global Ctrl+PageUp/Down listener (attached once at mount)
  // always invokes the current implementation. `navigateBy` itself
  // changes identity whenever `slides.length` does — without the ref
  // dance, we'd be detaching and re-attaching a document-level
  // keydown listener on every deck-size change.
  navigateByRef.current = navigateBy;

  // Same primitive as `navigateBy` but for absolute targets (Home,
  // End, sidebar click). The thumb buttons themselves still wire
  // `onClick={() => setActiveIndex(i)}` directly because they pass a
  // known-valid index from the render `slides.map(...)`; this helper
  // is the public form that can be called with anything (e.g.
  // `goToSlide(slides.length - 1)` for End, which would be a stale
  // value if the deck shrank between keydown and the setState fire).
  const goToSlide = useCallback(
    (target: number) => {
      setActiveIndex(() => {
        if (slides.length === 0) return 0;
        return Math.max(0, Math.min(slides.length - 1, target));
      });
    },
    [slides.length],
  );

  // Refs to each `.slide-thumb` <button>, keyed by `slide.id`. Used by
  // the sidebar arrow-key handler to programmatically focus the newly
  // active thumb so the focus ring follows the user's selection.
  //
  // Keying by `slide.id` (not array index) is important: when a
  // reorder happens, the thumb's index changes but its id (and DOM
  // element identity, because the React key is also `slide.id`) is
  // stable. The handler can therefore look up "the thumb the active
  // slide *is now*" without caring about reorder.
  //
  // We delete from the map on unmount (the ref callback receives
  // `null` when React detaches the element) so removed slides don't
  // leave dangling DOM references after the slide is deleted from
  // the deck.
  const thumbRefs = useRef<Map<string, HTMLButtonElement | null>>(
    new Map(),
  );

  // Ref-callback factory bound to a specific `slide.id`. Stable
  // across renders for the same id (so React doesn't see a new ref
  // function every render and detach/re-attach the DOM node). We
  // memoise the factory itself via `useCallback`; the per-id
  // closure is recreated on each call but React's ref-callback
  // protocol only cares about reference-stability for the SAME id,
  // which this gives.
  const setThumbRef = useCallback(
    (id: string) => (node: HTMLButtonElement | null) => {
      if (node) {
        thumbRefs.current.set(id, node);
      } else {
        thumbRefs.current.delete(id);
      }
    },
    [],
  );

  // Arrow-key navigation handler attached to each thumb's <button>.
  // Mirrors the standard listbox-pattern keyboard contract:
  //
  //   ArrowUp   → navigate to previous slide
  //   ArrowDown → navigate to next slide
  //   Home      → jump to first slide
  //   End       → jump to last slide
  //
  // Phase 19 PR 11: this is the third entry point into the shared
  // `navigateBy` / `goToSlide` navigation primitives, alongside the
  // toolbar Prev/Next buttons and the global Ctrl+PageUp/Dn
  // shortcut. Matches the WAI-ARIA "listbox" authoring practice for
  // a vertically-oriented set of options.
  //
  // After updating the active index we programmatically focus the
  // target thumb so the focus ring follows the selection. The
  // target thumb is already mounted (only the `active` class
  // changes between renders, not the element identity), so the
  // focus call works synchronously without waiting for React to
  // re-render.
  const handleThumbKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, slideIndex: number) => {
      let targetIndex: number | null = null;
      if (event.key === "ArrowUp") {
        targetIndex = Math.max(0, slideIndex - 1);
      } else if (event.key === "ArrowDown") {
        targetIndex = Math.min(slides.length - 1, slideIndex + 1);
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = slides.length - 1;
      } else {
        return;
      }
      // Always preventDefault on the keys we handle, even on edge no-ops
      // (e.g. ArrowUp at index 0). Otherwise the browser would scroll
      // the sidebar container in response to the arrow key, which
      // produces a confusing "the keypress did SOMETHING but not what
      // I expected" feel.
      event.preventDefault();
      if (targetIndex === slideIndex) return;
      goToSlide(targetIndex);
      const target = slides[targetIndex];
      if (target) {
        const node = thumbRefs.current.get(target.id);
        node?.focus();
      }
    },
    [goToSlide, slides],
  );

  // ───── Block-level mutators (delegate to helpers) ─────────────────
  //
  // Each one is a one-liner over the corresponding helper from
  // `slideEditorHelpers.ts`. The helpers return reference-stable
  // results on no-op inputs (out-of-range indices, identical from/to,
  // …) so we don't need to special-case those here — React's setState
  // does the identity check itself.

  const onBlockMove = useCallback(
    (slideIndex: number, from: number, to: number) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = moveBlock(slide, from, to);
        if (updatedSlide === slide) return prev;
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const onBlockRemove = useCallback(
    (slideIndex: number, blockIndex: number) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = removeBlockHelper(slide, blockIndex);
        if (updatedSlide === slide) return prev;
        // Free the upload-race token for the dropped block so the Map
        // doesn't accumulate dead entries (Devin Review PR #82 round 7
        // ANALYSIS_…_0003). Read the block off `prev[slideIndex]` (the
        // freshest state inside the updater) rather than the outer
        // `slides` closure so a concurrent remove doesn't free the
        // wrong key. `removeBlockHelper` returns the SAME slide ref on
        // out-of-range indices — we already early-return above in that
        // case, so reaching this point guarantees the helper finds the
        // outgoing block to discard.
        discardUploadTokensForBlock(
          uploadTokensRef.current,
          slide,
          blockIndex,
        );
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const onBlockAppend = useCallback(
    (slideIndex: number, block: SlideBlock) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = appendBlock(slide, block);
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const onBlockReplace = useCallback(
    (slideIndex: number, blockIndex: number, block: SlideBlock) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = replaceBlock(slide, blockIndex, block);
        if (updatedSlide === slide) return prev;
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // ───── Find panel ─────────────────────────────────────────────────
  //
  // Recompute matches every time the query / case-sensitivity / slide
  // data changes. The match list is memoised so re-renders that don't
  // touch any of the four inputs (e.g. block-content edits on a
  // different slide than the active match) don't trigger a re-walk.

  const findMatches = useMemo<SlideFindMatch[]>(
    () => findInSlides(slides, findQuery, { caseSensitive: findCaseSensitive }),
    [slides, findQuery, findCaseSensitive],
  );

  // Clamp the active match index against the live match count so the
  // status line never shows "5 of 3". We do this inline (rather than in
  // an effect) so the render synchronously sees the clamped value —
  // following the same pattern PR 6 used for the slash-menu highlight.
  const effectiveFindIndex =
    findMatches.length === 0
      ? 0
      : Math.max(0, Math.min(findActiveIndex, findMatches.length - 1));

  // Sync the React state when the inline clamp produced a different
  // value. We only write when the values actually differ to avoid a
  // setState loop.
  useEffect(() => {
    if (effectiveFindIndex !== findActiveIndex) {
      setFindActiveIndex(effectiveFindIndex);
    }
  }, [effectiveFindIndex, findActiveIndex]);

  // Jump the active-slide pointer to whichever slide the active match
  // lives on so the user sees the matched content immediately.
  useEffect(() => {
    if (findMatches.length === 0) return;
    const match = findMatches[effectiveFindIndex];
    if (match && match.slideIndex !== activeIndex) {
      setActiveIndex(match.slideIndex);
    }
    // We deliberately omit `activeIndex` from the deps so we don't
    // re-jump when the user manually clicks a different thumbnail
    // while the find panel is open — only an explicit Next / Prev
    // (which changes `effectiveFindIndex`) should reseat the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFindIndex, findMatches]);

  const navigateFind = useCallback(
    (direction: "next" | "previous") => {
      if (findMatches.length === 0) return;
      setFindActiveIndex((prev) => {
        const len = findMatches.length;
        if (direction === "next") return (prev + 1) % len;
        return (prev - 1 + len) % len;
      });
    },
    [findMatches.length],
  );

  // ───── Image-block upload ─────────────────────────────────────────
  //
  // `fileToDataUrl` returns a promise; on resolution we replace the
  // block in-place with the data URL. On rejection (the FileReader
  // failing — extremely rare for browser uploads but possible for a
  // race-condition during a tab close) we log to the console rather
  // than surfacing an error to the user, because the block is still
  // in a valid empty state.
  //
  // Concurrent-upload race: the user can pick file A, then immediately
  // pick file B before A's FileReader completes. Without coordination,
  // whichever read finishes LAST wins — regardless of which was picked
  // last (FileReader resolution order is not deterministic across
  // sizes; a large A picked first then a small B could resolve in B-A
  // order, but the opposite is also possible). We solve this with a
  // per-block sequence counter: every upload bumps the counter for
  // its (slideId, blockId) key and captures the post-bump value
  // as its token. After awaiting, the resolver checks whether the
  // counter has advanced past its token — if so, a newer upload has
  // started, and the stale result is discarded silently.
  //
  // The key uses `slide.id` AND `block.id` (both stable across drag-
  // reorders) rather than positional indices, because PR 8 introduces
  // drag-and-drop reorder at BOTH the slide and block levels. If the
  // user picks a file then drags either the containing slide or the
  // block to a new position before the FileReader resolves, an
  // index-based key would (a) misroute the result onto whichever
  // slide/block now occupies the old index — silent corruption —
  // and (b) silently lose the upload if no image block sits at that
  // (slideIndex, blockIndex) coordinate anymore. Keying off the
  // stable IDs makes the upload follow the target block through any
  // reorder, and the `findIndex` lookups inside the setSlides updater
  // resolve the live positions against React's latest state.
  const uploadTokensRef = useRef<Map<string, number>>(new Map());

  const onImageUpload = useCallback(
    async (
      slideId: string,
      blockId: string,
      file: File,
    ) => {
      const tokenKey = uploadTokenKey(slideId, blockId);
      const nextToken = (uploadTokensRef.current.get(tokenKey) ?? 0) + 1;
      uploadTokensRef.current.set(tokenKey, nextToken);
      try {
        const dataUrl = await fileToDataUrl(file);
        // Race guard: if another upload to the same block has started
        // after this one began, drop the stale result so the newer
        // upload's URL is the one that lands in the block.
        if (uploadTokensRef.current.get(tokenKey) !== nextToken) return;
        setSlides((prev) => {
          // Resolve slide-then-block by id against the freshest state
          // React hands us, so a drag-reorder at either level between
          // dragstart and FileReader resolution still routes the data
          // URL onto the originally targeted block. If either entity
          // no longer exists (user removed the slide / block mid-
          // upload), bail out cleanly.
          const slideIndex = prev.findIndex((s) => s.id === slideId);
          if (slideIndex < 0) return prev;
          const slide = prev[slideIndex];
          const blockIndex = slide.blocks.findIndex((b) => b.id === blockId);
          if (blockIndex < 0) return prev;
          const block = slide.blocks[blockIndex];
          if (block.type !== "image") return prev;
          const updatedSlide = replaceBlock(slide, blockIndex, {
            id: block.id,
            type: "image",
            content: dataUrl,
            alt: block.alt ?? "",
          });
          if (updatedSlide === slide) return prev;
          const next = [...prev];
          next[slideIndex] = updatedSlide;
          debouncedSave(next);
          return next;
        });
      } catch (err) {
        // Surface the failure in the dev console; the block stays in
        // its previous (probably empty) state so the user can retry.
        // Only log if this is still the latest upload for the block
        // — a stale rejection is just noise.
        if (uploadTokensRef.current.get(tokenKey) === nextToken) {
          console.warn("Failed to read image file:", err);
        }
      }
    },
    [debouncedSave],
  );

  const activeSlide = slides[activeIndex];
  // Per-slide word-count cache, sized to the deck.
  //
  // Phase 19 PR 11 perf: the toolbar reads `<active> / <total>` on every
  // render. A single keystroke on a 50-slide deck used to walk every
  // slide twice — once inline for `activeWordCount`, once via the
  // `useMemo` on `deckWordCount(slides)` — because the immutable
  // update yields a new `slides` reference even when only the active
  // slide actually changed.
  //
  // `wordCountCacheRef` survives the component lifetime in a `WeakMap`
  // (no manual cleanup; abandoned Slide objects garbage-collect
  // normally because the cache only weakly references them). Every
  // slide whose object identity didn't change between renders hits the
  // cache in O(1), so a one-slide edit costs `O(W_active_slide)`
  // instead of `O(N * W)`.
  //
  // The cache pattern mirrors `BaseEditor`'s `resolveLinkedRecords`
  // map (PR #84) and the `SheetEditor` incremental-recalc cache
  // (PR #83) — the third Phase 19 perf win, this time for the slide
  // surface.
  const wordCountCacheRef = useRef<WeakMap<Slide, number>>(new WeakMap());
  const wordCounts = useMemo(
    () => computeDeckWordCounts(slides, wordCountCacheRef.current),
    [slides],
  );
  const activeWordCount = wordCounts.perSlide[activeIndex] ?? 0;
  const totalWordCount = wordCounts.total;

  return (
    <div className="slide-editor">
      <div className="slide-editor-sidebar">
        <div className="slide-thumbnails">
          {slides.map((slide, i) => (
            <div
              // Stable key driven off `slide.id` (not `i`). Indices
              // would force React to destroy + remount the entire row
              // tree on every reorder, defeating the no-op-stable
              // contract of `moveSlide` and tearing down the layout
              // menu / aria-live state inside it.
              key={slide.id}
              className={`slide-thumb-row ${
                draggedSlideId === slide.id ? "is-dragging" : ""
              }`}
              draggable
              onDragStart={(event) => {
                setDraggedSlideId(slide.id);
                // Setting dataTransfer keeps the drag-image alive in
                // Chromium-based renderers — without `setData` the
                // browser cancels the drag immediately.
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", slide.id);
              }}
              onDragOver={(event) => {
                // Default browser behaviour is "this drop target
                // doesn't accept anything"; we must preventDefault to
                // declare the row as a valid drop target so the
                // browser fires `onDrop` instead of swallowing the
                // release.
                if (draggedSlideId && draggedSlideId !== slide.id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                if (!draggedSlideId || draggedSlideId === slide.id) {
                  // No active drag, or self-drop — nothing to do.
                  // The `onDragEnd` handler still fires and clears
                  // `draggedSlideId`, so leave it alone here.
                  return;
                }
                event.preventDefault();
                const fromIdx = slides.findIndex(
                  (s) => s.id === draggedSlideId,
                );
                // `setDraggedSlideId(null)` runs on every termination
                // path (success AND lookup-miss) so the `is-dragging`
                // visual cue can't stick if a concurrent edit shifts
                // the source out of the array before drop fires. The
                // `onDragEnd` handler is a defence in depth, but
                // dragend doesn't always fire reliably in Chromium's
                // touch-emulation path — clearing here guarantees the
                // class is removed at the exact moment the user
                // released the pointer.
                if (fromIdx < 0) {
                  setDraggedSlideId(null);
                  return;
                }
                moveSlide(fromIdx, i);
                setDraggedSlideId(null);
              }}
              onDragEnd={() => setDraggedSlideId(null)}
            >
              {/*
                * `draggable={false}` on every interactive child of the
                * `draggable` row mirrors the defensive pattern in
                * `SlideBlockRow` (textarea / input). Native HTML5 drag
                * inheritance means a `draggable` parent would otherwise
                * make these buttons drag-able too. In Chromium-on-
                * desktop the browser disambiguates click vs. drag on
                * `<button>` correctly, but accessibility tools that
                * simulate mouse events (and touch-emulation in Chrome
                * DevTools) can interpret a tap-with-millimetre-jitter
                * as a drag-start. Opting these children out forces the
                * row-level drag to only fire from non-button regions
                * (the empty padding / numbered chip), which is the
                * intended interaction.
                */}
              <button
                ref={setThumbRef(slide.id)}
                type="button"
                className={`slide-thumb ${i === activeIndex ? "active" : ""}`}
                draggable={false}
                // `aria-current="true"` is the WAI-ARIA standard for a
                // "the currently selected item in a non-page set"
                // signal. Pairs with the visual `active` class so
                // assistive tech announces the active slide alongside
                // sighted users' visual highlight.
                aria-current={i === activeIndex ? "true" : undefined}
                onClick={() => setActiveIndex(i)}
                onKeyDown={(event) => handleThumbKeyDown(event, i)}
              >
                <span className="slide-thumb-number">{i + 1}</span>
                <span className="slide-thumb-title">{slide.title || "Untitled"}</span>
              </button>
              <div className="slide-thumb-actions">
                <button
                  type="button"
                  className="btn-xs"
                  draggable={false}
                  onClick={() => duplicateSlide(i)}
                  aria-label={`Duplicate slide ${i + 1}`}
                  title="Duplicate slide"
                >
                  ⎘
                </button>
                <button
                  type="button"
                  className="btn-xs danger"
                  draggable={false}
                  onClick={() => removeSlide(i)}
                  disabled={slides.length <= 1}
                  aria-label={`Delete slide ${i + 1}`}
                  title="Delete slide"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="slide-sidebar-actions">
          <button
            ref={layoutButtonRef}
            type="button"
            className="btn-sm"
            onClick={() => setLayoutMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={layoutMenuOpen}
          >
            + Add Slide
          </button>
          {layoutMenuOpen && (
            <div ref={layoutMenuRef} className="slide-layout-menu" role="menu">
              {LAYOUT_ORDER.map((layout) => (
                <button
                  key={layout}
                  type="button"
                  role="menuitem"
                  className="slide-layout-menu-item"
                  onClick={() => addSlide(layout)}
                >
                  {LAYOUT_LABELS[layout]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="slide-editor-main">
        <div className="slide-editor-toolbar">
          {/*
           * Phase 19 PR 11: the toolbar has TWO distinct pairs of
           * arrow buttons that used to be conflated:
           *
           *   1. Navigation (Prev / Next) — change which slide is
           *      active without touching deck order. Mirror of
           *      `Ctrl+PageUp` / `Ctrl+PageDown` (global) and the
           *      sidebar's `Arrow ↑` / `Arrow ↓` handler.
           *
           *   2. Reorder (Move ↑ / Move ↓) — shift the active slide
           *      one position earlier / later in the deck. Mirror of
           *      drag-and-drop reorder introduced in PR 82.
           *
           * Before this PR the toolbar had only the reorder pair but
           * labelled them "Prev / Next", which collides with the
           * standard slide-deck navigation convention (Impress /
           * Slides / Keynote all use Prev / Next to mean "navigate").
           * Both pairs now ship side-by-side with unambiguous labels
           * and aria-labels.
           */}
          <button
            type="button"
            className="btn-sm"
            onClick={() => navigateBy(-1)}
            disabled={activeIndex === 0}
            aria-label="Previous slide"
            title="Previous slide (Ctrl+PageUp)"
          >
            ← Prev
          </button>
          <span>
            Slide {activeIndex + 1} / {slides.length}
          </span>
          <button
            type="button"
            className="btn-sm"
            onClick={() => navigateBy(1)}
            disabled={activeIndex === slides.length - 1}
            aria-label="Next slide"
            title="Next slide (Ctrl+PageDown)"
          >
            Next →
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex - 1)}
            disabled={activeIndex === 0}
            aria-label="Move slide up"
            title="Move this slide one position earlier"
          >
            ↑ Move
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex + 1)}
            disabled={activeIndex === slides.length - 1}
            aria-label="Move slide down"
            title="Move this slide one position later"
          >
            ↓ Move
          </button>
          <span
            className="slide-word-count"
            title="Words on this slide / total in deck"
          >
            Words: {activeWordCount} / {totalWordCount}
          </span>
          <button
            type="button"
            className="btn-sm danger"
            onClick={() => removeSlide(activeIndex)}
            disabled={slides.length <= 1}
          >
            Delete
          </button>
          <button
            type="button"
            className={`btn-sm ${showNotes ? "active" : ""}`}
            onClick={() => setShowNotes(!showNotes)}
          >
            Notes
          </button>
          <button
            type="button"
            className={`btn-sm ${findPanelOpen ? "active" : ""}`}
            onClick={() => setFindPanelOpen((open) => !open)}
            aria-label="Find in slides"
            title="Find in slides (Cmd/Ctrl+F)"
          >
            Find
          </button>
          <button
            type="button"
            className={`btn-sm ${marpMode ? "active" : ""}`}
            onClick={() => {
              setMarpMode((prev) => {
                const next = !prev;
                debouncedSave(slides, {
                  enabled: next,
                  source: marpSource,
                  theme: marpTheme,
                });
                return next;
              });
            }}
            title="Toggle Marp Mode (raw Marp Markdown with live HTML preview)"
          >
            Marp Mode
          </button>
        </div>

        {findPanelOpen && (
          <div className="slide-find-panel" role="search">
            <input
              type="text"
              className="slide-find-input"
              value={findQuery}
              onChange={(e) => {
                setFindQuery(e.target.value);
                // Reset to the first match when the query changes so
                // the user lands on the first hit rather than at a
                // stale index that may now overshoot the new match
                // count (the clamp would correct it, but starting from
                // 0 matches typical find-bar UX).
                setFindActiveIndex(0);
              }}
              placeholder="Find in slides..."
              aria-label="Find query"
              autoFocus
            />
            <label className="slide-find-toggle">
              <input
                type="checkbox"
                checked={findCaseSensitive}
                onChange={(e) => setFindCaseSensitive(e.target.checked)}
              />
              Case
            </label>
            <span className="slide-find-status">
              {findMatches.length === 0
                ? findQuery
                  ? "No matches"
                  : "Type to search"
                : `${effectiveFindIndex + 1} of ${findMatches.length}`}
            </span>
            <button
              type="button"
              className="btn-sm"
              onClick={() => navigateFind("previous")}
              disabled={findMatches.length === 0}
              aria-label="Previous match"
            >
              ‹
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => navigateFind("next")}
              disabled={findMatches.length === 0}
              aria-label="Next match"
            >
              ›
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                setFindPanelOpen(false);
                setFindQuery("");
              }}
              aria-label="Close find panel"
            >
              ×
            </button>
          </div>
        )}

        {marpMode && (
          <div className="marp-mode">
            <div className="marp-mode-toolbar">
              <label className="marp-mode-label">
                Theme
                <select
                  value={marpTheme ?? "default"}
                  onChange={(e) => {
                    const newTheme = e.target.value;
                    setMarpTheme(newTheme);
                    // Also rewrite the frontmatter in the raw source so the
                    // dropdown and source never desynchronize.
                    const updatedSource = setFrontmatterTheme(marpSource, newTheme);
                    setMarpSource(updatedSource);
                    debouncedSave(slides, {
                      enabled: marpMode,
                      source: updatedSource,
                      theme: newTheme,
                    });
                  }}
                >
                  <option value="default">default</option>
                  <option value="gaia">gaia</option>
                  <option value="uncover">uncover</option>
                </select>
              </label>
              <span className="marp-mode-hint">
                Use <code>---</code> to separate slides; <code>&lt;!-- notes --&gt;</code> for speaker notes.
              </span>
            </div>
            <div className="marp-mode-split">
              <textarea
                className="marp-mode-source"
                value={marpSource}
                onChange={(e) => {
                  const newSource = e.target.value;
                  setMarpSource(newSource);
                  // Sync theme from frontmatter → dropdown if the user
                  // manually edited the `theme:` directive.
                  const fmTheme = extractFrontmatterTheme(newSource);
                  const effectiveTheme = fmTheme ?? marpTheme;
                  if (fmTheme && fmTheme !== marpTheme) {
                    setMarpTheme(fmTheme);
                  }
                  debouncedSave(slides, {
                    enabled: marpMode,
                    source: newSource,
                    theme: effectiveTheme,
                  });
                }}
                placeholder="---&#10;marp: true&#10;theme: default&#10;---&#10;&#10;# Slide 1"
                rows={20}
                spellCheck={false}
              />
              <MarpPreview markdown={marpSource} theme={marpTheme ?? "default"} />
            </div>
          </div>
        )}

        {!marpMode && activeSlide && (
          <div className="slide-canvas">
            <input
              className="slide-title-input"
              value={activeSlide.title}
              onChange={(e) => updateSlide(activeIndex, { title: e.target.value })}
              placeholder="Slide Title"
            />
            <div className="slide-blocks">
              {activeSlide.blocks.map((block, bi) => (
                <SlideBlockRow
                  // Stable key driven off `block.id` (not `bi`) so a
                  // drag-reorder preserves component identity — the
                  // `<textarea>` keeps its cursor / selection state
                  // across the reorder, instead of being unmounted
                  // and re-created with a fresh DOM node.
                  key={block.id}
                  block={block}
                  blockIndex={bi}
                  totalBlocks={activeSlide.blocks.length}
                  onTypeChange={(nextType) => {
                    onBlockReplace(
                      activeIndex,
                      bi,
                      nextBlockForTypeChange(block, nextType),
                    );
                  }}
                  onContentChange={(nextContent) => {
                    onBlockReplace(activeIndex, bi, {
                      ...block,
                      content: nextContent,
                    });
                  }}
                  onAltChange={(nextAlt) => {
                    onBlockReplace(activeIndex, bi, {
                      ...block,
                      alt: nextAlt,
                    });
                  }}
                  onImageFile={(file) => {
                    // Pass `activeSlide.id` and `block.id` (not
                    // `activeIndex` / `bi`) so that an in-flight upload
                    // still lands on the right block after a drag-
                    // reorder shifts positions at either the slide or
                    // block level.
                    onImageUpload(activeSlide.id, block.id, file);
                  }}
                  onMoveUp={() => onBlockMove(activeIndex, bi, bi - 1)}
                  onMoveDown={() => onBlockMove(activeIndex, bi, bi + 1)}
                  onRemove={() => onBlockRemove(activeIndex, bi)}
                  draggedBlockId={draggedBlockId}
                  onDragStartBlock={setDraggedBlockId}
                  onDragEndBlock={() => setDraggedBlockId(null)}
                  onDropBlock={(targetIdx) => {
                    if (!draggedBlockId) return;
                    const fromIdx = activeSlide.blocks.findIndex(
                      (b) => b.id === draggedBlockId,
                    );
                    // Clear on every termination path (success AND
                    // lookup-miss) so the `is-dragging` class can't
                    // stick if the source block is removed mid-drag
                    // (e.g. the active slide changes via find-panel
                    // jump or version restore between dragstart and
                    // drop). `onDragEnd` is a defence in depth but
                    // doesn't always fire reliably in Chromium's
                    // touch-emulation path.
                    if (fromIdx < 0) {
                      setDraggedBlockId(null);
                      return;
                    }
                    onBlockMove(activeIndex, fromIdx, targetIdx);
                    setDraggedBlockId(null);
                  }}
                />
              ))}
              <button
                type="button"
                className="btn-sm"
                onClick={() =>
                  onBlockAppend(
                    activeIndex,
                    buildBlock({ type: "text", content: "" }),
                  )
                }
              >
                + Add Block
              </button>
            </div>

            {showNotes && (
              <SpeakerNotesField
                notes={activeSlide.notes}
                onChange={(notes) => updateSlide(activeIndex, { notes })}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

interface SlideBlockRowProps {
  block: SlideBlock;
  blockIndex: number;
  totalBlocks: number;
  onTypeChange: (next: SlideBlockType) => void;
  onContentChange: (next: string) => void;
  onAltChange: (next: string) => void;
  onImageFile: (file: File) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  /**
   * Drag-and-drop coordination — the parent owns the "currently
   * dragged block id" so multiple SlideBlockRow siblings can
   * coordinate without each maintaining its own copy of the
   * cross-row drag state.
   */
  draggedBlockId: string | null;
  onDragStartBlock: (id: string) => void;
  onDragEndBlock: () => void;
  onDropBlock: (targetIndex: number) => void;
}

/**
 * Per-block editor row. Pulled out into a separate component so the
 * per-block hooks (`useId` for the alt-text label) don't have to live
 * inside the `.map(...)` body — calling hooks inside a `.map` callback
 * works in practice but is fragile (the React docs warn against it
 * because reordering the map breaks the hook call order). Owning a
 * component per block lets us also memoise file-input id generation
 * cheaply.
 */
function SlideBlockRow({
  block,
  blockIndex,
  totalBlocks,
  onTypeChange,
  onContentChange,
  onAltChange,
  onImageFile,
  onMoveUp,
  onMoveDown,
  onRemove,
  draggedBlockId,
  onDragStartBlock,
  onDragEndBlock,
  onDropBlock,
}: SlideBlockRowProps) {
  const altId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImageFile(file);
    // Reset the input so picking the same file twice still fires
    // `onChange` — browsers suppress the change event when the
    // selection matches the previous one.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const isDragging = draggedBlockId === block.id;
  const isDropTargetCandidate =
    draggedBlockId !== null && draggedBlockId !== block.id;

  return (
    <div
      className={`slide-block ${isDragging ? "is-dragging" : ""}`}
      // Block-level drag-and-drop. We attach to the outer wrapper so
      // the whole block "card" is the drag handle / drop target, not
      // just one button inside it. The `<textarea>` and `<input>`
      // children still let the user click into them normally because
      // the browser only initiates a drag when the user grabs a
      // non-text-input region (the toolbar / preview gutter).
      draggable
      onDragStart={(event) => {
        onDragStartBlock(block.id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", block.id);
      }}
      onDragOver={(event) => {
        if (isDropTargetCandidate) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        if (!isDropTargetCandidate) return;
        event.preventDefault();
        onDropBlock(blockIndex);
      }}
      onDragEnd={onDragEndBlock}
    >
      <div className="slide-block-toolbar">
        {/*
         * `draggable={false}` on every interactive child of the
         * toolbar so the parent `.slide-block` wrapper's `draggable`
         * can't be triggered by accessibility tools, touch-emulation,
         * or millimetre-jitter taps that the browser would otherwise
         * interpret as a drag-start. Mirrors the existing defensive
         * pattern on the textarea / file-input / alt-text input
         * further down in this component, and the slide-thumbnail-row
         * buttons in the parent component (Devin Review PR #82
         * ANALYSIS-0002 — extends round 6's slide-row fix to the
         * block-row toolbar that was missed in that pass).
         */}
        <select
          value={block.type}
          onChange={(e) => onTypeChange(e.target.value as SlideBlockType)}
          aria-label={`Block ${blockIndex + 1} type`}
          draggable={false}
        >
          <option value="text">Text</option>
          <option value="bullets">Bullets</option>
          <option value="diagram">Diagram</option>
          <option value="image">Image</option>
        </select>
        <button
          type="button"
          className="btn-xs"
          onClick={onMoveUp}
          disabled={blockIndex === 0}
          aria-label={`Move block ${blockIndex + 1} up`}
          title="Move block up"
          draggable={false}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={onMoveDown}
          disabled={blockIndex === totalBlocks - 1}
          aria-label={`Move block ${blockIndex + 1} down`}
          title="Move block down"
          draggable={false}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn-xs danger"
          onClick={onRemove}
          aria-label={`Remove block ${blockIndex + 1}`}
          title="Remove block"
          draggable={false}
        >
          ×
        </button>
      </div>

      {block.type === "image" ? (
        <div className="slide-block-image">
          <input
            type="file"
            ref={fileInputRef}
            accept="image/*"
            onChange={handleFileChange}
            // Defensive: the parent `.slide-block` wrapper has
            // `draggable`, and some Chromium versions can initiate
            // the parent's drag if the user grabs the file-input's
            // border/padding instead of the button face. Setting
            // `draggable={false}` on the input prevents that escape.
            draggable={false}
          />
          {block.content && (
            <img
              src={block.content}
              alt={block.alt ?? ""}
              className="slide-block-image-preview"
            />
          )}
          <label htmlFor={altId} className="slide-block-alt-label">
            Alt text
          </label>
          <input
            id={altId}
            type="text"
            className="slide-block-alt-input"
            value={block.alt ?? ""}
            onChange={(e) => onAltChange(e.target.value)}
            placeholder="Describe the image for screen readers..."
            // See note on file input above — keep drag-grab confined
            // to the toolbar / preview gutter, not the alt-text
            // entry, so reorder can't be triggered by mis-clicks
            // while typing alt text.
            draggable={false}
          />
        </div>
      ) : (
        <>
          <textarea
            className="slide-block-content"
            value={block.content}
            onChange={(e) => onContentChange(e.target.value)}
            // Defensive: prevent the parent `.slide-block` wrapper's
            // `draggable` from intercepting drag-starts that begin
            // in the textarea's padding/border area. The browser
            // normally allows text-selection inside `<textarea>` to
            // win over a parent's drag, but Chromium edge cases can
            // initiate the parent drag when the grab point misses
            // the text-content layer (e.g. a click in the scrollbar
            // gutter on a wrap-wrapped line).
            draggable={false}
            placeholder={
              block.type === "bullets"
                ? "One bullet point per line..."
                : block.type === "diagram"
                  ? "Mermaid diagram DSL..."
                  : "Enter text content..."
            }
            rows={block.type === "diagram" ? 8 : 4}
            spellCheck={block.type !== "diagram"}
          />
          {block.type === "diagram" && <MermaidPreview dsl={block.content} />}
        </>
      )}
    </div>
  );
}

function MermaidPreview({ dsl }: { dsl: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);
  useEffect(() => {
    const handle = setTimeout(() => {
      const token = ++tokenRef.current;
      renderMermaid(dsl)
        .then((result) => {
          if (token !== tokenRef.current) return;
          setSvg(result.svg);
          setError(null);
        })
        .catch((err) => {
          if (token !== tokenRef.current) return;
          if (err instanceof MermaidEnvironmentError) {
            setError("Preview unavailable in this context");
          } else if (err instanceof MermaidRenderError) {
            setError(err.message);
          } else {
            setError(String(err));
          }
          setSvg("");
        });
    }, 250);
    return () => clearTimeout(handle);
  }, [dsl]);
  if (error) {
    return (
      <div className="slide-diagram-error" role="alert">
        {error}
      </div>
    );
  }
  if (!svg) return <div className="slide-diagram-placeholder">Rendering…</div>;
  return (
    <div
      className="slide-diagram-preview"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function MarpPreview({ markdown, theme }: { markdown: string; theme: string }) {
  const [html, setHtml] = useState("");
  const [css, setCss] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Debounce Marp rendering. Marp.render() can be expensive for large decks
  // and the textarea fires on every keystroke; without a debounce, typing
  // lag becomes noticeable in long presentations.
  useEffect(() => {
    const handle = setTimeout(() => {
      const token = ++tokenRef.current;
      try {
        const result = renderMarp(markdown, { theme });
        if (token !== tokenRef.current) return;
        setHtml(result.html);
        setCss(result.css);
        setError(null);
      } catch (err) {
        if (token !== tokenRef.current) return;
        if (err instanceof MarpRenderError) {
          setError(err.message);
        } else {
          setError(String(err));
        }
        setHtml("");
        setCss("");
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [markdown, theme]);

  // Render the deck inside a Shadow DOM so the Marp-emitted CSS (which can
  // include global selectors like `:root` / `body` / `*`) cannot bleed out
  // into the surrounding Tessera UI.
  //
  // The shadow-DOM mutation is delegated to `applyMarpToShadow`, which uses
  // Constructable Stylesheets (`adoptedStyleSheets`) where supported and a
  // `</style`-sanitising `<style>` fallback otherwise. Either way the
  // `</style>` breakout vector is closed — see `applyMarpToShadow` for the
  // full rationale.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    applyMarpToShadow(shadow, html, css);
  }, [html, css]);

  if (error) {
    return (
      <div className="marp-preview-error" role="alert">
        {error}
      </div>
    );
  }
  return <div ref={hostRef} className="marp-preview" />;
}
