# 22. Brand Pack — export / import a Brand Kit as a portable file

## Status

Accepted. Extends [0019](0019-slide-brand-kit.md) (the Slide Brand Kit
data model + brand-aware theming) and mirrors
[0018](0018-skill-export-import.md) (export / import a skill as a
portable file), reusing the same renderer-only serialisation +
validation pattern those decisions established.

## Context

A Brand Kit ([0019](0019-slide-brand-kit.md)) is declarative data —
brand colours, curated fonts, an inline logo, and a background style —
that re-skins a base slide theme. Once a user can author one, the
obvious next lever is making it **portable**: a brand that took effort
to dial in is worth moving between machines or handing to a teammate,
and — the motivating use case — exporting it from one Devin session and
re-importing it into a _separate_ session. Until now a custom kit lived
only in `localStorage` (`tessera.brandkits.custom`) with no way out.

This is exactly the problem [0018](0018-skill-export-import.md) solved
for Skills, so Brand Packs copy that decision deliberately rather than
inventing a parallel mechanism. The data already round-trips
losslessly: `serializeBrandKitStore` / `parseBrandKitStore` persist a
`{ version, brandKits }` envelope, and `coerceBrandKitDraft` /
`buildBrandKit` coerce and validate an arbitrary stored object into a
well-formed `BrandKit`. What was missing was a **single-kit** portable
file format and the UI to produce and consume it. This is purely a
renderer concern: no engine, IPC, Rust, or persistence-schema change is
needed.

The one correctness hazard is identity. The persistence envelope keys
kits by `id`, and a custom id is namespaced (`brand-…`). If an imported
file kept its `id`, importing it could silently **overwrite** a
different kit that happens to share that id. Import must therefore
always mint a fresh id.

## Decision

Add a portable single-kit file format and Export / Import controls,
entirely in the renderer, reusing the existing coercion + validation.

**File format** (`editors/slideBrandKit.ts`): a tagged, versioned
envelope distinct from the `localStorage` store envelope —
`{ format: "tessera.brandpack", version: 1, brandKit }` — pretty-printed
for human inspection. The `format` tag lets an arbitrary `.json` be told
apart from a Brand Pack before parsing; the export `version`
(`BRAND_PACK_VERSION`, independent of the private persistence
`SCHEMA_VERSION`) lets a future format change be refused cleanly rather
than half-read. The singular `brandKit` key (vs. the store's plural
`brandKits`) keeps the two envelopes unambiguous.

Three pure functions back it:

- `serializeBrandPack(kit)` — wraps a kit in the envelope. Pure: it
  never mutates the kit and does no IO.
- `brandPackFilename(kit)` — a stable `tessera-brand-<slug>.json`
  download name derived from the kit name, falling back to
  `tessera-brand-brand.json` when the name has no slug-safe characters.
- `parseBrandPack(raw)` → `{ ok: true, draft } | { ok: false, error }`.
  It never throws: malformed input degrades to a friendly message. It
  validates the envelope (`format`; a `version` that is an integer
  `>= 1` and not newer than supported; a `brandKit` object with a string
  `name`), then routes the raw kit through the **same**
  `coerceBrandKitDraft` coercion and `buildBrandKit` validation the
  persistence layer uses — so an imported brand can never be less
  well-formed than one authored in the editor (hex colours, curated-font
  ids, and the inline `data:image/*` logo guard + size cap all apply).
  Crucially it returns the draft **without an id**, so a fresh custom id
  is minted on save — an import can never overwrite or shadow an
  existing kit.

The version guard mirrors the hardened [0018](0018-skill-export-import.md)
one: a non-numeric, non-integer, or `< 1` version is rejected as "not a
valid Tessera brand pack" _before_ the `> BRAND_PACK_VERSION` "newer
version" check, so versions that no release ever produced are reported
as malformed rather than as "from the future".

**Forward-compatibility:** the envelope tolerates an optional future
`templates?` array (a later session will bundle user templates into the
same pack). `parseBrandPack` reads only `brandKit`, so any extra
top-level field — `templates` included — is ignored gracefully rather
than rejected. This session serialises only the brand kit.

**UI** (`editors/components/BrandKitShareControls.tsx`): beside the
"Customize brand" trigger in the Slide editor, an **Export** button
(enabled only when a user brand kit is active — built-in/base themes are
not kits) and an **Import** button. Export runs the standard
blob-download dance (`URL.createObjectURL` → temporary `<a download>` →
`revokeObjectURL`). Import drives a hidden
`<input type="file" accept=".json,application/json">`; on selection it
reads the text, runs `parseBrandPack`, and on success opens the
`BrandKitBuilderModal` pre-filled via a new `initialDraft` prop (draft
id undefined ⇒ fresh custom id on save), so the user reviews before
committing. A rejected import shows an inline `role="alert"` message and
opens no modal.

## Consequences

- A user brand kit can be exported to a portable file and imported on
  another machine or in another session, with every field — colours,
  optional heading/muted refinements, curated fonts, the inline logo
  (data URL, alt text, placement), base theme, and background style —
  preserved losslessly through the export → import → build round-trip,
  except for the id, which is minted fresh.
- Import is **non-destructive by construction**: it always mints a new
  custom id, so it can never overwrite an existing kit.
- Imported data is held to the same bar as editor-authored data: it
  flows through `coerceBrandKitDraft` + `buildBrandKit`, so a malformed
  or structurally invalid file (bad JSON, wrong/absent `format`, a
  newer version, a missing kit, invalid colours, or a logo that is not
  an inline `data:` URL) is rejected with a friendly, specific reason
  rather than producing a broken kit.
- No new engine, IPC, Rust, or persistence surface, and **no
  `SCHEMA_VERSION` bump**: the export envelope is versioned
  independently, and import reuses the existing data layer. Existing
  saved kits load as before.
- The shared `coerceBrandKitDraft` helper is now used by both
  `parseStoredBrandKit` (persistence) and `parseBrandPack` (import), so
  the two paths can never drift in how they coerce a raw kit.
- The pure functions (envelope shape, filename slug + fallback, every
  rejection path, the round-trip, and the ignored forward-compat
  `templates` field) and the UI (the Export download dance,
  import-opens-builder-pre-filled, import-mints-a-new-id, and the inline
  error) are unit-tested.
