/**
 * User-authored ("custom") skills: persistence + sanitisation.
 *
 * The built-in skills in `skillLibrary.ts` are TypeScript constants. This
 * module lets a user author their OWN deliberate multi-step instruction
 * templates (the same {@link Skill} shape) and persist them locally so
 * they show up in every editor's Skills picker alongside the built-ins.
 *
 * The pure logic (coerce / validate / build / upsert / remove / merge)
 * lives here with unit tests; the `useCustomSkills` hook is a thin shell
 * that loads/saves through these functions and the `SkillEditorModal` is a
 * thin form that calls {@link buildCustomSkill} on save.
 *
 * Persistence mirrors `conceptGraphPresets.ts`: a single, schema-versioned
 * `localStorage` blob, parsed defensively so a corrupt/tampered entry can
 * never throw or seed a malformed skill into the runner. Each candidate is
 * re-validated through the engine's {@link validateSkill} so a stored skill
 * always satisfies the same internal-consistency rules as a built-in one
 * (no dangling `{{var}}` references, unique step ids / outputs, …).
 *
 * PRIVACY: a custom skill stores only the user's own authored template
 * text — names, descriptions, input labels, and step instructions they
 * deliberately typed. It never captures document/selection content (that
 * is interpolated at run time and discarded). The blob lives in renderer
 * `localStorage` on the device; nothing here performs IO beyond that, logs,
 * or transmits content — the same local-first contract as the rest of the
 * Skills engine.
 */

import {
  MAX_MAX_TOKENS,
  MAX_TEMPERATURE,
  MIN_MAX_TOKENS,
  MIN_TEMPERATURE,
  validateSkill,
} from "./skillEngine";
import type {
  Skill,
  SkillInputSpec,
  SkillStep,
  SkillStepCheck,
  SkillStepKind,
  SkillSurface,
} from "./skillTypes";

// Re-export the engine's sampling bounds so the authoring UI (which already
// imports its other limits from this module) has a single import site and
// the editor's accepted range can never drift from what the engine clamps.
export { MAX_MAX_TOKENS, MAX_TEMPERATURE, MIN_MAX_TOKENS, MIN_TEMPERATURE };

// ─────────────────────────────────────────────────────────────────────
// Persistence + bounds
// ─────────────────────────────────────────────────────────────────────

/** `localStorage` key for the custom-skill store (global, not per-scope). */
export const CUSTOM_SKILLS_STORAGE_KEY = "tessera.skills.custom";

/** Schema version for the persisted store. Bump on a breaking shape change. */
const SCHEMA_VERSION = 1;

/** Every custom skill id starts with this so it can never collide with a
 *  built-in (kebab-case) id, regardless of what the user names the skill. */
export const CUSTOM_SKILL_ID_PREFIX = "custom-";

/** Hard cap on saved custom skills (defensive against unbounded growth). */
export const MAX_CUSTOM_SKILLS = 50;
/** Max steps in a single custom skill (matches the deliberate, not-a-novel ethos). */
export const MAX_SKILL_STEPS = 8;
/** Max declared inputs in a single custom skill. */
export const MAX_SKILL_INPUTS = 6;

export const MAX_SKILL_NAME = 60;
export const MAX_SKILL_DESCRIPTION = 200;
export const MAX_STEP_TITLE = 80;
export const MAX_STEP_INSTRUCTION = 4000;
export const MAX_STEP_OUTPUT_CONTRACT = 2000;
export const MAX_INPUT_LABEL = 60;
export const MAX_INPUT_PLACEHOLDER = 120;
export const MAX_VAR_NAME = 40;

/** Max distinct terms in a check's must-include / must-not-contain list. */
export const MAX_CHECK_TERMS = 8;
/** Max length of a single check term / `mustStartWith` prefix. */
export const MAX_CHECK_TERM = 120;
/** Upper bound the authoring UI accepts for a check's `minLines`. */
export const MAX_CHECK_MIN_LINES = 100;
/** Upper bound the authoring UI accepts for a check's `maxChars`. */
export const MAX_CHECK_MAX_CHARS = 8000;

