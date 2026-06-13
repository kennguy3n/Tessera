/**
 * financial functions.
 *
 * A self-contained, dependency-free implementation of the time-value-of-money,
 * cash-flow, and depreciation functions that finance-literate spreadsheet
 * users expect from Excel / Google Sheets. Every function follows the same
 * sign convention as Excel: money you *pay out* is negative and money you
 * *receive* is positive, so a loan's present value is positive while its
 * payment comes back negative.
 *
 * The closed-form TVM relations all derive from a single annuity equation
 * (`type` = 0 → payment at period end, `type` = 1 → payment at period start):
 *
 *     pv·(1+rate)^nper
 *       + pmt·(1 + rate·type)·((1+rate)^nper − 1) / rate
 *       + fv = 0
 *
 * with the `rate = 0` degenerate case (`pv + pmt·nper + fv = 0`) handled
 * separately to avoid a divide-by-zero. The amortisation helpers (`IPMT`,
 * `PPMT`, `CUMIPMT`, `CUMPRINC`) and the rate-solvers (`RATE`, `IRR`, `XIRR`)
 * are built on top of those primitives and mirror numpy-financial / Excel
 * results to within floating-point tolerance.
 *
 * Iterative solvers (`RATE`, `IRR`, `XIRR`) use Newton–Raphson seeded from a
 * caller-supplied (or default `0.1`) guess and fall back to bisection over a
 * wide bracket when the derivative misbehaves, returning `#NUM!` only when no
 * root can be found — never an infinite loop or a `NaN` leaking into the grid.
 */
import type { AstNode } from "../parser";
import {
  collectValues,
  evaluate,
  toNumber,
  type EvaluationContext,
  type FunctionImpl,
} from "../evaluator";
import { isFormulaError, makeError, type FormulaError } from "../types";

/** `0` (end of period) or `1` (start of period); anything else is `#NUM!`. */
type When = 0 | 1;

/** Evaluate a single AST argument down to a finite number. */
function num(arg: AstNode, ctx: EvaluationContext): number | FormulaError {
  const v = evaluate(arg, ctx);
  if (isFormulaError(v)) return v;
  return toNumber(v);
}

/**
 * Evaluate an optional argument, returning `fallback` when it is absent.
 * Used for Excel's trailing optional parameters (`fv`, `type`, `guess`, …).
 */
function optNum(
  args: AstNode[],
  index: number,
  ctx: EvaluationContext,
  fallback: number,
): number | FormulaError {
  if (index >= args.length) return fallback;
  return num(args[index], ctx);
}

/**
 * Surface a non-finite computation (`NaN` / `±Infinity`) as `#NUM!` instead of
 * letting it leak into the grid. Several closed-form relations here evaluate
 * `Math.pow(1 + rate, nper)`, which is `NaN` when `1 + rate < 0` and `nper` is
 * non-integer (e.g. `FV(-1.5, 2.5, 100)`), or divide by zero at degenerate
 * inputs (`NPER` when its ratio is `0/0`). Routing every function's result
 * through this single choke point (see {@link FINANCIAL_FUNCTIONS}) keeps the
 * module's documented "never leak NaN/Infinity" contract true for all 19
 * functions and any future arithmetic, rather than scattering ad-hoc guards.
 * Errors, strings, booleans and blanks pass through untouched.
 */
function guardFinite(label: string, fn: FunctionImpl): FunctionImpl {
  return (args, ctx) => {
    const result = fn(args, ctx);
    if (typeof result === "number" && !Number.isFinite(result)) {
      return makeError("#NUM!", `${label}: result is not a finite number`);
    }
    return result;
  };
}

/** Validate and narrow a raw `type`/`when` value to `0 | 1`. */
function toWhen(value: number, label: string): When | FormulaError {
  const t = Math.trunc(value);
  if (t !== 0 && t !== 1) {
    return makeError("#NUM!", `${label}: type must be 0 or 1`);
  }
  return t;
}

