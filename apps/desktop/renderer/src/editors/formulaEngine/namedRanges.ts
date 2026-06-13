/**
 * Named-range support for the formula engine.
 *
 * A named range maps a user-facing identifier (e.g. `Revenue`) to a
 * cell or range reference string (e.g. `Sheet1!$B$2:$B$10`). Formulas
 * reference the name directly — `=SUM(Revenue)` — and the evaluator
 * resolves it through {@link EvaluationContext.names}.
 *
 * This module is the single place that:
 *   1. validates a candidate name (Excel/Sheets defined-name rules);
 *   2. compiles a list of `{ name, range }` records into the
 *      `ReadonlyMap<string, AstNode>` the evaluator consumes, parsing
 *      each range string exactly once.
 *
 * Keeping it pure (no React, no I/O) means the rules are unit-testable
 * in isolation and reused by both the evaluator wiring and the UI's
 * name-manager validation.
 */
import { parseFormula, type AstNode } from "./parser";

/** A named range as persisted on the artifact / consumed by the UI. */
export interface NamedRangeInput {
  name: string;
  range: string;
}

/**
 * A cell-reference-shaped token (e.g. `A1`, `$AB$12`) — disallowed as a
 * name because it is ambiguous with a literal reference.
 */
const CELL_SHAPED = /^\$?[A-Za-z]{1,3}\$?[0-9]+$/;

/** A syntactically valid defined-name body. */
const VALID_NAME = /^[A-Za-z_\\][A-Za-z0-9_.]*$/;

/** Names that would collide with boolean literals. */
const RESERVED = new Set(["TRUE", "FALSE"]);

/**
 * Validate a defined-name candidate. Returns `null` when valid, or a
 * human-readable reason when not — suitable for surfacing inline in the
 * name-manager UI.
 */
export function validateName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === "") return "Name cannot be empty.";
  if (trimmed.length > 255) return "Name is too long (max 255 characters).";
  if (!VALID_NAME.test(trimmed)) {
    return "Name must start with a letter or underscore and contain only letters, digits, periods, or underscores.";
  }
  if (CELL_SHAPED.test(trimmed)) {
    return "Name cannot look like a cell reference (e.g. A1).";
  }
  if (RESERVED.has(trimmed.toUpperCase())) {
    return `"${trimmed}" is a reserved word.`;
  }
  return null;
}

/**
 * Parse a range string into the `cell` / `range` AST node a named range
 * must point at. Returns `null` when the string is not a valid single
 * cell or range reference (a named range may not point at an arbitrary
 * expression).
 */
export function parseRangeReference(range: string): AstNode | null {
  const parsed = parseFormula(range);
  if (!parsed.ok) return null;
  if (parsed.ast.type === "cell" || parsed.ast.type === "range") {
    return parsed.ast;
  }
  return null;
}

/**
 * Validate a full `{ name, range }` record. Returns `null` when both
 * the name and the range reference are well-formed, else a reason.
 */
export function validateNamedRange(input: NamedRangeInput): string | null {
  const nameError = validateName(input.name);
  if (nameError) return nameError;
  if (parseRangeReference(input.range) === null) {
    return "Range must be a single cell or range reference (e.g. Sheet1!A1:B10).";
  }
  return null;
}

/**
 * Compile a list of named ranges into the case-insensitive lookup map
 * the evaluator consumes. Invalid entries (bad name or unparseable
 * range) are skipped rather than throwing, so a single malformed
 * defined name can never break evaluation of the whole sheet. On a
 * duplicate name (case-insensitive) the last entry wins, matching the
 * workbook-level override semantics of Excel.
 */
export function buildNamesMap(
  ranges: readonly NamedRangeInput[] | undefined,
): ReadonlyMap<string, AstNode> {
  const map = new Map<string, AstNode>();
  if (!ranges) return map;
  for (const r of ranges) {
    if (validateName(r.name) !== null) continue;
    const node = parseRangeReference(r.range);
    if (node === null) continue;
    map.set(r.name.toUpperCase(), node);
  }
  return map;
}
