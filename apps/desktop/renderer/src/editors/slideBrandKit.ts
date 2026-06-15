/**
 * Brand Kit data model + localStorage persistence for the Slide editor.
 *
 * Design intent
 * -------------
 * The curated {@link SLIDE_THEMES} catalogue gives every deck a
 * coordinated typographic + colour treatment, but a *brand* is more than
 * a theme: an organisation wants its own accent, surface and text
 * colours, its own heading/body fonts and its logo in a fixed corner —
 * applied on top of whichever curated theme reads best. Gamma and Google
 * Slides both model this as a re-skinnable layer that leaves the deck's
 * structure (slides, layouts, blocks) untouched. A {@link BrandKit}
 * captures exactly that layer.
 *
 * How a kit re-skins a theme
 * --------------------------
 * A kit copies a base theme ({@link BrandKit.baseThemeId}) and overrides
 * only the parts it cares about. At render time the editor turns the kit
 * into a set of `--slide-*` CSS custom properties (see
 * {@link brandKitCssVars}) and stamps them *inline* on the slide canvas.
 * Inline custom properties beat the stylesheet's
 * `[data-slide-theme="…"]` declarations (same element, higher
 * specificity), so the existing theme CSS — which already reads
 * `--slide-accent`, `--slide-surface`, `--slide-font-body`, … — simply
 * picks up the brand values with zero changes to slide content.
 *
 * Persistence + safety (mirrors `skills/customSkills.ts`)
 * -------------------------------------------------------
 * Kits live in `localStorage` under {@link BRAND_KITS_STORAGE_KEY} in a
 * versioned envelope. Parsing is defensive and never throws: bad JSON, a
 * wrong schema version or a malformed kit degrade gracefully (the whole
 * store → empty, an individual bad kit → dropped). Every stored kit is
 * re-validated through {@link buildBrandKit} on load so a persisted kit
 * can never diverge from what the builder UI would have allowed, and a
 * tampered id that is not brand-namespaced is rejected. Local-first: no
 * value ever leaves the machine.
 */
import type { SlideBgStyle } from "./slideThemes";
import { DEFAULT_SLIDE_THEME_ID, isKnownSlideThemeId } from "./slideThemes";

// ─────────────────────────────────────────────────────────────────────
// Storage / id / bound constants
// ─────────────────────────────────────────────────────────────────────

/** `localStorage` key for the persisted custom brand-kit list. */
export const BRAND_KITS_STORAGE_KEY = "tessera.brandkits.custom";

/** Namespacing prefix for a locally-minted brand-kit id. */
export const BRAND_KIT_ID_PREFIX = "brand-";

/**
 * Schema version for the persisted envelope. LOCAL to this module — it
 * is NOT the global app schema version and must not be confused with it.
 * Bump only when the stored shape changes incompatibly.
 */
const SCHEMA_VERSION = 1;

/** Hard cap on stored kits, oldest-dropped on overflow (mirrors skills). */
export const MAX_BRAND_KITS = 50;

/** Length bound for a kit's display name. */
export const MAX_BRAND_NAME = 60;

/** Length bound for the logo alt text. */
export const MAX_LOGO_ALT = 120;

/**
 * Upper bound on an inline logo `data:` URL, in characters. A logo is
 * embedded directly in the deck so it stays self-contained; this keeps a
 * pathological multi-megabyte upload from bloating every saved deck and
 * `localStorage`. ~512 KB of base64 ≈ a generous 380 KB image.
 */
export const MAX_LOGO_DATA_URL_LENGTH = 512 * 1024;

/**
 * Approximate maximum *source-image* size the logo cap permits, in KB, for
 * user-facing copy. The hard limit is on the inline data: URL **length**
 * ({@link MAX_LOGO_DATA_URL_LENGTH}); base64 inflates bytes by ~4/3, so the
 * usable source image is ~3/4 of that. Stating this figure (rather than the
 * raw 512 KB char budget) keeps the limit we *show* in step with the limit
 * we *enforce* — a ~400 KB file is rejected, so "under 512 KB" would mislead.
 */
export const MAX_LOGO_IMAGE_KB = Math.round(
  (MAX_LOGO_DATA_URL_LENGTH * 3) / 4 / 1024,
);

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/** Corner the master logo is pinned to. */
export type LogoPlacement = "tl" | "tr" | "bl" | "br";

