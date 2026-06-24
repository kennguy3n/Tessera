/**
 * Pure helpers for `InfographicEditor` — content parsing and the
 * deterministic HTML / printable-text renderers used by the
 * preview and export pipelines.
 *
 * Extracted out of `InfographicEditor.tsx` so the component file's
 * exports are all components — required for React Fast Refresh to
 * preserve editor state across HMR edits. Types are imported from
 * `./infographicEditorTypes` (a dedicated type-only module), so
 * there is no runtime cycle with the component file: both this
 * helpers module and the component module independently consume
 * types from the third file, breaking the would-be A↔B dependency
 * edge.
 */
import { embedIcons } from "../services/iconResolver";
import { sanitizeCssColor } from "../utils/cssColor";
import { sanitizeIconSpec } from "../utils/iconSpec";
import { sanitizeHeroImage } from "../utils/heroImage";
import { escapeHtml } from "../utils/htmlEscape";
import type {
  InfographicContent,
  InfographicLayout,
} from "./infographicEditorTypes";

const LAYOUT_ALLOWLIST: readonly InfographicLayout[] = [
  "vertical",
  "horizontal",
  "grid",
];

export function sanitizeInfographicLayout(value: unknown): InfographicLayout {
  return typeof value === "string" &&
    (LAYOUT_ALLOWLIST as readonly string[]).includes(value)
    ? (value as InfographicLayout)
    : "vertical";
}

export const DEFAULT_INFOGRAPHIC_PRIMARY = "#7C3AED";
export const DEFAULT_INFOGRAPHIC_SECONDARY = "#0EA5E9";
export const DEFAULT_INFOGRAPHIC_ACCENT = "#F59E0B";

