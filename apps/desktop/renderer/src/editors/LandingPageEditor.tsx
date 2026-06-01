/**
 * LandingPageEditor — section-based editor for the LandingPage artifact type.
 *
 * Data model (mirrors `LandingPageSpec` in the Rust generator):
 *
 *   {
 *     "title": "...",
 *     "hero": { "headline": "...", "subheadline": "...", "cta": "...", "ctaUrl": "..." },
 *     "features": [ { "icon": "lucide:zap", "title": "...", "description": "..." } ],
 *     "stats": [ { "value": "10x", "label": "faster" } ],
 *     "testimonials": [ { "quote": "...", "name": "Jane Doe", "company": "Acme" } ],
 *     "cta": { "headline": "Ready?", "buttonText": "Get started", "buttonUrl": "https://..." },
 *     "colorScheme": { "primary": "#7C3AED", "secondary": "...", "accent": "..." }
 *   }
 */
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import IconPicker, { type IconPickerValue } from "../components/IconPicker";
import GenerateImageButton, {
  type GenerateImageResult,
} from "../components/GenerateImageButton";
import { Plus, Trash2, X } from "lucide-react";
import {
  buildLandingPreviewHtml,
  parseLandingPageContent,
} from "./landingPageEditorHelpers";
import type {
  LandingPageContent,
  LandingPageCta,
  LandingPageFeature,
  LandingPageHero,
  LandingPageStat,
  LandingPageTestimonial,
} from "./landingPageEditorTypes";

export type {
  LandingPageHeroImage,
  LandingPageHero,
  LandingPageFeature,
  LandingPageStat,
  LandingPageTestimonial,
  LandingPageCta,
  LandingPageContent,
} from "./landingPageEditorTypes";

