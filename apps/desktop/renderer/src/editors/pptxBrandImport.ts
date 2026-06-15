// ─────────────────────────────────────────────────────────────────────
// Import a Brand Kit from an uploaded `.pptx` (Gamma-style "import your
// brand from a deck").
//
// A `.pptx` is an OPC package — a ZIP whose theme lives at
// `ppt/theme/theme1.xml`. That part carries the deck's `<a:clrScheme>`
// (named colours) and `<a:fontScheme>` (heading/body typefaces), and the
// slide master may reference a logo image under `ppt/media/`. This module
// reads exactly those parts and turns them into a {@link BrandKitDraft}
// the user reviews and saves through the existing S1 brand builder — so a
// real branded deck becomes a Tessera Brand Kit in one step.
//
// It is deliberately light on resources: the archive is never inflated
// whole. Only the two or three entries we actually read (the theme, the
// master rels, and at most one logo image) are decompressed, and a guard
// caps the entry count and the decompressed bytes so a hostile or
// pathological file can't blow up CPU/memory. Everything runs in the
// renderer, synchronously, with no network — local-first by construction.
//
// The result mirrors `parseBrandPack`: a draft with NO id, so saving mints
// a fresh kit and an import can never overwrite an existing one. Every
// extracted value is run through the S1 coercers (`normalizeHexColor`,
// `isBrandFontId`, `isInlineImageDataUrl`) — a raw OOXML string never
// reaches the brand model directly. The function never throws on malformed
// input; it degrades to a friendly `{ ok: false, error }`.
// ─────────────────────────────────────────────────────────────────────

import {
  unzipSync,
  strFromU8,
  type Unzipped,
  type UnzipFileInfo,
} from "fflate";
import {
  type BrandKitDraft,
  normalizeHexColor,
  isBrandFontId,
  isInlineImageDataUrl,
  MAX_BRAND_NAME,
} from "./slideBrandKit";
import { DEFAULT_SLIDE_THEME_ID, isKnownSlideThemeId } from "./slideThemes";

/** Result of importing a brand from a `.pptx`. Mirrors `parseBrandPack`. */
export type PptxBrandImportResult =
  | { ok: true; draft: BrandKitDraft }
  | { ok: false; error: string };

/**
 * Caps that bound the work the importer will do, so a hostile or
 * pathological archive (a "zip bomb") can't exhaust CPU or memory. They
 * are generous for any real presentation and overridable for tests.
 */
export interface PptxParseLimits {
  /** Maximum number of entries the OPC package may declare. */
  maxEntries: number;
  /** Maximum decompressed bytes for any single inflated entry. */
  maxEntryBytes: number;
  /** Maximum decompressed bytes summed across the entries we inflate. */
  maxTotalBytes: number;
}

export const DEFAULT_PPTX_PARSE_LIMITS: PptxParseLimits = {
  maxEntries: 4096,
  maxEntryBytes: 8 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
};

export interface PptxParseOptions {
  /** Original file name; used to name the draft so the kit is identifiable. */
  fileName?: string;
  /** Curated base theme the kit re-skins; defaults to the app default. */
  baseThemeId?: string;
  /** Override the guard limits (mainly for tests). */
  limits?: Partial<PptxParseLimits>;
}

// User-facing rejection messages. Specific enough to act on, never a stack
// trace. The typographic apostrophe matches the rest of the editor copy.
const NOT_A_PPTX = "That file isn’t a PowerPoint (.pptx) we can read.";
const NO_THEME = "Couldn’t find a theme in that .pptx.";
const NO_COLORS = "Couldn’t find any usable brand colours in that .pptx.";
const TOO_COMPLEX = "That .pptx is too large or complex to import safely.";

const DEFAULT_DRAFT_NAME = "Imported brand";

// The OPC parts we read. `theme1.xml` is the authoritative theme for the
// common single-master deck; the master rels are consulted only for an
// optional logo.
const THEME_PATH = "ppt/theme/theme1.xml";
const MASTER_RELS_PATH = "ppt/slideMasters/_rels/slideMaster1.xml.rels";

// Image extensions a browser/Electron renderer can actually display. EMF /
// WMF / TIFF (common in Office decks) are skipped — they would render as a
// broken image — so the logo path stays best-effort and silent on failure.
const WEB_IMAGE_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/**
 * Ordered typeface→curated-font aliases. A theme typeface (e.g. "Calibri
 * Light", "Cambria") is matched case-insensitively by substring to the
 * nearest curated `BRAND_FONTS` id; the first match wins, so more specific
 * needles (e.g. "roboto mono", "book antiqua") precede their broader
 * cousins ("roboto", the generic "serif"). No match ⇒ the font is left
 * unset and the base theme's font is used — we never pass a raw OOXML
 * typeface string through as a font id.
 */
