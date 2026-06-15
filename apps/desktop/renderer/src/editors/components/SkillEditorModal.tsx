/**
 * Authoring form for a user-defined ("custom") skill.
 *
 * A thin form over {@link Modal} that edits a {@link CustomSkillDraft} (name,
 * description, target surfaces, declared inputs, and the ordered steps) and,
 * on save, builds + persists it through {@link useCustomSkills}. All of the
 * normalisation and validation lives in `customSkills.ts`; this component only
 * collects the draft and surfaces the build errors, so it stays presentational
 * and easy to test.
 *
 * The same modal backs every entry point (New / Edit / Duplicate): the host
 * passes a seed draft and a title, and is told the persisted skill on success.
 */

import { useMemo, useState } from "react";
import Modal from "../../components/Modal";
import {
  ALL_SKILL_SURFACES,
  ALL_STEP_KINDS,
  MAX_CHECK_MAX_CHARS,
  MAX_CHECK_MIN_LINES,
  MAX_MAX_TOKENS,
  MAX_SKILL_INPUTS,
  MAX_SKILL_STEPS,
  MAX_TEMPERATURE,
  MIN_MAX_TOKENS,
  MIN_TEMPERATURE,
  availableVarsBeforeStep,
  emptyCheckDraft,
  emptyInputDraft,
  emptyStepDraft,
  slugifyVar,
  type CustomCheckDraft,
  type CustomSkillDraft,
} from "../../skills/customSkills";
import { useCustomSkills } from "../../skills/useCustomSkills";
import type {
  Skill,
  SkillStepKind,
  SkillSurface,
} from "../../skills/skillTypes";

const SURFACE_LABELS: Record<SkillSurface, string> = {
  document: "Documents",
  slide: "Slides",
  sheet: "Sheets",
  base: "Base",
};

const KIND_LABELS: Record<SkillStepKind, string> = {
  plan: "Plan",
  draft: "Draft",
  critique: "Critique",
  revise: "Revise",
  extract: "Extract",
  format: "Format",
};

export interface SkillEditorModalProps {
  isOpen: boolean;
  /**
   * Seed draft: `emptyDraft(surface)` for a new skill, `skillToDraft(skill)`
   * to edit, or a copy with `id` cleared to duplicate. A NEW object reference
   * each time the modal opens re-seeds the form (see the render-phase reset).
   */
  initialDraft: CustomSkillDraft;
  /** Header text (e.g. "New skill" / "Edit skill"). */
  title: string;
  onClose: () => void;
  /** Called with the persisted skill after a successful save. */
  onSaved: (skill: Skill) => void;
}

/** Deep-enough clone so editing the local draft never mutates the seed. */
function cloneDraft(d: CustomSkillDraft): CustomSkillDraft {
  return {
    id: d.id,
    name: d.name,
    description: d.description,
    surfaces: [...d.surfaces],
    inputs: d.inputs.map((i) => ({ ...i })),
    steps: d.steps.map((s) => ({
      ...s,
      inputsFrom: [...s.inputsFrom],
      check: { ...(s.check ?? emptyCheckDraft()) },
    })),
  };
}

