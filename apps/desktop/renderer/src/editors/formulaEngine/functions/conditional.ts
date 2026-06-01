/**
 * conditional aggregation functions.
 *
 *   SUMIF(range, criterion, [sum_range])
 *   SUMIFS(sum_range, criteria_range1, criterion1, ...)
 *   COUNTIF(range, criterion)
 *   COUNTIFS(criteria_range1, criterion1, ...)
 *   AVERAGEIF(range, criterion, [average_range])
 *   AVERAGEIFS(average_range, criteria_range1, criterion1, ...)
 *
 * Criteria syntax matches Excel:
 *
 *   - Numeric literal:           `10`           → equals 10
 *   - Comparison + number:        `">10"`        → greater than 10
 *   - Comparison + text:          `"<>apple"`    → not "apple"
 *   - String with wildcards:      `"app*"` `"a?b"`
 *
 *   Wildcards: `*` matches any (incl. empty) substring, `?` matches
 *   exactly one character. `~*` and `~?` escape the literal character.
 *
 * All aggregation iterates parallel cells from each criteria/sum
 * range; per Excel, the ranges must have the same shape — we surface
 * `#VALUE!` if they don't.
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

type Predicate = (value: FormulaValue) => boolean;

interface ParsedCriterion {
  predicate: Predicate;
}

/**
 * Compile a criterion value (already evaluated, so a number / string
 * / boolean) into a predicate over `FormulaValue`s.
 *
 * Numbers / booleans → strict equality. Strings starting with one
 * of the comparison prefixes (`>=`, `<=`, `<>`, `>`, `<`, `=`) parse
 * out the operator and apply it; everything else is a textual
 * match-with-wildcards (case-insensitive).
 */
function compileCriterion(rawCriterion: FormulaValue): ParsedCriterion | FormulaError {
  if (isFormulaError(rawCriterion)) return rawCriterion;
  if (typeof rawCriterion === "number") {
    return { predicate: (v) => valueMatchesNumberEq(v, rawCriterion) };
  }
  if (typeof rawCriterion === "boolean") {
    return { predicate: (v) => v === rawCriterion };
  }
  if (rawCriterion === null) {
    return { predicate: (v) => v === null || v === "" };
  }
  const text = rawCriterion;
  // Comparison operators (case-sensitive, must be at the start).
  const opMatch = /^(>=|<=|<>|>|<|=)\s*(.*)$/s.exec(text);
  if (opMatch) {
    const [, op, rhsRaw] = opMatch;
    const rhsTrim = rhsRaw.trim();
    const rhsNumber = Number(rhsTrim);
    if (rhsTrim !== "" && Number.isFinite(rhsNumber)) {
      return { predicate: makeNumericPredicate(op, rhsNumber) };
    }
    if (rhsTrim === "" && (op === "=" || op === "<>")) {
      // `"="` / `"<>"` alone means "blank" / "non-blank"
      const isBlank = (v: FormulaValue) =>
        v === null || (typeof v === "string" && v === "");
      return { predicate: op === "=" ? isBlank : (v) => !isBlank(v) };
    }
    return {
      predicate: makeStringComparisonPredicate(op, rhsTrim),
    };
  }
  // Wildcard text match (case-insensitive).
  return { predicate: makeWildcardPredicate(text) };
}

function makeNumericPredicate(op: string, rhs: number): Predicate {
  return (v) => {
    if (v === null) return op === "=" ? rhs === 0 : op === "<>" ? rhs !== 0 : false;
    if (typeof v !== "number") {
      if (typeof v === "string") {
        const n = Number(v);
        if (!Number.isFinite(n)) return false;
        return numericCompare(op, n, rhs);
      }
      return false;
    }
    return numericCompare(op, v, rhs);
  };
}

function numericCompare(op: string, lhs: number, rhs: number): boolean {
  switch (op) {
    case "=":
      return lhs === rhs;
    case "<>":
      return lhs !== rhs;
    case "<":
      return lhs < rhs;
    case ">":
      return lhs > rhs;
    case "<=":
      return lhs <= rhs;
    case ">=":
      return lhs >= rhs;
    default:
      return false;
  }
}

