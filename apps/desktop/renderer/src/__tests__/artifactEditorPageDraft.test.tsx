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
});