/**
 * Future value of an annuity after `nper` periods — the engine shared by
 * `FV`, `IPMT`, and `PPMT`. Not exported as a formula; it is the closed-form
 * solution of the annuity equation for `fv`.
 */
function fvOf(
  rate: number,
  nper: number,
  pmt: number,
  pv: number,
  when: When,
): number {
  if (rate === 0) return -(pv + pmt * nper);
  const pow = Math.pow(1 + rate, nper);
  return -(pv * pow + (pmt * (1 + rate * when) * (pow - 1)) / rate);
}

/** Closed-form payment per period (shared by PMT / IPMT / PPMT / CUM*). */
function pmtOf(
  rate: number,
  nper: number,
  pv: number,
  fv: number,
  when: When,
): number {
  if (rate === 0) return -(fv + pv) / nper;
  const pow = Math.pow(1 + rate, nper);
  const factor = ((1 + rate * when) * (pow - 1)) / rate;
  return -(fv + pv * pow) / factor;
}

const PMT: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 5) {
    return makeError("#ERR!", "PMT expects 3 to 5 arguments");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  const nper = num(args[1], ctx);
  if (isFormulaError(nper)) return nper;
  const pv = num(args[2], ctx);
  if (isFormulaError(pv)) return pv;
  const fv = optNum(args, 3, ctx, 0);
  if (isFormulaError(fv)) return fv;
  const typeRaw = optNum(args, 4, ctx, 0);
  if (isFormulaError(typeRaw)) return typeRaw;
  const when = toWhen(typeRaw, "PMT");
  if (isFormulaError(when)) return when;
  if (nper === 0) return makeError("#NUM!", "PMT: nper must be non-zero");
  return pmtOf(rate, nper, pv, fv, when);
};

const FV: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 5) {
    return makeError("#ERR!", "FV expects 3 to 5 arguments");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  const nper = num(args[1], ctx);
  if (isFormulaError(nper)) return nper;
  const pmt = num(args[2], ctx);
  if (isFormulaError(pmt)) return pmt;
  const pv = optNum(args, 3, ctx, 0);
  if (isFormulaError(pv)) return pv;
  const typeRaw = optNum(args, 4, ctx, 0);
  if (isFormulaError(typeRaw)) return typeRaw;
  const when = toWhen(typeRaw, "FV");
  if (isFormulaError(when)) return when;
  return fvOf(rate, nper, pmt, pv, when);
};

const PV: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 5) {
    return makeError("#ERR!", "PV expects 3 to 5 arguments");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  const nper = num(args[1], ctx);
  if (isFormulaError(nper)) return nper;
  const pmt = num(args[2], ctx);
  if (isFormulaError(pmt)) return pmt;
  const fv = optNum(args, 3, ctx, 0);
  if (isFormulaError(fv)) return fv;
  const typeRaw = optNum(args, 4, ctx, 0);
  if (isFormulaError(typeRaw)) return typeRaw;
  const when = toWhen(typeRaw, "PV");
  if (isFormulaError(when)) return when;
  if (rate === 0) return -(fv + pmt * nper);
  const pow = Math.pow(1 + rate, nper);
  return -(fv + pmt * (1 + rate * when) * ((pow - 1) / rate)) / pow;
};

