/**
 * math / aggregation functions.
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
        // text in SUM/AVERAGE over a range — literal or named).
        if (isRangeArg(arg, ctx)) continue;
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

const RANDBETWEEN: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) {
    return makeError("#ERR!", "RANDBETWEEN expects 2 arguments");
  }
  const lo = singleNumber(args[0], ctx);
  if (isFormulaError(lo)) return lo;
  const hi = singleNumber(args[1], ctx);
  if (isFormulaError(hi)) return hi;
  const low = Math.ceil(lo);
  const high = Math.floor(hi);
  if (low > high) {
    return makeError("#NUM!", "RANDBETWEEN: low must be <= high");
  }
  const r = (ctx.random ?? Math.random)();
  // Inclusive of both endpoints, matching Excel / Google Sheets.
  return low + Math.floor(r * (high - low + 1));
};

const TRUNC: FunctionImpl = (args, ctx) =>
  withDigits(args, ctx, (v, d) => {
    const factor = Math.pow(10, d);
    return Math.trunc(v * factor) / factor;
  });

const SIGN: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "SIGN expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  return Math.sign(v);
};

const EXP: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "EXP expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  const r = Math.exp(v);
  if (!Number.isFinite(r)) return makeError("#NUM!", "EXP overflow");
  return r;
};

const LN: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "LN expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  if (v <= 0) return makeError("#NUM!", "LN requires a positive argument");
  return Math.log(v);
};

const LOG10: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "LOG10 expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  if (v <= 0) return makeError("#NUM!", "LOG10 requires a positive argument");
  return Math.log10(v);
};

const LOG: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "LOG expects 1 or 2 arguments");
  }
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  if (v <= 0) return makeError("#NUM!", "LOG requires a positive argument");
  let base = 10;
  if (args.length === 2) {
    const b = singleNumber(args[1], ctx);
    if (isFormulaError(b)) return b;
    base = b;
  }
  if (base <= 0 || base === 1) {
    return makeError("#NUM!", "LOG base must be positive and != 1");
  }
  return Math.log(v) / Math.log(base);
};

const PI: FunctionImpl = (args) => {
  if (args.length !== 0) return makeError("#ERR!", "PI expects 0 arguments");
  return Math.PI;
};

/** Build a single-argument trig/transform function with a name for diagnostics. */
function unaryMathFn(
  name: string,
  fn: (v: number) => number,
  guard?: (v: number) => boolean,
): FunctionImpl {
  return (args, ctx) => {
    if (args.length !== 1) {
      return makeError("#ERR!", `${name} expects 1 argument`);
    }
    const v = singleNumber(args[0], ctx);
    if (isFormulaError(v)) return v;
    if (guard && !guard(v)) {
      return makeError("#NUM!", `${name}: argument out of domain`);
    }
    const r = fn(v);
    if (!Number.isFinite(r)) return makeError("#NUM!", `${name} overflow`);
    return r;
  };
}

const SIN = unaryMathFn("SIN", Math.sin);
const COS = unaryMathFn("COS", Math.cos);
const TAN = unaryMathFn("TAN", Math.tan);
const ASIN = unaryMathFn("ASIN", Math.asin, (v) => v >= -1 && v <= 1);
const ACOS = unaryMathFn("ACOS", Math.acos, (v) => v >= -1 && v <= 1);
const ATAN = unaryMathFn("ATAN", Math.atan);
const SINH = unaryMathFn("SINH", Math.sinh);
const COSH = unaryMathFn("COSH", Math.cosh);
const TANH = unaryMathFn("TANH", Math.tanh);
const RADIANS = unaryMathFn("RADIANS", (v) => (v * Math.PI) / 180);
const DEGREES = unaryMathFn("DEGREES", (v) => (v * 180) / Math.PI);

const ATAN2: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "ATAN2 expects 2 arguments");
  // Excel orders the arguments (x, y) — the opposite of Math.atan2.
  const x = singleNumber(args[0], ctx);
  if (isFormulaError(x)) return x;
  const y = singleNumber(args[1], ctx);
  if (isFormulaError(y)) return y;
  if (x === 0 && y === 0) return makeError("#DIV/0!", "ATAN2(0, 0) undefined");
  return Math.atan2(y, x);
};

const EVEN: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "EVEN expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  // Round away from zero to the nearest even integer.
  const ceil = v >= 0 ? Math.ceil(v) : Math.floor(v);
  return ceil % 2 === 0 ? ceil : ceil + Math.sign(ceil || 1);
};

const ODD: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "ODD expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  if (v === 0) return 1;
  const ceil = v >= 0 ? Math.ceil(v) : Math.floor(v);
  return Math.abs(ceil) % 2 === 1 ? ceil : ceil + Math.sign(ceil);
};