function makeStringComparisonPredicate(op: string, rhs: string): Predicate {
  const rhsLower = rhs.toLowerCase();
  return (v) => {
    if (v === null) return false;
    const lhs = String(v).toLowerCase();
    switch (op) {
      case "=":
        return wildcardMatch(rhsLower, lhs);
      case "<>":
        return !wildcardMatch(rhsLower, lhs);
      case "<":
        return lhs < rhsLower;
      case ">":
        return lhs > rhsLower;
      case "<=":
        return lhs <= rhsLower;
      case ">=":
        return lhs >= rhsLower;
      default:
        return false;
    }
  };
}

function makeWildcardPredicate(pattern: string): Predicate {
  const lower = pattern.toLowerCase();
  return (v) => {
    if (v === null) return lower === "";
    const subj = String(v).toLowerCase();
    return wildcardMatch(lower, subj);
  };
}

function valueMatchesNumberEq(v: FormulaValue, n: number): boolean {
  if (v === null) return n === 0;
  if (typeof v === "number") return v === n;
  if (typeof v === "boolean") return (v ? 1 : 0) === n;
  if (typeof v === "string") {
    const parsed = Number(v);
    return Number.isFinite(parsed) && parsed === n;
  }
  return false;
}

/**
 * Match a wildcard `pattern` (with `*` and `?`, and `~` escaping)
 * against `subject`. Both are assumed already lower-cased.
 *
 * Compiled to a regex once per call — patterns are short and the
 * conditional aggregators are themselves O(N) over the criteria
 * range, so this is well within budget.
 */
function wildcardMatch(pattern: string, subject: string): boolean {
  // Build regex source by escaping regex metacharacters and
  // translating wildcards.
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "*" || next === "?" || next === "~") {
        out += escapeRegex(next);
        i++;
        continue;
      }
    }
    if (ch === "*") {
      out += ".*";
      continue;
    }
    if (ch === "?") {
      out += ".";
      continue;
    }
    out += escapeRegex(ch);
  }
  out += "$";
  return new RegExp(out, "s").test(subject);
}

function escapeRegex(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandRange(arg: AstNode, ctx: EvaluationContext): FormulaValue[] | FormulaError {
  if (arg.type !== "range") {
    // Single value — treat as a 1-cell "range".
    const v = evaluate(arg, ctx);
    if (isFormulaError(v)) return v;
    return [v];
  }
  const cells: FormulaValue[] = [];
  for (const v of collectValues(arg, ctx)) {
    if (isFormulaError(v)) return v;
    cells.push(v);
  }
  return cells;
}

const SUMIF: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "SUMIF expects 2 or 3 arguments");
  }
  const criteriaRange = expandRange(args[0], ctx);
  if (isFormulaError(criteriaRange)) return criteriaRange;
  const sumRange = args.length === 3 ? expandRange(args[2], ctx) : criteriaRange;
  if (isFormulaError(sumRange)) return sumRange;
  if (sumRange.length !== criteriaRange.length) {
    return makeError("#VALUE!", "SUMIF range shape mismatch");
  }
  const criterion = compileCriterion(evaluate(args[1], ctx));
  if (isFormulaError(criterion)) return criterion;
  let sum = 0;
  for (let i = 0; i < criteriaRange.length; i++) {
    if (!criterion.predicate(criteriaRange[i])) continue;
    const v = sumRange[i];
    if (isFormulaError(v)) return v;
    const n = toNumber(v);
    if (isFormulaError(n)) continue; // Excel skips non-numeric.
    sum += n;
  }
  return sum;
};

const COUNTIF: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "COUNTIF expects 2 arguments");
  const range = expandRange(args[0], ctx);
  if (isFormulaError(range)) return range;
  const criterion = compileCriterion(evaluate(args[1], ctx));
  if (isFormulaError(criterion)) return criterion;
  let count = 0;
  for (const v of range) {
    if (criterion.predicate(v)) count++;
  }
  return count;
};

