/**
 * Renderer coverage for wiring the CitationPanel (which hosts both the
 * "Sources" and the enriched "Knowledge" tab) into the artifact editor.
 *
 * Before this wiring, CitationPanel was fully built and unit-tested but
 * was not imported by any page or editor, so the Knowledge tab was
 * unreachable in the shipping app. These tests assert that:
 *
 *   1. The editor toolbar renders a "Citations" action button.
 *   2. The panel is mounted-but-closed by default (returns null while
 *      `isOpen` is false), so nothing leaks into the editor chrome.
 *   3. Clicking the button opens the panel and loads citations via
 *      `window.tessera.citations.list`, making the Sources/Knowledge
 *      tabs reachable from the editor.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  configure,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import ArtifactEditorPage from "../pages/ArtifactEditorPage";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });
configure({ asyncUtilTimeout: 10_000 });

// A sheet artifact is used so the editor mounts the lightweight
// SheetEditor rather than the ProseMirror document editor — the button
// and panel live in the page chrome (outside the editor surface), so
// the artifact type is incidental, and sheet keeps the test fast and
// free of heavy editor dependencies.
const sheetArtifact = {
  id: "art-citations",
  title: "Citation Wiring Doc",
  artifactType: "sheet" as const,
  templateId: null,
  content: JSON.stringify({ columns: ["Col"], rows: [["original"]] }),
  citationCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  version: 1,
};

function renderEditor() {
  return render(
    <MemoryRouter initialEntries={["/artifact/art-citations"]}>
      <Routes>
        <Route path="/artifact/:id" element={<ArtifactEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ArtifactEditorPage citation panel wiring", () => {
  beforeEach(() => {
    window.tessera.artifacts.get = vi
      .fn()
      .mockResolvedValue(sheetArtifact);
    (
      window.tessera.citations.list as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);
  });

  it("renders the Citations action and keeps the panel closed until clicked", async () => {
    renderEditor();

    const button = await screen.findByTestId("open-citations");
    expect(button).toHaveTextContent(/citations/i);

    // Panel is mounted-but-closed: CitationPanel returns null while
    // isOpen is false, so its region must not be present yet, and the
    // citation load must not have fired.
    expect(
      screen.queryByRole("region", { name: /citations panel/i }),
    ).not.toBeInTheDocument();
    expect(window.tessera.citations.list).not.toHaveBeenCalled();
  });

  it("opens the citation panel (Sources + Knowledge tabs reachable) on click", async () => {
    renderEditor();

    fireEvent.click(await screen.findByTestId("open-citations"));

    const panel = await screen.findByRole("region", {
      name: /citations panel/i,
    });
    expect(panel).toBeInTheDocument();

    // Opening the panel loads this artifact's citations from the bridge.
    await waitFor(() =>
      expect(window.tessera.citations.list).toHaveBeenCalledWith(
        "art-citations",
      ),
    );
  });
});
