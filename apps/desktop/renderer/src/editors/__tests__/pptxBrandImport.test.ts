import { describe, expect, it } from "vitest";
import { zipSync, strToU8 } from "fflate";
import { parsePptxBrand } from "../pptxBrandImport";
import {
  isInlineImageDataUrl,
  MAX_LOGO_DATA_URL_LENGTH,
} from "../slideBrandKit";

// ─────────────────────────────────────────────────────────────────────
// Fixtures: build a minimal, valid `.pptx` (OPC ZIP) in-memory with the
// same library we ship, so the tests exercise the real unzip + parse path.
// ─────────────────────────────────────────────────────────────────────

type ColorSpec = { srgb: string } | { sysLastClr: string };

function clrSlot(name: string, spec: ColorSpec): string {
  if ("srgb" in spec) {
    return `<a:${name}><a:srgbClr val="${spec.srgb}"/></a:${name}>`;
  }
  return `<a:${name}><a:sysClr val="windowText" lastClr="${spec.sysLastClr}"/></a:${name}>`;
}

interface ThemeSpec {
  colors?: Record<string, ColorSpec>;
  major?: string;
  minor?: string;
  includeColorScheme?: boolean;
  includeFontScheme?: boolean;
}

function themeXml(spec: ThemeSpec = {}): string {
  const {
    colors = {
      dk1: { srgb: "1E1B2E" },
      lt1: { srgb: "FAF8FF" },
      dk2: { srgb: "44546A" },
      lt2: { srgb: "E7E6E6" },
      accent1: { srgb: "7C3AED" },
    },
    major = "Cambria",
    minor = "Calibri",
    includeColorScheme = true,
    includeFontScheme = true,
  } = spec;

  const slots = Object.entries(colors)
    .map(([name, value]) => clrSlot(name, value))
    .join("");
  const clrScheme = includeColorScheme
    ? `<a:clrScheme name="Test">${slots}</a:clrScheme>`
    : "";
  const fontScheme = includeFontScheme
    ? `<a:fontScheme name="Test">` +
      `<a:majorFont><a:latin typeface="${major}"/></a:majorFont>` +
      `<a:minorFont><a:latin typeface="${minor}"/></a:minorFont>` +
      `</a:fontScheme>`
    : "";

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Test">` +
    `<a:themeElements>${clrScheme}${fontScheme}</a:themeElements>` +
    `</a:theme>`
  );
}

const IMAGE_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";

