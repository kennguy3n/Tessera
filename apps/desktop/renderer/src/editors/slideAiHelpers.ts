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
import { buildBlock, newSlideId, parseSlideChart } from "./slideEditorHelpers";
import {
  SLIDE_LAYOUTS,
  isKnownSlideLayout,
  resolveSlideLayout,
} from "./slideLayouts";
import type { Slide, SlideBlock, SlideLayout } from "./slideEditorTypes";

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
  /**
   * Optional layout id the model emitted for this slide via the
   * `## [layout] title` heading convention. Validated and resolved by
   * {@link resolveGeneratedSlideLayout}; an unknown / unsupported hint
   * is ignored in favour of the deterministic heuristic.
   */
  layoutHint?: string;
}

/**
 * Layouts the deck generator is allowed to assign from a model hint.
 * Restricted to content-only layouts so an AI-generated slide never
 * materialises an empty image region (image layouts are reserved for
 * the per-slide "Suggest layout" action where the user is editing a
 * real slide and can fill the image). The first slide is always the
 * cover (`title`).
 */
export const AI_DECK_LAYOUTS: ReadonlySet<SlideLayout> = new Set<SlideLayout>([
  "title",
  "titleContent",
  "twoColumn",
  "bigNumber",
  "sectionHeader",
  "quote",
]);

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

/** Matches a leading `[layout]` tag on a slide heading, e.g. `[twoColumn]`. */
const LAYOUT_HINT_RE = /^\[\s*([a-zA-Z]+)\s*\]\s*(.*)$/;

/**
 * Split an optional leading `[layout]` tag off a slide heading. The
 * deck generator asks the model to prefix each slide heading with a
 * layout hint (`## [twoColumn] Comparison`); this recovers the hint and
 * the bare title. Returns `{ title }` unchanged when no tag is present
 * so a normal heading is untouched.
 */
export function splitLayoutHint(heading: string): {
  layoutHint?: string;
  title: string;
} {
  const match = LAYOUT_HINT_RE.exec(heading);
  if (!match) return { title: heading };
  const title = match[2].trim();
  return { layoutHint: match[1].trim(), title };
}

/**
 * Whether a hinted layout can actually be materialised from the parsed
 * slide's content. `twoColumn` needs two columns to fill, while
 * `bigNumber` and `quote` need at least one bullet for the headline /
 * quotation respectively — honouring those hints for a slide that
 * lacks the bullets would leave an empty region (or duplicate the
 * title into the quote slot). Every other deck-gen layout materialises
 * safely for any bullet count (`sectionHeader`/`titleContent` handle 0
 * bullets), so an under-filled hint falls back to the heuristic.
 */
function hintFitsContent(
  hint: SlideLayout,
  parsed: ParsedOutlineSlide,
): boolean {
  switch (hint) {
    case "twoColumn":
      return parsed.bullets.length >= 2;
    case "bigNumber":
    case "quote":
      return parsed.bullets.length >= 1;
    default:
      return true;
  }
}

/**
 * Resolve the layout for a generated slide: prefer the model's hint
 * when it names a layout supported for generation AND that layout fits
 * the slide's content, otherwise fall back to the deterministic
 * {@link suggestLayoutForGeneratedSlide} heuristic. The first slide is
 * always the cover (`title`). Pure — no IO.
 */