export function SkillEditorModal({
  isOpen,
  initialDraft,
  title,
  onClose,
  onSaved,
}: SkillEditorModalProps) {
  const { saveSkill } = useCustomSkills();
  const [draft, setDraft] = useState<CustomSkillDraft>(() =>
    cloneDraft(initialDraft),
  );
  const [errors, setErrors] = useState<string[]>([]);

  // Re-seed the form whenever the host hands us a fresh draft (a new open, or
  // a switch between New/Edit/Duplicate). Render-phase reset mirrors
  // SkillRunnerPanel — cheaper than an effect and avoids a flash of stale data.
  const [seed, setSeed] = useState(initialDraft);
  if (seed !== initialDraft) {
    setSeed(initialDraft);
    setDraft(cloneDraft(initialDraft));
    setErrors([]);
  }

  const patch = (next: Partial<CustomSkillDraft>) =>
    setDraft((d) => ({ ...d, ...next }));

  const toggleSurface = (surface: SkillSurface) =>
    setDraft((d) => ({
      ...d,
      surfaces: d.surfaces.includes(surface)
        ? d.surfaces.filter((s) => s !== surface)
        : [...d.surfaces, surface],
    }));

  const updateInput = (
    index: number,
    next: Partial<CustomSkillDraft["inputs"][number]>,
  ) =>
    setDraft((d) => ({
      ...d,
      inputs: d.inputs.map((row, i) =>
        i === index ? { ...row, ...next } : row,
      ),
    }));
  const addInput = () =>
    setDraft((d) =>
      d.inputs.length >= MAX_SKILL_INPUTS
        ? d
        : { ...d, inputs: [...d.inputs, emptyInputDraft()] },
    );
  const removeInput = (index: number) =>
    setDraft((d) => ({ ...d, inputs: d.inputs.filter((_, i) => i !== index) }));

  const updateStep = (
    index: number,
    next: Partial<CustomSkillDraft["steps"][number]>,
  ) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((row, i) => (i === index ? { ...row, ...next } : row)),
    }));
  const addStep = () =>
    setDraft((d) =>
      d.steps.length >= MAX_SKILL_STEPS
        ? d
        : { ...d, steps: [...d.steps, emptyStepDraft()] },
    );
  const removeStep = (index: number) =>
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, i) => i !== index) }));
  const toggleStepInput = (index: number, varName: string) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((row, i) => {
        if (i !== index) return row;
        const has = row.inputsFrom.includes(varName);
        return {
          ...row,
          inputsFrom: has
            ? row.inputsFrom.filter((v) => v !== varName)
            : [...row.inputsFrom, varName],
        };
      }),
    }));
  const updateStepCheck = (index: number, next: Partial<CustomCheckDraft>) =>
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((row, i) =>
        i === index
          ? { ...row, check: { ...(row.check ?? emptyCheckDraft()), ...next } }
          : row,
      ),
    }));

  const inputTokens = useMemo(
    () => draft.inputs.map((row) => slugifyVar(row.id || row.label)),
    [draft.inputs],
  );

  const handleSave = () => {
    const result = saveSkill(draft);
    if (result.ok) {
      onSaved(result.skill);
      onClose();
    } else {
      setErrors(result.errors);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      closeOnOverlayClick={false}
    >
      <div className="skill-editor" data-testid="skill-editor">
        <label className="ai-panel-field">
          <span>Name</span>
          <input
            type="text"
            className="input"
            value={draft.name}
            onChange={(e) => patch({ name: e.target.value })}
            placeholder="e.g. Investor-ready summary"
            data-testid="skill-editor-name"
            aria-label="Skill name"
          />
        </label>

        <label className="ai-panel-field">
          <span>Description</span>
          <input
            type="text"
            className="input"
            value={draft.description}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="What this skill produces"
            data-testid="skill-editor-description"
            aria-label="Skill description"
          />
        </label>

        <fieldset className="skill-editor-fieldset">
          <legend>Surfaces</legend>
          <div className="skill-editor-surfaces">
            {ALL_SKILL_SURFACES.map((surface) => (
              <label key={surface} className="skill-editor-check">
                <input
                  type="checkbox"
                  checked={draft.surfaces.includes(surface)}
                  onChange={() => toggleSurface(surface)}
                  data-testid={`skill-editor-surface-${surface}`}
                />
                <span>{SURFACE_LABELS[surface]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="skill-editor-fieldset">
          <legend>Inputs</legend>
          <p className="ai-panel-hint">
            Fields the user fills in before running. Reference them in a step
            with the variable shown next to each one.
          </p>
          {draft.inputs.map((row, i) => (
            <div
              key={i}
              className="skill-editor-row"
              data-testid={`skill-editor-input-${i}`}
            >
              <div className="skill-editor-row-main">
                <input
                  type="text"
                  className="input"
                  value={row.label}
                  onChange={(e) => updateInput(i, { label: e.target.value })}
                  placeholder="Label (e.g. Topic)"
                  data-testid={`skill-editor-input-${i}-label`}
                  aria-label={`Input ${i + 1} label`}
                />
                <code
                  className="skill-editor-var"
                  aria-label={`Input ${i + 1} variable`}
                >
                  {inputTokens[i] ? `{{${inputTokens[i]}}}` : "{{…}}"}
                </code>
                <button
                  type="button"
                  className="btn btn-ghost skill-editor-remove"
                  onClick={() => removeInput(i)}
                  data-testid={`skill-editor-input-${i}-remove`}
                  aria-label={`Remove input ${i + 1}`}
                >
                  Remove
                </button>
              </div>
              <div className="skill-editor-row-opts">
                <label className="skill-editor-check">
                  <input
                    type="checkbox"
                    checked={row.required}
                    onChange={(e) =>
                      updateInput(i, { required: e.target.checked })
                    }
                    data-testid={`skill-editor-input-${i}-required`}
                  />
                  <span>Required</span>
                </label>
                <label className="skill-editor-check">
                  <input
                    type="checkbox"
                    checked={row.multiline}
                    onChange={(e) =>
                      updateInput(i, { multiline: e.target.checked })
                    }
                    data-testid={`skill-editor-input-${i}-multiline`}
                  />
                  <span>Multi-line</span>
                </label>
              </div>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-secondary skill-editor-add"
            onClick={addInput}
            disabled={draft.inputs.length >= MAX_SKILL_INPUTS}
            data-testid="skill-editor-add-input"
          >
            Add input
          </button>
        </fieldset>

        <fieldset className="skill-editor-fieldset">
          <legend>Steps</legend>
          <p className="ai-panel-hint">
            Each step is one focused model call. Its output becomes a variable
            later steps can attach as material.
          </p>
          {draft.steps.map((row, i) => {
            const available = availableVarsBeforeStep(draft, i);
            const outputToken = slugifyVar(row.output) || `step_${i + 1}`;
            const check = row.check ?? emptyCheckDraft();
            return (
              <div
                key={i}
                className="skill-editor-step"
                data-testid={`skill-editor-step-${i}`}
              >
                <div className="skill-editor-row-main">
                  <input
                    type="text"
                    className="input"
                    value={row.title}
                    onChange={(e) => updateStep(i, { title: e.target.value })}
                    placeholder={`Step ${i + 1} title`}
                    data-testid={`skill-editor-step-${i}-title`}
                    aria-label={`Step ${i + 1} title`}
                  />
                  <select
                    className="input skill-editor-kind"
                    value={row.kind}
                    onChange={(e) =>
                      updateStep(i, { kind: e.target.value as SkillStepKind })
                    }
                    data-testid={`skill-editor-step-${i}-kind`}
                    aria-label={`Step ${i + 1} kind`}
                  >
                    {ALL_STEP_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {KIND_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn btn-ghost skill-editor-remove"
                    onClick={() => removeStep(i)}
                    data-testid={`skill-editor-step-${i}-remove`}
                    aria-label={`Remove step ${i + 1}`}
                  >
                    Remove
                  </button>
                </div>
                <label className="ai-panel-field">
                  <span>Instruction</span>
                  <textarea
                    className="ai-panel-prompt"
                    rows={3}
                    value={row.instruction}
                    onChange={(e) =>
                      updateStep(i, { instruction: e.target.value })
                    }
                    placeholder="What the model should do in this step"
                    data-testid={`skill-editor-step-${i}-instruction`}
                    aria-label={`Step ${i + 1} instruction`}
                  />
                </label>
                {available.length > 0 && (
                  <div
                    className="skill-editor-from"
                    role="group"
                    aria-label={`Step ${i + 1} attached material`}
                  >
                    <span className="ai-panel-hint">
                      Attach earlier material:
                    </span>
                    {available.map((varName) => (
                      <label key={varName} className="skill-editor-check">
                        <input
                          type="checkbox"
                          checked={row.inputsFrom.includes(varName)}
                          onChange={() => toggleStepInput(i, varName)}
                          data-testid={`skill-editor-step-${i}-from-${varName}`}
                        />
                        <code>{`{{${varName}}}`}</code>
                      </label>
                    ))}
                  </div>
                )}
                <label className="ai-panel-field">
                  <span>
                    Output variable{" "}
                    <code className="skill-editor-var">{`{{${outputToken}}}`}</code>
                  </span>
                  <input
                    type="text"
                    className="input"
                    value={row.output}
                    onChange={(e) => updateStep(i, { output: e.target.value })}
                    placeholder="e.g. outline"
                    data-testid={`skill-editor-step-${i}-output`}
                    aria-label={`Step ${i + 1} output variable`}
                  />
                </label>
                <details
                  className="skill-editor-contract-group"
                  data-testid={`skill-editor-step-${i}-contract`}
                >
                  <summary>
                    Output format contract
                    {row.outputContract.trim() ? " (set)" : " (optional)"}
                  </summary>
                  <p className="ai-panel-hint">
                    Appended to this step&rsquo;s prompt to pin the exact output
                    shape (e.g. &ldquo;FORMAT: 3&ndash;6 &lsquo;- &rsquo;
                    bullets, no prose&rdquo;). Tight format discipline is the
                    single biggest reliability lever for a small local model.
                  </p>
                  <label className="ai-panel-field">
                    <span>Required output format</span>
                    <textarea
                      className="ai-panel-prompt"
                      rows={2}
                      value={row.outputContract}
                      onChange={(e) =>
                        updateStep(i, { outputContract: e.target.value })
                      }
                      placeholder="e.g. FORMAT: one '- ' bullet per line, no sub-bullets, no prose."
                      data-testid={`skill-editor-step-${i}-contract-text`}
                      aria-label={`Step ${i + 1} output format contract`}
                    />
                  </label>
                </details>
                <details
                  className="skill-editor-sampling-group"
                  data-testid={`skill-editor-step-${i}-sampling`}
                >
                  <summary>Model sampling (optional)</summary>
                  <p className="ai-panel-hint">
                    Tune how the model samples this step. Leave blank to use the
                    sensible default for a {KIND_LABELS[row.kind].toLowerCase()}{" "}
                    step.
                  </p>
                  <div className="skill-editor-check-grid">
                    <label className="ai-panel-field skill-editor-check-num">
                      <span>Temperature</span>
                      <input
                        type="number"
                        min={MIN_TEMPERATURE}
                        max={MAX_TEMPERATURE}
                        step={0.1}
                        className="input"
                        value={row.temperature ?? ""}
                        onChange={(e) =>
                          updateStep(i, { temperature: e.target.value })
                        }
                        placeholder="—"
                        data-testid={`skill-editor-step-${i}-temperature`}
                        aria-label={`Step ${i + 1} temperature`}
                      />
                    </label>
                    <label className="ai-panel-field skill-editor-check-num">
                      <span>Max tokens</span>
                      <input
                        type="number"
                        min={MIN_MAX_TOKENS}
                        max={MAX_MAX_TOKENS}
                        className="input"
                        value={row.maxTokens ?? ""}
                        onChange={(e) =>
                          updateStep(i, { maxTokens: e.target.value })
                        }
                        placeholder="—"
                        data-testid={`skill-editor-step-${i}-maxtokens`}
                        aria-label={`Step ${i + 1} max tokens`}
                      />
                    </label>
                  </div>
                </details>
                <details
                  className="skill-editor-check-group"
                  data-testid={`skill-editor-step-${i}-check`}
                >
                  <summary>Acceptance check (optional)</summary>
                  <p className="ai-panel-hint">
                    Reject this step&rsquo;s output unless it passes these
                    deterministic rules. A failed check triggers one automatic
                    repair attempt before the result is kept.
                  </p>
                  <div className="skill-editor-check-grid">
                    <label className="skill-editor-check">
                      <input
                        type="checkbox"
                        checked={check.nonEmpty}
                        onChange={(e) =>
                          updateStepCheck(i, { nonEmpty: e.target.checked })
                        }
                        data-testid={`skill-editor-step-${i}-check-nonempty`}
                      />
                      <span>Must not be empty</span>
                    </label>
                    <label className="skill-editor-check">
                      <input
                        type="checkbox"
                        checked={check.forbidFences}
                        onChange={(e) =>
                          updateStepCheck(i, { forbidFences: e.target.checked })
                        }
                        data-testid={`skill-editor-step-${i}-check-forbidfences`}
                      />
                      <span>No Markdown code fences</span>
                    </label>
                  </div>
                  <div className="skill-editor-check-grid">
                    <label className="ai-panel-field skill-editor-check-num">
                      <span>Min non-empty lines</span>
                      <input
                        type="number"
                        min={1}
                        max={MAX_CHECK_MIN_LINES}
                        className="input"
                        value={check.minLines}
                        onChange={(e) =>
                          updateStepCheck(i, { minLines: e.target.value })
                        }
                        placeholder="—"
                        data-testid={`skill-editor-step-${i}-check-minlines`}
                        aria-label={`Step ${i + 1} minimum non-empty lines`}
                      />
                    </label>
                    <label className="ai-panel-field skill-editor-check-num">
                      <span>Max characters</span>
                      <input
                        type="number"
                        min={1}
                        max={MAX_CHECK_MAX_CHARS}
                        className="input"
                        value={check.maxChars}
                        onChange={(e) =>
                          updateStepCheck(i, { maxChars: e.target.value })
                        }
                        placeholder="—"
                        data-testid={`skill-editor-step-${i}-check-maxchars`}
                        aria-label={`Step ${i + 1} maximum characters`}
                      />
                    </label>
                  </div>
                  <label className="ai-panel-field">
                    <span>Must start with</span>
                    <input
                      type="text"
                      className="input"
                      value={check.mustStartWith}
                      onChange={(e) =>
                        updateStepCheck(i, { mustStartWith: e.target.value })
                      }
                      placeholder="e.g. ="
                      data-testid={`skill-editor-step-${i}-check-startswith`}
                      aria-label={`Step ${i + 1} must start with`}
                    />
                  </label>
                  <label className="ai-panel-field">
                    <span>Must include (one per line)</span>
                    <textarea
                      className="ai-panel-prompt"
                      rows={2}
                      value={check.mustInclude}
                      onChange={(e) =>
                        updateStepCheck(i, { mustInclude: e.target.value })
                      }
                      placeholder="Each line is a required substring"
                      data-testid={`skill-editor-step-${i}-check-include`}
                      aria-label={`Step ${i + 1} required substrings`}
                    />
                  </label>
                  <label className="ai-panel-field">
                    <span>Must not include (one per line)</span>
                    <textarea
                      className="ai-panel-prompt"
                      rows={2}
                      value={check.forbidContains}
                      onChange={(e) =>
                        updateStepCheck(i, { forbidContains: e.target.value })
                      }
                      placeholder="Each line is a forbidden substring"
                      data-testid={`skill-editor-step-${i}-check-forbid`}
                      aria-label={`Step ${i + 1} forbidden substrings`}
                    />
                  </label>
                </details>
              </div>
            );
          })}
          <button
            type="button"
            className="btn btn-secondary skill-editor-add"
            onClick={addStep}
            disabled={draft.steps.length >= MAX_SKILL_STEPS}
            data-testid="skill-editor-add-step"
          >
            Add step
          </button>
        </fieldset>

        {errors.length > 0 && (
          <div
            className="ai-panel-error skill-editor-errors"
            role="alert"
            data-testid="skill-editor-errors"
          >
            <ul>
              {errors.map((err, i) => (
                <li key={i} data-testid="skill-editor-error">
                  {err}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ai-panel-run-row skill-editor-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            data-testid="skill-editor-save"
          >
            Save skill
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            data-testid="skill-editor-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