/** The four placements in picker display order (top row, then bottom). */
export const LOGO_PLACEMENTS: readonly LogoPlacement[] = [
  "tl",
  "tr",
  "bl",
  "br",
];

const LOGO_PLACEMENT_SET: ReadonlySet<string> = new Set(LOGO_PLACEMENTS);

/** Master logo pinned to a slide corner via CSS (no per-slide block). */
export interface BrandLogo {
  /** Inline `data:image/*` URL so the deck stays self-contained. */
  dataUrl: string;
  /** Accessible description; "" is allowed for a decorative mark. */
  alt: string;
  placement: LogoPlacement;
}

/**
 * Brand colour overrides. `accent`, `surface` and `text` are required
 * (a usable brand needs all three); `heading` and `muted` are optional
 * refinements that fall back to the base theme when omitted. Every value
 * is a canonical lowercase `#rrggbb` string (see {@link normalizeHexColor}).
 */
export interface BrandColors {
  accent: string;
  surface: string;
  text: string;
  heading?: string;
  muted?: string;
}

/**
 * A user-defined brand skin layered over a curated theme. Every field
 * beyond the identity + colours is optional so a minimal kit (just
 * colours) is valid and legacy decks render unchanged when no kit is
 * active.
 */
export interface BrandKit {
  /** Brand-namespaced id; see {@link newBrandKitId}. */
  id: string;
  /** Display name, e.g. "Acme Corp". */
  name: string;
  colors: BrandColors;
  /** Curated font id ({@link BRAND_FONTS}) for headings; omitted ⇒ theme. */
  headingFont?: string;
  /** Curated font id ({@link BRAND_FONTS}) for body; omitted ⇒ theme. */
  bodyFont?: string;
  logo?: BrandLogo;
  /** Decorative background; omitted ⇒ inherit the base theme's. */
  bgStyle?: SlideBgStyle;
  /** Which curated theme the kit copies + customizes. */
  baseThemeId?: string;
}

/**
 * Flat, all-strings draft the builder UI binds to. Optional kit fields
 * are represented by the empty string (never `undefined`) so the form
 * controls stay controlled. {@link buildBrandKit} turns a draft into a
 * validated {@link BrandKit}.
 */
export interface BrandKitDraft {
  /** Present when editing an existing kit; absent for a new one. */
  id?: string;
  name: string;
  baseThemeId: string;
  colors: {
    accent: string;
    surface: string;
    text: string;
    heading: string;
    muted: string;
  };
  /** Curated font id, or "" to inherit the base theme. */
  headingFont: string;
  bodyFont: string;
  /** "" ⇒ no logo. */
  logoDataUrl: string;
  logoAlt: string;
  logoPlacement: LogoPlacement;
  /** "" ⇒ inherit the base theme's background style. */
  bgStyle: string;
}

/** Result of building a kit from a draft. */
export type BrandKitBuildResult =
  | { ok: true; brandKit: BrandKit }
  | { ok: false; errors: string[] };

// ─────────────────────────────────────────────────────────────────────
// Curated font catalogue
// ─────────────────────────────────────────────────────────────────────

/**
 * A selectable brand font. We persist the stable {@link BrandFont.id}
 * (not a raw CSS string) so a tampered store can never inject arbitrary
 * `font-family` CSS into the canvas; the id resolves to a vetted,
 * web-safe stack only at apply time (see {@link brandFontStack}).
 */
export interface BrandFont {
  id: string;
  label: string;
  /** Vetted, web-safe font stack stamped into a `--slide-font-*` var. */
  stack: string;
}

/**
 * Curated font list. "system" maps to the app's own `--font-family`
 * (Inter-based) so it always matches the design system; the rest are
 * web-safe stacks that render without bundling extra font files (keeping
 * the renderer local-first and offline-safe).
 */
