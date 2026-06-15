# 16. Per-step sampling authoring in the custom-skill editor

## Status

Accepted. Extends [0013](0013-user-authored-skills.md) (user-authored
"custom" Skills) and [0015](0015-custom-skill-check-authoring.md)
(acceptance-check authoring), following the same renderer-only
authoring + serialisation pattern.

## Context

The Skills engine already supports per-step sampling overrides:
`SkillStep.temperature?` and `SkillStep.maxTokens?`
(`skills/skillTypes.ts`). `compileStep` (`skills/skillEngine.ts`)
resolves each step's effective value as
`clampTemperature(step.temperature ?? DEFAULT_STEP_TEMPERATURE[kind])`
and `clampMaxTokens(step.maxTokens ?? DEFAULT_STEP_MAX_TOKENS[kind])`,
and both values flow end-to-end: the renderer→main `model:generate`
schema already accepts `maxTokens` and `temperature`. Per-step sampling
is a meaningful small-model quality lever — a `plan` or `critique` step
benefits from a low temperature for determinism, while a `draft` step
can run hotter for fluency, and a long `format` step may need a larger
token budget.

Today the built-in skills rely on the per-kind defaults and set no
per-step overrides. More importantly, **custom skills cannot author
sampling at all**: the `customSkills.ts` serialisation layer
(`skillToDraft`, `parseStoredSteps`, `buildCustomSkill`) ignored
`temperature` / `maxTokens`, and `SkillEditorModal` exposed no controls.
A user authoring a skill therefore could not tune sampling per step, and
any future built-in that set an override would lose it through a
duplicate/edit round-trip — the same lossy-serialisation gap that
0015 closed for `check`.

This is purely a renderer authoring + serialisation gap: the engine
clamps and the IPC schema already consume these fields, so no engine,
IPC, or Rust change is needed.

## Decision

Make per-step `temperature` and `maxTokens` first-class, optional parts
of custom-skill authoring, entirely in the renderer.

`CustomStepDraft` (`skills/customSkills.ts`) gains optional
`temperature?: string` and `maxTokens?: string` fields — edited as free
text, where **blank means "inherit the per-kind default"**. Pure
converters keep the draft and the engine shape in exact correspondence:

- `numberToDraft(value): string` renders a stored numeric override as an
  editable string. Unlike `positiveIntToDraft` it keeps `0` (a valid
  temperature) and decimals verbatim, and yields `""` for an absent or
  non-finite value.
- `parseTemperatureDraft(raw): number | null` parses with `Number(...)`
  (decimals and an explicit `0` are valid) and rejects anything outside
  `[MIN_TEMPERATURE, MAX_TEMPERATURE]` (0–2).
- `parseMaxTokensDraft(raw): number | null` requires a strict integer
  (`/^[0-9]+$/`) inside `[MIN_MAX_TOKENS, MAX_MAX_TOKENS]` (1–4096).

The accepted bounds are **imported from and re-exported through**
`skillEngine`'s `MIN_TEMPERATURE` / `MAX_TEMPERATURE` / `MIN_MAX_TOKENS`
/ `MAX_MAX_TOKENS`, so the editor's range can never drift from what the
engine clamps. `buildCustomSkill` only sets a field when its draft is
non-blank; a present-but-invalid value pushes a friendly per-step error
(prefixed with the step title) rather than being silently dropped, so a
typo never degrades sampling unnoticed.

`SkillEditorModal` renders the two number inputs inside a collapsed
`<details>` ("Model sampling (optional)") under each step, mirroring the
"Acceptance check (optional)" section, so the step form stays undisturbed
for authors who do not tune sampling. As with the check `<details>`, the
group is spaced with margins rather than `display: flex`, since the
shell ships Electron 31 / Chromium 126 and `<details>` ignores non-block
`display` before Chromium 131.

## Consequences

- Custom skills can now author per-step sampling, exposing the same
  quality lever (low temperature for plan/critique, higher for draft;
  larger token budgets for long-form steps) that the engine already
  honours. The values flow through `compileStep`'s existing clamps and
  the `model:generate` IPC schema unchanged.
- Sampling overrides **round-trip losslessly** through
  `skillToDraft → buildCustomSkill` and through the localStorage
  save/load path, so duplicating or editing a skill preserves them —
  forward-compatible with any future built-in that sets an override.
- An explicit `temperature: 0` survives the round-trip (it is not
  collapsed to blank), and a malformed authored value surfaces as a
  validation error instead of being dropped.
- No new engine, IPC, or Rust surface, and **no `SCHEMA_VERSION` bump**:
  `parseStoredSteps` reads missing fields as blank, so skills saved
  before this change load cleanly. `validateSkill` still does not read
  sampling.
- The draft/engine mapping is pure and unit-tested (parsing, clamp
  bounds, the `0`-vs-blank distinction, and full duplicate + save/load
  round-trips), with editor tests covering authoring the controls and
  seeing preserved values on edit.
