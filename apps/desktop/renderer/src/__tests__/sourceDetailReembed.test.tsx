import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import SourceDetailPage from "../pages/SourceDetailPage";

describe("SourceDetailPage Re-embed button", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Seed the SourceDetailPage with a minimal source so the page
    // mounts past its loading state.
    window.tessera.sources.getDetail = vi.fn().mockResolvedValue({
      source: {
        id: "src-1",
        sourceType: "local_folder",
        path: "/mock/folder",
        status: "connected",
        createdAt: new Date().toISOString(),
        lastIndexed: new Date().toISOString(),
        fileCount: 3,
      },
      files: [],
    });
  });

  function renderWithRoute() {
    return render(
      <MemoryRouter initialEntries={["/sources/src-1"]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("renders the Re-embed button with an accessible label", async () => {
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Re-embed"),
    );
  });

  it("clicking Re-embed triggers the backfillEmbeddings IPC exactly once", async () => {
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");
    fireEvent.click(button);
    await waitFor(() => {
      expect(
        window.tessera.sources.backfillEmbeddings,
      ).toHaveBeenCalledTimes(1);
    });
  });

  it("disables the Re-embed button while the IPC is in flight", async () => {
    // Make backfillEmbeddings hang so we can observe the in-flight state.
    let resolveBackfill: (value: unknown) => void = () => undefined;
    window.tessera.sources.backfillEmbeddings = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBackfill = resolve;
        }),
    );
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");
    fireEvent.click(button);
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    });
    expect(button.textContent).toMatch(/Re-embedding/i);
    // Resolve and verify it re-enables.
    resolveBackfill({
      embedded: 5,
      failed: 0,
      batchSize: 64,
      progress: {
        status: "done",
        totalChunks: 5,
        embedded: 5,
        failed: 0,
        modelId: "hash-trick-v1",
        lastError: null,
      },
    });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("renders the progress card after a successful backfill (done state)", async () => {
    // After the backfill resolves, `reembedJustFinished` flips to true
    // and the polling loop fetches the final progress snapshot once.
    // We seed it with a `done` snapshot so the test doesn't have to
    // race the running→done transition.
    window.tessera.sources.getEmbeddingProgress = vi.fn().mockResolvedValue({
      status: "done",
      totalChunks: 10,
      embedded: 10,
      failed: 0,
      modelId: "hash-trick-v1",
      lastError: null,
    });
    window.tessera.sources.backfillEmbeddings = vi.fn().mockResolvedValue({
      embedded: 10,
      failed: 0,
      batchSize: 64,
      progress: {
        status: "done",
        totalChunks: 10,
        embedded: 10,
        failed: 0,
        modelId: "hash-trick-v1",
        lastError: null,
      },
    });
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");
    fireEvent.click(button);
    await waitFor(
      () => {
        expect(
          screen.getByTestId("embedding-progress-card"),
        ).toBeInTheDocument();
      },
      { timeout: 2000 },
    );
    const card = screen.getByTestId("embedding-progress-card");
    expect(card.textContent).toContain("10");
    expect(card.textContent).toMatch(/chunks embedded/i);
  });

  it("renders an inline error banner if the backfill IPC rejects (e.g. rate-limited)", async () => {
    window.tessera.sources.backfillEmbeddings = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Rate limit exceeded for sources:backfillEmbeddings — retry in 10s",
        ),
      );
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByTestId("reembed-error")).toHaveTextContent(
        /Rate limit exceeded/i,
      );
    });
    // Button re-enables so the user can retry once the limiter
    // refills.
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a failed-state banner when the embedding tracker reports `status: failed`", async () => {
    window.tessera.sources.getEmbeddingProgress = vi.fn().mockResolvedValue({
      status: "failed",
      totalChunks: 10,
      embedded: 3,
      failed: 1,
      modelId: "hash-trick-v1",
      lastError: "embedder crashed",
    });
    window.tessera.sources.backfillEmbeddings = vi.fn().mockResolvedValue({
      embedded: 3,
      failed: 1,
      batchSize: 64,
      progress: {
        status: "failed",
        totalChunks: 10,
        embedded: 3,
        failed: 1,
        modelId: "hash-trick-v1",
        lastError: "embedder crashed",
      },
    });
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");
    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByText(/Re-embed failed/i)).toBeInTheDocument();
      expect(screen.getByText(/embedder crashed/i)).toBeInTheDocument();
    });
  });
});