export const BRAND_FONTS: readonly BrandFont[] = [
  { id: "system", label: "System default", stack: "var(--font-family)" },
  {
    id: "inter",
    label: "Inter",
    stack: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  },
  {
    id: "sans",
    label: "Neutral sans",
    stack: "'Helvetica Neue', Helvetica, Arial, sans-serif",
  },
  {
    id: "humanist",
    label: "Humanist sans",
    stack: "'Segoe UI', 'Trebuchet MS', system-ui, -apple-system, sans-serif",
  },
  {
    id: "serif",
    label: "Classic serif",
    stack: "Georgia, 'Times New Roman', serif",
  },
  {
    id: "elegant",
    label: "Elegant serif",
    stack: "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif",
  },
  {
    id: "mono",
    label: "Monospace",
    stack:
      "var(--font-family-mono, ui-monospace), 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
  },
] as const;

const FONT_BY_ID: ReadonlyMap<string, BrandFont> = new Map(
  BRAND_FONTS.map((font) => [font.id, font]),
);

/** True iff `id` names a curated brand font. */
export function isBrandFontId(id: string | undefined | null): boolean {
  return typeof id === "string" && FONT_BY_ID.has(id);
}

/**
 * Resolve a curated font id to its vetted CSS stack, or `null` when the
 * id is unknown/absent (so the caller can fall back to the theme font).
 */
export function brandFontStack(id: string | undefined | null): string | null {
  if (id == null) return null;
  return FONT_BY_ID.get(id)?.stack ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────

const BG_STYLE_SET: ReadonlySet<string> = new Set<SlideBgStyle>([
  "solid",
  "gradient",
  "mesh",
  "dots",
  "lines",
]);

/** Narrow an arbitrary value to a known {@link SlideBgStyle}. */
export function isSlideBgStyle(value: unknown): value is SlideBgStyle {
  return typeof value === "string" && BG_STYLE_SET.has(value);
}

/** Narrow an arbitrary value to a {@link LogoPlacement}. */
export function isLogoPlacement(value: unknown): value is LogoPlacement {
  return typeof value === "string" && LOGO_PLACEMENT_SET.has(value);
}

/** Whether `id` belongs to a user-authored brand kit. */
export function isBrandKitId(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(BRAND_KIT_ID_PREFIX);
}

/**
 * Generate a locally-unique brand-kit id. Prefers `crypto.randomUUID`
 * (present in the Electron renderer + jsdom), falling back to a
 * time+random token so it never throws in an exotic host. Mirrors
 * `customSkills.newCustomSkillId`.
 */
export function newBrandKitId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return `${BRAND_KIT_ID_PREFIX}${c.randomUUID()}`;
  }
  return `${BRAND_KIT_ID_PREFIX}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** Collapse internal whitespace + trim, then length-bound. */
function collapse(raw: string, max: number): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const HEX_PATTERN = /^([0-9a-f]{3}|[0-9a-f]{6})$/;

/**
 * Normalise a hex colour to canonical lowercase `#rrggbb`, or `null`
 * when the input is not a 3- or 6-digit hex colour. A leading `#` is
 * optional and shorthand (`#abc`) expands to the full form (`#aabbcc`)
 * so equality + storage are unambiguous. Alpha (4/8-digit) is rejected:
 * slide surfaces want opaque brand colours.
 */
export function normalizeHexColor(
  raw: string | undefined | null,
): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/^#/, "");
  if (!HEX_PATTERN.test(s)) return null;
  const hex = s.length === 3 ? `${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}` : s;
  return `#${hex}`;
}

/** True iff `raw` is a hex colour {@link normalizeHexColor} accepts. */
export function isValidHexColor(raw: string | undefined | null): boolean {
  return normalizeHexColor(raw) !== null;
}

/**
 * True iff `url` is a non-empty inline `data:image/*` URL within the
 * size cap. The brand logo must be a self-contained inline image; a
 * remote `http(s)` URL would defeat local-first and a non-image data URL
 * would render as a broken image, so both are rejected.
 */
export function isInlineImageDataUrl(url: string | undefined | null): boolean {
  return (
    typeof url === "string" &&
    url.length > 0 &&
    url.length <= MAX_LOGO_DATA_URL_LENGTH &&
    /^data:image\/[a-z0-9.+-]+;/i.test(url)
  );
}

// ─────────────────────────────────────────────────────────────────────
// Build / normalize (single source of validation, reused on load)
// ─────────────────────────────────────────────────────────────────────

