# 20. Slide template library: breadth, taxonomy, and a thumbnail gallery

## Status

Accepted. Builds on the Slides editor's existing template system
(`editors/slideTemplates.ts`, materialised by `buildDeckFromTemplate` in
`editors/slideEditorHelpers.ts`) and reuses the themed slide surface and
block previews introduced for the editor canvas
(`editors/components/SlideBlockPreviews.tsx`, the `[data-slide-theme]` /
`[data-slide-layout]` rules in `styles/components.css`). Renderer-only;
no IPC, Rust, or schema change.

## Context

The Slides editor shipped with a thin template library: six built-in
starter decks (`pitch`, `status-report`, `workshop`, `project-proposal`,
`retrospective`, `case-study`) in `SLIDE_TEMPLATES`, surfaced through a
flat modal in `SlideEditor.tsx` — no categories, no search, and no
preview. A `SlideTemplate` is pure metadata
(`{ id, label, description, icon, suggestedTheme?, slides }`, each slide
`{ layout, title, blocks, notes? }`), materialised into real `Slide[]`
by `buildDeckFromTemplate`. Benchmarks (Gamma's 100+ searchable
templates across ~11 categories; Google Slides' gallery) set the bar:
the library should be broad, professional, categorised, searchable, and
visually browsable.

Three forces shaped the design:

1. **Legacy safety.** Template ids are stable identifiers; renaming one
   would silently orphan saved decks. Any taxonomy must be _additive_ —
   new optional fields, new ids only — and must not touch
   `SCHEMA_VERSION`.
2. **No screenshots, local-first.** Thumbnails must render from the same
   data the editor uses, with no image assets, no network fetches, and
   no build-time snapshotting (decks are user data).
3. **The slide renderer already exists.** Themes, layouts, and the
   table/chart/diagram previews are all CSS- and component-driven off
   the `.slide-canvas` surface. A preview should reuse that surface
   rather than fork a second renderer that can drift.

## Decision

**Taxonomy (additive).** Add a `TemplateCategory` string union mirroring
Gamma's set — Company, Consulting, Creative, Education, Fundraising,
Marketing, People, Project Management, Reporting, Sales, Strategy —
exported alongside `TEMPLATE_CATEGORIES` and an `ALL_TEMPLATES_CATEGORY`
sentinel (`"All"`). `SlideTemplate` gains an **optional** `category?`
field; an untagged template still appears under "All", so the change is
backward-compatible by construction.

**Breadth.** Grow the catalogue from 6 to 24 professionally written
multi-slide decks, each tagged with a category (≥ 2 per category) and a
sensible `suggestedTheme`, using only the existing layouts, block types,
and table/chart DSLs. No image blocks (keeps built-ins local-first and
asset-free), and no chart/table/diagram on a deck's first slide (so the
thumbnail of the first slide is always a clean title/section surface).

**Pure filtering.** A single `filterSlideTemplates(templates, category,
query)` helper does category + case-insensitive free-text matching
(label, description, category) and treats a whitespace-only query as no
query. It is pure and side-effect-free so it is trivially unit-tested and
memoised in the gallery (`useMemo` on category + query).

**Thumbnail = the real slide surface, scaled with CSS.** Rather than
mount the _editable_ `SlideDesignCanvas` (textareas, add-block
affordances, focus traps — none of which belong in a gallery card) or
screenshot decks, a new read-only `SlideThumbnail`
(`editors/components/SlideThumbnail.tsx`) renders a template's first
slide on the **same** themed `.slide-canvas` surface, stamping
`data-slide-theme` / `data-slide-layout` / `data-slide-bg` so every
palette, layout grid, and slot-driven typography rule applies verbatim.
Prose renders statically; `table` / `chart` / `diagram` reuse the shared
`SlideBlockPreviews`, so the preview cannot drift from the editor's
renderer. Scaling is **pure CSS**: `.slide-thumb-frame` is a 16:9
container query (`container-type: inline-size`) and the inner fixed
960×540 canvas is shrunk with `transform: scale(calc(100cqw / 960))` —
no `ResizeObserver`, no JS measurement, no layout thrash, correct at any
card width. Container queries and `cqw` units are available in the
shell's Chromium 126. The thumbnail is decorative (`aria-hidden`,
`pointer-events: none`); the card itself owns the accessible name.

**Gallery UX.** The existing template modal in `SlideEditor.tsx` is
extended (not replaced) into a gallery: a search `<input>`, a row of
category filter chips (All + the eleven categories), and a responsive
card grid of `SlideThumbnail`s with label/description/category, plus an
empty state. Each card is a plain container with a **stretched,
transparent `<button>`** as the click target, so the whole card is one
focusable control without nesting the thumbnail's block markup (`<ul>`,
`<table>`) inside a `<button>` (invalid HTML); the card shows its focus
ring via `:focus-within`. All styling reuses existing design tokens.

## Consequences

- Users can browse ~24 professional decks, filter by category, search by
  name/description/use-case, see a live themed thumbnail of each, and
  create a deck from any of them; `buildDeckFromTemplate` materialises
  every catalogue template unchanged.
- The taxonomy is additive: `category?` is optional, the six original
  template ids are untouched, and there is **no `SCHEMA_VERSION` bump** —
  decks saved before this change load unchanged.
- The thumbnail shares one renderer with the editor (themed
  `.slide-canvas` + `SlideBlockPreviews`), so previews stay faithful to
  what a created deck looks like, with no screenshots, no image assets,
  and no network calls.
- Pure-CSS container-query scaling means the gallery has no per-card JS
  measurement; 24 lightweight static renders mount only when the gallery
  opens, and first slides carry no charts/tables, keeping it cheap.
- `filterSlideTemplates`, the catalogue breadth/taxonomy invariants
  (every template tagged with a known category, ≥ 2 per category, all
  ids materialise to known layouts), and `SlideThumbnail` rendering are
  unit-tested. No new IPC, Rust, or data-layer surface.
