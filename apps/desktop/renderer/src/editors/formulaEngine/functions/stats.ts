/**
 * statistical functions.
 *
 *   MEDIAN(a, b, …)       Middle value (mean of the two middles when
 *                         the count is even). Strings/blanks in
 *                         ranges are skipped (Excel rule); a literal
 *                         string argument is coerced.
 *   STDEV(a, b, …)        Sample standard deviation (divide by N-1).
 *   STDEVP(a, b, …)       Population std. dev. (divide by N).
 *   VAR(a, b, …)          Sample variance.
 *   PERCENTILE(range, p)  p ∈ [0,1]; linear interpolation between
 *                         sorted samples (Excel's PERCENTILE.INC).
 *   RANK(value, range, [order])
 *                         Rank of `value` in `range`. `order = 0` (or
 *                         omitted) = descending; non-zero = ascending.
 *                         Ties get the same rank, next rank is
 *                         skipped (Excel "competition" ranking).
 *
 * STDEV / VAR return `#DIV/0!` when N<2 (Bessel's correction needs at
 * least two samples); PERCENTILE returns `#NUM!` when the range is
 * empty or `p` is outside `[0,1]`.
 */
import type { AstNode } from "../parser";
import {
  collectValues,
  evaluate,
  isRangeArg,
  toNumber,
  type EvaluationContext,
  type FunctionImpl,
} from "../evaluator";
import {
  isFormulaError,
  makeError,
  type FormulaError,
  type FormulaValue,
} from "../types";

/** Collect every numeric value across `args`, skipping blanks/strings in ranges. */
function collectNumbers(
  args: AstNode[],
  ctx: EvaluationContext,
): number[] | FormulaError {
  const out: number[] = [];
  for (const arg of args) {
    for (const v of collectValues(arg, ctx)) {
      if (isFormulaError(v)) return v;
      if (v === null) continue;
      if (typeof v === "number") {
        out.push(v);
        continue;
      }
      if (typeof v === "boolean") {
        // Direct boolean arg = coerce to 1/0; in a range, Excel skips.
        if (!isRangeArg(arg, ctx)) out.push(v ? 1 : 0);
        continue;
      }
      if (typeof v === "string") {
        if (isRangeArg(arg, ctx)) continue;
        const n = toNumber(v);
        if (isFormulaError(n)) return n;
        out.push(n);
      }
    }
  }
  return out;
}

const MEDIAN: FunctionImpl = (args, ctx) => {
  const xs = collectNumbers(args, ctx);
  if (isFormulaError(xs)) return xs;
  if (xs.length === 0) return makeError("#NUM!", "MEDIAN: empty input");
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = n >> 1;
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
};

function variance(
  args: AstNode[],
  ctx: EvaluationContext,
  population: boolean,
): FormulaValue {
  const xs = collectNumbers(args, ctx);
  if (isFormulaError(xs)) return xs;
  const denom = population ? xs.length : xs.length - 1;
  if (denom <= 0) {
    return makeError("#DIV/0!", "variance requires at least 2 samples");
  }
  const mean = xs.reduce((acc, v) => acc + v, 0) / xs.length;
  let ssq = 0;
  for (const x of xs) {
    const d = x - mean;
    ssq += d * d;
  }
  return ssq / denom;
}

const STDEV: FunctionImpl = (args, ctx) => {
  const v = variance(args, ctx, false);
  if (isFormulaError(v)) return v;
  return Math.sqrt(v as number);
};

const STDEVP: FunctionImpl = (args, ctx) => {
  const v = variance(args, ctx, true);
  if (isFormulaError(v)) return v;
  return Math.sqrt(v as number);
};

const VAR: FunctionImpl = (args, ctx) => variance(args, ctx, false);

const PERCENTILE: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) {
    return makeError("#ERR!", "PERCENTILE expects 2 arguments");
  }
  const xs = collectNumbers([args[0]], ctx);
  if (isFormulaError(xs)) return xs;
  if (xs.length === 0) return makeError("#NUM!", "PERCENTILE: empty range");
  const pV = evaluate(args[1], ctx);
  if (isFormulaError(pV)) return pV;
  const p = toNumber(pV);
  if (isFormulaError(p)) return p;
  if (p < 0 || p > 1)
    return makeError("#NUM!", "PERCENTILE p must be in [0,1]");
  const sorted = [...xs].sort((a, b) => a - b);
  // Excel's PERCENTILE.INC: rank = p * (N-1); interpolate between
  // sorted[floor] and sorted[ceil].
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const frac = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
};

