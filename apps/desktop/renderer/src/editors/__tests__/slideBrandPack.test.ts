import { beforeEach, describe, expect, it } from "vitest";
import {
  BRAND_KIT_ID_PREFIX,
  BRAND_PACK_FORMAT,
  BRAND_PACK_VERSION,
  brandPackFilename,
  buildBrandKit,
  emptyBrandKitDraft,
  isBrandKitId,
  loadBrandKits,
  parseBrandPack,
  saveBrandKits,
  serializeBrandKitStore,
  serializeBrandPack,
  type BrandKit,
  type BrandKitDraft,
} from "../slideBrandKit";

// A 1x1 transparent PNG, well under the size cap.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A minimal valid draft; override fields per-test. */
function draft(overrides: Partial<BrandKitDraft> = {}): BrandKitDraft {
  return {
    ...emptyBrandKitDraft("aurora"),
    name: "Acme Corp",
    colors: {
      accent: "#7c3aed",
      surface: "#ffffff",
      text: "#1e1b2e",
      heading: "",
      muted: "",
    },
    ...overrides,
  };
}

/** Build a kit with a deterministic id so assertions are stable. */
function buildKit(
  overrides: Partial<BrandKitDraft> = {},
  id = "fixed",
): BrandKit {
  const result = buildBrandKit(
    draft(overrides),
    () => `${BRAND_KIT_ID_PREFIX}${id}`,
  );
  if (!result.ok)
    throw new Error(`unexpected build failure: ${result.errors.join(", ")}`);
  return result.brandKit;
}

