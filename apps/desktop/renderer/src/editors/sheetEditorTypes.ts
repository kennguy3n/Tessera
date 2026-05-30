/**
 * Pure type declarations for `SheetEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */

/**
 * Phase 15 Task 14: a workbook-level named range. The `name` is the
 * identifier the user (or a formula like `=SUM(Revenue)`) references;
 * `range` is an A1-style cell reference matching the XLSX defined-names
 * spec (e.g. `Sheet1!$B$2:$B$10` or `Sheet1!$A$1`).
 *
 * The struct is serialised to JSON 1:1 so the Rust XLSX exporter can
 * round-trip it via serde — see `tessera_export::xlsx::SheetContent`.
 * Adding optional fields here later must keep the serde struct in sync.
 */
export interface SheetNamedRange {
  name: string;
  range: string;
}

export interface SheetContent {
  columns: string[];
  rows: string[][];
  /**
   * Phase 15 Task 14: optional workbook-level named ranges. Persisted on
   * the artifact JSON so the XLSX exporter can emit `<definedName>`
   * entries; the renderer-side Sheet editor does NOT currently surface
   * these to the user (a future task), but the JSON schema is forward-
   * compatible: producers may omit the field entirely (treated as no
   * named ranges), consumers must tolerate missing or empty arrays.
   */
  namedRanges?: SheetNamedRange[];
}