const RANK: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "RANK expects 2 or 3 arguments");
  }
  const vV = evaluate(args[0], ctx);
  if (isFormulaError(vV)) return vV;
  const target = toNumber(vV);
  if (isFormulaError(target)) return target;
  const xs = collectNumbers([args[1]], ctx);
  if (isFormulaError(xs)) return xs;
  let ascending = false;
  if (args.length === 3) {
    const oV = evaluate(args[2], ctx);
    if (isFormulaError(oV)) return oV;
    const o = toNumber(oV);
    if (isFormulaError(o)) return o;
    ascending = o !== 0;
  }
  if (!xs.includes(target)) {
    return makeError("#N/A", "RANK: value not present in range");
  }
  // Competition ranking: count strictly-better values + 1.
  let better = 0;
  for (const x of xs) {
    if (ascending ? x < target : x > target) better++;
  }
  return better + 1;
};

const VARP: FunctionImpl = (args, ctx) => variance(args, ctx, true);

const COUNTBLANK: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) {
    return makeError("#ERR!", "COUNTBLANK expects 1 argument");
  }
  let blanks = 0;
  for (const v of collectValues(args[0], ctx)) {
    if (isFormulaError(v)) return v;
    // Excel counts both truly-empty cells and cells whose value is an
    // empty string as blank.
    if (v === null || v === "") blanks++;
  }
  return blanks;
};

const COUNTUNIQUE: FunctionImpl = (args, ctx) => {
  const seen = new Set<string>();
  for (const arg of args) {
    for (const v of collectValues(arg, ctx)) {
      if (isFormulaError(v)) return v;
      if (v === null) continue;
      // Tag the value with its type so the number 1 and the string
      // "1" are counted as distinct, matching Google Sheets.
      seen.add(
        `${typeof v}:${typeof v === "string" ? v.toLowerCase() : String(v)}`,
      );
    }
  }
  return seen.size;
};

const MODE: FunctionImpl = (args, ctx) => {
  const xs = collectNumbers(args, ctx);
  if (isFormulaError(xs)) return xs;
  if (xs.length === 0) return makeError("#N/A", "MODE: empty input");
  const counts = new Map<number, number>();
  let bestValue = xs[0];
  let bestCount = 0;
  for (const x of xs) {
    const c = (counts.get(x) ?? 0) + 1;
    counts.set(x, c);
    // Prefer the higher count; on a tie keep the value that first
    // reached that count earliest in the data (Excel's behaviour),
    // which falls out of iterating in source order with a strict `>`.
    if (c > bestCount) {
      bestCount = c;
      bestValue = x;
    }
  }
  if (bestCount < 2) return makeError("#N/A", "MODE: no value repeats");
  return bestValue;
};

const LARGE: FunctionImpl = (args, ctx) => nthOrdered(args, ctx, "LARGE");
const SMALL: FunctionImpl = (args, ctx) => nthOrdered(args, ctx, "SMALL");

/** Shared kth-largest / kth-smallest implementation for LARGE / SMALL. */
function nthOrdered(
  args: AstNode[],
  ctx: EvaluationContext,
  which: "LARGE" | "SMALL",
): FormulaValue {
  if (args.length !== 2) {
    return makeError("#ERR!", `${which} expects 2 arguments`);
  }
  const xs = collectNumbers([args[0]], ctx);
  if (isFormulaError(xs)) return xs;
  const kV = evaluate(args[1], ctx);
  if (isFormulaError(kV)) return kV;
  const kNum = toNumber(kV);
  if (isFormulaError(kNum)) return kNum;
  const k = Math.trunc(kNum);
  if (k < 1 || k > xs.length) {
    return makeError("#NUM!", `${which}: k is out of range`);
  }
  const sorted = [...xs].sort((a, b) => (which === "LARGE" ? b - a : a - b));
  return sorted[k - 1];
}

export const STATS_FUNCTIONS: Record<string, FunctionImpl> = {
  MEDIAN,
  STDEV,
  STDEVP,
  VAR,
  VARP,
  PERCENTILE,
  RANK,
  COUNTBLANK,
  COUNTUNIQUE,
  MODE,
  LARGE,
  SMALL,
};
