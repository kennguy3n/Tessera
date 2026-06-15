/**
 * Pure compiler for the Skills / Instruction-Template engine.
 *
 * No React / IPC / DOM imports — every function here is a deterministic
 * data transform so the test suite can pin behaviour without a renderer
 * or a running model. The thin `useSkillRunner` hook calls into this
 * for: seeding the initial context from user inputs, compiling each
 * step into a self-contained prompt, cleaning the model's raw output,
 * and threading that output back into the context for later steps.
 *
 * The design goal is to make a SMALL on-device model reliable by
 * decomposition: each step is one narrow sub-task with a strict output
 * contract, and the engine — not the model — owns the control flow.
 */

import type {
  CompiledStep,
  Skill,
  SkillContext,
  SkillInputSpec,
  SkillStep,
  SkillStepKind,
} from "./skillTypes";

// ─────────────────────────────────────────────────────────────────────
// Bounds. Every interpolated value and resolved parameter is clamped so
// a pathological input (a giant pasted selection, a bad slider value)
// can never blow up a prompt or the saved run state.
// ─────────────────────────────────────────────────────────────────────

/** Max characters of any single interpolated / appended context value. */
export const MAX_CONTEXT_VALUE_CHARS = 8000;
/** Clamp range for a step's sampling temperature (matches IPC schema). */
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;
/** Clamp range for a step's max-token budget. Per-step stays modest so
 * a chain of steps cannot blow the per-request IPC ceiling (32k). */
export const MIN_MAX_TOKENS = 1;
export const MAX_MAX_TOKENS = 4096;

/**
 * Default sampling temperature per step kind. Planning, critique, and
 * extraction want determinism (low temperature); drafting wants room to
 * write; revise/format sit in between.
 */
export const DEFAULT_STEP_TEMPERATURE: Record<SkillStepKind, number> = {
  plan: 0.3,
  draft: 0.7,
  critique: 0.2,
  revise: 0.4,
  extract: 0.1,
  format: 0.2,
};

/** Default max-token budget per step kind. */
export const DEFAULT_STEP_MAX_TOKENS: Record<SkillStepKind, number> = {
  plan: 512,
  draft: 1536,
  critique: 512,
  revise: 1536,
  extract: 768,
  format: 1024,
};

/**
 * Terse, role-specific system preamble per step kind. Small models stay
 * on task when the instruction is explicit about "return ONLY the
 * result" — the same lesson `documentAiHelpers.SYSTEM_PREAMBLE` encodes
 * for the single-shot path, specialised per deliberate role.
 */
export const STEP_PREAMBLES: Record<SkillStepKind, string> = {
  plan:
    "You are planning before writing. Think about the task and produce " +
    "ONLY the plan in the exact format requested — concrete, ordered, and " +
    "brief. No preamble, no prose outside the plan.",
  draft:
    "You are drafting. Follow the plan exactly and use the supplied " +
    "material. Return ONLY the drafted text — no preamble, no commentary, " +
    "no markdown code fences.",
  critique:
    "You are a strict reviewer. Identify concrete, specific problems only " +
    "(unsupported claims, vague wording, missing points, errors). Do not " +
    "rewrite the text. Return ONLY the critique in the requested format.",
  revise:
    "You are revising. Apply every point of the critique to the draft " +
    "while preserving its meaning and intent. Return ONLY the revised " +
    "text — no commentary, no markdown code fences.",
  extract:
    "You extract structured information. Use only what is present in the " +
    "supplied material. Return ONLY the requested structure.",
  format:
    "You reformat text without changing its meaning. Return ONLY the " +
    "reformatted result, with no preamble and no code fences.",
};

// ─────────────────────────────────────────────────────────────────────
// Interpolation
// ─────────────────────────────────────────────────────────────────────

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Clamp a value so one huge string can't dominate a prompt. */
function clampValue(value: string): string {
  if (value.length <= MAX_CONTEXT_VALUE_CHARS) return value;
  return value.slice(0, MAX_CONTEXT_VALUE_CHARS);
}