/** Canonical surface order, used to normalise + render surface lists. */
export const ALL_SKILL_SURFACES: readonly SkillSurface[] = [
  "document",
  "slide",
  "sheet",
  "base",
];

/** All step kinds, in authoring-menu order. */
export const ALL_STEP_KINDS: readonly SkillStepKind[] = [
  "plan",
  "draft",
  "critique",
  "revise",
  "extract",
  "format",
];

const KIND_SET = new Set<string>(ALL_STEP_KINDS);

// ─────────────────────────────────────────────────────────────────────
// Authoring draft shapes (the loose form the editor UI holds)
// ─────────────────────────────────────────────────────────────────────

/** One row in the inputs editor. */
export interface CustomInputDraft {
  /** Context-variable name (referenced in instructions as `{{id}}`). */
  id: string;
  label: string;
  required: boolean;
  multiline: boolean;
}

/**
 * The loose, text-input-friendly form of a step's deterministic
 * acceptance {@link SkillStepCheck}. Numbers and lists are held as raw
 * strings (the numeric fields back `<input type="number">`; the list
 * fields are newline-separated, one term per line) so the editor never
 * has to juggle `number | ""`. {@link buildStepCheck} parses this into a
 * real {@link SkillStepCheck} (or `undefined` when nothing is set).
 */
export interface CustomCheckDraft {
  /** Output must be non-empty after trimming. */
  nonEmpty: boolean;
  /** Output must not contain a Markdown code fence. */
  forbidFences: boolean;
  /** Minimum non-empty lines (blank ⇒ no constraint). */
  minLines: string;
  /** Maximum characters (blank ⇒ no constraint). */
  maxChars: string;
  /** Exact case-sensitive prefix the trimmed output must start with. */
  mustStartWith: string;
  /** Required substrings, one per line (case-insensitive). */
  mustInclude: string;
  /** Forbidden substrings, one per line (case-insensitive). */
  forbidContains: string;
}

/** One row in the steps editor. */
export interface CustomStepDraft {
  title: string;
  kind: SkillStepKind;
  instruction: string;
  /** Context variable this step's output binds to. */
  output: string;
  /** Prior variables (declared inputs / earlier outputs) to attach as material. */
  inputsFrom: string[];
  /** Optional strict output contract; empty ⇒ omitted. */
  outputContract: string;
  /**
   * Optional deterministic acceptance check authored for this step.
   * Absent on legacy drafts; {@link emptyStepDraft} / {@link skillToDraft}
   * always populate it. Built into a {@link SkillStepCheck} on save.
   */
  check?: CustomCheckDraft;
  /**
   * Sampling-temperature override as a free-text field; blank ⇒ use the
   * sensible per-kind default. Absent on legacy drafts; the factories always
   * populate it. Parsed + clamped into {@link SkillStep.temperature} on save.
   */
  temperature?: string;
  /**
   * Max-tokens override as a free-text field; blank ⇒ use the per-kind
   * default. Absent on legacy drafts; the factories always populate it.
   * Parsed into {@link SkillStep.maxTokens} on save.
   */
  maxTokens?: string;
}

/** The full draft the {@link SkillEditorModal} edits. */
export interface CustomSkillDraft {
  /** Present when editing an existing custom skill; absent for a new one. */
  id?: string;
  name: string;
  description: string;
  surfaces: SkillSurface[];
  inputs: CustomInputDraft[];
  steps: CustomStepDraft[];
}

/** Result of building a skill from a draft. */
export type BuildResult =
  | { ok: true; skill: Skill }
  | { ok: false; errors: string[] };

// ─────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────

