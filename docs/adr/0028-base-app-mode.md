# 28. Base app-usage mode + Base template gallery

## Status

Accepted. Gives the Base editor the "use it, don't just build it" face that
Slides got through its template arc, and reuses two patterns this codebase
has already hardened: the renderer-only persisted-store + `useSyncExternalStore`
hook for user content ([0019](0019-slide-brand-kit.md),
[0023](0023-slide-user-templates.md)), and the portable
`{ format, version, <item> }` file with a hardened version guard and
non-destructive import ([0018](0018-skill-export-import.md),
[0023](0023-slide-user-templates.md)). Renderer-only; no IPC, Rust, or
`SCHEMA_VERSION` change.

## Context

The Base editor (`editors/BaseEditor.tsx` + `editors/baseviews/**`) is
Airtable-class: multi-table linked records, lookup / rollup / formula /
auto-number fields, grid / kanban / calendar / timeline / gallery / form
views, group-by, color-by, an expand-record modal, CSV/JSON import-export,
comments, and on-device AI. All of it is **builder** surface — chrome for
_shaping_ a base. There was no way to _use_ a base as a focused
mini-application: every interaction routed through builder affordances
(the expand-record modal exposes field-management and schema controls;
`baseviews/FormView.tsx` was a write-only builder preview, not a runtime
data-entry surface), and there was no at-a-glance summary of the data.

Two adjacent precedents shaped the approach:

1. **A base already serialises two ways.** `baseDocumentHelpers.ts` parses
   _either_ the legacy `{ fields, records }` blob (wrapped into a single
   table) _or_ the `{ tables, activeTableId }` document, and a single-table
   base round-trips **byte-compatibly** back to the legacy shape. Any new
   persisted state has to preserve that invariant or it breaks every
   existing base and test.
2. **User content is a solved problem.** `customSlideTemplates.ts` +
   `useCustomSlideTemplates.ts` (and `skills/customSkills.ts`) already
   define the versioned, defensive `localStorage` store, the shared
   `useSyncExternalStore` hook, and the portable single-item file with a
   hardened version guard and id-dropping import.

The work was to add an app-usage runtime over the _existing_ base data
model (no new field/record concepts) and persist its small amount of
configuration without disturbing the legacy round-trip — then, as a second
deliverable, let users start a base from a pre-built template and save /
share their own.

## Decision

Add an **app mode** to the Base editor and a **template gallery**, both
additive and renderer-only.

### App mode

**A `builder ⇄ app` toggle.** A toolbar control switches the editor between
the full builder and an app runtime that hides builder chrome (field
management, view config, schema editing). The _current_ mode is ephemeral
renderer state; only which mode a base **opens** in persists
(`BaseAppConfig.defaultMode`), so a legacy base with no `app` block always
opens in the builder, unchanged.

**`AppShell` + derived pages.** `baseviews/appmode/AppShell.tsx` renders a
left nav whose pages are largely **derived**: one data page per table, one
page per configured form, and a dashboard. So an empty `app` block is still
a usable app (browse every table, see counts) with zero authoring. App-mode
mutations reuse the existing index-based active-table handlers
(`onUpdateCell` / `onRemoveRecord` operate on indices into the _active_
table), so a record-mutating surface first switches to its own table to keep
indices aligned, and "open the newest record after add" is tracked with a
pending-open ref.

**Record detail page.** `baseviews/appmode/RecordDetail.tsx` replaces the
builder expand-modal in app mode with a clean read/edit page: fields, linked
records, and lookups/rollups, inline editing via the **exported** `CellInput`
/ `LongTextModal` from `BaseEditor` (reused, not reimplemented), and
prev/next navigation across the current record set.

**Data-entry forms.** `baseviews/appmode/AppForms.tsx` promotes `FormView`
into the runtime: it lists every configured form, renders a fillable subset
(`fieldNames` empty = all fillable fields) by passing a derived
`{ ...data, fields: subset }`, and submit creates a record via the existing
`addRecordWith`. More than one form is supported (one nav entry each).

**Lightweight dashboard.** `baseviews/appmode/AppDashboard.tsx` +
`dashboardData.ts` compute counts, group-by breakdowns, single rollups, and
a simple bar chart over existing fields, reusing the base/sheet helpers
(`aggregateValues`, `barLayout`, `yAxisTicks`) — no new chart dependency.

**Persistence (legacy-safe by construction).** App config lives in an
optional `app?: BaseAppConfig` on `BaseDocument` (`forms`, `dashboard`, and
optional `name` / `defaultMode`). The round-trip invariant is enforced in
`baseDocumentHelpers.ts`:

- On parse, the config is sanitised + reconciled against the live tables
  (`reconcileAppConfig`) and attached **iff** it is meaningful
  (`isMeaningfulAppConfig`); otherwise `doc.app` stays `undefined` and the
  base opens in the builder.