const NPER: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 5) {
    return makeError("#ERR!", "NPER expects 3 to 5 arguments");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  const pmt = num(args[1], ctx);
  if (isFormulaError(pmt)) return pmt;
  const pv = num(args[2], ctx);
  if (isFormulaError(pv)) return pv;
  const fv = optNum(args, 3, ctx, 0);
  if (isFormulaError(fv)) return fv;
  const typeRaw = optNum(args, 4, ctx, 0);
  if (isFormulaError(typeRaw)) return typeRaw;
  const when = toWhen(typeRaw, "NPER");
  if (isFormulaError(when)) return when;
  if (rate === 0) {
    if (pmt === 0) return makeError("#NUM!", "NPER: pmt must be non-zero");
    return -(pv + fv) / pmt;
  }
  const z = pmt * (1 + rate * when);
  const num1 = z - fv * rate;
  const den = z + pv * rate;
  // `num1 / den` can be `0/0` (→ NaN) or `x/0` (→ ±Infinity) at degenerate
  // terms; `NaN <= 0` / `Infinity <= 0` are both `false`, so guard finiteness
  // explicitly before taking the log of a non-positive / non-finite ratio.
  const ratio = num1 / den;
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return makeError("#NUM!", "NPER: no solution for these terms");
  }
  return Math.log(ratio) / Math.log(1 + rate);
};

/** Interest portion of the payment in period `per` (numpy-financial parity). */
function ipmtValue(
  rate: number,
  per: number,
  nper: number,
  pv: number,
  fv: number,
  when: When,
): number {
  const total = pmtOf(rate, nper, pv, fv, when);
  let ip = fvOf(rate, per - 1, total, pv, when) * rate;
  if (when === 1) {
    if (per === 1) return 0;
    ip /= 1 + rate;
  }
  return ip;
}

