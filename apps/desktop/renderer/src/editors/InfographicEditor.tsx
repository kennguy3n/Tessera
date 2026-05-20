/**
 * InfographicEditor — visual editor for the Infographic artifact type.
 *
 * Data model (mirrors the Rust `InfographicSpec` & `generate_infographic` shape):
 *
 *   {
 *     "title": "...",
 *     "subtitle": "...",
 *     "layout": "vertical" | "horizontal" | "grid",
 *     "colorScheme": { "primary": "#7C3AED", "secondary": "...", "accent": "..." },
 *     "defaultIconSet": "lucide" | "phosphor",
 *     "sections": [
 *       { "icon": "lucide:trending-up", "heading": "...", "body": "...", "stat": "92%", "statLabel": "growth" }
 *     ]
 *   }
 *
 * The editor renders the sections vertically with reorder/delete controls,
 * an IconPicker popover per section, optional stat + label, and a live
 * Markdown/HTML preview that uses iconResolver to substitute the icon tokens
 * to inline SVG.
 */
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import IconPicker, { type IconPickerValue } from "../components/IconPicker";
import { embedIcons } from "../services/iconResolver";
import { sanitizeCssColor } from "../utils/cssColor";
import { Plus, Trash2, ArrowUp, ArrowDown, X } from "lucide-react";

export type InfographicLayout = "vertical" | "horizontal" | "grid";

export interface InfographicSection {
  icon?: string; // e.g. "lucide:trending-up"
  heading: string;
  body: string;
  stat?: string;
  statLabel?: string;
}

export interface InfographicColorScheme {
  primary?: string;
  secondary?: string;
  accent?: string;
}

export interface InfographicContent {
  title: string;
  subtitle?: string;
  layout: InfographicLayout;
  colorScheme: InfographicColorScheme;
  defaultIconSet?: "lucide" | "phosphor";
  sections: InfographicSection[];
}

interface InfographicEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
}

const DEFAULT_PRIMARY = "#7C3AED";
const DEFAULT_SECONDARY = "#0EA5E9";
const DEFAULT_ACCENT = "#F59E0B";

export function parseInfographicContent(content: string): InfographicContent {
  const fallback: InfographicContent = {
    title: "Untitled Infographic",
    subtitle: "",
    layout: "vertical",
    colorScheme: {
      primary: DEFAULT_PRIMARY,
      secondary: DEFAULT_SECONDARY,
      accent: DEFAULT_ACCENT,
    },
    defaultIconSet: "lucide",
    sections: [
      { heading: "Section 1", body: "Describe the first idea here.", icon: "lucide:sparkles" },
    ],
  };
  if (!content) return fallback;
  try {
    const parsed = JSON.parse(content) as Partial<InfographicContent>;
    if (parsed && Array.isArray(parsed.sections)) {
      return {
        title: parsed.title ?? fallback.title,
        subtitle: parsed.subtitle ?? "",
        layout: (parsed.layout as InfographicLayout) ?? fallback.layout,
        colorScheme: {
          primary: parsed.colorScheme?.primary ?? DEFAULT_PRIMARY,
          secondary: parsed.colorScheme?.secondary ?? DEFAULT_SECONDARY,
          accent: parsed.colorScheme?.accent ?? DEFAULT_ACCENT,
        },
        defaultIconSet: parsed.defaultIconSet ?? "lucide",
        sections: parsed.sections.length > 0 ? parsed.sections : fallback.sections,
      };
    }
  } catch {
    // Fall back to default
  }
  return fallback;
}

function iconSpecFromPick(v: IconPickerValue): string {
  return `${v.set}:${v.name}`;
}

