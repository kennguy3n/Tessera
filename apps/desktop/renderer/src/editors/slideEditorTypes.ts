/**
 * Pure type declarations for `SlideEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */

export type SlideBlockType = "text" | "bullets" | "diagram" | "image";

export interface SlideBlock {
  type: SlideBlockType;
  /**
   * Block content. Semantics depend on `type`:
   *   - text / bullets — plain user text
   *   - diagram — Mermaid DSL
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
}

/**
 * Pre-defined block compositions for new slides. The layout determines
 * the initial `blocks` array shape; the user is free to mutate every
 * block afterwards, add more, or delete them down to zero. The layout
 * itself is NOT persisted on the Slide — it only governs the initial
 * state of a freshly-inserted slide. Persisting it would constrain
 * future edits and force a "this slide is a two-column slide, you
 * can't add a third block" rule we explicitly DO NOT want.
 */
export type SlideLayout =
  | "blank"
  | "title"
  | "titleContent"
  | "twoColumn"
  | "imageCaption";

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
