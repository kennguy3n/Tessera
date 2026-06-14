# 12. Deliberate multi-step Skills engine for small-model AI quality

## Status

Accepted.

## Context

Every AI affordance in Tessera's editors is **single-shot**: the
Document assistant (`buildAiPrompt`), the Slide deck generator
(`buildDeckPrompt`), and the Sheet/Base helpers each assemble one
self-contained prompt, make a single `window.tessera.model.generate`
call, and parse the result line-by-line. "Instruction templates" today
are limited to (a) static per-action prompt strings in the various
`*AiHelpers.ts` files and (b) per-section `prompt:` fields in
`templates/<category>/*.yaml`.

Single-shot prompting is the worst regime for the small, local model
Tessera ships (a Ternary-Bonsai 1.58-bit weight selected by device
tier). Small models degrade sharply when asked to plan, produce, and
self-correct in one pass, which is exactly where Tessera's output
quality trailed cloud assistants and one-prompt deck/site generators.

We needed a way to lift small-model quality **without** swapping in a
bigger model or changing the renderer↔Electron IPC contract. The
`model:generate` IPC schema (`GenerateRequestSchema`) accepts only
`{ templateId?, sourceIds?, sectionIndex?, prompt, maxTokens?,
temperature? }` — notably there is **no `grammar` field over IPC**;
GBNF-constrained decoding exists only at the Rust runtime layer. Adding
a grammar field would mean an IPC schema + handler + Rust change that
trips the IPC-audit quality gate, so it was explicitly kept out of scope.

## Decision

Add a renderer-side, surface-agnostic **Skills engine** that orchestrates
several deliberate steps (plan → draft → critique → revise, …) over the
*existing* single-shot IPC. A small model run through a deliberate loop
produces markedly better output than the same model run once.

New module `apps/desktop/renderer/src/skills/`:

- **`skillTypes.ts`** — declarative, dependency-light schema. A `Skill`
  has `inputs` and an ordered list of `SkillStep`s; each step declares a
  `kind` (`plan|draft|critique|revise|extract|format`), an `instruction`,
  the context variables it reads (`inputsFrom`), and the variable it
  writes (`output`). `CompiledStep` is the fully-resolved, ready-to-send
  form.
- **`skillEngine.ts`** — a **pure** compiler (the core IP, fully
  unit-tested, no React/IPC imports). It interpolates `{{var}}`
  references, prepends a per-kind preamble, appends each upstream
  variable as a labelled block and the step's output contract, clamps
  sampling params (per-kind `temperature`/`maxTokens` defaults), folds a
  step's cleaned output back into context immutably (`foldStepOutput`),
  sanitizes model output (`cleanStepOutput`: strips code fences, leading
  "Sure, here's…" labels and wrapping quotes — mirroring
  `documentAiHelpers`), and validates skills (`validateSkill`: no dup
  ids/outputs, no forward/unknown variable references, non-blank
  instructions). Context values are length-clamped
  (`MAX_CONTEXT_VALUE_CHARS`) to bound prompt growth across steps.
- **`skillLibrary.ts`** — four seed skills, one per surface
  (`document-deliberate-draft`, `slide-plan-write-tighten`,
  `sheet-intent-formula-selfcheck`, `base-schema-design`), plus
  `getSkillById` / `getSkillsForSurface` lookups.
- **`useSkillRunner.ts`** — a thin React hook that executes
  `CompiledStep`s **sequentially** over the existing streaming IPC. It
  mirrors `useDocumentAi`'s contract exactly: subscribe to
  `model.onToken`, call `model.generate(...)`, accumulate tokens, guard
  stale runs with a monotonic `runIdRef`, honour the `battery_low`
  generation sentinel, and support cancel. Between steps it cleans the
  output and threads it into context via `foldStepOutput` before
  compiling the next step.

UI integration is additive and reuses existing styles/helpers:

- **`editors/components/SkillRunnerPanel.tsx`** — a presentational,
  accessible panel (text status labels, `aria-live`, `htmlFor` labels —
  not colour-only) that drives `useSkillRunner`, shows per-step progress
  and live output, and hands the final text back via `onApply`.
- **`AiAssistantPanel.tsx`** gains a "Quick actions / Skills" toggle. In
  Skills mode it renders `SkillRunnerPanel` for the document surface and
  applies the result through the existing `applyAiResult` path
  (insert-below, or replace when there is a selection).

### Why renderer-only, and how structure is enforced

Because the IPC has no `grammar` field, per-step structure is enforced at
the **prompt level** via each step's `outputContract` (the same technique
`slideAiHelpers` uses with its deck output contract), not via GBNF. The
`grammar` field is carried through `SkillStep`/`CompiledStep` as a
forward-compatibility/intent hint but is **not** enforced today. This
keeps the entire change inside the renderer, leaving the IPC schema, the
N-API bridge, and the Rust runtime untouched — so no IPC-audit, cold-start,
or Rust gate is affected.

## Consequences

- Small-model output quality improves on the deliberate loop without a
  bigger model, a new model download, or any IPC/Rust change. The engine
  is opt-in per run and sits beside the existing single-shot quick
  actions, which are unchanged.
- The engine is **surface-agnostic**: the same compiler, runner, and
  panel back Document/Slide/Sheet/Base skills. Only the Document surface
  is wired into its assistant panel in this change; rolling the panel
  under the Slide/Sheet/Base assistants is incremental follow-up work.
- The compiler is pure and isolated from React and IPC, so its prompt
  layout, clamping, folding, sanitisation, and validation are exhaustively
  unit-testable (`skills/__tests__/`), and the runner is tested against a
  scripted fake of the model surface.
- Deliberate skills make **N model calls per run** instead of one (N =
  step count). Each step is bounded by its clamped `maxTokens`, runs on
  the same streaming path (cancellable, battery-gated), and threads only
  length-clamped context forward, but a skill run is inherently slower and
  more compute-heavy than a single-shot action — an acceptable trade for
  the quality lift, and the reason skills are a separate, explicit mode.
- **Follow-ups (deliberately out of scope):** wiring per-step GBNF through
  a new IPC `grammar` field + the sidecar; a deterministic
  `parseFormula`-backed tool step for the Sheet skill's self-check; loading
  user- and connector-authored skills from disk; and surfacing the panel
  in the Slide/Sheet/Base assistants.
```
