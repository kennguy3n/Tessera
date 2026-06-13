/**
 * Types for the DocumentEditor on-device AI writing assistant.
 *
 * Kept in a dedicated, dependency-light module (no TipTap / React
 * imports) so the pure prompt-building + output-cleaning helpers in
 * `documentAiHelpers.ts` and their unit tests can import these
 * shapes without dragging in the editor module graph.
 *
 * Everything here is on-device: the assistant only ever calls
 * `window.tessera.model.generate(...)` (the local sidecar or the
 * user's own configured provider). No document text is sent to any
 * Tessera-operated network service.
 */

/** Stable identifiers for the built-in writing actions. */
export type DocumentAiActionId =
  | "improve"
  | "shorter"
  | "longer"
  | "fix"
  | "tone"
  | "summarize"
  | "translate"
  | "bullets"
  | "continue"
  | "custom";

/** Logical grouping for rendering the action list in sections. */
export type DocumentAiActionGroup = "edit" | "transform" | "generate";

/**
 * How the assistant's result is written back into the document once
 * the user accepts it.
 *
 *  - `replace`: overwrite the current selection (or, when nothing is
 *    selected, the whole document body) with the result.
 *  - `insert-below`: drop the result into a new block immediately
 *    after the current selection / cursor block.
 *  - `append`: add the result at the very end of the document.
 */
export type DocumentAiApplyMode = "replace" | "insert-below" | "append";

/** Lifecycle of a single AI run, surfaced to the panel UI. */
export type DocumentAiRunStatus =
  | "idle"
  | "streaming"
  | "done"
  | "error"
  | "cancelled"
  | "battery_low";

/**
 * A single built-in writing action.
 *
 * `needsSelection` actions are disabled (with an explanatory hint)
 * when the editor selection is empty — e.g. "make shorter" has
 * nothing to shorten without selected text. `continue` and `custom`
 * work from the cursor / a free-form prompt and so do NOT require a
 * selection.
 */
export interface DocumentAiAction {
  id: DocumentAiActionId;
  label: string;
  description: string;
  group: DocumentAiActionGroup;
  /** Whether the action requires non-empty selected text to run. */
  needsSelection: boolean;
  /** Default apply mode suggested in the preview once a run finishes. */
  defaultApply: DocumentAiApplyMode;
  /** Search keywords (slash menu / command surfacing). */
  keywords: string[];
}

/** Tone presets for the "change tone" action. */
export type DocumentAiTone =
  | "professional"
  | "casual"
  | "confident"
  | "friendly"
  | "concise"
  | "academic";

/**
 * Everything the prompt builder needs to assemble the instruction
 * string handed to `model.generate`.
 *
 * `selection` is the plain-text of the current editor selection (may
 * be empty for `continue` / `custom`). `precedingText` gives the
 * model a little upstream context for `continue` so it can match
 * voice without us shipping the whole document.
 */
export interface DocumentAiPromptInput {
  action: DocumentAiActionId;
  selection: string;
  /** Free-form user instruction (the "Ask AI" box). */
  instruction?: string;
  /** Selected tone, only meaningful when `action === "tone"`. */
  tone?: DocumentAiTone;
  /** Target language label, only meaningful when `action === "translate"`. */
  language?: string;
  /** Up-to-a-few-hundred-chars of text before the cursor, for `continue`. */
  precedingText?: string;
}

/** One contiguous run in a rendered word-level diff. */
export interface DiffSegment {
  kind: "equal" | "added" | "removed";
  value: string;
}
