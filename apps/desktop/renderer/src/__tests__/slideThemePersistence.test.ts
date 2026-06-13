import { describe, expect, it } from "vitest";
import { parseSlideContent } from "../editors/slideEditorHelpers";
import { DEFAULT_SLIDE_THEME_ID, SLIDE_THEMES } from "../editors/slideThemes";
import type { SlideContent } from "../editors/slideEditorTypes";

const A_NON_DEFAULT_THEME = SLIDE_THEMES.find(
  (t) => t.id !== DEFAULT_SLIDE_THEME_ID,
)!.id;

describe("parseSlideContent themeId handling", () => {
  it("round-trips a persisted, known theme id", () => {
    const content: SlideContent = {
      slides: [{ id: "s1", title: "A", blocks: [], notes: "" }],
      themeId: A_NON_DEFAULT_THEME,
    };
    const parsed = parseSlideContent(JSON.stringify(content));
    expect(parsed.themeId).toBe(A_NON_DEFAULT_THEME);
  });

  it("defaults a legacy deck without a themeId to the default", () => {
    const legacy = {
      slides: [{ id: "s1", title: "A", blocks: [], notes: "" }],
    };
    const parsed = parseSlideContent(JSON.stringify(legacy));
    expect(parsed.themeId).toBe(DEFAULT_SLIDE_THEME_ID);
  });

  it("coerces a hand-edited unknown themeId to the default", () => {
    const content = {
      slides: [{ id: "s1", title: "A", blocks: [], notes: "" }],
      themeId: "totally-made-up",
    };
    const parsed = parseSlideContent(JSON.stringify(content));
    expect(parsed.themeId).toBe(DEFAULT_SLIDE_THEME_ID);
  });

  it("defaults the empty / unparseable cases to the default theme", () => {
    expect(parseSlideContent("").themeId).toBe(DEFAULT_SLIDE_THEME_ID);
    expect(parseSlideContent("not json at all").themeId).toBe(
      DEFAULT_SLIDE_THEME_ID,
    );
  });

  it("always resolves to a known catalogue id (never null/undefined)", () => {
    const knownIds = new Set(SLIDE_THEMES.map((t) => t.id));
    for (const raw of ["", "{}", '{"themeId": 42}', '{"themeId": null}']) {
      expect(knownIds.has(parseSlideContent(raw).themeId)).toBe(true);
    }
  });
});