const IPMT: FunctionImpl = (args, ctx) => {
  if (args.length < 4 || args.length > 6) {
    return makeError("#ERR!", "IPMT expects 4 to 6 arguments");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  const per = num(args[1], ctx);
  if (isFormulaError(per)) return per;
  const nper = num(args[2], ctx);
  if (isFormulaError(nper)) return nper;
  const pv = num(args[3], ctx);
  if (isFormulaError(pv)) return pv;
  const fv = optNum(args, 4, ctx, 0);
  if (isFormulaError(fv)) return fv;
  const typeRaw = optNum(args, 5, ctx, 0);
  if (isFormulaError(typeRaw)) return typeRaw;
  const when = toWhen(typeRaw, "IPMT");
  if (isFormulaError(when)) return when;
  if (per < 1 || per > nper) {
    return makeError("#NUM!", "IPMT: per must be between 1 and nper");
  }
  return ipmtValue(rate, per, nper, pv, fv, when);
};

const PPMT: FunctionImpl = (args, ctx) => {
  if (args.length < 4 || args.length > 6) {
    return makeError("#ERR!", "PPMT expects 4 to 6 arguments");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  const per = num(args[1], ctx);
  if (isFormulaError(per)) return per;
  const nper = num(args[2], ctx);
  if (isFormulaError(nper)) return nper;
  const pv = num(args[3], ctx);
  if (isFormulaError(pv)) return pv;
  const fv = optNum(args, 4, ctx, 0);
  if (isFormulaError(fv)) return fv;
  const typeRaw = optNum(args, 5, ctx, 0);
  if (isFormulaError(typeRaw)) return typeRaw;
  const when = toWhen(typeRaw, "PPMT");
  if (isFormulaError(when)) return when;
  if (per < 1 || per > nper) {
    return makeError("#NUM!", "PPMT: per must be between 1 and nper");
  }
  const total = pmtOf(rate, nper, pv, fv, when);
  return total - ipmtValue(rate, per, nper, pv, fv, when);
};

/** Shared validation + summation for CUMIPMT / CUMPRINC. */
function cumulative(
  args: AstNode[],
  ctx: EvaluationContext,
  label: string,
  pick: (
    rate: number,
    per: number,
    nper: number,
    pv: number,
    when: When,
  ) => number,
): number | FormulaError {
  if (args.length !== 6) {
    return makeError("#ERR!", `${label} expects 6 arguments`);
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  const nper = num(args[1], ctx);
  if (isFormulaError(nper)) return nper;
  const pv = num(args[2], ctx);
  if (isFormulaError(pv)) return pv;
  const start = num(args[3], ctx);
  if (isFormulaError(start)) return start;
  const end = num(args[4], ctx);
  if (isFormulaError(end)) return end;
  const typeRaw = num(args[5], ctx);
  if (isFormulaError(typeRaw)) return typeRaw;
  const when = toWhen(typeRaw, label);
  if (isFormulaError(when)) return when;
  if (rate <= 0 || nper <= 0 || pv <= 0) {
    return makeError("#NUM!", `${label}: rate, nper and pv must be positive`);
  }
  const s = Math.trunc(start);
  const e = Math.trunc(end);
  if (s < 1 || e < s || e > nper) {
    return makeError("#NUM!", `${label}: invalid start/end period`);
  }
  let sum = 0;
  for (let per = s; per <= e; per++) sum += pick(rate, per, nper, pv, when);
  return sum;
}

const CUMIPMT: FunctionImpl = (args, ctx) =>
  cumulative(args, ctx, "CUMIPMT", (rate, per, nper, pv, when) =>
    ipmtValue(rate, per, nper, pv, 0, when),
  );

const CUMPRINC: FunctionImpl = (args, ctx) =>
  cumulative(args, ctx, "CUMPRINC", (rate, per, nper, pv, when) => {
    const total = pmtOf(rate, nper, pv, 0, when);
    return total - ipmtValue(rate, per, nper, pv, 0, when);
  });

/** Flatten every numeric value across the args, skipping blanks/text. */
function collectNumbers(
  args: AstNode[],
  ctx: EvaluationContext,
): number[] | FormulaError {
  const out: number[] = [];
  for (const arg of args) {
    for (const v of collectValues(arg, ctx)) {
      if (isFormulaError(v)) return v;
      if (typeof v === "number") out.push(v);
      else if (typeof v === "boolean") out.push(v ? 1 : 0);
      // blanks / text are ignored, matching Excel's NPV/IRR over references
    }
  }
  return out;
}

const NPV: FunctionImpl = (args, ctx) => {
  if (args.length < 2) {
    return makeError("#ERR!", "NPV expects a rate and at least one value");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  if (rate === -1) return makeError("#DIV/0!", "NPV: rate cannot be -100%");
  const flows = collectNumbers(args.slice(1), ctx);
  if (isFormulaError(flows)) return flows;
  let total = 0;
  for (let i = 0; i < flows.length; i++) {
    total += flows[i] / Math.pow(1 + rate, i + 1);
  }
  return total;
};

/** Periodic NPV with the first cash flow at period 0 (used by IRR). */
function npvAtPeriodZero(rate: number, flows: number[]): number {
  let total = 0;
  for (let i = 0; i < flows.length; i++) {
    total += flows[i] / Math.pow(1 + rate, i);
  }
  return total;
}

/**
 * Solve `f(rate) = 0` for an internal rate of return. Newton–Raphson from
 * `guess`, falling back to bisection across `[-0.999999, 10]` when Newton
 * stalls (flat derivative or divergence). Returns `null` when no sign change
 * brackets a root so callers can surface `#NUM!`.
 */
function solveRate(
  f: (rate: number) => number,
  guess: number,
): number | null {
  const MAX_ITER = 100;
  const TOL = 1e-7;
  let rate = guess;
  for (let i = 0; i < MAX_ITER; i++) {
    const y = f(rate);
    if (!Number.isFinite(y)) break;
    if (Math.abs(y) < TOL) return rate;
    const h = 1e-6;
    const dy = (f(rate + h) - f(rate - h)) / (2 * h);
    if (!Number.isFinite(dy) || dy === 0) break;
    const next = rate - y / dy;
    if (!Number.isFinite(next)) break;
    if (Math.abs(next - rate) < TOL) return next;
    rate = next;
  }
  // Bisection fallback over a wide, economically sensible bracket. Stretch the
  // bracket to also contain a caller-supplied guess that sits outside the
  // default `[-0.999999, 10]` window, so an unusual `guess` (e.g. a >1000%
  // expected return) still benefits from the fallback search rather than only
  // seeding Newton.
  let lo = Math.min(-0.999999, guess);
  let hi = Math.max(10, guess);
  // Never cross the `rate = -1` pole, where every discount factor diverges.
  if (lo <= -1) lo = -0.999999;
  let flo = f(lo);
  let fhi = f(hi);
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) {
    return null;
  }
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fmid = f(mid);
    if (!Number.isFinite(fmid)) return null;
    if (Math.abs(fmid) < TOL || (hi - lo) / 2 < TOL) return mid;
    if (flo * fmid < 0) {
      hi = mid;
      fhi = fmid;
    } else {
      lo = mid;
      flo = fmid;
    }
  }
  return (lo + hi) / 2;
}

const IRR: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "IRR expects 1 or 2 arguments");
  }
  const flows = collectNumbers([args[0]], ctx);
  if (isFormulaError(flows)) return flows;
  if (flows.length < 2) {
    return makeError("#NUM!", "IRR needs at least two cash flows");
  }
  const hasPos = flows.some((f) => f > 0);
  const hasNeg = flows.some((f) => f < 0);
  if (!hasPos || !hasNeg) {
    return makeError("#NUM!", "IRR needs at least one positive and one negative cash flow");
  }
  const guess = optNum(args, 1, ctx, 0.1);
  if (isFormulaError(guess)) return guess;
  const root = solveRate((r) => npvAtPeriodZero(r, flows), guess);
  if (root === null) return makeError("#NUM!", "IRR did not converge");
  return root;
};

