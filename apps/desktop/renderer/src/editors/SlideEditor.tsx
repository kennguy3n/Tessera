import { useState, useCallback, useRef, useEffect, useId } from "react";
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
  type ParsedSlideContent,
} from "./slideEditorHelpers";
import type {
  MarpModeState,
  Slide,
  SlideBlockType,
  SlideContent,
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

  const addSlide = useCallback(() => {
    setSlides((prev) => {
      const updated = [
        ...prev,
        { title: "New Slide", blocks: [{ type: "text" as const, content: "" }], notes: "" },
      ];
      setActiveIndex(updated.length - 1);
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeSlide = useCallback(
    (index: number) => {
      setSlides((prev) => {
        if (prev.length <= 1) return prev;
        const updated = prev.filter((_, i) => i !== index);
        const newIndex = Math.min(activeIndex, updated.length - 1);
        setActiveIndex(newIndex);
        debouncedSave(updated);
        return updated;
      });
    },
    [activeIndex, debouncedSave],
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

  const activeSlide = slides[activeIndex];

  return (
    <div className="slide-editor">
      <div className="slide-editor-sidebar">
        <div className="slide-thumbnails">
          {slides.map((slide, i) => (
            <button
              key={i}
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
          ))}
        </div>
        <div className="slide-sidebar-actions">
          <button type="button" className="btn-sm" onClick={addSlide}>
            + Add Slide
          </button>
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
                <div key={bi} className="slide-block">
                  <select
                    value={block.type}
                    onChange={(e) => {
                      const newBlocks = [...activeSlide.blocks];
                      const nextType = e.target.value as SlideBlockType;
                      newBlocks[bi] = {
                        ...newBlocks[bi],
                        type: nextType,
                        content:
                          nextType === "diagram" && !newBlocks[bi].content
                            ? DEFAULT_DIAGRAM_DSL
                            : newBlocks[bi].content,
                      };
                      updateSlide(activeIndex, { blocks: newBlocks });
                    }}
                  >
                    <option value="text">Text</option>
                    <option value="bullets">Bullets</option>
                    <option value="diagram">Diagram</option>
                  </select>
                  <textarea
                    className="slide-block-content"
                    value={block.content}
                    onChange={(e) => {
                      const newBlocks = [...activeSlide.blocks];
                      newBlocks[bi] = { ...newBlocks[bi], content: e.target.value };
                      updateSlide(activeIndex, { blocks: newBlocks });
                    }}
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
                  {block.type === "diagram" && (
                    <MermaidPreview dsl={block.content} />
                  )}
                </div>
              ))}
              <button
                type="button"
                className="btn-sm"
                onClick={() => {
                  const newBlocks = [
                    ...activeSlide.blocks,
                    { type: "text" as const, content: "" },
                  ];
                  updateSlide(activeIndex, { blocks: newBlocks });
                }}
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

const DEFAULT_DIAGRAM_DSL = `flowchart LR
  Source --> Process --> Output`;

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

