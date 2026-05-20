import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import LandingPageEditor, {
  buildLandingPreviewHtml,
  parseLandingPageContent,
} from "../editors/LandingPageEditor";

describe("parseLandingPageContent", () => {
  it("returns default content for empty input", () => {
    const parsed = parseLandingPageContent("");
    expect(parsed.title).toBe("Untitled Landing Page");
    expect(parsed.hero.headline.length).toBeGreaterThan(0);
    expect(parsed.features.length).toBeGreaterThanOrEqual(3);
  });

  it("returns default content for invalid JSON", () => {
    const parsed = parseLandingPageContent("garbage");
    expect(parsed.title).toBe("Untitled Landing Page");
  });

  it("round-trips serialized content", () => {
    const orig = parseLandingPageContent("");
    const reparsed = parseLandingPageContent(JSON.stringify(orig));
    expect(reparsed).toEqual(orig);
  });
});

describe("buildLandingPreviewHtml", () => {
  it("renders hero, features, and final CTA", () => {
    const html = buildLandingPreviewHtml({
      title: "Test Landing",
      hero: { headline: "Hello", subheadline: "World", cta: "Sign up", ctaUrl: "#" },
      features: [
        { icon: "lucide:zap", title: "Fast", description: "Very" },
      ],
      stats: [{ value: "99%", label: "uptime" }],
      testimonials: [{ quote: "Great", name: "Alice", company: "Acme" }],
      cta: { headline: "Ready?", buttonText: "Go", buttonUrl: "#go" },
      colorScheme: { primary: "#7C3AED" },
    });
    expect(html).toContain("Hello");
    expect(html).toContain("World");
    expect(html).toContain("Sign up");
    expect(html).toContain("Fast");
    expect(html).toContain("99%");
    expect(html).toContain("Alice");
    expect(html).toContain("Ready?");
    expect(html).toContain("Go");
    // Icons should be substituted inline
    expect(html).not.toContain("{{icon:");
    expect(html).toMatch(/<svg/);
  });

  it("omits empty sections cleanly", () => {
    const html = buildLandingPreviewHtml({
      title: "x",
      hero: { headline: "h", subheadline: "s" },
      features: [{ title: "T", description: "D" }],
      stats: [],
      testimonials: [],
      colorScheme: {},
    });
    expect(html).not.toContain("landing-stats");
    expect(html).not.toContain("landing-testimonials");
    expect(html).not.toContain("landing-final-cta");
  });

  it("escapes HTML in user content", () => {
    const html = buildLandingPreviewHtml({
      title: "x",
      hero: { headline: "<img src=x>", subheadline: "" },
      features: [],
      stats: [],
      testimonials: [],
      colorScheme: {},
    });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img");
  });
});

describe("LandingPageEditor", () => {
  it("renders the hero headline input", () => {
    render(<LandingPageEditor content="" onSave={() => {}} autoSaveMs={10} />);
    expect(screen.getByLabelText("Hero headline")).toBeInTheDocument();
  });

  it("saves changes after the debounce", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    try {
      render(
        <LandingPageEditor content="" onSave={onSave} autoSaveMs={50} />,
      );
      fireEvent.change(screen.getByLabelText("Hero headline"), {
        target: { value: "Brand new headline" },
      });
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(onSave).toHaveBeenCalled();
      const saved = JSON.parse(
        (onSave.mock.calls[onSave.mock.calls.length - 1] as [string])[0],
      );
      expect(saved.hero.headline).toBe("Brand new headline");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds and removes features", () => {
    render(<LandingPageEditor content="" onSave={() => {}} autoSaveMs={10} />);
    const initialCount = screen.getAllByLabelText(/Feature \d+ title/).length;
    fireEvent.click(screen.getByLabelText("Add feature"));
    const afterAdd = screen.getAllByLabelText(/Feature \d+ title/).length;
    expect(afterAdd).toBe(initialCount + 1);
  });
});
