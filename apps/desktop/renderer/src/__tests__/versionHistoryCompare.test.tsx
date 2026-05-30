/**
 * Phase 15 Task 24 — component test for `VersionHistory`'s Compare
 * mode. Exercises:
 *   1. compare button is disabled until two versions are ticked
 *   2. ticking a third version replaces the oldest selection (cap=2)
 *   3. clicking Compare renders the diff with the expected
 *      add/remove summary and entry rows
 *   4. preview view is exited when entering compare view (and vice
 *      versa)
 *
 * Tests use the global `window.tessera` mock provided by
 * `src/__tests__/setup.ts`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import VersionHistory from "../components/VersionHistory";

const VERSIONS = [
  {
    version: 1,
    content: "alpha\nbeta\ngamma",
    createdAt: "2024-01-01T00:00:00Z",
  },
  {
    version: 2,
    content: "alpha\nbeta-edited\ngamma",
    createdAt: "2024-01-02T00:00:00Z",
  },
  {
    version: 3,
    content: "alpha\nbeta-edited\ngamma\ndelta",
    createdAt: "2024-01-03T00:00:00Z",
  },
];

function setupApi() {
  const api = window.tessera!;
  vi.mocked(api.artifacts.listVersions).mockResolvedValue(VERSIONS);
}

describe("VersionHistory Compare", () => {
  beforeEach(() => {
    setupApi();
  });

  async function renderPanel() {
    const onClose = vi.fn();
    const onRestore = vi.fn();
    render(
      <VersionHistory
        artifactId="art-1"
        isOpen
        onClose={onClose}
        onRestore={onRestore}
      />,
    );
    // Wait for the version list to render.
    await screen.findByText("v1");
    return { onClose, onRestore };
  }

  it("disables Compare until exactly two versions are ticked", async () => {
    await renderPanel();
    const compareBtn = screen.getByRole("button", { name: "Compare" });
    expect(compareBtn).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Select v1 for comparison"));
    expect(compareBtn).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Select v2 for comparison"));
    expect(compareBtn).toBeEnabled();
  });

  it("caps at two selections and drops the oldest on a third pick", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText("Select v1 for comparison"));
    fireEvent.click(screen.getByLabelText("Select v2 for comparison"));
    fireEvent.click(screen.getByLabelText("Select v3 for comparison"));
    // v1 should be dropped — only v2 and v3 should remain checked.
    const v1Checkbox = screen.getByLabelText(
      "Select v1 for comparison",
    ) as HTMLInputElement;
    const v2Checkbox = screen.getByLabelText(
      "Select v2 for comparison",
    ) as HTMLInputElement;
    const v3Checkbox = screen.getByLabelText(
      "Select v3 for comparison",
    ) as HTMLInputElement;
    expect(v1Checkbox.checked).toBe(false);
    expect(v2Checkbox.checked).toBe(true);
    expect(v3Checkbox.checked).toBe(true);
  });

  it("renders a side-by-side diff with correct summary counts", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText("Select v1 for comparison"));
    fireEvent.click(screen.getByLabelText("Select v3 for comparison"));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    await screen.findByText("Diff: v1 → v3");
    // v1: alpha / beta / gamma
    // v3: alpha / beta-edited / gamma / delta
    // LCS = alpha + gamma (length 2). added = 4 - 2 = 2; removed = 3 - 2 = 1.
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    expect(screen.getByText("=2")).toBeInTheDocument();
    // The removed line should be rendered as a remove row.
    const diffPanel = screen.getByLabelText("Version comparison");
    expect(diffPanel.querySelectorAll(".version-diff-line-remove").length)
      .toBeGreaterThan(0);
    expect(diffPanel.querySelectorAll(".version-diff-line-add").length)
      .toBeGreaterThan(0);
  });

  it("switches from preview view to compare view and back", async () => {
    await renderPanel();
    // Open preview for v2 by clicking its button (not the checkbox).
    fireEvent.click(screen.getByRole("button", { name: /v2/ }));
    await screen.findByText("Preview: v2");
    expect(screen.getByText("Preview: v2")).toBeInTheDocument();

    // Select two versions and switch to compare — preview should
    // disappear.
    fireEvent.click(screen.getByLabelText("Select v1 for comparison"));
    fireEvent.click(screen.getByLabelText("Select v2 for comparison"));
    fireEvent.click(screen.getByRole("button", { name: "Compare" }));
    await waitFor(() => {
      expect(screen.queryByText("Preview: v2")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Diff: v1 → v2")).toBeInTheDocument();

    // Click on a version to preview — diff should disappear.
    fireEvent.click(screen.getByRole("button", { name: /v3/ }));
    await waitFor(() => {
      expect(screen.queryByText("Diff: v1 → v2")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Preview: v3")).toBeInTheDocument();
  });
});
