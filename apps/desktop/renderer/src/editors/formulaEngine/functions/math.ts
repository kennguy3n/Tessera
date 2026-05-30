/**
 * Phase 16 Task 5 — math / aggregation functions.
 *
 * Each function follows Excel/Google-Sheets semantics:
 *
 *   - SUM/AVERAGE/COUNT/COUNTA/MIN/MAX/PRODUCT accept any mix of
 *     literals, single cells, and ranges; ranges are flattened.
 *   - COUNT counts only numeric values (including booleans coerced
 *     to numbers via direct arguments, but NOT via range cells —
 *     matching Excel); COUNTA counts any non-blank value.
 *   - ROUND/ROUNDUP/ROUNDDOWN take `(value, digits)` with `digits`
 *     defaulting to 0 if omitted.
 *   - ABS/CEILING/FLOOR/MOD/POWER/SQRT/INT take their canonical args.
 *   - RAND() is volatile — uses `ctx.random` if provided (tests pin
 *     it) and falls back to `Math.random()` otherwise.
 *
 * Argument-count errors return `#ERR!` with a message; type
 * coercion errors propagate from `toNumber()`.
 */
import type { AstNode } from "../parser";
import {
  collectValues,
  evaluate,
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

/** Iterate every numeric value across the args, skipping blanks/strings. */
function* numericArgs(
  args: AstNode[],
  ctx: EvaluationContext,
  includeBoolean = true,
): Generator<number | FormulaError> {
  for (const arg of args) {
    for (const v of collectValues(arg, ctx)) {
      if (isFormulaError(v)) {
        yield v;
        continue;
      }
      if (v === null) continue;
      if (typeof v === "number") {
        yield v;
        continue;
      }
      if (typeof v === "boolean") {
        if (includeBoolean) yield v ? 1 : 0;
        continue;
      }
      if (typeof v === "string") {
        // Inside aggregation, strings are skipped (Excel ignores
        // text in SUM/AVERAGE over a range).
        if (arg.type === "range") continue;
        const n = toNumber(v);
        if (isFormulaError(n)) {
          yield n;
        } else {
          yield n;
        }
      }
    }
  }
}

function reduceNumbers(
  args: AstNode[],
  ctx: EvaluationContext,
  initial: number,
  reducer: (acc: number, v: number) => number,
): FormulaValue {
  let acc = initial;
  for (const v of numericArgs(args, ctx)) {
    if (isFormulaError(v)) return v;
    acc = reducer(acc, v);
  }
  return acc;
}

const SUM: FunctionImpl = (args, ctx) => reduceNumbers(args, ctx, 0, (a, b) => a + b);

const PRODUCT: FunctionImpl = (args, ctx) => {
  let count = 0;
  let acc = 1;
  for (const v of numericArgs(args, ctx)) {
    if (isFormulaError(v)) return v;
    acc *= v;
    count++;
  }
  return count === 0 ? 0 : acc;
};

const AVERAGE: FunctionImpl = (args, ctx) => {
  let sum = 0;
  let count = 0;
  for (const v of numericArgs(args, ctx)) {
    if (isFormulaError(v)) return v;
    sum += v;
    count++;
  }
  if (count === 0) return makeError("#DIV/0!", "AVERAGE over no numeric values");
  return sum / count;
};

const COUNT: FunctionImpl = (args, ctx) => {
  let count = 0;
  for (const v of numericArgs(args, ctx, false)) {
    if (isFormulaError(v)) continue;
    count++;
  }
  return count;
};

const COUNTA: FunctionImpl = (args, ctx) => {
  let count = 0;
  for (const arg of args) {
    for (const v of collectValues(arg, ctx)) {
      if (v === null) continue;
      if (typeof v === "string" && v === "") continue;
      count++;
    }
  }
  return count;
};

const MIN: FunctionImpl = (args, ctx) => {
  let best: number | null = null;
  for (const v of numericArgs(args, ctx)) {
    if (isFormulaError(v)) return v;
    if (best === null || v < best) best = v;
  }
  return best === null ? 0 : best;
};

const MAX: FunctionImpl = (args, ctx) => {
  let best: number | null = null;
  for (const v of numericArgs(args, ctx)) {
    if (isFormulaError(v)) return v;
    if (best === null || v > best) best = v;
  }
  return best === null ? 0 : best;
};

function singleNumber(arg: AstNode, ctx: EvaluationContext): number | FormulaError {
  const v = evaluate(arg, ctx);
  if (isFormulaError(v)) return v;
  return toNumber(v);
}

function withDigits(
  args: AstNode[],
  ctx: EvaluationContext,
  fn: (value: number, digits: number) => number,
): FormulaValue {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "expected 1 or 2 arguments");
  }
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  let digits = 0;
  if (args.length === 2) {
    const d = singleNumber(args[1], ctx);
    if (isFormulaError(d)) return d;
    digits = Math.trunc(d);
  }
  return fn(v, digits);
}

