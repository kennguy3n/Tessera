/**
 * Curated deck themes for the structured Slide editor.
 *
 * Design intent
 * -------------
 * Google Slides and Gamma both ship a small, opinionated set of
 * typographic + colour themes the user switches between with a live
 * preview, rather than a free-form colour picker. We mirror that: a
 * fixed catalogue of themes, each one a coordinated pairing of a
 * heading font, a body font, a surface colour and an accent.
 *
 * Single source of truth for colours
 * ----------------------------------
 * The *colour* values for each theme are NOT declared here. They live
 * in `styles/components.css` under `[data-slide-theme="<id>"]` (with
 * matching `[data-theme="dark"] [data-slide-theme="<id>"]` overrides)
 * so the whole theme system inherits the design-system's existing
 * light/dark parity, `color-mix` accent derivation and WCAG-AA
 * calibration with zero colour duplication between TS and CSS. The
 * editor applies a theme purely by stamping `data-slide-theme={id}`
 * on the canvas + preview swatches; CSS does the rest. This module is
 * therefore the *metadata* catalogue: stable ids, human labels, a
 * one-line description for the picker, and the Marp theme each maps to
 * for the export / present pipeline.
 *
 * Why a separate module (mirrors `slideEditorTypes` / `slideEditorHelpers`)
 * ------------------------------------------------------------------------
 * Keeping the catalogue out of the component file means the export
 * pipeline (`tessera_export` via `slidesToMarpMarkdown`) and the unit
 * tests can resolve a theme → Marp-theme mapping without importing the
 * React component, and Fast Refresh keeps working because the
 * component file still only exports components.
 */
import type { MarpRenderOptions } from "../services/marpRenderer";

/** Marp built-in themes the structured themes can map onto for export. */
export type MarpBuiltinTheme = NonNullable<MarpRenderOptions["theme"]>;

/**
 * Decorative background style applied via CSS. These map to
 * `--slide-bg-style` in `components.css`. "solid" is the default.
 */
export type SlideBgStyle = "solid" | "gradient" | "mesh" | "dots" | "lines";

export interface SlideTheme {
  /**
   * Stable identifier persisted in the saved deck JSON
   * (`SlideContent.themeId`) and stamped onto the canvas as
   * `data-slide-theme`. NEVER rename an existing id — doing so would
   * silently reset every saved deck to the default theme on next
   * open. Add a new id instead.
   */
  id: string;
  /** Human-readable label shown in the theme picker. */
  label: string;
  /** One-line description shown under the label in the picker. */
  description: string;
  /**
   * Marp built-in theme this maps to when the deck is exported /
   * presented through the Marp pipeline. The structured editor's
   * own colours are CSS-driven (see module doc), but the Marp CLI
   * only understands its three built-in themes, so each curated
   * theme picks the closest match.
   */
  marpTheme: MarpBuiltinTheme;
  /**
   * Font family for body/content blocks. When absent, inherits the
   * global `--font-family`. The canvas reads this through the
   * `--slide-font-body` CSS variable (set per-theme in `tokens.css`);
   * this TS field is the source-of-truth metadata kept alongside the
   * other theme properties and is available for future picker preview
   * enhancements.
   */
  bodyFont?: string;
  /**
   * Font weight for the heading. Defaults to 700 when absent.
   * Lets themes differentiate between bold geometric headings
   * and lighter, elegant typographic treatments.
   */
  headingWeight?: number;
  /**
   * Decorative background style. Maps to CSS class
   * `slide-bg-<style>` applied alongside the theme. Defaults to
   * "solid" when absent. Gradient/mesh/dots/lines are subtle
   * decorative patterns — NOT background images.
   */
  bgStyle?: SlideBgStyle;
  /**
   * Hex swatch colour displayed in the theme picker preview card.
   * Falls back to the CSS `--slide-accent` when omitted. Kept in
   * TS so the React picker can render without CSS variable lookups.
   */
  swatch?: string;
}

/**
 * The curated catalogue, in picker display order. The FIRST entry is
 * the default applied to decks with no persisted `themeId` (legacy
 * decks + brand-new decks) — see {@link DEFAULT_SLIDE_THEME_ID}.
 */
