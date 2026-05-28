/**
 * Pure helpers for `LandingPageEditor` — content parsing and the
 * deterministic HTML / printable-text renderers used by the
 * preview and export pipelines.
 *
 * Extracted out of `LandingPageEditor.tsx` so the component file's
 * exports are all components — required for React Fast Refresh to
 * preserve editor state across HMR edits. Types are imported from
 * `./landingPageEditorTypes` (a dedicated type-only module), so
 * there is no runtime cycle with the component file: both this
 * helpers module and the component module independently consume
 * types from the third file, breaking the would-be A↔B dependency
 * edge.
 */
import { embedIcons } from "../services/iconResolver";
import { sanitizeCssColor } from "../utils/cssColor";
import { sanitizeIconSpec } from "../utils/iconSpec";
import { sanitizeUrl } from "../utils/safeUrl";
import { sanitizeHeroImage } from "../utils/heroImage";
import { escapeHtml } from "../utils/htmlEscape";
import type { LandingPageContent } from "./landingPageEditorTypes";

const DEFAULT_LANDING_PRIMARY = "#7C3AED";
const DEFAULT_LANDING_SECONDARY = "#0EA5E9";
const DEFAULT_LANDING_ACCENT = "#F59E0B";

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
      primary: DEFAULT_LANDING_PRIMARY,
      secondary: DEFAULT_LANDING_SECONDARY,
      accent: DEFAULT_LANDING_ACCENT,
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
          image: sanitizeHeroImage(parsed.hero.image),
        },
        features:
          parsed.features.length > 0 ? parsed.features : fallback.features,
        stats: Array.isArray(parsed.stats) ? parsed.stats : [],
        testimonials: Array.isArray(parsed.testimonials)
          ? parsed.testimonials
          : [],
        cta: parsed.cta ?? fallback.cta,
        colorScheme: {
          primary: parsed.colorScheme?.primary ?? DEFAULT_LANDING_PRIMARY,
          secondary:
            parsed.colorScheme?.secondary ?? DEFAULT_LANDING_SECONDARY,
          accent: parsed.colorScheme?.accent ?? DEFAULT_LANDING_ACCENT,
        },
      };
    }
  } catch {
    // Fall back to default
  }
  return fallback;
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
    DEFAULT_LANDING_PRIMARY,
  );
  const secondary = sanitizeCssColor(
    data.colorScheme.secondary,
    DEFAULT_LANDING_SECONDARY,
  );
  const accent = sanitizeCssColor(
    data.colorScheme.accent,
    DEFAULT_LANDING_ACCENT,
  );

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

  // Hero image (optional). The `assetUrl` is already validated to
  // start with `tessera-asset://generated-images/` by
  // `sanitizeHeroImage`, but the value still comes from
  // user-derived JSON, so we HTML-escape it
  // before interpolating into `src` as defence-in-depth. Width and
  // height are written to the DOM so the layout doesn't reflow when
  // the image finishes decoding. Width/height are also HTML-escaped
  // for the same belt-and-braces reason — `sanitizeHeroImage`
  // validates them as finite positive `Number.isSafeInteger` values
  // today (so `Number(n).toString()` produces only digits, never
  // HTML-special characters), but escaping pins the invariant that
  // EVERY user-derived interpolation in this template string passes
  // through `escapeHtml`, so a future refactor that relaxes the
  // type to accept e.g. a string-typed `"100%"` dimension cannot
  // silently open an injection vector through the unescaped
  // `width="${...}"` slot. Devin Review PR #38 post-merge follow-up.
  const heroImageHtml = data.hero.image
    ? `<figure class="landing-hero-image">\n      <img src="${escapeHtml(data.hero.image.assetUrl)}" alt="${escapeHtml(data.hero.headline)}" width="${escapeHtml(String(data.hero.image.width))}" height="${escapeHtml(String(data.hero.image.height))}" />\n    </figure>`
    : "";

  const html = `<div class="landing" style="--lp-primary:${primary};--lp-secondary:${secondary};--lp-accent:${accent};">
  <header class="landing-hero">
    <h1>${escapeHtml(data.hero.headline)}</h1>
    <p>${escapeHtml(data.hero.subheadline)}</p>
    ${heroCta}
    ${heroImageHtml}
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

/**
 * Build a readable plain-text / markdown rendering of the landing page for
 * line-based export formats (PDF, DOCX). Equivalent of the
 * `buildInfographicPrintableText` companion in `InfographicEditor.tsx` —
 * see that file for the design rationale. Same regression target: a PDF
 * export of a visual artifact must not dump raw JSON through the
 * line-based PDF builder.
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
