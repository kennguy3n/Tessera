# 19. Slide Brand Kit data model + brand-aware theming

## Status

Accepted. Builds on [0004](0004-local-first.md) (local-first
architecture) and reuses the renderer-side `localStorage` persistence
pattern established by [0013](0013-user-authored-skills.md)
(user-authored Skills).

## Context

The Slides editor has a strong _structural_ foundation — a deck is a
list of `Slide`s with typed `SlideBlock`s, a curated catalogue of ten
themes (`editors/slideThemes.ts`), and ten CSS-grid layouts
(`editors/slideLayouts.ts`). The editor stamps `data-slide-theme={id}`
and `data-slide-layout={id}` onto the `.slide-canvas`, and the actual
theme **colours and fonts live in CSS** under
`[data-slide-theme="<id>"]` (`styles/tokens.css`) consumed through
`--slide-*` custom properties (`--slide-accent`, `--slide-surface`,
`--slide-headline`, `--slide-font-headline`, `--slide-font-body`, …) in
`styles/components.css`.

What it lacked is a **brand layer**. The theme catalogue is fixed: there
was no way to set brand colours, a logo, or brand fonts. The benchmarks
(Gamma, Google Slides) both separate content/structure from a
customizable, addressable "brand skin" — the user picks a base look and
then re-skins it (colours + fonts + logo + image style) _without_
touching slide content. Tessera had no equivalent.

Constraints that shaped the design:

- **Renderer-only / additive.** No IPC, N-API, or Rust changes; no
  `SCHEMA_VERSION` bump. Every new field must be optional so that a
  legacy deck with no brand kit renders byte-for-byte as before, and no
  stable theme/layout id may be renamed (renaming silently resets saved
  decks).
- The theme system **already** funnels its look through `--slide-*`
  custom properties, so a brand skin can be expressed as an _override_
  of those same properties rather than a parallel styling mechanism.
- Brand kits are small, user-authored, re-creatable, per-device data —
  the same shape and lifetime as custom Skills (0013), whose versioned,
  never-throwing `localStorage` store is the proven precedent.

The open questions were therefore only: **how is a brand skin applied to
the canvas without editing content**, **where do brand kits live**, and
**how does a deck reference one safely** when the referenced kit may no
longer exist.

## Decision

Introduce an additive **`BrandKit`** model that re-skins a curated base
theme, applied by stamping CSS custom properties as **inline styles** on
the slide canvas, persisted in `localStorage`, and referenced from a
deck by an optional, defensively-validated `brandKitId`.

New modules under `apps/desktop/renderer/src/editors/`:

- **`slideBrandKit.ts`** — a **pure** model + validation + persistence
  module (no React, no IPC). It defines `BrandKit`
  (`{ id, name, colors: { accent, surface, text, heading?, muted? },
headingFont?, bodyFont?, logo?, bgStyle?, baseThemeId? }`) and an
  author-facing `BrandKitDraft`. `buildBrandKit` normalises a draft into
  a validated kit: `normalizeHexColor` canonicalises hex (expands
  3-digit shorthand, lowercases, rejects alpha/garbage), the three core
  colours are required, optional colours error only when present and
  malformed, and an unknown base theme / font id / bg style **degrades**
  to a safe default rather than failing. Logos are accepted only as
  inline `data:image/*` URLs under a size cap (`isInlineImageDataUrl`,
  `MAX_LOGO_DATA_URL_LENGTH`). Fonts are chosen from a **curated**
  catalogue (`BRAND_FONTS`) and stored as font _ids_, never as arbitrary
  CSS, then resolved to a vetted stack (`brandFontStack`) at apply time.
  `brandKitCssVars` turns a kit into the `--slide-*` override map. The
  versioned store (`BRAND_KITS_STORAGE_KEY = "tessera.brandkits.custom"`,
  local `SCHEMA_VERSION = 1`) parses defensively — bad JSON, wrong
  version, non-array payloads, malformed/duplicate/foreign-id entries are
  all dropped, and the list is capped (`MAX_BRAND_KITS`). Ids are
  namespaced (`brand-…`) so a kit can never collide with a custom-skill
  id, and `coerceBrandKitId` keeps only a structurally-valid id when a
  deck is parsed.
- **`useBrandKits.ts`** — a module-level store exposed through
  `useSyncExternalStore` (mirroring `useCustomSkills`), so every mounted
  editor sees the same list and re-renders on save/delete. Returns
  `brandKits`, `saveBrandKit`, `deleteBrandKit`, and `brandKitById`.

Theming is applied as an **inline-style override**, not new stylesheet
rules:

- `SlideEditor` resolves the active kit (`brandKitById(brandKitId)`) and
  stamps `brandKitCssVars(kit)` as an inline `style` on the
  `.slide-canvas`. Inline custom properties beat the
  `[data-slide-theme]` declarations on the same element, so the brand
  skin overrides the curated theme while **all unset properties fall
  through to the base theme** — the "structure stays, skin changes"
  model. Applying a kit also sets the deck's `themeId` to the kit's
  validated `baseThemeId`, and `data-slide-bg` prefers the kit's
  `bgStyle`. Two new properties, `--slide-text` (body text) and
  `--slide-muted` (secondary text), are introduced and wired in a
  clearly-delimited brand-kit section of `components.css`, scoped to the
  Design view (`[data-slide-brand]`) where text sits on the branded
  surface.