export const SLIDE_THEMES: readonly SlideTheme[] = [
  {
    id: "aurora",
    label: "Aurora",
    description: "Clean sans-serif on a soft, accent-tinted surface.",
    marpTheme: "default",
    swatch: "#7c3aed",
  },
  {
    id: "editorial",
    label: "Editorial",
    description: "Serif headlines on warm paper for long-form decks.",
    marpTheme: "default",
    bodyFont: "Georgia, 'Times New Roman', serif",
    headingWeight: 600,
    swatch: "#1d4ed8",
  },
  {
    id: "noir",
    label: "Noir",
    description: "High-contrast dark-forward theme for the stage.",
    marpTheme: "uncover",
    headingWeight: 800,
    swatch: "#111827",
  },
  {
    id: "mint",
    label: "Mint",
    description: "Fresh teal palette with airy spacing.",
    marpTheme: "default",
    swatch: "#0f766e",
  },
  {
    id: "solar",
    label: "Solar",
    description: "Warm amber accents with bold geometric headings.",
    marpTheme: "gaia",
    headingWeight: 800,
    bgStyle: "gradient",
    swatch: "#c2410c",
  },
  {
    id: "slate",
    label: "Slate",
    description: "Neutral, corporate-safe blue-grey.",
    marpTheme: "default",
    swatch: "#334155",
  },
  {
    id: "rosewood",
    label: "Rosewood",
    description: "Warm rose tones with elegant serif headings.",
    marpTheme: "default",
    bodyFont: "Georgia, 'Times New Roman', serif",
    headingWeight: 600,
    bgStyle: "gradient",
    swatch: "#9f1239",
  },
  {
    id: "ocean",
    label: "Ocean",
    description: "Deep navy with cyan accents — confident and modern.",
    marpTheme: "uncover",
    headingWeight: 700,
    bgStyle: "mesh",
    swatch: "#0e7490",
  },
  {
    id: "forest",
    label: "Forest",
    description: "Deep greens with earthy, organic feel.",
    marpTheme: "default",
    bgStyle: "dots",
    swatch: "#166534",
  },
  {
    id: "lavender",
    label: "Lavender",
    description: "Soft purple with lightweight, modern typography.",
    marpTheme: "default",
    headingWeight: 500,
    swatch: "#7e22ce",
  },
] as const;

/** Default theme for decks with no persisted `themeId`. */
export const DEFAULT_SLIDE_THEME_ID = SLIDE_THEMES[0].id;

const THEME_BY_ID: ReadonlyMap<string, SlideTheme> = new Map(
  SLIDE_THEMES.map((theme) => [theme.id, theme]),
);

/**
 * True iff `id` names a theme in the catalogue. Used by the
 * content parser to validate a persisted `themeId` before trusting
 * it (a hand-edited or future-version deck could carry an unknown
 * id, which must degrade to the default rather than stamping an
 * unstyled `data-slide-theme` onto the canvas).
 */
export function isKnownSlideThemeId(id: string | undefined | null): boolean {
  return typeof id === "string" && THEME_BY_ID.has(id);
}

/**
 * Resolve a (possibly missing / unknown) theme id to a concrete
 * theme, falling back to the default. Total — never throws, always
 * returns a usable theme so callers don't need their own guard.
 */
export function getSlideTheme(id: string | undefined | null): SlideTheme {
  if (id != null) {
    const found = THEME_BY_ID.get(id);
    if (found) return found;
  }
  return THEME_BY_ID.get(DEFAULT_SLIDE_THEME_ID) as SlideTheme;
}

/**
 * Resolve a theme id to its Marp built-in theme for the export /
 * present pipeline. Unknown ids fall back to the default theme's
 * mapping (not bare `"default"`) so the resolution stays consistent
 * with {@link getSlideTheme}.
 */
export function marpThemeForSlideTheme(
  id: string | undefined | null,
): MarpBuiltinTheme {
  return getSlideTheme(id).marpTheme;
}
