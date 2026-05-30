/**
 * Phase 16 Task 3 — AST evaluator.
 *
 * Walks the AST produced by `parser.ts` and returns a `FormulaValue`
 * (number / string / boolean / null / `FormulaError`). Cell and
 * range references are resolved via the `CellResolver` interface so
 * the evaluator stays decoupled from the React state shape and can
 * be re-used by the Base-editor formula field (Phase 17) and the
 * cross-sheet workbook (Phase 16 PR 2).
 *
 * Type coercion follows Excel rules:
 *
 *   - Arithmetic operators (`+ - * / ^ %`) coerce strings that
 *     parse as numbers to numbers, blanks to `0`, booleans to
 *     `1 / 0`, and otherwise return `#VALUE!`.
 *   - The concatenation operator (`&`) coerces every value to its
 *     string representation; blank → `""`; booleans → `"TRUE"` /
 *     `"FALSE"`; errors propagate.
 *   - Comparisons (`= <> < > <= >=`) compare numbers numerically,
 *     strings lexicographically (case-insensitive, like Excel), and
 *     booleans `FALSE < TRUE`. A blank cell equals both `0` and
 *     `""` (Excel's empty-cell rule).
 *
 * Errors propagate eagerly — the moment a sub-expression evaluates
 * to a `FormulaError`, the outer expression returns the same error
 * (Excel's "errors-poison-results" rule). `IFERROR` is the only
 * function that catches them, implemented in `functions/logic.ts`.
 *
 * Design note: this module intentionally does NOT import from
 * `./functions/*`. The function registry is injected via
 * `EvaluationContext.functions`. The default registry is assembled
 * in `functions/index.ts` (which imports the evaluator helpers) so
 * the dependency graph stays acyclic. The facade `index.ts`
 * provides `defaultContext()` to plug the standard registry in for
 * callers that don't need to customise it.
 */
import type { AstNode } from "./parser";
import { cellKey } from "./depGraph";
import {
  isFormulaError,
  makeError,
  type CellResolver,
  type FormulaError,
  type FormulaValue,
} from "./types";

/**
 * Signature every formula function obeys. We use the mutable
 * `AstNode[]` (not `ReadonlyArray<…>`) so functions can pass `args`
 * straight through to helpers that themselves take `AstNode[]`
 * without juggling readonly qualifiers. Implementations MUST NOT
 * mutate the array — the parser hands the same array reference to
 * every call.
 */
export type FunctionImpl = (
  args: AstNode[],
  ctx: EvaluationContext,
) => FormulaValue;

/**
 * Per-evaluation context. Carries the cell-resolver, a visited set
 * for circular-reference detection, and the function registry. We
 * pass it down through every recursive call instead of stashing it
 * in module-level state so concurrent evaluations stay isolated.
 *
 * `functions` is REQUIRED — callers (e.g. the facade) inject the
 * default registry. Tests can substitute a smaller registry to
 * pin behaviour.
 */
export interface EvaluationContext {
  readonly resolver: CellResolver;
  readonly visiting: Set<string>;
  readonly functions: ReadonlyMap<string, FunctionImpl>;
  readonly random?: () => number;
  /**
   * Deterministic clock used by `TODAY()` / `NOW()` (and any future
   * volatile time-based function). Falls back to `new Date()` when
   * absent. Tests pin this to a fixed instant so date assertions are
   * stable.
   */
  readonly now?: () => Date;
}

