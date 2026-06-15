import { beforeEach, describe, expect, it } from "vitest";
import {
  BRAND_KITS_STORAGE_KEY,
  BRAND_KIT_ID_PREFIX,
  MAX_BRAND_KITS,
  MAX_LOGO_DATA_URL_LENGTH,
  brandCssForExport,
  brandDraftCssVars,
  brandFontStack,
  brandKitCssVars,
  buildBrandKit,
  coerceBrandKitId,
  emptyBrandKitDraft,
  findBrandKit,
  isBrandFontId,
  isBrandKitId,
  isInlineImageDataUrl,
  isLogoPlacement,
  isSlideBgStyle,
  isValidHexColor,
  loadBrandKits,
  newBrandKitId,
  normalizeHexColor,
  parseBrandKitStore,
  parseStoredBrandKit,
  removeBrandKit,
  saveBrandKits,
  serializeBrandKitStore,
  upsertBrandKit,
  type BrandKit,
  type BrandKitDraft,
} from "../slideBrandKit";
import { parseSlideContent } from "../slideEditorHelpers";

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

/** Build a kit with a deterministic id (so assertions are stable). */
function kit(overrides: Partial<BrandKitDraft> = {}, id = "fixed"): BrandKit {
  const result = buildBrandKit(
    draft(overrides),
    () => `${BRAND_KIT_ID_PREFIX}${id}`,
  );
  if (!result.ok)
    throw new Error(`unexpected build failure: ${result.errors.join(", ")}`);
  return result.brandKit;
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("normalizeHexColor", () => {
  it("accepts 6-digit hex with or without a leading #", () => {
    expect(normalizeHexColor("#7C3AED")).toBe("#7c3aed");
    expect(normalizeHexColor("7c3aed")).toBe("#7c3aed");
  });

  it("expands 3-digit shorthand to the canonical 6-digit form", () => {
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
    expect(normalizeHexColor("abc")).toBe("#aabbcc");
  });

  it("trims surrounding whitespace and lowercases", () => {
    expect(normalizeHexColor("  #FFF  ")).toBe("#ffffff");
  });

  it("rejects malformed, alpha, and empty values", () => {
    expect(normalizeHexColor("#12g")).toBeNull();
    expect(normalizeHexColor("#1234")).toBeNull(); // 4-digit alpha
    expect(normalizeHexColor("#12345678")).toBeNull(); // 8-digit alpha
    expect(normalizeHexColor("rgb(0,0,0)")).toBeNull();
    expect(normalizeHexColor("")).toBeNull();
    expect(normalizeHexColor(undefined)).toBeNull();
    expect(normalizeHexColor(null)).toBeNull();
  });

  it("isValidHexColor mirrors normalizeHexColor's acceptance", () => {
    expect(isValidHexColor("#fff")).toBe(true);
    expect(isValidHexColor("nope")).toBe(false);
  });
});

describe("isInlineImageDataUrl", () => {
  it("accepts an inline data:image URL under the cap", () => {
    expect(isInlineImageDataUrl(PNG_DATA_URL)).toBe(true);
    expect(isInlineImageDataUrl("data:image/svg+xml;utf8,<svg/>")).toBe(true);
  });

  it("rejects remote URLs, non-image data, empty, and oversized payloads", () => {
    expect(isInlineImageDataUrl("https://example.com/logo.png")).toBe(false);
    expect(isInlineImageDataUrl("data:text/plain;base64,QQ==")).toBe(false);
    expect(isInlineImageDataUrl("")).toBe(false);
    expect(isInlineImageDataUrl(null)).toBe(false);
    const huge = `data:image/png;base64,${"A".repeat(MAX_LOGO_DATA_URL_LENGTH)}`;
    expect(isInlineImageDataUrl(huge)).toBe(false);
  });
});

describe("curated catalogues + narrowers", () => {
  it("resolves curated font ids to a vetted stack and rejects unknown ids", () => {
    expect(brandFontStack("system")).toBe("var(--font-family)");
    expect(brandFontStack("serif")).toContain("Georgia");
    expect(brandFontStack("not-a-font")).toBeNull();
    expect(brandFontStack(undefined)).toBeNull();
    expect(isBrandFontId("inter")).toBe(true);
    expect(isBrandFontId("inter-extra")).toBe(false);
  });

  it("narrows bg styles, placements, and brand ids", () => {
    expect(isSlideBgStyle("mesh")).toBe(true);
    expect(isSlideBgStyle("plaid")).toBe(false);
    expect(isLogoPlacement("br")).toBe(true);
    expect(isLogoPlacement("middle")).toBe(false);
    expect(isBrandKitId("brand-123")).toBe(true);
    expect(isBrandKitId("custom-123")).toBe(false);
  });

  it("mints brand-namespaced ids", () => {
    expect(newBrandKitId().startsWith(BRAND_KIT_ID_PREFIX)).toBe(true);
    expect(newBrandKitId()).not.toBe(newBrandKitId());
  });
});

describe("buildBrandKit", () => {
  it("builds a minimal valid kit and normalises its colours", () => {
    const result = buildBrandKit(
      draft({
        colors: {
          accent: "7C3AED",
          surface: "#FFF",
          text: "#1e1b2e",
          heading: "",
          muted: "",
        },
      }),
      () => "brand-x",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brandKit.id).toBe("brand-x");
    expect(result.brandKit.colors).toEqual({
      accent: "#7c3aed",
      surface: "#ffffff",
      text: "#1e1b2e",
    });
    // Unset optionals are omitted, not stored as empty strings.
    expect(result.brandKit.colors.heading).toBeUndefined();
    expect(result.brandKit.headingFont).toBeUndefined();
    expect(result.brandKit.logo).toBeUndefined();
  });

  it("collects errors for a missing name and the required colours", () => {
    const result = buildBrandKit(
      draft({
        name: "  ",
        colors: {
          accent: "nope",
          surface: "",
          text: "#1e1b2e",
          heading: "",
          muted: "",
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(3);
    expect(result.errors.join(" ")).toMatch(/name/i);
    expect(result.errors.join(" ")).toMatch(/accent/i);
    expect(result.errors.join(" ")).toMatch(/surface/i);
  });

  it("errors on a present-but-invalid optional colour but ignores a blank one", () => {
    const invalid = buildBrandKit(
      draft({
        colors: {
          accent: "#7c3aed",
          surface: "#ffffff",
          text: "#1e1b2e",
          heading: "bogus",
          muted: "",
        },
      }),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors.join(" ")).toMatch(/heading/i);
  });

  it("keeps a valid logo and rejects a malformed one", () => {
    const good = buildBrandKit(
      draft({
        logoDataUrl: PNG_DATA_URL,
        logoAlt: "Logo",
        logoPlacement: "br",
      }),
      () => "brand-logo",
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.brandKit.logo).toEqual({
        dataUrl: PNG_DATA_URL,
        alt: "Logo",
        placement: "br",
      });
    }

    const bad = buildBrandKit(draft({ logoDataUrl: "https://x/y.png" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toMatch(/logo/i);
  });

  it("degrades unknown base theme / font / bg gracefully instead of erroring", () => {
    const result = buildBrandKit(
      draft({
        baseThemeId: "does-not-exist",
        headingFont: "not-a-font",
        bgStyle: "plaid",
      }),
      () => "brand-d",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.brandKit.baseThemeId).toBe("aurora"); // default
    expect(result.brandKit.headingFont).toBeUndefined();
    expect(result.brandKit.bgStyle).toBeUndefined();
  });

  it("preserves a brand-namespaced draft id (edit) but mints when missing/foreign", () => {
    const edit = buildBrandKit(draft({ id: "brand-keep" }), () => "brand-new");
    expect(edit.ok && edit.brandKit.id).toBe("brand-keep");
    const foreign = buildBrandKit(
      draft({ id: "custom-skill" }),
      () => "brand-new",
    );
    expect(foreign.ok && foreign.brandKit.id).toBe("brand-new");
  });
});

describe("brandKitCssVars / brandDraftCssVars", () => {
  it("always emits the three required vars and conditionally the rest", () => {
    const minimal = brandKitCssVars(kit());
    expect(minimal).toEqual({
      "--slide-accent": "#7c3aed",
      "--slide-surface": "#ffffff",
      "--slide-text": "#1e1b2e",
    });

    const full = brandKitCssVars(
      kit({
        colors: {
          accent: "#7c3aed",
          surface: "#ffffff",
          text: "#1e1b2e",
          heading: "#111111",
          muted: "#6b7280",
        },
        headingFont: "serif",
        bodyFont: "inter",
      }),
    );
    expect(full["--slide-headline"]).toBe("#111111");
    expect(full["--slide-muted"]).toBe("#6b7280");
    expect(full["--slide-font-headline"]).toContain("Georgia");
    expect(full["--slide-font-body"]).toContain("Inter");
  });

  it("draft vars skip invalid/half-typed values so the preview never flashes", () => {
    const vars = brandDraftCssVars(
      draft({
        colors: {
          accent: "#7c3aed",
          surface: "#ff", // half-typed, invalid
          text: "#1e1b2e",
          heading: "",
          muted: "",
        },
      }),
    );
    expect(vars["--slide-accent"]).toBe("#7c3aed");
    expect(vars["--slide-text"]).toBe("#1e1b2e");
    expect(vars["--slide-surface"]).toBeUndefined();
  });
});

describe("brandCssForExport", () => {
  it("binds only the required vars onto Marp elements for a minimal kit", () => {
    const css = brandCssForExport(kit());

    // :root declares every var brandKitCssVars produced (single source of
    // truth) — here, exactly the three required ones.
    expect(css).toContain(":root {");
    expect(css).toContain("--slide-accent: #7c3aed;");
    expect(css).toContain("--slide-surface: #ffffff;");
    expect(css).toContain("--slide-text: #1e1b2e;");

    // section is always re-skinned with surface + body text colour.
    expect(css).toMatch(
      /section \{\n {2}background-color: var\(--slide-surface\);\n {2}color: var\(--slide-text\);\n\}/,
    );
    // No body font → no font-family binding on section.
    expect(css).not.toContain("font-family: var(--slide-font-body)");

    // No heading colour/font defined → no heading block emitted at all.
    expect(css).not.toContain("section h1,");
    expect(css).not.toContain("color: var(--slide-headline)");

    // Accent always tints links + the title underline (never body copy).
    expect(css).toContain("section a {\n  color: var(--slide-accent);\n}");
    expect(css).toContain(
      "border-bottom: 0.075em solid color-mix(in srgb, var(--slide-accent) 32%, transparent);",
    );

    // No muted → no secondary-text block.
    expect(css).not.toContain("--slide-muted");
    expect(css).not.toContain("section blockquote");
  });

  it("binds heading colour/fonts and muted when the kit defines them", () => {
    const css = brandCssForExport(
      kit({
        colors: {
          accent: "#7c3aed",
          surface: "#ffffff",
          text: "#1e1b2e",
          heading: "#111111",
          muted: "#6b7280",
        },
        headingFont: "serif",
        bodyFont: "inter",
      }),
    );

    // :root carries the conditional vars + resolved curated font stacks.
    expect(css).toContain("--slide-headline: #111111;");
    expect(css).toContain("--slide-muted: #6b7280;");
    expect(css).toContain("--slide-font-headline: ");
    expect(css).toContain("Georgia");
    expect(css).toContain("Inter");

    // Body font binds onto section.
    expect(css).toContain("font-family: var(--slide-font-body);");

    // Heading block binds colour + heading font across h1..h6.
    expect(css).toContain("section h1,");
    expect(css).toContain("section h6 {");
    expect(css).toContain("color: var(--slide-headline);");
    expect(css).toContain("font-family: var(--slide-font-headline);");

    // Muted drives conventional secondary-text elements.
    expect(css).toContain(
      "section blockquote,\nsection figcaption,\nsection small {\n  color: var(--slide-muted);\n}",
    );
  });
});

describe("list ops", () => {
  it("appends new kits and replaces an existing one in place", () => {
    const a = kit({ name: "A" }, "a");
    const b = kit({ name: "B" }, "b");
    let list = upsertBrandKit([], a);
    list = upsertBrandKit(list, b);
    expect(list.map((k) => k.id)).toEqual(["brand-a", "brand-b"]);

    const aRenamed: BrandKit = { ...a, name: "A2" };
    list = upsertBrandKit(list, aRenamed);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("A2"); // kept its slot
  });

  it("drops the oldest kit when a new one overflows the cap", () => {
    let list: BrandKit[] = [];
    for (let i = 0; i < MAX_BRAND_KITS; i++) {
      list = upsertBrandKit(list, kit({ name: `K${i}` }, `k${i}`));
    }
    expect(list).toHaveLength(MAX_BRAND_KITS);
    list = upsertBrandKit(list, kit({ name: "overflow" }, "overflow"));
    expect(list).toHaveLength(MAX_BRAND_KITS);
    expect(list[0].id).toBe("brand-k1"); // brand-k0 evicted
    expect(list[list.length - 1].id).toBe("brand-overflow");
  });

  it("removes + finds by id safely", () => {
    const a = kit({ name: "A" }, "a");
    expect(removeBrandKit([a], "brand-a")).toEqual([]);
    expect(removeBrandKit([a], "missing")).toEqual([a]);
    expect(findBrandKit([a], "brand-a")).toBe(a);
    expect(findBrandKit([a], "missing")).toBeNull();
    expect(findBrandKit([a], undefined)).toBeNull();
  });
});

describe("persistence round-trip", () => {
  it("serialises then parses back to an equivalent list", () => {
    const list = [kit({ name: "A" }, "a"), kit({ name: "B" }, "b")];
    const parsed = parseBrandKitStore(serializeBrandKitStore(list));
    expect(parsed).toEqual(list);
  });

  it("load/save go through localStorage", () => {
    expect(loadBrandKits()).toEqual([]);
    const list = [kit({ name: "A" }, "a")];
    saveBrandKits(list);
    expect(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)).toContain(
      "brand-a",
    );
    expect(loadBrandKits()).toEqual(list);
  });

  it("degrades bad JSON, wrong version, and non-array payloads to null", () => {
    expect(parseBrandKitStore(null)).toBeNull();
    expect(parseBrandKitStore("{not json")).toBeNull();
    expect(
      parseBrandKitStore(JSON.stringify({ version: 999, brandKits: [] })),
    ).toBeNull();
    expect(
      parseBrandKitStore(JSON.stringify({ version: 1, brandKits: "nope" })),
    ).toBeNull();
  });

  it("drops individually-invalid and duplicate-id kits while keeping good ones", () => {
    const good = kit({ name: "Good" }, "good");
    const raw = JSON.stringify({
      version: 1,
      brandKits: [
        good,
        { id: "brand-good", name: "dupe", colors: good.colors }, // duplicate id
        { id: "not-brand", name: "x", colors: good.colors }, // non-brand id
        { id: "brand-bad", name: "", colors: good.colors }, // empty name
        { nonsense: true },
      ],
    });
    const parsed = parseBrandKitStore(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].id).toBe("brand-good");
  });

  it("parseStoredBrandKit rejects a non-brand-namespaced id", () => {
    expect(parseStoredBrandKit({ id: "x", name: "n", colors: {} })).toBeNull();
  });

  it("loadBrandKits never throws on a corrupt store", () => {
    window.localStorage.setItem(BRAND_KITS_STORAGE_KEY, "{broken");
    expect(loadBrandKits()).toEqual([]);
  });
});

describe("coerceBrandKitId + parseSlideContent integration", () => {
  it("keeps a brand-namespaced id and drops anything else", () => {
    expect(coerceBrandKitId("brand-abc")).toBe("brand-abc");
    expect(coerceBrandKitId("custom-abc")).toBeUndefined();
    expect(coerceBrandKitId(undefined)).toBeUndefined();
  });

  it("parseSlideContent carries a structurally-valid brandKitId and degrades others", () => {
    const slides = [
      {
        id: "s1",
        title: "T",
        blocks: [{ id: "b1", type: "text", content: "" }],
      },
    ];
    const withBrand = parseSlideContent(
      JSON.stringify({ slides, themeId: "aurora", brandKitId: "brand-z" }),
    );
    expect(withBrand.brandKitId).toBe("brand-z");

    const foreign = parseSlideContent(
      JSON.stringify({ slides, brandKitId: "not-a-brand" }),
    );
    expect(foreign.brandKitId).toBeUndefined();

    // A legacy deck with no brand kit stays clean.
    const legacy = parseSlideContent(JSON.stringify({ slides }));
    expect(legacy.brandKitId).toBeUndefined();
  });
});
