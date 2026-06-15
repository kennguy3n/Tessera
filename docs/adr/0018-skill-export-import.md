# 18. Export / import a skill as a portable, shareable file

## Status

Accepted. Extends [0012](0012-deliberate-skills-engine.md) (the
deliberate Skills engine) and [0013](0013-user-authored-skills.md)
(user-authored "custom" Skills), reusing the same renderer-only
serialisation + validation layer those decisions established.

## Context

A skill is declarative data — a named template of steps, inputs,
contracts, checks, and sampling — that the engine interprets. Once a
user can author one ([0013](0013-user-authored-skills.md)), the obvious
next lever is making one **shareable**: a good "draft → critique →
revise" recipe, or a domain-specific format contract, is worth handing
to a teammate (or moving between machines) rather than re-authoring by
hand. Until now a custom skill lived only in `localStorage`
(`tessera.skills.custom`) with no way out, and the built-ins — which are
the best worked examples of contracts/checks/sampling — could not be
used as portable starting templates at all.

The data already round-trips losslessly: `serializeCustomSkillStore` /
`parseCustomSkillStore` persist a `{ version, skills }` envelope, and
`parseStoredInputs` / `parseStoredSteps` / `buildCustomSkill` coerce and
validate an arbitrary stored object into a well-formed `Skill`. What was
missing was a **single-skill** portable file format and the UI to
produce and consume it. This is purely a renderer concern: no engine,
IPC, Rust, or persistence-schema change is needed.

The one correctness hazard is identity. The persistence envelope keys
skills by `id`, and a custom id is namespaced (`custom-…`). If an
imported file kept its `id`, importing it could silently **overwrite** a
different skill that happens to share that id, and importing a built-in
(whose id is not `custom-…`) would produce an un-editable, un-deletable
"custom" skill. Import must therefore always mint a fresh id.

## Decision

Add a portable single-skill file format and Export / Import controls,
entirely in the renderer, reusing the existing coercion + validation.

**File format** (`skills/customSkills.ts`): a tagged, versioned envelope
distinct from the `localStorage` store envelope —
`{ format: "tessera.skill", version: 1, skill }` — pretty-printed for
human inspection. The `format` tag lets an arbitrary `.json` be told
apart from a Tessera skill before parsing; the export `version`
(`SKILL_EXPORT_VERSION`, independent of the private persistence
`SCHEMA_VERSION`) lets a future format change be refused cleanly rather
than half-read.

Three pure functions back it:

- `serializeSkillExport(skill)` — wraps any skill (built-in **or**
  custom) in the envelope. Pure: it never mutates the skill and does no
  IO, so exporting a built-in yields its canonical template as a
  starting point.
- `exportSkillFilename(skill)` — a stable `tessera-skill-<slug>.json`
  download name derived from the skill name via the existing
  `slugifyVar`.
- `parseSkillImport(raw)` → `{ ok: true, draft } | { ok: false, error }`.
  It never throws: malformed input degrades to a friendly message. It
  validates the envelope (`format`, `version` not newer than supported,
  a `skill` object with a string `name`), then routes the raw skill
  through the **same** `parseStoredInputs` / `parseStoredSteps`
  coercion and `buildCustomSkill` validation the persistence layer uses,
  so an imported template can never be less well-formed than one
  authored in the editor. Crucially it builds the draft **without an
  id**, so a fresh custom id is minted on save — an import can never
  overwrite or shadow an existing skill, even one exported from a
  built-in.

**UI** (`editors/components/SkillManagerControls.tsx`): the manage row
gains **Export** (enabled whenever a skill is selected; works for
built-ins too) and **Import** buttons alongside New / Edit / Duplicate /
Delete. Export runs the standard blob-download dance
(`URL.createObjectURL` → temporary `<a download>` → `revokeObjectURL`),
matching `BaseEditor`'s existing `triggerDownload`. Import drives a
hidden `<input type="file" accept=".json">`; on file selection it reads
the text, runs `parseSkillImport`, and on success opens the
`SkillEditorModal` pre-filled exactly like Duplicate (draft id
undefined ⇒ fresh custom id on save), so the user reviews before
committing. A rejected import shows an inline `role="alert"` message in
the row and opens no editor.

## Consequences

- A custom skill (or a built-in used as a template) can be exported to a
  portable file and imported on another machine or by another user, with
  every authored field — steps, inputs, `outputContract`, `check`,
  per-step sampling, `inputsFrom` — preserved losslessly through the
  export → import → build round-trip.
- Import is **non-destructive by construction**: it always mints a new
  custom id, so it can never overwrite an existing skill, and a built-in
  imported this way becomes a fully editable/deletable custom copy.
- Imported data is held to the same bar as editor-authored data: it
  flows through `parseStored*` + `buildCustomSkill`, so a malformed or
  structurally invalid file is rejected with a friendly, specific reason
  rather than producing a broken skill.
- No new engine, IPC, Rust, or persistence surface, and **no
  `SCHEMA_VERSION` bump**: the export envelope is versioned
  independently, and import reuses the existing data layer. The new
  localStorage shape is unchanged, so existing saved skills load as
  before.
- The pure functions (envelope shape, filename slug, every rejection
  path, and built-in / custom round-trips) and the UI (the Export
  download dance, import-opens-editor-pre-filled, import-mints-a-new-id,
  and the inline error) are unit-tested.