- **Logo corner slot:** when a kit has a logo, the canvas gets
  `data-slide-logo={tl|tr|bl|br}` and renders the logo as an
  absolutely-positioned child of `.slide-canvas` via CSS placement — a
  single "master logo" on every slide, with **no per-slide block** and
  no slide-content change. The `data:` URL stays inline so decks remain
  self-contained.
- `SlideContent` gains an optional `brandKitId?: string`;
  `parseSlideContent` carries it through `coerceBrandKitId` (a structural
  check only). Whether that id still resolves to a real kit is decided at
  render time against the live store, so an unknown/deleted id simply
  **degrades to "no brand kit"** and the deck renders on its plain theme.
- **Brand kit is deck-scoped, not editor-scoped.** It lives in the
  deck's `brandKitId`, so any operation that **replaces the whole deck**
  re-establishes a coherent brand state rather than carrying the old skin
  over: a version restore reads `brandKitId` from the incoming deck, and
  applying a template or an AI-generated deck **detaches** the kit
  (`brandKitId → undefined`). A template declares its own
  `suggestedTheme`, so inheriting a kit authored against a different base
  theme would leave `deck.themeId !== kit.baseThemeId` and let a later
  re-apply snap the theme back. Detaching only removes the skin; the
  curated theme and all slide content are preserved, and the kit (still
  in the store) is one click away from being re-applied. A deck swap also
  dismisses the brand builder modal, which seeds its draft from the deck
  at mount and would otherwise edit a stale draft.
- **`themeId == baseThemeId` is established, not invariant.** The deck's
  `themeId` is aligned to the kit's `baseThemeId` only at the points
  where the brand state is (re-)established — applying/saving a kit
  (`applyBrandKit`) and restoring/replacing a deck — not as a standing
  invariant. The interactive theme picker is the one path that
  deliberately lets the two diverge: because a kit is a _layer_,
  switching themes keeps the skin and re-skins the newly chosen base (the
  Gamma/Google-Slides "swap the base, keep the brand" model). The builder
  is where `baseThemeId` is authoritatively chosen, so re-applying the
  kit from there re-asserts that base — expected, since the builder shows
  the base-theme selector.

UI integration is additive and reuses existing primitives:

- **`editors/components/BrandKitBuilderModal.tsx`** — a "copy &
  customize a theme" form built on the existing `components/Modal.tsx`
  (focus-trapped, `role="dialog"`). It picks a base theme, edits the five
  brand hex colours, picks heading/body fonts from the curated list,
  uploads a logo (→ inline `data:` URL) and its placement, and shows a
  **live preview** rendered with the same `.slide-canvas` classes and a
  `brandDraftCssVars` override map that tolerates half-typed input. Save
  routes through `saveBrandKit`, surfaces validation errors inline, and
  applies the kit to the deck. A "Customize brand" trigger sits beside
  the theme picker in the toolbar.

### Privacy

Consistent with ADR 0004: a brand kit stores only the user's own brand
assets (colours, curated font ids, an inline logo `data:` URL) on-device
in `localStorage`, and is **never transmitted**. The logo is embedded
inline rather than fetched, so rendering a branded deck adds no network
egress.

## Consequences

- A user can open a deck, click "Customize brand", set brand
  colours/fonts/logo with a live preview, and watch the canvas re-skin
  **without any slide content changing**; the logo appears in the chosen
  corner on every slide; and the brand persists across reloads. This
  delivers the Gamma/Google-Slides brand-skin capability that was the
  single biggest gap versus those benchmarks.
- The change stays fully inside the renderer-only, additive boundary: no
  IPC/Rust/schema changes, every field optional, no id renamed. A legacy
  deck with no `brandKitId` serialises and renders exactly as before
  (`JSON.stringify` drops the `undefined` field).
- Expressing the skin as an **override of the existing `--slide-*`
  properties** (rather than a second styling path) means the curated
  themes and the brand layer cannot drift apart: any property a kit does
  not set inherits the base theme, and the pure `slideBrandKit.ts` is
  exhaustively unit-testable (validator/normalizer, store round-trip,
  the stamped override map).
- A deck references a kit by id and resolves it at render time, so
  deleting a kit never corrupts a deck — it cleanly degrades to the
  plain base theme.
- **`localStorage` trade-offs (accepted):** brand kits are per-device,
  not synced, subject to the storage quota (bounded by `MAX_BRAND_KITS`
  and the logo size cap), and wiped if the user clears site data — the
  same accepted trade-off as 0013. This ADR deliberately scopes out
  Brand Pack file export/import; a later session layers portability on
  top of this model without changing it.
