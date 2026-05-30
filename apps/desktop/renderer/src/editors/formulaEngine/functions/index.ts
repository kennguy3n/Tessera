/**
 * Phase 16 — function registry.
 *
 * Every function the evaluator dispatches goes through this map. The
 * registry is split into per-category modules (`math.ts`,
 * `conditional.ts`, `logic.ts`, …) so PR 2's text / lookup / date /
 * statistical additions are pure additions to this index.
 *
 * Tests can build a custom registry by passing a `functions` override
 * into the evaluation context, so the public registry is read-only.
 */
import type { FunctionImpl } from "../evaluator";

import { MATH_FUNCTIONS } from "./math";
import { CONDITIONAL_FUNCTIONS } from "./conditional";
import { LOGIC_FUNCTIONS } from "./logic";

// Re-export so callers (functions/*, evaluator consumers) have a
// single import location for the function-signature type.
export type { FunctionImpl };

function buildRegistry(): ReadonlyMap<string, FunctionImpl> {
  const all: Record<string, FunctionImpl> = {
    ...MATH_FUNCTIONS,
    ...CONDITIONAL_FUNCTIONS,
    ...LOGIC_FUNCTIONS,
  };
  const map = new Map<string, FunctionImpl>();
  for (const [name, impl] of Object.entries(all)) {
    map.set(name.toUpperCase(), impl);
  }
  return map;
}

export const FUNCTION_REGISTRY: ReadonlyMap<string, FunctionImpl> = buildRegistry();