export function evaluate(node: AstNode, ctx: EvaluationContext): FormulaValue {
  switch (node.type) {
    case "number":
      return node.value;
    case "string":
      return node.value;
    case "boolean":
      return node.value;
    case "identifier":
      // Bare identifiers are reserved for future named-range support
      // (Phase 16 PR 2). For now, surface as `#NAME?` so the user
      // sees a precise error instead of a silent `0`.
      return makeError("#NAME?", `unknown name "${node.name}"`);
    case "cell": {
      // Cycle key matches `cellKey()` from depGraph so the resolver
      // and the evaluator agree on visiting-set entries. Sheet is
      // threaded so `Sheet1!A1` referring `Sheet2!A1` is not a cycle.
      const key = cellKey(node.row, node.col, node.sheet);
      if (ctx.visiting.has(key)) {
        return makeError("#CIRCULAR!", `circular reference at ${key}`);
      }
      return ctx.resolver.getEvaluated(node.row, node.col, node.sheet);
    }
    case "range":
      // Bare ranges (not wrapped in a function call) collapse to
      // their first cell — matching Excel's implicit-intersection
      // behaviour when no array context is provided. Functions that
      // want the full range expand it themselves via
      // `collectValues()` below.
      return ctx.resolver.getEvaluated(
        node.start.row,
        node.start.col,
        node.sheet,
      );
    case "function": {
      const impl = ctx.functions.get(node.name.toUpperCase());
      if (!impl) {
        return makeError("#NAME?", `unknown function "${node.name}"`);
      }
      return impl(node.args, ctx);
    }
    case "unary":
      return evaluateUnary(node.op, node.operand, ctx);
    case "binary":
      return evaluateBinary(node.op, node.left, node.right, ctx);
    default: {
      const _exhaust: never = node;
      return makeError("#ERR!", `unrecognised AST node ${String(_exhaust)}`);
    }
  }
}

function evaluateUnary(
  op: "+" | "-" | "%",
  operand: AstNode,
  ctx: EvaluationContext,
): FormulaValue {
  const v = evaluate(operand, ctx);
  if (isFormulaError(v)) return v;
  const n = toNumber(v);
  if (isFormulaError(n)) return n;
  if (op === "+") return n;
  if (op === "-") return -n;
  return n / 100; // %
}

type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "^"
  | "&"
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">=";