const MROUND: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "MROUND expects 2 arguments");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  const factor = singleNumber(args[1], ctx);
  if (isFormulaError(factor)) return factor;
  if (factor === 0) return 0;
  if (Math.sign(v) !== Math.sign(factor) && v !== 0) {
    return makeError("#NUM!", "MROUND: value and multiple must share a sign");
  }
  return Math.round(v / factor) * factor;
};

const QUOTIENT: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "QUOTIENT expects 2 arguments");
  const a = singleNumber(args[0], ctx);
  if (isFormulaError(a)) return a;
  const b = singleNumber(args[1], ctx);
  if (isFormulaError(b)) return b;
  if (b === 0) return makeError("#DIV/0!", "QUOTIENT by zero");
  return Math.trunc(a / b);
};

const FACT: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "FACT expects 1 argument");
  const v = singleNumber(args[0], ctx);
  if (isFormulaError(v)) return v;
  const n = Math.trunc(v);
  if (n < 0) return makeError("#NUM!", "FACT requires a non-negative argument");
  if (n > 170) return makeError("#NUM!", "FACT overflow (n > 170)");
  let acc = 1;
  for (let i = 2; i <= n; i++) acc *= i;
  return acc;
};

const COMBIN: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "COMBIN expects 2 arguments");
  const nV = singleNumber(args[0], ctx);
  if (isFormulaError(nV)) return nV;
  const kV = singleNumber(args[1], ctx);
  if (isFormulaError(kV)) return kV;
  const n = Math.trunc(nV);
  const k = Math.trunc(kV);
  if (n < 0 || k < 0 || k > n) {
    return makeError("#NUM!", "COMBIN requires 0 <= k <= n");
  }
  // Multiplicative formula, kept numerically stable by dividing as we
  // go and using the smaller of k / (n-k).
  const kk = Math.min(k, n - k);
  let acc = 1;
  for (let i = 1; i <= kk; i++) {
    acc = (acc * (n - kk + i)) / i;
  }
  const r = Math.round(acc);
  if (!Number.isFinite(r)) return makeError("#NUM!", "COMBIN overflow");
  return r;
};

const GCD: FunctionImpl = (args, ctx) => {
  let acc = 0;
  for (const v of numericArgs(args, ctx, false)) {
    if (isFormulaError(v)) return v;
    // Excel rejects negative arguments outright (validate the raw
    // value, before truncation, so the check is meaningful).
    if (v < 0) return makeError("#NUM!", "GCD requires non-negative integers");
    acc = gcd2(acc, Math.trunc(v));
  }
  return acc;
};

const LCM: FunctionImpl = (args, ctx) => {
  let acc = 1;
  let seen = false;
  for (const v of numericArgs(args, ctx, false)) {
    if (isFormulaError(v)) return v;
    const n = Math.trunc(Math.abs(v));
    if (n === 0) return 0;
    acc = (acc / gcd2(acc, n)) * n;
    seen = true;
  }
  return seen ? acc : 0;
};

function gcd2(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

const SUMSQ: FunctionImpl = (args, ctx) =>
  reduceNumbers(args, ctx, 0, (acc, v) => acc + v * v);

/**
 * SUMPRODUCT(array1, [array2], ...) — multiply corresponding elements
 * across equally-shaped ranges/arrays and sum the products. With a
 * single array it degenerates to a plain sum of that array. Mirrors
 * Excel: non-numeric cells contribute `0`, and a shape mismatch
 * across arrays returns `#VALUE!`.
 */
const SUMPRODUCT: FunctionImpl = (args, ctx) => {
  if (args.length === 0) {
    return makeError("#ERR!", "SUMPRODUCT expects at least 1 argument");
  }
  const columns: number[][] = [];
  for (const arg of args) {
    const col: number[] = [];
    for (const v of collectValues(arg, ctx)) {
      if (isFormulaError(v)) return v;
      if (typeof v === "number") col.push(v);
      else if (typeof v === "boolean") col.push(v ? 1 : 0);
      else col.push(0); // blanks / text contribute 0, matching Excel
    }
    columns.push(col);
  }
  const len = columns[0].length;
  for (const col of columns) {
    if (col.length !== len) {
      return makeError("#VALUE!", "SUMPRODUCT: arrays must be the same size");
    }
  }
  let total = 0;
  for (let i = 0; i < len; i++) {
    let product = 1;
    for (const col of columns) product *= col[i];
    total += product;
  }
  return total;
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
  TRUNC,
  ABS,
  SIGN,
  CEILING,
  FLOOR,
  MOD,
  POWER,
  SQRT,
  INT,
  RAND,
  RANDBETWEEN,
  EXP,
  LN,
  LOG,
  LOG10,
  PI,
  SIN,
  COS,
  TAN,
  ASIN,
  ACOS,
  ATAN,
  ATAN2,
  SINH,
  COSH,
  TANH,
  RADIANS,
  DEGREES,
  EVEN,
  ODD,
  MROUND,
  QUOTIENT,
  FACT,
  COMBIN,
  GCD,
  LCM,
  SUMSQ,
  SUMPRODUCT,
};
