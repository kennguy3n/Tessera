/**
 * Pure type declarations for `SlideEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */
import type { SlideBgStyle } from "./slideThemes";

export type SlideBlockType =
  | "text"
  | "bullets"
  | "diagram"
  | "table"
  | "chart"
  | "image";

export interface SlideBlock {
  /**
   * Stable identifier used as the React key and the drag-and-drop
   * payload. Generated fresh by `buildSlideFromLayout`, `appendBlock`,
   * `replaceBlock` (only when the caller doesn't pre-set one), and on
   * every duplicated block so reorders and duplicates never collide.
   *
   * Persisted in the saved JSON so a deck round-trips through disk
   * without React losing component identity. Legacy decks written
   * before don't have block IDs; `parseSlideContent`
   * backfills them on load so the rest of the editor never sees a
   * block without an ID.
   */
  id: string;
  type: SlideBlockType;
  /**
   * Block content. Semantics depend on `type`:
   *   - text / bullets — plain user text
   *   - diagram — Mermaid DSL
   *   - table — a GitHub-flavoured Markdown pipe table (one `| a | b |`
   *     row per line, an optional `| --- | --- |` separator). Parsed by
   *     `parseSlideTable` for the live preview and emitted verbatim on
   *     Marp export.
   *   - chart — a small line-oriented data DSL parsed by
   *     `parseSlideChart` (`type:`, `labels:`, then one `name: v, v, …`
   *     series line each). Rendered as inline SVG via `SlideChart`,
   *     reusing the `sheetCharts` geometry; exported as a data table.
   *   - image — a `data:` URL (the image-upload path embeds the file
   *     inline so the slide content stays self-contained and round-
   *     trips through the JSON storage layer without needing a
   *     separate asset registry). Empty string means "no image yet".
   */
  content: string;
  /**
   * Optional alt text for the image block. Required for accessibility
   * but stored separately from `content` so the data URL doesn't get
   * tangled with display metadata. Ignored for non-image blocks.
   */
  alt?: string;
  /**
   * Layout region this block occupies. Blocks with no `slot` flow
   * into the layout's default body region. The slot name corresponds
   * to a CSS grid-area defined in `slideLayouts.ts`. Persisted so
   * round-tripping through disk preserves the spatial arrangement.
   * Legacy decks omit this; `parseSlideContent` leaves it undefined
   * and the rendering path treats undefined as "body".
   */
  slot?: string;
}

/**
 * Pre-defined block compositions for new slides. The layout determines
 * the initial `blocks` array shape AND the visual region arrangement on
 * the canvas. The user is free to mutate every block afterwards, add
 * more, or delete them — blocks flow into the layout's regions by
 * `slot` and overflow into the default body region.
 *
 * The layout IS now persisted on the Slide (`Slide.layout`) so the
 * canvas can render the correct CSS-grid regions on re-open and the
 * layout picker can show which layout is active. This does NOT
 * constrain editing — blocks can always be added, removed, or retyped
 * regardless of the active layout. Changing layout just re-flows the
 * same blocks into different regions.
 */
export type SlideLayout =
  | "blank"
  | "title"
  | "titleContent"
  | "twoColumn"
  | "imageLeft"
  | "imageRight"
  | "sectionHeader"
  | "bigNumber"
  | "quote"
  | "imageCaption"
  // Smart layouts (additive — never reorder/rename the ids above).
  | "timeline"
  | "process"
  | "comparison"
  | "gallery"
  | "metricRow";

/**
 * Deck-level canvas aspect ratio. Optional and additive: legacy decks
 * omit it and `parseSlideContent` resolves the 16:9 default, so they
 * render exactly as before. "1:1" is useful for square social exports.
 */
export type SlideAspectRatio = "16:9" | "4:3" | "1:1";

export interface Slide {
  /**
   * Stable identifier used as the React key in the sidebar
   * thumbnails, in find-panel results, and as the drag-and-drop
   * payload when reordering slides. Generated fresh by
   * `buildSlideFromLayout` and by `duplicateSlideAt` (the duplicate
   * gets a new ID, not the source's ID — duplicating a slide must
   * not collide with the original's React key).
   *
   * Persisted in the saved JSON so a deck round-trips through disk
   * without React losing slide identity. `parseSlideContent`
   * backfills IDs for slides parsed from older saves that don't
   * have one.
   */
  id: string;
  title: string;
  blocks: SlideBlock[];
  notes: string;
  /**
   * Persisted layout id. Controls the CSS-grid region arrangement on
   * the canvas (see `slideLayouts.ts`). Optional and additive: legacy
   * decks omit it and `parseSlideContent` infers a layout from the
   * block shape. Unknown ids degrade to the default layout.
   */
  layout?: SlideLayout;
  /**
   * Per-slide background override. When set, this slide renders with
   * the given background style instead of the deck theme's default
   * `bgStyle` (see `slideThemes.ts`). Optional and additive: legacy
   * decks and slides that don't override simply inherit the theme
   * background. Reuses the existing `SlideBgStyle` union and the
   * `[data-slide-bg]` CSS so no new rendering primitive is needed.
   */
  background?: SlideBgStyle;
}

export interface MarpModeState {
  enabled: boolean;
  source: string;
  theme?: string;
}

export interface SlideContent {
  slides: Slide[];
  marp?: MarpModeState;
  /**
   * Curated deck theme id (see `slideThemes.ts`). Optional and
   * additive: legacy decks saved before themes shipped simply omit
   * it and `parseSlideContent` resolves the default. The id is
   * validated against the known catalogue on load, so an unknown /
   * hand-edited value degrades to the default rather than stamping an
   * unstyled theme attribute onto the canvas.
   */
  themeId?: string;
  /**
   * Deck canvas aspect ratio (see {@link SlideAspectRatio}). Optional
   * and additive: legacy decks omit it and `parseSlideContent`
   * resolves the 16:9 default. A hand-edited / unknown value degrades
   * to 16:9 rather than stamping an invalid attribute onto the canvas.
   */
  aspectRatio?: SlideAspectRatio;
}