/** A fresh, empty draft seeded from the deck's current theme. */
export function emptyBrandKitDraft(baseThemeId?: string): BrandKitDraft {
  const base = isKnownSlideThemeId(baseThemeId)
    ? (baseThemeId as string)
    : DEFAULT_SLIDE_THEME_ID;
  return {
    name: "",
    baseThemeId: base,
    colors: { accent: "", surface: "", text: "", heading: "", muted: "" },
    headingFont: "",
    bodyFont: "",
    logoDataUrl: "",
    logoAlt: "",
    logoPlacement: "tl",
    bgStyle: "",
  };
}

/** Hydrate a draft from an existing kit so the builder can edit it. */
export function brandKitToDraft(kit: BrandKit): BrandKitDraft {
  return {
    id: kit.id,
    name: kit.name,
    baseThemeId: isKnownSlideThemeId(kit.baseThemeId)
      ? (kit.baseThemeId as string)
      : DEFAULT_SLIDE_THEME_ID,
    colors: {
      accent: kit.colors.accent,
      surface: kit.colors.surface,
      text: kit.colors.text,
      heading: kit.colors.heading ?? "",
      muted: kit.colors.muted ?? "",
    },
    headingFont: kit.headingFont ?? "",
    bodyFont: kit.bodyFont ?? "",
    logoDataUrl: kit.logo?.dataUrl ?? "",
    logoAlt: kit.logo?.alt ?? "",
    logoPlacement: kit.logo?.placement ?? "tl",
    bgStyle: kit.bgStyle ?? "",
  };
}

/**
 * Build + validate a {@link BrandKit} from a draft. Returns the kit on
 * success or the collected human-readable errors on failure. The base
 * theme + fonts + background degrade gracefully (unknown ⇒ default /
 * omitted) rather than erroring, because they are picker-bound and
 * cannot be made invalid through the UI; only the *required* colours,
 * the name, and a malformed logo upload produce errors.
 */
export function buildBrandKit(
  draft: BrandKitDraft,
  idGen: () => string = newBrandKitId,
): BrandKitBuildResult {
  const errors: string[] = [];

  const name = collapse(draft.name, MAX_BRAND_NAME);
  if (!name) errors.push("Name is required.");

  const accent = normalizeHexColor(draft.colors.accent);
  if (!accent) errors.push("Accent must be a valid hex colour (e.g. #7c3aed).");
  const surface = normalizeHexColor(draft.colors.surface);
  if (!surface)
    errors.push("Surface must be a valid hex colour (e.g. #faf8ff).");
  const text = normalizeHexColor(draft.colors.text);
  if (!text) errors.push("Text must be a valid hex colour (e.g. #1e1b2e).");

  // Optional colours: blank ⇒ omit; present-but-invalid ⇒ error.
  let heading: string | undefined;
  if (draft.colors.heading.trim()) {
    const normalized = normalizeHexColor(draft.colors.heading);
    if (!normalized) errors.push("Heading colour must be a valid hex colour.");
    else heading = normalized;
  }
  let muted: string | undefined;
  if (draft.colors.muted.trim()) {
    const normalized = normalizeHexColor(draft.colors.muted);
    if (!normalized) errors.push("Muted colour must be a valid hex colour.");
    else muted = normalized;
  }

  // Logo: blank ⇒ none; present-but-malformed ⇒ error.
  let logo: BrandLogo | undefined;
  if (draft.logoDataUrl.trim()) {
    if (!isInlineImageDataUrl(draft.logoDataUrl)) {
      errors.push(
        `Logo image is too large — choose a smaller image (under ~${MAX_LOGO_IMAGE_KB} KB).`,
      );
    } else {
      logo = {
        dataUrl: draft.logoDataUrl,
        alt: collapse(draft.logoAlt, MAX_LOGO_ALT),
        placement: isLogoPlacement(draft.logoPlacement)
          ? draft.logoPlacement
          : "tl",
      };
    }
  }

  if (errors.length > 0 || !accent || !surface || !text) {
    return { ok: false, errors };
  }

  const colors: BrandColors = { accent, surface, text };
  if (heading) colors.heading = heading;
  if (muted) colors.muted = muted;

  const kit: BrandKit = {
    id: isBrandKitId(draft.id) ? (draft.id as string) : idGen(),
    name,
    colors,
    baseThemeId: isKnownSlideThemeId(draft.baseThemeId)
      ? draft.baseThemeId
      : DEFAULT_SLIDE_THEME_ID,
  };
  if (isBrandFontId(draft.headingFont)) kit.headingFont = draft.headingFont;
  if (isBrandFontId(draft.bodyFont)) kit.bodyFont = draft.bodyFont;
  if (isSlideBgStyle(draft.bgStyle)) kit.bgStyle = draft.bgStyle;
  if (logo) kit.logo = logo;

  return { ok: true, brandKit: kit };
}

