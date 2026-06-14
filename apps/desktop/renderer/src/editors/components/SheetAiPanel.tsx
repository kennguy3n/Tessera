/**
 * On-device AI assistant for the Sheet editor.
 *
 * A toolbar-toggled panel offering four actions, all powered by the
 * LOCAL model surface via {@link useModelStream} (no network AI):
 *   - generate:  natural language → a spreadsheet formula
 *   - explain:   plain-English explanation of the active cell's formula
 *   - fix:       correct / simplify the active cell's formula
 *   - summarize: a short prose summary of the selected range
 *
 * Security/privacy: prompts are built by the pure helpers in
 * `sheetAiHelpers.ts`, which bound how much sheet content is included.
 * A generated formula is ALWAYS parsed + validated
 * (`validateGeneratedFormula`) before the Insert button is enabled —
 * the assistant can never blind-write an unparseable string into a cell.
 */
import { useCallback, useMemo, useState } from "react";

import StopGenerationButton from "../../components/StopGenerationButton";
import { useModelStream } from "../../hooks/useModelStream";
import {
  buildContext,
  buildExplainPrompt,
  buildFixPrompt,
  buildFormulaPrompt,
  buildSummarizePrompt,
  extractFormula,
  validateGeneratedFormula,
  type FormulaValidation,
  type SheetAiAction,
} from "../sheetAiHelpers";
import { SkillRunnerPanel } from "./SkillRunnerPanel";
import { getSkillsForSurface } from "../../skills/skillLibrary";

type SheetPanelMode = "quick" | "skills";

export interface SheetAiPanelProps {
  columns: string[];
  rows: string[][];
  activeCellRef?: string;
  /** Raw text of the active cell (the formula explain/fix operates on). */
  activeFormula?: string;
  selectionRef?: string;
  onInsertFormula: (formula: string) => void;
  onClose: () => void;
}

const ACTIONS: { id: SheetAiAction; label: string }[] = [
  { id: "generate", label: "Generate formula" },
  { id: "explain", label: "Explain" },
  { id: "fix", label: "Fix / optimize" },
  { id: "summarize", label: "Summarize range" },
];

const PRODUCES_FORMULA = (action: SheetAiAction): boolean =>
  action === "generate" || action === "fix";