/**
 * Replace `{{var}}` placeholders in `template` with values from `ctx`.
 * Unknown placeholders collapse to an empty string (so a half-authored
 * skill degrades gracefully rather than leaking `{{var}}` into a
 * prompt). Each substituted value is clamped to `MAX_CONTEXT_VALUE_CHARS`.
 * Pure and deterministic.
 */
export function interpolate(template: string, ctx: SkillContext): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    const value = ctx[name];
    return typeof value === "string" ? clampValue(value) : "";
  });
}

/** List the distinct `{{var}}` names referenced by a template. */
export function referencedVars(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER_RE)) {
    names.add(match[1]);
  }
  return [...names];
}

/**
 * Humanise a context-variable id into a prompt block label, e.g.
 * `"draft_text"` → `"DRAFT TEXT"`. Used to label `inputsFrom` material
 * blocks so the model can tell instruction from working material.
 */
export function humanizeVarName(id: string): string {
  return id.replace(/[_-]+/g, " ").trim().toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────
// Context seeding
// ─────────────────────────────────────────────────────────────────────

/** Clamp a temperature into the supported range; NaN → kind default. */
export function clampTemperature(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_TEMPERATURE, Math.min(MAX_TEMPERATURE, value));
}

/** Clamp a max-token budget into the supported range; NaN → fallback. */
export function clampMaxTokens(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(MIN_MAX_TOKENS, Math.min(MAX_MAX_TOKENS, Math.round(value)));
}

/**
 * Seed the run context from the user-supplied input values. Only keys
 * declared on the skill's `inputs` are admitted (so a stray field can't
 * inject an arbitrary variable), each clamped to the value ceiling.
 */
export function initialContext(
  skill: Skill,
  rawInputs: Record<string, string>,
): SkillContext {
  const ctx: SkillContext = {};
  for (const spec of skill.inputs) {
    const value = rawInputs[spec.id];
    ctx[spec.id] = typeof value === "string" ? clampValue(value) : "";
  }
  return ctx;
}

/**
 * Which required inputs are still missing (empty after trim). The runner
 * blocks the run until this returns an empty array.
 */