export function parseInfographicContent(content: string): InfographicContent {
  const fallback: InfographicContent = {
    title: "Untitled Infographic",
    subtitle: "",
    layout: "vertical",
    colorScheme: {
      primary: DEFAULT_INFOGRAPHIC_PRIMARY,
      secondary: DEFAULT_INFOGRAPHIC_SECONDARY,
      accent: DEFAULT_INFOGRAPHIC_ACCENT,
    },
    defaultIconSet: "lucide",
    sections: [
      {
        heading: "Section 1",
        body: "Describe the first idea here.",
        icon: "lucide:sparkles",
      },
    ],
  };
  if (!content) return fallback;
  try {
    const parsed = JSON.parse(content) as Partial<InfographicContent>;
    if (parsed && Array.isArray(parsed.sections)) {
      return {
        title: parsed.title ?? fallback.title,
        subtitle: parsed.subtitle ?? "",
        layout: sanitizeInfographicLayout(parsed.layout),
        colorScheme: {
          primary: parsed.colorScheme?.primary ?? DEFAULT_INFOGRAPHIC_PRIMARY,
          secondary:
            parsed.colorScheme?.secondary ?? DEFAULT_INFOGRAPHIC_SECONDARY,
          accent: parsed.colorScheme?.accent ?? DEFAULT_INFOGRAPHIC_ACCENT,
        },
        defaultIconSet: parsed.defaultIconSet ?? "lucide",
        sections:
          parsed.sections.length > 0 ? parsed.sections : fallback.sections,
        heroImage: sanitizeHeroImage(parsed.heroImage),
      };
    }
  } catch {
    // Fall back to default
  }
  return fallback;
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
    DEFAULT_INFOGRAPHIC_PRIMARY,
  );
  const secondary = sanitizeCssColor(
    data.colorScheme.secondary,
    DEFAULT_INFOGRAPHIC_SECONDARY,
  );
  const accent = sanitizeCssColor(
    data.colorScheme.accent,
    DEFAULT_INFOGRAPHIC_ACCENT,
  );
  // `data.layout` is allowlisted by `sanitizeInfographicLayout` in
  // `parseInfographicContent`, but interpolating into a class attribute
  // deserves defence-in-depth: a future refactor that drops the upstream
  // validation must not silently re-open the XSS surface. We re-validate
  // here and fall back to the safe `vertical` class on any anomaly.
  const layoutClass = `infographic-preview-${sanitizeInfographicLayout(data.layout)}`;
  const sectionsHtml = data.sections
    .map((s) => {
      // The icon spec comes from user-editable JSON. The `embedIcons()`
      // token regex would refuse a malformed spec, but a value containing
      // `}}` would close the token prematurely and let arbitrary trailing
      // text reach the DOM via `dangerouslySetInnerHTML`. Validate against
      // an `lucide|phosphor` + alnum/`_-` grammar and drop the icon when
      // the spec is malformed.
      const safeIcon = sanitizeIconSpec(s.icon);
      const iconToken = safeIcon
        ? `{{icon:${safeIcon} size=32 color=${primary}}}`
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

  // Hero image (optional). The `assetUrl` was already validated to
  // start with `tessera-asset://generated-images/` by
  // `sanitizeHeroImage`, but the value is still user-derived (the
  // IPC handler returns the URL and the editor persists it
  // verbatim) so we HTML-escape it
  // before interpolating into the `src` attribute as belt-and-
  // braces. Width/height are written to the DOM so the layout
  // doesn't reflow when the image finishes decoding. Width/height
  // are also HTML-escaped — `sanitizeHeroImage` validates them as
  // finite positive `Number.isSafeInteger` values today (so
  // `Number(n).toString()` produces only digits, never HTML-special
  // characters), but the consistency with every other interpolation
  // in this template string defends against a future refactor that
  // might relax the type to accept e.g. a string-typed `"100%"`
  // dimension and would otherwise silently open an injection vector
  // through the now-unescaped `width="${...}"` slot. Devin Review PR
  // #38 post-merge follow-up.
  const heroHtml = data.heroImage
    ? `<figure class="infographic-hero">
  <img src="${escapeHtml(data.heroImage.assetUrl)}" alt="${escapeHtml(data.title)}" width="${escapeHtml(String(data.heroImage.width))}" height="${escapeHtml(String(data.heroImage.height))}" />
</figure>`
    : "";

  const html = `<div class="infographic ${layoutClass}" style="--igc-primary:${primary};--igc-secondary:${secondary};--igc-accent:${accent};">
  <header class="infographic-header">
    <h1>${escapeHtml(data.title)}</h1>
    ${data.subtitle ? `<p class="infographic-subtitle">${escapeHtml(data.subtitle)}</p>` : ""}
  </header>
  ${heroHtml}
  <div class="infographic-grid">
    ${sectionsHtml}
  </div>
</div>`;
  return embedIcons(html);
}

/**
 * Build a readable plain-text / markdown rendering of the infographic for
 * line-based export formats (PDF, DOCX). The Rust PDF exporter walks the
 * content line-by-line and renders each non-empty line as a paragraph; an
 * HTML or JSON dump produces tag-soup output that does not resemble the
 * visual infographic at all. This serialiser produces the equivalent of
 * the screen-reader view: title, subtitle, and per-section heading + stat
 * + body separated by blank lines so the PDF builder lays them out as
 * stacked paragraphs.
 *
 * The output deliberately omits CSS, colour scheme and icon glyphs since
 * the PDF builder is text-only and cannot rasterise inline SVG (the
 * Typst PDF pipeline in `crates/tessera_export/src/typst.rs` is where
 * high-fidelity diagram embedding belongs). The icon name is included as
 * a textual hint so the reader still knows what symbol the section was
 * meant to carry.
 *
 * Regression: before this fix, exporting an infographic to PDF would
 * dump the raw JSON model line-by-line through the PDF builder,
 * producing pages of `{"title": "..."}` syntax instead of the visual
 * layout.
 */
export function buildInfographicPrintableText(
  data: InfographicContent,
): string {
  const lines: string[] = [];
  // Title as a top-level heading. The PDF builder renders the first line
  // at a larger font size irrespective of markdown syntax, but emitting
  // `# Title` keeps the same content readable when the same string is
  // routed through the markdown export path too.
  lines.push(`# ${data.title}`);
  if (data.subtitle) {
    lines.push("");
    lines.push(data.subtitle);
  }
  for (const s of data.sections) {
    lines.push("");
    // Heading on its own line so the line-based PDF reader picks it up
    // as a distinct paragraph.
    lines.push(`## ${s.heading}`);
    if (s.stat) {
      // Stat blocks are short emphatic numbers (e.g. "10x", "$1.2M") with
      // an optional descriptive label — flatten to a single line.
      const label = s.statLabel ? ` ${s.statLabel}` : "";
      lines.push(`${s.stat}${label}`);
    }
    if (s.body) {
      lines.push(s.body);
    }
    if (s.icon) {
      // Surface the icon hint at the end of the section. We keep it
      // verbose ("Icon:") rather than relying on punctuation so an export
      // viewed without styling is still self-describing.
      lines.push(`Icon: ${s.icon}`);
    }
  }
  return lines.join("\n");
}
