import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
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

  it("hides the hero-image UI when no artifactId is supplied", () => {
    // Tests that construct an editor without going through
    // ArtifactEditorPage (which threads the artifact's id down)
    // must not see the Generate-image affordance. This guards
    // against accidentally rendering it in the no-artifact case
    // where `tessera.imagegen.generate` would have nowhere to
    // route the asset.
    render(<LandingPageEditor content="" onSave={() => {}} autoSaveMs={10} />);
    expect(screen.queryByTestId("imagegen-button")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("imagegen-unavailable"),
    ).not.toBeInTheDocument();
  });
});

describe("LandingPageEditor hero image", () => {
  beforeEach(() => {
    // Default mock from setup.ts has imagegen.isAvailable === false.
    // Override per-test where needed.
    vi.spyOn(window.tessera.imagegen, "isAvailable").mockResolvedValue(true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the unavailable banner when imagegen.isAvailable resolves false", async () => {
    vi.spyOn(window.tessera.imagegen, "isAvailable").mockResolvedValue(false);
    render(
      <LandingPageEditor
        content=""
        onSave={() => {}}
        artifactId="landing-001"
        autoSaveMs={10}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("imagegen-unavailable")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("imagegen-button")).not.toBeInTheDocument();
  });

  it("shows the prompt + Generate button when imagegen.isAvailable resolves true", async () => {
    render(
      <LandingPageEditor
        content=""
        onSave={() => {}}
        artifactId="landing-002"
        autoSaveMs={10}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("imagegen-button")).toBeInTheDocument();
    });
    // Prompt is seeded from the default headline.
    expect(
      (screen.getByLabelText("Image prompt") as HTMLTextAreaElement).value,
    ).toContain("Marketing hero image");
  });

  it("persists the generated assetUrl into the JSON on save", async () => {
    const generate = vi
      .spyOn(window.tessera.imagegen, "generate")
      .mockResolvedValue({
        path: "/mock/landing-003/hero.png",
        assetUrl: "tessera-asset://generated-images/landing-003/hero.png",
        seed: 99,
        width: 1536,
        height: 1024,
        durationMs: 8000,
        sizeBytes: 350000,
      });
    const onSave = vi.fn();
    vi.useFakeTimers();
    try {
      render(
        <LandingPageEditor
          content=""
          onSave={onSave}
          artifactId="landing-003"
          autoSaveMs={50}
        />,
      );
      // Wait for isAvailable() to resolve and the button to render.
      await act(async () => {
        await Promise.resolve();
      });
      // Edit the prompt and click Generate.
      fireEvent.change(screen.getByLabelText("Image prompt"), {
        target: { value: "Bright cinematic SaaS hero composition" },
      });
      await act(async () => {
        fireEvent.click(screen.getByLabelText("Generate image"));
        await Promise.resolve();
        await Promise.resolve();
      });
      // Drain the autosave debounce.
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(generate).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Bright cinematic SaaS hero composition",
          artifactId: "landing-003",
        }),
      );
      const lastCall = onSave.mock.calls.at(-1) as [string];
      const saved = JSON.parse(lastCall[0]);
      expect(saved.hero.image).toEqual({
        assetUrl: "tessera-asset://generated-images/landing-003/hero.png",
        prompt: "Bright cinematic SaaS hero composition",
        seed: 99,
        width: 1536,
        height: 1024,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the generated image as a preview and lets the user remove it", async () => {
    const content = JSON.stringify({
      title: "Existing Landing Page",
      hero: {
        headline: "H",
        subheadline: "S",
        image: {
          assetUrl:
            "tessera-asset://generated-images/landing-004/old-hero.png",
          prompt: "Old prompt",
          seed: 3,
          width: 1024,
          height: 1024,
        },
      },
      features: [{ title: "T", description: "D" }],
      stats: [],
      testimonials: [],
      colorScheme: {},
    });
    render(
      <LandingPageEditor
        content={content}
        onSave={() => {}}
        artifactId="landing-004"
        autoSaveMs={10}
      />,
    );
    const preview = await screen.findByTestId("landing-hero-image-preview");
    const img = preview.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "tessera-asset://generated-images/landing-004/old-hero.png",
    );
    // The Generate button is hidden while a hero image exists.
    expect(screen.queryByTestId("imagegen-button")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Remove hero image"));
    // After removing, the Generate UI returns.
    await waitFor(() => {
      expect(screen.getByTestId("imagegen-button")).toBeInTheDocument();
    });
  });

  it("surfaces the bridge error message when generate() rejects", async () => {
    vi.spyOn(window.tessera.imagegen, "generate").mockRejectedValue(
      new Error("Rate limit exceeded"),
    );
    render(
      <LandingPageEditor
        content=""
        onSave={() => {}}
        artifactId="landing-005"
        autoSaveMs={10}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("imagegen-button")).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Image prompt"), {
      target: { value: "Anything" },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Generate image"));
      await Promise.resolve();
      await Promise.resolve();
    });
    const errorBox = await screen.findByTestId("imagegen-error");
    expect(errorBox.textContent).toContain("Rate limit exceeded");
  });

  it("drops a hero image payload whose assetUrl is not tessera-asset://generated-images/", () => {
    const parsed = parseLandingPageContent(
      JSON.stringify({
        title: "X",
        hero: {
          headline: "h",
          subheadline: "s",
          image: {
            assetUrl: "http://evil.example.com/img.png",
            prompt: "x",
            seed: 1,
            width: 1024,
            height: 1024,
          },
        },
        features: [],
        stats: [],
        testimonials: [],
        colorScheme: {},
      }),
    );
    // Hostile scheme is rejected; field is dropped so the renderer
    // falls back to the Generate UI rather than loading the URL.
    expect(parsed.hero.image).toBeUndefined();
  });

  it("renders the hero image as a <figure> in the preview HTML", () => {
    const html = buildLandingPreviewHtml({
      title: "Hero",
      hero: {
        headline: "h",
        subheadline: "s",
        image: {
          assetUrl: "tessera-asset://generated-images/landing-006/h.png",
          prompt: "p",
          seed: 1,
          width: 1024,
          height: 1024,
        },
      },
      features: [],
      stats: [],
      testimonials: [],
      colorScheme: {},
    });
    expect(html).toContain("landing-hero-image");
    expect(html).toContain(
      'src="tessera-asset://generated-images/landing-006/h.png"',
    );
    expect(html).toMatch(/<figure[^>]*landing-hero-image/);
    // Width/height must appear unchanged for the normal numeric
    // case — `escapeHtml(String(1024))` is `"1024"`, so the new
    // belt-and-braces escape wrap added in the PR #38 post-merge
    // follow-up is a no-op for valid inputs and must not regress
    // the dimension contract.
    expect(html).toContain('width="1024"');
    expect(html).toContain('height="1024"');
  });

  it("HTML-escapes width/height in the preview HTML — defends against future type-relaxation injection", () => {
    // Devin Review PR #38 post-merge follow-up: same invariant as
    // `infographicEditor.test.tsx` — `width="..."` and
    // `height="..."` slots in `buildLandingPreviewHtml`'s
    // `<figure>` template now pass through `escapeHtml(String(...))`
    // to pin the consistency invariant that EVERY user-derived
    // interpolation passes through `escapeHtml`. This defends
    // against a future refactor that relaxes the dimension type
    // to accept a string-typed `"100%"` and would otherwise
    // silently open an injection vector.
    const hostileWidth = '1024" onload="alert(1)' as unknown as number;
    const hostileHeight = '1024" onerror="alert(2)' as unknown as number;
    const html = buildLandingPreviewHtml({
      title: "Hero",
      hero: {
        headline: "h",
        subheadline: "s",
        image: {
          assetUrl: "tessera-asset://generated-images/landing-006/h.png",
          prompt: "p",
          seed: 1,
          width: hostileWidth,
          height: hostileHeight,
        },
      },
      features: [],
      stats: [],
      testimonials: [],
      colorScheme: {},
    });
    // Assert the full escaped substring under the exact attribute
    // key so this test specifically pins the width/height escape
    // behaviour — a weaker `toContain("&quot;")` would pass even
    // without the wrap because `escapeHtml(assetUrl)` /
    // `escapeHtml(headline)` already produce `&quot;` elsewhere in
    // the template. Devin Review PR #41 follow-up tightening.
    expect(html).not.toContain('onload="alert(1)');
    expect(html).not.toContain('onerror="alert(2)');
    expect(html).toContain('width="1024&quot; onload=&quot;alert(1)"');
    expect(html).toContain('height="1024&quot; onerror=&quot;alert(2)"');
  });
});
