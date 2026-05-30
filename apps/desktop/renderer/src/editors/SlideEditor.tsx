import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useId,
  useMemo,
  type ChangeEvent,
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
  duplicateSlideAt,
  moveBlock,
  removeBlock as removeBlockHelper,
  appendBlock,
  replaceBlock,
  slideWordCount,
  deckWordCount,
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

  // Sync external content prop changes (e.g., version restore)
  useEffect(() => {
    if (content !== lastSavedRef.current) {
      const parsed = parseSlideContent(content);
      setSlides(parsed.slides);
      setMarpMode(parsed.marpMode);
      setMarpSource(parsed.marpSource);
      setMarpTheme(parsed.marpTheme ?? "default");
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
      if (to < 0 || to >= slides.length) return;
      setSlides((prev) => {
        const updated = [...prev];
        const [moved] = updated.splice(from, 1);
        updated.splice(to, 0, moved);
        setActiveIndex(to);
        debouncedSave(updated);
        return updated;
      });
    },
    [slides.length, debouncedSave],
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

  const onImageUpload = useCallback(
    async (
      slideIndex: number,
      blockIndex: number,
      file: File,
    ) => {
      try {
        const dataUrl = await fileToDataUrl(file);
        setSlides((prev) => {
          const slide = prev[slideIndex];
          if (!slide) return prev;
          const block = slide.blocks[blockIndex];
          if (!block || block.type !== "image") return prev;
          const updatedSlide = replaceBlock(slide, blockIndex, {
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
        console.warn("Failed to read image file:", err);
      }
    },
    [debouncedSave],
  );

  const activeSlide = slides[activeIndex];
  const activeWordCount = activeSlide ? slideWordCount(activeSlide) : 0;
  const totalWordCount = useMemo(() => deckWordCount(slides), [slides]);

  return (
    <div className="slide-editor">
      <div className="slide-editor-sidebar">
        <div className="slide-thumbnails">
          {slides.map((slide, i) => (
            <div key={i} className="slide-thumb-row">
              <button
                type="button"
                className={`slide-thumb ${i === activeIndex ? "active" : ""}`}
                // `aria-current="true"` is the WAI-ARIA standard for a
                // "the currently selected item in a non-page set"
                // signal. Pairs with the visual `active` class so
                // assistive tech announces the active slide alongside
                // sighted users' visual highlight.
                aria-current={i === activeIndex ? "true" : undefined}
                onClick={() => setActiveIndex(i)}
              >
                <span className="slide-thumb-number">{i + 1}</span>
                <span className="slide-thumb-title">{slide.title || "Untitled"}</span>
              </button>
              <div className="slide-thumb-actions">
                <button
                  type="button"
                  className="btn-xs"
                  onClick={() => duplicateSlide(i)}
                  aria-label={`Duplicate slide ${i + 1}`}
                  title="Duplicate slide"
                >
                  ⎘
                </button>
                <button
                  type="button"
                  className="btn-xs danger"
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
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex - 1)}
            disabled={activeIndex === 0}
          >
            Prev
          </button>
          <span>
            Slide {activeIndex + 1} / {slides.length}
          </span>
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex + 1)}
            disabled={activeIndex === slides.length - 1}
          >
            Next
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
                  key={bi}
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
                    onImageUpload(activeIndex, bi, file);
                  }}
                  onMoveUp={() => onBlockMove(activeIndex, bi, bi - 1)}
                  onMoveDown={() => onBlockMove(activeIndex, bi, bi + 1)}
                  onRemove={() => onBlockRemove(activeIndex, bi)}
                />
              ))}
              <button
                type="button"
                className="btn-sm"
                onClick={() =>
                  onBlockAppend(activeIndex, { type: "text", content: "" })
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

  return (
    <div className="slide-block">
      <div className="slide-block-toolbar">
        <select
          value={block.type}
          onChange={(e) => onTypeChange(e.target.value as SlideBlockType)}
          aria-label={`Block ${blockIndex + 1} type`}
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
        >
          ↓
        </button>
        <button
          type="button"
          className="btn-xs danger"
          onClick={onRemove}
          aria-label={`Remove block ${blockIndex + 1}`}
          title="Remove block"
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
          />
        </div>
      ) : (
        <>
          <textarea
            className="slide-block-content"
            value={block.content}
            onChange={(e) => onContentChange(e.target.value)}
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
