/**
 * Pure helpers for the DocumentEditor AI writing assistant.
 *
 * No TipTap / React / DOM imports — every function here is a plain
 * data transform so the test suite can pin behaviour without booting
 * the editor. The component + hook layers (`useDocumentAi`,
 * `AiAssistantPanel`) call into these for prompt assembly, output
 * sanitisation, and the diff preview.
 *
 * PRIVACY: `buildAiPrompt` only ever embeds text the user has already
 * typed / selected in their own document. The resulting string is
 * handed to `window.tessera.model.generate`, which runs on-device (or
 * against the user's own configured provider). Nothing here logs,
 * persists, or transmits document content.
 */

import { escapeHtml } from "../documentEditorHelpers";
import type {
  DiffSegment,
  DocumentAiAction,
  DocumentAiActionId,
  DocumentAiPromptInput,
  DocumentAiTone,
} from "./documentAiTypes";

// ─────────────────────────────────────────────────────────────────────
// Action catalog
// ─────────────────────────────────────────────────────────────────────

/**
 * The built-in writing actions, in display order. `custom` is the
 * free-form "Ask AI" path and is intentionally last; it is excluded
 * from the selection quick-toolbar (which only shows selection-scoped
 * transforms) but available in the Ask AI panel.
 */
export const DOCUMENT_AI_ACTIONS: readonly DocumentAiAction[] = [
  {
    id: "improve",
    label: "Improve writing",
    description: "Refine clarity, flow, and word choice",
    group: "edit",
    needsSelection: true,
    defaultApply: "replace",
    keywords: ["improve", "rewrite", "polish", "clarity", "enhance"],
  },
  {
    id: "fix",
    label: "Fix spelling & grammar",
    description: "Correct mistakes without changing meaning",
    group: "edit",
    needsSelection: true,
    defaultApply: "replace",
    keywords: ["fix", "grammar", "spelling", "proofread", "correct"],
  },
  {
    id: "shorter",
    label: "Make shorter",
    description: "Tighten the text while keeping the key points",
    group: "edit",
    needsSelection: true,
    defaultApply: "replace",
    keywords: ["shorter", "shorten", "concise", "trim", "condense"],
  },
  {
    id: "longer",
    label: "Make longer",
    description: "Expand with more detail and explanation",
    group: "edit",
    needsSelection: true,
    defaultApply: "replace",
    keywords: ["longer", "expand", "elaborate", "detail"],
  },
  {
    id: "tone",
    label: "Change tone",
    description: "Rewrite in a different voice",
    group: "transform",
    needsSelection: true,
    defaultApply: "replace",
    keywords: ["tone", "voice", "professional", "casual", "formal"],
  },
  {
    id: "summarize",
    label: "Summarize",
    description: "Condense into a short summary",
    group: "transform",
    needsSelection: true,
    defaultApply: "insert-below",
    keywords: ["summarize", "summary", "tldr", "abstract", "recap"],
  },
  {
    id: "bullets",
    label: "Turn into bullets",
    description: "Rewrite as a bulleted list",
    group: "transform",
    needsSelection: true,
    defaultApply: "replace",
    keywords: ["bullets", "list", "points", "bulleted"],
  },
  {
    id: "translate",
    label: "Translate",
    description: "Translate into another language",
    group: "transform",
    needsSelection: true,
    defaultApply: "replace",
    keywords: ["translate", "translation", "language"],
  },
  {
    id: "continue",
    label: "Continue writing",
    description: "Pick up where the cursor is and keep going",
    group: "generate",
    needsSelection: false,
    defaultApply: "insert-below",
    keywords: ["continue", "write", "more", "keep going", "draft"],
  },
  {
    id: "custom",
    label: "Ask AI",
    description: "Generate from your own instruction",
    group: "generate",
    needsSelection: false,
    defaultApply: "insert-below",
    keywords: ["ask", "prompt", "generate", "custom", "ai"],
  },
];

