/**
 * Regression coverage for CitationPanel's Escape-key precedence.
 *
 * The panel and its nested dialogs used to each register their own
 * window `keydown` listener, so a single Escape while a sub-dialog was
 * open fired BOTH — dismissing the sub-dialog AND closing the whole
 * panel underneath it. Escape handling is now centralized in the panel
 * and dismisses the innermost open surface first, only closing the
 * panel when no sub-dialog is open.
 *
 * These tests assert that hierarchy for both the destructive
 * "Confirm remove" dialog and the "Add citation" dialog.
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
});

async function renderOpenPanel(onClose: () => void) {
  render(<CitationPanel artifactId="artifact-1" isOpen onClose={onClose} />);
  // Wait for the citation to load so the Remove action is present.
  await screen.findByRole("button", { name: /remove citation from acme\.md/i });
}

describe("CitationPanel Escape precedence", () => {
  it("Escape cancels the confirm-remove dialog without closing the panel", async () => {
    const onClose = vi.fn();
    await renderOpenPanel(onClose);

    fireEvent.click(
      screen.getByRole("button", { name: /remove citation from acme\.md/i }),
    );
    expect(
      await screen.findByRole("alertdialog", {
        name: /confirm citation removal/i,
      }),
    ).toBeInTheDocument();

    // First Escape: dismiss only the inner dialog; panel stays open.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", {
          name: /confirm citation removal/i,
        }),
      ).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: /citations panel/i }),
    ).toBeInTheDocument();

    // Second Escape: now the panel itself closes.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the add-citation dialog without closing the panel", async () => {
    const onClose = vi.fn();
    await renderOpenPanel(onClose);

    fireEvent.click(
      screen.getByRole("button", { name: /add a new citation/i }),
    );
    expect(
      await screen.findByRole("dialog", { name: /add citation/i }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: /add citation/i }),
      ).not.toBeInTheDocument(),
    );
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Escape closes the panel directly when no sub-dialog is open", async () => {
    const onClose = vi.fn();
    await renderOpenPanel(onClose);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
