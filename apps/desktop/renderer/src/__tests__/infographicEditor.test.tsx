import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
} from "@testing-library/react";
import InfographicEditor, {
  buildPreviewHtml,
  parseInfographicContent,
} from "../editors/InfographicEditor";

describe("parseInfographicContent", () => {
  it("returns default content for empty input", () => {
    const parsed = parseInfographicContent("");
    expect(parsed.title).toBe("Untitled Infographic");
    expect(parsed.layout).toBe("vertical");
    expect(parsed.sections.length).toBeGreaterThan(0);
    expect(parsed.colorScheme.primary).toBe("#7C3AED");
  });

  it("returns default content for invalid JSON", () => {
    const parsed = parseInfographicContent("not json {{{");
    expect(parsed.title).toBe("Untitled Infographic");
  });

  it("round-trips serialized content", () => {
    const orig = parseInfographicContent("");
    const json = JSON.stringify(orig);
    const reparsed = parseInfographicContent(json);
    expect(reparsed).toEqual(orig);
  });

  it("preserves custom layout and colors", () => {
    const json = JSON.stringify({
      title: "My Infographic",
      layout: "grid",
      colorScheme: { primary: "#FF0000", secondary: "#00FF00", accent: "#0000FF" },
      sections: [{ heading: "A", body: "B" }],
    });
    const parsed = parseInfographicContent(json);
    expect(parsed.layout).toBe("grid");
    expect(parsed.colorScheme.primary).toBe("#FF0000");
    expect(parsed.title).toBe("My Infographic");
    expect(parsed.sections).toHaveLength(1);
  });
});

describe("buildPreviewHtml", () => {
  it("emits an <h1> for the title and a section per entry", () => {
    const html = buildPreviewHtml({
      title: "Top Metrics",
      subtitle: "Q3",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED", secondary: "#0EA5E9", accent: "#F59E0B" },
      sections: [
        { heading: "Revenue", body: "Up 15%", stat: "15%", statLabel: "QoQ" },
        { heading: "Users", body: "10k MAU" },
      ],
    });
    expect(html).toContain("<h1>Top Metrics</h1>");
    expect(html).toContain("Revenue");
    expect(html).toContain("Users");
    expect(html).toContain("Q3");
    expect(html).toContain("infographic-preview-vertical");
    expect(html).toContain("15%");
  });

  it("escapes HTML in user content", () => {
    const html = buildPreviewHtml({
      title: "<script>alert(1)</script>",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "X", body: "X" }],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("inlines icons via embedIcons", () => {
    const html = buildPreviewHtml({
      title: "T",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ icon: "lucide:check", heading: "Done", body: "" }],
    });
    // embedIcons replaces {{icon:...}} tokens with inline <svg>
    expect(html).not.toContain("{{icon:");
    expect(html).toMatch(/<svg/);
  });

  it("drops malformed icon specs instead of letting them break out of the token", () => {
    // containing `}}` would close the `{{icon:...}}` token prematurely and
    // let arbitrary trailing text (including `<script>`) reach the DOM.
    const html = buildPreviewHtml({
      title: "T",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [
        {
          icon: "lucide:check}}<script>alert(1)</script>{{icon:x",
          heading: "Bad",
          body: "",
        },
      ],
    });
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("{{icon:");
  });

  it("falls back to a safe layout class when `layout` is not allowlisted", () => {
    // value is interpolated into a class attribute; a value like
    // `vertical" onclick="alert(1)` would break out of the attribute.
    // The fix is to (a) constrain `layout` to the allowlist on parse, and
    // (b) defence-in-depth re-check inside `buildPreviewHtml`. This test
    // bypasses parse and supplies a hostile layout directly to the HTML
    // builder to assert the second layer holds.
    const html = buildPreviewHtml({
      title: "T",
      // Cast through unknown so TS doesn't reject the hostile literal —
      // we're simulating data that bypassed the parse-time allowlist.
      layout: 'vertical" onclick="alert(1)' as unknown as "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "X", body: "X" }],
    });
    // The breakout fragment must NOT survive — the layout falls back to the
    // safe `vertical` class.
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain('class="infographic infographic-preview-vertical"');
  });
});

