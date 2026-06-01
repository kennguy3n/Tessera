/**
 * auto-fill series detection + cell generation.
 *
 * Given a source array of raw cell strings (the cells the user
 * selected before grabbing the fill handle) and a target length,
 * extrapolate the series and return the values for the new cells.
 *
 * Four detection passes, in order:
 *
 *   1. **Formula** — every source cell starts with `=`. We tokenize
 *      each source formula, then for each target cell shift every
 *      CELL_REF token by the (rowDelta, colDelta) from the source
 *      cell to that target cell. Absolute (`$`) markers freeze their
 *      axis. The result is rebuilt by splicing the shifted ref text
 *      back into the original formula at the token's source position.
 *
 *   2. **Arithmetic progression** — every source cell parses to a
 *      finite number. We compute the step from the last two source
 *      values (or 0 if only one cell) and extrapolate linearly.
 *
 *   3. **ISO date progression** — every source cell parses as an
 *      `YYYY-MM-DD` calendar date. We compute the day-step from the
 *      last two and emit each successor as the same ISO format.
 *
 *   4. **Copy / cycle** — fall through; the source cells are repeated
 *      modulo their length.
 *
 * Pure module — no React, no DOM. All logic is tested with Vitest
 * directly from this file's exports.
 */

import { tokenize, type Token } from "./formulaEngine/tokenizer";

/** Direction the user drags the fill handle. */
export type FillDirection = "down" | "right" | "up" | "left";

/**
 * Extrapolate a `length`-element series from `source` in the given
 * `direction`. The returned array is the full series — i.e. the
 * `length` cells that should populate the *new* range, NOT the
 * `source.length + length` combined sequence.
 *
 * Examples:
 *   fillSeries(["1", "2"], 3, "down") === ["3", "4", "5"]
 *   fillSeries(["=A1+1"], 2, "down")  === ["=A2+1", "=A3+1"]
 *   fillSeries(["foo"], 4, "right")   === ["foo", "foo", "foo", "foo"]
 *   fillSeries(["2024-01-01"], 3, "down") === ["2024-01-02","2024-01-03","2024-01-04"]
 */
export function fillSeries(
  source: string[],
  length: number,
  direction: FillDirection,
): string[] {
  if (length <= 0) return [];
  if (source.length === 0) return new Array(length).fill("");

  // Pass 1: every source cell is a formula.
  if (source.every((s) => s.startsWith("="))) {
    return fillFormulaSeries(source, length, direction);
  }

  // Pass 2: every source cell parses to a finite number.
  const numbers = source.map((s) => {
    const trimmed = s.trim();
    if (trimmed === "") return Number.NaN;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : Number.NaN;
  });
  if (numbers.every((n) => !Number.isNaN(n))) {
    return fillNumericSeries(numbers, length, direction);
  }

  // Pass 3: every source cell is an ISO calendar date.
  const dates = source.map(parseIsoDate);
  if (dates.every((d) => d !== null)) {
    return fillDateSeries(dates as Date[], length, direction);
  }

  // Pass 4: cycle the source values.
  const out: string[] = [];
  for (let i = 0; i < length; i++) out.push(source[i % source.length]);
  return out;
}

// ---------------------------------------------------------------------------
// Formula auto-fill — token-level CELL_REF shifting.
// ---------------------------------------------------------------------------

function fillFormulaSeries(
  source: string[],
  length: number,
  direction: FillDirection,
): string[] {
  const out: string[] = [];
  // Distance (in cells along the fill axis) between source row[k]
  // and the target cell at output index i, when the seed for i is
  // source[i % source.length]. The seed sits at source-row seedIdx
  // (0..source.length-1); the target sits at source-row
  // source.length + i (i.e. immediately past the source range,
  // shifted by i). Hence:
  //
  //   delta = (source.length + i) − seedIdx
  //
  // For a two-cell source [=A1, =B1] filled 4 cells down:
  //   i=0 seedIdx=0 → delta 2 → =A3
  //   i=1 seedIdx=1 → delta 2 → =B3
  //   i=2 seedIdx=0 → delta 4 → =A5
  //   i=3 seedIdx=1 → delta 4 → =B5
  //
  // The earlier (repeat - 1) formulation under-shifted every
  // non-first seed within a repeat group; this is the correct
  // closed-form.
  for (let i = 0; i < length; i++) {
    const seedIdx = i % source.length;
    const seed = source[seedIdx];
    const offset = source.length + i - seedIdx;
    let rowDelta = 0;
    let colDelta = 0;
    if (direction === "down") rowDelta = offset;
    else if (direction === "up") rowDelta = -offset;
    else if (direction === "right") colDelta = offset;
    else colDelta = -offset;
    out.push(shiftFormulaRefs(seed, rowDelta, colDelta));
  }
  return out;
}