export default function InfographicEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
}: InfographicEditorProps) {
  const [data, setData] = useState<InfographicContent>(() =>
    parseInfographicContent(content),
  );
  const [pickerOpenFor, setPickerOpenFor] = useState<number | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  const debouncedSave = useCallback(
    (next: InfographicContent) => {
      const json = JSON.stringify(next);
      onDraftChange?.(json);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, onDraftChange, autoSaveMs],
  );

  useEffect(
    () => () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    },
    [],
  );

  useEffect(() => {
    if (content !== lastSavedRef.current) {
      setData(parseInfographicContent(content));
      lastSavedRef.current = content;
    }
  }, [content]);

  const update = (patch: Partial<InfographicContent>) => {
    setData((prev) => {
      const next = { ...prev, ...patch };
      debouncedSave(next);
      return next;
    });
  };

  const updateSection = (i: number, patch: Partial<InfographicSection>) => {
    setData((prev) => {
      const sections = prev.sections.map((s, idx) =>
        idx === i ? { ...s, ...patch } : s,
      );
      const next = { ...prev, sections };
      debouncedSave(next);
      return next;
    });
  };

  const addSection = () => {
    setData((prev) => {
      const sections = [
        ...prev.sections,
        { heading: `Section ${prev.sections.length + 1}`, body: "", icon: "lucide:sparkles" },
      ];
      const next = { ...prev, sections };
      debouncedSave(next);
      return next;
    });
  };

  const removeSection = (i: number) => {
    setData((prev) => {
      if (prev.sections.length <= 1) return prev;
      const sections = prev.sections.filter((_, idx) => idx !== i);
      const next = { ...prev, sections };
      debouncedSave(next);
      return next;
    });
  };

  const moveSection = (from: number, dir: -1 | 1) => {
    setData((prev) => {
      const to = from + dir;
      if (to < 0 || to >= prev.sections.length) return prev;
      const sections = [...prev.sections];
      const [moved] = sections.splice(from, 1);
      sections.splice(to, 0, moved);
      const next = { ...prev, sections };
      debouncedSave(next);
      return next;
    });
  };

  const previewHtml = useMemo(() => buildPreviewHtml(data), [data]);

  return (
    <div className="infographic-editor" data-testid="infographic-editor">
      <div className="infographic-editor-toolbar">
        <input
          aria-label="Infographic title"
          value={data.title}
          onChange={(e) => update({ title: e.target.value })}
          placeholder="Title"
          className="infographic-title-input"
        />
        <input
          aria-label="Infographic subtitle"
          value={data.subtitle ?? ""}
          onChange={(e) => update({ subtitle: e.target.value })}
          placeholder="Subtitle (optional)"
          className="infographic-subtitle-input"
        />
        <div className="infographic-toolbar-row">
          <label>
            Layout:
            <select
              aria-label="Layout"
              value={data.layout}
              onChange={(e) =>
                update({ layout: e.target.value as InfographicLayout })
              }
            >
              <option value="vertical">Vertical</option>
              <option value="horizontal">Horizontal</option>
              <option value="grid">Grid</option>
            </select>
          </label>
          <label>
            Primary:
            <input
              type="color"
              aria-label="Primary color"
              value={data.colorScheme.primary ?? DEFAULT_PRIMARY}
              onChange={(e) =>
                update({
                  colorScheme: { ...data.colorScheme, primary: e.target.value },
                })
              }
            />
          </label>
          <label>
            Secondary:
            <input
              type="color"
              aria-label="Secondary color"
              value={data.colorScheme.secondary ?? DEFAULT_SECONDARY}
              onChange={(e) =>
                update({
                  colorScheme: { ...data.colorScheme, secondary: e.target.value },
                })
              }
            />
          </label>
          <label>
            Accent:
            <input
              type="color"
              aria-label="Accent color"
              value={data.colorScheme.accent ?? DEFAULT_ACCENT}
              onChange={(e) =>
                update({
                  colorScheme: { ...data.colorScheme, accent: e.target.value },
                })
              }
            />
          </label>
        </div>
      </div>

      <div className="infographic-editor-body">
        <div className="infographic-editor-sections">
          {data.sections.map((section, i) => (
            <div className="infographic-section-card" key={i}>
              <div className="infographic-section-row">
                <button
                  type="button"
                  className="infographic-icon-button"
                  onClick={() =>
                    setPickerOpenFor(pickerOpenFor === i ? null : i)
                  }
                  aria-label="Pick icon"
                >
                  {section.icon ?? "icon"}
                </button>
                <input
                  aria-label={`Section ${i + 1} heading`}
                  className="infographic-heading-input"
                  value={section.heading}
                  onChange={(e) =>
                    updateSection(i, { heading: e.target.value })
                  }
                  placeholder="Heading"
                />
                <div className="infographic-section-actions">
                  <button
                    type="button"
                    aria-label="Move up"
                    onClick={() => moveSection(i, -1)}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    onClick={() => moveSection(i, 1)}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Delete section"
                    onClick={() => removeSection(i)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              <textarea
                aria-label={`Section ${i + 1} body`}
                className="infographic-body-input"
                value={section.body}
                onChange={(e) => updateSection(i, { body: e.target.value })}
                placeholder="Body text"
                rows={3}
              />
              <div className="infographic-stat-row">
                <input
                  aria-label="Stat value"
                  placeholder="Stat (e.g. 92%)"
                  value={section.stat ?? ""}
                  onChange={(e) => updateSection(i, { stat: e.target.value })}
                />
                <input
                  aria-label="Stat label"
                  placeholder="Stat label"
                  value={section.statLabel ?? ""}
                  onChange={(e) =>
                    updateSection(i, { statLabel: e.target.value })
                  }
                />
              </div>
              {pickerOpenFor === i && (
                <div className="infographic-icon-picker-popover" role="dialog" aria-label="Icon picker">
                  <button
                    type="button"
                    className="infographic-icon-picker-close"
                    aria-label="Close icon picker"
                    onClick={() => setPickerOpenFor(null)}
                  >
                    <X size={16} />
                  </button>
                  <IconPicker
                    value={parsePickedIcon(section.icon)}
                    onChange={(v) => {
                      updateSection(i, { icon: iconSpecFromPick(v) });
                      setPickerOpenFor(null);
                    }}
                  />
                </div>
              )}
            </div>
          ))}
          <button
            type="button"
            className="infographic-add-section"
            onClick={addSection}
            aria-label="Add section"
          >
            <Plus size={16} /> Add section
          </button>
        </div>

        <div
          className="infographic-preview"
          aria-label="Infographic preview"
          data-testid="infographic-preview"
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      </div>
    </div>
  );
}

