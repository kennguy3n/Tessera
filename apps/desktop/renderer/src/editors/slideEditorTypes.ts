/**
 * Pure type declarations for `SlideEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */

export type SlideBlockType = "text" | "bullets" | "diagram";

export interface SlideBlock {
  type: SlideBlockType;
  content: string;
}

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