export function SheetAiPanel({
  columns,
  rows,
  activeCellRef,
  activeFormula,
  selectionRef,
  onInsertFormula,
  onClose,
}: SheetAiPanelProps) {
  const [action, setAction] = useState<SheetAiAction>("generate");
  const [request, setRequest] = useState("");
  const [candidate, setCandidate] = useState<FormulaValidation | null>(null);
  const { output, isStreaming, error, available, run, reset, cancel } =
    useModelStream();

  const [panelMode, setPanelMode] = useState<SheetPanelMode>("quick");
  const sheetSkills = useMemo(() => getSkillsForSurface("sheet"), []);
  const [skillId, setSkillId] = useState(sheetSkills[0]?.id ?? "");
  const selectedSkill =
    sheetSkills.find((s) => s.id === skillId) ?? sheetSkills[0];
  const [skillError, setSkillError] = useState<string | null>(null);

  // A skill's final output is a single formula (starting with '='). It
  // passes through the SAME extract + parse-validate chokepoint as a
  // quick generation, so an unparseable result can never be written to
  // a cell — it surfaces an error instead.
  const applyFormulaFromSkill = useCallback(
    (text: string) => {
      const formula = extractFormula(text);
      const result: FormulaValidation =
        formula === null
          ? { ok: false, error: "The skill did not return a usable formula." }
          : validateGeneratedFormula(formula);
      if (result.ok) {
        setSkillError(null);
        onInsertFormula(result.formula);
        onClose();
      } else {
        setSkillError(result.error);
      }
    },
    [onInsertFormula, onClose],
  );

  // Switching modes cancels an in-flight quick generation (so it can't
  // keep streaming invisibly once the Stop button is hidden in skills
  // mode) and clears stale quick state (candidate/output/error) and the
  // skill error. The skill chain is torn down by SkillRunnerPanel's
  // unmount when leaving skills mode.
  const switchSheetMode = useCallback(
    (next: SheetPanelMode) => {
      if (next === panelMode) return;
      // Cancel settles the in-flight quick stream (issues model:cancelJob
      // AND resolves the local hook) so `reset` below can clear it.
      if (next === "skills" && isStreaming) cancel();
      setCandidate(null);
      reset();
      setSkillError(null);
      setPanelMode(next);
    },
    [panelMode, isStreaming, cancel, reset],
  );

  const hasFormula = !!activeFormula && activeFormula.trim().startsWith("=");
  const canRun =
    available &&
    !isStreaming &&
    (action === "generate"
      ? request.trim() !== ""
      : action === "summarize"
        ? rows.length > 0
        : hasFormula);

  const buildPrompt = useCallback((): string => {
    const ctx = buildContext(columns, rows, { activeCellRef, selectionRef });
    switch (action) {
      case "generate":
        return buildFormulaPrompt(request, ctx);
      case "explain":
        return buildExplainPrompt(activeFormula ?? "");
      case "fix":
        return buildFixPrompt(activeFormula ?? "");
      case "summarize":
        return buildSummarizePrompt(ctx);
    }
  }, [
    action,
    columns,
    rows,
    activeCellRef,
    selectionRef,
    request,
    activeFormula,
  ]);

  const handleRun = useCallback(async () => {
    setCandidate(null);
    reset();
    let text: string;
    try {
      text = await run(buildPrompt());
    } catch {
      // The hook already surfaced the message via `error`.
      return;
    }
    if (PRODUCES_FORMULA(action)) {
      const formula = extractFormula(text);
      setCandidate(
        formula === null
          ? { ok: false, error: "The model did not return a usable formula." }
          : validateGeneratedFormula(formula),
      );
    }
  }, [action, buildPrompt, run, reset]);

  const handleInsert = useCallback(() => {
    if (candidate?.ok) {
      onInsertFormula(candidate.formula);
      onClose();
    }
  }, [candidate, onInsertFormula, onClose]);

  return (
    <section
      className="sheet-cf-panel sheet-ai-panel"
      data-testid="sheet-ai-panel"
      aria-label="AI assistant"
    >
      <div className="sheet-cf-header">
        <span className="sheet-cf-title">AI assistant</span>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close AI assistant"
        >
          ×
        </button>
      </div>

      {sheetSkills.length > 0 && (
        <div
          className="sheet-ai-actions sheet-ai-modes"
          role="group"
          aria-label="Assistant mode"
        >
          <button
            type="button"
            className={panelMode === "quick" ? "btn-sm active" : "btn-sm"}
            aria-pressed={panelMode === "quick"}
            disabled={isStreaming}
            data-testid="sheet-ai-mode-quick"
            onClick={() => switchSheetMode("quick")}
          >
            Quick actions
          </button>
          <button
            type="button"
            className={panelMode === "skills" ? "btn-sm active" : "btn-sm"}
            aria-pressed={panelMode === "skills"}
            disabled={isStreaming}
            data-testid="sheet-ai-mode-skills"
            onClick={() => switchSheetMode("skills")}
          >
            Skill
          </button>
        </div>
      )}

      {panelMode === "skills" && selectedSkill ? (
        <>
          {sheetSkills.length > 1 && (
            <label className="sheet-cf-field">
              <span className="sheet-cf-label">Skill</span>
              <select
                className="input"
                value={skillId}
                onChange={(e) => setSkillId(e.target.value)}
                aria-label="Choose a skill"
              >
                {sheetSkills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <SkillRunnerPanel
            key={selectedSkill.id}
            skill={selectedSkill}
            onApply={applyFormulaFromSkill}
            applyLabel={`Insert into ${activeCellRef ?? "cell"}`}
          />
          {skillError && (
            <p
              className="sheet-nr-error"
              role="alert"
              data-testid="sheet-ai-skill-error"
            >
              {skillError}
            </p>
          )}
        </>
      ) : (
        <>
          <div
            className="sheet-ai-actions"
            role="tablist"
            aria-label="AI action"
          >
            {ACTIONS.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={action === a.id}
                className={action === a.id ? "btn-sm active" : "btn-sm"}
                onClick={() => {
                  setAction(a.id);
                  setCandidate(null);
                }}
              >
                {a.label}
              </button>
            ))}
          </div>

          {action === "generate" && (
            <label className="sheet-cf-field">
              <span className="sheet-cf-label">
                Describe the formula you want
                {activeCellRef ? ` (for ${activeCellRef})` : ""}
              </span>
              <textarea
                className="sheet-ai-input"
                data-testid="sheet-ai-request"
                rows={2}
                value={request}
                placeholder="sum of column B where column C is 'paid'"
                onChange={(e) => setRequest(e.target.value)}
              />
            </label>
          )}

          {(action === "explain" || action === "fix") &&
            (hasFormula ? (
              <p className="sheet-ai-target" data-testid="sheet-ai-target">
                <code>{activeFormula}</code>
              </p>
            ) : (
              <p className="sheet-cf-empty">
                Select a cell that contains a formula first.
              </p>
            ))}

          {action === "summarize" && (
            <p className="sheet-cf-empty">
              Summarizes {selectionRef ? `range ${selectionRef}` : "the sheet"}.
            </p>
          )}

          <div className="sheet-ai-controls">
            <button
              type="button"
              className="btn-sm primary"
              data-testid="sheet-ai-run"
              disabled={!canRun}
              onClick={() => void handleRun()}
            >
              {isStreaming ? "Generating…" : "Run"}
            </button>
            <StopGenerationButton />
          </div>

          {!available && (
            <p className="sheet-nr-error" role="alert">
              The on-device model is not available. Start it from settings to
              use the assistant.
            </p>
          )}

          {error && (
            <p
              className="sheet-nr-error"
              role="alert"
              data-testid="sheet-ai-error"
            >
              {error}
            </p>
          )}

          {output && (
            <div
              className="sheet-ai-output"
              data-testid="sheet-ai-output"
              aria-live="polite"
            >
              {output}
            </div>
          )}

          {PRODUCES_FORMULA(action) && candidate && (
            <div className="sheet-ai-result">
              {candidate.ok ? (
                <>
                  <code
                    className="sheet-ai-formula"
                    data-testid="sheet-ai-formula"
                  >
                    {candidate.formula}
                  </code>
                  <button
                    type="button"
                    className="btn-sm primary"
                    data-testid="sheet-ai-insert"
                    onClick={handleInsert}
                  >
                    Insert into {activeCellRef ?? "cell"}
                  </button>
                </>
              ) : (
                <p className="sheet-nr-error" role="alert">
                  {candidate.error}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