// ─────────────────────────────────────────────────────────────────────
// Brand → CSS custom properties (the re-skin)
// ─────────────────────────────────────────────────────────────────────

/**
 * Turn an active kit into the `--slide-*` custom properties to stamp
 * *inline* on the slide canvas, overriding the base theme. Only the
 * properties the kit actually defines are emitted, so unset refinements
 * (heading colour, muted, fonts, …) keep inheriting the curated theme.
 * The keys intentionally match the variables the existing theme CSS
 * already consumes (`--slide-accent`, `--slide-surface`,
 * `--slide-font-headline`, `--slide-font-body`) plus the two body-text
 * variables this feature introduces (`--slide-text`, `--slide-muted`).
 */
export function brandKitCssVars(kit: BrandKit): Record<string, string> {
  const vars: Record<string, string> = {
    "--slide-accent": kit.colors.accent,
    "--slide-surface": kit.colors.surface,
    "--slide-text": kit.colors.text,
  };
  if (kit.colors.heading) vars["--slide-headline"] = kit.colors.heading;
  if (kit.colors.muted) vars["--slide-muted"] = kit.colors.muted;
  const headingStack = brandFontStack(kit.headingFont);
  if (headingStack) vars["--slide-font-headline"] = headingStack;
  const bodyStack = brandFontStack(kit.bodyFont);
  if (bodyStack) vars["--slide-font-body"] = bodyStack;
  return vars;
}

/**
 * Like {@link brandKitCssVars} but for an in-progress {@link BrandKitDraft},
 * so the builder UI can show a live preview before the draft is a valid,
 * saved kit. Emits only the properties whose values are currently valid
 * (a half-typed hex colour is simply skipped), letting the rest fall back
 * to the base theme — the preview never flashes an invalid colour.
 */
export function brandDraftCssVars(
  draft: BrandKitDraft,
): Record<string, string> {
  const vars: Record<string, string> = {};
  const accent = normalizeHexColor(draft.colors.accent);
  if (accent) vars["--slide-accent"] = accent;
  const surface = normalizeHexColor(draft.colors.surface);
  if (surface) vars["--slide-surface"] = surface;
  const text = normalizeHexColor(draft.colors.text);
  if (text) vars["--slide-text"] = text;
  const heading = normalizeHexColor(draft.colors.heading);
  if (heading) vars["--slide-headline"] = heading;
  const muted = normalizeHexColor(draft.colors.muted);
  if (muted) vars["--slide-muted"] = muted;
  const headingStack = brandFontStack(draft.headingFont);
  if (headingStack) vars["--slide-font-headline"] = headingStack;
  const bodyStack = brandFontStack(draft.bodyFont);
  if (bodyStack) vars["--slide-font-body"] = bodyStack;
  return vars;
}

// ─────────────────────────────────────────────────────────────────────
// List ops (insert/replace, remove) — mirror customSkills
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert `kit` or replace the existing one with the same id, preserving
 * order (a replacement keeps its slot; a new kit appends). Enforces
 * {@link MAX_BRAND_KITS} by dropping the oldest when a *new* kit would
 * overflow — a replacement never trips the cap.
 */
export function upsertBrandKit(
  kits: ReadonlyArray<BrandKit>,
  kit: BrandKit,
): BrandKit[] {
  const idx = kits.findIndex((k) => k.id === kit.id);
  if (idx >= 0) {
    const next = kits.slice();
    next[idx] = kit;
    return next;
  }
  const next = [...kits, kit];
  return next.length > MAX_BRAND_KITS
    ? next.slice(next.length - MAX_BRAND_KITS)
    : next;
}

