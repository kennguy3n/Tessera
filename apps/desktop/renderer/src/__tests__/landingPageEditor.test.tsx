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

  it("neutralises javascript: URLs in hero and final-CTA hrefs", () => {
    // Regression for Devin Review ANALYSIS_pr-review-job-157bbcc3...-0004.
    // The JSON is editable so a user-authored `javascript:` scheme must not
    // produce an executable `href` in either the preview or any exported
    // HTML. `escapeHtml` alone does not strip URL schemes — the editor must
    // route every href through `sanitizeUrl`, which falls back to `#`.
    const html = buildLandingPreviewHtml({
      title: "x",
      hero: {
        headline: "h",
        subheadline: "s",
        cta: "Click me",
        ctaUrl: "javascript:alert(document.cookie)",
      },
      features: [],
      stats: [],
      testimonials: [],
      cta: {
        headline: "Final",
        buttonText: "Go",
        buttonUrl: " JavaScript:alert(1)",
      },
      colorScheme: {},
    });
    expect(html).not.toMatch(/href="javascript:/i);
    expect(html).not.toContain("alert");
    // Both hrefs should have been neutralised to "#".
    const heroHrefMatches = html.match(/landing-hero-cta" href="([^"]*)"/);
    expect(heroHrefMatches?.[1]).toBe("#");
    const finalHrefMatches = html.match(/landing-final-cta-button" href="([^"]*)"/);
    expect(finalHrefMatches?.[1]).toBe("#");
  });

  it("preserves safe URL schemes (http, https, mailto, anchors, paths)", () => {
    const html = buildLandingPreviewHtml({
      title: "x",
      hero: {
        headline: "h",
        subheadline: "s",
        cta: "A",
        ctaUrl: "https://example.com/signup",
      },
      features: [],
      stats: [],
      testimonials: [],
      cta: {
        headline: "Final",
        buttonText: "B",
        buttonUrl: "mailto:hi@example.com",
      },
      colorScheme: {},
    });
    expect(html).toContain('href="https://example.com/signup"');
    expect(html).toContain('href="mailto:hi@example.com"');
  });

  it("drops malformed feature icon specs instead of letting them break out of the token", () => {
    // Regression for Devin Review ANALYSIS_pr-review-job-...-0001 — mirror
    // of the InfographicEditor test. A spec containing `}}` would otherwise
    // let arbitrary trailing text (including `<script>`) reach the DOM.
    const html = buildLandingPreviewHtml({
      title: "x",
      hero: { headline: "h", subheadline: "s" },
      features: [
        {
          icon: "lucide:zap}}<script>alert(1)</script>{{icon:x",
          title: "Bad",
          description: "Bad",
        },
      ],
      stats: [],
      testimonials: [],
      colorScheme: {},
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("{{icon:");
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
