/**
 * Curated layout catalogue for the structured Slide editor.
 *
 * Design intent
 * -------------
 * Gamma-style responsive layouts: semantic named regions arranged via
 * CSS grid, NOT Google-Slides-style absolute pixel positioning.
 * Content flows into named regions ("slots") and always looks good
 * without manual alignment — ideal for non-designer SME tenants.
 *
 * Single source of truth for region geometry
 * -------------------------------------------
 * The CSS grid definitions live in `styles/components.css` under
 * `[data-slide-layout="<id>"]` selectors (with matching dark-mode
 * overrides). This module is the *metadata* catalogue: stable ids,
 * human labels, region definitions (slot names + grid-area mapping),
 * a one-line description for the picker, and the Marp `_class` each
 * layout maps to for the export pipeline.
 *
 * Mirrors `slideThemes.ts`: pure metadata, no React, no IPC.
 */
import type { Slide, SlideLayout } from "./slideEditorTypes";

/**
 * A named region within a layout. Each region maps to a CSS
 * grid-area and accepts specific block types (or any type if
 * `acceptedTypes` is omitted).
 */
export interface LayoutRegion {
  /** Slot name used as `SlideBlock.slot` and CSS `grid-area`. */
  slot: string;
  /** Human label shown in the empty-region placeholder. */
  label: string;
  /** Placeholder text shown when the region is empty. */
  placeholder: string;
}

export interface SlideLayoutDef {
  /** Stable id persisted in `Slide.layout`. NEVER rename. */
  id: SlideLayout;
  /** Human label for the layout picker. */
  label: string;
  /** One-line description for the picker tooltip. */
  description: string;
  /**
   * Ordered regions. The first region is the "primary" / title
   * region. Regions map to CSS grid-areas in `components.css`.
   */
  regions: readonly LayoutRegion[];
  /**
   * Marp `_class` value emitted in the export pipeline so the
   * generated slide gets the matching Marp CSS treatment.
   */
  marpClass: string;
  /** Compact ASCII glyph for the layout picker thumbnail. */
  glyph: string;
  /**
   * Optional lucide icon name (resolved via `iconResolver`) shown
   * alongside the label in the richer layout/insert menus. Purely a
   * display affordance: when absent or unresolvable the UI falls back
   * to {@link glyph}, so this never affects layout geometry or export.
   */
  iconName?: string;
}

/**
 * The curated catalogue, in picker display order. The FIRST entry
 * is the default applied to slides with no persisted `layout`.
 */
export const SLIDE_LAYOUTS: readonly SlideLayoutDef[] = [
  {
    id: "titleContent",
    label: "Title + Content",
    description: "Heading with a body region below.",
    regions: [{ slot: "body", label: "Body", placeholder: "Add content…" }],
    marpClass: "layout-titleContent",
    glyph: "═\n─",
    iconName: "Type",
  },
  {
    id: "title",
    label: "Title Only",
    description: "A centred title — perfect for opening and closing slides.",
    regions: [],
    marpClass: "layout-title",
    glyph: "═",
    iconName: "Heading1",
  },
  {
    id: "sectionHeader",
    label: "Section Header",
    description: "Bold centred heading for dividing deck sections.",
    regions: [
      { slot: "subtitle", label: "Subtitle", placeholder: "Add subtitle…" },
    ],
    marpClass: "layout-sectionHeader",
    glyph: "◆",
    iconName: "Minus",
  },
  {
    id: "twoColumn",
    label: "Two Columns",
    description: "Side-by-side regions for comparison or parallel content.",
    regions: [
      { slot: "left", label: "Left", placeholder: "Left column…" },
      { slot: "right", label: "Right", placeholder: "Right column…" },
    ],
    marpClass: "layout-twoColumn",
    glyph: "│ │",
    iconName: "Columns2",
  },
  {
    id: "imageLeft",
    label: "Image Left",
    description: "Image on the left, text body on the right.",
    regions: [
      { slot: "image", label: "Image", placeholder: "Add image…" },
      { slot: "body", label: "Body", placeholder: "Add content…" },
    ],
    marpClass: "layout-imageLeft",
    glyph: "▣ ─",
    iconName: "PanelLeft",
  },
  {
    id: "imageRight",
    label: "Image Right",
    description: "Text body on the left, image on the right.",
    regions: [
      { slot: "body", label: "Body", placeholder: "Add content…" },
      { slot: "image", label: "Image", placeholder: "Add image…" },
    ],
    marpClass: "layout-imageRight",
    glyph: "─ ▣",
    iconName: "PanelRight",
  },
  {
    id: "bigNumber",
    label: "Big Number",
    description: "Hero statistic with a supporting caption.",
    regions: [
      { slot: "number", label: "Number", placeholder: "42%" },
      { slot: "caption", label: "Caption", placeholder: "Add caption…" },
    ],
    marpClass: "layout-bigNumber",
    glyph: "##",
    iconName: "Hash",
  },
  {
    id: "quote",
    label: "Quote",
    description: "Centred quotation with optional attribution.",
    regions: [
      { slot: "quote", label: "Quote", placeholder: "Add quote…" },
      { slot: "attribution", label: "Attribution", placeholder: "— Author" },
    ],
    marpClass: "layout-quote",
    glyph: "❝❞",
    iconName: "Quote",
  },
  {
    id: "imageCaption",
    label: "Image + Caption",
    description: "Full-width image with a text caption below.",
    regions: [
      { slot: "image", label: "Image", placeholder: "Add image…" },
      { slot: "caption", label: "Caption", placeholder: "Add caption…" },
    ],
    marpClass: "layout-imageCaption",
    glyph: "▣\n─",
    iconName: "Image",
  },
  {
    id: "blank",
    label: "Blank",
    description: "Empty canvas — arrange blocks freely.",
    regions: [{ slot: "body", label: "Body", placeholder: "Add content…" }],
    marpClass: "layout-blank",
    glyph: "□",
    iconName: "Square",
  },
  {
    id: "timeline",
    label: "Timeline",
    description: "Horizontal sequence of milestones connected on a track.",
    regions: [
      { slot: "event", label: "Milestone", placeholder: "Add a milestone…" },
    ],
    marpClass: "layout-timeline",
    glyph: "●─●─●",
    iconName: "Milestone",
  },
  {
    id: "process",
    label: "Process / Steps",
    description: "Numbered steps that flow left-to-right for how-to flows.",
    regions: [{ slot: "step", label: "Step", placeholder: "Describe a step…" }],
    marpClass: "layout-process",
    glyph: "1·2·3",
    iconName: "ListOrdered",
  },
  {
    id: "comparison",
    label: "Comparison",
    description: "Two side-by-side panels with a central divider.",
    regions: [
      { slot: "left", label: "Option A", placeholder: "First option…" },
      { slot: "right", label: "Option B", placeholder: "Second option…" },
    ],
    marpClass: "layout-comparison",
    glyph: "▮│▮",
    iconName: "GitCompare",
  },
  {
    id: "gallery",
    label: "Gallery",
    description: "Responsive grid of images that wraps to fit the canvas.",
    regions: [{ slot: "image", label: "Image", placeholder: "Add an image…" }],
    marpClass: "layout-gallery",
    glyph: "▦",
    iconName: "Images",
  },
  {
    id: "metricRow",
    label: "Metric Row",
    description: "A row of headline numbers with supporting labels.",
    regions: [{ slot: "metric", label: "Metric", placeholder: "e.g. 99%" }],
    marpClass: "layout-metricRow",
    glyph: "## ##",
    iconName: "BarChart3",
  },
] as const;

