/**
 * Sheet conditional-formatting rules editor.
 *
 * A toolbar-toggled panel that lists the active sheet's
 * {@link ConditionalFormatRule}s and lets the user add, edit, and
 * delete them. It is a controlled component: every mutation produces a
 * brand-new rules array handed to `onChange`, which `SheetEditor` then
 * persists. The actual cell styling is computed elsewhere
 * (`conditionalStyleForCell`) — this panel only edits the rule set.
 */

import { useCallback } from "react";
import type {
  ConditionalFormatRule,
  ConditionalOperator,
} from "../sheetEditorTypes";
import {
  OPERATOR_LABELS,
  defaultConditionalRule,
  operatorTakesValue,
} from "../sheetConditionalFormatting";

export interface ConditionalFormatPanelProps {
  rules: ConditionalFormatRule[];
  /** Active-sheet column headers, for the per-column scope dropdown. */
  columns: string[];
  onChange: (rules: ConditionalFormatRule[]) => void;
  onClose: () => void;
}

const OPERATORS = Object.keys(OPERATOR_LABELS) as ConditionalOperator[];

export function ConditionalFormatPanel({
  rules,
  columns,
  onChange,
  onClose,
}: ConditionalFormatPanelProps) {
  const updateRule = useCallback(
    (id: string, patch: Partial<ConditionalFormatRule>) => {
      onChange(
        rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
      );
    },
    [rules, onChange],
  );

  const addRule = useCallback(() => {
    onChange([...rules, defaultConditionalRule()]);
  }, [rules, onChange]);

  const removeRule = useCallback(
    (id: string) => {
      onChange(rules.filter((rule) => rule.id !== id));
    },
    [rules, onChange],
  );

  return (
    <section
      className="sheet-cf-panel"
      data-testid="sheet-cf-panel"
      aria-label="Conditional formatting rules"
    >
      <div className="sheet-cf-header">
        <span className="sheet-cf-title">Conditional formatting</span>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close conditional formatting"
        >
          ×
        </button>
      </div>

      {rules.length === 0 ? (
        <p className="sheet-cf-empty" data-testid="sheet-cf-empty">
          No rules yet. Add a rule to highlight cells by value.
        </p>
      ) : (
        <ul className="sheet-cf-list">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="sheet-cf-rule"
              data-testid={`sheet-cf-rule-${rule.id}`}
            >
              <label className="sheet-cf-field">
                <span className="sheet-cf-label">Column</span>
                <select
                  value={rule.column === null ? "all" : String(rule.column)}
                  aria-label="Rule column"
                  onChange={(e) =>
                    updateRule(rule.id, {
                      column:
                        e.target.value === "all"
                          ? null
                          : Number(e.target.value),
                    })
                  }
                >
                  <option value="all">All columns</option>
                  {columns.map((col, idx) => (
                    <option key={idx} value={idx}>
                      {col || `Column ${idx + 1}`}
                    </option>
                  ))}
                </select>
              </label>

              <label className="sheet-cf-field">
                <span className="sheet-cf-label">Condition</span>
                <select
                  value={rule.operator}
                  aria-label="Rule operator"
                  onChange={(e) =>
                    updateRule(rule.id, {
                      operator: e.target.value as ConditionalOperator,
                    })
                  }
                >
                  {OPERATORS.map((op) => (
                    <option key={op} value={op}>
                      {OPERATOR_LABELS[op]}
                    </option>
                  ))}
                </select>
              </label>

              {operatorTakesValue(rule.operator) && (
                <label className="sheet-cf-field">
                  <span className="sheet-cf-label">Value</span>
                  <input
                    type="text"
                    value={rule.value}
                    aria-label="Rule value"
                    onChange={(e) =>
                      updateRule(rule.id, { value: e.target.value })
                    }
                  />
                </label>
              )}

              <div className="sheet-cf-style">
                <label className="sheet-cf-color" title="Background colour">
                  <span className="sheet-cf-label">Fill</span>
                  <input
                    type="color"
                    aria-label="Rule background colour"
                    value={rule.style.background ?? "#fde68a"}
                    onChange={(e) =>
                      updateRule(rule.id, {
                        style: { ...rule.style, background: e.target.value },
                      })
                    }
                  />
                </label>
                <label className="sheet-cf-color" title="Text colour">
                  <span className="sheet-cf-label">Text</span>
                  <input
                    type="color"
                    aria-label="Rule text colour"
                    value={rule.style.color ?? "#000000"}
                    onChange={(e) =>
                      updateRule(rule.id, {
                        style: { ...rule.style, color: e.target.value },
                      })
                    }
                  />
                </label>
                <label className="sheet-cf-toggle">
                  <input
                    type="checkbox"
                    aria-label="Rule bold"
                    checked={rule.style.bold ?? false}
                    onChange={(e) =>
                      updateRule(rule.id, {
                        style: { ...rule.style, bold: e.target.checked },
                      })
                    }
                  />
                  Bold
                </label>
              </div>

              <button
                type="button"
                className="btn-sm sheet-cf-remove"
                onClick={() => removeRule(rule.id)}
                aria-label="Delete rule"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className="btn-sm"
        data-testid="sheet-cf-add"
        onClick={addRule}
      >
        + Add rule
      </button>
    </section>
  );
}