/**
 * Re-emit `formula` with every relative-axis component of every
 * CELL_REF token shifted by `(rowDelta, colDelta)`. Absolute
 * markers (`$A$1`, `$A1`, `A$1`) freeze their axis. Tokenize
 * positions are 1-based against the original source (which may
 * include the leading `=`); we splice the replacement text in by
 * (start, end) so any surrounding whitespace or operators are
 * preserved verbatim.
 *
 * Exported for direct unit testing — the higher-level
 * `fillFormulaSeries` is the production entry point.
 */
export function shiftFormulaRefs(
  formula: string,
  rowDelta: number,
  colDelta: number,
): string {
  if (rowDelta === 0 && colDelta === 0) return formula;
  const tokens = tokenize(formula);
  // Splice in reverse so earlier indices stay valid as we patch.
  const refs: Token[] = [];
  for (const t of tokens) if (t.type === "CELL_REF" && t.cellRef) refs.push(t);
  if (refs.length === 0) return formula;
  let out = formula;
  for (let i = refs.length - 1; i >= 0; i--) {
    const t = refs[i];
    const ref = t.cellRef!;
    const newCol = ref.absoluteCol ? ref.col : ref.col + colDelta;
    const newRow = ref.absoluteRow ? ref.row : ref.row + rowDelta;
    if (newCol < 0 || newRow < 0) {
      // Excel emits `#REF!` for out-of-bounds shifts; we encode
      // the same sentinel so the evaluator returns the right
      // error code on read.
      out = out.slice(0, t.start) + "#REF!" + out.slice(t.end);
      continue;
    }
    const text =
      (ref.absoluteCol ? "$" : "") +
      columnLetter(newCol) +
      (ref.absoluteRow ? "$" : "") +
      String(newRow + 1);
    out = out.slice(0, t.start) + text + out.slice(t.end);
  }
  return out;
}

function columnLetter(index: number): string {
  let label = "";
  let n = index;
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

// ---------------------------------------------------------------------------
// Numeric auto-fill — arithmetic progression.
// ---------------------------------------------------------------------------

function fillNumericSeries(
  source: number[],
  length: number,
  direction: FillDirection,
): string[] {
  // Two-or-more-cell selection → step is mean diff between
  // consecutive values (handles non-uniform input by averaging).
  // One-cell selection → step of 1 for forward fill, -1 for back.
  let step: number;
  if (source.length >= 2) {
    let sum = 0;
    for (let i = 1; i < source.length; i++) sum += source[i] - source[i - 1];
    step = sum / (source.length - 1);
  } else {
    step = direction === "up" || direction === "left" ? -1 : 1;
  }
  const last = source[source.length - 1];
  const out: string[] = [];
  for (let i = 1; i <= length; i++) out.push(formatNumber(last + step * i));
  return out;
}

function formatNumber(n: number): string {
  // Avoid trailing `.0` for whole numbers; preserve precision for
  // fractions. `String(0.1+0.2)` returns `"0.30000000000000004"`
  // — accepted for now since we don't ship a number-format engine
  // for fill output (the user formatted the source cells, the
  // displayed format engine handles their cell renders).
  return Number.isInteger(n) ? n.toFixed(0) : String(n);
}

// ---------------------------------------------------------------------------
// Date auto-fill — `YYYY-MM-DD` strings only.
// ---------------------------------------------------------------------------

function parseIsoDate(s: string): Date | null {
  const trimmed = s.trim();
  // Strict YYYY-MM-DD; reject anything that doesn't match.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const [y, m, d] = trimmed.split("-").map(Number);
  const candidate = new Date(Date.UTC(y, m - 1, d));
  if (
    candidate.getUTCFullYear() !== y ||
    candidate.getUTCMonth() !== m - 1 ||
    candidate.getUTCDate() !== d
  ) {
    return null;
  }
  return candidate;
}

function fillDateSeries(
  source: Date[],
  length: number,
  direction: FillDirection,
): string[] {
  const MS_PER_DAY = 86_400_000;
  let stepDays: number;
  if (source.length >= 2) {
    let sum = 0;
    for (let i = 1; i < source.length; i++) {
      sum += (source[i].getTime() - source[i - 1].getTime()) / MS_PER_DAY;
    }
    stepDays = Math.round(sum / (source.length - 1));
  } else {
    stepDays = direction === "up" || direction === "left" ? -1 : 1;
  }
  const last = source[source.length - 1];
  const out: string[] = [];
  for (let i = 1; i <= length; i++) {
    const d = new Date(last.getTime() + stepDays * i * MS_PER_DAY);
    out.push(formatIsoDate(d));
  }
  return out;
}

function formatIsoDate(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
