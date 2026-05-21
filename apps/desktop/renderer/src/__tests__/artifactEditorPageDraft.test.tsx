import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ArtifactEditorPage from "../pages/ArtifactEditorPage";

const SHEET_INITIAL = JSON.stringify({
  columns: ["Col"],
  rows: [["original"]],
});

const baseArtifact = {
  id: "art-draft",
  title: "Draft Test",
  artifactType: "sheet" as const,
  templateId: null,
  content: SHEET_INITIAL,
  citationCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 1,
};

// Sheet content that includes an UNRESOLVABLE icon token. The `lucide:does-not-exist`
// is intentionally not a real icon name — `embedIcons` will pass the content
// through unchanged, so the icon branch of `handleExport` produces no override.
// This is the exact precondition for the BUG_pr-review-job-f080f66818c644baa7573bf023ef2675_0001
// regression: with the previous if/else-if, the draft-vs-persisted fallback
// would never run for icon-aware formats whose tokens all fail to resolve.
const SHEET_WITH_UNRESOLVABLE_ICON = JSON.stringify({
  columns: ["Col"],
  rows: [["original {{icon:lucide:does-not-exist}}"]],
});

const artifactWithUnresolvableIcon = {
  ...baseArtifact,
  id: "art-icon-draft",
  content: SHEET_WITH_UNRESOLVABLE_ICON,
};