interface LandingPageEditorProps {
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



export default function LandingPageEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
  artifactId,
}: LandingPageEditorProps) {
  const [data, setData] = useState<LandingPageContent>(() =>
    parseLandingPageContent(content),
  );
  const [pickerOpenFor, setPickerOpenFor] = useState<number | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  const debouncedSave = useCallback(
    (next: LandingPageContent) => {
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
      setData(parseLandingPageContent(content));
      lastSavedRef.current = content;
    }
  }, [content]);

  const mutate = (next: LandingPageContent) => {
    setData(next);
    debouncedSave(next);
  };

  const updateHero = (patch: Partial<LandingPageHero>) =>
    mutate({ ...data, hero: { ...data.hero, ...patch } });

  const updateFeature = (i: number, patch: Partial<LandingPageFeature>) =>
    mutate({
      ...data,
      features: data.features.map((f, idx) =>
        idx === i ? { ...f, ...patch } : f,
      ),
    });

  const addFeature = () =>
    mutate({
      ...data,
      features: [
        ...data.features,
        { title: "New feature", description: "", icon: "lucide:sparkles" },
      ],
    });

  const removeFeature = (i: number) =>
    mutate({
      ...data,
      features: data.features.filter((_, idx) => idx !== i),
    });

  const updateStat = (i: number, patch: Partial<LandingPageStat>) =>
    mutate({
      ...data,
      stats: data.stats.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    });

  const addStat = () =>
    mutate({
      ...data,
      stats: [...data.stats, { value: "0", label: "" }],
    });

  const removeStat = (i: number) =>
    mutate({ ...data, stats: data.stats.filter((_, idx) => idx !== i) });

  const updateTestimonial = (
    i: number,
    patch: Partial<LandingPageTestimonial>,
  ) =>
    mutate({
      ...data,
      testimonials: data.testimonials.map((t, idx) =>
        idx === i ? { ...t, ...patch } : t,
      ),
    });

  const addTestimonial = () =>
    mutate({
      ...data,
      testimonials: [
        ...data.testimonials,
        { quote: "", name: "", company: "" },
      ],
    });

  const removeTestimonial = (i: number) =>
    mutate({
      ...data,
      testimonials: data.testimonials.filter((_, idx) => idx !== i),
    });

  const updateCta = (patch: Partial<LandingPageCta>) =>
    mutate({
      ...data,
      cta: { ...(data.cta ?? { headline: "", buttonText: "" }), ...patch },
    });

  const onHeroImageGenerated = useCallback(
    (result: GenerateImageResult) => {
      setData((prev) => {
        const next: LandingPageContent = {
          ...prev,
          hero: {
            ...prev.hero,
            image: {
              assetUrl: result.assetUrl,
              prompt: result.prompt,
              seed: result.seed,
              width: result.width,
              height: result.height,
            },
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
      const next: LandingPageContent = {
        ...prev,
        hero: { ...prev.hero, image: undefined },
      };
      debouncedSave(next);
      return next;
    });
  }, [debouncedSave]);

  const previewHtml = useMemo(() => buildLandingPreviewHtml(data), [data]);

  return (
    <div className="landing-editor" data-testid="landing-editor">
      <div className="landing-editor-panel">
        <h2>Hero</h2>
        <input
          aria-label="Hero headline"
          value={data.hero.headline}
          onChange={(e) => updateHero({ headline: e.target.value })}
          placeholder="Headline"
        />
        <input
          aria-label="Hero subheadline"
          value={data.hero.subheadline}
          onChange={(e) => updateHero({ subheadline: e.target.value })}
          placeholder="Subheadline"
        />
        <input
          aria-label="Hero CTA text"
          value={data.hero.cta ?? ""}
          onChange={(e) => updateHero({ cta: e.target.value })}
          placeholder="CTA button text"
        />
        <input
          aria-label="Hero CTA URL"
          value={data.hero.ctaUrl ?? ""}
          onChange={(e) => updateHero({ ctaUrl: e.target.value })}
          placeholder="CTA URL"
        />
        {artifactId && (
          <div className="landing-hero-image">
            <h3>Hero image</h3>
            {data.hero.image ? (
              <div
                className="landing-hero-image-preview"
                data-testid="landing-hero-image-preview"
              >
                <img
                  src={data.hero.image.assetUrl}
                  alt={`Hero image for ${data.hero.headline}`}
                  width={data.hero.image.width}
                  height={data.hero.image.height}
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
                  data.hero.subheadline
                    ? `Marketing hero image for "${data.hero.headline}" — ${data.hero.subheadline}`
                    : `Marketing hero image for "${data.hero.headline}"`
                }
                onGenerated={onHeroImageGenerated}
              />
            )}
          </div>
        )}

        <h2>Features</h2>
        {data.features.map((f, i) => (
          <div className="landing-feature" key={i}>
            <button
              type="button"
              className="landing-icon-button"
              onClick={() => setPickerOpenFor(pickerOpenFor === i ? null : i)}
              aria-label="Pick icon"
            >
              {f.icon ?? "icon"}
            </button>
            <input
              aria-label={`Feature ${i + 1} title`}
              value={f.title}
              onChange={(e) => updateFeature(i, { title: e.target.value })}
              placeholder="Title"
            />
            <input
              aria-label={`Feature ${i + 1} description`}
              value={f.description}
              onChange={(e) =>
                updateFeature(i, { description: e.target.value })
              }
              placeholder="Description"
            />
            <button
              type="button"
              aria-label="Delete feature"
              onClick={() => removeFeature(i)}
            >
              <Trash2 size={16} />
            </button>
            {pickerOpenFor === i && (
              <div
                className="landing-icon-picker-popover"
                role="dialog"
                aria-label="Icon picker"
              >
                <button
                  type="button"
                  className="landing-icon-picker-close"
                  aria-label="Close icon picker"
                  onClick={() => setPickerOpenFor(null)}
                >
                  <X size={16} />
                </button>
                <IconPicker
                  value={parsePickedIcon(f.icon)}
                  onChange={(v) => {
                    updateFeature(i, { icon: `${v.set}:${v.name}` });
                    setPickerOpenFor(null);
                  }}
                />
              </div>
            )}
          </div>
        ))}
        <button type="button" onClick={addFeature} aria-label="Add feature">
          <Plus size={16} /> Add feature
        </button>

        <h2>Stats</h2>
        {data.stats.map((s, i) => (
          <div className="landing-stat" key={i}>
            <input
              aria-label={`Stat ${i + 1} value`}
              value={s.value}
              onChange={(e) => updateStat(i, { value: e.target.value })}
              placeholder="Value (e.g. 99.9%)"
            />
            <input
              aria-label={`Stat ${i + 1} label`}
              value={s.label}
              onChange={(e) => updateStat(i, { label: e.target.value })}
              placeholder="Label"
            />
            <button
              type="button"
              aria-label="Delete stat"
              onClick={() => removeStat(i)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addStat} aria-label="Add stat">
          <Plus size={16} /> Add stat
        </button>

        <h2>Testimonials</h2>
        {data.testimonials.map((t, i) => (
          <div className="landing-testimonial" key={i}>
            <textarea
              aria-label={`Testimonial ${i + 1} quote`}
              value={t.quote}
              onChange={(e) => updateTestimonial(i, { quote: e.target.value })}
              placeholder="Quote"
              rows={2}
            />
            <input
              aria-label={`Testimonial ${i + 1} name`}
              value={t.name}
              onChange={(e) => updateTestimonial(i, { name: e.target.value })}
              placeholder="Name"
            />
            <input
              aria-label={`Testimonial ${i + 1} company`}
              value={t.company ?? ""}
              onChange={(e) =>
                updateTestimonial(i, { company: e.target.value })
              }
              placeholder="Company"
            />
            <button
              type="button"
              aria-label="Delete testimonial"
              onClick={() => removeTestimonial(i)}
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <button type="button" onClick={addTestimonial} aria-label="Add testimonial">
          <Plus size={16} /> Add testimonial
        </button>

        <h2>Final CTA</h2>
        <input
          aria-label="CTA headline"
          value={data.cta?.headline ?? ""}
          onChange={(e) => updateCta({ headline: e.target.value })}
          placeholder="CTA section headline"
        />
        <input
          aria-label="CTA button text"
          value={data.cta?.buttonText ?? ""}
          onChange={(e) => updateCta({ buttonText: e.target.value })}
          placeholder="CTA button text"
        />
        <input
          aria-label="CTA button URL"
          value={data.cta?.buttonUrl ?? ""}
          onChange={(e) => updateCta({ buttonUrl: e.target.value })}
          placeholder="CTA button URL"
        />
      </div>

      <div
        className="landing-preview"
        data-testid="landing-preview"
        aria-label="Landing page preview"
        dangerouslySetInnerHTML={{ __html: previewHtml }}
      />
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
