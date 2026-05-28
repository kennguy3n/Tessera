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
import GenerateImageButton, {
  type GenerateImageResult,
} from "../components/GenerateImageButton";
import { Plus, Trash2, ArrowUp, ArrowDown, X } from "lucide-react";
import {
  buildPreviewHtml,
  DEFAULT_INFOGRAPHIC_ACCENT as DEFAULT_ACCENT,
  DEFAULT_INFOGRAPHIC_PRIMARY as DEFAULT_PRIMARY,
  DEFAULT_INFOGRAPHIC_SECONDARY as DEFAULT_SECONDARY,
  parseInfographicContent,
} from "./infographicEditorHelpers";
import type {
  InfographicContent,
  InfographicLayout,
  InfographicSection,
} from "./infographicEditorTypes";

export type {
  InfographicLayout,
  InfographicSection,
  InfographicColorScheme,
  InfographicHeroImage,
  InfographicContent,
} from "./infographicEditorTypes";

interface InfographicEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
  /**
   * The owning artifact's id — threaded into the imagegen IPC so
   * generated hero images land in
   * `<userData>/generated-images/<artifactId>/`. Optional because
   * existing tests that drive the editor directly (without going
   * through `ArtifactEditorPage`) shouldn't have to construct a
   * fake id; the hero-image UI is hidden when no id is supplied.
   */
  artifactId?: string;
}

function iconSpecFromPick(v: IconPickerValue): string {
  return `${v.set}:${v.name}`;
}

export default function InfographicEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
  artifactId,
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

  const onHeroImageGenerated = useCallback(
    (result: GenerateImageResult) => {
      // Persist exactly the fields we need to re-render later — we
      // deliberately do NOT store the absolute on-disk `path` in
      // the artifact JSON because the path is main-process state
      // (it includes the user's home directory) and would break
      // across machines on artifact sync.
      setData((prev) => {
        const next: InfographicContent = {
          ...prev,
          heroImage: {
            assetUrl: result.assetUrl,
            prompt: result.prompt,
            seed: result.seed,
            width: result.width,
            height: result.height,
          },
        };
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const clearHeroImage = useCallback(() => {
    setData((prev) => {
      const next: InfographicContent = { ...prev, heroImage: undefined };
      debouncedSave(next);
      return next;
    });
  }, [debouncedSave]);

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
        {artifactId && (
          <div className="infographic-hero-image">
            <h3>Hero image</h3>
            {data.heroImage ? (
              <div
                className="infographic-hero-image-preview"
                data-testid="infographic-hero-image-preview"
              >
                <img
                  src={data.heroImage.assetUrl}
                  alt={`Hero image for ${data.title}`}
                  width={data.heroImage.width}
                  height={data.heroImage.height}
                />
                <button
                  type="button"
                  onClick={clearHeroImage}
                  aria-label="Remove hero image"
                >
                  <Trash2 size={16} /> Remove
                </button>
              </div>
            ) : (
              <GenerateImageButton
                artifactId={artifactId}
                initialPrompt={
                  data.subtitle
                    ? `Hero image for an infographic titled "${data.title}" — ${data.subtitle}`
                    : `Hero image for an infographic titled "${data.title}"`
                }
                onGenerated={onHeroImageGenerated}
              />
            )}
          </div>
        )}
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
