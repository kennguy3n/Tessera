# 24. Slide branded export fidelity — brand survives PPTX / PDF / HTML

## Status

Accepted. Builds on [0019](0019-slide-brand-kit.md) (Slide Brand Kit
data model + brand-aware theming) and [0004](0004-local-first.md)
(local-first architecture). Extends the Marp export path established for
slide artifacts without touching the N-API bridge ([0008](0008-n-api-bridge.md)).

## Context

The Slides editor renders a rich, brand-aware look **in-app**: a deck
carries an optional `brandKitId` (0019), the active `BrandKit` is
resolved against the `localStorage` store, and `brandKitCssVars(kit)` is
stamped as inline `--slide-*` custom properties on the `.slide-canvas`,
overriding the curated theme's colours and fonts. None of that survived
**export**:

- `editors/slideEditorHelpers.ts` → `slidesToMarpMarkdown(slides, { theme? })`
  builds a YAML front-matter header (`marp: true`,
  `theme: '<one-of-3>'`, `paginate: true`) plus the slide bodies. The
  only styling it represents is the `theme:` _name_, and
  `marpThemeForSlideTheme` collapses all ten curated themes
  (`editors/slideThemes.ts`) to one of Marp's three built-ins
  (`default` / `uncover` / `gaia`). The Brand Kit's colours and fonts
  were not represented at all, so an exported deck looked generic.
- The Marp built-in themes do **not** read the `--slide-*` custom
  properties the in-app themes consume, so even declaring those
  variables would not, on its own, change a single colour in the
  exported deck.
- **Routing gap.** Only PPTX went through `slidesToMarpMarkdown` →
  `api.artifacts.exportMarp` → `electron/marpExport.ts#runMarpExport` →
  the Marp CLI. In `pages/ArtifactEditorPage.tsx#handleExport`, slide
  **PDF** fell into the `BINARY_FORMATS` branch (`exportToFile`, a Rust
  exporter) and slide **HTML** into the generic `exportArtifact` branch
  (Rust, clipboard/file). Neither rendered the deck as slides, and
  neither could carry the brand. The Definition of Done requires
  PPTX **and** PDF **and** HTML to reflect the brand.

Two facts make a renderer-only fix possible. First, `runMarpExport`
writes `opts.markdown` **verbatim** to a temp `.md` file before invoking
the CLI, so any CSS embedded _inside_ the markdown string travels
end-to-end with **no IPC change**. Second, the existing `MarpFormat`
enum (`electron/ipc/schemas.ts`) and `buildMarpArgs` already support
`pdf` / `pptx` / `html` — PDF and HTML simply were not being routed
through them for slides.

Constraints (inherited from 0019): renderer-only, additive, **legacy
decks export byte-identical**, no `SCHEMA_VERSION` bump, no stable id
renamed; brand values sanitised so they cannot break out of the
`<style>` / front-matter context; brand hex via 0019's validator and
fonts via the curated `BRAND_FONTS` list (never raw user strings).

## Decision

Carry the brand into the export by **generating a small Marp-compatible
CSS string from the active Brand Kit and injecting it into the exported
markdown via Marp's `style:` global directive**, then route slide PDF
and HTML through the same Marp pipeline as PPTX. No IPC, schema, or Rust
change.

**1. `brandCssForExport(kit)` (pure, in `editors/slideBrandKit.ts`).**
Derives entirely from `brandKitCssVars(kit)` — the same override map used
in-app (0019), kept as the single source of truth. It emits a `:root`
block declaring every `--slide-*` variable the kit produced, then
**binds those variables onto the selectors the Marp built-in themes
actually render**, because the built-ins do not consume `--slide-*`
themselves:

```css
:root { --slide-accent: …; --slide-surface: …; --slide-text: …; /* + optional */ }
section { background-color: var(--slide-surface); color: var(--slide-text);
          /* font-family: var(--slide-font-body) when a body font resolves */ }
/* section h1..h6 { color/font-family } only when the kit sets them */
section a { color: var(--slide-accent); }
section h1 { border-bottom: 0.075em solid
             color-mix(in srgb, var(--slide-accent) 32%, transparent); … }
/* section blockquote, figcaption, small { color: var(--slide-muted) } when set */
```

