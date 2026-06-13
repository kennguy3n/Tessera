import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLIDE_THEME_ID,
  SLIDE_THEMES,
  getSlideTheme,
  isKnownSlideThemeId,
  marpThemeForSlideTheme,
} from "../editors/slideThemes";
import { resolveThemeId } from "../editors/slideEditorHelpers";

describe("slideThemes catalogue", () => {
  it("exposes a non-empty, id-unique catalogue", () => {
    expect(SLIDE_THEMES.length).toBeGreaterThan(0);
    const ids = SLIDE_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps every theme onto a real Marp built-in theme", () => {
    const valid = new Set(["default", "gaia", "uncover"]);
    for (const theme of SLIDE_THEMES) {
      expect(valid.has(theme.marpTheme)).toBe(true);
    }
  });

  it("uses the first catalogue entry as the default", () => {
    expect(DEFAULT_SLIDE_THEME_ID).toBe(SLIDE_THEMES[0].id);
  });
});

describe("isKnownSlideThemeId", () => {
  it("returns true for every catalogue id", () => {
    for (const theme of SLIDE_THEMES) {
      expect(isKnownSlideThemeId(theme.id)).toBe(true);
    }
  });

  it("returns false for unknown / nullish ids", () => {
    expect(isKnownSlideThemeId("nope")).toBe(false);
    expect(isKnownSlideThemeId("")).toBe(false);
    expect(isKnownSlideThemeId(null)).toBe(false);
    expect(isKnownSlideThemeId(undefined)).toBe(false);
  });
});

describe("getSlideTheme", () => {
  it("returns the matching theme for a known id", () => {
    const theme = SLIDE_THEMES[SLIDE_THEMES.length - 1];
    expect(getSlideTheme(theme.id)).toEqual(theme);
  });

  it("falls back to the default for unknown / nullish ids", () => {
    expect(getSlideTheme("nope").id).toBe(DEFAULT_SLIDE_THEME_ID);
    expect(getSlideTheme(null).id).toBe(DEFAULT_SLIDE_THEME_ID);
    expect(getSlideTheme(undefined).id).toBe(DEFAULT_SLIDE_THEME_ID);
  });
});

describe("marpThemeForSlideTheme", () => {
  it("returns the mapped Marp theme for a known id", () => {
    for (const theme of SLIDE_THEMES) {
      expect(marpThemeForSlideTheme(theme.id)).toBe(theme.marpTheme);
    }
  });

  it("returns the default theme's Marp mapping for unknown ids", () => {
    expect(marpThemeForSlideTheme("nope")).toBe(
      getSlideTheme(DEFAULT_SLIDE_THEME_ID).marpTheme,
    );
  });
});

describe("resolveThemeId", () => {
  it("passes through a known id unchanged", () => {
    const id = SLIDE_THEMES[1].id;
    expect(resolveThemeId(id)).toBe(id);
  });

  it("coerces unknown / nullish ids to the default", () => {
    expect(resolveThemeId("nope")).toBe(DEFAULT_SLIDE_THEME_ID);
    expect(resolveThemeId(null)).toBe(DEFAULT_SLIDE_THEME_ID);
    expect(resolveThemeId(undefined)).toBe(DEFAULT_SLIDE_THEME_ID);
  });
});

describe("Phase 2: extended theme properties", () => {
  it("includes all 10 curated themes", () => {
    expect(SLIDE_THEMES.length).toBe(10);
    const ids = SLIDE_THEMES.map((t) => t.id);
    expect(ids).toContain("aurora");
    expect(ids).toContain("editorial");
    expect(ids).toContain("noir");
    expect(ids).toContain("mint");
    expect(ids).toContain("solar");
    expect(ids).toContain("slate");
    expect(ids).toContain("rosewood");
    expect(ids).toContain("ocean");
    expect(ids).toContain("forest");
    expect(ids).toContain("lavender");
  });

  it("every theme has a swatch colour", () => {
    for (const theme of SLIDE_THEMES) {
      expect(theme.swatch).toBeTruthy();
      expect(theme.swatch).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("themes with bgStyle use a valid style", () => {
    const valid = new Set(["solid", "gradient", "mesh", "dots", "lines"]);
    for (const theme of SLIDE_THEMES) {
      if (theme.bgStyle) {
        expect(valid.has(theme.bgStyle)).toBe(true);
      }
    }
  });

  it("themes with headingWeight use a valid weight", () => {
    for (const theme of SLIDE_THEMES) {
      if (theme.headingWeight != null) {
        expect(theme.headingWeight).toBeGreaterThanOrEqual(100);
        expect(theme.headingWeight).toBeLessThanOrEqual(900);
      }
    }
  });

  it("new themes are known to the catalogue", () => {
    expect(isKnownSlideThemeId("rosewood")).toBe(true);
    expect(isKnownSlideThemeId("ocean")).toBe(true);
    expect(isKnownSlideThemeId("forest")).toBe(true);
    expect(isKnownSlideThemeId("lavender")).toBe(true);
  });
});