function parsePickedIcon(spec: string | undefined): IconPickerValue | null {
  if (!spec) return null;
  const [set, name] = spec.split(":");
  if (set !== "lucide" && set !== "phosphor") return null;
  if (!name) return null;
  return { set, name };
}

/**
 * Build a deterministic HTML preview of the infographic. Icons are
 * inlined as SVG via the embedIcons() resolver so the preview matches
 * what an HTML export would produce.
 */
export function buildPreviewHtml(data: InfographicContent): string {
  // Sanitise color values before interpolating them into the inline CSS
  // custom-property declaration below. The native color picker always emits
  // `#rrggbb`, but the underlying JSON is user-editable and could carry a
  // value that escapes the CSS-property slot (e.g. injects `; background:
  // url(...)`).  HTML-escaping is not enough inside a `style="..."`
  // attribute — `;` and `:` are HTML-safe but CSS-unsafe — so we run a
  // CSS-grammar check and fall back to the default on anything suspicious.
  const primary = sanitizeCssColor(
    data.colorScheme.primary,
    DEFAULT_PRIMARY,
  );
  const secondary = sanitizeCssColor(
    data.colorScheme.secondary,
    DEFAULT_SECONDARY,
  );
  const accent = sanitizeCssColor(data.colorScheme.accent, DEFAULT_ACCENT);
  const layoutClass = `infographic-preview-${data.layout}`;
  const sectionsHtml = data.sections
    .map((s) => {
      const iconToken = s.icon
        ? `{{icon:${s.icon} size=32 color=${primary}}}`
        : "";
      const statBlock = s.stat
        ? `<div class="infographic-stat"><span class="infographic-stat-value">${escapeHtml(s.stat)}</span><span class="infographic-stat-label">${escapeHtml(s.statLabel ?? "")}</span></div>`
        : "";
      return `<section class="infographic-section">
  <div class="infographic-section-icon">${iconToken}</div>
  <h3>${escapeHtml(s.heading)}</h3>
  ${statBlock}
  <p>${escapeHtml(s.body)}</p>
</section>`;
    })
    .join("\n");

  const html = `<div class="infographic ${layoutClass}" style="--igc-primary:${primary};--igc-secondary:${secondary};--igc-accent:${accent};">
  <header class="infographic-header">
    <h1>${escapeHtml(data.title)}</h1>
    ${data.subtitle ? `<p class="infographic-subtitle">${escapeHtml(data.subtitle)}</p>` : ""}
  </header>
  <div class="infographic-grid">
    ${sectionsHtml}
  </div>
</div>`;
  return embedIcons(html);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