describe("ArtifactEditorPage live-draft export", () => {
  beforeEach(() => {
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(baseArtifact);
    window.tessera.artifacts.exportArtifact = vi.fn().mockResolvedValue({
      // CSV is a sheet-appropriate non-icon-aware format. Markdown was
      // intentionally removed from sheet exports because rendering a
      // `{columns, rows}` JSON as markdown was nonsensical (see
      // `availableExportFormats` in ArtifactEditorPage).
      format: "csv",
      content: "x",
    });
    window.tessera.artifacts.update = vi.fn().mockResolvedValue(baseArtifact);
    // jsdom doesn't implement clipboard; stub it.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      writable: true,
      configurable: true,
    });
  });

  it("exports the live draft content (not the last-persisted artifact) when the user edits then immediately exports", async () => {
    render(
      <MemoryRouter initialEntries={["/artifact/art-draft"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for the sheet editor to render the initial cell value.
    await waitFor(() => {
      expect(screen.getByText("original")).toBeInTheDocument();
    });

    // Trigger an edit: double-click the cell, type a new value, blur.
    fireEvent.doubleClick(screen.getByText("original"));
    const inputs = await screen.findAllByDisplayValue("original");
    fireEvent.change(inputs[0], { target: { value: "edited-live" } });
    fireEvent.blur(inputs[0]);

    // Immediately export as CSV (a sheet-appropriate non-icon-aware
    // format — no debounce wait, which is the bug scenario the fix
    // targets).
    const exportSelect = screen.getByLabelText("Export artifact") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "csv" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportArtifact).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportArtifact as unknown as {
      mock: { calls: unknown[][] };
    };
    const call = mockFn.mock.calls[0];
    // Args: (id, format, contentOverride)
    const contentOverride = call[2] as string | null;
    expect(contentOverride).not.toBeNull();
    expect(contentOverride).toContain("edited-live");
    expect(contentOverride).not.toContain("original");
  });

  it("propagates the saved Marp theme through PPTX export even when Marp Mode is OFF (regression for ANALYSIS_pr-review-job-3c40496bade1479cab1f5fa0a18d503c_0002)", async () => {
    // Slide artifact whose persisted content carries `marp.theme: gaia` but
    // has `marp.enabled = false` (the WYSIWYG path that synthesises Marp
    // markdown rather than handing through user-authored Marp source).
    const slideArtifact = {
      ...baseArtifact,
      id: "art-slide-theme",
      artifactType: "slides" as const,
      content: JSON.stringify({
        slides: [
          {
            title: "Cover",
            blocks: [{ type: "text", content: "hello" }],
            notes: "",
          },
        ],
        marp: {
          enabled: false,
          source: "",
          theme: "gaia",
        },
      }),
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(slideArtifact);
    window.tessera.artifacts.exportMarp = vi
      .fn()
      .mockResolvedValue("/tmp/Cover.pptx");

    render(
      <MemoryRouter initialEntries={["/artifact/art-slide-theme"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for the slide editor to mount so the export select is present.
    const exportSelect = await waitFor(() => {
      const el = screen.queryByLabelText("Export artifact");
      if (!el) throw new Error("export select not mounted yet");
      return el as HTMLSelectElement;
    });
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "pptx" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportMarp).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportMarp as unknown as {
      mock: { calls: Array<[{ markdown: string; theme?: string }]> };
    };
    const arg = mockFn.mock.calls[0][0];
    // The Marp CLI receives `--theme gaia` via the IPC argument …
    expect(arg.theme).toBe("gaia");
    // … AND the synthesised Marp Markdown front-matter must also carry
    // `theme: 'gaia'` so it stays consistent if the CLI ever stops overriding
    // the front-matter (defence in depth, not just an aesthetic alignment).
    // The scalar is YAML single-quoted by `slidesToMarpMarkdown` to neutralise
    // newline-based directive injection — see utils/yaml.ts.
    expect(arg.markdown).toContain("theme: 'gaia'");
    expect(arg.markdown).not.toContain("theme: 'default'");
  });

  it("falls back to 'default' for BOTH the front-matter and the CLI flag when the artifact has no saved Marp theme (regression for ANALYSIS_pr-review-job-b7cedd18ee6c4395b90418917f949569_0004)", async () => {
    // Slide artifact whose persisted content has no `marp` block at all
    // (e.g. authored before Marp support was added) — `parsed.marpTheme`
    // resolves to `undefined`. Previously the IPC argument and the
    // synthesised front-matter defaulted independently in two different
    // places; this test pins them to a single shared default so the two
    // sides cannot drift again.
    const slideArtifact = {
      ...baseArtifact,
      id: "art-slide-no-theme",
      artifactType: "slides" as const,
      content: JSON.stringify({
        slides: [
          {
            title: "Cover",
            blocks: [{ type: "text", content: "hello" }],
            notes: "",
          },
        ],
        // intentionally omit `marp` to model a pre-Marp artifact
      }),
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(slideArtifact);
    window.tessera.artifacts.exportMarp = vi
      .fn()
      .mockResolvedValue("/tmp/Cover.pptx");

    render(
      <MemoryRouter initialEntries={["/artifact/art-slide-no-theme"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const exportSelect = await waitFor(() => {
      const el = screen.queryByLabelText("Export artifact");
      if (!el) throw new Error("export select not mounted yet");
      return el as HTMLSelectElement;
    });
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "pptx" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportMarp).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportMarp as unknown as {
      mock: { calls: Array<[{ markdown: string; theme?: string }]> };
    };
    const arg = mockFn.mock.calls[0][0];
    expect(arg.theme).toBe("default");
    expect(arg.markdown).toContain("theme: 'default'");
  });

  it("exports the live draft when icon-aware format has only unresolvable icon tokens (regression for BUG_pr-review-job-f080f66818c644baa7573bf023ef2675_0001)", async () => {
    // Override the default mocks for this test to use the icon-laden fixture.
    window.tessera.artifacts.get = vi
      .fn()
      .mockResolvedValue(artifactWithUnresolvableIcon);

    render(
      <MemoryRouter initialEntries={["/artifact/art-icon-draft"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for the sheet editor — the cell text contains the unresolvable token.
    await waitFor(() => {
      expect(
        screen.getByText(/original \{\{icon:lucide:does-not-exist\}\}/),
      ).toBeInTheDocument();
    });

    // Edit the cell.
    fireEvent.doubleClick(
      screen.getByText(/original \{\{icon:lucide:does-not-exist\}\}/),
    );
    const inputs = await screen.findAllByDisplayValue(
      "original {{icon:lucide:does-not-exist}}",
    );
    fireEvent.change(inputs[0], {
      target: { value: "edited-live {{icon:lucide:does-not-exist}}" },
    });
    fireEvent.blur(inputs[0]);

    // Export as HTML — icon-aware, but the icon token is unresolvable. Before
    // the fix, `embedded === liveContent` would leave `contentOverride === null`
    // and the persisted snapshot would be exported instead of the draft.
    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "html" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportArtifact).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportArtifact as unknown as {
      mock: { calls: unknown[][] };
    };
    const call = mockFn.mock.calls[0];
    const contentOverride = call[2] as string | null;
    expect(contentOverride).not.toBeNull();
    expect(contentOverride).toContain("edited-live");
    // The unresolvable token must pass through unchanged (embedIcons is a
    // no-op for tokens it can't resolve); the contract here is that the
    // *live* version of the content reaches the exporter, not that the
    // tokens get rewritten.
    expect(contentOverride).toContain("{{icon:lucide:does-not-exist}}");
  });

  it("does NOT rewrite {{icon:...}} tokens in JSON-structured artifacts (sheets/bases/infographics/landing-pages) — regression for ANALYSIS_pr-review-job-b2d5a388d3234be29ad9e3139f4a3c63_0001", async () => {
    // The user has manually typed a *resolvable* icon token into a sheet cell.
    // Even though the format (HTML) is icon-aware and the token is resolvable,
    // running `embedIcons` over stringified JSON would inject inline `<svg ...>`
    // containing unescaped `"` characters, which would break the JSON the Rust
    // exporter parses on the other side of the IPC.
    //
    // The correct architectural behaviour is to gate `embedIcons` by artifact
    // type: only `document` artifacts (raw markdown/text content) get token
    // rewriting; JSON-structured artifacts express icons through structured
    // schema fields and are passed through to the exporter unchanged.
    const sheetWithResolvableIcon = JSON.stringify({
      columns: ["Col"],
      rows: [["literal {{icon:lucide:home}} in a cell"]],
    });
    const sheetArtifact = {
      ...baseArtifact,
      id: "art-sheet-icon",
      artifactType: "sheet" as const,
      content: sheetWithResolvableIcon,
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(sheetArtifact);

    render(
      <MemoryRouter initialEntries={["/artifact/art-sheet-icon"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/literal \{\{icon:lucide:home\}\} in a cell/),
      ).toBeInTheDocument();
    });

    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "html" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportArtifact).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportArtifact as unknown as {
      mock: { calls: unknown[][] };
    };
    const call = mockFn.mock.calls[0];
    const contentOverride = call[2] as string | null;
    // `contentOverride` may be null (no diff between draft and persisted)
    // OR equal to the original JSON; either way the JSON structure must be
    // intact and the `{{icon:...}}` token must survive (no inline `<svg>`).
    const effective = contentOverride ?? sheetWithResolvableIcon;
    expect(effective).toContain("{{icon:lucide:home}}");
    expect(effective).not.toContain("<svg");
    // Sanity: the JSON shape is preserved.
    expect(() => JSON.parse(effective)).not.toThrow();
  });

  it("pre-renders infographic JSON to rich HTML via buildPreviewHtml before exporting (regression for ANALYSIS_pr-review-job-944bd22719314f15b61523f7c7574bc6_0001)", async () => {
    // Without the fix, the persisted infographic JSON would reach the Rust
    // HTML exporter unchanged, which would chop `{"title":"...","sections":
    // [...]}` into pseudo-paragraphs and lose the rich visual layout. The
    // contract is: the renderer detects `infographic` + `html` format,
    // runs the artifact through `buildPreviewHtml(parseInfographicContent(...))`,
    // and passes the resulting HTML fragment through `contentOverride`.
    const infographicJson = JSON.stringify({
      title: "Q4 KPIs",
      subtitle: "All-up snapshot",
      sections: [
        {
          icon: "lucide:trending-up",
          heading: "Growth",
          body: "+42% YoY",
          stat: "42%",
          statLabel: "growth",
        },
      ],
      colorScheme: { primary: "#7C3AED", secondary: "#5B21B6", accent: "#F59E0B" },
      layout: "vertical",
    });
    const infographicArtifact = {
      ...baseArtifact,
      id: "art-infographic",
      artifactType: "infographic" as const,
      content: infographicJson,
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(infographicArtifact);

    render(
      <MemoryRouter initialEntries={["/artifact/art-infographic"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // Wait for the editor to render — the heading is one of the more
    // specific strings only present after a successful parse + mount.
    await waitFor(() => {
      expect(screen.getAllByDisplayValue("Q4 KPIs").length).toBeGreaterThan(0);
    });

    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "html" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportArtifact).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportArtifact as unknown as {
      mock: { calls: unknown[][] };
    };
    const call = mockFn.mock.calls[0];
    const contentOverride = call[2] as string | null;
    // The override MUST be set — passing through the raw JSON is exactly
    // the bug.
    expect(contentOverride).not.toBeNull();
    const html = contentOverride as string;
    // It must look like HTML, not JSON.
    expect(html.trimStart().startsWith("<")).toBe(true);
    // Specific markers from buildPreviewHtml — the wrapper div class, the
    // heading, the stat block. These pin the *content* of the override,
    // not just its shape.
    expect(html).toContain('class="infographic infographic-preview-vertical"');
    expect(html).toContain("Q4 KPIs");
    expect(html).toContain("Growth");
    expect(html).toContain("+42% YoY");
    // And it must NOT contain the literal JSON braces from the persisted
    // model — that would mean the override was bypassed.
    expect(html).not.toContain('"sections":');
  });

  it("pre-renders landing_page JSON to rich HTML via buildLandingPreviewHtml before exporting (regression for ANALYSIS_pr-review-job-944bd22719314f15b61523f7c7574bc6_0001)", async () => {
    const landingJson = JSON.stringify({
      hero: {
        headline: "Ship Faster",
        subheadline: "The fastest static-site generator.",
        cta: "Get started",
        ctaUrl: "https://example.com",
      },
      features: [
        {
          icon: "lucide:zap",
          title: "Blazing fast",
          description: "Sub-second builds.",
        },
      ],
      stats: [],
      testimonials: [],
      cta: null,
      colorScheme: { primary: "#7C3AED", secondary: "#5B21B6", accent: "#F59E0B" },
    });
    const landingArtifact = {
      ...baseArtifact,
      id: "art-landing",
      artifactType: "landing_page" as const,
      content: landingJson,
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(landingArtifact);

    render(
      <MemoryRouter initialEntries={["/artifact/art-landing"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByDisplayValue("Ship Faster").length,
      ).toBeGreaterThan(0);
    });

    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "html" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportArtifact).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportArtifact as unknown as {
      mock: { calls: unknown[][] };
    };
    const call = mockFn.mock.calls[0];
    const contentOverride = call[2] as string | null;
    expect(contentOverride).not.toBeNull();
    const html = contentOverride as string;
    expect(html.trimStart().startsWith("<")).toBe(true);
    expect(html).toContain('class="landing"');
    expect(html).toContain("Ship Faster");
    expect(html).toContain("Blazing fast");
    expect(html).not.toContain('"features":');
  });

  it("pre-renders infographic JSON to printable text (NOT raw JSON) when exporting to PDF (regression for BUG_pr-review-job-5a49c7d7ef804edda4f280500e2b1ff0_0001)", async () => {
    // Visual artifact + PDF used to hit the binary-format branch with no
    // `contentOverride`, so the persisted `{"title":"…","sections":[…]}`
    // JSON went straight through the line-based PDF builder which
    // rendered it character-soup. The fix is to route visual artifacts
    // through `buildInfographicPrintableText` (markdown-style heading +
    // paragraph layout) for PDF/DOCX in the same way HTML uses the
    // preview HTML builder. Pin both ends of the contract: the override
    // MUST be set, MUST NOT look like JSON, and MUST contain the
    // section content as plain readable text.
    const infographicJson = JSON.stringify({
      title: "Q4 KPIs",
      subtitle: "All-up snapshot",
      sections: [
        {
          icon: "lucide:trending-up",
          heading: "Growth",
          body: "+42% YoY",
          stat: "42%",
          statLabel: "growth",
        },
      ],
      colorScheme: { primary: "#7C3AED", secondary: "#5B21B6", accent: "#F59E0B" },
      layout: "vertical",
    });
    const infographicArtifact = {
      ...baseArtifact,
      id: "art-infographic-pdf",
      artifactType: "infographic" as const,
      content: infographicJson,
    };
    window.tessera.artifacts.get = vi
      .fn()
      .mockResolvedValue(infographicArtifact);
    window.tessera.artifacts.exportToFile = vi
      .fn()
      .mockResolvedValue("/tmp/Q4 KPIs.pdf");

    render(
      <MemoryRouter initialEntries={["/artifact/art-infographic-pdf"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByDisplayValue("Q4 KPIs").length).toBeGreaterThan(0);
    });

    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "pdf" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportToFile).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportToFile as unknown as {
      mock: { calls: unknown[][] };
    };
    // exportToFile(id, format, suggestedName, contentOverride)
    const call = mockFn.mock.calls[0];
    const contentOverride = call[3] as string | null;
    expect(contentOverride).not.toBeNull();
    const text = contentOverride as string;
    // It must NOT look like JSON — the bug was that PDF received raw JSON.
    expect(text.trimStart().startsWith("{")).toBe(false);
    expect(text).not.toContain('"sections":');
    expect(text).not.toContain('"colorScheme":');
    // It MUST contain the actual visible content as plain text, in
    // markdown-style ordering (title heading → section heading →
    // stat → body).
    expect(text).toContain("# Q4 KPIs");
    expect(text).toContain("All-up snapshot");
    expect(text).toContain("## Growth");
    expect(text).toContain("42% growth");
    expect(text).toContain("+42% YoY");
  });

  it("pre-renders landing_page JSON to printable text (NOT raw JSON) when exporting to PDF (regression for BUG_pr-review-job-5a49c7d7ef804edda4f280500e2b1ff0_0001)", async () => {
    // Landing page parallel of the above — exports to PDF must produce
    // a structured markdown-like rendering (hero → features → stats →
    // testimonials → cta), never raw JSON.
    const landingJson = JSON.stringify({
      title: "Tessera",
      hero: {
        headline: "Ship Faster",
        subheadline: "The fastest static-site generator.",
        cta: "Get started",
        ctaUrl: "https://example.com/signup",
      },
      features: [
        {
          icon: "lucide:zap",
          title: "Blazing fast",
          description: "Render in under a second.",
        },
      ],
      stats: [{ value: "10x", label: "faster" }],
      testimonials: [
        { quote: "Game changer.", name: "Jane Doe", company: "Acme" },
      ],
      cta: {
        headline: "Ready?",
        buttonText: "Start free",
        buttonUrl: "https://example.com/start",
      },
      colorScheme: {
        primary: "#7C3AED",
        secondary: "#0EA5E9",
        accent: "#F59E0B",
      },
    });
    const landingArtifact = {
      ...baseArtifact,
      id: "art-landing-pdf",
      artifactType: "landing_page" as const,
      content: landingJson,
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(landingArtifact);
    window.tessera.artifacts.exportToFile = vi
      .fn()
      .mockResolvedValue("/tmp/Tessera.pdf");

    render(
      <MemoryRouter initialEntries={["/artifact/art-landing-pdf"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(
        screen.getAllByDisplayValue("Ship Faster").length,
      ).toBeGreaterThan(0);
    });

    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "pdf" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportToFile).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportToFile as unknown as {
      mock: { calls: unknown[][] };
    };
    const call = mockFn.mock.calls[0];
    const contentOverride = call[3] as string | null;
    expect(contentOverride).not.toBeNull();
    const text = contentOverride as string;
    expect(text.trimStart().startsWith("{")).toBe(false);
    expect(text).not.toContain('"features":');
    expect(text).not.toContain('"stats":');
    expect(text).toContain("# Tessera");
    expect(text).toContain("## Ship Faster");
    expect(text).toContain("The fastest static-site generator.");
    expect(text).toContain("## Features");
    expect(text).toContain("### Blazing fast");
    expect(text).toContain("## Stats");
    expect(text).toContain("10x");
    expect(text).toContain("## Testimonials");
    expect(text).toContain("Jane Doe");
    expect(text).toContain("## Ready?");
  });

  it("for PDF export: rewrites {{icon:...}} tokens in document content to [name] text placeholders (NOT inline <svg>)", async () => {
    // Long-term-correct icon export contract:
    //   - HTML / DOCX  -> inline <svg> (carries visual fidelity)
    //   - PDF (minimal builder) -> "[name]" text placeholders
    //
    // The fallback PDF builder in `tessera_export::pdf` is text-only and
    // cannot embed images. Previously the renderer ran `embedIcons` for
    // PDF, which dumped inline `<svg ...>` markup into the document; the
    // PDF builder then escaped the `<` / `>` and rendered the literal
    // tag text in the body. Switching PDF onto `iconsToTextPlaceholder`
    // produces a readable line like "Hello [home] world" instead, and
    // preserves the Typst PDF pipeline's separate high-fidelity path
    // (which DOES render real vectors).
    const docArtifact = {
      ...baseArtifact,
      id: "art-doc-pdf-icons",
      artifactType: "document" as const,
      content: "Hello {{icon:lucide:home}} world",
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(docArtifact);
    // PDF is a binary format: the renderer routes it through
    // `artifacts.exportToFile` (which prompts the user via the
    // native save dialog), NOT `exportArtifact`.
    window.tessera.artifacts.exportToFile = vi
      .fn()
      .mockResolvedValue("/tmp/Draft Test.pdf");

    render(
      <MemoryRouter initialEntries={["/artifact/art-doc-pdf-icons"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      // The TipTap editor renders the prose text as a div containing
      // the user-typed line.
      expect(screen.getByText(/Hello/)).toBeInTheDocument();
    });

    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "pdf" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportToFile).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportToFile as unknown as {
      mock: { calls: unknown[][] };
    };
    // exportToFile(id, format, suggestedName, contentOverride)
    const call = mockFn.mock.calls[0];
    const contentOverride = call[3] as string | null;
    expect(contentOverride).not.toBeNull();
    const text = contentOverride as string;
    expect(text).toContain("[home]");
    expect(text).not.toMatch(/<svg/);
    expect(text).not.toContain("{{icon:");
  });

  it("for HTML export: keeps inline <svg> markup for document {{icon:...}} tokens", async () => {
    // Sibling contract to the PDF test above: HTML can carry inline
    // SVG, so `embedIcons` (not the text-placeholder helper) is what
    // the renderer must apply for html/docx formats.
    const docArtifact = {
      ...baseArtifact,
      id: "art-doc-html-icons",
      artifactType: "document" as const,
      content: "Hello {{icon:lucide:home}} world",
    };
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(docArtifact);

    render(
      <MemoryRouter initialEntries={["/artifact/art-doc-html-icons"]}>
        <Routes>
          <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/Hello/)).toBeInTheDocument();
    });

    const exportSelect = screen.getByLabelText(
      "Export artifact",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "html" } });
    });

    await waitFor(() => {
      expect(window.tessera.artifacts.exportArtifact).toHaveBeenCalled();
    });
    const mockFn = window.tessera.artifacts.exportArtifact as unknown as {
      mock: { calls: unknown[][] };
    };
    const call = mockFn.mock.calls[0];
    const contentOverride = call[2] as string | null;
    expect(contentOverride).not.toBeNull();
    const text = contentOverride as string;
    expect(text).toMatch(/<svg/);
    expect(text).not.toContain("{{icon:");
    expect(text).not.toContain("[home]");
  });
});