const MIRR: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) {
    return makeError("#ERR!", "MIRR expects 3 arguments");
  }
  const flows = collectNumbers([args[0]], ctx);
  if (isFormulaError(flows)) return flows;
  const financeRate = num(args[1], ctx);
  if (isFormulaError(financeRate)) return financeRate;
  const reinvestRate = num(args[2], ctx);
  if (isFormulaError(reinvestRate)) return reinvestRate;
  const n = flows.length;
  if (n < 2) return makeError("#NUM!", "MIRR needs at least two cash flows");
  let pvNeg = 0;
  let fvPos = 0;
  for (let i = 0; i < n; i++) {
    if (flows[i] < 0) pvNeg += flows[i] / Math.pow(1 + financeRate, i);
    else fvPos += flows[i] * Math.pow(1 + reinvestRate, n - 1 - i);
  }
  if (pvNeg === 0 || fvPos === 0) {
    return makeError("#DIV/0!", "MIRR needs both positive and negative flows");
  }
  return Math.pow(-fvPos / pvNeg, 1 / (n - 1)) - 1;
};

/** Read parallel value/date arrays for XNPV / XIRR. */
function readDatedFlows(
  valuesArg: AstNode,
  datesArg: AstNode,
  ctx: EvaluationContext,
  label: string,
): { values: number[]; dates: number[] } | FormulaError {
  const values = collectNumbers([valuesArg], ctx);
  if (isFormulaError(values)) return values;
  const dates = collectNumbers([datesArg], ctx);
  if (isFormulaError(dates)) return dates;
  if (values.length !== dates.length) {
    return makeError("#NUM!", `${label}: values and dates must be the same size`);
  }
  if (values.length < 2) {
    return makeError("#NUM!", `${label} needs at least two cash flows`);
  }
  return { values, dates: dates.map((d) => Math.trunc(d)) };
}

/** Continuous (Actual/365) discounted value used by XNPV / XIRR. */
function xnpvAt(rate: number, values: number[], dates: number[]): number {
  const d0 = dates[0];
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i] / Math.pow(1 + rate, (dates[i] - d0) / 365);
  }
  return total;
}

