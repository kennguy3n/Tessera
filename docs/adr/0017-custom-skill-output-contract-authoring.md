# 17. Per-step output-contract authoring in the custom-skill editor

## Status

Accepted. Extends [0012](0012-deliberate-skills-engine.md) (the
deliberate Skills engine), [0013](0013-user-authored-skills.md)
(user-authored "custom" Skills), [0015](0015-custom-skill-check-authoring.md)
(acceptance-check authoring), and [0016](0016-custom-skill-sampling-authoring.md)
(sampling authoring), following the same renderer-only authoring +
serialisation pattern.

## Context

A step's `outputContract` (`SkillStep.outputContract?`,
`skills/skillTypes.ts`) is the engine's prompt-level structured-output
lever: `compileStep` (`skills/skillEngine.ts`) appends it to the step's
prompt as an explicit FORMAT clause, e.g. the built-in `document-deliberate-draft`
plan step pins _"FORMAT: 3–6 lines, each a single '- ' bullet … No
sub-bullets, no prose."_ Tight, per-step format discipline is the single
biggest reliability lever for a small local model — it is the practical
stand-in for the GBNF grammar that the renderer→main `model:generate`
IPC does **not** carry, so it is the structured-output mechanism that
actually ships today.

The `customSkills.ts` serialisation layer was already complete for this
field: `CustomStepDraft.outputContract`, `emptyStepDraft`, `skillToDraft`,
`buildCustomSkill` (which clamps it with `clampMultiline` to
`MAX_STEP_OUTPUT_CONTRACT` and omits it when blank), and `parseStoredSteps`
all carry it. But **`SkillEditorModal` exposed no control for it**: a
custom-skill author could not write an output contract, and — worse —
duplicating a built-in that ships one preserved the contract only
invisibly (it survived the round-trip but never appeared in the editor,
so the author could neither see nor tune it). This is exactly the
"silently preserved, never surfaced" gap that 0015 closed for `check`
and 0016 closed for sampling, now applied to the highest-value lever.

This is purely a renderer authoring gap: the engine consumes the field
and the serialisation already round-trips it, so no engine, IPC, Rust,
or `customSkills.ts` data-layer change is needed.

## Decision

Surface per-step `outputContract` authoring in `SkillEditorModal`,
entirely in the renderer and reusing the existing data layer unchanged.

Each step gains an "Output format contract" `<details>` group, placed
above the existing "Model sampling" and "Acceptance check" groups (the
contract shapes the prompt; sampling shapes generation; the check
validates the result). It holds a single multi-line `<textarea>` bound
to `row.outputContract` via the generic `updateStep(i, { outputContract })`
setter — no new draft field or converter, since `CustomStepDraft.outputContract`
is a required string (`""` when unset) and `buildCustomSkill` already
`clampMultiline`-clamps it to `MAX_STEP_OUTPUT_CONTRACT` and omits it
when blank.

The group's `<summary>` is **state-aware** — it reads
`"Output format contract (set)"` when the step carries a non-blank
contract and `"(optional)"` otherwise — so a duplicated built-in
advertises its preserved contract without the author having to expand
every step. As with the sampling and check groups, the `<details>` is
spaced with margins rather than `display: flex`, since the shell ships
Electron 31 / Chromium 126 and `<details>` ignores non-block `display`
before Chromium 131.

## Consequences

- Custom skills can now author the per-step output contract — the same
  structured-output discipline the built-ins use — directly in the
  editor, and the value flows through `compileStep`'s existing
  prompt-assembly unchanged.
- Output contracts **round-trip losslessly** through
  `skillToDraft → buildCustomSkill` and the localStorage save/load path,
  and a duplicated built-in now both preserves _and_ surfaces its
  contract (the `(set)` summary), closing the invisible-preservation gap.
- An over-long contract is clamped to `MAX_STEP_OUTPUT_CONTRACT` and a
  blank one is omitted, matching the established instruction/check
  authoring behaviour; internal newlines are preserved so multi-line
  FORMAT blocks survive.
- No new engine, IPC, Rust, or data-layer surface, and **no
  `SCHEMA_VERSION` bump**: the serialisation already handled this field,
  so skills saved before this change load unchanged. `validateSkill`
  still does not read `outputContract`.
- The data-layer mapping (omit-when-blank, clamp, multiline, built-in
  and save/load round-trips) and the editor controls (rendering,
  authoring, and the `(set)` summary on a duplicated built-in) are
  unit-tested.