- On serialise, a single-table base **with no meaningful app config** still
  emits the byte-identical legacy `{ fields, records }` body. Only once the
  config is meaningful does it emit the full `{ tables, activeTableId, app }`
  shape — necessary because forms/widgets reference table ids, and the
  legacy body has no id to reference. `app` is appended additively, so the
  Rust core (which ignores unknown fields — see `signing.rs`) and any reader
  that only consumes `fields`/`records` are unaffected.

There is **no `SCHEMA_VERSION` bump**: missing or partial config degrades to
"no forms, no widgets, opens in builder", and any reference to a renamed /
deleted field or table is reconciled away on load.

### Template gallery

**Built-in starters (`baseTemplates.ts`).** Five stateless `build()`
factories — CRM, project tracker, content calendar, applicant tracker, asset
inventory — each returning a single-table `BaseDocument` _with_ an embedded
app config (count / rollup / chart / group widgets + an intake form) so a
starter is a usable app immediately, not a bare schema. Each build mints
fresh table/record ids.

**User templates (`customBaseTemplates.ts` + `useCustomBaseTemplates.ts`).**
The Base analogue of the slide-template store. A `CustomBaseTemplate` is
`{ id, label, description?, category?, content: BaseDocument }` — it captures
the **whole saved base**, not a skeleton. One validation gate,
`buildCustomBaseTemplate(draft)`, collapses + length-bounds the label
(rejecting empty), drops a blank description, coerces an unknown category to
"All", and — crucially — round-trips the embedded base through the editor's
own `serializeBaseDocument` → `parseBaseDocument` codec (`coerceBaseDocument`).
That deep-clones the content (so a stored template never aliases live
records), re-runs every sanitiser, and reconciles the app config, exactly as
loading a saved base would. The `{ version, templates }` store at
`tessera.basetemplates.custom` never throws on bad JSON / wrong version /
non-array, drops malformed / duplicate / foreign-id (`basetpl-`) entries, and
caps at 50 (oldest dropped). `useCustomBaseTemplates` exposes
`customTemplates` + `saveTemplate` / `deleteTemplate` / `duplicateTemplate` /
`templateById` through a module store read via `useSyncExternalStore`, so a
save in one editor updates every open gallery.

**Portable file.** A `{ format: "tessera.basetemplate", version: 1, template }`
envelope, versioned independently of the store. `parseBaseTemplate(raw)`
never throws: it checks the `format` tag, applies the hardened version guard
(reject non-numeric / non-integer / `< 1` — so `0`, `-1`, `0.5`, `NaN`,
`Infinity` all read as "not valid" — _then_ reject `> BASE_TEMPLATE_VERSION`
as "newer"), routes the embedded base through `coerceBaseDocument`, and
**always drops the id** so saving mints a fresh `basetpl-` id and an import
can never overwrite an existing template.

**Apply = replace the document (a noted default).** `BaseEditor` owns a
single artifact and has no "new base" entry point (`CreatePage` is out of
scope), so "insert a template" means **replace the whole document**. This is
guarded by an inline confirm when the current base holds records
(`baseHasData`). The gallery (`components/BaseTemplateGallery.tsx`, over the
shared `Modal`) lists built-ins by category, the user's saved templates with
Use / Export / Delete, a "save this base as a template" form, and import via
a hidden file input; applying reconstructs the live document through
`instantiateBaseDocument` and resets view / app-mode / expanded-record state.

## Consequences

- A base can be **used**, not just built: a `builder ⇄ app` toggle, a derived
  app navigation, a readable record-detail page with inline edit and
  prev/next, one or more runtime data-entry forms, and a lightweight
  dashboard (counts, group-by rollups, a bar chart) over existing fields.
- The feature is **additive and legacy-safe**: `app` is optional, a base
  with no meaningful config serialises byte-for-byte as the legacy
  `{ fields, records }` body and opens in the builder, missing/partial config
  degrades gracefully, stale field/table references are reconciled on load,
  and there is **no `SCHEMA_VERSION` bump**.
- Users can **start from a template** (five app-wired built-ins), **save** the
  current base as a named/categorised template that reproduces it faithfully
  (every table, field, sample record, and the app config), and **export /
  import** a portable `tessera-base-template-<slug>.json` that re-imports —
  in the same or a fresh session — as a new, non-overwriting template.
- Imported and persisted templates are held to the same bar as
  editor-authored bases: every path flows through the base codec +
  `buildCustomBaseTemplate`, so a malformed file or corrupt store entry is
  rejected or degraded with no throw and nothing broken reaches the editor.
- **Renderer-only and local-first**: no new IPC, Rust, network, or
  persistence-schema surface; adding `app` to the serialized body is safe
  because the core ignores unknown fields. The store envelope and the
  portable-file envelope are versioned independently so each can evolve alone.
- App-config sanitise/reconcile + the persistence round-trip (legacy and
  app-config branches), the dashboard data helpers, the built-in starters
  (app-wired + codec round-trip), the user-template store / defensive parse /
  version guard / portable-file round-trip, and the hook lifecycle are all
  unit-tested.
