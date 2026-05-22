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
import { embedIcons } from "../services/iconResolver";
import { sanitizeCssColor } from "../utils/cssColor";
import { sanitizeIconSpec } from "../utils/iconSpec";
import { sanitizeUrl } from "../utils/safeUrl";
import { Plus, Trash2, X } from "lucide-react";

export interface LandingPageHero {
  headline: string;
  subheadline: string;
  cta?: string;
  ctaUrl?: string;
}

export interface LandingPageFeature {
  icon?: string;
  title: string;
  description: string;
}

export interface LandingPageStat {
  value: string;
  label: string;
}

export interface LandingPageTestimonial {
  quote: string;
  name: string;
  company?: string;
}

export interface LandingPageCta {
  headline: string;
  buttonText: string;
  buttonUrl?: string;
}

export interface LandingPageContent {
  title: string;
  hero: LandingPageHero;
  features: LandingPageFeature[];
  stats: LandingPageStat[];
  testimonials: LandingPageTestimonial[];
  cta?: LandingPageCta;
  colorScheme: {
    primary?: string;
    secondary?: string;
    accent?: string;
  };
}

interface LandingPageEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
}

const DEFAULT_PRIMARY = "#7C3AED";
const DEFAULT_SECONDARY = "#0EA5E9";
const DEFAULT_ACCENT = "#F59E0B";

export function parseLandingPageContent(content: string): LandingPageContent {
  const fallback: LandingPageContent = {
    title: "Untitled Landing Page",
    hero: {
      headline: "Your product, your way",
      subheadline: "Describe the problem you solve in one sentence.",
      cta: "Get started",
      ctaUrl: "#",
    },
    features: [
      {
        icon: "lucide:zap",
        title: "Fast",
        description: "Built for speed.",
      },
      {
        icon: "lucide:shield-check",
        title: "Secure",
        description: "Local-first and private by default.",
      },
      {
        icon: "lucide:sparkles",
        title: "Delightful",
        description: "Designed to feel right.",
      },
    ],
    stats: [],
    testimonials: [],
    cta: {
      headline: "Ready to start?",
      buttonText: "Sign up",
      buttonUrl: "#",
    },
    colorScheme: {
      primary: DEFAULT_PRIMARY,
      secondary: DEFAULT_SECONDARY,
      accent: DEFAULT_ACCENT,
    },
  };
  if (!content) return fallback;
  try {
    const parsed = JSON.parse(content) as Partial<LandingPageContent>;
    if (parsed && parsed.hero && Array.isArray(parsed.features)) {
      return {
        title: parsed.title ?? fallback.title,
        hero: {
          headline: parsed.hero.headline ?? fallback.hero.headline,
          subheadline: parsed.hero.subheadline ?? fallback.hero.subheadline,
          cta: parsed.hero.cta ?? "",
          ctaUrl: parsed.hero.ctaUrl ?? "",
        },
        features:
          parsed.features.length > 0 ? parsed.features : fallback.features,
        stats: Array.isArray(parsed.stats) ? parsed.stats : [],
        testimonials: Array.isArray(parsed.testimonials)
          ? parsed.testimonials
          : [],
        cta: parsed.cta ?? fallback.cta,
        colorScheme: {
          primary: parsed.colorScheme?.primary ?? DEFAULT_PRIMARY,
          secondary: parsed.colorScheme?.secondary ?? DEFAULT_SECONDARY,
          accent: parsed.colorScheme?.accent ?? DEFAULT_ACCENT,
        },
      };
    }
  } catch {
    // Fall back to default
  }
  return fallback;
}

export default function LandingPageEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
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

/**
 * Pure preview builder — exercised by unit tests. The output is a standalone
 * HTML fragment with icon tokens already substituted to inline SVG via the
 * iconResolver, so a downstream HTML export can serialize it directly.
 */
