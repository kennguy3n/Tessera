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
    // exist on the real type — a pattern that lets renderer code
    // accidentally rely on non-existent fields. We keep the mock
    // honest by only populating the two fields the bridge actually
    // returns.
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
    // Regression test for finding: if the previous
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
    // Regression test for finding: with the original
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
    // Per-click cycle, the hook must observe running → done. We
    // model this by tracking poll order across both clicks: each
    // cycle's first poll is running, second is done. The hook's
    // stale-terminal guard requires observing running before
    // terminating, so this sequence lets the effect terminate
    // cleanly after each cycle.
    let pollCount = 0;
    window.tessera.sources.getEmbeddingProgress = vi.fn().mockImplementation(
      async () => {
        pollCount += 1;
        // Odd polls = running, even polls = done. So each cycle
        // (running → done) is two polls.
        if (pollCount % 2 === 1) {
          return {
            status: "running" as const,
            totalChunks: 5,
            embedded: 2,
            failed: 0,
            modelId: "hash-trick-v1",
            lastError: null,
          };
        }
        return {
          status: "done" as const,
          totalChunks: 5,
          embedded: 5,
          failed: 0,
          modelId: "hash-trick-v1",
          lastError: null,
        };
      },
    );
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
    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");

    fireEvent.click(button);
    await waitFor(() => {
      expect(window.tessera.sources.backfillEmbeddings).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });
    // Wait for the first cycle to terminate cleanly — i.e. the
    // hook saw running then done and stopped polling. We pin this
    // by observing that pollCount has reached at least 2 (one
    // running, one done) and then settles.
    await waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(2);
    });
    const pollsAfterFirstClick = pollCount;

    fireEvent.click(button);
    await waitFor(() => {
      expect(window.tessera.sources.backfillEmbeddings).toHaveBeenCalledTimes(2);
    });
    // The second polling cycle must fire at least one additional
    // `getEmbeddingProgress` call. If the effect had failed to
    // restart (the bug we're guarding against), this count would
    // stay equal to `pollsAfterFirstClick`.
    await waitFor(() => {
      expect(pollCount).toBeGreaterThan(pollsAfterFirstClick);
    });
  });

  it("shows a failed-state banner when the embedding tracker reports `status: failed`", async () => {
    // Realistic mock sequence: the bridge's `mark_starting()`
    // pre-flight reset means the first poll always sees `running`
    // with zero counters, then the worker thread does its work and
    // either succeeds or fails. The hook's stale-terminal guard
    // (`observedRunning` flag) refuses to commit a terminal snapshot
    // until it has witnessed at least one `running` response —
    // exactly to defend against accidentally rendering the previous
    // run's stale terminal state. So this test's mock has to step
    // through the same `running → failed` transition the real
    // bridge would produce, otherwise the guard correctly refuses
    // to surface the failure (because, from the hook's perspective,
    // an immediate `failed` is indistinguishable from "previous run
    // ended Failed and the bridge hasn't reset yet"). See
    // `useEmbeddingProgress` for the full discussion.
    let pollCount = 0;
    window.tessera.sources.getEmbeddingProgress = vi.fn().mockImplementation(
      async () => {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            status: "running",
            totalChunks: 0,
            embedded: 0,
            failed: 0,
            modelId: null,
            lastError: null,
          };
        }
        return {
          status: "failed",
          totalChunks: 10,
          embedded: 3,
          failed: 1,
          modelId: "hash-trick-v1",
          lastError: "embedder crashed",
        };
      },
    );
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

  it("suppresses a stale terminal snapshot until the new run reaches `running` (race-fix regression)", async () => {
    // Regression test for the second-pass finding:
    // when the renderer polls `getEmbeddingProgress` before the
    // bridge's worker thread has called `tracker.start()` for the
    // new run, the first response can be the *previous* run's
    // terminal status (`done` / `failed`). Without the hook's
    // stale-terminal guard, the renderer would render that as the
    // current run and stop polling. With the guard, the hook
    // refuses to commit any terminal snapshot to render-state
    // until it has observed at least one `running` response,
    // keeping the poll loop alive until the worker thread finishes
    // resetting state.
    let pollCount = 0;
    window.tessera.sources.getEmbeddingProgress = vi.fn().mockImplementation(
      async () => {
        pollCount += 1;
        // Poll 1: race — see previous run's stale `done` snapshot
        if (pollCount === 1) {
          return {
            status: "done",
            totalChunks: 5,
            embedded: 5,
            failed: 0,
            modelId: "hash-trick-v1",
            lastError: null,
          };
        }
        // Poll 2: worker thread has caught up; tracker now Running
        if (pollCount === 2) {
          return {
            status: "running",
            totalChunks: 10,
            embedded: 2,
            failed: 0,
            modelId: "hash-trick-v1",
            lastError: null,
          };
        }
        // Poll 3+: backfill complete with REAL new-run counters
        return {
          status: "done",
          totalChunks: 10,
          embedded: 10,
          failed: 0,
          modelId: "hash-trick-v1",
          lastError: null,
        };
      },
    );
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
    // The final card must show the NEW run's counters (10/10), not
    // the stale previous-run counters (5/5). If the guard regressed,
    // the renderer would render `5 / 5 chunks` from poll 1 and
    // never reach the real result. We need a longer timeout than
    // the default 1000ms because the hook polls every 500ms and we
    // need at least three polls (stale done → running → fresh done)
    // to terminate the cycle cleanly.
    await waitFor(
      () => {
        expect(screen.getByText(/10 \/ 10/)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByText(/5 \/ 5/)).not.toBeInTheDocument();
    // And the poller must have actually polled multiple times
    // (i.e. it didn't quit on poll 1's stale `done`).
    expect(pollCount).toBeGreaterThanOrEqual(3);
  });

  it("stops the polling loop when the backfill IPC rejects synchronously (no infinite-poll leak)", async () => {
    // Regression test for finding: if
    // `sources:backfillEmbeddings` rejects before reaching the
    // bridge (e.g. the IPC handler's
    // `defaultRateLimiter.consume(...)` throws synchronously),
    // the bridge's pre-flight `mark_starting()` never fires. The
    // tracker is therefore stuck in whatever state the previous
    // run left it in (`idle` on fresh launch, `done` / `failed`
    // afterwards), and the `useEmbeddingProgress` hook's
    // `observedRunning` guard can never be satisfied — the
    // polling loop would tick every 500 ms forever, never
    // reaching a terminal state, until the user clicks Re-embed
    // again or unmounts the page.
    //
    // The fix in `SourceDetailPage.handleReembed` rolls
    // `reembedGeneration` back to the quiescent sentinel (`0`)
    // on the catch path, tripping the
    // `if (generation <= 0) return;` early-return at the top of
    // the hook's effect. That cancels the pending timer via the
    // effect cleanup and prevents any further polls from being
    // scheduled.
    //
    // We assert the bounded-poll-count contract: after the
    // rejection, `getEmbeddingProgress` may have fired a couple
    // of in-flight polls before the rollback flush, but it must
    // NOT keep growing on a wall-clock interval. A 1.5 s wait
    // (three full 500 ms intervals) is enough to catch a
    // never-ending poller.
    let pollCount = 0;
    window.tessera.sources.getEmbeddingProgress = vi.fn().mockImplementation(
      async () => {
        pollCount += 1;
        // Simulate the "previous run finished" / fresh-launch
        // case: tracker is sitting in a stale `done` state. The
        // hook's `observedRunning` guard means this never
        // terminates the polling loop on its own.
        return {
          status: "done" as const,
          totalChunks: 0,
          embedded: 0,
          failed: 0,
          modelId: "hash-trick-v1",
          lastError: null,
        };
      },
    );
    window.tessera.sources.backfillEmbeddings = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Rate limit exceeded for sources:backfillEmbeddings — retry in 10s",
        ),
      );

    renderWithRoute();
    const button = await screen.findByTestId("reembed-button");
    fireEvent.click(button);

    // Wait until the error banner renders — at that point the
    // catch handler has run, including the `setReembedGeneration(0)`
    // rollback, and React has scheduled the effect cleanup.
    await waitFor(() => {
      expect(screen.getByTestId("reembed-error")).toHaveTextContent(
        /Rate limit exceeded/i,
      );
    });

    // Take a snapshot of how many polls leaked through before
    // the cleanup fired. There may be a small number due to
    // microtask ordering (the hook's first tick can dispatch
    // before the rollback's effect flush), but the count must
    // not keep growing.
    const pollsAtSettle = pollCount;
    // Wait 1.5 s — three full polling intervals. If the cleanup
    // worked, the poll count must NOT grow during this window.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(pollCount).toBe(pollsAtSettle);
  });
});
