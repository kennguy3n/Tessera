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
    // Resolve and verify it re-enables. The bridge's
    // `BackfillEmbeddingsResult` exposes `embedded` and `progress`
    // (the wrapped snapshot) — nothing else. The test mock used to
    // also synthesise `failed` and `batchSize` fields that don't
    // exist on the real type, which Devin Review flagged as a
    // pattern that lets renderer code accidentally rely on
    // non-existent fields. We keep the mock honest by only
    // populating the two fields the bridge actually returns.
    resolveBackfill({
      embedded: 5,
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

  it("suppresses the stale progress card when a follow-up click is rejected with an error", async () => {
    // Regression test for Devin Review finding: if the previous
    // backfill completed and left a "done" snapshot in the
    // `useEmbeddingProgress` hook's state, and the user clicks
    // Re-embed again but the IPC rejects synchronously (e.g.
    // rate-limit at the IPC layer, before the bridge is called),
    // the renderer used to show both the success card from the
    // previous run AND the new error banner. The render guard
    // now suppresses the progress card whenever `reembedError`
    // is set, so the error banner is the single source of truth
    // for the most recent click.
    const doneSnap = {
      status: "done" as const,
      totalChunks: 5,
      embedded: 5,
      failed: 0,
      modelId: "hash-trick-v1",
      lastError: null,
    };
    window.tessera.sources.getEmbeddingProgress = vi
      .fn()
      .mockResolvedValue(doneSnap);
    window.tessera.sources.backfillEmbeddings = vi
      .fn()
      // First click: succeeds and leaves a `done` snapshot in
      // the hook's state.
      .mockResolvedValueOnce({ embedded: 5, progress: doneSnap })
      // Second click: rate-limited at the IPC layer.
      .mockRejectedValueOnce(
        new Error(
          "Rate limit exceeded for sources:backfillEmbeddings — retry in 10s",
        ),
      );
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");

    fireEvent.click(button);
    await waitFor(() => {
      expect(
        screen.getByTestId("embedding-progress-card"),
      ).toBeInTheDocument();
    });

    fireEvent.click(button);
    await waitFor(() => {
      expect(screen.getByTestId("reembed-error")).toHaveTextContent(
        /Rate limit exceeded/i,
      );
    });
    // The stale success card must NOT be visible: with the
    // `!reembedError` render guard it is suppressed even though
    // the hook's internal `snap` still holds the `done` payload.
    expect(
      screen.queryByTestId("embedding-progress-card"),
    ).not.toBeInTheDocument();
  });

  it("re-runs the polling effect on a second Re-embed click (generation counter)", async () => {
    // Regression test for Devin Review finding: with the original
    // `active: boolean` design, clicking Re-embed a second time
    // failed to restart the polling loop because the boolean stayed
    // `true` across the click handler's batched state updates.
    // The hook now takes a monotonic `generation` counter that
    // bumps on each click, so the effect re-fires deterministically.
    //
    // We assert two things:
    //   (a) the IPC fires twice — once per click;
    //   (b) `getEmbeddingProgress` is polled at least twice in the
    //       second cycle (i.e. the polling effect actually restarted
    //       after the first cycle terminated).
    window.tessera.sources.backfillEmbeddings = vi.fn().mockResolvedValue({
      embedded: 5,
      progress: {
        status: "done",
        totalChunks: 5,
        embedded: 5,
        failed: 0,
        modelId: "hash-trick-v1",
        lastError: null,
      },
    });
    window.tessera.sources.getEmbeddingProgress = vi.fn().mockResolvedValue({
      status: "done",
      totalChunks: 5,
      embedded: 5,
      failed: 0,
      modelId: "hash-trick-v1",
      lastError: null,
    });
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");

    fireEvent.click(button);
    await waitFor(() => {
      expect(window.tessera.sources.backfillEmbeddings).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    const pollsAfterFirstClick = vi.mocked(
      window.tessera.sources.getEmbeddingProgress,
    ).mock.calls.length;

    fireEvent.click(button);
    await waitFor(() => {
      expect(window.tessera.sources.backfillEmbeddings).toHaveBeenCalledTimes(2);
    });
    // The second polling cycle must fire at least one additional
    // `getEmbeddingProgress` call. If the effect had failed to
    // restart (the bug we're guarding against), this count would
    // stay equal to `pollsAfterFirstClick`.
    await waitFor(() => {
      expect(
        vi.mocked(window.tessera.sources.getEmbeddingProgress).mock.calls.length,
      ).toBeGreaterThan(pollsAfterFirstClick);
    });
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