Every binding is conditional on the corresponding var existing, so a
minimal kit (accent/surface/text only) emits exactly the required
bindings and nothing speculative. The mapping mirrors how
`styles/components.css` consumes the same variables in-app (accent →
title underline + links; surface → background; text → body copy; muted →
secondary text), so the exported look tracks the in-app look.

**2. Injection via the `style:` directive (additive, in
`slidesToMarpMarkdown`).** The signature gains an optional second field:
`slidesToMarpMarkdown(slides, { theme?, brandCss? })`. When `brandCss`
is a non-blank string, it is emitted as a YAML literal block in the
front-matter:

```
paginate: true
style: |
  <brand css, every line indented two spaces>
---
```

Marp applies a `style:` global directive **without** requiring `--html`,
so this is the safe default (it does not enable arbitrary HTML). When
`brandCss` is absent or whitespace-only, **no directive is emitted and
the output is byte-identical to today's** — the additive guarantee,
pinned by a test.

**3. Security — shared `escapeStyleClose`.** The existing
`</style → \3c /style` sanitiser inside `applyMarpToShadow` was extracted
into a shared, exported `escapeStyleClose(css)` and reused at the
injection site. `\3c ` is the canonical CSS hex escape for `<` (the
trailing space terminates the escape), so a hostile brand value
containing `</style>` cannot close the `<style>` element / front-matter
context. Brand colours still pass through 0019's `normalizeHexColor`
validator and fonts resolve through the curated `BRAND_FONTS` catalogue,
so no raw user string is interpolated unescaped.

**4. Reroute PDF + HTML through Marp (in `handleExport`).** A
`SLIDE_MARP_FORMATS = ["pptx", "pdf", "html"]` set (with an
`isSlideMarpFormat` type guard) replaces the old PPTX-only branch. For a
**slide** artifact in any of those formats, `handleExport` resolves the
deck's kit (`findBrandKit(loadBrandKits(), parsed.brandKitId)`), builds
`brandCss = brandKit ? brandCssForExport(brandKit) : undefined`,
synthesises the markdown via `slidesToMarpMarkdown(parsed.slides, { theme, brandCss })`,
and calls `exportMarp({ markdown, format, outputPath, theme })` with the
selected format. Hand-authored **Marp-mode** source is passed through
untouched — the brand is injected only into _synthesised_ markdown, never
into user-authored Marp source. Non-slide PPTX still throws the same
error as before.

**Why renderer-only suffices (the step-3 fallback was not needed).**
Because the brand CSS lives inside the markdown that `runMarpExport`
writes verbatim, and the `style:` directive needs no `--html`, the brand
reaches the CLI for **all three** formats with zero schema/IPC/Rust
change. No narrow custom-theme IPC field was added; `SCHEMA_VERSION` is
untouched.

## Consequences

- Exporting a deck with an active Brand Kit now produces PPTX, PDF, and
  HTML whose colours and fonts reflect the brand — verified by the brand
  CSS appearing in the generated Marp markdown (unit tests) and by an
  integration test asserting `exportMarp` receives the injected
  `style:` block for each of the three formats.
- A deck with **no** Brand Kit exports byte-identical to before: the
  injection only fires when a kit resolves, and a dedicated test pins the
  no-brand front-matter and asserts `undefined` / blank `brandCss` is a
  no-op.
- **Behaviour change, scoped to slide artifacts:** slide PDF and HTML now
  render as real Marp slides instead of going through the generic Rust
  artifact exporters. This is the intended outcome (those paths never
  produced slide-shaped output); documents, sheets, infographics, and
  landing pages are unaffected and keep their existing exporters.
- The export CSS is derived from the same `brandKitCssVars` map used
  in-app, so the brand layer and the curated themes cannot drift: the
  export re-skins the brand essentials (accent/surface/text colours +
  heading/body fonts) onto the Marp built-in theme.
- **Built-in-theme caveat (accepted):** because the three Marp built-ins
  do not consume `--slide-*`, the export binds those variables onto
  `section` / `h1..h6` / `a` rather than porting all ten curated CSS
  themes verbatim. Colours and fonts — the brand-defining attributes —
  survive; pixel-faithful reproduction of every curated theme's bespoke
  CSS is deliberately out of scope.
- **Privacy (consistent with 0004 / 0019):** the brand CSS is generated
  on-device and embedded into the local export file; nothing is
  transmitted, and the kit's inline logo `data:` URL (if any) adds no
  network egress.
