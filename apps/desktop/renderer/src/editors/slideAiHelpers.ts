/**
 * Pure logic for the Slide editor's AI assistant.
 *
 * This module is the "thin helpers" half of the editor pattern
 * (`SlideEditor.tsx` + `slideEditorHelpers.ts` + `slideEditorTypes.ts`):
 * it owns every piece of AI logic that does NOT touch React or the IPC
 * surface, so it can be exhaustively unit-tested without a renderer or
 * a running model.
 *
 * Two responsibilities:
 *
 *   1. PROMPT BUILDERS — turn editor state + a user request into the
 *      plain-text prompt handed to `window.tessera.model.generate`.
 *      Every prompt is deterministic and self-contained (no chat
 *      history) so a small on-device model produces a parseable
 *      result, and so the prompt can be snapshot-tested.
 *
 *   2. TOLERANT PARSERS — turn the model's free-form streamed text
 *      back into structured `Slide[]` / `string[]` data. On-device
 *      models are small and do NOT reliably emit strict JSON, so we
 *      parse a forgiving line-oriented format (headings + bullets)
 *      and defensively cap every dimension (slide count, bullet
 *      count, string length) so a runaway or adversarial completion
 *      can never blow up the editor or the saved document.
 *
 * Privacy: nothing here performs IO. The prompts are built from the
 * user's own deck content and are only ever sent to the LOCAL model
 * surface by the calling hook — see `hooks/useModelGeneration.ts`.
 */
import { buildBlock, newSlideId } from "./slideEditorHelpers";
import type { Slide, SlideBlock } from "./slideEditorTypes";

// ---------------------------------------------------------------------------
// Bounds. Every parsed dimension is clamped so a pathological completion
// (e.g. a model that loops forever emitting bullets) cannot produce a
// document that janks the renderer or bloats the saved JSON.
// ---------------------------------------------------------------------------

/** Min / max slides a single "generate a deck" request can produce. */
export const MIN_DECK_SLIDES = 3;
export const MAX_DECK_SLIDES = 20;
/** Max bullets kept per slide when parsing a model response. */
export const MAX_BULLETS_PER_SLIDE = 8;
/** Hard cap on any single parsed line (title / bullet) length. */
export const MAX_LINE_LENGTH = 240;
/** Hard cap on parsed speaker-notes length. */
export const MAX_NOTES_LENGTH = 800;

export type DeckTone = "professional" | "casual" | "academic" | "persuasive";

export interface DeckPromptInput {
  /** The user's free-text topic / brief for the deck. */
  topic: string;
  /** Desired slide count; clamped to [MIN_DECK_SLIDES, MAX_DECK_SLIDES]. */
  slideCount: number;
  /** Optional intended audience, woven into the prompt when present. */
  audience?: string;
  /** Optional tone; defaults to "professional". */
  tone?: DeckTone;
}

export interface ParsedOutlineSlide {
  title: string;
  bullets: string[];
  notes?: string;
}

export interface ParsedDeckOutline {
  /** Deck-level title parsed from a leading `TITLE:` line, if present. */
  title?: string;
  slides: ParsedOutlineSlide[];
}

export type SlideRewriteMode = "concise" | "expand" | "rewrite";

/**
 * Clamp a requested slide count into the supported range. NaN /
 * non-finite inputs collapse to the minimum so a bad <input> value
 * can't escape the bounds.
 */
export function clampDeckSlideCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_DECK_SLIDES;
  return Math.max(MIN_DECK_SLIDES, Math.min(MAX_DECK_SLIDES, Math.round(n)));
}

/**
 * Normalise a single line of model output: strip leading markdown
 * emphasis / list markers, collapse internal whitespace, drop wrapping
 * quotes, and hard-cap the length. Returns "" for a line that is empty
 * after cleaning (the caller filters those out).
 */
export function cleanModelLine(raw: string): string {
  let line = raw.trim();
  if (!line) return "";
  // Strip a leading list marker: -, *, •, –, —, or "1." / "1)".
  line = line.replace(/^\s*(?:[-*•–—]|\d+[.)])\s+/, "");
  // Strip surrounding markdown emphasis (**bold**, *italic*, `code`)
  // that a model sometimes wraps a whole line in. Only unwrap when the
  // SAME marker brackets the whole string so we don't mangle a line
  // that merely contains emphasis.
  line = line.replace(/^\*\*(.+)\*\*$/, "$1");
  line = line.replace(/^\*(.+)\*$/, "$1");
  line = line.replace(/^`(.+)`$/, "$1");
  // Strip wrapping straight / smart quotes.
  line = line.replace(/^["'“”'](.+)["'“”']$/, "$1");
  line = line.replace(/\s+/g, " ").trim();
  if (line.length > MAX_LINE_LENGTH) {
    line = line.slice(0, MAX_LINE_LENGTH).trimEnd();
  }
  return line;
}