/** Human-readable labels for the tone presets. */
export const DOCUMENT_AI_TONES: ReadonlyArray<{
  id: DocumentAiTone;
  label: string;
}> = [
  { id: "professional", label: "Professional" },
  { id: "casual", label: "Casual" },
  { id: "confident", label: "Confident" },
  { id: "friendly", label: "Friendly" },
  { id: "concise", label: "Concise" },
  { id: "academic", label: "Academic" },
];

const ACTION_BY_ID: ReadonlyMap<DocumentAiActionId, DocumentAiAction> = new Map(
  DOCUMENT_AI_ACTIONS.map((a) => [a.id, a]),
);

/** Look up an action by id; returns `undefined` for unknown ids. */
export function getDocumentAiAction(
  id: DocumentAiActionId,
): DocumentAiAction | undefined {
  return ACTION_BY_ID.get(id);
}

/**
 * Whether `action` can run given the current selection text. Mirrors
 * `DocumentAiAction.needsSelection` but also treats whitespace-only
 * selections as empty so the toolbar doesn't offer "improve" on a run
 * of spaces.
 */
export function canRunAction(
  id: DocumentAiActionId,
  selection: string,
): boolean {
  const action = ACTION_BY_ID.get(id);
  if (!action) return false;
  if (!action.needsSelection) return true;
  return selection.trim().length > 0;
}

// ─────────────────────────────────────────────────────────────────────
// Prompt assembly
// ─────────────────────────────────────────────────────────────────────

/**
 * Shared system preamble. We keep instructions terse and explicit so
 * small on-device models stay on task: return ONLY the rewritten text
 * (no preamble, no markdown fences, no "Sure, here's…"). The cleaning
 * pass in `cleanModelOutput` is the belt to this braces — but a clear
 * instruction means it rarely has work to do.
 */
const SYSTEM_PREAMBLE =
  "You are a precise writing assistant embedded in a document editor. " +
  "Apply the requested edit and return ONLY the resulting text, with no " +
  "explanations, no preamble, no surrounding quotes, and no markdown code " +
  "fences. Preserve the original meaning and any factual details unless the " +
  "instruction explicitly asks otherwise.";

const TONE_DESCRIPTIONS: Record<DocumentAiTone, string> = {
  professional: "a professional, polished business tone",
  casual: "a casual, conversational tone",
  confident: "a confident, assertive tone",
  friendly: "a warm, friendly tone",
  concise: "a concise, no-filler tone",
  academic: "a formal, academic tone",
};

/** Clamp helper so we never embed an unbounded blob into the prompt. */
function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/**
 * Build the instruction string sent to `model.generate`.
 *
 * The returned prompt is fully self-contained: system preamble +
 * task-specific instruction + the user's text delimited by sentinel
 * lines so the model can tell instruction from content. Pure and
 * deterministic for a given input (no timestamps / randomness) so the
 * test suite can assert exact output.
 */