/** Remove a brand kit by id (no-op when absent). */
export function removeBrandKit(
  kits: ReadonlyArray<BrandKit>,
  id: string,
): BrandKit[] {
  return kits.filter((k) => k.id !== id);
}

/** Find a kit by id, or `null`. Total — safe with an unknown/absent id. */
export function findBrandKit(
  kits: ReadonlyArray<BrandKit>,
  id: string | undefined | null,
): BrandKit | null {
  if (id == null) return null;
  return kits.find((k) => k.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Defensive parse / serialize / load / save (mirrors customSkills)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce one raw stored object into a valid {@link BrandKit}, or `null`
 * when unusable. Routes through {@link buildBrandKit} so a persisted kit
 * reuses the exact same normalisation + validation as the builder UI and
 * can never diverge from it. A stored id that is not brand-namespaced is
 * rejected so a tampered blob cannot shadow anything.
 */
export function parseStoredBrandKit(value: unknown): BrandKit | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !isBrandKitId(rec.id)) return null;
  if (typeof rec.name !== "string") return null;

  const colors = asRecord(rec.colors) ?? {};
  const logo = asRecord(rec.logo);

  const draft: BrandKitDraft = {
    id: rec.id,
    name: rec.name,
    baseThemeId: asString(rec.baseThemeId) || DEFAULT_SLIDE_THEME_ID,
    colors: {
      accent: asString(colors.accent),
      surface: asString(colors.surface),
      text: asString(colors.text),
      heading: asString(colors.heading),
      muted: asString(colors.muted),
    },
    headingFont: asString(rec.headingFont),
    bodyFont: asString(rec.bodyFont),
    logoDataUrl: logo ? asString(logo.dataUrl) : "",
    logoAlt: logo ? asString(logo.alt) : "",
    logoPlacement:
      logo && isLogoPlacement(logo.placement) ? logo.placement : "tl",
    bgStyle: asString(rec.bgStyle),
  };

  const result = buildBrandKit(draft, () => rec.id as string);
  return result.ok ? result.brandKit : null;
}

/**
 * Defensively parse a raw `localStorage` string into a validated list of
 * brand kits, or `null` when absent/unusable. Never throws: bad JSON, a
 * wrong schema version, or a non-array `brandKits` all degrade to `null`;
 * individually-bad or duplicate-id kits are dropped.
 */
export function parseBrandKitStore(raw: string | null): BrandKit[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  if (rec.version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(rec.brandKits)) return null;

  const kits: BrandKit[] = [];
  const seen = new Set<string>();
  for (const item of rec.brandKits) {
    const kit = parseStoredBrandKit(item);
    if (kit && !seen.has(kit.id)) {
      seen.add(kit.id);
      kits.push(kit);
      if (kits.length >= MAX_BRAND_KITS) break;
    }
  }
  return kits;
}

/** Serialize a brand-kit list to the persisted JSON string (with version). */
export function serializeBrandKitStore(kits: ReadonlyArray<BrandKit>): string {
  return JSON.stringify({ version: SCHEMA_VERSION, brandKits: kits });
}

/**
 * Load + validate the persisted brand kits. Returns `[]` (never null)
 * when there is nothing usable, so callers can use the result directly.
 * Never throws.
 */
export function loadBrandKits(): BrandKit[] {
  try {
    return (
      parseBrandKitStore(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)) ??
      []
    );
  } catch {
    return [];
  }
}

/**
 * Persist `kits`. Best-effort: silently no-ops if `localStorage` is
 * unavailable or the write is rejected (quota/locked).
 */
export function saveBrandKits(kits: ReadonlyArray<BrandKit>): void {
  try {
    window.localStorage.setItem(
      BRAND_KITS_STORAGE_KEY,
      serializeBrandKitStore(kits),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}

/**
 * Structural coercion of a persisted `brandKitId` reference carried on a
 * deck's content. Validity against the *live* localStorage store can
 * only be checked at render time (the editor degrades to "no brand kit"
 * when the id is not found), so the pure content parser only confirms
 * the value is a brand-namespaced string and otherwise drops it. Mirrors
 * how `resolveThemeId` guards `themeId`.
 */
export function coerceBrandKitId(
  value: string | undefined | null,
): string | undefined {
  return isBrandKitId(value) ? (value as string) : undefined;
}