const FONT_ALIASES: ReadonlyArray<readonly [needle: string, fontId: string]> = [
  // Monospace
  ["roboto mono", "mono"],
  ["liberation mono", "mono"],
  ["lucida console", "mono"],
  ["consol", "mono"],
  ["courier", "mono"],
  ["menlo", "mono"],
  ["monaco", "mono"],
  ["sfmono", "mono"],
  ["monospace", "mono"],
  // Elegant serif
  ["palatino", "elegant"],
  ["book antiqua", "elegant"],
  ["garamond", "elegant"],
  ["goudy", "elegant"],
  ["constantia", "elegant"],
  // Classic serif
  ["times new roman", "serif"],
  ["cambria", "serif"],
  ["georgia", "serif"],
  ["times", "serif"],
  ["minion", "serif"],
  ["pt serif", "serif"],
  ["merriweather", "serif"],
  ["serif", "serif"],
  // Inter (matches the app's own system font family)
  ["inter", "inter"],
  // Humanist sans
  ["calibri", "humanist"],
  ["segoe", "humanist"],
  ["trebuchet", "humanist"],
  ["corbel", "humanist"],
  ["candara", "humanist"],
  ["tahoma", "humanist"],
  ["verdana", "humanist"],
  ["optima", "humanist"],
  ["gill sans", "humanist"],
  ["open sans", "humanist"],
  ["lato", "humanist"],
  // Neutral / grotesque sans
  ["aptos", "sans"],
  ["arial", "sans"],
  ["helvetica", "sans"],
  ["roboto", "sans"],
  ["franklin gothic", "sans"],
  ["univers", "sans"],
  ["liberation sans", "sans"],
  ["proxima", "sans"],
  ["montserrat", "sans"],
  ["work sans", "sans"],
];

interface ThemeColors {
  accent1?: string;
  lt1?: string;
  dk1?: string;
  dk2?: string;
  lt2?: string;
}

interface ThemeFonts {
  heading: string;
  body: string;
}

// Accumulator threaded through the inflate filter so the byte caps are
// enforced across every entry we choose to decompress, not just per call.
interface InflateBudget {
  total: number;
  tripped: boolean;
}

/**
 * Parse an uploaded `.pptx`'s OOXML theme into a builder-ready
 * {@link BrandKitDraft}, or a friendly error. Never throws.
 *
 * Mapping (each colour validated by `normalizeHexColor`):
 * `accent ← accent1`, `surface ← lt1`, `text ← dk1`, `heading ← dk2`
 * (falling back to text), and a derived `muted` (text blended toward
 * surface, so captions stay legible). Fonts map `majorFont → headingFont`
 * and `minorFont → bodyFont` via {@link FONT_ALIASES}.
 */
export function parsePptxBrand(
  input: ArrayBuffer | Uint8Array,
  options: PptxParseOptions = {},
): PptxBrandImportResult {
  const limits: PptxParseLimits = {
    ...DEFAULT_PPTX_PARSE_LIMITS,
    ...(options.limits ?? {}),
  };

  try {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (bytes.length === 0) return { ok: false, error: NOT_A_PPTX };

    // Cheap entry-count guard from the End-Of-Central-Directory record,
    // before inflating anything.
    const declaredEntries = readZipEntryCount(bytes);
    if (declaredEntries !== null && declaredEntries > limits.maxEntries) {
      return { ok: false, error: TOO_COMPLEX };
    }

    const budget: InflateBudget = { total: 0, tripped: false };

    // Pass 1: the required theme + (for an optional logo) the master rels.
    let primary: Unzipped;
    try {
      primary = inflateWanted(
        bytes,
        (name) => name === THEME_PATH || name === MASTER_RELS_PATH,
        limits,
        budget,
      );
    } catch {
      // fflate throws on a non-ZIP / unsupported-compression entry.
      return { ok: false, error: NOT_A_PPTX };
    }

    const themeBytes = primary[THEME_PATH];
    if (!themeBytes) {
      // A tripped guard means the theme existed but was too big to inflate;
      // otherwise the part is genuinely absent.
      return { ok: false, error: budget.tripped ? TOO_COMPLEX : NO_THEME };
    }

    const themeDoc = parseXml(strFromU8(themeBytes));
    if (!themeDoc) return { ok: false, error: NO_THEME };

    const colors = extractColors(themeDoc);
    // accent1 / lt1 / dk1 are the load-bearing trio — require at least one
    // before treating this as a usable theme.
    if (!colors.accent1 && !colors.lt1 && !colors.dk1) {
      return { ok: false, error: NO_COLORS };
    }

    const surface = colors.lt1 ?? "#ffffff";
    const text = colors.dk1 ?? "#1e1b2e";
    const accent = colors.accent1 ?? colors.dk2 ?? text;
    const heading = colors.dk2 ?? text;
    const muted = blendHex(text, surface, 0.45) ?? colors.lt2 ?? "";

    const fonts = extractFonts(themeDoc);

    const baseThemeId = isKnownSlideThemeId(options.baseThemeId)
      ? (options.baseThemeId as string)
      : DEFAULT_SLIDE_THEME_ID;

    const draft: BrandKitDraft = {
      name: draftNameFromFileName(options.fileName),
      baseThemeId,
      colors: { accent, surface, text, heading, muted },
      headingFont: fonts.heading,
      bodyFont: fonts.body,
      logoDataUrl: "",
      logoAlt: "",
      logoPlacement: "tl",
      bgStyle: "",
    };

    // Optional, best-effort logo. It must never fail the colour/font path,
    // so any problem (missing rels, oversize image, non-web format) just
    // leaves the logo empty for the user to add manually.
    try {
      const logoDataUrl = extractLogo(
        bytes,
        primary[MASTER_RELS_PATH],
        limits,
        budget,
      );
      if (logoDataUrl) {
        draft.logoDataUrl = logoDataUrl;
        draft.logoAlt = draft.name;
      }
    } catch {
      // ignore — logo stays unset
    }

    return { ok: true, draft };
  } catch {
    // Absolute backstop: the importer must never throw on malformed input.
    return { ok: false, error: NOT_A_PPTX };
  }
}

