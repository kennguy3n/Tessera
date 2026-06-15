# 25. Slide brand import — extract a Brand Kit from a `.pptx`

## Status

Accepted. Extends [0019](0019-slide-brand-kit.md) (the Slide Brand Kit
data model + brand-aware theming) and reuses the non-destructive,
renderer-only import pattern established by
[0022](0022-slide-brand-pack.md) (portable Brand Pack import/export) and
[0018](0018-skill-export-import.md). It is the inbound mirror of
[0024](0024-slide-branded-export.md): where 0024 makes a Tessera brand
survive an _export_ to `.pptx`, this decision lets a brand be _imported_
from one.

## Context

A Brand Kit ([0019](0019-slide-brand-kit.md)) is declarative data —
brand colours, curated fonts, an optional inline logo, a background —
that re-skins a curated theme. Authoring one from scratch means picking
colours and fonts by hand. But most users already have a branded
PowerPoint deck, and Gamma-style tools have set the expectation that you
can "import your brand from a `.pptx`" in one step. That deck already
encodes the brand in a machine-readable form, so asking the user to
re-key it is busywork.

A `.pptx` is an OPC package — a ZIP — and its brand lives in the
DrawingML theme part at `ppt/theme/theme1.xml`:

- `<a:clrScheme>` names twelve colours (`dk1`/`lt1` the text/background
  pair, `dk2`/`lt2` secondary, `accent1..6`, two hyperlink colours).
  Each is either `<a:srgbClr val="RRGGBB"/>` or a `<a:sysClr>` carrying
  the concrete value it last resolved to in `@lastClr`.
- `<a:fontScheme>` names a `majorFont` (headings) and `minorFont`
  (body), each with a `<a:latin typeface="…"/>`.
- A logo, if any, is a media part referenced by a relationship from the
  slide master.

The goal: read those parts, map them onto a `BrandKitDraft`, and hand
that draft to the **existing** S1 builder ([0019](0019-slide-brand-kit.md))
pre-filled so the user reviews and saves it — exactly the review-then-save
flow a Brand Pack import ([0022](0022-slide-brand-pack.md)) already uses.
The output is a standard `BrandKit`, so it persists, re-skins the deck,
and exports as a Brand Pack with no extra work.

Three forces shaped the design:

1. **Untrusted input.** A `.pptx` is an arbitrary user file. Parsing it
   must never crash the renderer, and a hostile/pathological archive (a
   "zip bomb") must not be able to exhaust CPU or memory.
2. **Resource budget.** Tessera is a local-first desktop app that must
   stay light on battery, memory and CPU. The importer must do the
   _least_ work that yields a brand — not inflate or scan a whole deck.
3. **Identity safety.** Import must be non-destructive: it can never
   overwrite an existing kit.

## Decision

Add a pure, renderer-only extractor — `editors/pptxBrandImport.ts`,
`parsePptxBrand(bytes, opts?) → { ok: true; draft } | { ok: false; error }`
— and wire an "Import .pptx" control into the existing brand
share-controls row. No engine, IPC, Rust, or persistence-schema change.

**Renderer-only, no IPC.** XML parsing uses the renderer's native
`DOMParser` (also present in jsdom, so it is unit-testable) with
namespace-agnostic, local-name lookups (`getElementsByTagNameNS("*", …)`)
so an unusual prefix binding never breaks extraction. The only missing
primitive is ZIP inflation. Routing raw bytes through IPC to the Rust
main process was considered and rejected: it would add a new trust
boundary and message surface for a problem that is safely solvable in
the renderer, and it would break the local-first, no-native-dependency
posture. The parse is small and synchronous; a worker would add
complexity for no felt latency on theme-sized inputs.

**New dependency: `fflate`.** The renderer had no unzip capability, so we
add `fflate` — a ~8 KB, zero-native-dependency, MIT-licensed,
widely-used inflate/deflate library. It is the minimal choice that meets
the resource bar: it exposes `unzipSync(data, { filter })`, which lets us
inflate **only the specific entries we need** rather than expanding the
whole archive. The same library builds in-memory `.pptx` fixtures in the
tests (`zipSync`), so what we ship is what we test against. Heavier
alternatives (e.g. JSZip) were rejected on bundle size and footprint.

