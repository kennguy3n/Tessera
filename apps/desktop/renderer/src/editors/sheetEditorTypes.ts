/**
 * Pure type declarations for `SheetEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */

export interface SheetContent {
  columns: string[];
  rows: string[][];
}