function evaluateBinary(
  op: BinaryOp,
  leftNode: AstNode,
  rightNode: AstNode,
  ctx: EvaluationContext,
): FormulaValue {
  const left = evaluate(leftNode, ctx);
  if (isFormulaError(left)) return left;
  const right = evaluate(rightNode, ctx);
  if (isFormulaError(right)) return right;

  if (op === "&") {
    return toString(left) + toString(right);
  }
  if (
    op === "=" ||
    op === "<>" ||
    op === "<" ||
    op === ">" ||
    op === "<=" ||
    op === ">="
  ) {
    return compare(op, left, right);
  }
  // Arithmetic — coerce both sides to numbers.
  const a = toNumber(left);
  if (isFormulaError(a)) return a;
  const b = toNumber(right);
  if (isFormulaError(b)) return b;
  switch (op) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      if (b === 0) return makeError("#DIV/0!", "division by zero");
      return a / b;
    case "^":
      return Math.pow(a, b);
    default: {
      const _exhaust: never = op;
      return makeError("#ERR!", `unknown operator ${String(_exhaust)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Coercion helpers (exported for the function-implementation modules).
// ---------------------------------------------------------------------------

/** Coerce any non-error `FormulaValue` to a number using Excel rules. */
export function toNumber(value: FormulaValue): number | FormulaError {
  if (isFormulaError(value)) return value;
  if (value === null) return 0;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return makeError("#NUM!", "NaN");
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return 0;
    // Excel-style: `"50%"` → `0.5`, `"$1,234.5"` → `1234.5`.
    // (Full locale-aware parsing lives in `functions/text.ts:VALUE()`
    // shipping in PR 2.)
    const percent = /%\s*$/.test(trimmed);
    const cleaned = trimmed.replace(/[$,%\s]/g, "");
    const n = Number(cleaned);
    if (!Number.isFinite(n)) {
      return makeError("#VALUE!", `cannot coerce "${value}" to number`);
    }
    return percent ? n / 100 : n;
  }
  return makeError("#VALUE!", `cannot coerce ${typeof value} to number`);
}

/** Coerce a value to its Excel string representation. */
export function toString(value: FormulaValue): string {
  if (isFormulaError(value)) return value.code;
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") return formatNumber(value);
  return value;
}

/** Coerce a value to boolean using Excel rules. */
export function toBoolean(value: FormulaValue): boolean | FormulaError {
  if (isFormulaError(value)) return value;
  if (value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const upper = value.trim().toUpperCase();
    if (upper === "TRUE") return true;
    if (upper === "FALSE") return false;
    if (upper === "") return false;
    const n = Number(value);
    if (Number.isFinite(n)) return n !== 0;
    return makeError("#VALUE!", `cannot coerce "${value}" to boolean`);
  }
  return makeError("#VALUE!", `cannot coerce ${typeof value} to boolean`);
}

function compare(
  op: "=" | "<>" | "<" | ">" | "<=" | ">=",
  a: FormulaValue,
  b: FormulaValue,
): boolean | FormulaError {
  if (op === "=" || op === "<>") {
    const equal = looseEquals(a, b);
    return op === "=" ? equal : !equal;
  }
  const cmp = orderedCompare(a, b);
  if (isFormulaError(cmp)) return cmp;
  switch (op) {
    case "<":
      return cmp < 0;
    case ">":
      return cmp > 0;
    case "<=":
      return cmp <= 0;
    case ">=":
      return cmp >= 0;
  }
}

function looseEquals(a: FormulaValue, b: FormulaValue): boolean {
  if (isFormulaError(a) || isFormulaError(b)) return false;
  if (a === null) a = "";
  if (b === null) b = "";
  if (typeof a === typeof b) {
    if (typeof a === "string") return a.toLowerCase() === (b as string).toLowerCase();
    return a === b;
  }
  if (typeof a === "number" && typeof b === "string" && b === "") return a === 0;
  if (typeof a === "string" && a === "" && typeof b === "number") return b === 0;
  return false;
}

function orderedCompare(
  a: FormulaValue,
  b: FormulaValue,
): number | FormulaError {
  if (isFormulaError(a) || isFormulaError(b)) {
    return makeError("#VALUE!", "cannot compare errors");
  }
  if (a === null) a = 0;
  if (b === null) b = 0;
  if (typeof a === "number" && typeof b === "number") return Math.sign(a - b);
  if (typeof a === "string" && typeof b === "string") {
    const ca = a.toLowerCase();
    const cb = b.toLowerCase();
    if (ca < cb) return -1;
    if (ca > cb) return 1;
    return 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Math.sign((a ? 1 : 0) - (b ? 1 : 0));
  }
  // Type-rank ordering matches Excel: number < string < boolean.
  const rank = (v: FormulaValue): number => {
    if (typeof v === "number") return 0;
    if (typeof v === "string") return 1;
    if (typeof v === "boolean") return 2;
    return -1;
  };
  return Math.sign(rank(a) - rank(b));
}

/**
 * Helper used by aggregation functions to walk an AST node that may
 * be a single cell, a range, or a literal/expression. Yields every
 * resolved `FormulaValue` inside the node.
 *
 * Range nodes are expanded across all cells (inclusive); single
 * cells/literals are emitted once.
 */
export function* collectValues(
  node: AstNode,
  ctx: EvaluationContext,
): Generator<FormulaValue> {
  if (node.type === "range") {
    for (let r = node.start.row; r <= node.end.row; r++) {
      for (let c = node.start.col; c <= node.end.col; c++) {
        const key = cellKey(r, c, node.sheet);
        if (ctx.visiting.has(key)) {
          yield makeError("#CIRCULAR!", `circular reference at ${key}`);
          continue;
        }
        yield ctx.resolver.getEvaluated(r, c, node.sheet);
      }
    }
    return;
  }
  yield evaluate(node, ctx);
}

/** Format a number the way Excel's general-format cell does. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    if (Number.isNaN(value)) return "#NUM!";
    return value > 0 ? "Infinity" : "-Infinity";
  }
  if (Number.isInteger(value)) return value.toString();
  const abs = Math.abs(value);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e15)) {
    return value.toExponential();
  }
  return parseFloat(value.toPrecision(15)).toString();
}
