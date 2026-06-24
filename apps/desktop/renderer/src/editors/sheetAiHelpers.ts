/**
 * Pure helpers for the Sheet editor's on-device AI assistant.
 *
 * Everything here is side-effect-free so it can be unit-tested in
 * isolation and reused by the panel component. The assistant runs
 * ENTIRELY on the local model surface (`window.tessera.model.generate`);
 * this module only builds the prompts that are sent to that on-device
 * model and parses/validates what comes back. No network calls, no
 * third-party transmission of sheet content.
 *
 * The two security-critical guarantees, both enforced here:
 *   1. We never send more than a bounded, sampled slice of the sheet to
 *      the model (`MAX_SAMPLE_ROWS` × `MAX_CELL_CHARS`), so a giant
 *      sheet can't blow up the prompt or leak the entire dataset into
 *      a log.
 *   2. A model-generated formula is ALWAYS parsed + validated
 *      (`validateGeneratedFormula`) before the caller is allowed to
 *      insert it — the assistant can never blind-write an unparseable
 *      or malicious string into a cell.
 */
import { parseFormula } from "./formulaEngine";

/** The kinds of assistance the panel offers. */
export type SheetAiAction = "generate" | "explain" | "fix" | "summarize";

/**
 * Grounding context handed to the prompt builders. Deliberately small:
 * column headers, the current selection, and a bounded sample of rows.
 */
export interface SheetAiContext {
  /** A1-style column header labels (`A`, `B`, …) or user headers. */
  columns: string[];
  /** A1 reference of the active cell, e.g. `"B5"`. */
  activeCellRef?: string;
  /** A1 reference of the current selection, e.g. `"A1:C10"`. */
  selectionRef?: string;
  /**
   * A bounded sample of the sheet's rows (already sliced by the
   * caller, but re-bounded here defensively). Used to ground the model
   * so it references real columns/values.
   */
  sampleRows: string[][];
}

/** Hard caps so the prompt stays bounded regardless of sheet size. */
export const MAX_SAMPLE_ROWS = 20;
export const MAX_SAMPLE_COLS = 26;
export const MAX_CELL_CHARS = 64;

/** Truncate a cell's text so one huge cell can't dominate the prompt. */
function clampCell(text: string | undefined): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= MAX_CELL_CHARS) return s;
  return s.slice(0, MAX_CELL_CHARS - 1) + "…";
}

/**
 * Render the grounding sample as a compact, bounded table the model can
 * read. Columns are labelled with both their letter and (when present)
 * the header text from row 0.
 */
export function renderContextTable(ctx: SheetAiContext): string {
  const colCount = Math.min(ctx.columns.length, MAX_SAMPLE_COLS);
  if (colCount === 0) return "(empty sheet)";
  const header = ctx.columns
    .slice(0, colCount)
    .map(
      (label, i) =>
        `${columnLetter(i)}${label ? ` (${clampCell(label)})` : ""}`,
    )
    .join(" | ");
  const rows = ctx.sampleRows.slice(0, MAX_SAMPLE_ROWS).map((row, r) => {
    const cells = [];
    for (let c = 0; c < colCount; c++) cells.push(clampCell(row[c]));
    return `${r + 1}: ${cells.join(" | ")}`;
  });
  return [`Columns: ${header}`, ...rows].join("\n");
}

