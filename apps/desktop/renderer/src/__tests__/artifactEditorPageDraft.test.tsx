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

describe("ArtifactEditorPage live-draft export", () => {
  beforeEach(() => {
    window.tessera.artifacts.get = vi.fn().mockResolvedValue(baseArtifact);
    window.tessera.artifacts.exportArtifact = vi.fn().mockResolvedValue({
      format: "markdown",
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

    // Immediately export as markdown (no debounce wait — this is the bug
    // scenario the fix targets).
    const exportSelect = screen.getByLabelText("Export artifact") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(exportSelect, { target: { value: "markdown" } });
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
});