// ─────────────────────────────────────────────────────────────────────
// ZIP / inflate (only the entries we need)
// ─────────────────────────────────────────────────────────────────────

/**
 * Inflate only the entries `wanted` selects, enforcing the per-entry and
 * cumulative byte caps. An entry that would exceed a cap is skipped (not
 * inflated) and flips `budget.tripped` so the caller can tell "absent" from
 * "refused as too large".
 */
function inflateWanted(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  limits: PptxParseLimits,
  budget: InflateBudget,
): Unzipped {
  return unzipSync(bytes, {
    filter: (info: UnzipFileInfo) => {
      if (!wanted(info.name)) return false;
      if (info.originalSize > limits.maxEntryBytes) {
        budget.tripped = true;
        return false;
      }
      if (budget.total + info.originalSize > limits.maxTotalBytes) {
        budget.tripped = true;
        return false;
      }
      budget.total += info.originalSize;
      return true;
    },
  });
}

/**
 * Read the total entry count from a ZIP's End-Of-Central-Directory record,
 * or `null` when it can't be found (e.g. ZIP64). Best-effort: a `null`
 * simply means the count guard is skipped and the byte caps still apply.
 */
function readZipEntryCount(bytes: Uint8Array): number | null {
  const MIN_EOCD = 22;
  if (bytes.length < MIN_EOCD) return null;
  // The EOCD sits at the end, before an optional comment (<= 0xffff bytes).
  const earliest = Math.max(0, bytes.length - MIN_EOCD - 0xffff);
  for (let i = bytes.length - MIN_EOCD; i >= earliest; i--) {
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06
    ) {
      // Total entries (this disk) — 2-byte little-endian at offset 10.
      return bytes[i + 10] | (bytes[i + 11] << 8);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// XML extraction
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse XML namespace-aware, returning `null` on any parser error. We match
 * by local name (`getElementsByTagNameNS("*", …)`) so an unusual prefix
 * binding (`a:` vs anything else) never breaks lookup.
 */
function parseXml(xml: string): Document | null {
  try {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return null;
    if (!doc.documentElement) return null;
    return doc;
  } catch {
    return null;
  }
}

function extractColors(doc: Document): ThemeColors {
  const scheme = doc.getElementsByTagNameNS("*", "clrScheme")[0];
  if (!scheme) return {};
  const found: Record<string, string> = {};
  for (const slot of Array.from(scheme.children)) {
    const hex = colorFromSlot(slot);
    if (hex) found[slot.localName] = hex;
  }
  return {
    accent1: found.accent1,
    lt1: found.lt1,
    dk1: found.dk1,
    dk2: found.dk2,
    lt2: found.lt2,
  };
}

/**
 * Resolve a clrScheme slot (`dk1`, `accent1`, …) to a canonical hex colour.
 * A slot wraps either `<a:srgbClr val="RRGGBB"/>` or
 * `<a:sysClr … lastClr="RRGGBB"/>`; `lastClr` is the concrete value the
 * authoring app last resolved a system colour to.
 */
function colorFromSlot(slot: Element): string | null {
  const srgb = slot.getElementsByTagNameNS("*", "srgbClr")[0];
  if (srgb) return normalizeHexColor(srgb.getAttribute("val"));
  const sys = slot.getElementsByTagNameNS("*", "sysClr")[0];
  if (sys) return normalizeHexColor(sys.getAttribute("lastClr"));
  return null;
}

function extractFonts(doc: Document): ThemeFonts {
  const scheme = doc.getElementsByTagNameNS("*", "fontScheme")[0];
  if (!scheme) return { heading: "", body: "" };
  const major = scheme.getElementsByTagNameNS("*", "majorFont")[0];
  const minor = scheme.getElementsByTagNameNS("*", "minorFont")[0];
  return {
    heading: matchCuratedFont(latinTypeface(major)),
    body: matchCuratedFont(latinTypeface(minor)),
  };
}

/** The `<a:latin typeface="…">` name within a major/minor font group. */
function latinTypeface(fontGroup: Element | undefined): string {
  if (!fontGroup) return "";
  const latin = fontGroup.getElementsByTagNameNS("*", "latin")[0];
  return latin?.getAttribute("typeface") ?? "";
}

/** Map a theme typeface to a curated font id, or "" when none is confident. */
function matchCuratedFont(typeface: string): string {
  const name = typeface.trim().toLowerCase();
  if (!name) return "";
  for (const [needle, fontId] of FONT_ALIASES) {
    if (name.includes(needle) && isBrandFontId(fontId)) return fontId;
  }
  return "";
}

// ─────────────────────────────────────────────────────────────────────
// Optional logo
// ─────────────────────────────────────────────────────────────────────

/**
 * Best-effort: find the first web-renderable image the slide master
 * references, inflate just that one entry, and return it as a size-capped
 * inline `data:` URL — or `null` when there is no usable logo. Honours the
 * same byte budget so the logo can't blow the memory cap either.
 */
function extractLogo(
  bytes: Uint8Array,
  relsBytes: Uint8Array | undefined,
  limits: PptxParseLimits,
  budget: InflateBudget,
): string | null {
  if (!relsBytes) return null;
  const relsDoc = parseXml(strFromU8(relsBytes));
  if (!relsDoc) return null;

  const candidates: string[] = [];
  for (const rel of Array.from(
    relsDoc.getElementsByTagNameNS("*", "Relationship"),
  )) {
    const type = (rel.getAttribute("Type") ?? "").toLowerCase();
    const mode = (rel.getAttribute("TargetMode") ?? "internal").toLowerCase();
    const target = rel.getAttribute("Target") ?? "";
    // Only embedded image parts — never an external/hyperlink target.
    if (!type.endsWith("/image") || mode === "external" || !target) continue;
    candidates.push(target);
  }
  if (candidates.length === 0) return null;

  for (const target of candidates) {
    const path = resolveMasterRelTarget(target);
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const mime = WEB_IMAGE_MIME[ext];
    if (!mime) continue; // skip emf/wmf/tiff and other non-web formats

    let media: Unzipped;
    try {
      media = inflateWanted(bytes, (name) => name === path, limits, budget);
    } catch {
      continue;
    }
    const data = media[path];
    if (!data || data.length === 0) continue;

    const dataUrl = `data:${mime};base64,${bytesToBase64(data)}`;
    // Reuse the S1 guard: enforces inline `data:image/*` + the size cap.
    if (isInlineImageDataUrl(dataUrl)) return dataUrl;
    // Oversize or otherwise rejected — try the next candidate.
  }
  return null;
}

/**
 * Resolve a relationship `Target` from `slideMaster1.xml.rels` to a package
 * path. Targets are relative to `ppt/slideMasters/` (e.g.
 * `../media/image1.png` → `ppt/media/image1.png`); a leading `/` denotes a
 * package-absolute path.
 */
function resolveMasterRelTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const stack = ["ppt", "slideMasters"];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") stack.pop();
    else stack.push(segment);
  }
  return stack.join("/");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// ─────────────────────────────────────────────────────────────────────
// Colour + name helpers
// ─────────────────────────────────────────────────────────────────────

/** Blend two hex colours, `t` of the way from `a` to `b`. */
function blendHex(a: string, b: string, t: number): string | null {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return null;
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  return rgbToHex(mix(ca.r, cb.r), mix(ca.g, cb.g), mix(ca.b, cb.b));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const norm = normalizeHexColor(hex);
  if (!norm) return null;
  const n = norm.slice(1);
  return {
    r: parseInt(n.slice(0, 2), 16),
    g: parseInt(n.slice(2, 4), 16),
    b: parseInt(n.slice(4, 6), 16),
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const channel = (v: number) =>
    Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Derive a clean draft name from the uploaded file's name. */
function draftNameFromFileName(fileName: string | undefined): string {
  if (!fileName) return DEFAULT_DRAFT_NAME;
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const stem = base.replace(/\.[^.]+$/, "");
  const cleaned = stem.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  const bounded =
    cleaned.length > MAX_BRAND_NAME
      ? cleaned.slice(0, MAX_BRAND_NAME).trimEnd()
      : cleaned;
  return bounded || DEFAULT_DRAFT_NAME;
}
