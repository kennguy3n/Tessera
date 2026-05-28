/**
 * Pure type declarations for `BaseEditor` and its companion modules.
 *
 * Lives in a third file (neither the component file nor the helpers
 * file) so the component and helpers can each import these types
 * directly without creating a runtime cycle. Compile-time-erased
 * declarations only — no value-level code lives here, by design.
 */

export type FieldType = "text" | "number" | "date" | "select" | "checkbox" | "url";

export interface BaseField {
  name: string;
  type: FieldType;
  options?: string[]; // for select type
}

export interface BaseContent {
  fields: BaseField[];
  records: Record<string, unknown>[];
}
