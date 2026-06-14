/**
 * Types for the Skills / Instruction-Template engine.
 *
 * A *skill* is a declarative, multi-step instruction template that
 * orchestrates the on-device model across several deliberate sub-tasks
 * (plan → draft → critique → revise, intent → formula → self-check, …)
 * instead of a single one-shot prompt. Decomposing a task into narrow,
 * grammar-/contract-constrained steps is the highest-ROI lever for a
 * SMALL local model: each step is something a 1–3B model can do
 * reliably, and the engine threads each step's output into the next.
 *
 * This module is intentionally dependency-light (no React / TipTap /
 * IPC imports) so the pure compiler in `skillEngine.ts` and its unit
 * tests can import these shapes without booting the renderer. The
 * actual `model.generate` calls live in the thin `useSkillRunner`
 * hook; everything here and in `skillEngine.ts` is a pure data
 * transform.
 *
 * PRIVACY: skills only ever interpolate text the user supplied (the
 * editor selection / their typed inputs) and the model's own prior
 * step outputs. Nothing here performs IO, logs, or transmits content.
 */

/** Editor surfaces a skill can target. */
export type SkillSurface = "document" | "sheet" | "slide" | "base";

/**
 * The deliberate role a step plays in the chain. The kind drives a
 * terse, role-specific system preamble (see `STEP_PREAMBLES`) and a
 * sensible default sampling temperature (planning/critique want low
 * temperature; drafting wants more room).
 */
export type SkillStepKind =
  | "plan"
  | "draft"
  | "critique"
  | "revise"
  | "extract"
  | "format";

/** Lifecycle of a multi-step skill run, surfaced to the panel UI. */
export type SkillRunStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "battery_low";

/**
 * A user/editor-supplied input to a skill. `id` is the context-variable
 * name the step `instruction` templates reference as `{{id}}`.
 */
export interface SkillInputSpec {
  /** Context variable name, referenced in instructions as `{{id}}`. */
  id: string;
  /** Human-readable label for the input control. */
  label: string;
  /** Whether the run is blocked until this input is non-empty. */
  required?: boolean;
  /** Placeholder text for the input control. */
  placeholder?: string;
  /** Render a multi-line textarea rather than a single-line input. */
  multiline?: boolean;
}

/**
 * One deliberate step in a skill. Each step compiles to exactly one
 * `model.generate` call.
 *
 * `instruction` is a template interpolated with the current context
 * (`{{var}}`). `inputsFrom` names the context variables whose values
 * are appended to the prompt as labelled blocks so the model sees the
 * material it must work on (e.g. the plan from a prior step). `output`
 * is the context variable the step's cleaned result is bound to, so
 * later steps can reference it.
 */
export interface SkillStep {
  /** Stable id, unique within the skill. */
  id: string;
  /** Short human-readable title shown in the run progress UI. */
  title: string;
  /** The deliberate role this step plays. */
  kind: SkillStepKind;
  /** Instruction template; `{{var}}` placeholders are interpolated. */
  instruction: string;
  /**
   * Context variables to append to the prompt as labelled material
   * blocks, in order. Unknown / empty variables are skipped.
   */
  inputsFrom?: string[];
  /** Context variable the cleaned step output is bound to. */
  output: string;
  /**
   * Optional strict output-format contract appended verbatim after the
   * instruction. This is what keeps a small model's output parseable
   * (mirrors the `DECK_OUTPUT_CONTRACT_LINES` technique in
   * `slideAiHelpers`).
   */
  outputContract?: string;
  /**
   * Optional GBNF grammar id for structured output. NOT yet wired
   * through the `model:generate` IPC (which only accepts
   * prompt/maxTokens/temperature today); carried here so skills can
   * declare intent and a follow-up can enforce it without a schema
   * change. Until then, `outputContract` does the structural work.
   */
  grammar?: string;
  /** Sampling temperature override; defaults per `kind`. */
  temperature?: number;
  /** Max tokens override; defaults per `kind`. */
  maxTokens?: number;
}

/**
 * A declarative, multi-step instruction template.
 *
 * Skills are plain data so they can be authored, versioned, and
 * eventually loaded from disk / connectors — the same philosophy as the
 * YAML artifact templates under `templates/<kind>/`.
 */
export interface Skill {
  /** Stable, kebab-case id. */
  id: string;
  /** Display name. */
  name: string;
  /** One-line description of what the skill produces. */
  description: string;
  /** Surfaces this skill is offered on. */
  surfaces: SkillSurface[];
  /** Inputs the user/editor supplies before the run. */
  inputs: SkillInputSpec[];
  /** Ordered, deliberate steps. */
  steps: SkillStep[];
}

/** Context variables threaded through a run: var name → current value. */
export type SkillContext = Record<string, string>;

/**
 * A single step compiled against a concrete context: the exact prompt
 * to send and the resolved sampling parameters. Produced by
 * `compileStep`; consumed by the runner.
 */
export interface CompiledStep {
  /** The originating step id. */
  id: string;
  /** The step title (for progress UI). */
  title: string;
  /** The step kind. */
  kind: SkillStepKind;
  /** Fully-assembled, self-contained prompt string. */
  prompt: string;
  /** Resolved sampling temperature (clamped). */
  temperature: number;
  /** Resolved max tokens (clamped). */
  maxTokens: number;
  /** Context variable the cleaned output should be bound to. */
  output: string;
  /** Declared grammar id (forwarded, not yet enforced over IPC). */
  grammar?: string;
}

/** Result of a single completed step within a run. */
export interface SkillStepResult {
  /** The step id. */
  id: string;
  /** The step title. */
  title: string;
  /** The cleaned text the model produced for this step. */
  output: string;
}