const XNPV: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) {
    return makeError("#ERR!", "XNPV expects 3 arguments");
  }
  const rate = num(args[0], ctx);
  if (isFormulaError(rate)) return rate;
  if (rate <= -1) return makeError("#NUM!", "XNPV: rate must exceed -100%");
  const flows = readDatedFlows(args[1], args[2], ctx, "XNPV");
  if (isFormulaError(flows)) return flows;
  return xnpvAt(rate, flows.values, flows.dates);
};

const XIRR: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "XIRR expects 2 or 3 arguments");
  }
  const flows = readDatedFlows(args[0], args[1], ctx, "XIRR");
  if (isFormulaError(flows)) return flows;
  const hasPos = flows.values.some((f) => f > 0);
  const hasNeg = flows.values.some((f) => f < 0);
  if (!hasPos || !hasNeg) {
    return makeError("#NUM!", "XIRR needs at least one positive and one negative cash flow");
  }
  const guess = optNum(args, 2, ctx, 0.1);
  if (isFormulaError(guess)) return guess;
  const root = solveRate(
    (r) => xnpvAt(r, flows.values, flows.dates),
    guess,
  );
  if (root === null) return makeError("#NUM!", "XIRR did not converge");
  return root;
};

const SLN: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) return makeError("#ERR!", "SLN expects 3 arguments");
  const cost = num(args[0], ctx);
  if (isFormulaError(cost)) return cost;
  const salvage = num(args[1], ctx);
  if (isFormulaError(salvage)) return salvage;
  const life = num(args[2], ctx);
  if (isFormulaError(life)) return life;
  if (life === 0) return makeError("#DIV/0!", "SLN: life must be non-zero");
  return (cost - salvage) / life;
};

const SYD: FunctionImpl = (args, ctx) => {
  if (args.length !== 4) return makeError("#ERR!", "SYD expects 4 arguments");
  const cost = num(args[0], ctx);
  if (isFormulaError(cost)) return cost;
  const salvage = num(args[1], ctx);
  if (isFormulaError(salvage)) return salvage;
  const life = num(args[2], ctx);
  if (isFormulaError(life)) return life;
  const per = num(args[3], ctx);
  if (isFormulaError(per)) return per;
  if (life <= 0) return makeError("#NUM!", "SYD: life must be positive");
  if (per < 1 || per > life) {
    return makeError("#NUM!", "SYD: per must be between 1 and life");
  }
  return ((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1));
};

const DB: FunctionImpl = (args, ctx) => {
  if (args.length < 4 || args.length > 5) {
    return makeError("#ERR!", "DB expects 4 or 5 arguments");
  }
  const cost = num(args[0], ctx);
  if (isFormulaError(cost)) return cost;
  const salvage = num(args[1], ctx);
  if (isFormulaError(salvage)) return salvage;
  const life = num(args[2], ctx);
  if (isFormulaError(life)) return life;
  const periodRaw = num(args[3], ctx);
  if (isFormulaError(periodRaw)) return periodRaw;
  // Excel truncates `period` to an integer (the schedule is per whole period);
  // do the same up front so the stub-period check (`period === life + 1`)
  // matches Excel for fractional inputs and stays consistent with `DDB`.
  const period = Math.trunc(periodRaw);
  const monthRaw = optNum(args, 4, ctx, 12);
  if (isFormulaError(monthRaw)) return monthRaw;
  const month = Math.trunc(monthRaw);
  if (cost < 0 || salvage < 0 || life <= 0 || period < 1) {
    return makeError("#NUM!", "DB: invalid arguments");
  }
  if (month < 1 || month > 12) {
    return makeError("#NUM!", "DB: month must be between 1 and 12");
  }
  if (cost === 0) return 0;
  // Excel rounds the fixed declining rate to three decimals.
  const rate = Math.round((1 - Math.pow(salvage / cost, 1 / life)) * 1000) / 1000;
  const first = (cost * rate * month) / 12;
  if (period === 1) return first;
  let accumulated = first;
  let dep = 0;
  const lastFull = life; // periods 2..life use the full-year formula
  for (let p = 2; p <= period && p <= lastFull; p++) {
    dep = (cost - accumulated) * rate;
    accumulated += dep;
  }
  if (period <= lastFull) return dep;
  // Final stub period (only present when month < 12).
  if (period === life + 1) {
    return ((cost - accumulated) * rate * (12 - month)) / 12;
  }
  return makeError("#NUM!", "DB: period exceeds the depreciation schedule");
};