export function missingRequiredInputs(
  skill: Skill,
  rawInputs: Record<string, string>,
): SkillInputSpec[] {
  return skill.inputs.filter(
    (spec) => spec.required && !(rawInputs[spec.id] ?? "").trim(),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Step compilation
// ─────────────────────────────────────────────────────────────────────

/**
 * Compile one step against the current context into a self-contained
 * prompt + resolved sampling parameters.
 *
 * Prompt layout (deterministic, snapshot-testable):
 *
 *   <role preamble for step.kind>
 *
 *   <interpolated instruction>
 *
 *   <LABEL>:                     // one block per non-empty inputsFrom var
 *   <value>
 *
 *   <outputContract>             // verbatim, if present
 */
export function compileStep(step: SkillStep, ctx: SkillContext): CompiledStep {
  const parts: string[] = [STEP_PREAMBLES[step.kind], "", interpolate(step.instruction, ctx).trim()];

  for (const varName of step.inputsFrom ?? []) {
    const value = (ctx[varName] ?? "").trim();
    if (value.length === 0) continue;
    parts.push("", `${humanizeVarName(varName)}:`, clampValue(value));
  }

  if (step.outputContract && step.outputContract.trim().length > 0) {
    parts.push("", step.outputContract.trim());
  }

  return {
    id: step.id,
    title: step.title,
    kind: step.kind,
    prompt: parts.join("\n"),
    temperature: clampTemperature(
      step.temperature ?? DEFAULT_STEP_TEMPERATURE[step.kind],
      DEFAULT_STEP_TEMPERATURE[step.kind],
    ),
    maxTokens: clampMaxTokens(
      step.maxTokens ?? DEFAULT_STEP_MAX_TOKENS[step.kind],
      DEFAULT_STEP_MAX_TOKENS[step.kind],
    ),
    output: step.output,
    grammar: step.grammar,
  };
}

/**
 * Bind a step's cleaned output into a NEW context (the input ctx is left
 * untouched, so a run's context history is immutable and replayable).
 */
export function foldStepOutput(
  ctx: SkillContext,
  step: SkillStep,
  cleanedOutput: string,
): SkillContext {
  return { ...ctx, [step.output]: clampValue(cleanedOutput) };
}

// ─────────────────────────────────────────────────────────────────────
// Output sanitisation
// ─────────────────────────────────────────────────────────────────────

const LEADING_LABEL_RE =
  /^(?:sure|certainly|here(?:'s| is)|of course)[^\n:]*:?\s*/i;

/**
 * Clean a raw model completion for a step: strip a wrapping code fence,
 * a leading conversational label ("Sure, here's…"), and one pair of
 * wrapping quotes, then trim. Idempotent. Mirrors
 * `documentAiHelpers.cleanModelOutput` but kept local so the engine has
 * no dependency on the document editor module.
 */
export function cleanStepOutput(raw: string): string {
  let text = (raw ?? "").trim();
  if (text.length === 0) return "";

  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  text = text.replace(LEADING_LABEL_RE, "").trim();
  text = stripWrappingQuotes(text);

  return text.trim();
}

function stripWrappingQuotes(text: string): string {
  if (text.length < 2) return text;
  const first = text[0];
  const last = text[text.length - 1];
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    "\u201c": "\u201d",
    "\u2018": "\u2019",
  };
  if (pairs[first] && pairs[first] === last) {
    const inner = text.slice(1, -1);
    if (!inner.includes(first) && !inner.includes(last)) {
      return inner;
    }
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────
// Skill validation (authoring guard, used by tests + the library)
// ─────────────────────────────────────────────────────────────────────

/**
 * Validate a skill's internal consistency and return a list of human
 * readable problems (empty ⇒ valid). Catches the mistakes that would
 * otherwise produce a silently-degraded run:
 *
 *   - empty step list / blank ids / blank instructions
 *   - duplicate step ids or output variable names
 *   - a step referencing (via `{{var}}` or `inputsFrom`) a variable that
 *     no prior step produced and that is not a declared input
 *
 * The seed library asserts this returns `[]` for every shipped skill.
 */
export function validateSkill(skill: Skill): string[] {
  const problems: string[] = [];

  if (skill.steps.length === 0) {
    problems.push(`skill "${skill.id}" has no steps`);
  }

  const declaredInputs = new Set(skill.inputs.map((i) => i.id));
  const seenStepIds = new Set<string>();
  const producedVars = new Set<string>(declaredInputs);
  const seenOutputs = new Set<string>();

  for (const step of skill.steps) {
    if (!step.id.trim()) problems.push(`a step in "${skill.id}" has a blank id`);
    if (seenStepIds.has(step.id)) {
      problems.push(`duplicate step id "${step.id}" in "${skill.id}"`);
    }
    seenStepIds.add(step.id);

    if (!step.instruction.trim()) {
      problems.push(`step "${step.id}" in "${skill.id}" has a blank instruction`);
    }

    const refs = new Set<string>([
      ...referencedVars(step.instruction),
      ...(step.inputsFrom ?? []),
    ]);
    for (const ref of refs) {
      if (!producedVars.has(ref)) {
        problems.push(
          `step "${step.id}" in "${skill.id}" references unknown variable "${ref}"`,
        );
      }
    }

    if (!step.output.trim()) {
      problems.push(`step "${step.id}" in "${skill.id}" has a blank output`);
    }
    if (seenOutputs.has(step.output)) {
      problems.push(
        `duplicate output variable "${step.output}" in "${skill.id}"`,
      );
    }
    seenOutputs.add(step.output);

    // The step's output becomes available to subsequent steps.
    producedVars.add(step.output);
  }

  return problems;
}
