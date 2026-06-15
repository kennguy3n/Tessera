# 23. User-authored slide templates + portable template files

## Status

Accepted. Completes the arc the slide-template library began
([0020](0020-slide-template-library.md)) by making the gallery
_user-extensible_, mirroring how Skills became user-authored
([0013](0013-user-authored-skills.md)) and then shareable
([0018](0018-skill-export-import.md)). Reuses the renderer-only
persisted-store + `useSyncExternalStore` hook pattern established for the
Slide Brand Kit ([0019](0019-slide-brand-kit.md)). Renderer-only; no IPC,
Rust, or schema change.

## Context

After [0020](0020-slide-template-library.md) the Slides gallery lists 24
built-in templates by category, each with a live `SlideThumbnail`. A
built-in `SlideTemplate` is _stateless metadata_
(`{ id, label, description, icon, suggestedTheme?, slides }`) materialised
into a deck by `buildDeckFromTemplate`. But a user who has carefully built
a real deck — chosen a theme, an aspect ratio, a brand kit, written
layouts and backgrounds — cannot save it as a reusable starting point, nor
carry it into a separate session. The catalogue is read-only.

Two precedents already solve the hard parts in this codebase:

1. **A versioned, defensive `localStorage` store + a shared hook.**
   `slideBrandKit.ts` persists a `{ version, … }` envelope and exposes it
   through `useBrandKits` (`useSyncExternalStore`), so a mutation in one
   editor is reflected everywhere and a corrupt blob never throws.
   `skills/customSkills.ts` does the same for custom Skills.
2. **A portable, single-item file.** [0018](0018-skill-export-import.md)
   established the `{ format, version, <item> }` envelope (distinct from
   the store envelope, versioned independently), a hardened version guard,
   and **non-destructive import** — the file's id is always dropped and a
   fresh one minted so an import can never overwrite an existing item.

What was missing was the slide-domain analogue: a model that captures a
whole **deck** (not a metadata skeleton), a store for it, the "Save deck
as template" UX, and a portable file so a template can travel between
sessions. This is purely a renderer concern.

The one correctness hazard, as in [0018](0018-skill-export-import.md), is
identity. The store keys templates by a custom-namespaced id (`tpl-…`). If
an imported file kept its id it could silently overwrite a different
template, and a non-`tpl-` id could shadow a built-in. Import must always
mint a fresh id.

## Decision

Add `editors/customSlideTemplates.ts` (model + store + portable file),
`editors/useCustomSlideTemplates.ts` (shared hook), and the gallery /
toolbar UX in `SlideEditor.tsx`. Everything is additive and renderer-only.

**Model (`CustomSlideTemplate`).** A user template captures the saved deck
plus gallery metadata: `{ id, label, description?, category?, content:
SlideContent }`. Unlike a built-in, `content` is the exact `SlideContent`
the editor persists, so applying it reproduces the deck verbatim — slides,
layouts, backgrounds, theme, aspect ratio, brand kit — not a blueprint
skeleton. The shape is flat and JSON-serialisable so a future Brand Pack
bundle (a sibling initiative) can embed a `templates?: CustomSlideTemplate[]`
array without coupling to this module.

**One validation gate.** Every persisted / imported template flows through
`buildCustomSlideTemplate(draft)`, which collapses + length-bounds the
label (rejecting an empty name), drops a blank description, coerces an
unknown `category` to undefined ("All"), and — crucially — round-trips the
embedded deck through the editor's own `parseSlideContent`
(`normalizeSlideContent`). So an unknown layout/theme/brand-kit id degrades
exactly as it does everywhere else, a corrupt deck can never reach the
canvas, and a stored template can never be less well-formed than one
authored in the UI.