function masterRelsXml(
  rels: ReadonlyArray<{ type?: string; target: string; external?: boolean }>,
): string {
  const body = rels
    .map((rel, i) => {
      const type = rel.type ?? IMAGE_REL_TYPE;
      const mode = rel.external ? ` TargetMode="External"` : "";
      return `<Relationship Id="rId${i + 1}" Type="${type}" Target="${rel.target}"${mode}/>`;
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `${body}</Relationships>`
  );
}

function makePptx(files: Record<string, string | Uint8Array>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) {
    zippable[path] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(zippable);
}

/** A complete, well-formed deck with the default theme above. */
function defaultPptx(theme = themeXml()): Uint8Array {
  return makePptx({
    "[Content_Types].xml": "<Types/>",
    "ppt/presentation.xml": "<p:presentation/>",
    "ppt/theme/theme1.xml": theme,
  });
}

/** Decode a base64 string to bytes (test helper; `atob` exists in jsdom). */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function unwrap(result: ReturnType<typeof parsePptxBrand>) {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.draft;
}

describe("parsePptxBrand", () => {
  it("maps the clrScheme + fontScheme to a draft", () => {
    const draft = unwrap(
      parsePptxBrand(defaultPptx(), { fileName: "Acme Corp Deck.pptx" }),
    );

    expect(draft.colors.accent).toBe("#7c3aed"); // accent1
    expect(draft.colors.surface).toBe("#faf8ff"); // lt1
    expect(draft.colors.text).toBe("#1e1b2e"); // dk1
    expect(draft.colors.heading).toBe("#44546a"); // dk2
    // muted is a derived blend of text → surface; always a valid hex.
    expect(draft.colors.muted).toMatch(/^#[0-9a-f]{6}$/);
    expect(draft.colors.muted).toBe("#817e8c");

    expect(draft.headingFont).toBe("serif"); // Cambria
    expect(draft.bodyFont).toBe("humanist"); // Calibri
    expect(draft.name).toBe("Acme Corp Deck");
    expect(draft.logoDataUrl).toBe("");
  });

  it("is non-destructive: the draft carries no id", () => {
    const draft = unwrap(parsePptxBrand(defaultPptx()));
    expect(draft.id).toBeUndefined();
  });

  it("names the draft 'Imported brand' when no file name is given", () => {
    const draft = unwrap(parsePptxBrand(defaultPptx()));
    expect(draft.name).toBe("Imported brand");
  });

  it("reads sysClr via its @lastClr resolved value", () => {
    const theme = themeXml({
      colors: {
        dk1: { sysLastClr: "000000" },
        lt1: { sysLastClr: "FFFFFF" },
        accent1: { srgb: "FF0000" },
      },
    });
    const draft = unwrap(parsePptxBrand(defaultPptx(theme)));
    expect(draft.colors.text).toBe("#000000");
    expect(draft.colors.surface).toBe("#ffffff");
    expect(draft.colors.accent).toBe("#ff0000");
  });

  it("maps a variety of typefaces to curated font ids", () => {
    const cases: Array<[string, string]> = [
      ["Georgia", "serif"],
      ["Palatino Linotype", "elegant"],
      ["Consolas", "mono"],
      ["Roboto Mono", "mono"],
      ["Segoe UI", "humanist"],
      ["Arial", "sans"],
      ["Inter", "inter"],
    ];
    for (const [typeface, expected] of cases) {
      const draft = unwrap(
        parsePptxBrand(defaultPptx(themeXml({ major: typeface }))),
      );
      expect(draft.headingFont).toBe(expected);
    }
  });

  it("leaves a font unset when no curated match is confident", () => {
    const draft = unwrap(
      parsePptxBrand(
        defaultPptx(themeXml({ major: "Comic Sans MS", minor: "Wingdings" })),
      ),
    );
    expect(draft.headingFont).toBe("");
    expect(draft.bodyFont).toBe("");
  });

  it("drops an invalid colour and falls back", () => {
    // accent1 is not a hex colour → dropped; accent falls back to dk2.
    const theme = themeXml({
      colors: {
        dk1: { srgb: "1E1B2E" },
        lt1: { srgb: "FAF8FF" },
        dk2: { srgb: "44546A" },
        accent1: { srgb: "NOTHEX" },
      },
    });
    const draft = unwrap(parsePptxBrand(defaultPptx(theme)));
    expect(draft.colors.accent).toBe("#44546a");
    expect(draft.colors.text).toBe("#1e1b2e");
  });

  it("seeds baseThemeId from a known option, else the default", () => {
    const withTheme = unwrap(
      parsePptxBrand(defaultPptx(), { baseThemeId: "noir" }),
    );
    expect(withTheme.baseThemeId).toBe("noir");

    const unknown = unwrap(
      parsePptxBrand(defaultPptx(), { baseThemeId: "does-not-exist" }),
    );
    expect(unknown.baseThemeId).toBe("aurora");
  });

  // ── Failure paths (never throw) ──────────────────────────────────────

  it("returns an error (no throw) for non-ZIP bytes", () => {
    const result = parsePptxBrand(new Uint8Array([1, 2, 3, 4, 5]));
    expect(result.ok).toBe(false);
  });

  it("returns an error for an empty input", () => {
    expect(parsePptxBrand(new Uint8Array()).ok).toBe(false);
    expect(parsePptxBrand(new ArrayBuffer(0)).ok).toBe(false);
  });

  it("returns an error when theme1.xml is missing", () => {
    const pptx = makePptx({
      "[Content_Types].xml": "<Types/>",
      "ppt/presentation.xml": "<p:presentation/>",
    });
    const result = parsePptxBrand(pptx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/theme/i);
  });

  it("returns an error when the theme has no usable colours", () => {
    // Only an out-of-trio accent + an invalid accent1 → nothing usable.
    const theme = themeXml({
      colors: { accent2: { srgb: "112233" }, accent1: { srgb: "ZZZZZZ" } },
    });
    const result = parsePptxBrand(defaultPptx(theme));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/colour/i);
  });

  it("returns an error for malformed theme XML (no throw)", () => {
    const result = parsePptxBrand(defaultPptx("<a:theme><broken"));
    expect(result.ok).toBe(false);
  });

  it("accepts an ArrayBuffer as well as a Uint8Array", () => {
    const bytes = defaultPptx();
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    expect(parsePptxBrand(buffer).ok).toBe(true);
  });

  // ── Zip-bomb guards ──────────────────────────────────────────────────

  it("trips the entry-count guard", () => {
    const result = parsePptxBrand(defaultPptx(), { limits: { maxEntries: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/large|complex/i);
  });

  it("trips the per-entry byte guard before inflating the theme", () => {
    const result = parsePptxBrand(defaultPptx(), {
      limits: { maxEntryBytes: 10 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/large|complex/i);
  });

  // ── Optional logo (best-effort) ──────────────────────────────────────

  it("extracts a small master logo into an inline data URL", () => {
    const pptx = makePptx({
      "ppt/theme/theme1.xml": themeXml(),
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": masterRelsXml([
        { target: "../media/image1.png" },
      ]),
      "ppt/media/image1.png": base64ToBytes(TINY_PNG_BASE64),
    });
    const draft = unwrap(parsePptxBrand(pptx, { fileName: "Brandy.pptx" }));
    expect(draft.logoDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(isInlineImageDataUrl(draft.logoDataUrl)).toBe(true);
    expect(draft.logoAlt).toBe("Brandy");
    expect(draft.logoPlacement).toBe("tl");
  });

  it("skips a non-web-renderable logo format (e.g. EMF)", () => {
    const pptx = makePptx({
      "ppt/theme/theme1.xml": themeXml(),
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": masterRelsXml([
        { target: "../media/image1.emf" },
      ]),
      "ppt/media/image1.emf": new Uint8Array([1, 2, 3, 4]),
    });
    const draft = unwrap(parsePptxBrand(pptx));
    expect(draft.logoDataUrl).toBe("");
  });

  it("rejects an oversize logo (over the inline size cap)", () => {
    const oversize = new Uint8Array(MAX_LOGO_DATA_URL_LENGTH); // > cap once base64'd
    const pptx = makePptx({
      "ppt/theme/theme1.xml": themeXml(),
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": masterRelsXml([
        { target: "../media/image1.png" },
      ]),
      "ppt/media/image1.png": oversize,
    });
    const draft = unwrap(parsePptxBrand(pptx));
    expect(draft.logoDataUrl).toBe("");
  });

  it("ignores an external (hyperlink-mode) image relationship", () => {
    const pptx = makePptx({
      "ppt/theme/theme1.xml": themeXml(),
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": masterRelsXml([
        { target: "https://example.com/logo.png", external: true },
      ]),
    });
    const draft = unwrap(parsePptxBrand(pptx));
    expect(draft.logoDataUrl).toBe("");
  });
});
