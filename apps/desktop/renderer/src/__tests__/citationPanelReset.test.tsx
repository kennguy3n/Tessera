/**
 * Regression coverage for CitationPanel sub-dialog state lifecycle.
 *
 * CitationPanel is mounted unconditionally by the artifact editor and
 * gates its render on `isOpen`, so its internal sub-dialog state
 * (`showAdd` / `pendingDelete` / `replaceFor`) would otherwise survive
 * a close/reopen cycle and even bleed across an artifact switch:
 *
 *   - Closing via the Close button (or Escape) calls `onClose()` without
 *     clearing sub-dialog state, so a previously-open Add/Replace/Confirm
 *     dialog would reappear on the next open.
 *   - Switching `artifactId` while a dialog is open would leave that
 *     dialog bound to the *previous* artifact's citation.
 *
 * The panel now resets all sub-dialog state whenever it closes or the
 * artifact changes. These tests lock in that behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import CitationPanel from "../components/CitationPanel";
import type { CitationInfo } from "../types/ipc";

function citation(over: Partial<CitationInfo> = {}): CitationInfo {
  return {
    citationId: "cit-1",
    sourceId: "11111111-1111-4111-8111-111111111111",
    sourceType: "file",
    sourceTitle: "acme.md",
    sourceUri: "file://acme.md",
    chunkHash: "filehash",
    page: null,
    confidence: 0.9,
    usedFor: "document",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  (window.tessera.citations.list as ReturnType<typeof vi.fn>).mockResolvedValue(
    [citation()],
  );
  (
    window.tessera.citations.checkFreshness as ReturnType<typeof vi.fn>
  ).mockResolvedValue("fresh");
  (window.tessera.citations.list as ReturnType<typeof vi.fn>).mockClear();
});

describe("CitationPanel sub-dialog reset", () => {
  it("does not re-show the Add dialog after a close/reopen cycle", async () => {
    const { rerender } = render(
      <CitationPanel artifactId="artifact-1" isOpen onClose={() => {}} />,
    );
    await screen.findByRole("button", { name: /add a new citation/i });

    fireEvent.click(
      screen.getByRole("button", { name: /add a new citation/i }),
    );
    expect(
      await screen.findByRole("dialog", { name: /add citation/i }),
    ).toBeInTheDocument();

    // Close the panel (component renders null but stays mounted, so its
    // state would otherwise persist) and reopen it.
    rerender(
      <CitationPanel
        artifactId="artifact-1"
        isOpen={false}
        onClose={() => {}}
      />,
    );
    rerender(
      <CitationPanel artifactId="artifact-1" isOpen onClose={() => {}} />,
    );

    await screen.findByRole("button", { name: /add a new citation/i });
    // The Add dialog must NOT reappear — the panel reopened clean.
    expect(
      screen.queryByRole("dialog", { name: /add citation/i }),
    ).not.toBeInTheDocument();
  });

  it("dismisses an open sub-dialog when the artifact changes", async () => {
    const { rerender } = render(
      <CitationPanel artifactId="artifact-1" isOpen onClose={() => {}} />,
    );
    await screen.findByRole("button", { name: /add a new citation/i });

    fireEvent.click(
      screen.getByRole("button", { name: /add a new citation/i }),
    );
    expect(
      await screen.findByRole("dialog", { name: /add citation/i }),
    ).toBeInTheDocument();

    // Navigate to a different artifact while the panel stays open.
    rerender(
      <CitationPanel artifactId="artifact-2" isOpen onClose={() => {}} />,
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /add citation/i }),
      ).not.toBeInTheDocument(),
    );
    // The panel reloaded citations for the new artifact.
    expect(window.tessera.citations.list).toHaveBeenCalledWith("artifact-2");
  });
});