describe("parseInfographicContent layout allowlist", () => {
  it("rejects unknown layout values and falls back to vertical", () => {
    const json = JSON.stringify({
      title: "X",
      layout: 'vertical" onclick="alert(1)',
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "A", body: "B" }],
    });
    const parsed = parseInfographicContent(json);
    expect(parsed.layout).toBe("vertical");
  });

  it("accepts each allowlisted layout value verbatim", () => {
    for (const layout of ["vertical", "horizontal", "grid"] as const) {
      const json = JSON.stringify({
        title: "X",
        layout,
        colorScheme: { primary: "#7C3AED" },
        sections: [{ heading: "A", body: "B" }],
      });
      expect(parseInfographicContent(json).layout).toBe(layout);
    }
  });
});

describe("InfographicEditor", () => {
  it("renders the title input and a section card", () => {
    render(<InfographicEditor content="" onSave={() => {}} autoSaveMs={10} />);
    expect(
      screen.getByLabelText("Infographic title"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Section 1 heading")).toBeInTheDocument();
  });

  it("calls onSave after the debounce when the user types", () => {
    vi.useFakeTimers();
    const onSave = vi.fn();
    try {
      render(
        <InfographicEditor content="" onSave={onSave} autoSaveMs={50} />,
      );
      fireEvent.change(screen.getByLabelText("Infographic title"), {
        target: { value: "New Title" },
      });
      act(() => {
        vi.advanceTimersByTime(60);
      });
      expect(onSave).toHaveBeenCalled();
      const saved = JSON.parse(
        (onSave.mock.calls[onSave.mock.calls.length - 1] as [string])[0],
      );
      expect(saved.title).toBe("New Title");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a new section when the user clicks 'Add section'", () => {
    render(<InfographicEditor content="" onSave={() => {}} autoSaveMs={10} />);
    expect(screen.getByLabelText("Section 1 heading")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Add section"));
    expect(screen.getByLabelText("Section 2 heading")).toBeInTheDocument();
  });

  it("hides the hero-image UI when no artifactId is supplied", () => {
    // Tests that construct an editor without going through
    // ArtifactEditorPage must not see the Generate-image affordance.
    render(<InfographicEditor content="" onSave={() => {}} autoSaveMs={10} />);
    expect(screen.queryByTestId("imagegen-button")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("imagegen-unavailable"),
    ).not.toBeInTheDocument();
  });
});

describe("InfographicEditor hero image", () => {
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
      <InfographicEditor
        content=""
        onSave={() => {}}
        artifactId="artifact-001"
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
      <InfographicEditor
        content=""
        onSave={() => {}}
        artifactId="artifact-002"
        autoSaveMs={10}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("imagegen-button")).toBeInTheDocument();
    });
    // Prompt is seeded from the default title.
    expect(
      (screen.getByLabelText("Image prompt") as HTMLTextAreaElement).value,
    ).toContain("Untitled Infographic");
  });

  it("persists the generated assetUrl into the JSON on save", async () => {
    const generate = vi
      .spyOn(window.tessera.imagegen, "generate")
      .mockResolvedValue({
        path: "/mock/artifact-003/hero.png",
        assetUrl: "tessera-asset://generated-images/artifact-003/hero.png",
        seed: 42,
        width: 1024,
        height: 1024,
        durationMs: 12345,
        sizeBytes: 220000,
      });
    const onSave = vi.fn();
    vi.useFakeTimers();
    try {
      render(
        <InfographicEditor
          content=""
          onSave={onSave}
          artifactId="artifact-003"
          autoSaveMs={50}
        />,
      );
      // Wait for isAvailable() to resolve and the button to render.
      // The promise was queued before fake timers kicked in, so a
      // microtask flush brings the component up.
      await act(async () => {
        await Promise.resolve();
      });
      // Edit the prompt and click Generate.
      fireEvent.change(screen.getByLabelText("Image prompt"), {
        target: { value: "Vibrant abstract gradient" },
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
          prompt: "Vibrant abstract gradient",
          artifactId: "artifact-003",
          width: 1024,
          height: 1024,
        }),
      );
      // The latest persisted JSON must include the heroImage payload
      // with the bridge-returned assetUrl, seed, and dimensions.
      const lastCall = onSave.mock.calls.at(-1) as [string];
      const saved = JSON.parse(lastCall[0]);
      expect(saved.heroImage).toEqual({
        assetUrl: "tessera-asset://generated-images/artifact-003/hero.png",
        prompt: "Vibrant abstract gradient",
        seed: 42,
        width: 1024,
        height: 1024,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the generated image as a preview and lets the user remove it", async () => {
    const content = JSON.stringify({
      title: "Existing Infographic",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "S", body: "B" }],
      heroImage: {
        assetUrl:
          "tessera-asset://generated-images/artifact-004/old-hero.png",
        prompt: "Old prompt",
        seed: 7,
        width: 1024,
        height: 1024,
      },
    });
    render(
      <InfographicEditor
        content={content}
        onSave={() => {}}
        artifactId="artifact-004"
        autoSaveMs={10}
      />,
    );
    const preview = await screen.findByTestId(
      "infographic-hero-image-preview",
    );
    const img = preview.querySelector("img");
    expect(img?.getAttribute("src")).toBe(
      "tessera-asset://generated-images/artifact-004/old-hero.png",
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
      <InfographicEditor
        content=""
        onSave={() => {}}
        artifactId="artifact-005"
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
    const parsed = parseInfographicContent(
      JSON.stringify({
        title: "X",
        layout: "vertical",
        colorScheme: { primary: "#7C3AED" },
        sections: [{ heading: "A", body: "B" }],
        heroImage: {
          assetUrl: "http://evil.example.com/img.png",
          prompt: "x",
          seed: 1,
          width: 1024,
          height: 1024,
        },
      }),
    );
    // Hostile scheme is rejected; field is dropped so the renderer
    // falls back to the Generate UI rather than loading the URL.
    expect(parsed.heroImage).toBeUndefined();
  });

  it("renders the hero image as a <figure> in the preview HTML", () => {
    const html = buildPreviewHtml({
      title: "Hero",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "A", body: "B" }],
      heroImage: {
        assetUrl: "tessera-asset://generated-images/artifact-006/h.png",
        prompt: "p",
        seed: 1,
        width: 1024,
        height: 1024,
      },
    });
    expect(html).toContain("infographic-hero");
    expect(html).toContain(
      'src="tessera-asset://generated-images/artifact-006/h.png"',
    );
    // Width/height must appear unchanged for the normal numeric
    // case — `escapeHtml(String(1024))` is `"1024"`, so the new
    // belt-and-braces escape wrap added in the PR #38 post-merge
    // follow-up is a no-op for valid inputs and must not regress
    // the dimension contract that sizes the `<img>` slot in the
    // export HTML.
    expect(html).toContain('width="1024"');
    expect(html).toContain('height="1024"');
  });

  it("HTML-escapes width/height in the preview HTML — defends against future type-relaxation injection", () => {
    // Devin Review PR #38 post-merge follow-up: the `width="..."`
    // and `height="..."` slots inside `<img>` were the only
    // user-derived interpolations in `buildPreviewHtml`'s
    // `<figure>` template that did NOT pass through `escapeHtml`.
    // `sanitizeHeroImage` validates them as finite positive
    // integers today (so `Number(n).toString()` is digits-only),
    // but the consistency with every other interpolation in the
    // same template string is what defends against a future
    // refactor that relaxes the type to accept a string-typed
    // `"100%"`-style dimension. This regression test pins the
    // invariant programmatically by passing a hostile string
    // through the `as unknown as number` escape hatch — the
    // sanitizer-validated runtime type is `number`, but the
    // template builder MUST still escape the value before
    // interpolation.
    const hostileWidth = '1024" onload="alert(1)' as unknown as number;
    const hostileHeight = '1024" onerror="alert(2)' as unknown as number;
    const html = buildPreviewHtml({
      title: "Hero",
      layout: "vertical",
      colorScheme: { primary: "#7C3AED" },
      sections: [{ heading: "A", body: "B" }],
      heroImage: {
        assetUrl: "tessera-asset://generated-images/artifact-006/h.png",
        prompt: "p",
        seed: 1,
        width: hostileWidth,
        height: hostileHeight,
      },
    });
    // The hostile quote+attribute injection must be HTML-escaped:
    // the raw `onload="alert(1)` / `onerror="alert(2)` sequence must
    // NOT appear in the output, and the escaped form must be
    // confined INSIDE the `width="..."` / `height="..."` attribute
    // slot (i.e. the closing `"` after the hostile payload is the
    // attribute terminator, not an attacker-controlled one). Assert
    // the full escaped substring under the exact attribute key so
    // this test specifically pins the width/height escape
    // behaviour — a weaker `toContain("&quot;")` would pass even
    // without the wrap because `escapeHtml(assetUrl)` and
    // `escapeHtml(title)` already produce `&quot;` elsewhere in
    // the template. Devin Review PR #41 follow-up tightening.
    expect(html).not.toContain('onload="alert(1)');
    expect(html).not.toContain('onerror="alert(2)');
    expect(html).toContain('width="1024&quot; onload=&quot;alert(1)"');
    expect(html).toContain('height="1024&quot; onerror=&quot;alert(2)"');
  });
});