const DDB: FunctionImpl = (args, ctx) => {
  if (args.length < 4 || args.length > 5) {
    return makeError("#ERR!", "DDB expects 4 or 5 arguments");
  }
  const cost = num(args[0], ctx);
  if (isFormulaError(cost)) return cost;
  const salvage = num(args[1], ctx);
  if (isFormulaError(salvage)) return salvage;
  const life = num(args[2], ctx);
  if (isFormulaError(life)) return life;
  const period = num(args[3], ctx);
  if (isFormulaError(period)) return period;
  const factorRaw = optNum(args, 4, ctx, 2);
  if (isFormulaError(factorRaw)) return factorRaw;
  if (cost < 0 || salvage < 0 || life <= 0 || period < 1 || factorRaw <= 0) {
    return makeError("#NUM!", "DDB: invalid arguments");
  }
  if (period > life) {
    return makeError("#NUM!", "DDB: period must not exceed life");
  }
  // Iterate the book value forward; clamp so it never drops below salvage.
  let accumulated = 0;
  let dep = 0;
  const p = Math.ceil(period);
  for (let i = 1; i <= p; i++) {
    dep = Math.min(
      ((cost - accumulated) * factorRaw) / life,
      cost - salvage - accumulated,
    );
    if (dep < 0) dep = 0;
    accumulated += dep;
  }
  return dep;
};

const EFFECT: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "EFFECT expects 2 arguments");
  const nominal = num(args[0], ctx);
  if (isFormulaError(nominal)) return nominal;
  const nperyRaw = num(args[1], ctx);
  if (isFormulaError(nperyRaw)) return nperyRaw;
  const npery = Math.trunc(nperyRaw);
  if (nominal <= 0 || npery < 1) {
    return makeError("#NUM!", "EFFECT: nominal>0 and npery>=1 required");
  }
  return Math.pow(1 + nominal / npery, npery) - 1;
};

const NOMINAL: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "NOMINAL expects 2 arguments");
  const effect = num(args[0], ctx);
  if (isFormulaError(effect)) return effect;
  const nperyRaw = num(args[1], ctx);
  if (isFormulaError(nperyRaw)) return nperyRaw;
  const npery = Math.trunc(nperyRaw);
  if (effect <= 0 || npery < 1) {
    return makeError("#NUM!", "NOMINAL: effect>0 and npery>=1 required");
  }
  return (Math.pow(1 + effect, 1 / npery) - 1) * npery;
};

/** Raw (unwrapped) implementations, keyed by their spreadsheet name. */
const RAW_FINANCIAL_FUNCTIONS: Record<string, FunctionImpl> = {
  PMT,
  FV,
  PV,
  NPER,
  IPMT,
  PPMT,
  CUMIPMT,
  CUMPRINC,
  NPV,
  IRR,
  MIRR,
  XNPV,
  XIRR,
  SLN,
  SYD,
  DB,
  DDB,
  EFFECT,
  NOMINAL,
};

// Every financial function is wrapped in `guardFinite` so a non-finite result
// (NaN / ±Infinity) from any code path surfaces as `#NUM!` — the single place
// that enforces the module's "never leak a non-finite number into the grid"
// contract.
export const FINANCIAL_FUNCTIONS: Record<string, FunctionImpl> =
  Object.fromEntries(
    Object.entries(RAW_FINANCIAL_FUNCTIONS).map(([name, fn]) => [
      name,
      guardFinite(name, fn),
    ]),
  );