/** Zero-based column index → spreadsheet letter (`0`→`A`, `27`→`AB`). */
export function columnLetter(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

const FORMULA_RULES = [
  "Rules:",
  "- Output ONLY the formula on a single line, beginning with '='.",
  "- Do NOT wrap it in backticks, code fences, or prose.",
  "- Use A1-style references (e.g. B2, C2:C100) and the functions a",
  "  spreadsheet supports (SUM, SUMIF, AVERAGEIF, COUNTIF, IF, IFS,",
  "  VLOOKUP, XLOOKUP, INDEX, MATCH, TEXT, DATE, etc.).",
  "- If the request cannot be expressed as a formula, output exactly",
  "  '#UNSUPPORTED'.",
].join("\n");

/**
 * Build the natural-language → formula prompt. The model is instructed
 * to emit a single bare formula so {@link extractFormula} can recover
 * it deterministically.
 */
export function buildFormulaPrompt(
  request: string,
  ctx: SheetAiContext,
): string {
  const where = ctx.activeCellRef
    ? `The formula will be placed in cell ${ctx.activeCellRef}.`
    : "";
  return [
    "You are a spreadsheet formula generator.",
    "Given the sheet below and a request, produce ONE spreadsheet formula.",
    "",
    renderContextTable(ctx),
    "",
    where,
    `Request: ${request.trim()}`,
    "",
    FORMULA_RULES,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** Build the explain-this-formula prompt. */
export function buildExplainPrompt(formula: string): string {
  return [
    "Explain what the following spreadsheet formula does, in plain",
    "English, for a non-technical user. Be concise (2-4 sentences).",
    "Describe the result, not a step-by-step token walk-through.",
    "",
    `Formula: ${ensureLeadingEquals(formula)}`,
  ].join("\n");
}

/**
 * Build the fix/optimize-formula prompt. When a known error code is
 * supplied it is included so the model can target the specific fault.
 */
export function buildFixPrompt(formula: string, errorCode?: string): string {
  const errLine = errorCode
    ? `It currently returns the error ${errorCode}.`
    : "It is not behaving as intended.";
  return [
    "The following spreadsheet formula needs fixing or simplifying.",
    errLine,
    "Return a corrected formula.",
    "",
    `Formula: ${ensureLeadingEquals(formula)}`,
    "",
    FORMULA_RULES,
  ].join("\n");
}

/** Build a summarize-this-range prompt (free-text answer, not a formula). */
export function buildSummarizePrompt(ctx: SheetAiContext): string {
  const scope = ctx.selectionRef ? `range ${ctx.selectionRef}` : "the data";
  return [
    `Summarize ${scope} below in 2-4 sentences. Note any obvious`,
    "trends, totals, or outliers a user would care about. Do not",
    "invent values that are not present.",
    "",
    renderContextTable(ctx),
  ].join("\n");
}

/** Prepend `=` if the string doesn't already start with one. */
export function ensureLeadingEquals(formula: string): string {
  const t = formula.trim();
  return t.startsWith("=") ? t : `=${t}`;
}

/**
 * Recover a single formula from raw model output. Handles the common
 * ways a model decorates its answer:
 *   - fenced code blocks (```…```), with or without a language tag,
 *   - leading prose before the formula,
 *   - a bare expression with no leading `=`.
 *
 * Returns the formula string (guaranteed to start with `=`) or `null`
 * when the model declined (`#UNSUPPORTED`) or produced nothing usable.
 */
export function extractFormula(modelOutput: string): string | null {
  let text = modelOutput.trim();
  if (text === "" || text.includes("#UNSUPPORTED")) return null;

  // Strip a single fenced code block if the whole answer is wrapped in
  // one; otherwise just remove stray fence lines.
  const fenceMatch = text.match(/```[a-zA-Z]*\n?([\s\S]*?)```/);
  if (fenceMatch) text = fenceMatch[1].trim();
  text = text.replace(/```/g, "").trim();

  // Prefer the first line that begins with '=' (the instructed shape).
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("=")) return line;
  }

  // Fall back to a single-line answer that is plausibly an expression.
  const firstLine = text.split(/\r?\n/)[0]?.trim() ?? "";
  if (firstLine === "") return null;
  // Reject answers that are clearly prose (contain sentence
  // punctuation followed by a space) rather than an expression.
  if (/[.;:]\s/.test(firstLine)) return null;
  return ensureLeadingEquals(firstLine);
}

/** Result of validating a model-generated formula. */
export type FormulaValidation =
  | { ok: true; formula: string }
  | { ok: false; error: string };

/**
 * Parse + validate a candidate formula before it is allowed anywhere
 * near a cell. This is the single chokepoint that enforces the
 * "never blind-insert" rule: the panel calls this and only offers an
 * Insert action when it returns `ok`.
 */
export function validateGeneratedFormula(candidate: string): FormulaValidation {
  const formula = ensureLeadingEquals(candidate);
  const parsed = parseFormula(formula);
  if (!parsed.ok) {
    return { ok: false, error: `${parsed.code}: ${parsed.message}` };
  }
  return { ok: true, formula };
}

/**
 * Build the bounded grounding context from the full sheet. Caller
 * passes the raw grid; we slice it to the configured caps so neither
 * the prompt nor any log can carry the entire dataset.
 */
export function buildContext(
  columns: string[],
  rows: string[][],
  opts: { activeCellRef?: string; selectionRef?: string } = {},
): SheetAiContext {
  return {
    columns,
    activeCellRef: opts.activeCellRef,
    selectionRef: opts.selectionRef,
    sampleRows: rows
      .slice(0, MAX_SAMPLE_ROWS)
      .map((r) => r.slice(0, MAX_SAMPLE_COLS)),
  };
}
