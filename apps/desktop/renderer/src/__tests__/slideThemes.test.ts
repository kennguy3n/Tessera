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