/** Whether `id` belongs to a user-authored skill. */
export function isCustomSkillId(id: string): boolean {
  return id.startsWith(CUSTOM_SKILL_ID_PREFIX);
}

/**
 * Generate a locally-unique custom-skill id. Prefers `crypto.randomUUID`
 * (present in the Electron renderer + jsdom 22+); falls back to a
 * time+random token so the function never throws in an exotic host.
 * Mirrors `conceptGraphPresets.newPresetId`.
 */
export function newCustomSkillId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return `${CUSTOM_SKILL_ID_PREFIX}${c.randomUUID()}`;
  }
  return `${CUSTOM_SKILL_ID_PREFIX}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** Collapse internal whitespace + trim, then length-bound. */
function collapse(raw: string, max: number): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/** Trim ends + length-bound, preserving internal newlines (for templates). */
function clampMultiline(raw: string, max: number): string {
  const s = (raw ?? "").trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

/**
 * Derive a valid context-variable name (`[a-z0-9_]`, the alphabet the
 * engine's `{{var}}` placeholder regex accepts) from arbitrary text.
 * Returns `""` when nothing usable remains so callers can fall back.
 */
export function slugifyVar(raw: string): string {
  const s = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s.length > MAX_VAR_NAME
    ? s.slice(0, MAX_VAR_NAME).replace(/_+$/g, "")
    : s;
}

/** Normalise a surfaces list: keep only valid ones, dedupe, canonical order. */
export function normalizeSurfaces(raw: unknown): SkillSurface[] {
  const set = new Set<string>(
    Array.isArray(raw)
      ? raw.filter((s): s is string => typeof s === "string")
      : [],
  );
  return ALL_SKILL_SURFACES.filter((s) => set.has(s));
}

/** Coerce an arbitrary value to a valid step kind, or null. */
export function normalizeStepKind(raw: unknown): SkillStepKind | null {
  return typeof raw === "string" && KIND_SET.has(raw)
    ? (raw as SkillStepKind)
    : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

// ─────────────────────────────────────────────────────────────────────
// Authoring helpers (used by the editor UI)
// ─────────────────────────────────────────────────────────────────────

/** An empty acceptance-check draft (no constraint on any field). */
export function emptyCheckDraft(): CustomCheckDraft {
  return {
    nonEmpty: false,
    forbidFences: false,
    minLines: "",
    maxChars: "",
    mustStartWith: "",
    mustInclude: "",
    forbidContains: "",
  };
}

/** An empty step draft (sensible defaults). */
export function emptyStepDraft(): CustomStepDraft {
  return {
    title: "",
    kind: "draft",
    instruction: "",
    output: "",
    inputsFrom: [],
    outputContract: "",
    check: emptyCheckDraft(),
    temperature: "",
    maxTokens: "",
  };
}

/** An empty input draft. */
export function emptyInputDraft(): CustomInputDraft {
  return { id: "", label: "", required: false, multiline: false };
}

/** A blank draft for the "New skill" path, defaulting to one surface. */
export function emptyDraft(
  surface: SkillSurface = "document",
): CustomSkillDraft {
  return {
    name: "",
    description: "",
    surfaces: [surface],
    inputs: [{ id: "topic", label: "Topic", required: true, multiline: false }],
    steps: [
      { ...emptyStepDraft(), title: "Draft", kind: "draft", output: "result" },
    ],
  };
}

/**
 * Convert a step's {@link SkillStepCheck} (or a raw persisted record) into
 * the editor's {@link CustomCheckDraft}. Reads every field defensively so
 * it is safe on either a typed built-in check or arbitrary stored JSON; an
 * absent/garbage value yields an all-empty draft. Inverse of
 * {@link buildStepCheck}.
 */
export function checkToDraft(raw: SkillStepCheck | unknown): CustomCheckDraft {
  const rec = asRecord(raw);
  if (!rec) return emptyCheckDraft();
  return {
    nonEmpty: rec.nonEmpty === true,
    forbidFences: rec.forbidFences === true,
    minLines: positiveIntToDraft(rec.minLines),
    maxChars: positiveIntToDraft(rec.maxChars),
    mustStartWith:
      typeof rec.mustStartWith === "string" ? rec.mustStartWith : "",
    mustInclude: stringListToDraft(rec.mustInclude),
    forbidContains: stringListToDraft(rec.forbidContains),
  };
}

/** A finite positive integer becomes its decimal string; anything else "". */
function positiveIntToDraft(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? String(Math.floor(value))
    : "";
}

/**
 * Any finite number becomes its string form; anything else "". Unlike
 * {@link positiveIntToDraft} this keeps `0` (a valid temperature) and decimals
 * (e.g. `0.2`), so a stored sampling override round-trips back into the editor
 * verbatim. Blank ⇒ the step inherits its per-kind default.
 */
function numberToDraft(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "";
}

/**
 * A `string[]` becomes a newline-joined textarea value. Term content is kept
 * verbatim (whitespace is significant to the engine) — only whitespace-only
 * entries are dropped — so re-building the draft is the exact inverse.
 */
function stringListToDraft(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((t): t is string => typeof t === "string")
    .filter((t) => t.trim().length > 0)
    .join("\n");
}

/** Re-hydrate a saved {@link Skill} back into an editable draft. */
export function skillToDraft(skill: Skill): CustomSkillDraft {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
    surfaces: normalizeSurfaces(skill.surfaces),
    inputs: skill.inputs.map((i) => ({
      id: i.id,
      label: i.label,
      required: !!i.required,
      multiline: !!i.multiline,
    })),
    steps: skill.steps.map((s) => ({
      title: s.title,
      kind: s.kind,
      instruction: s.instruction,
      output: s.output,
      inputsFrom: [...(s.inputsFrom ?? [])],
      outputContract: s.outputContract ?? "",
      check: checkToDraft(s.check),
      temperature: numberToDraft(s.temperature),
      maxTokens: numberToDraft(s.maxTokens),
    })),
  };
}

/**
 * The context variables available to a step at `stepIndex` — the declared
 * inputs plus every earlier step's output. Used by the editor to render the
 * "attach prior outputs" choices and to label them; the same set the engine
 * uses to decide whether a reference resolves.
 */
export function availableVarsBeforeStep(
  draft: CustomSkillDraft,
  stepIndex: number,
): string[] {
  const vars: string[] = [];
  const seen = new Set<string>();
  const push = (v: string) => {
    const slug = slugifyVar(v);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      vars.push(slug);
    }
  };
  for (const input of draft.inputs) push(input.id || input.label);
  for (let i = 0; i < stepIndex && i < draft.steps.length; i++) {
    push(draft.steps[i].output || `step_${i + 1}`);
  }
  return vars;
}

// ─────────────────────────────────────────────────────────────────────
// Build a Skill from a draft (the authoring path)
// ─────────────────────────────────────────────────────────────────────

/** Result of building one step's acceptance check. */
export interface CheckBuildResult {
  /**
   * The built check from the fields that parsed cleanly, or `undefined` when
   * no field is set. Note this may be defined *alongside* `errors` when some
   * fields are valid and others are not (e.g. `nonEmpty` set but `minLines`
   * non-numeric); callers must treat a non-empty `errors` as authoritative
   * and ignore `check` (as `buildCustomSkill` does — it aborts on any error).
   */
  check?: SkillStepCheck;
  /** Human-readable problems (e.g. a non-numeric `minLines`). */
  errors: string[];
}

/** Parse a raw numeric-input string into a bounded positive integer, or
 *  `null` when blank/invalid (so the caller can surface a friendly error). */
function parseCheckInt(raw: string, max: number): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1 || n > max) return null;
  return n;
}

/**
 * Parse an authored temperature into the engine's accepted range, or `null`
 * when blank/invalid (so the caller can surface a friendly error rather than
 * silently clamping). Decimals and `0` are valid; anything outside
 * [{@link MIN_TEMPERATURE}, {@link MAX_TEMPERATURE}] is rejected.
 */
function parseTemperatureDraft(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < MIN_TEMPERATURE || n > MAX_TEMPERATURE) {
    return null;
  }
  return n;
}

/**
 * Parse an authored max-tokens value into a whole number in the engine's
 * accepted range, or `null` when blank/invalid. Mirrors {@link parseCheckInt}'s
 * strict integer grammar (this regex only ever runs on author input).
 */
function parseMaxTokensDraft(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^[0-9]+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < MIN_MAX_TOKENS || n > MAX_MAX_TOKENS) {
    return null;
  }
  return n;
}

/**
 * Length-clamp a single check term. Content is preserved verbatim (the
 * engine treats a needle's interior/surrounding whitespace as significant
 * and `mustInclude: ["## "]` is a real built-in), so this only enforces the
 * length bound — it never trims, which is what keeps duplicating a built-in
 * skill lossless.
 */
function clampTerm(raw: string): string {
  return raw.length > MAX_CHECK_TERM ? raw.slice(0, MAX_CHECK_TERM) : raw;
}

/**
 * Split a newline-separated list field into length-clamped, deduped, capped
 * terms. Whitespace-only lines are dropped (they would be no-ops in the
 * engine, which ignores empty needles), but a meaningful term keeps its
 * surrounding whitespace.
 */
function parseTermList(raw: string): string[] {
  const terms = (raw ?? "")
    .split("\n")
    .map(clampTerm)
    .filter((t) => t.trim().length > 0);
  return dedupe(terms).slice(0, MAX_CHECK_TERMS);
}

/**
 * Build a normalised {@link SkillStepCheck} from a {@link CustomCheckDraft},
 * collecting any human-readable problems. Only fields the author actually
 * set are emitted (so a step with no check stays `check`-free, keeping the
 * persisted blob and the round-trip clean). Numeric fields that are present
 * but non-numeric / out of range produce an error rather than being silently
 * dropped. Mirrors the engine's regex-free primitives — never builds a
 * dynamic regular expression. Inverse of {@link checkToDraft}.
 *
 * When some fields are valid and others error, the returned `check` reflects
 * only the valid fields; callers must treat a non-empty `errors` as a build
 * failure and discard `check` (see {@link CheckBuildResult}).
 */
export function buildStepCheck(
  draft: CustomCheckDraft | undefined,
): CheckBuildResult {
  const errors: string[] = [];
  if (!draft) return { errors };

  const check: SkillStepCheck = {};

  if (draft.nonEmpty) check.nonEmpty = true;
  if (draft.forbidFences) check.forbidFences = true;

  if (draft.minLines.trim()) {
    const n = parseCheckInt(draft.minLines, MAX_CHECK_MIN_LINES);
    if (n === null) {
      errors.push(
        `Minimum lines must be a whole number from 1 to ${MAX_CHECK_MIN_LINES}.`,
      );
    } else {
      check.minLines = n;
    }
  }

  if (draft.maxChars.trim()) {
    const n = parseCheckInt(draft.maxChars, MAX_CHECK_MAX_CHARS);
    if (n === null) {
      errors.push(
        `Maximum characters must be a whole number from 1 to ${MAX_CHECK_MAX_CHARS}.`,
      );
    } else {
      check.maxChars = n;
    }
  }

  // Leading whitespace on a prefix can never match (the engine trims the
  // output before `startsWith`), so strip it; trailing whitespace is kept.
  const startsWith = clampTerm(draft.mustStartWith.replace(/^\s+/, ""));
  if (startsWith.trim().length > 0) check.mustStartWith = startsWith;

  const include = parseTermList(draft.mustInclude);
  if (include.length > 0) check.mustInclude = include;

  const forbid = parseTermList(draft.forbidContains);
  if (forbid.length > 0) check.forbidContains = forbid;

  return Object.keys(check).length > 0 ? { check, errors } : { errors };
}

/**
 * Validate + normalise a {@link CustomSkillDraft} into a {@link Skill}.
 *
 * Returns `{ ok: true, skill }` when the draft is well-formed, or
 * `{ ok: false, errors }` with human-readable problems otherwise. The
 * normalisation (trim, length-clamp, slugify variable names, drop dangling
 * `inputsFrom` references, fill blank titles/outputs) makes the editor
 * forgiving, while the final {@link validateSkill} pass guarantees the
 * produced skill obeys the same internal-consistency rules as a built-in.
 *
 * `idGen` is injectable so tests get deterministic ids.
 */
export function buildCustomSkill(
  draft: CustomSkillDraft,
  idGen: () => string = newCustomSkillId,
): BuildResult {
  const errors: string[] = [];

  const name = collapse(draft.name, MAX_SKILL_NAME);
  if (!name) errors.push("Name is required.");

  const description = collapse(draft.description, MAX_SKILL_DESCRIPTION);

  const surfaces = normalizeSurfaces(draft.surfaces);
  if (surfaces.length === 0) {
    errors.push(
      "Choose at least one surface (Documents, Slides, Sheets, or Base).",
    );
  }

  if (draft.inputs.length > MAX_SKILL_INPUTS) {
    errors.push(`A skill can declare at most ${MAX_SKILL_INPUTS} inputs.`);
  }

  const inputs: SkillInputSpec[] = [];
  const inputIds = new Set<string>();
  draft.inputs.forEach((row, i) => {
    const id = slugifyVar(row.id || row.label);
    if (!id) {
      errors.push(`Input ${i + 1} needs a name.`);
      return;
    }
    if (inputIds.has(id)) {
      errors.push(`Duplicate input variable "${id}".`);
      return;
    }
    inputIds.add(id);
    const label = collapse(row.label, MAX_INPUT_LABEL) || humanize(id);
    const spec: SkillInputSpec = { id, label };
    if (row.required) spec.required = true;
    if (row.multiline) spec.multiline = true;
    inputs.push(spec);
  });

  if (draft.steps.length === 0) {
    errors.push("Add at least one step.");
  }
  if (draft.steps.length > MAX_SKILL_STEPS) {
    errors.push(`A skill can have at most ${MAX_SKILL_STEPS} steps.`);
  }

  const steps: SkillStep[] = [];
  const outputs = new Set<string>(inputIds);
  const stepIds = new Set<string>();
  // Variables produced so far (inputs + prior outputs), to prune inputsFrom.
  const producedSoFar = new Set<string>(inputIds);
  draft.steps.forEach((row, i) => {
    const kind = normalizeStepKind(row.kind);
    if (!kind) {
      errors.push(`Step ${i + 1} has an invalid kind.`);
      return;
    }
    const title = collapse(row.title, MAX_STEP_TITLE) || `Step ${i + 1}`;
    const instruction = clampMultiline(row.instruction, MAX_STEP_INSTRUCTION);
    if (!instruction) {
      errors.push(`Step ${i + 1} ("${title}") needs an instruction.`);
    }

    let output = slugifyVar(row.output) || `step_${i + 1}`;
    // Avoid colliding with an input or an earlier step's output.
    if (outputs.has(output)) {
      let n = i + 1;
      let candidate = `${output}_${n}`;
      while (outputs.has(candidate)) candidate = `${output}_${++n}`;
      output = candidate;
    }

    const id = `s${i + 1}`;
    stepIds.add(id);

    // Keep only references that actually resolve at this point in the chain.
    const inputsFrom = dedupe(
      row.inputsFrom.map(slugifyVar).filter((v) => v && producedSoFar.has(v)),
    );

    const step: SkillStep = { id, title, kind, instruction, output };
    if (inputsFrom.length > 0) step.inputsFrom = inputsFrom;
    const contract = clampMultiline(
      row.outputContract,
      MAX_STEP_OUTPUT_CONTRACT,
    );
    if (contract) step.outputContract = contract;

    const { check, errors: checkErrors } = buildStepCheck(row.check);
    for (const problem of checkErrors) {
      errors.push(`Step ${i + 1} ("${title}") check: ${problem}`);
    }
    if (check) step.check = check;

    // Optional per-step sampling overrides; blank ⇒ inherit the per-kind
    // default. A present-but-invalid value errors rather than being dropped.
    const temperatureRaw = row.temperature ?? "";
    if (temperatureRaw.trim()) {
      const t = parseTemperatureDraft(temperatureRaw);
      if (t === null) {
        errors.push(
          `Step ${i + 1} ("${title}") temperature must be a number from ${MIN_TEMPERATURE} to ${MAX_TEMPERATURE}.`,
        );
      } else {
        step.temperature = t;
      }
    }
    const maxTokensRaw = row.maxTokens ?? "";
    if (maxTokensRaw.trim()) {
      const m = parseMaxTokensDraft(maxTokensRaw);
      if (m === null) {
        errors.push(
          `Step ${i + 1} ("${title}") max tokens must be a whole number from ${MIN_MAX_TOKENS} to ${MAX_MAX_TOKENS}.`,
        );
      } else {
        step.maxTokens = m;
      }
    }

    outputs.add(output);
    producedSoFar.add(output);
    steps.push(step);
  });

  if (errors.length > 0) return { ok: false, errors };

  const existingId =
    typeof draft.id === "string" && isCustomSkillId(draft.id) ? draft.id : null;
  const skill: Skill = {
    id: existingId ?? idGen(),
    name,
    description,
    surfaces,
    inputs,
    steps,
  };

  // Final structural guard: dangling `{{var}}` references, etc. This should
  // not normally fire (the UI prunes inputsFrom and slugs variables) but a
  // `{{var}}` typed into an instruction that no input/step produces is only
  // catchable here.
  const structural = validateSkill(skill);
  if (structural.length > 0) {
    return { ok: false, errors: structural.map(friendlyStructuralError) };
  }

  return { ok: true, skill };
}

/** Humanise a variable id into a label, e.g. `use_case` → `Use case`. */
function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  if (!words) return id;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Turn an engine validation string into something an author can act on. */
function friendlyStructuralError(problem: string): string {
  const m = problem.match(/references unknown variable "([^"]+)"/);
  if (m) {
    return `An instruction references "{{${m[1]}}}", but no input or earlier step produces it.`;
  }
  return problem;
}

// ─────────────────────────────────────────────────────────────────────
// CRUD over a skills array (pure)
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert `skill` or replace the existing one with the same id, preserving
 * order (replacement keeps its slot; a new skill appends). Enforces
 * {@link MAX_CUSTOM_SKILLS} by dropping the oldest when a *new* skill would
 * overflow — a replacement never trips the cap.
 */
export function upsertCustomSkill(
  skills: ReadonlyArray<Skill>,
  skill: Skill,
): Skill[] {
  const idx = skills.findIndex((s) => s.id === skill.id);
  if (idx >= 0) {
    const next = skills.slice();
    next[idx] = skill;
    return next;
  }
  const next = [...skills, skill];
  return next.length > MAX_CUSTOM_SKILLS
    ? next.slice(next.length - MAX_CUSTOM_SKILLS)
    : next;
}

/** Remove a custom skill by id (no-op when absent). */
export function removeCustomSkill(
  skills: ReadonlyArray<Skill>,
  id: string,
): Skill[] {
  return skills.filter((s) => s.id !== id);
}

// ─────────────────────────────────────────────────────────────────────
// Defensive parse / serialize / load / save (mirrors conceptGraphPresets)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce one raw stored object into a valid custom {@link Skill}, or `null`
 * when unusable. Routes through {@link buildCustomSkill} (reusing the exact
 * same normalisation + structural validation as the authoring path) so a
 * persisted skill can never diverge from what the editor would have allowed.
 * A stored id that is not custom-namespaced is rejected so a tampered blob
 * cannot shadow a built-in skill.
 */
export function parseStoredSkill(value: unknown): Skill | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !isCustomSkillId(rec.id)) return null;
  if (typeof rec.name !== "string") return null;

  const draft: CustomSkillDraft = {
    id: rec.id,
    name: rec.name,
    description: typeof rec.description === "string" ? rec.description : "",
    surfaces: normalizeSurfaces(rec.surfaces),
    inputs: parseStoredInputs(rec.inputs),
    steps: parseStoredSteps(rec.steps),
  };

  const result = buildCustomSkill(draft);
  return result.ok ? result.skill : null;
}

function parseStoredInputs(raw: unknown): CustomInputDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomInputDraft[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === "string" ? rec.id : "";
    const label = typeof rec.label === "string" ? rec.label : "";
    if (!id && !label) continue;
    out.push({
      id,
      label,
      required: rec.required === true,
      multiline: rec.multiline === true,
    });
  }
  return out;
}

function parseStoredSteps(raw: unknown): CustomStepDraft[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomStepDraft[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    if (!rec) continue;
    out.push({
      title: typeof rec.title === "string" ? rec.title : "",
      kind: normalizeStepKind(rec.kind) ?? "draft",
      instruction: typeof rec.instruction === "string" ? rec.instruction : "",
      output: typeof rec.output === "string" ? rec.output : "",
      inputsFrom: Array.isArray(rec.inputsFrom)
        ? rec.inputsFrom.filter((v): v is string => typeof v === "string")
        : [],
      outputContract:
        typeof rec.outputContract === "string" ? rec.outputContract : "",
      check: checkToDraft(rec.check),
      temperature: numberToDraft(rec.temperature),
      maxTokens: numberToDraft(rec.maxTokens),
    });
  }
  return out;
}

/**
 * Defensively parse a raw `localStorage` string into a validated list of
 * custom skills, or `null` when absent/unusable. Never throws: bad JSON, a
 * wrong schema version, or a non-array `skills` all degrade to `null`;
 * individually-bad or duplicate-id skills are dropped.
 */
export function parseCustomSkillStore(raw: string | null): Skill[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  if (rec.version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(rec.skills)) return null;

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const item of rec.skills) {
    const skill = parseStoredSkill(item);
    if (skill && !seen.has(skill.id)) {
      seen.add(skill.id);
      skills.push(skill);
      if (skills.length >= MAX_CUSTOM_SKILLS) break;
    }
  }
  return skills;
}

/** Serialize a custom-skill list to the persisted JSON string (with version). */
export function serializeCustomSkillStore(
  skills: ReadonlyArray<Skill>,
): string {
  return JSON.stringify({ version: SCHEMA_VERSION, skills });
}

/**
 * Load + validate the persisted custom skills. Returns `[]` (never null)
 * when there is nothing usable, so callers can use the result directly.
 * Never throws.
 */
export function loadCustomSkills(): Skill[] {
  try {
    return (
      parseCustomSkillStore(
        window.localStorage.getItem(CUSTOM_SKILLS_STORAGE_KEY),
      ) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Persist `skills`. Best-effort: silently no-ops if `localStorage` is
 * unavailable or the write is rejected (quota/locked).
 */
export function saveCustomSkills(skills: ReadonlyArray<Skill>): void {
  try {
    window.localStorage.setItem(
      CUSTOM_SKILLS_STORAGE_KEY,
      serializeCustomSkillStore(skills),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}

function dedupe<T>(values: ReadonlyArray<T>): T[] {
  return Array.from(new Set(values));
}