export function resolveGeneratedSlideLayout(
  parsed: ParsedOutlineSlide,
  index: number,
  total: number,
): SlideLayout {
  if (index === 0) return "title";
  const hint = parsed.layoutHint;
  if (
    hint &&
    isKnownSlideLayout(hint) &&
    AI_DECK_LAYOUTS.has(hint) &&
    hintFitsContent(hint, parsed)
  ) {
    return hint;
  }
  return suggestLayoutForGeneratedSlide(parsed, index, total);
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
      const { layoutHint, title } = splitLayoutHint(heading);
      current = { title, bullets: [], layoutHint };
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
/**
 * Select the best layout for a generated slide based on its content.
 * Pure, deterministic — no IO or model calls.
 *
 * Heuristics:
 *   - First slide (title slide) → "title" (just the deck title)
 *   - No bullets, short title → "sectionHeader" (section divider)
 *   - Single short bullet (≤ 20 chars starting with a digit) → "bigNumber"
 *   - Single bullet → "titleContent" (text block)
 *   - 2 bullets → "twoColumn" (parallel comparison)
 *   - 3+ bullets → "titleContent" (standard bullets)
 *   - Last slide → "sectionHeader" (closing slide)
 */
export function suggestLayoutForGeneratedSlide(
  parsed: ParsedOutlineSlide,
  index: number,
  total: number,
  _deckTitle?: string,
): SlideLayout {
  const isTitleSlide = index === 0;
  const isClosingSlide = index === total - 1 && total > 2;

  // Title slide: deck-level title only
  if (isTitleSlide) return "title";

  // Closing slide: section header style (clean ending)
  if (isClosingSlide && parsed.bullets.length === 0) return "sectionHeader";

  // No bullets → section header
  if (parsed.bullets.length === 0) return "sectionHeader";

  // Single short bullet starting with digit → big number
  if (parsed.bullets.length === 1) {
    const bullet = parsed.bullets[0].trim();
    if (/^\d/.test(bullet) && bullet.length <= 20) return "bigNumber";
    return "titleContent";
  }

  // Two bullets → two columns
  if (parsed.bullets.length === 2) return "twoColumn";

  // Default: title + content with bullets
  return "titleContent";
}

export function outlineToSlides(outline: ParsedDeckOutline): Slide[] {
  if (outline.slides.length === 0) return [];
  const total = outline.slides.length;
  return outline.slides.map((parsed, index) => {
    const isTitleSlide = index === 0;
    const title = isTitleSlide && outline.title ? outline.title : parsed.title;
    const layout = resolveGeneratedSlideLayout(parsed, index, total);

    const blocks: SlideBlock[] = [];
    switch (layout) {
      case "title":
      case "sectionHeader":
        // No body blocks for title/section slides
        if (parsed.bullets.length > 0) {
          blocks.push(
            buildBlock({
              type: "text",
              content: parsed.bullets.join("\n"),
              slot: "subtitle",
            }),
          );
        }
        break;
      case "bigNumber":
        blocks.push(
          buildBlock({
            type: "text",
            content: parsed.bullets[0] ?? "",
            slot: "number",
          }),
        );
        if (parsed.title) {
          blocks.push(
            buildBlock({
              type: "text",
              content: parsed.title,
              slot: "caption",
            }),
          );
        }
        break;
      case "twoColumn":
        blocks.push(
          buildBlock({
            type: "text",
            content: parsed.bullets[0] ?? "",
            slot: "left",
          }),
        );
        blocks.push(
          buildBlock({
            type: "text",
            content: parsed.bullets.slice(1).join("\n"),
            slot: "right",
          }),
        );
        break;
      case "quote":
        // First bullet (or the heading) is the quotation; a second
        // bullet, if present, becomes the attribution line.
        blocks.push(
          buildBlock({
            type: "text",
            content: parsed.bullets[0] ?? parsed.title,
            slot: "quote",
          }),
        );
        if (parsed.bullets.length > 1) {
          blocks.push(
            buildBlock({
              type: "text",
              content: parsed.bullets.slice(1).join(" "),
              slot: "attribution",
            }),
          );
        }
        break;
      default:
        // titleContent and fallback
        if (parsed.bullets.length > 1) {
          blocks.push(
            buildBlock({
              type: "bullets",
              content: parsed.bullets.join("\n"),
              slot: "body",
            }),
          );
        } else if (parsed.bullets.length === 1) {
          blocks.push(
            buildBlock({
              type: "text",
              content: parsed.bullets[0],
              slot: "body",
            }),
          );
        } else {
          blocks.push(buildBlock({ type: "text", content: "", slot: "body" }));
        }
        break;
    }
    return {
      id: newSlideId("slide"),
      title: layout === "bigNumber" ? "" : title,
      blocks,
      notes: parsed.notes ?? "",
      layout,
    };
  });
}

// ---------------------------------------------------------------------------
// Per-slide context + prompt builders
// ---------------------------------------------------------------------------

/**
 * Flatten a slide into the compact plain-text context fed to the model
 * for a per-slide operation. Title first, then each text/bullets
 * block's lines; image/diagram/table/chart blocks contribute a short
 * placeholder so the model knows they exist without being handed a
 * multi-MB data URL or raw Mermaid/table/chart DSL. This mirrors the
 * presenter-mode `slideBodyLines` placeholders so all serialisation
 * paths describe non-text blocks the same way.
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
    } else if (block.type === "table") {
      parts.push("[table]");
    } else if (block.type === "chart") {
      const title = parseSlideChart(block.content)?.title?.trim();
      parts.push(title ? `[chart: ${title}]` : "[chart]");
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
 * Shared output contract + layout vocabulary for the deck-level
 * prompts. Both {@link buildDeckPrompt} (generate from a topic) and
 * {@link buildDeckRestylePrompt} (restyle an existing deck) emit the
 * EXACT same `## [layout] title` + bullets format, so a single
 * {@link parseDeckOutline} / {@link outlineToSlides} pipeline parses
 * both responses. Keeping the spec in one place means the parser and
 * the prompt can never drift apart.
 */
const DECK_OUTPUT_CONTRACT_LINES: readonly string[] = [
  "Output format (follow EXACTLY, output nothing else):",
  "TITLE: <deck title>",
  "## [layout] <slide title>",
  "- <bullet, max ~12 words>",
  "- <bullet>",
  "",
  "Choose [layout] for each slide from this list, picking the best fit:",
  "- twoColumn: two parallel points or a comparison (exactly 2 bullets)",
  "- bigNumber: one headline statistic (a single short numeric bullet)",
  "- quote: a notable quotation (bullet 1 = quote, bullet 2 = attribution)",
  "- sectionHeader: a divider with no bullets",
  "- titleContent: standard bullets (use this when unsure)",
];

/**
 * Build the "generate a deck" prompt. The strict output contract at
 * the top is what makes {@link parseDeckOutline} reliable against a
 * small local model.
 */
export function buildDeckPrompt(input: DeckPromptInput): string {
  const count = clampDeckSlideCount(input.slideCount);
  const tone = TONE_GUIDANCE[input.tone ?? "professional"];
  // Build the prompt line-by-line, keeping the blank `""` entries as
  // real blank lines so the format spec, layout vocabulary, rules and
  // topic stay visually separated (paragraph breaks help the model).
  // The optional audience line is appended conditionally rather than
  // filtered out, so no blank-line separators get swallowed.
  const lines = [
    "You are a presentation outline generator.",
    `Produce a slide deck outline of exactly ${count} slides for the topic below.`,
    "",
    ...DECK_OUTPUT_CONTRACT_LINES,
    "",
    "Rules:",
    "- The first slide is the title slide: omit the [layout] tag, 0-1 bullets.",
    "- Every other slide starts with a [layout] tag and has 2-5 short bullets.",
    "- No preamble, no closing remarks, no code fences, no bold/italic.",
    `- ${tone}`,
    "",
  ];
  if (input.audience?.trim()) {
    lines.push(`Audience: ${input.audience.trim()}`);
  }
  lines.push(`Topic: ${input.topic.trim()}`);
  return lines.join("\n");
}

export interface DeckRestyleInput {
  /** The deck to restyle, in display order. */
  slides: Slide[];
  /** Optional tone; defaults to "professional". */
  tone?: DeckTone;
}

/**
 * Serialise an existing deck into the same line-oriented outline format
 * the deck prompts ask the model to PRODUCE, so a restyle is a
 * round-trip through one shared grammar. Each slide becomes a
 * `## [layout] title` heading (the first slide omits the tag, matching
 * the title-slide convention) followed by its text/bullets content and
 * an optional `NOTES:` line. Image / diagram / table / chart blocks are
 * intentionally omitted from the text stream — they are re-attached
 * structurally by {@link mergeRestyledDeck} so a binary asset or raw
 * table/chart DSL is never serialised into a prompt (privacy + token
 * budget; the model would otherwise restyle the DSL as prose). Pure —
 * no IO.
 */
export function serializeDeckForRestyle(slides: Slide[]): string {
  const lines: string[] = [];
  slides.forEach((slide, index) => {
    const layout = resolveSlideLayout(slide);
    const title = slide.title.trim() || "Untitled slide";
    lines.push(index === 0 ? `## ${title}` : `## [${layout}] ${title}`);
    for (const block of slide.blocks) {
      if (
        block.type === "image" ||
        block.type === "diagram" ||
        block.type === "table" ||
        block.type === "chart"
      ) {
        continue;
      }
      const body = block.content
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      for (const line of body) lines.push(`- ${line}`);
    }
    const notes = slide.notes?.trim();
    if (notes) lines.push(`NOTES: ${notes}`);
  });
  return lines.join("\n");
}

/**
 * Build the "restyle this deck" prompt. Reuses the shared deck output
 * contract so the model's response parses through the same
 * {@link parseDeckOutline} → {@link outlineToSlides} pipeline as a
 * fresh generation; the difference is the instruction set, which pins
 * the slide count + order and asks the model to improve wording and
 * layout choices rather than invent new content.
 */
export function buildDeckRestylePrompt(input: DeckRestyleInput): string {
  const count = input.slides.length;
  const tone = TONE_GUIDANCE[input.tone ?? "professional"];
  return [
    "You are a presentation design editor.",
    `Restyle the existing ${count}-slide deck below.`,
    "Keep the meaning and order of every slide; do not add, drop, or reorder slides.",
    "For each slide, tighten the wording and pick the [layout] that best fits its content.",
    "",
    ...DECK_OUTPUT_CONTRACT_LINES,
    "",
    "Rules:",
    `- Output exactly ${count} slides, in the same order, each covering the same point as the input.`,
    "- The first slide is the title slide: omit the [layout] tag.",
    "- Tighten bullets to be short and punchy; keep every key fact.",
    "- No preamble, no closing remarks, no code fences, no bold/italic.",
    `- ${tone}`,
    "",
    "Current deck:",
    serializeDeckForRestyle(input.slides),
  ].join("\n");
}

/**
 * Layouts that carry an image region. Derived from the layout
 * catalogue (single source of truth) so a new image layout is picked
 * up automatically. Used by {@link mergeRestyledDeck} to decide when a
 * slide's original (image-bearing) layout must be preserved.
 */
const IMAGE_LAYOUTS: ReadonlySet<SlideLayout> = new Set(
  SLIDE_LAYOUTS.filter((l) => l.regions.some((r) => r.slot === "image")).map(
    (l) => l.id,
  ),
);

/**
 * Reconcile a model-restyled deck back onto the originals, index by
 * index, so a restyle improves presentation WITHOUT silently losing
 * user content:
 *
 *   - The slide id is carried over from the original at the same index
 *     so the thumbnail navigator and selection stay stable across a
 *     restyle (the deck is re-keyed in place, not rebuilt).
 *   - Non-text blocks (image / diagram / table / chart) never travel
 *     through the text outline, so they are re-attached from the
 *     original slide; a restyle can never drop a picture, diagram,
 *     table, or chart.
 *   - When the original slide used an image layout but the model picked
 *     a text-only layout, the original layout is preserved so the
 *     re-attached image keeps its region instead of becoming an
 *     orphaned block.
 *   - Notes fall back to the original when the model omitted them.
 *
 * Any extra slides the model emitted beyond the original count are kept
 * as-is (fresh ids from `outlineToSlides`); the prompt pins the count,
 * but the merge stays total in case a model over-produces. Pure — no IO.
 */
export function mergeRestyledDeck(
  originals: Slide[],
  restyled: Slide[],
): Slide[] {
  return restyled.map((next, index) => {
    const original = originals[index];
    if (!original) return next;
    // Every non-text block is re-attached structurally (none travel
    // through the text outline): images, diagrams, and the data blocks
    // (table / chart), so a restyle can't destroy a user's table/chart.
    const preserved = original.blocks.filter(
      (b) =>
        b.type === "image" ||
        b.type === "diagram" ||
        b.type === "table" ||
        b.type === "chart",
    );
    // Only image/diagram blocks anchor to an image region, so only they
    // drive whether a model-downgraded layout must be restored. Tables
    // and charts render as ordinary blocks and need no image region.
    const regionVisuals = original.blocks.filter(
      (b) => b.type === "image" || b.type === "diagram",
    );
    const nextLayout = next.layout ?? resolveSlideLayout(next);
    const layout =
      regionVisuals.length > 0 &&
      IMAGE_LAYOUTS.has(resolveSlideLayout(original)) &&
      !IMAGE_LAYOUTS.has(nextLayout)
        ? resolveSlideLayout(original)
        : nextLayout;
    return {
      ...next,
      id: original.id,
      layout,
      blocks:
        preserved.length > 0 ? [...next.blocks, ...preserved] : next.blocks,
      notes: next.notes?.trim() ? next.notes : original.notes,
    };
  });
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

/**
 * A regenerated single slide: a fresh title + bullets the model
 * produced for one existing slide. Distinct from the per-slide rewrite
 * (which only transforms the existing bullets) — regenerate is allowed
 * to rephrase the title too.
 */
export interface RegeneratedSlide {
  title: string;
  bullets: string[];
}

/**
 * Build a per-slide "regenerate" prompt: ask the model for a fresh,
 * sharper take on ONE slide while staying on the same subject. Uses the
 * single-slide `## title` + bullets contract (no `[layout]` tag — the
 * slide keeps its current layout) so {@link parseRegeneratedSlide} can
 * recover it via the shared outline parser. The optional deck title
 * gives the model context for tone/topic without leaking other slides.
 */
export function buildSlideRegeneratePrompt(
  slide: Slide,
  deckTitle?: string,
): string {
  const lines = [
    "You are regenerating one slide of a presentation.",
    "Produce a fresh, sharper version of this slide on the SAME subject.",
    "Keep the slide's topic and intent; improve the title and the bullets.",
    "",
    "Output format (follow EXACTLY, output nothing else):",
    "## <slide title>",
    "- <bullet, max ~12 words>",
    "- <bullet>",
    "",
    "Rules:",
    "- 2-5 short bullets. No preamble, no code fences, no bold/italic.",
  ];
  if (deckTitle?.trim()) lines.push(`Deck: ${deckTitle.trim()}`);
  lines.push("", "Current slide:", slideToContext(slide));
  return lines.join("\n");
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

/**
 * Build a prompt asking the model to pick the single best layout for a
 * slide from the curated catalogue. Every layout's stable id +
 * one-line description is listed so the model has the full vocabulary;
 * the output contract (the bare id, nothing else) lets
 * {@link parseLayoutSuggestion} recover it reliably.
 */
export function buildLayoutSuggestionPrompt(slide: Slide): string {
  const options = SLIDE_LAYOUTS.map(
    (layout) => `- ${layout.id}: ${layout.description}`,
  ).join("\n");
  return [
    "You are a presentation design assistant.",
    "Choose the single best layout for the slide below.",
    "Available layouts:",
    options,
    "",
    "Output ONLY the layout id (for example: twoColumn).",
    "No explanation, no punctuation, no other text.",
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
 * Normalise a layout token for tolerant matching: lower-case and strip
 * everything but letters/digits so `twoColumn`, `Two Columns` and
 * `two-column` all collapse to the same key.
 */
function normLayoutKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Lookup from a normalised token to a layout id, built from every
 * layout's stable id AND its human label so the parser recognises both
 * `twoColumn` and `Two Columns`.
 */
const LAYOUT_KEY_LOOKUP: ReadonlyMap<string, SlideLayout> = (() => {
  const map = new Map<string, SlideLayout>();
  for (const layout of SLIDE_LAYOUTS) {
    map.set(normLayoutKey(layout.id), layout.id);
    map.set(normLayoutKey(layout.label), layout.id);
  }
  return map;
})();

/**
 * Normalised layout keys that are also common English words. These only
 * match as a whole line or the FIRST token of a line, never buried in
 * prose, so a reply like "the title works best here" doesn't get
 * mis-read as the `title` layout. Unambiguous ids (e.g. `twoColumn`,
 * `bigNumber`) remain matchable anywhere in the response.
 */
const AMBIGUOUS_LAYOUT_KEYS: ReadonlySet<string> = new Set([
  "title",
  "quote",
  "blank",
]);

/**
 * Parse a per-slide "suggest a layout" response into a known layout id.
 * Tolerant of a small model that wraps the id in prose, code fences, or
 * uses the human label / hyphenated form. For each line it tries an
 * exact (normalised) whole-line match first — catching multi-word
 * labels like "Two Columns" and bare ids — then scans individual
 * tokens, returning the FIRST recognised layout. Layout ids that double
 * as common English words ({@link AMBIGUOUS_LAYOUT_KEYS}) are only
 * trusted as the first token to avoid false positives from prose.
 * Returns null when nothing in the response names a known layout, so
 * the caller can no-op rather than apply a bogus layout. Pure — no IO.
 */
export function parseLayoutSuggestion(raw: string): SlideLayout | null {
  const text = stripCodeFences(raw);
  for (const rawLine of text.split(/\r?\n/)) {
    const lineMatch = LAYOUT_KEY_LOOKUP.get(normLayoutKey(rawLine));
    if (lineMatch) return lineMatch;
    const tokens = rawLine.split(/[^a-zA-Z0-9]+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i += 1) {
      const key = normLayoutKey(tokens[i]);
      const tokenMatch = LAYOUT_KEY_LOOKUP.get(key);
      if (!tokenMatch) continue;
      if (AMBIGUOUS_LAYOUT_KEYS.has(key) && i !== 0) continue;
      return tokenMatch;
    }
  }
  return null;
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

/**
 * Parse a per-slide "regenerate" response into a fresh title + bullets.
 * Reuses the shared {@link parseDeckOutline} grammar and takes the
 * first slide it recovers (the response describes a single slide), so
 * the same heading / bullet tolerances apply. Returns null when the
 * model returned nothing usable (no title AND no bullets) so the caller
 * can no-op rather than blank the slide. Pure — no IO.
 */
export function parseRegeneratedSlide(raw: string): RegeneratedSlide | null {
  const first = parseDeckOutline(raw).slides[0];
  if (!first) return null;
  const title = first.title.trim();
  if (!title && first.bullets.length === 0) return null;
  return { title, bullets: first.bullets };
}

/**
 * Apply a regenerated slide onto an existing one: swap in the new
 * bullets (via {@link applyBulletsToSlide}, so images/diagrams and the
 * slide's layout + notes are preserved) and the new title. An empty
 * regenerated title keeps the current title rather than blanking it.
 * Returns the input slide unchanged (referential equality) when neither
 * the title nor the bullets would change, so the caller can
 * short-circuit a no-op apply.
 */
export function applyRegeneratedSlide(
  slide: Slide,
  regen: RegeneratedSlide,
): Slide {
  const title = regen.title || slide.title;
  const withBullets =
    regen.bullets.length > 0
      ? applyBulletsToSlide(slide, regen.bullets)
      : slide;
  if (title === slide.title && withBullets === slide) return slide;
  return { ...withBullets, title };
}