const AVERAGEIF: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "AVERAGEIF expects 2 or 3 arguments");
  }
  const criteriaRange = expandRange(args[0], ctx);
  if (isFormulaError(criteriaRange)) return criteriaRange;
  const avgRange = args.length === 3 ? expandRange(args[2], ctx) : criteriaRange;
  if (isFormulaError(avgRange)) return avgRange;
  if (avgRange.length !== criteriaRange.length) {
    return makeError("#VALUE!", "AVERAGEIF range shape mismatch");
  }
  const criterion = compileCriterion(evaluate(args[1], ctx));
  if (isFormulaError(criterion)) return criterion;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < criteriaRange.length; i++) {
    if (!criterion.predicate(criteriaRange[i])) continue;
    const v = avgRange[i];
    if (isFormulaError(v)) return v;
    const n = toNumber(v);
    if (isFormulaError(n)) continue;
    sum += n;
    count++;
  }
  if (count === 0) return makeError("#DIV/0!", "AVERAGEIF matched no numeric cells");
  return sum / count;
};

function evalCriteriaPairs(
  args: AstNode[],
  ctx: EvaluationContext,
  startIndex: number,
): {
  ranges: FormulaValue[][];
  criteria: ParsedCriterion[];
  length: number;
} | FormulaError {
  // After `startIndex`, args come in pairs: (range, criterion).
  if ((args.length - startIndex) % 2 !== 0) {
    return makeError("#ERR!", "criteria range/criterion args must pair up");
  }
  const ranges: FormulaValue[][] = [];
  const criteria: ParsedCriterion[] = [];
  let length = -1;
  for (let i = startIndex; i < args.length; i += 2) {
    const range = expandRange(args[i], ctx);
    if (isFormulaError(range)) return range;
    if (length === -1) length = range.length;
    if (range.length !== length) {
      return makeError("#VALUE!", "criteria ranges have differing shapes");
    }
    ranges.push(range);
    const criterion = compileCriterion(evaluate(args[i + 1], ctx));
    if (isFormulaError(criterion)) return criterion;
    criteria.push(criterion);
  }
  return { ranges, criteria, length };
}

const SUMIFS: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length % 2 === 0) {
    return makeError("#ERR!", "SUMIFS expects sum_range + (range, criterion) pairs");
  }
  const sumRange = expandRange(args[0], ctx);
  if (isFormulaError(sumRange)) return sumRange;
  const pairs = evalCriteriaPairs(args, ctx, 1);
  if (isFormulaError(pairs)) return pairs;
  if (pairs.length !== sumRange.length) {
    return makeError("#VALUE!", "SUMIFS sum_range shape mismatch");
  }
  let sum = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (!pairs.criteria.every((c, k) => c.predicate(pairs.ranges[k][i]))) continue;
    const v = sumRange[i];
    if (isFormulaError(v)) return v;
    const n = toNumber(v);
    if (isFormulaError(n)) continue;
    sum += n;
  }
  return sum;
};

const COUNTIFS: FunctionImpl = (args, ctx) => {
  if (args.length === 0 || args.length % 2 !== 0) {
    return makeError("#ERR!", "COUNTIFS expects (range, criterion) pairs");
  }
  const pairs = evalCriteriaPairs(args, ctx, 0);
  if (isFormulaError(pairs)) return pairs;
  let count = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs.criteria.every((c, k) => c.predicate(pairs.ranges[k][i]))) count++;
  }
  return count;
};

const AVERAGEIFS: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length % 2 === 0) {
    return makeError("#ERR!", "AVERAGEIFS expects avg_range + (range, criterion) pairs");
  }
  const avgRange = expandRange(args[0], ctx);
  if (isFormulaError(avgRange)) return avgRange;
  const pairs = evalCriteriaPairs(args, ctx, 1);
  if (isFormulaError(pairs)) return pairs;
  if (pairs.length !== avgRange.length) {
    return makeError("#VALUE!", "AVERAGEIFS average_range shape mismatch");
  }
  let sum = 0;
  let count = 0;
  for (let i = 0; i < pairs.length; i++) {
    if (!pairs.criteria.every((c, k) => c.predicate(pairs.ranges[k][i]))) continue;
    const v = avgRange[i];
    if (isFormulaError(v)) return v;
    const n = toNumber(v);
    if (isFormulaError(n)) continue;
    sum += n;
    count++;
  }
  if (count === 0) return makeError("#DIV/0!", "AVERAGEIFS matched no numeric cells");
  return sum / count;
};

export const CONDITIONAL_FUNCTIONS: Record<string, FunctionImpl> = {
  SUMIF,
  SUMIFS,
  COUNTIF,
  COUNTIFS,
  AVERAGEIF,
  AVERAGEIFS,
};