const ROUND: FunctionImpl = (args, ctx) =>
  withDigits(args, ctx, (v, d) => {
    const factor = Math.pow(10, d);
    return Math.round(v * factor) / factor;
  });

const ROUNDUP: FunctionImpl = (args, ctx) =>
  withDigits(args, ctx, (v, d) => {
    const factor = Math.pow(10, d);
    return (v >= 0 ? Math.ceil(v * factor) : Math.floor(v * factor)) / factor;
  });

const ROUNDDOWN: FunctionImpl = (args, ctx) =>
  withDigits(args, ctx, (v, d) => {
    const factor = Math.pow(10, d);
    return (v >= 0 ? Math.floor(v * factor) : Math.ceil(v * factor)) / factor;
  });

const ABS: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "ABS expects 1 argument");
  const v = singleNumber(args[0], ctx);
  return isFormulaError(v) ? v : Math.abs(v);
};

const CEILING: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "CEILING expects 1 or 2 arguments");
  }
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  let sig = 1;
  if (args.length === 2) {
    const s = singleNumber(args[1], ctx);
    if (isFormulaError(s)) return s;
    sig = s;
  }
  if (sig === 0) return 0;
  return Math.ceil(v / sig) * sig;
};

const FLOOR: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "FLOOR expects 1 or 2 arguments");
  }
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  let sig = 1;
  if (args.length === 2) {
    const s = singleNumber(args[1], ctx);
    if (isFormulaError(s)) return s;
    sig = s;
  }
  if (sig === 0) return 0;
  return Math.floor(v / sig) * sig;
};

const MOD: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "MOD expects 2 arguments");
  const a = singleNumber(args[0], ctx);
  if (isFormulaError(a)) return a;
  const b = singleNumber(args[1], ctx);
  if (isFormulaError(b)) return b;
  if (b === 0) return makeError("#DIV/0!", "MOD by zero");
  // Excel's MOD takes the sign of the divisor (matches the math
  // definition `a - b * INT(a/b)`).
  return a - b * Math.floor(a / b);
};

const POWER: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "POWER expects 2 arguments");
  const a = singleNumber(args[0], ctx);
  if (isFormulaError(a)) return a;
  const b = singleNumber(args[1], ctx);
  if (isFormulaError(b)) return b;
  const r = Math.pow(a, b);
  if (!Number.isFinite(r)) return makeError("#NUM!", "POWER overflow");
  return r;
};

const SQRT: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "SQRT expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  if (v < 0) return makeError("#NUM!", "SQRT of negative number");
  return Math.sqrt(v);
};

const INT: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "INT expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  return Math.floor(v);
};

const RAND: FunctionImpl = (args, ctx) => {
  if (args.length !== 0) return makeError("#ERR!", "RAND expects 0 arguments");
  return (ctx.random ?? Math.random)();
};

export const MATH_FUNCTIONS: Record<string, FunctionImpl> = {
  SUM,
  AVERAGE,
  COUNT,
  COUNTA,
  MIN,
  MAX,
  PRODUCT,
  ROUND,
  ROUNDUP,
  ROUNDDOWN,
  ABS,
  CEILING,
  FLOOR,
  MOD,
  POWER,
  SQRT,
  INT,
  RAND,
};
