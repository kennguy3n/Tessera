# 15. Acceptance-check authoring in the custom-skill editor

## Status

Accepted. Completes the first follow-up of
[0014](0014-deterministic-step-checks-and-repair.md) (deterministic
per-step checks + bounded auto-repair) and extends
[0013](0013-user-authored-skills.md) (user-authored "custom" Skills).

## Context

ADR 0014 added an engine-owned, deterministic per-step `check`
(`SkillStepCheck`) plus a bounded auto-repair loop, and wired it into the
hard-coded `BUILTIN_SKILLS`. It explicitly scoped `check` **out** of
custom-skill authoring: the `SkillEditorModal` UI and the
`customSkills.ts` serialisation layer (`skillToDraft`, `parseStoredSteps`,
`buildCustomSkill`) all ignored the field. Two visible gaps followed:

- A user **could not attach a check** to a step in a skill they authored,
  so the self-check / auto-repair quality mechanism was reserved for
  built-ins.
- **Duplicating or editing a built-in lost its checks.** Because the
  serialisation round-trip dropped `check`, a custom copy of (say) the
  Sheet formula skill silently lost its `mustStartWith: "="` guard.

The engine side (`evaluateCheck` / the repair loop) already consumes
`SkillStep.check` regardless of who authored the skill, so this is purely
a renderer authoring + serialisation gap — no engine, IPC, or Rust change
is needed.

## Decision

Make `check` a first-class, optional part of custom-skill authoring,
entirely in the renderer.

A draft-shaped mirror of `SkillStepCheck`, `CustomCheckDraft`
(`skills/customSkills.ts`), holds every predicate as an editable string /
boolean (numbers and substring lists are edited as text, one term per
line). Pure converters keep the draft and the engine shape in exact
correspondence:

- `checkToDraft(raw): CustomCheckDraft` — defensively reads an arbitrary
  stored record into a draft (used by both `skillToDraft` and
  `parseStoredSteps`), so editing or reloading a skill rehydrates its
  checks.
- `buildStepCheck(draft): { check?; errors[] }` — parses a draft back
  into a minimal `SkillStepCheck`, emitting only the predicates the author
  actually set and collecting friendly per-field errors (numbers must be a
  whole number in range; over-long terms are clamped; blank lines and
  duplicates are dropped). Its errors are surfaced through
  `buildCustomSkill`, prefixed with the step title.

Authoring bounds (`MAX_CHECK_TERMS`, `MAX_CHECK_TERM`,
`MAX_CHECK_MIN_LINES`, `MAX_CHECK_MAX_CHARS`) keep a persisted check small
and bounded.

**Term content is preserved verbatim** — only whitespace-only lines are
dropped and over-long terms are length-clamped. This matters because the
engine treats whitespace as significant (e.g. the slide built-in's
`mustInclude: ["## "]` carries a meaningful trailing space), so trimming
would silently change semantics and break a lossless duplicate. The one
exception is `mustStartWith`, whose **leading** whitespace is stripped:
the engine trims output before `startsWith`, so a leading space on the
prefix could never match.

`SkillEditorModal` renders the controls as a collapsed
`<details>` ("Acceptance check (optional)") under each step, so the
existing step form is undisturbed for authors who do not need a check.
The regex-free predicate set, `evaluateCheck`, and the repair loop from
0014 are reused unchanged; only authored input flows into them.

## Consequences

- Custom skills are now full-fledged: an author can attach the same
  deterministic self-check / auto-repair discipline that built-ins use,
  and **duplicating or editing a built-in now preserves its checks**
  losslessly through the localStorage round-trip.
- No new engine, IPC, or Rust surface: `evaluateCheck` and the runner are
  untouched; the change is a draft ⇄ `SkillStepCheck` mapping plus UI.
  `validateSkill` still does not read `check`, so checks never affect
  structural validation.
- The draft/engine mapping is pure and exhaustively unit-tested
  (`buildStepCheck`, `checkToDraft`, and full save/load round-trips,
  including the whitespace-significant cases), with editor tests covering
  authoring a check and seeing a duplicated built-in's preserved values.
- The only remaining 0014 follow-up is the (still-deferred) option to
  layer GBNF enforcement underneath these checks if the IPC schema ever
  gains a `grammar` field.