/** Default layout for slides with no persisted `layout`. */
export const DEFAULT_SLIDE_LAYOUT: SlideLayout = SLIDE_LAYOUTS[0].id;

const LAYOUT_BY_ID: ReadonlyMap<string, SlideLayoutDef> = new Map(
  SLIDE_LAYOUTS.map((l) => [l.id, l]),
);

/**
 * True iff `id` names a layout in the catalogue. Used by the content
 * parser to validate a persisted `layout` before trusting it.
 */
export function isKnownSlideLayout(
  id: string | undefined | null,
): id is SlideLayout {
  return typeof id === "string" && LAYOUT_BY_ID.has(id);
}

/**
 * Resolve a (possibly missing / unknown) layout id to a concrete
 * layout definition, falling back to the default. Total — never
 * throws, always returns a usable layout.
 */
export function getSlideLayout(id: string | undefined | null): SlideLayoutDef {
  if (id != null) {
    const found = LAYOUT_BY_ID.get(id);
    if (found) return found;
  }
  return LAYOUT_BY_ID.get(DEFAULT_SLIDE_LAYOUT)!;
}

/**
 * Infer a layout from a slide's block shape. Used when loading legacy
 * decks that have no persisted `layout`. The heuristic examines block
 * types and count to pick the best visual match.
 *
 * Pure, deterministic, tested.
 */
export function inferLayoutFromBlocks(slide: Slide): SlideLayout {
  const { blocks, title } = slide;
  const types = blocks.map((b) => b.type);
  const hasImage = types.includes("image");
  const textishCount = types.filter(
    (t) => t === "text" || t === "bullets",
  ).length;

  // No blocks at all → title-only
  if (blocks.length === 0) {
    return "title";
  }

  // Single image block (no text) → imageCaption without the caption
  if (blocks.length === 1 && hasImage) {
    return "imageCaption";
  }

  // Image + one text/bullets → imageRight
  if (blocks.length === 2 && hasImage && textishCount === 1) {
    const imageIdx = types.indexOf("image");
    return imageIdx === 0 ? "imageLeft" : "imageRight";
  }

  // Two text/bullets blocks (no image) → twoColumn
  if (blocks.length === 2 && textishCount === 2 && !hasImage) {
    return "twoColumn";
  }

  // Single short text line → could be bigNumber or quote
  if (blocks.length === 1 && blocks[0].type === "text") {
    const content = blocks[0].content.trim();
    // Looks like a number/stat (starts with digit or %, short)
    if (/^\d/.test(content) && content.length <= 20) {
      return "bigNumber";
    }
  }

  // Title-only with no real content
  if (
    blocks.length === 1 &&
    blocks[0].type === "text" &&
    blocks[0].content.trim() === "" &&
    title.trim() !== ""
  ) {
    return "titleContent";
  }

  // Default: title + content
  return "titleContent";
}

/**
 * Resolve the layout for a slide. If the slide has a persisted and
 * known layout, returns it directly. Otherwise infers from block shape.
 */
export function resolveSlideLayout(slide: Slide): SlideLayout {
  if (isKnownSlideLayout(slide.layout)) return slide.layout;
  return inferLayoutFromBlocks(slide);
}
