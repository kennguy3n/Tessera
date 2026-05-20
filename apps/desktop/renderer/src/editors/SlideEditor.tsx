import { useState, useCallback, useRef, useEffect } from "react";
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
import { yamlSingleQuote } from "../utils/yaml";

export type SlideBlockType = "text" | "bullets" | "diagram";

export interface SlideBlock {
  type: SlideBlockType;
  content: string;
}

export interface Slide {
  title: string;
  blocks: SlideBlock[];
  notes: string;
}

export interface MarpModeState {
  enabled: boolean;
  source: string;
  theme?: string;
}

export interface SlideContent {
  slides: Slide[];
  marp?: MarpModeState;
}

interface SlideEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
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
              <div className="slide-notes">
                <label className="slide-notes-label">Speaker Notes</label>
                <textarea
                  className="slide-notes-input"
                  value={activeSlide.notes}
                  onChange={(e) => updateSlide(activeIndex, { notes: e.target.value })}
                  placeholder="Speaker notes for this slide..."
                  rows={3}
                />
              </div>
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

/**
 * Apply Marp-emitted CSS + HTML to a Shadow DOM safely.
 *
 * Exported for unit testing of the CSS injection / `</style>` breakout
 * defence; not part of the editor's public API. See the `useEffect` in
 * `MarpPreview` for the full security rationale.
 */
export function applyMarpToShadow(
  shadow: ShadowRoot,
  html: string,
  css: string,
): void {
  const supportsConstructable =
    typeof CSSStyleSheet !== "undefined" &&
    typeof (CSSStyleSheet.prototype as { replaceSync?: unknown }).replaceSync ===
      "function" &&
    "adoptedStyleSheets" in shadow;

  if (supportsConstructable) {
    const existing = shadow.adoptedStyleSheets ?? [];
    let sheet = existing[0];
    if (!sheet) {
      sheet = new CSSStyleSheet();
      shadow.adoptedStyleSheets = [sheet];
    }
    try {
      sheet.replaceSync(css);
    } catch {
      sheet.replaceSync("");
    }
    shadow.querySelector(":scope > style[data-marp-fallback]")?.remove();
  } else {
    // Sanitise `</style` so the HTML parser cannot close the stylesheet
    // early when the fallback path injects raw CSS via a `<style>` element.
    //
    // We use the canonical CSS hex escape `\3c ` (= `<`) defined in CSS
    // Syntax §4.3.7, instead of the JS-style `\<` backslash escape that we
    // previously emitted. `\<` is silently dropped by the CSS parser so the
    // rule containing the payload becomes malformed; `\3c ` is a valid CSS
    // character escape that preserves the rule meaning while still
    // preventing the HTML tokenizer from recognising `</style`. The trailing
    // space after `\3c` is significant — it terminates the hex-digit run
    // per the CSS Syntax production for IDENT escapes.
    const safeCss = css.replace(/<\/style/gi, "\\3c /style");
    let styleEl = shadow.querySelector<HTMLStyleElement>(
      ":scope > style[data-marp-fallback]",
    );
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-marp-fallback", "");
      shadow.appendChild(styleEl);
    }
    styleEl.textContent = safeCss;
  }

  let deck = shadow.querySelector<HTMLDivElement>(".marp-preview-deck");
  if (!deck) {
    deck = document.createElement("div");
    deck.className = "marp-preview-deck";
    shadow.appendChild(deck);
  }
  deck.innerHTML = html;
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

interface ParsedSlideContent {
  slides: Slide[];
  marpMode: boolean;
  marpSource: string;
  marpTheme: MarpRenderOptions["theme"] | undefined;
}

export function parseSlideContent(content: string): ParsedSlideContent {
  const emptyDefault: ParsedSlideContent = {
    slides: [{ title: "Title Slide", blocks: [{ type: "text", content: "" }], notes: "" }],
    marpMode: false,
    marpSource: "",
    marpTheme: undefined,
  };
  if (!content) return emptyDefault;
  try {
    const parsed = JSON.parse(content) as SlideContent;
    if (parsed.slides && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
      return {
        slides: parsed.slides,
        marpMode: parsed.marp?.enabled ?? false,
        marpSource: parsed.marp?.source ?? "",
        marpTheme: parsed.marp?.theme,
      };
    }
  } catch {
    // Not JSON — treat as single text slide
  }
  return {
    slides: [{ title: "Slide 1", blocks: [{ type: "text", content }], notes: "" }],
    marpMode: false,
    marpSource: "",
    marpTheme: undefined,
  };
}

/**
 * Convert the structured `Slide[]` representation (used by the WYSIWYG slide
 * editor) into a Marp-Markdown string suitable for handing to the Marp CLI.
 *
 * This is the path taken when a user exports a slide artifact to PPTX without
 * having explicitly toggled Marp Mode — we synthesise a minimal Marp document
 * from the structured blocks so the Marp CLI has something to render.
 */