export function buildLandingPreviewHtml(data: LandingPageContent): string {
  // See `sanitizeCssColor` — we validate before interpolating into the
  // inline `style="..."` attribute below so a maliciously crafted color
  // value cannot escape its CSS-property slot. The native color picker
  // already constrains its output to `#rrggbb`, but the JSON is editable.
  const primary = sanitizeCssColor(
    data.colorScheme.primary,
    DEFAULT_PRIMARY,
  );
  const secondary = sanitizeCssColor(
    data.colorScheme.secondary,
    DEFAULT_SECONDARY,
  );
  const accent = sanitizeCssColor(data.colorScheme.accent, DEFAULT_ACCENT);

  // Defense in depth: even though the JSON should already be trustworthy
  // (locally authored on this machine), the `href` slot is the highest-risk
  // attribute in the rendered preview — a `javascript:` scheme would
  // execute on click in the live `dangerouslySetInnerHTML` preview AND in
  // any exported HTML the user shares. `escapeHtml` does NOT strip URL
  // schemes, so we route every href through `sanitizeUrl` first, which
  // falls back to `#` for unsafe schemes.
  const heroCta = data.hero.cta
    ? `<a class="landing-hero-cta" href="${escapeHtml(sanitizeUrl(data.hero.ctaUrl, "#"))}">${escapeHtml(data.hero.cta)}</a>`
    : "";

  const featuresHtml = data.features
    .map((f) => {
      // See InfographicEditor for rationale: the icon spec is interpolated
      // into a `{{icon:...}}` token that `embedIcons` later resolves to inline
      // SVG. A spec containing `}}` would close the token prematurely and let
      // arbitrary trailing text reach the DOM via `dangerouslySetInnerHTML`.
      // Validate against the strict `lucide|phosphor` + alnum/`_-` grammar.
      const safeIcon = sanitizeIconSpec(f.icon);
      const icon = safeIcon
        ? `{{icon:${safeIcon} size=24 color=${primary}}}`
        : "";
      return `<article class="landing-feature">
  <div class="landing-feature-icon">${icon}</div>
  <h3>${escapeHtml(f.title)}</h3>
  <p>${escapeHtml(f.description)}</p>
</article>`;
    })
    .join("\n");

  const statsHtml = data.stats.length
    ? `<section class="landing-stats">
  ${data.stats
    .map(
      (s) =>
        `<div class="landing-stat"><span class="landing-stat-value">${escapeHtml(s.value)}</span><span class="landing-stat-label">${escapeHtml(s.label)}</span></div>`,
    )
    .join("\n  ")}
</section>`
    : "";

  const testimonialsHtml = data.testimonials.length
    ? `<section class="landing-testimonials">
  ${data.testimonials
    .map(
      (t) =>
        `<blockquote class="landing-testimonial"><p>${escapeHtml(t.quote)}</p><footer>${escapeHtml(t.name)}${t.company ? ` — ${escapeHtml(t.company)}` : ""}</footer></blockquote>`,
    )
    .join("\n  ")}
</section>`
    : "";

  const finalCta = data.cta?.buttonText
    ? `<section class="landing-final-cta">
  <h2>${escapeHtml(data.cta.headline)}</h2>
  <a class="landing-final-cta-button" href="${escapeHtml(sanitizeUrl(data.cta.buttonUrl, "#"))}">${escapeHtml(data.cta.buttonText)}</a>
</section>`
    : "";

  const html = `<div class="landing" style="--lp-primary:${primary};--lp-secondary:${secondary};--lp-accent:${accent};">
  <header class="landing-hero">
    <h1>${escapeHtml(data.hero.headline)}</h1>
    <p>${escapeHtml(data.hero.subheadline)}</p>
    ${heroCta}
  </header>
  <section class="landing-features">
    ${featuresHtml}
  </section>
  ${statsHtml}
  ${testimonialsHtml}
  ${finalCta}
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

/**
 * Build a readable plain-text / markdown rendering of the landing page for
 * line-based export formats (PDF, DOCX). Equivalent of the
 * `buildInfographicPrintableText` companion in `InfographicEditor.tsx` —
 * see that file for the design rationale. Same regression target:
 * review-job-5a49c7d7ef804edda4f280500e2b1ff0_0001 (PDF export of
 * a visual artifact must not dump raw JSON through the line-based PDF
 * builder).
 *
 * The output structure mirrors the visible page sections — hero, features,
 * stats, testimonials, CTA — so the printed PDF reads top-to-bottom like
 * the page itself.
 */
export function buildLandingPagePrintableText(
  data: LandingPageContent,
): string {
  const lines: string[] = [];
  lines.push(`# ${data.title}`);

  // Hero block: headline (H2) + subheadline + optional CTA call.
  lines.push("");
  lines.push(`## ${data.hero.headline}`);
  if (data.hero.subheadline) {
    lines.push(data.hero.subheadline);
  }
  if (data.hero.cta) {
    // Emit the CTA as a labelled line so a reader without styling still
    // sees that this is the page's call to action. Including the URL
    // keeps the export self-contained when printed and read offline.
    const url = data.hero.ctaUrl ? ` — ${data.hero.ctaUrl}` : "";
    lines.push(`Call to action: ${data.hero.cta}${url}`);
  }

  if (data.features.length > 0) {
    lines.push("");
    lines.push("## Features");
    for (const f of data.features) {
      lines.push("");
      lines.push(`### ${f.title}`);
      if (f.description) {
        lines.push(f.description);
      }
      if (f.icon) {
        lines.push(`Icon: ${f.icon}`);
      }
    }
  }

  if (data.stats.length > 0) {
    lines.push("");
    lines.push("## Stats");
    for (const s of data.stats) {
      lines.push(`${s.value} — ${s.label}`);
    }
  }

  if (data.testimonials.length > 0) {
    lines.push("");
    lines.push("## Testimonials");
    for (const t of data.testimonials) {
      lines.push("");
      // Quote on its own line for readability; attribution underneath
      // (matches how block quotes typically render in print).
      lines.push(`"${t.quote}"`);
      const attribution = t.company ? `${t.name}, ${t.company}` : t.name;
      lines.push(`— ${attribution}`);
    }
  }

  if (data.cta) {
    lines.push("");
    lines.push(`## ${data.cta.headline}`);
    const url = data.cta.buttonUrl ? ` — ${data.cta.buttonUrl}` : "";
    lines.push(`Call to action: ${data.cta.buttonText}${url}`);
  }

  return lines.join("\n");
}
