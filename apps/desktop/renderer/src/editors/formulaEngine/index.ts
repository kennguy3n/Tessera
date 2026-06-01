/**
 * formula-engine public facade.
 *
 * Single import location for everything outside the engine that
 * wants to evaluate or analyse formulas. The internal modules
 * (`tokenizer.ts`, `parser.ts`, `evaluator.ts`, …) are still
 * separately importable for tests, but production code should
 * prefer this surface.
 */
export { tokenize, type Token, type TokenType } from "./tokenizer";
export {
  parseFormula,
  type AstNode,
  type BinaryOp,
  type ParseResult,
  type UnaryOp,
} from "./parser";
export {
  evaluate,
  toNumber,
  toString,
  toBoolean,
  collectValues,
  type EvaluationContext,
  type FunctionImpl,
} from "./evaluator";
export {
  FORMULA_ERROR_CODES,
  isFormulaError,
  makeError,
  type CellRef,
  type CellRefNode,
  type CellResolver,
  type FormulaError,
  type FormulaErrorCode,
  type FormulaValue,
  type RangeRef,
} from "./types";
export {
  cellKey,
  parseCellKey,
  extractReferences,
  DependencyGraph,
} from "./depGraph";
export { FUNCTION_REGISTRY } from "./functions";
export {
  applyCellFormat,
  cellFormatStyle,
  valueToDateSerial,
} from "./format";
export { dateToSerial, serialToDate } from "./functions/date";

import { parseFormula } from "./parser";
import {
  evaluate,
  type EvaluationContext,
  type FunctionImpl,
} from "./evaluator";
import { FUNCTION_REGISTRY } from "./functions";
import {
  makeError,
  type CellResolver,
  type FormulaValue,
} from "./types";

/** Build an `EvaluationContext` with the standard function registry. */
export function defaultContext(
  resolver: CellResolver,
  overrides: Partial<Omit<EvaluationContext, "resolver">> = {},
): EvaluationContext {
  return {
    resolver,
    visiting: overrides.visiting ?? new Set<string>(),
    functions: overrides.functions ?? FUNCTION_REGISTRY,
    random: overrides.random,
    now: overrides.now,
  };
}

/**
 * One-shot helper: parse + evaluate `formula` against `resolver`.
 * Returns either the `FormulaValue` produced by the evaluator or a
 * `#ERR!` / `#REF!` for syntax failures.
 *
 * The `=` prefix is optional (the tokenizer strips it).
 */
export function evaluateFormulaString(
  formula: string,
  resolver: CellResolver,
  overrides: Partial<Omit<EvaluationContext, "resolver">> = {},
): FormulaValue {
  const parsed = parseFormula(formula);
  if (!parsed.ok) return makeError(parsed.code, parsed.message);
  const ctx = defaultContext(resolver, overrides);
  return evaluate(parsed.ast, ctx);
}

/**
 * Convenience re-export so callers building their own registries can
 * register a function by name without poking into the read-only
 * `FUNCTION_REGISTRY` map.
 *
 * Returns a new registry rather than mutating the global one so
 * concurrent tests stay isolated.
 */
export function extendRegistry(
  extras: Record<string, FunctionImpl>,
): ReadonlyMap<string, FunctionImpl> {
  const next = new Map(FUNCTION_REGISTRY);
  for (const [name, impl] of Object.entries(extras)) {
    next.set(name.toUpperCase(), impl);
  }
  return next;
}


