# 14. Deterministic per-step output checks with bounded auto-repair

## Status

Accepted. Builds on [0012](0012-deliberate-skills-engine.md) (the
deliberate multi-step Skills engine) and [0006](0006-ternary-bonsai.md)
(the single small local model the engine has to coax good structure out
of).

## Context

ADR 0012 shipped a renderer-side Skills engine that breaks a task into
deliberate steps (plan → draft → critique → revise, etc.), each compiled
to exactly one `model.generate` call. Structure is coaxed out of the
small local model purely at the prompt level: a step's optional
`outputContract` is appended verbatim, and `cleanStepOutput` strips a
wrapping code fence / conversational label / quotes from the completion.

Two gaps remained from the critique:

- **No structured-output discipline per step.** `SkillStep` already
  carries a `grammar?` field, but it is explicitly _not_ wired: the
  `model:generate` IPC schema (`GenerateRequestSchema`) accepts only
  `prompt` / `maxTokens` / `temperature` — there is **no `grammar`
  field** — and crossing into the N-API bridge / Rust runtime to add GBNF
  enforcement is out of scope for a renderer-only feature (the same
  boundary 0012 and 0013 drew). So nothing actually rejects a malformed
  step output; a stray code fence, an empty answer, or a spreadsheet
  formula that does not start with `=` flows straight into the next step.
- **No self-verification.** Only one built-in skill (the Sheet
  formula skill) verifies its own work, and it does so with an extra
  _model_ step ("check this formula") — itself subject to the same
  small-model unreliability it is meant to catch.

We want a cheap, trustworthy way to (a) assert the shape of a step's
output and (b) recover when it is wrong, **without** an IPC/Rust schema
change and **without** another unreliable model judgement.

GBNF-over-IPC was reconsidered and again rejected here: it requires
changing the fixed IPC schema, the bridge, and the runtime, and it can
only constrain grammar — it cannot express "must start with `=`" or
"must not echo a code fence" as cheaply as a substring test, nor can it
_repair_ an already-produced output.

## Decision

Add an **engine-owned, deterministic per-step `check`** plus a **bounded
auto-repair loop** in the runner. Both pieces are pure and live entirely
in the renderer, alongside the rest of the engine.

`SkillStep` gains an optional `check?: SkillStepCheck`
(`skills/skillTypes.ts`). `SkillStepCheck` is a small, declarative set of
**regex-free** predicates — deliberately not a `RegExp`, so a check can
never hang (no ReDoS) or execute skill/model-supplied text:

- `nonEmpty` — non-empty after trim.
- `minLines` — at least _n_ non-empty lines.
- `maxChars` — at most _n_ characters (after trim).
- `mustStartWith` — trimmed output starts with an exact (case-sensitive)
  prefix.
- `mustInclude` — every listed substring is present (case-insensitive).
- `forbidFences` — output contains no Markdown code fence (` ``` `).
- `forbidContains` — none of the listed substrings is present
  (case-insensitive).

Two new **pure** functions in `skills/skillEngine.ts`:

- `evaluateCheck(check, output): string[]` — returns one human-readable
  message per failed predicate (empty ⇒ acceptable, or no check). Each
  predicate is independent so a single output can report _all_ its
  problems at once. Pure and total — only fixed substring / length / line
  tests.
- `compileRepairStep(step, ctx, previousOutput, failures): CompiledStep`
  — reuses the step's normal `compileStep` prompt (same preamble,
  instruction, material blocks, output contract, and resolved sampling
  params) and appends the rejected attempt plus the exact failures, with
  "Return ONLY the corrected result." So the repair prompt can never
  drift from the original step's framing.

The runner (`skills/useSkillRunner.ts`) applies the loop between
`cleanStepOutput` and `foldStepOutput`, bounded by
`MAX_STEP_REPAIRS = 1`:

1. Clean the step output, then `evaluateCheck` it.
2. While there are failures and the repair budget is not exhausted,
   re-stream the step once via `compileRepairStep` with the rejected
   attempt + failures.
3. **Keep a repaired attempt only when it is strictly better**
   (`repairFailures.length < checkFailures.length`); otherwise discard it
   and stop. This guarantees the chosen output is never worse than the
   first attempt.
4. **Never hard-fail.** After the budget the chain proceeds with the best
   output and records the residual `checkFailures` (and whether the kept
   output was `repaired`) on the `SkillStepResult`.

The runner exposes `isRepairing` so the UI can show a transient
"Repairing…" state, and `SkillRunnerPanel` renders a subtle, secondary
per-step badge — "Self-checked" (passed), "Auto-repaired" (a repair was
kept), or "Check not satisfied" (residual failures, with the messages in
the `title`).

Built-in skills are wired conservatively: lenient `{ nonEmpty: true }`
broadly, and structural predicates (`mustStartWith: "="` for Sheet
formulas, `mustInclude: ["## "]` for slide outlines, `forbidFences` for
prose steps) **only** where the step's own behaviour already satisfies
them. The deterministic check _complements_ — does not replace — the
Sheet skill's existing model-based self-check step.

Scope boundaries (deliberate, to keep the change tight and reviewable):

- The IPC schema, N-API bridge, and Rust runtime are untouched; `grammar`
  remains declared-but-unenforced as in 0012.
- `check` is **not** added to custom-skill authoring (the
  `SkillEditorModal` / `customSkills.ts` serialisation) in this change —
  noted as a follow-up so users can later attach checks to their own
  skills.

## Consequences

- A malformed step output is now caught the moment it is produced and
  repaired in-band, before it can poison downstream steps — closing the
  "structured-output discipline per step" and "self-verification" gaps
  from the critique with **no** model size increase and **no** IPC/Rust
  change.
- The check is deterministic and regex-free, so it adds negligible cost,
  cannot be made to hang, and cannot execute model-supplied text. The
  repair pass costs at most one extra `model.generate` per failing step
  (`MAX_STEP_REPAIRS = 1`).
- "Strictly better" + "never hard-fail" means the feature can only
  improve or preserve a run's output, never regress or block it; a step
  that cannot be repaired still completes, with its residual problems
  surfaced to the user rather than hidden.
- `evaluateCheck` / `compileRepairStep` are pure and exhaustively
  unit-testable; the loop itself is covered by synthetic-skill runner and
  panel tests, so the built-in fixtures did not need to be perturbed.
- **Follow-up:** expose `check` authoring in the custom-skill editor, and
  (if the IPC schema ever gains a `grammar` field) layer GBNF enforcement
  _underneath_ these checks rather than replacing them.
