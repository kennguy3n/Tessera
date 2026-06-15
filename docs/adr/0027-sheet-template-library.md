# 27. Sheet template library, toolbar discoverability, and locale-aware number formats

## Status

Accepted. Brings the Sheets editor (`editors/SheetEditor.tsx`) up to the
bar set by the Slides template system (ADR 0020 "Slide template library"
and ADR 0023 "User-authored slide templates"), reusing the established
patterns: built-in metadata starters, a versioned renderer store +
`useSyncExternalStore` hook, a portable export/import file with a
hardened version guard, and a pure category/query filter. Renderer-only;
no IPC, Rust, or `SCHEMA_VERSION` change.

## Context

The Sheets editor is feature-rich — a 200+-function formula engine
(`editors/formulaEngine/`), range-bound charts, pivot tables, conditional
formatting, data validation, named ranges, freeze panes, filter, sort,
find/replace, and autofill — but two gaps held it back relative to
Slides:

1. **No in-editor template gallery.** Slides shipped a searchable,
   categorised gallery of curated starter decks plus user-saved templates
   and a portable `tessera.slidetemplate` file; Sheets had nothing — a
   new sheet was always an empty grid.
2. **Low discoverability.** Most of the editor's power lived in panels and
   the right-click context menu. The toolbar surfaced charts, pivots,
   conditional formatting, named ranges, validation, and the AI
   assistant, but **freeze panes was context-menu-only**, and there was no
   one-click "chart this selection" path.
3. **Anglo-centric number formats.** The number-format menu offered only
   `$`/`.`/`,` US-style currency and ISO/US dates — no presets for the
   common international currencies or date orders a non-US user expects.

Three forces shaped the design:

- **Mirror Slides, don't reinvent.** The slide modules
  (`slideTemplates.ts`, `customSlideTemplates.ts`,
  `useCustomSlideTemplates.ts`) are the accepted, tested pattern. The
  sheet analogues should mirror them field-for-field so the validation,
  capping, defensive-parse, and version-guard behaviour stay identical
  and reviewable.
- **Additive & legacy-safe.** A sheet saved before this change must load
  byte-identically. Built-in template ids are stable identifiers; new
  toolbar controls must not remove or rename existing ones; no
  `SCHEMA_VERSION` bump.
- **The data model is fixed.** A1 cell references and chart/pivot ranges
  address the data `rows` array (A1 = `rows[0][0]`); the `columns` header
  array is **not** addressable by formulas. Per-cell `formats` are keyed
  `"row,col"` against the data-row index. Templates and the importer must
  respect this exactly, or a template's formulas/formats land on the
  wrong cells.

## Decision

### 1. In-editor template gallery

**Built-ins as pure metadata** (`editors/sheetTemplates.ts`). A
`SheetTemplate` is `{ id, label, description, icon, category, content }`
where `content: SheetTemplateContent` is the structural subset of
`SheetContent` a template can carry (columns, rows, formats,
conditionalRules, validations, charts, pivots, namedRanges, column/row
sizes, freeze). Seven professionally-modelled starters ship — monthly
budget, cash-flow, sales forecast, project tracker, inventory reorder,
KPI scorecard, expense report — across four categories (Finance, Sales,
Operations, Project Management). A compact `TemplateSpec` authoring shape
with `columnFormats` (column → pattern, expanded over every data row) and
`cellFormats` (explicit `"row,col"` overlays for a bold totals row) keeps
the catalogue terse and correct. Formulas, number formats, and — where it
adds value — a chart are baked in. `filterSheetTemplates` is a single
pure category + case-insensitive free-text helper, mirroring
`filterSlideTemplates`.

Charts in built-ins **prefer a single series with a category
`labelRange`** rather than multi-column ranges: the engine's
`extractChartData` names series by their A1 column letter when
`useFirstRowAsHeader` is false (the default), so a multi-series chart
would show an unhelpful "B"/"C" legend. One series with a label range
gives meaningful category labels and no legend noise.

**User templates** (`editors/customSheetTemplates.ts`,
`useCustomSheetTemplates.ts`). "Save as template" captures the current
sheet into a `CustomSheetTemplate` through a single validation gate,
`buildCustomSheetTemplate(draft)`, and persists it via a versioned
`localStorage` store (`tessera.sheettemplates.custom`, envelope
`{ version, templates }`) behind a module-level store exposed with
`useSyncExternalStore`, so a save/edit/delete in one editor is reflected
in every open editor. Custom ids are namespaced (`stpl-`) so they can
never collide with a built-in id and the store can reject foreign/tampered
ids. The store is capped (50; oldest dropped on overflow), and
`parseCustomSheetTemplateStore` **never throws** — bad JSON, a wrong
schema version, a non-array payload, or individually malformed/duplicate
entries all degrade to a clean result.