**Persisted store + hook.** A `{ version, templates }` envelope at
`tessera.slidetemplates.custom`. `parseCustomSlideTemplateStore` never
throws: bad JSON, a wrong `SCHEMA_VERSION`, or a non-array `templates`
degrade to "nothing stored"; individually-malformed, duplicate-id, and
foreign-id (non-`tpl-`) entries are dropped; the list is capped at
`MAX_CUSTOM_SLIDE_TEMPLATES` (50, oldest dropped on overflow).
`useCustomSlideTemplates` mirrors `useBrandKits`: a module-level store read
via `useSyncExternalStore` exposes `customTemplates` plus
`saveTemplate` / `deleteTemplate` / `duplicateTemplate` / `templateById`,
so a save in one editor updates every open gallery.

**"Save deck as template" UX.** A toolbar action captures the current deck
(from the same refs the debounced save serialises) into a draft and opens
`SlideTemplateSaveModal` — a thin form over the shared `Modal` for
name/description/category. Saved templates appear in a new "Your templates"
section above the built-in grid, each with a `SlideThumbnail`, and are
filtered/searched by the **same** `filterSlideTemplates` helper — generalised
to `<T extends FilterableTemplate>` so it accepts custom templates with no
change to its pure, built-in behaviour. Each card supports Apply, Edit,
Duplicate, Export, and a two-step Delete. Applying reconstructs the deck via
`parseSlideContent` + a new `cloneSlidesWithFreshIds` helper (every slide/block
id is reissued so the applied deck never aliases the stored template's ids).

**Single active overlay.** The app's `useFocusTrap` documents a
one-overlay-at-a-time invariant (so a single Escape/Tab handler is live).
Edit and Import are launched from _within_ the open gallery, so they close
the gallery before opening the modal and reopen it on close — the user
returns to the now-updated grid without ever stacking two focus traps.

**Portable template file.** A `{ format: "tessera.slidetemplate",
version: 1, template }` envelope, versioned independently of the store
`SCHEMA_VERSION`. `serializeSlideTemplate` pretty-prints it and never
mutates the source; `slideTemplateFilename` derives a stable
`tessera-slide-template-<slug>.json` name. `parseSlideTemplate(raw)` →
`{ ok: true, draft } | { ok: false, error }` never throws: it validates the
`format` tag, applies the hardened version guard (reject
non-numeric/non-integer/`< 1` — so `0`, `-1`, `0.5`, `NaN`, `Infinity` all
read as "not valid" — _then_ reject `> SLIDE_TEMPLATE_VERSION` as "newer"),
and routes the embedded deck through the same `normalizeSlideContent` +
`buildCustomSlideTemplate` gate. It builds the draft **without an id**, so
saving mints a fresh `tpl-` id and an import is non-destructive. Export /
Import controls live in the gallery; Import drives a hidden
`<input type="file" accept=".json">`, reads the text, and on success opens
the modal pre-filled (review-then-save, like Duplicate); a rejected import
shows an inline `role="alert"` message and opens no modal.

## Consequences

- A user can save the current deck as a named, categorised template that
  appears in the gallery with a live thumbnail, re-apply it (reproducing
  the deck faithfully), and manage it (edit / duplicate / two-step delete).
- A template exports to a portable `tessera-slide-template-<slug>.json`
  that re-imports — in the same or a fresh session — as a new,
  non-overwriting template, because import always mints a fresh id.
- Imported and persisted data are held to the same bar as editor-authored
  data: both flow through `normalizeSlideContent` + `buildCustomSlideTemplate`,
  so a malformed file or a corrupt store entry is rejected (or degraded)
  with no throw and nothing broken reaches the canvas.
- The change is additive and legacy-safe: every new field is optional, the
  built-in template ids and `buildDeckFromTemplate` are untouched,
  `filterSlideTemplates` keeps its built-in behaviour, and there is **no
  `SCHEMA_VERSION` bump** — existing decks and the existing store load
  unchanged.
- Renderer-only and local-first: no new IPC, Rust, network, or
  persistence-schema surface. The store envelope and the portable-file
  envelope are versioned independently so each can evolve alone.
- The model, store round-trip + defensive parse, the hook lifecycle, the
  portable-file round-trip + every version-guard and rejection path, the
  save-deck-as-template capture, gallery filtering, apply, and the
  import-pre-fills / inline-error UI are all unit- and UI-tested.
