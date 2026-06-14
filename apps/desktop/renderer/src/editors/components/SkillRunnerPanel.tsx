/**
 * Presentational panel for running a deliberate, multi-step Skill on the
 * on-device model.
 *
 * Unlike the single-shot "quick actions" in {@link AiAssistantPanel}, a
 * Skill chains several model calls (plan → draft → critique → revise, …)
 * so a small local model produces higher-quality output. This component
 * collects the skill's declared inputs, drives {@link useSkillRunner},
 * shows live per-step progress, and hands the final output back to the
 * host editor via `onApply`.
 *
 * Surface-agnostic: it renders whatever `skill` it is given, so the same
 * component backs Document / Slide / Sheet / Base skill panels. The host
 * decides what "apply" means for its surface.
 */

import { useCallback, useMemo, useState } from "react";
import { useSkillRunner } from "../../skills/useSkillRunner";
import type { Skill } from "../../skills/skillTypes";

export interface SkillRunnerPanelProps {
  /** The skill to run. */
  skill: Skill;
  /** Apply the skill's final output to the host surface. */
  onApply?: (text: string) => void;
  /** Label for the apply button (defaults to "Insert"). */
  applyLabel?: string;
}

function blankInputs(skill: Skill): Record<string, string> {
  const seed: Record<string, string> = {};
  for (const input of skill.inputs) seed[input.id] = "";
  return seed;
}

export function SkillRunnerPanel({
  skill,
  onApply,
  applyLabel = "Insert",
}: SkillRunnerPanelProps) {
  const runner = useSkillRunner(skill);
  const [inputs, setInputs] = useState<Record<string, string>>(() =>
    blankInputs(skill),
  );

  // Re-seed inputs whenever the selected skill changes.
  const seededFor = useMemo(() => skill.id, [skill.id]);
  const [seedKey, setSeedKey] = useState(seededFor);
  if (seedKey !== seededFor) {
    setSeedKey(seededFor);
    setInputs(blankInputs(skill));
    runner.reset();
  }

  const setInput = useCallback((id: string, value: string) => {
    setInputs((prev) => ({ ...prev, [id]: value }));
  }, []);

  const run = useCallback(() => {
    runner.run(inputs);
  }, [runner, inputs]);

  const missing = new Set(runner.missingInputs);

  return (
    <div
      className="skill-panel"
      data-testid="skill-runner-panel"
      role="group"
      aria-label={`${skill.name} skill`}
    >
      <p className="ai-panel-hint skill-panel-desc">{skill.description}</p>

      {skill.inputs.map((input) => {
        const fieldId = `skill-input-${input.id}`;
        const invalid = missing.has(input.id);
        return (
          <label key={input.id} className="ai-panel-field" htmlFor={fieldId}>
            <span>
              {input.label}
              {input.required ? <span aria-hidden="true"> *</span> : null}
            </span>
            {input.multiline ? (
              <textarea
                id={fieldId}
                className="ai-panel-prompt"
                rows={3}
                value={inputs[input.id] ?? ""}
                placeholder={input.placeholder}
                aria-required={input.required}
                aria-invalid={invalid}
                onChange={(e) => setInput(input.id, e.target.value)}
              />
            ) : (
              <input
                id={fieldId}
                type="text"
                value={inputs[input.id] ?? ""}
                placeholder={input.placeholder}
                aria-required={input.required}
                aria-invalid={invalid}
                onChange={(e) => setInput(input.id, e.target.value)}
              />
            )}
          </label>
        );
      })}

      <div className="ai-panel-run-row">
        <button
          type="button"
          className="btn btn-primary"
          onClick={run}
          disabled={runner.isRunning}
          data-testid="skill-run"
        >
          {runner.isRunning ? "Running…" : "Run skill"}
        </button>
        {runner.isRunning && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={runner.cancel}
            data-testid="skill-stop"
          >
            Stop
          </button>
        )}
        <span className="ai-panel-shortcut">
          {skill.steps.length} steps
        </span>
      </div>

      {runner.status === "error" && (
        <p className="ai-panel-error" role="alert" data-testid="skill-error">
          {runner.error ?? "The skill failed to run."}
        </p>
      )}
      {runner.status === "battery_low" && (
        <p className="ai-panel-error" role="alert">
          Generation paused — device battery is below 20%.
        </p>
      )}
      {runner.status === "cancelled" && (
        <p className="ai-panel-hint">Skill stopped.</p>
      )}

      {(runner.isRunning || runner.steps.length > 0) && (
        <ol className="skill-step-list" data-testid="skill-steps">
          {skill.steps.map((step, index) => {
            const done = index < runner.steps.length;
            const active = runner.isRunning && index === runner.currentStepIndex;
            const state = done ? "done" : active ? "active" : "pending";
            const stateLabel =
              state === "done"
                ? "Done"
                : state === "active"
                  ? "Running…"
                  : "Queued";
            return (
              <li
                key={step.id}
                className={`skill-step skill-step-${state}`}
                data-testid={`skill-step-${step.id}`}
              >
                <div className="skill-step-head">
                  <span className="skill-step-title">{step.title}</span>
                  <span className="skill-step-state">{stateLabel}</span>
                </div>
                {done && (
                  <details className="skill-step-output">
                    <summary>View output</summary>
                    <div className="ai-result-text">
                      {runner.steps[index].output}
                    </div>
                  </details>
                )}
                {active && runner.liveOutput.length > 0 && (
                  <div
                    className="ai-result-text skill-step-live"
                    aria-live="polite"
                  >
                    {runner.liveOutput}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {runner.status === "done" && runner.finalOutput.length > 0 && (
        <>
          <div className="ai-panel-result" data-testid="skill-final">
            <div className="ai-result-text">{runner.finalOutput}</div>
          </div>
          {onApply && (
            <div
              className="ai-panel-apply"
              role="group"
              aria-label="Apply skill result"
            >
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => onApply(runner.finalOutput)}
                data-testid="skill-apply"
              >
                {applyLabel}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={run}
                title="Run again"
              >
                Retry
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