Because the sheet model has no single deep validator (unlike
`parseSlideContent`), `normalizeSheetContent` is the **defensive gate
reused on every path** (capture, store load, file import): it rebuilds a
clean `SheetTemplateContent` field-by-field with total guards (validates
chart types, pivot aggregations, conditional operators, alignment values,
format-key shape, positive-integer freeze counts; coerces cells to
strings; caps dimensions), so a corrupt or hostile blob degrades to a
clean grid rather than reaching the renderer. Applying a template
round-trips through the editor's own `parseSheetContent` so it deep-clones
and cannot share structure with a built-in.

**Portable file** (`tessera.sheettemplate`). Export/import uses a
`{ format, version, template }` envelope **distinct from the store
envelope and versioned independently**. The import guard is hardened
exactly like `parseSkillImport` / the slide importer: reject a
non-numeric / non-integer / `< 1` version **first** (so `0`, `-1`, `0.5`,
`NaN`, `Infinity` all read as "not a valid file"), then reject a version
newer than this build. Import is **non-destructive**: the id is always
dropped, so saving an imported template mints a fresh custom id and can
never overwrite an existing one.

### 2. Toolbar discoverability (additive)

The pass is strictly additive — no existing control is removed or
renamed. The genuinely missing affordances are added: a **Freeze** toggle
(`aria-pressed`, freeze-to-selection / unfreeze; previously
context-menu-only) and a **Chart from selection** quick action that
builds a sensible `ChartSpec` from the current selection (multi-column →
first column as `labelRange`, the rest as the data range; single column →
the whole selection) and opens the charts panel. A grouping separator
visually clusters the structural controls.

### 3. Locale-aware number-format presets

`editors/localeNumberFormats.ts` derives currency presets for eleven
common currencies (EUR, GBP, JPY, CHF, CNY, INR, CAD, AUD, BRL, KRW, MXN)
and five locale date presets, reusing `Intl` (no new dependency). The
number-format `<select>` becomes grouped: the common presets stay
ungrouped on top, then "Currency (locale)" and "Date (locale)"
`<optgroup>`s, via a pure `groupedNumberFormatPresets` helper.

**Engine separator limitation (the key constraint).** The format engine
(`formulaEngine/format.ts`) **hardcodes `,` as the thousands separator and
`.` as the decimal separator**, so a preset cannot render European-style
`1.234,56`. What a preset *can* — and does — localise is derived from
`Intl`:

- the currency **symbol** (`€`, `£`, `¥`, `₹`, `CA$`, …), taken under a
  neutral `en` locale so it is stable and unambiguous;
- symbol **placement** (prefix `£1,234.56` vs suffix `1,234.56 €`), read
  from the preset's own locale;
- the **decimal-place count** (2 for most, 0 for JPY/KRW);
- the date **field order + separator** (`dd/mm/yyyy`, `dd.mm.yyyy`,
  `d mmm yyyy`, …), which the engine's date formatter passes through
  verbatim.

The currency symbol is spliced into the engine pattern as a quoted
literal so it survives the engine's quote-stripping; a multi-letter prefix
symbol (`CHF`) gets a trailing space so it doesn't collide with the first
digit. This keeps the presets faithfully locale-aware **within** the
engine's separator limitation rather than forking the formatter.

## Consequences

- Users open a searchable, categorised gallery, preview a template, and
  insert a fully-formed sheet (headers, sample rows, formulas, number
  formats, and where relevant a chart); can save the current sheet as a
  reusable template; and can export/import templates as portable files to
  share across machines — all local-first, with no network calls and no
  image assets.
- The feature is additive and legacy-safe: no toolbar control is removed
  or renamed, custom ids are namespaced away from built-ins, and there is
  **no `SCHEMA_VERSION` bump** — a sheet saved before this change loads
  unchanged, and a template carrying no extras serialises byte-identically
  to legacy single-sheet JSON.
- The store and the portable file are versioned **independently**; both
  parse paths never throw and route through one `normalizeSheetContent`
  gate, so a corrupt store entry or a hostile import degrades to a clean
  grid instead of crashing the editor.
- Freeze panes and chart-from-selection are now one click from the
  toolbar, and international users get correct currency symbols,
  placement, decimal counts, and date orders.
- The engine's hardcoded `,`/`.` separators mean locale presets vary only
  symbol/placement/decimals/date-order — European decimal-comma grouping
  is explicitly **out of scope** here; lifting it would require
  parameterising the formatter (`formulaEngine/format.ts`), a separate,
  larger change.
- `sheetTemplates` (catalogue + filter), `customSheetTemplates`
  (normalise/build/list-ops/store/portable-file guard),
  `useCustomSheetTemplates` (store reactivity), `localeNumberFormats`
  (pure pattern builder + `Intl` invariants), and the grouped-preset
  helper are all unit-tested. No new IPC, Rust, or data-layer surface.