export function buildAiPrompt(input: DocumentAiPromptInput): string {
  const selection = clampText(input.selection ?? "", 8000);
  const instruction = (input.instruction ?? "").trim();

  let task: string;
  switch (input.action) {
    case "improve":
      task =
        "Improve the writing below. Fix awkward phrasing, tighten wording, " +
        "and improve flow while keeping the original meaning and length " +
        "roughly the same.";
      break;
    case "fix":
      task =
        "Correct spelling, grammar, and punctuation in the text below. Do " +
        "not change the wording or meaning beyond what is needed to fix " +
        "errors.";
      break;
    case "shorter":
      task =
        "Rewrite the text below to be noticeably shorter while preserving " +
        "the key points and meaning.";
      break;
    case "longer":
      task =
        "Expand the text below with more detail, examples, and explanation " +
        "while staying on topic and preserving the original meaning.";
      break;
    case "tone": {
      const tone = input.tone
        ? TONE_DESCRIPTIONS[input.tone]
        : "a clearer tone";
      task = `Rewrite the text below in ${tone}. Keep the meaning intact.`;
      break;
    }
    case "summarize":
      task =
        "Write a brief summary of the text below, capturing only the most " +
        "important points.";
      break;
    case "bullets":
      task =
        "Rewrite the text below as a concise bulleted list. Start each " +
        "bullet with '- ' and put one point per line.";
      break;
    case "translate": {
      const language = (input.language ?? "").trim() || "English";
      task =
        `Translate the text below into ${language}. Return only the ` +
        "translation, preserving formatting and meaning.";
      break;
    }
    case "continue":
      task =
        "Continue writing naturally from where the text below leaves off. " +
        "Match the existing voice, tone, and style. Do not repeat the text " +
        "already written; only add what comes next.";
      break;
    case "custom":
    default:
      task =
        instruction.length > 0
          ? instruction
          : "Help the user write based on the context below.";
      break;
  }

  // Non-custom actions use a fixed task template, but the panel still shows
  // an "Optional: add extra instructions" box for every selection-based
  // action. Fold any text the user typed into the task so it actually
  // influences the output instead of being silently dropped. (For `custom`
  // the instruction already *is* the task, so we don't append it twice.)
  if (input.action !== "custom" && instruction.length > 0) {
    task += ` Additional instruction from the user: ${instruction}`;
  }

  const parts: string[] = [SYSTEM_PREAMBLE, "", task];

  // For a custom instruction that ALSO has a selection, give the model
  // the selection as the working material. For `continue`, prefer the
  // preceding-text window so the model sees upstream context.
  if (input.action === "continue") {
    const preceding = clampText(
      (input.precedingText ?? selection).trim(),
      2000,
    );
    if (preceding.length > 0) {
      parts.push("", "TEXT SO FAR:", preceding);
    }
  } else if (selection.trim().length > 0) {
    parts.push("", "TEXT:", selection);
  }

  // A custom action may carry BOTH an instruction (already used as the
  // task) and a selection (used as TEXT above). Nothing more to add.
  return parts.join("\n");
}

// ─────────────────────────────────────────────────────────────────────
// Output sanitisation
// ─────────────────────────────────────────────────────────────────────

const LEADING_LABEL_RE =
  /^(?:sure|certainly|here(?:'s| is)|of course)[^\n:]*:?\s*/i;

/**
 * Clean a raw model completion into text safe to drop into the
 * document.
 *
 *  - Strips a single wrapping pair of triple-backtick code fences
 *    (models love to wrap prose in ```), preserving the inner text.
 *  - Removes a leading conversational label ("Sure, here's the
 *    rewrite:") that small models sometimes emit despite the system
 *    instruction.
 *  - Strips a single pair of matching wrapping quotes.
 *  - Trims surrounding whitespace.
 *
 * Idempotent: cleaning already-clean text returns it unchanged.
 */
export function cleanModelOutput(raw: string): string {
  let text = (raw ?? "").trim();
  if (text.length === 0) return "";

  // Strip a wrapping ```lang ... ``` fence (with or without a language
  // tag on the opening fence). Only when BOTH fences are present so we
  // don't eat a half-streamed fence mid-generation.
  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Drop a single leading conversational label.
  text = text.replace(LEADING_LABEL_RE, "").trim();

  // Strip one pair of matching wrapping quotes (straight or smart).
  text = stripWrappingQuotes(text);

  return text.trim();
}

function stripWrappingQuotes(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    "\u201c": "\u201d", // “ ”
    "\u2018": "\u2019", // ‘ ’
  };
  if (pairs[first] && pairs[first] === last) {
    const inner = text.slice(1, -1);
    // Only strip if the inner text has no unescaped matching quote of
    // its own (avoids turning `"a" and "b"` into `a" and "b`).
    if (!inner.includes(first) && !inner.includes(last)) {
      return inner;
    }
  }
  return text;
}

/**
 * Split text into bullet lines for the `bullets` action's structured
 * insert. Returns the trimmed, non-empty lines with any leading bullet
 * marker (`- `, `* `, `• `, `1. `) removed so the caller can rebuild
 * them as real list items.
 */
export function parseBulletLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0);
}