export function slidesToMarpMarkdown(
  slides: Slide[],
  options?: { theme?: string },
): string {
  const theme = options?.theme ?? "default";
  // `theme` originates from user-editable JSON (parsed.marp?.theme). Wrap it
  // in a YAML single-quoted scalar so a value containing a newline cannot
  // inject a second directive into the front-matter block. See
  // `utils/yaml.ts` for the full rationale.
  const header = [
    "---",
    "marp: true",
    `theme: ${yamlSingleQuote(theme)}`,
    "paginate: true",
    "---",
  ];
  const body = slides.map((slide) => renderSlideAsMarp(slide));
  // Marp requires `---` horizontal rules between slides to delimit them.
  // The opening front-matter `---...---` block separates config from the
  // first slide; subsequent slides each need their own leading `---`.
  return [header.join("\n"), body.join("\n\n---\n\n")].join("\n\n");
}

function renderSlideAsMarp(slide: Slide): string {
  const parts: string[] = [];
  if (slide.title) {
    parts.push(`# ${slide.title}`);
  }
  for (const block of slide.blocks) {
    const content = (block.content ?? "").trim();
    if (!content) continue;
    if (block.type === "bullets") {
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => `- ${line.replace(/^[-*]\s*/, "")}`);
      if (lines.length > 0) parts.push(lines.join("\n"));
    } else if (block.type === "diagram") {
      parts.push("```mermaid\n" + content + "\n```");
    } else {
      parts.push(content);
    }
  }
  if (slide.notes && slide.notes.trim().length > 0) {
    parts.push(`<!-- ${escapeHtmlComment(slide.notes.trim())} -->`);
  }
  return parts.join("\n\n");
}

/**
 * Escape a string so it can be embedded inside an HTML comment without the
 * embedded `-->` closing the comment early.
 *
 * Used by `renderSlideAsMarp` when materialising speaker notes for the Marp
 * CLI export pipeline. Without this, a user's notes containing `-->` would
 * prematurely terminate the comment and inject the trailing text into the
 * surrounding Marp Markdown, which then leaks into the rendered slide deck
 * (PPTX/PDF/HTML) as visible content. The standard mitigation (used by
 * mdast-util-to-markdown, remark, etc.) is to insert a space inside the
 * `-->` sequence so the HTML tokenizer no longer recognises a comment-end.
 */
export function escapeHtmlComment(text: string): string {
  // Replace every `-->` with `-- >`. The space breaks the HTML5 comment-end
  // production (`--` followed by `>`) without altering the visible characters
  // beyond a single space inside the comment body — speaker notes are not
  // rendered as text, so the cosmetic change is invisible to the audience.
  return text.replace(/-->/g, "-- >");
}

/**
 * Extract the `theme:` value from the YAML front-matter of a Marp source
 * string. Returns `undefined` if the source has no front-matter or no
 * `theme:` directive. Used by `SlideEditor` to keep the theme dropdown in
 * sync when the user manually edits the raw Marp source.
 *
 * Front-matter detection is anchored at the start of the string and uses a
 * non-greedy capture so trailing `---` separators between slides don't
 * accidentally extend the front-matter region. Quoting is tolerated by
 * trimming + stripping outer quote chars.
 */
export function extractFrontmatterTheme(src: string): string | undefined {
  const fmMatch = src.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const themeMatch = fmMatch[1].match(/^theme:\s*(.+)$/m);
  if (!themeMatch) return undefined;
  let value = themeMatch[1].trim();
  // Strip a single layer of surrounding single or double quotes — YAML
  // allows both `theme: gaia`, `theme: "gaia"`, and `theme: 'gaia'`.
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Return a copy of the given Marp source with its front-matter `theme:`
 * directive set to the given value. If the source has no front-matter,
 * prepend a minimal one (`marp: true` + `theme:`). If front-matter exists
 * but has no `theme:` line, append one at the end of the block.
 *
 * Used by `SlideEditor` so the theme dropdown rewrites the visible source
 * front-matter rather than diverging silently from it.
 */
export function setFrontmatterTheme(src: string, theme: string): string {
  const fmMatch = src.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    const prefix = src.length > 0 ? "\n\n" : "";
    return `---\nmarp: true\ntheme: ${theme}\n---${prefix}${src}`;
  }
  const [whole, open, body, close] = fmMatch;
  const themeRe = /^theme:\s*.+$/m;
  let newBody: string;
  if (themeRe.test(body)) {
    newBody = body.replace(themeRe, `theme: ${theme}`);
  } else {
    newBody = body.trimEnd() + `\ntheme: ${theme}`;
  }
  return src.replace(whole, `${open}${newBody}${close}`);
}