/**
 * Strip Markdown code-fence lines (``` … ```) from a raw completion.
 * Small models sometimes wrap their entire answer in a fence; the
 * fence lines themselves carry no content and would otherwise be
 * parsed as stray text.
 */
function stripCodeFences(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter((line) => !/^\s*```/.test(line))
    .join("\n");
}

const HEADING_RE = /^\s*#{1,6}\s+(.*\S)\s*$/;
const SLIDE_LABEL_RE = /^\s*slide\s*\d+\s*[:.)-]\s*(.*\S)\s*$/i;
const NUMBERED_RE = /^\s*\d+[.)]\s+(.*\S)\s*$/;
const BULLET_RE = /^\s*(?:[-*•–—])\s+(.*\S)\s*$/;
const NOTES_RE = /^\s*notes?\s*[:-]\s*(.*)$/i;
const TITLE_RE = /^\s*title\s*[:-]\s*(.*\S)\s*$/i;

/**
 * Detect a slide-heading line and return its text, or null if the line
 * is not a heading. Accepts three forms a small model commonly emits:
 *
 *   - `## Heading`              (markdown ATX heading)
 *   - `Slide 2: Heading`        (explicit slide label)
 *   - `2. Heading` / `2) Heading` (numbered outline item)
 *
 * The numbered form is deliberately checked LAST and only when the
 * text after the number is non-empty, so a bare "2." never starts a
 * phantom slide.
 */
export function parseHeadingLine(line: string): string | null {
  const heading = HEADING_RE.exec(line);
  if (heading) return cleanModelLine(heading[1]);
  const labelled = SLIDE_LABEL_RE.exec(line);
  if (labelled) return cleanModelLine(labelled[1]);
  const numbered = NUMBERED_RE.exec(line);
  if (numbered) return cleanModelLine(numbered[1]);
  return null;
}

/**
 * Parse a model's free-form deck outline into structured slides.
 *
 * Forgiving by design (see module doc): it recognises markdown / label
 * / numbered headings, `-`/`*`/`•` bullets, an optional leading
 * `TITLE:` line, and per-slide `NOTES:` lines. Any non-blank line that
 * is none of those, while inside a slide section, is treated as a
 * bullet so prose-style output still yields content rather than being
 * silently dropped. Everything is clamped to the module bounds.
 */
export function parseDeckOutline(raw: string): ParsedDeckOutline {
  const text = stripCodeFences(raw);
  const lines = text.split(/\r?\n/);
  let deckTitle: string | undefined;
  const slides: ParsedOutlineSlide[] = [];
  let current: ParsedOutlineSlide | null = null;

  const pushCurrent = () => {
    if (current && (current.title || current.bullets.length > 0)) {
      slides.push(current);
    }
    current = null;
  };

  for (const rawLine of lines) {
    if (slides.length >= MAX_DECK_SLIDES && current === null) break;
    const line = rawLine.trim();
    if (!line) continue;

    // A deck-level TITLE only counts before the first slide heading.
    if (current === null && slides.length === 0 && deckTitle === undefined) {
      const titleMatch = TITLE_RE.exec(line);
      if (titleMatch) {
        deckTitle = cleanModelLine(titleMatch[1]);
        continue;
      }
    }

    const heading = parseHeadingLine(line);
    if (heading !== null) {
      pushCurrent();
      if (slides.length >= MAX_DECK_SLIDES) break;
      current = { title: heading, bullets: [] };
      continue;
    }

    // Lines below only make sense inside a slide; if a model emits
    // bullets before any heading, open an untitled slide so the
    // content is still captured.
    if (current === null) {
      current = { title: "", bullets: [] };
    }

    const notesMatch = NOTES_RE.exec(line);
    if (notesMatch) {
      const note = notesMatch[1].trim().slice(0, MAX_NOTES_LENGTH);
      current.notes = current.notes ? `${current.notes} ${note}` : note;
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    const candidate = bulletMatch
      ? cleanModelLine(bulletMatch[1])
      : cleanModelLine(line);
    if (candidate && current.bullets.length < MAX_BULLETS_PER_SLIDE) {
      current.bullets.push(candidate);
    }
  }
  pushCurrent();

  return { title: deckTitle, slides: slides.slice(0, MAX_DECK_SLIDES) };
}

/**
 * Convert a parsed outline into real `Slide[]` objects with fresh ids.
 *
 * Layout heuristic (kept simple + deterministic):
 *   - The FIRST slide becomes the title slide: its `title` is the deck
 *     title (falling back to the slide's own heading) and any bullets
 *     it carried become a single bullets block beneath it. A title
 *     slide with no bullets is title-only.
 *   - Every other slide with bullets gets one `bullets` block; a slide
 *     with a single line gets a `text` block (reads better than a
 *     one-item bullet list); a heading-only slide gets an empty text
 *     block so the canvas has an editable body.
 *
 * Returns `[]` for an outline with no usable slides so the caller can
 * surface "the model didn't return a usable deck" instead of applying
 * an empty deck.
 */
export function outlineToSlides(outline: ParsedDeckOutline): Slide[] {
  if (outline.slides.length === 0) return [];
  return outline.slides.map((parsed, index) => {
    const isTitleSlide = index === 0;
    const title = isTitleSlide && outline.title ? outline.title : parsed.title;
    const blocks: SlideBlock[] = [];
    if (parsed.bullets.length > 1) {
      blocks.push(
        buildBlock({ type: "bullets", content: parsed.bullets.join("\n") }),
      );
    } else if (parsed.bullets.length === 1) {
      blocks.push(buildBlock({ type: "text", content: parsed.bullets[0] }));
    } else if (!isTitleSlide) {
      blocks.push(buildBlock({ type: "text", content: "" }));
    }
    return {
      id: newSlideId("slide"),
      title,
      blocks,
      notes: parsed.notes ?? "",
    };
  });
}

// ---------------------------------------------------------------------------
// Per-slide context + prompt builders
// ---------------------------------------------------------------------------

/**
 * Flatten a slide into the compact plain-text context fed to the model
 * for a per-slide operation. Title first, then each text/bullets
 * block's lines; image/diagram blocks contribute a short placeholder
 * so the model knows they exist without being handed a multi-MB data
 * URL or raw Mermaid DSL.
 */
export function slideToContext(slide: Slide): string {
  const parts: string[] = [];
  if (slide.title.trim()) parts.push(`Title: ${slide.title.trim()}`);
  for (const block of slide.blocks) {
    if (block.type === "image") {
      const alt = (block.alt ?? "").trim();
      parts.push(alt ? `[image: ${alt}]` : "[image]");
    } else if (block.type === "diagram") {
      parts.push("[diagram]");
    } else {
      const body = block.content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of body) parts.push(`- ${line}`);
    }
  }
  return parts.join("\n");
}

const TONE_GUIDANCE: Record<DeckTone, string> = {
  professional: "Use a clear, professional business tone.",
  casual: "Use a friendly, conversational tone.",
  academic: "Use a precise, academic tone with domain-accurate terms.",
  persuasive: "Use a confident, persuasive tone that drives to action.",
};

/**
 * Build the "generate a deck" prompt. The strict output contract at
 * the top is what makes {@link parseDeckOutline} reliable against a
 * small local model.
 */
export function buildDeckPrompt(input: DeckPromptInput): string {
  const count = clampDeckSlideCount(input.slideCount);
  const tone = TONE_GUIDANCE[input.tone ?? "professional"];
  const audienceLine = input.audience?.trim()
    ? `Audience: ${input.audience.trim()}\n`
    : "";
  return [
    "You are a presentation outline generator.",
    `Produce a slide deck outline of exactly ${count} slides for the topic below.`,
    "",
    "Output format (follow EXACTLY, output nothing else):",
    "TITLE: <deck title>",
    "## <slide title>",
    "- <bullet, max ~12 words>",
    "- <bullet>",
    "",
    "Rules:",
    "- The first slide is the title slide and may have 0-1 bullets.",
    "- Every other slide has 2-5 short bullets.",
    "- No preamble, no closing remarks, no code fences, no bold/italic.",
    `- ${tone}`,
    "",
    audienceLine,
    `Topic: ${input.topic.trim()}`,
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * Build a per-slide bullet-rewrite prompt for the three rewrite modes.
 * The output contract (one bullet per line, `- ` prefix, no prose)
 * lets {@link parseBulletResponse} recover the bullets reliably.
 */
export function buildRewritePrompt(
  slide: Slide,
  mode: SlideRewriteMode,
): string {
  const context = slideToContext(slide);
  const instruction =
    mode === "concise"
      ? "Rewrite the slide's bullets to be more concise and punchy. Keep the key facts; cut filler. Aim for fewer, tighter bullets."
      : mode === "expand"
        ? "Expand the slide's bullets with 1-2 additional supporting points. Keep each bullet short."
        : "Rewrite the slide's bullets for clarity and impact. Keep roughly the same number of bullets.";
  return [
    "You are editing one slide of a presentation.",
    instruction,
    "",
    "Output ONLY the new bullets, one per line, each starting with '- '.",
    "No title, no preamble, no code fences.",
    "",
    "Current slide:",
    context,
  ].join("\n");
}

/** Build a prompt that asks the model for speaker notes for a slide. */
export function buildNotesPrompt(slide: Slide): string {
  return [
    "You are writing speaker notes for one presentation slide.",
    "Write 2-4 sentences the presenter can say aloud to expand on the slide.",
    "Output ONLY the notes as plain prose. No bullets, no preamble, no code fences.",
    "",
    "Slide:",
    slideToContext(slide),
  ].join("\n");
}

/** Build a prompt that asks the model for a single image-generation prompt. */
export function buildImagePromptSuggestion(slide: Slide): string {
  return [
    "Suggest ONE vivid image-generation prompt that visually represents this slide.",
    "Describe subject, style, mood and composition in a single line.",
    "Output ONLY the prompt text. No quotes, no preamble, no options list.",
    "",
    "Slide:",
    slideToContext(slide),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsers + appliers
// ---------------------------------------------------------------------------

/**
 * Parse a bullet-list response into clean bullet strings. Recognises
 * `-`/`*`/`•` and numbered markers; falls back to treating each
 * non-empty line as a bullet when the model omits markers. Clamped to
 * {@link MAX_BULLETS_PER_SLIDE}.
 */
export function parseBulletResponse(raw: string): string[] {
  const text = stripCodeFences(raw);
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (out.length >= MAX_BULLETS_PER_SLIDE) break;
    const line = rawLine.trim();
    if (!line) continue;
    // Skip a stray markdown heading or "Slide N:" label the model
    // might prepend. Numbered lines (`1.`) are kept — in a bullet
    // response they ARE the bullets, and `cleanModelLine` strips the
    // marker.
    if (HEADING_RE.test(line) || SLIDE_LABEL_RE.test(line)) {
      continue;
    }
    const cleaned = cleanModelLine(line);
    if (cleaned) out.push(cleaned);
  }
  return out;
}

/**
 * Parse a free-prose notes response into a single trimmed paragraph,
 * capped to {@link MAX_NOTES_LENGTH}. Collapses internal newlines to
 * spaces so the notes textarea shows one tidy block.
 */
export function parseNotesResponse(raw: string): string {
  const text = stripCodeFences(raw)
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, MAX_NOTES_LENGTH);
}

/**
 * Parse an image-prompt suggestion: the first non-empty, cleaned line.
 * Returns "" when the model returned nothing usable.
 */
export function parseImagePromptResponse(raw: string): string {
  const text = stripCodeFences(raw);
  for (const rawLine of text.split(/\r?\n/)) {
    const cleaned = cleanModelLine(rawLine);
    if (cleaned) return cleaned;
  }
  return "";
}

/**
 * Replace a slide's primary text/bullets block with a `bullets` block
 * holding `bullets`, preserving every image / diagram block and the
 * slide's title + notes. When the slide has no text/bullets block, a
 * new bullets block is prepended. Returns the input slide unchanged
 * (referential equality preserved) when `bullets` is empty so the
 * caller can short-circuit a no-op apply.
 */
export function applyBulletsToSlide(slide: Slide, bullets: string[]): Slide {
  if (bullets.length === 0) return slide;
  const content = bullets.join("\n");
  const targetIndex = slide.blocks.findIndex(
    (b) => b.type === "text" || b.type === "bullets",
  );
  if (targetIndex === -1) {
    return {
      ...slide,
      blocks: [buildBlock({ type: "bullets", content }), ...slide.blocks],
    };
  }
  const nextBlocks = slide.blocks.map((block, i) =>
    i === targetIndex
      ? { ...block, type: "bullets" as const, content, alt: undefined }
      : block,
  );
  return { ...slide, blocks: nextBlocks };
}
