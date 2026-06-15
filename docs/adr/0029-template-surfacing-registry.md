# 29. Surface template cards from the registry, not a hardcoded list

## Status

Accepted. Builds on [0008](0008-n-api-bridge.md) (the N-API bridge that
already carries `TemplateInfo` from the Rust registry to the renderer)
and complements [0023](0023-slide-user-templates.md) (user-authored
templates discovered from disk). Where 0023 made _slide_ templates
discoverable, this decision makes the renderer's **generic template
gallery** discover any bundled template directly from the registry.

## Context

Generation templates ship as YAML under `templates/<category>/`
(`documents`, `slides`, `sheets`, `bases`, `infographics`,
`landing_pages`) plus `locales/<lang>/` variants. They carry metadata —
`locale` (BCP-47, default `en`) and `industry: Vec<String>` — and are
auto-discovered by the Rust registry and by the auto-walking test
`crates/tessera_templates/tests/bundled_templates.rs`. Adding a template
is meant to be "drop a YAML file."

It was not. `apps/desktop/renderer/src/pages/CreatePage.tsx` surfaced
template **cards** from a hardcoded `CATEGORIES: Record<string,
CategoryItem[]>` map, and each entry _also_ hand-encoded that template's
`industry` tags and `availableLocales`. So shipping a template took a
YAML file **and** a hand-registered card — and worse, the industry/locale
metadata was duplicated between the YAML (source of truth) and the
renderer literal, where it silently drifted. This hand-registration is a
bottleneck that serializes otherwise-parallel template work and is a
recurring source of "I added the YAML but it doesn't show up" bugs.

Three forces shaped the design:

1. **A new YAML must appear with no renderer edit.** That is the whole
   point — existence and filterability of a card must come from the
   registry.
2. **Some structure is genuinely editorial, not derivable.** The four
   tabs (Create / Analyze / Plan / Approve) are a _semantic workflow_
   taxonomy: the same `artifact_type` legitimately splits across tabs,
   and templates carry no "tab"/"intent" field. The named quick-start
   **workflow shortcuts** (e.g. "Summarize sources") are not template
   files at all — they are curated entry points that run an underlying
   template. Short display names ("PRD" vs. the YAML's "Product
   Requirements Document") are also editorial.
3. **The gallery must stay correct and fast.** It must render its
   curated structure synchronously (the smoke test
   `__tests__/smoke/featureVerification.test.ts` statically parses a
   top-level `const CATEGORIES` out of this file, and unit tests assert
   curated cards render immediately), and it must not pay for a registry
   fetch in the wizard or the runner where the gallery is not shown.

A pure "derive everything from the registry" design fails force 2; the
status-quo "curate everything" fails force 1. The decision is a hybrid.

## Decision

**Additive registry metadata (Rust, no schema break).** Extend the
N-API `TemplateInfo` (`crates/tessera_bridge/src/templates.rs`) with
three additive fields, each with a serde default so older serialized
records still deserialize and `SCHEMA_VERSION` is untouched:

- `industry: Vec<String>` (`#[serde(default)]`) — mirrors the YAML.
- `locale: String` (`#[serde(default = "default_locale")]`, `"en"`) —
  mirrors the template loader's base-language default.
- `category: String` (`#[serde(default)]`) — the on-disk directory,
  computed from the artifact type by `category_for(ArtifactType)`
  (`Document → "documents"`, `Sheet → "sheets"`, …) so the renderer
  groups templates without re-implementing the artifact→directory map.

`list_templates` / `list_templates_with_audit` / `get_template` are
otherwise unchanged; the fields flow through the existing
`bridge_list_templates` / `bridge_get_template` exports automatically and
N-API camel-cases them (`industry`, `locale`, `category`,
`artifactType`, …). The hand-written IPC contract in
`apps/desktop/shared/types.ts` (re-exported by
`renderer/src/types/ipc.ts`) is the renderer-side mirror and gains the
same three fields — editing it _is_ the "regenerate types" step; there
is no separate codegen.

**Hybrid gallery: curated overlay × registry derivation
(`CreatePage.tsx`).** Keep `const CATEGORIES` as a small _curated
overlay_ that owns only what is editorial — tab placement, short
name/description, and the `badge: "workflow"` shortcuts — and **delete**
the per-entry `industry`/`availableLocales` values and the old
`CORE_LOCALES` constant. A pure `buildDerivedCategories(registry)` then
JOINs that overlay with `window.tessera.templates.list()`:

- **Overlay:** every curated entry keeps its tab/name/description, but
  its `industry` and `availableLocales` are overlaid from the registry —
  the YAML is now the single source of truth for filterable metadata.
- **Auto-surface:** any base template (`locale === "en"`) whose id is
  _not_ curated is appended as a plain card under
  `defaultTabForCategory(category)` (sheets/bases → Plan; everything
  else → Create). This is what lets a freshly dropped YAML appear as a
  filterable card with zero edits to this file.
- **Locale grouping:** localized variants (`<base-id>-<locale>`,
  `locale !== "en"`) are never their own card; they are grouped into
  their base id's `availableLocales`, so the language filter and
  `resolveTemplateId` can navigate to `<base-id>-<locale>` when a variant
  exists and the bare base id otherwise.

The existing industry filter, language filter, search, tab layout, and
workflow shortcuts are preserved; workflow shortcuts always pass the
filters.

**Why `const CATEGORIES` survives, and synchronous rendering.** Keeping
a literal `const CATEGORIES` keeps the static smoke test green and — more
importantly — lets the gallery render the curated cards **synchronously**
from an empty registry. `buildDerivedCategories([])` returns the curated
overlay verbatim; the auto-surfaced cards appear once
`templates.list()` resolves (a microtask that does not flush inside a
synchronous test). So the render is never gated on a `loading` flag, the
gallery is correct before _and_ after the fetch, and existing
synchronous unit tests keep passing.

**Performance.** The gallery is extracted into a `TemplateGallery` child
that is mounted **only** in gallery mode, so `useTemplateList()` (the one
`templates.list()` call) never fires in wizard or runner mode.
`buildDerivedCategories` is pure and memoised on the registry array.

## Consequences

- Dropping a template YAML makes it appear as a filterable card with **no
  `CreatePage.tsx` edit** — existence, industry tags, and available
  locales all come from the registry. Parallel template work no longer
  serializes on hand-registration.
- `industry`/`locale` are no longer duplicated in the renderer; the YAML
  is authoritative and cannot drift from the card.
- Tabs, short names, and workflow shortcuts remain curated **by design** —
  they encode editorial/semantic intent the registry does not carry. An
  auto-surfaced template lands in a sensible default tab and can be
  promoted (renamed / re-tabbed) later by adding a `CATEGORIES` entry,
  which always wins over the fallback.
- The Rust change is additive (serde defaults, no `SCHEMA_VERSION` bump);
  `get_template` and both `list_*` paths keep their existing behavior.
- `category` is a derived convenience (artifact type → directory); it is
  not authoritative on-disk layout, and a future artifact type defaults
  to the Create tab until `defaultTabForCategory` is taught otherwise.
- The auto-surface order trails the curated cards alphabetically (the
  registry sorts by name); curated curation order is preserved within a
  tab. Filter counts and empty states are computed from the derived,
  per-tab list, so they stay accurate as templates are added.