**What we read, and nothing more.** Pass one inflates at most
`ppt/theme/theme1.xml` (required) and
`ppt/slideMasters/_rels/slideMaster1.xml.rels` (only for an optional
logo). A logo, if referenced, costs one more inflate of a single media
entry. The whole archive is never expanded.

**Zip-bomb guards** (tunable via an optional `limits` argument so tests
can trip them with tiny fixtures):

- A cheap entry-count check reads the ZIP End-Of-Central-Directory record
  _before_ inflating anything and bails if the package declares more than
  `maxEntries` entries.
- The `unzipSync` filter enforces a per-entry decompressed cap
  (`maxEntryBytes`) and a cumulative cap (`maxTotalBytes`) across every
  entry we choose to inflate, skipping (never inflating) anything that
  would exceed them.

**Colour mapping**, every value run through S1's `normalizeHexColor`
(which also accepts the bare `RRGGBB` form OOXML uses) and dropped if
invalid:

- `accent ← accent1` (fallback `dk2`, then `text`)
- `surface ← lt1` (fallback `#ffffff`)
- `text ← dk1` (fallback `#1e1b2e`)
- `heading ← dk2` (fallback `text`)
- `muted ←` a derived blend of `text` toward `surface` (≈45%), which is a
  better caption colour than `lt2` and is always a valid hex.

`accent1`/`lt1`/`dk1` are the load-bearing trio; if none of them yields a
valid colour we return `{ ok: false }` ("no usable colours") rather than
inventing a brand.

**Font mapping.** `majorFont → headingFont`, `minorFont → bodyFont` via
an ordered, case-insensitive alias table that maps a theme typeface
(e.g. "Cambria", "Calibri Light", "Roboto Mono") to the nearest curated
`BRAND_FONTS` id, more-specific needles first. The result is validated
with `isBrandFontId`; **no raw typeface string is ever used as a font
id**. No confident match ⇒ the font is left unset and the base theme's
font is used.

**Optional, best-effort logo.** If the slide master references an image,
we take the first web-renderable one (PNG/JPEG/GIF/WebP/BMP/SVG; EMF/WMF/
TIFF are skipped — they render broken), inflate just that entry, and
build a size-capped inline `data:` URL validated by S1's
`isInlineImageDataUrl` (reusing `MAX_LOGO_DATA_URL_LENGTH`). Any failure —
missing rels, oversize image, unsupported format — is swallowed silently
and the logo is left for the user to add in the builder. The logo path
can never fail the colour/font path.

**Non-destructive.** The produced draft carries **no id**, so saving
through the unchanged builder mints a fresh `brand-…` id; an import can
never overwrite an existing kit. The draft is seeded with the deck's
current `baseThemeId` so the saved kit re-skins the active deck.

**Never throws.** Every failure mode — not a ZIP, a missing or malformed
theme, no usable colours, a tripped guard — returns a friendly,
user-facing `{ ok: false, error }`; an outer `try/catch` is the final
backstop.

## Consequences

- A user imports a real branded `.pptx`, sees its colours, fonts (and,
  when extractable, logo) pre-filled in the S1 builder, reviews, and
  saves a new Brand Kit that immediately re-skins the deck — one step,
  no re-keying.
- The extracted kit is an ordinary `BrandKit`, so it persists, applies,
  and (per [0022](0022-slide-brand-pack.md)) exports as a Brand Pack with
  no further work.
- The importer is bounded in work and memory by construction (inflate
  only what is read; entry-count and byte caps), keeping the feature
  within the app's resource budget on low-end laptops.
- `fflate` is now a renderer dependency. It is tiny, dependency-free, and
  also used by the test fixtures; the supply-chain surface is one small,
  well-known package.
- Mapping is intentionally lossy: a 12-colour OOXML scheme collapses to
  the five Brand Kit roles, and only curated fonts are matched. This is a
  feature — the user reviews a clean draft rather than a faithful but
  unusable dump — and the builder lets them adjust before saving.
- The extractor only reads `theme1.xml` and `slideMaster1.xml`'s rels.
  Decks whose authoritative theme is a different `themeN.xml`, or whose
  logo lives off the first master, import colours/fonts but may miss the
  logo; the user adds it manually. Following the master→theme reference
  chain is a possible later refinement.
