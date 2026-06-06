/**
 * Pure evaluation logic for Sheet conditional formatting.
 *
 * Kept DOM-free and React-free (the renderer turns the resulting
 * {@link ConditionalRuleStyle} into a `CSSProperties` via the existing
 * `cellFormatStyle` translator) so the matching algorithm unit-tests in
 * isolation. A rule matches against a cell's *displayed* value — i.e.
 * the computed result for formula cells — so the styling reacts to what
 * the user actually sees.
 */

import type {
  ConditionalFormatRule,
  ConditionalOperator,
  ConditionalRuleStyle,
} from "./sheetEditorTypes";

let ruleIdCounter = 0;

/** Process-unique id for a freshly created rule. */
export function makeRuleId(): string {
  ruleIdCounter += 1;
  return `cfr-${Date.now().toString(36)}-${ruleIdCounter}`;
}

/** Human-readable label for an operator (used by the rules UI). */
export const OPERATOR_LABELS: Record<ConditionalOperator, string> = {
  gt: "is greater than",
  gte: "is greater than or equal to",
  lt: "is less than",
  lte: "is less than or equal to",
  eq: "equals",
  neq: "does not equal",
  contains: "contains",
  notContains: "does not contain",
  isEmpty: "is empty",
  notEmpty: "is not empty",
};

/** Operators that ignore the rule's right-hand `value`. */
export function operatorTakesValue(operator: ConditionalOperator): boolean {
  return operator !== "isEmpty" && operator !== "notEmpty";
}

/**
 * Whether `displayValue` satisfies `rule`. The numeric operators coerce
 * both operands with `Number(...)` and bail out (no match) if either
 * side isn't a finite number, so a `> 5` rule never highlights the text
 * cell "hello". Text operators compare the raw displayed strings;
 * `eq`/`neq` are numeric-aware so `"5"` matches a rule value of `"5.0"`.
 */
export function cellMatchesRule(
  displayValue: string,
  rule: ConditionalFormatRule,
): boolean {
  const cell = displayValue ?? "";
  switch (rule.operator) {
    case "isEmpty":
      return cell.trim() === "";
    case "notEmpty":
      return cell.trim() !== "";
    case "contains":
      return cell.includes(rule.value);
    case "notContains":
      return !cell.includes(rule.value);
    case "eq":
    case "neq": {
      const cellNum = Number(cell);
      const ruleNum = Number(rule.value);
      const numericComparable =
        cell.trim() !== "" &&
        rule.value.trim() !== "" &&
        Number.isFinite(cellNum) &&
        Number.isFinite(ruleNum);
      const equal = numericComparable
        ? cellNum === ruleNum
        : cell === rule.value;
      return rule.operator === "eq" ? equal : !equal;
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const cellNum = Number(cell);
      const ruleNum = Number(rule.value);
      if (
        cell.trim() === "" ||
        rule.value.trim() === "" ||
        !Number.isFinite(cellNum) ||
        !Number.isFinite(ruleNum)
      ) {
        return false;
      }
      switch (rule.operator) {
        case "gt":
          return cellNum > ruleNum;
        case "gte":
          return cellNum >= ruleNum;
        case "lt":
          return cellNum < ruleNum;
        case "lte":
          return cellNum <= ruleNum;
      }
      return false;
    }
    default:
      return false;
  }
}

/**
 * Merge the styles of every rule that matches `(colIdx, displayValue)`,
 * in array order, into a single {@link ConditionalRuleStyle}. A rule
 * whose `column` is `null` applies to every column; otherwise it only
 * applies to its target column. Returns an empty object when nothing
 * matches (the caller can spread it harmlessly).
 */
export function conditionalStyleForCell(
  rules: ConditionalFormatRule[] | undefined,
  colIdx: number,
  displayValue: string,
): ConditionalRuleStyle {
  if (!rules || rules.length === 0) return {};
  const merged: ConditionalRuleStyle = {};
  for (const rule of rules) {
    if (rule.column !== null && rule.column !== colIdx) continue;
    if (!cellMatchesRule(displayValue, rule)) continue;
    if (rule.style.bold !== undefined) merged.bold = rule.style.bold;
    if (rule.style.italic !== undefined) merged.italic = rule.style.italic;
    if (rule.style.underline !== undefined) {
      merged.underline = rule.style.underline;
    }
    if (rule.style.color !== undefined) merged.color = rule.style.color;
    if (rule.style.background !== undefined) {
      merged.background = rule.style.background;
    }
  }
  return merged;
}

/** A new rule pre-filled with sensible defaults for the editor UI. */
export function defaultConditionalRule(): ConditionalFormatRule {
  return {
    id: makeRuleId(),
    column: null,
    operator: "gt",
    value: "",
    style: { background: "#fde68a" },
  };
}