/**
 * Convert a cleaned AI result into the HTML the editor should insert.
 *
 *  - `bullets` → a `<ul>` of `<li>`s (one per parsed bullet line).
 *  - everything else → one `<p>` per blank-line-delimited block, with
 *    single newlines becoming `<br>`.
 *
 * All user/model text is HTML-escaped so a model that happens to emit
 * `<script>` can't inject live markup into the document. Returns an
 * empty paragraph for empty input so callers always insert a valid
 * block.
 */
export function aiResultToHtml(
  text: string,
  action: DocumentAiActionId,
): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "<p></p>";

  if (action === "bullets") {
    const items = parseBulletLines(trimmed);
    if (items.length === 0) return "<p></p>";
    return `<ul>${items
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("")}</ul>`;
  }

  const blocks = trimmed.split(/\n{2,}/).filter((b) => b.trim().length > 0);
  if (blocks.length === 0) return "<p></p>";
  return blocks
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

// ─────────────────────────────────────────────────────────────────────
// Word-level diff (preview)
// ─────────────────────────────────────────────────────────────────────

/**
 * Tokenise into words + surrounding whitespace runs so the diff aligns
 * on word boundaries (what a human reads) rather than characters.
 */
function tokenizeForDiff(text: string): string[] {
  // Split keeping the whitespace as its own tokens so reassembling the
  // segments reproduces the original exactly.
  return text.match(/\s+|\S+/g) ?? [];
}

/**
 * Compute a word-level diff between `before` and `after` as a list of
 * contiguous `equal` / `removed` / `added` segments.
 *
 * Uses a classic LCS dynamic-programming table. To keep the editor
 * responsive on large rewrites we cap the token product; beyond the
 * cap we degrade gracefully to a single `removed` + `added` pair
 * (a whole-block replacement preview) rather than spending O(n·m)
 * time/memory. This keeps per-frame work bounded.
 */
export function computeWordDiff(before: string, after: string): DiffSegment[] {
  if (before === after) {
    return before.length > 0 ? [{ kind: "equal", value: before }] : [];
  }
  const a = tokenizeForDiff(before);
  const b = tokenizeForDiff(after);

  if (a.length === 0) {
    return after.length > 0 ? [{ kind: "added", value: after }] : [];
  }
  if (b.length === 0) {
    return before.length > 0 ? [{ kind: "removed", value: before }] : [];
  }

  // Guard against pathological sizes: 1.5M cell table ≈ a few MB and a
  // few ms — beyond that, fall back to a coarse whole-text diff.
  const MAX_PRODUCT = 1_500_000;
  if (a.length * b.length > MAX_PRODUCT) {
    return [
      { kind: "removed", value: before },
      { kind: "added", value: after },
    ];
  }

  const lcs = buildLcsTable(a, b);
  return backtrackDiff(a, b, lcs);
}

function buildLcsTable(a: string[], b: string[]): Uint32Array {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const idx = i * cols + j;
      if (a[i] === b[j]) {
        table[idx] = table[(i + 1) * cols + (j + 1)] + 1;
      } else {
        const down = table[(i + 1) * cols + j];
        const right = table[i * cols + (j + 1)];
        table[idx] = down >= right ? down : right;
      }
    }
  }
  return table;
}

function backtrackDiff(
  a: string[],
  b: string[],
  table: Uint32Array,
): DiffSegment[] {
  const cols = b.length + 1;
  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;

  // Coalesce consecutive tokens of the same kind into one segment so
  // the rendered preview has runs, not per-word spans.
  const push = (kind: DiffSegment["kind"], value: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.value += value;
    else segments.push({ kind, value });
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i++;
      j++;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + (j + 1)]) {
      push("removed", a[i]);
      i++;
    } else {
      push("added", b[j]);
      j++;
    }
  }
  while (i < a.length) {
    push("removed", a[i]);
    i++;
  }
  while (j < b.length) {
    push("added", b[j]);
    j++;
  }
  return segments;
}
