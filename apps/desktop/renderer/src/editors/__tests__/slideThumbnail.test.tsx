/**
 * Render tests for the gallery's read-only SlideThumbnail.
 *
 * These assert the thumbnail renders the *themed slide surface* (so all
 * the `[data-slide-theme]` / `[data-slide-layout]` CSS applies) and that
 * every catalogue template's first slide renders without throwing — the
 * gallery shows one of these per card.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { SlideThumbnail } from "../components/SlideThumbnail";
import { SLIDE_TEMPLATES } from "../slideTemplates";
import { DEFAULT_SLIDE_THEME_ID } from "../slideThemes";

afterEach(() => {
  cleanup();
});

describe("SlideThumbnail", () => {
  it("renders the themed slide surface with theme + layout attributes", () => {
    const template = SLIDE_TEMPLATES[0]; // pitch
    const themeId = template.suggestedTheme ?? DEFAULT_SLIDE_THEME_ID;
    const { container } = render(
      <SlideThumbnail slide={template.slides[0]} themeId={themeId} />,
    );

    const canvas = container.querySelector(".slide-thumb-canvas");
    expect(canvas).not.toBeNull();
    expect(canvas?.getAttribute("data-slide-theme")).toBe(themeId);
    expect(canvas?.getAttribute("data-slide-layout")).toBe(
      template.slides[0].layout,
    );
  });

  it("is decorative (aria-hidden) so the card owns the accessible name", () => {
    const template = SLIDE_TEMPLATES[0];
    const { container } = render(
      <SlideThumbnail slide={template.slides[0]} themeId="aurora" />,
    );
    const frame = container.querySelector(".slide-thumb-frame");
    expect(frame?.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders the slide title text", () => {
    const template = SLIDE_TEMPLATES[0];
    const first = template.slides[0];
    const { container } = render(
      <SlideThumbnail slide={first} themeId="aurora" />,
    );
    expect(container.textContent).toContain(first.title);
  });

  it("renders bullets as a real list", () => {
    const bulletSlide = {
      layout: "titleContent" as const,
      title: "Agenda",
      blocks: [
        {
          type: "bullets" as const,
          content: "First item\nSecond item\nThird item",
        },
      ],
    };
    const { container } = render(
      <SlideThumbnail slide={bulletSlide} themeId="aurora" />,
    );
    const list = container.querySelector(".slide-thumb-bullets");
    expect(list).not.toBeNull();
    expect(list?.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders the first slide of every catalogue template without throwing", () => {
    for (const template of SLIDE_TEMPLATES) {
      const themeId = template.suggestedTheme ?? DEFAULT_SLIDE_THEME_ID;
      expect(() => {
        const { unmount } = render(
          <SlideThumbnail slide={template.slides[0]} themeId={themeId} />,
        );
        unmount();
      }).not.toThrow();
    }
  });
});
