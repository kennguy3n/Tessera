# 21. Slide visual polish — smart layouts, real icons, per-slide background, aspect ratio

## Status

Accepted. Builds on the structured Slides editor (the CSS-grid layout
system in `editors/slideLayouts.ts` + `styles/components.css`, the
curated theme catalogue in `editors/slideThemes.ts`, and the
`SlideContent`/`Slide` schema in `editors/slideEditorTypes.ts`). Purely
additive and renderer-only — it extends those surfaces without renaming
any stable id or touching the Rust core, the N-API bridge
([0008](0008-n-api-bridge.md)), or `SCHEMA_VERSION`.

## Context

The Slides editor shipped ten named-region CSS-grid layouts and ten
themes, but its visual repertoire lagged behind tools like Gamma (rich
"Smart Layouts" — timelines, process steps, comparisons, galleries,
metric rows) and Google Slides. Three concrete gaps:

- **Iconography** was single emoji glyphs in the Add-Slide and insert
  menus, even though `lucide-react` and `@phosphor-icons/react` are
  already root-hoisted dependencies with a full `services/iconResolver.ts`
  (`resolveIconComponent`) and an `IconPicker` component — a real icon
  set was available but unused in these menus.
- **Layouts** were limited to the original ten, none of which expressed
  the most common "smart" compositions (timeline, process, comparison,
  gallery, metric row).
- **Canvas shape** was hard-coded 16:9, and a slide could not override
  the deck's background `bgStyle` — both reasonable per-deck / per-slide
  knobs for social (1:1) or emphasis use.

Every gap is a renderer-only presentation concern: the persistence
schema already round-trips arbitrary optional fields
(`backfillSlideIds` preserves unknown `Slide` keys; `parseSlideContent`
validates the deck-level fields it knows), and Marp export keys off each
layout's `marpClass`, ignoring unknown classes gracefully. So none of
this needs a new IPC channel, a Rust change, or a schema-version bump.

## Decision

Raise visual polish additively, entirely in the renderer, reusing the
existing tokens, classes, and icon infrastructure.

- **Real icons.** A small `SlideMenuIcon` helper in `SlideEditor.tsx`
  resolves a layout/preset `iconName` through the existing
  `resolveIconComponent({ set: "lucide", name })` and renders the lucide
  component, falling back to the existing emoji `glyph` on a miss (so a
  bad/typo'd name degrades, never throws). `SlideLayoutDef` and
  `InsertCardPreset` gain an optional, display-only `iconName`; it is
  never persisted. No new dependency is added.

- **Five smart layouts** — `timeline`, `process`, `comparison`,
  `gallery`, `metricRow` — each added as a new id in the `SlideLayout`
  union and `SLIDE_LAYOUTS`, with a `buildSlideFromLayout` case that
  scaffolds sensible slotted blocks, a `marpClass` of `layout-<id>`, a
  matching insert-card preset (`timeline-card`, `process-card`,
  `comparison-split`, `gallery-card`, `metric-row` — the original
  `comparison` preset id is left untouched), and a
  `[data-slide-layout="<id>"] .slide-blocks` grid in `components.css`.
  The grids are authored to work in **both** the outline and design
  canvases: design-view blocks carry no `data-slot`, so the new rules
  style the grid container plus uniform cards via positional selectors
  (`:not(.slide-design-add)`, `:nth-of-type`, `:first/last-of-type`, CSS
  counters) rather than per-slot selectors, and the trailing
  "+ Add block" button is pushed to its own full-width row so it never
  occupies a content cell. Existing layouts are not modified.

- **Per-slide background.** `Slide.background?: SlideBgStyle` (the
  existing `solid|gradient|mesh|dots|lines` union, now exported
  canonically from `slideThemes.ts` alongside a `SLIDE_BG_STYLES` list
  and an `isKnownSlideBgStyle` guard). The canvas stamps
  `data-slide-bg = slide.background ?? theme.bgStyle`, reusing the
  existing `slide-bg-<style>` rendering. `duplicateSlideAt` copies the
  override (conditionally, so a slide without one stays key-free and its
  serialised JSON is unchanged).

- **Aspect ratio.** `SlideContent.aspectRatio?: "16:9" | "4:3" | "1:1"`
  with `DEFAULT_ASPECT_RATIO = "16:9"` and a `resolveAspectRatio`
  coercer that mirrors `resolveThemeId`; `parseSlideContent` validates
  it on load. `SlideEditor` mirrors it into a ref (matching the existing
  theme-id ref pattern) so the debounced save reads the freshest value,
  stamps `data-slide-aspect` on the design canvas, and a CSS override
  switches the design canvas off the hard-coded 16:9 for `4:3`/`1:1`.

- **Accent decorations** (timeline nodes/connectors, process step number
  badges, comparison panel top-borders, gallery image frames, metric
  accent text) are scoped **only** to the new layouts and built from the
  existing `--slide-*` tokens (`--slide-accent`, `--slide-surface` as the
  guaranteed-contrast on-accent colour). All of the new CSS lives in one
  clearly delimited "VISUAL POLISH (S6)" section so it does not collide
  with the parallel Brand-Kit work, and it never touches the
  `[data-slide-theme]` colour rules.

All new fields are optional and legacy-safe: a deck saved before this
change has no `aspectRatio` and no per-slide `background`, so it renders
exactly as before, and no stable id is renamed.

## Consequences

- A user can insert the five new smart layouts (from both the Add-Slide
  menu and the insert-card presets), switch the deck between 16:9 / 4:3
  / 1:1, and override a single slide's background — all persisting in
  `SlideContent`/`Slide` and round-tripping through `parseSlideContent`.
  The Add-Slide and insert menus show real lucide icons with an emoji
  fallback.
- **Scope: the in-app design canvas only.** Aspect ratio and per-slide
  background apply to the renderer's `.slide-canvas`. The Present view is
  a separate Electron main-process window
  (`electron/ipc/slides.ts`) that receives a flattened, plain-text
  `PresentationSlide[]` and carries no layout/background/aspect metadata;
  wiring these through that IPC is intentionally out of scope for this
  renderer-only change. The outline canvas is a tall scrolling editor
  with no fixed ratio, so the aspect override targets the design canvas.
- **Marp export** is unaffected: new layouts emit `layout-<id>` classes
  via the existing `renderSlideAsMarp` path, and Marp ignores unknown
  classes, so `slidesToMarpMarkdown` keeps working without brand/Present
  parity (a separate concern).
- **No new IPC, Rust, or data-layer surface, and no `SCHEMA_VERSION`
  bump.** Icons reuse the existing `iconResolver`; the new optional
  fields are validated on load and otherwise pass through the existing
  migration untouched. No new runtime dependency is introduced.
- The new layout ids/marpClasses/icons, the `buildSlideFromLayout`
  scaffolding, the new presets, aspect-ratio resolution + round-trip,
  the per-slide background guard + round-trip, and `duplicateSlideAt`
  background propagation are all unit-tested
  (`renderer/src/__tests__/slideVisualPolish.test.ts`).
