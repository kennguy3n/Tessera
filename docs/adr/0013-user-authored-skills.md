# 13. User-authored ("custom") Skills persisted in the renderer

## Status

Accepted. Builds on [0012](0012-deliberate-skills-engine.md) (the
deliberate multi-step Skills engine) and [0004](0004-local-first.md)
(local-first architecture).

## Context

ADR 0012 shipped a renderer-side Skills engine plus four **built-in**
skills hard-coded in `skills/skillLibrary.ts` (`BUILTIN_SKILLS`). Those
templates are immutable: a user cannot tweak a step's instruction,
change the output contract, add an input, or author a new skill for a
workflow we did not anticipate. "Loading user-authored skills" was
listed as an explicit out-of-scope follow-up in 0012, and it is the
single biggest gap versus editors whose value comes from
user-customisable templates.

The constraints from 0012 still hold:

- The `model:generate` IPC schema (`GenerateRequestSchema`) is fixed and
  has **no `grammar` field**; the Skills engine runs entirely in the
  renderer over the existing single-shot IPC. A custom-skills feature
  must not touch the IPC schema, the N-API bridge, or the Rust runtime.
- Skills are pure data (`Skill` = `inputs` + ordered `SkillStep`s) and
  the engine already exposes a pure `validateSkill` that rejects
  duplicate ids/outputs, forward/unknown `{{var}}` references, and blank
  instructions.

So the open questions were only: **where do user skills live**, and
**how does a user author them safely** without letting malformed data
corrupt the engine.

Persistence options considered:

1. **App settings / config (`SettingsData` + `AppConfigSchema`, IPC).**
   Durable and synced with other settings, but it means a schema change,
   an IPC round-trip on every read/write, and a config migration — heavy
   for what is essentially a pile of user-editable text, and it drags the
   feature across the renderer-only boundary 0012 deliberately drew.
2. **`localStorage`, mirroring `utils/conceptGraphPresets.ts`.** The
   concept-graph presets already persist user-authored, re-creatable
   structures to a versioned `localStorage` store with defensive parsing
   that never throws. Same data shape (small JSON), same lifetime
   (per-device, user-owned), same failure tolerance.

## Decision

Persist user-authored skills in the renderer via `localStorage`,
mirroring the `conceptGraphPresets` pattern, and reuse the engine's
`validateSkill` so a custom skill is structurally identical to a
built-in once saved.

New modules under `apps/desktop/renderer/src/skills/`:

- **`customSkills.ts`** — a **pure** persistence + sanitisation module
  (no React, no IPC). It defines author-facing draft types
  (`CustomSkillDraft` / `CustomInputDraft` / `CustomStepDraft`),
  normalises a draft into a real `Skill` (`buildCustomSkill`: slugifies
  variable names via `slugifyVar`, prunes `inputsFrom` references that do
  not resolve at that point in the chain, clamps lengths, dedupes
  ids/outputs, then runs `validateSkill` and maps any structural problem
  to an author-friendly message), and reads/writes a **versioned** store
  (`CUSTOM_SKILLS_STORAGE_KEY = "tessera.skills.custom"`,
  `SCHEMA_VERSION = 1`). `parseCustomSkillStore` never throws: bad JSON,
  a wrong version, a non-array payload, malformed/duplicate entries, or a
  non-custom id are all dropped, and the store is capped
  (`MAX_CUSTOM_SKILLS`, `MAX_SKILL_STEPS`, `MAX_SKILL_INPUTS`). Custom ids
  are namespaced (`custom-…`) so a user skill can never shadow or
  impersonate a built-in.
- **`useCustomSkills.ts`** — a tiny module-level store exposed through
  `useSyncExternalStore`, so every mounted AI panel sees the same merged
  list and re-renders when a skill is saved or deleted. The hook returns
  `skillsForSurface(surface)` = built-ins for that surface **followed by**
  the user's custom skills for it, plus `saveSkill` / `deleteSkill` /
  `skillById`.

UI integration is additive and reuses existing components/styles:

- **`editors/components/SkillEditorModal.tsx`** — an authoring form built
  on the existing `components/Modal.tsx` (focus-trapped, `role="dialog"`).
  It edits name, description, the four surface checkboxes, an inputs
  editor (each input shows its derived `{{variable}}`), and a steps editor
  (title, kind, instruction, the `inputsFrom` "attach earlier material"
  checkboxes, and output variable). It surfaces `buildCustomSkill`
  validation errors inline and only closes on a successful save. Both skill
  context mechanisms from the engine are exposed: inline `{{var}}`
  interpolation **and** labelled `inputsFrom` blocks.
- **`editors/components/SkillManagerControls.tsx`** — a shared New / Edit /
  Duplicate / Delete control strip (Edit/Delete enabled only for custom
  skills; Duplicate works on built-ins too, producing an editable copy;
  Delete uses an inline confirm, not `window.confirm`).
- All four assistant panels (`AiAssistantPanel`, `SlideAiPanel`,
  `SheetAiPanel`, `BaseAiAssistant`) now source their skill list from
  `useCustomSkills().skillsForSurface(surface)` instead of the static
  `getSkillsForSurface`, and render `<SkillManagerControls>` next to the
  picker. `SkillRunnerPanel` re-seeds its input fields when the selected
  skill's **input signature** changes, so editing a custom skill in place
  (same id) does not leave stale fields.

### Privacy

Consistent with ADR 0004: a custom skill stores only the user's own
template text on-device in `localStorage` and is **never transmitted**.
At run time the engine interpolates only user-entered input values and
prior on-device step outputs — exactly like a built-in skill — so
authoring a skill adds no new data egress.

## Consequences

- Users can create, edit, duplicate, and delete deliberate multi-step
  skills for any surface, and run them through the same engine, runner,
  and panel as the built-ins — closing the biggest template-flexibility
  gap from the critique without a bigger model or any IPC/Rust change.
- The feature stays fully inside the renderer-only boundary 0012 drew:
  no `SettingsData`/`AppConfigSchema`/IPC/migration changes. The pure
  `customSkills.ts` is exhaustively unit-testable, and `validateSkill`
  reuse means a saved custom skill obeys the same structural invariants as
  a built-in.
- **`localStorage` trade-offs (accepted):** the store is per-device and
  not synced across machines, is subject to the browser storage quota
  (bounded here by the skill/step/input caps), and is wiped if the user
  clears site data. Because skills are small, user-authored, and
  re-creatable templates (the same rationale as `conceptGraphPresets`),
  this is acceptable; a future migration to a synced/config-backed store
  can re-import the `localStorage` payload if durability needs grow.
- Custom skills are merged **after** built-ins per surface, so the
  built-in default selection and ordering are unchanged when a user has no
  custom skills, and the picker only appears once more than one skill
  exists for a surface (unchanged from 0012).