/** A kit exercising every optional field (refinements, fonts, logo, bg). */
function richKit(id = "source"): BrandKit {
  return buildKit(
    {
      name: "Globex Industries",
      colors: {
        accent: "#0f766e",
        surface: "#f8fafc",
        text: "#0b1320",
        heading: "#082f49",
        muted: "#64748b",
      },
      baseThemeId: "aurora",
      headingFont: "serif",
      bodyFont: "inter",
      logoDataUrl: PNG_DATA_URL,
      logoAlt: "Globex mark",
      logoPlacement: "br",
      bgStyle: "gradient",
    },
    id,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("serializeBrandPack", () => {
  it("wraps a kit in a tagged, versioned envelope distinct from the store", () => {
    const parsed = JSON.parse(serializeBrandPack(richKit())) as Record<
      string,
      unknown
    >;
    expect(parsed.format).toBe(BRAND_PACK_FORMAT);
    expect(parsed.version).toBe(BRAND_PACK_VERSION);
    expect((parsed.brandKit as BrandKit).id).toBe(
      `${BRAND_KIT_ID_PREFIX}source`,
    );
    // Export uses singular `brandKit`; the store envelope uses `brandKits`.
    expect(parsed).not.toHaveProperty("brandKits");
    // Pretty-printed (human-shareable), not minified onto one line.
    expect(serializeBrandPack(richKit())).toContain("\n");
  });

  it("does not mutate the kit it serialises", () => {
    const kit = richKit();
    const before = JSON.stringify(kit);
    serializeBrandPack(kit);
    expect(JSON.stringify(kit)).toBe(before);
  });
});

describe("brandPackFilename", () => {
  it("slugifies the name to kebab-case with a .json extension", () => {
    expect(brandPackFilename(buildKit({ name: "My Cool Brand" }))).toBe(
      "tessera-brand-my-cool-brand.json",
    );
  });

  it("collapses punctuation/whitespace runs into single hyphens", () => {
    expect(brandPackFilename(buildKit({ name: "Acme — Corp!!  2024" }))).toBe(
      "tessera-brand-acme-corp-2024.json",
    );
  });

  it("falls back to a stable stem when nothing usable remains", () => {
    expect(brandPackFilename(buildKit({ name: "!!!" }))).toBe(
      "tessera-brand-brand.json",
    );
  });
});

describe("parseBrandPack — happy path", () => {
  it("round-trips a kit byte-for-byte except for a freshly minted id", () => {
    const source = richKit("source");
    const result = parseBrandPack(serializeBrandPack(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The draft carries NO id ⇒ saving mints a fresh one (non-destructive).
    expect(result.draft.id).toBeUndefined();

    const rebuilt = buildBrandKit(
      result.draft,
      () => `${BRAND_KIT_ID_PREFIX}imported`,
    );
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    // A brand-new, non-overwriting id…
    expect(isBrandKitId(rebuilt.brandKit.id)).toBe(true);
    expect(rebuilt.brandKit.id).not.toBe(source.id);
    // …but every other field survives the export → import → build trip.
    expect({ ...rebuilt.brandKit, id: source.id }).toEqual(source);
  });

  it("imports a colours-only kit (optional refinements omitted)", () => {
    const source = buildKit({ name: "Minimal" }, "minimal");
    const result = parseBrandPack(serializeBrandPack(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rebuilt = buildBrandKit(
      result.draft,
      () => `${BRAND_KIT_ID_PREFIX}x`,
    );
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;
    expect({ ...rebuilt.brandKit, id: source.id }).toEqual(source);
  });

  it("ignores an unknown/forward-compat templates field instead of rejecting", () => {
    const source = richKit("fc");
    const envelope = {
      format: BRAND_PACK_FORMAT,
      version: BRAND_PACK_VERSION,
      brandKit: source,
      // A later session bundles user templates into the same pack; an older
      // client of the same format version must tolerate (ignore) the field.
      templates: [{ id: "tpl-1", name: "Cover" }],
      somethingElseEntirely: 42,
    };
    const result = parseBrandPack(JSON.stringify(envelope));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.draft.name).toBe("Globex Industries");
    // The unknown fields never leak into the draft.
    expect(result.draft).not.toHaveProperty("templates");
  });

  it("persists an imported kit as a NEW kit on save → load", () => {
    const source = richKit("orig");
    const result = parseBrandPack(serializeBrandPack(source));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const rebuilt = buildBrandKit(result.draft);
    expect(rebuilt.ok).toBe(true);
    if (!rebuilt.ok) return;

    expect(rebuilt.brandKit.id).not.toBe(source.id);
    saveBrandKits([rebuilt.brandKit]);
    const [loaded] = loadBrandKits();
    expect(loaded.name).toBe("Globex Industries");
    expect(loaded.colors.accent).toBe("#0f766e");
    expect(loaded.logo?.alt).toBe("Globex mark");
  });
});

describe("parseBrandPack — rejections", () => {
  it("rejects invalid JSON", () => {
    const result = parseBrandPack("not json{");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/i);
  });

  it("rejects a file without the brand-pack format tag", () => {
    // The localStorage store envelope ({version, brandKits}) has no `format`.
    const storeBlob = serializeBrandKitStore([richKit()]);
    const result = parseBrandPack(storeBlob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Tessera brand pack/i);
  });

  it("rejects an envelope from a newer pack version", () => {
    const blob = JSON.stringify({
      format: BRAND_PACK_FORMAT,
      version: BRAND_PACK_VERSION + 1,
      brandKit: richKit(),
    });
    const result = parseBrandPack(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/newer version/i);
  });

  it("rejects a version below the first version as malformed, not 'newer'", () => {
    // 0, negative, non-integer and non-finite versions were never produced by
    // any release; reject them as malformed BEFORE the "newer" check.
    for (const version of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const blob = JSON.stringify({
        format: BRAND_PACK_FORMAT,
        version,
        brandKit: richKit(),
      });
      const result = parseBrandPack(blob);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/valid Tessera brand pack/i);
      expect(result.error).not.toMatch(/newer version/i);
    }
  });

  it("rejects an envelope whose version is not a number", () => {
    const blob = JSON.stringify({
      format: BRAND_PACK_FORMAT,
      version: "1",
      brandKit: richKit(),
    });
    const result = parseBrandPack(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/valid Tessera brand pack/i);
  });

  it("rejects a file that contains no brand kit", () => {
    const blob = JSON.stringify({
      format: BRAND_PACK_FORMAT,
      version: BRAND_PACK_VERSION,
      brandKit: 123,
    });
    const result = parseBrandPack(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/doesn’t contain a brand kit/i);
  });

  it("rejects a well-formed envelope whose kit fails to build (bad colours)", () => {
    const blob = JSON.stringify({
      format: BRAND_PACK_FORMAT,
      version: BRAND_PACK_VERSION,
      brandKit: { name: "Broken", colors: { accent: "nope" } },
    });
    const result = parseBrandPack(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.length).toBeGreaterThan(0);
  });

  it("rejects a kit whose logo is not an inline data: URL", () => {
    const blob = JSON.stringify({
      format: BRAND_PACK_FORMAT,
      version: BRAND_PACK_VERSION,
      brandKit: {
        name: "Remote Logo",
        colors: { accent: "#7c3aed", surface: "#ffffff", text: "#1e1b2e" },
        logo: {
          dataUrl: "https://example.com/logo.png",
          alt: "remote",
          placement: "tl",
        },
      },
    });
    const result = parseBrandPack(blob);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/logo/i);
  });
});
