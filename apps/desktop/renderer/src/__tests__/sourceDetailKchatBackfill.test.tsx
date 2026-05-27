import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import SourceDetailPage, {
  extractKchatChannelIdFromSource,
} from "../pages/SourceDetailPage";
import type { SourceInfo } from "../types/ipc";

/**
 * Phase 13 Task 10 \u2014 KChat backfill progress card on
 * `SourceDetailPage`.
 *
 * The IPC (`kchat:backfillProgress`) already exists and is unit
 * tested at the electron layer (`kchatIpc.test.ts`). These tests
 * pin the renderer's projection of every status discriminator the
 * IPC emits:
 *
 *   1. `extractKchatChannelIdFromSource` returns the correct id
 *      for KChat sources, null for non-KChat sources, and null for
 *      pathologically-empty paths.
 *   2. `idle` / `active` / `complete` / `error` each render their
 *      intended copy in the card body.
 *   3. The Backfill posts button calls `kchat.backfillChannel` with
 *      the extracted channel id.
 *   4. The button disables while the IPC is in flight AND while
 *      the poller reports `status === "active"` (the two are
 *      independently sufficient to disable, defence-in-depth so
 *      the user can't double-trigger before the poll catches up).
 *   5. The card is NOT rendered for non-KChat sources \u2014 the
 *      embedding card and KChat card must not coexist on a
 *      local_folder source.
 *   6. The poll IPC is invoked with the channel id on mount, and
 *      stops being invoked after unmount (cancellation
 *      guarantee).
 */
describe("SourceDetailPage \u2014 KChat backfill card", () => {
  const KCHAT_CHANNEL_ID = "chid26charactersaaaaaaaaaa";
  const KCHAT_SOURCE = {
    id: "src-kchat-1",
    sourceType: "kchat",
    path: `/home/u/.tessera/kchat-channels/${KCHAT_CHANNEL_ID}`,
    status: "indexed",
    createdAt: new Date().toISOString(),
    lastIndexed: new Date().toISOString(),
    fileCount: 0,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    // Default: KChat source with idle backfill (no walk yet).
    // Per-test overrides set `backfillProgress` to drive the
    // active / complete / error branches.
    window.tessera.sources.getDetail = vi.fn().mockResolvedValue({
      source: KCHAT_SOURCE,
      files: [],
    });
  });

  function renderWithRoute() {
    return render(
      <MemoryRouter initialEntries={["/sources/src-kchat-1"]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  describe("extractKchatChannelIdFromSource", () => {
    it("returns the basename for a KChat source path", () => {
      const id = extractKchatChannelIdFromSource(KCHAT_SOURCE);
      expect(id).toBe(KCHAT_CHANNEL_ID);
    });

    it("returns null for a non-KChat source", () => {
      const folder: SourceInfo = {
        id: "src-local",
        sourceType: "local_folder",
        path: "/Users/me/Documents",
        status: "indexed",
        createdAt: "",
        lastIndexed: null,
        fileCount: 0,
      };
      expect(extractKchatChannelIdFromSource(folder)).toBeNull();
    });

    it("returns null for an empty KChat source path", () => {
      // Defensive: a malformed `source.path` of `""` or `"///"`
      // would produce an empty basename. The helper guards
      // against this so the polling hook stays quiescent
      // instead of issuing IPCs with `channelId: ""`.
      expect(
        extractKchatChannelIdFromSource({
          ...KCHAT_SOURCE,
          path: "",
        }),
      ).toBeNull();
      expect(
        extractKchatChannelIdFromSource({
          ...KCHAT_SOURCE,
          path: "///",
        }),
      ).toBeNull();
    });

    it("strips trailing slashes correctly", () => {
      // `kchatChannelCacheDir` doesn't emit trailing slashes, but
      // a future refactor could. The helper must tolerate them.
      expect(
        extractKchatChannelIdFromSource({
          ...KCHAT_SOURCE,
          path: `/home/u/.tessera/kchat-channels/${KCHAT_CHANNEL_ID}/`,
        }),
      ).toBe(KCHAT_CHANNEL_ID);
    });
  });

  describe("rendering", () => {
    it("renders the idle card with the placeholder copy", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "idle",
      });
      renderWithRoute();
      await waitFor(() => {
        expect(
          screen.getByTestId("kchat-backfill-card"),
        ).toBeInTheDocument();
      });
      const status = screen.getByTestId("kchat-backfill-status");
      expect(status).toHaveAttribute("data-status", "idle");
      expect(status.textContent).toMatch(/no walk has run yet/i);
    });

    it("renders the active card with the ingested counter and indeterminate progress", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: 1_700_000_000_000,
        totalPosts: null,
        postsIngested: 42,
        status: "active",
      });
      renderWithRoute();
      await waitFor(() => {
        expect(
          screen.getByTestId("kchat-backfill-card"),
        ).toBeInTheDocument();
      });
      const status = screen.getByTestId("kchat-backfill-status");
      expect(status).toHaveAttribute("data-status", "active");
      expect(status.textContent).toContain("42 posts ingested");
      const bar = screen.getByLabelText("KChat backfill progress");
      // Indeterminate: no `value` / `max` because totalPosts === null.
      expect(bar.tagName.toLowerCase()).toBe("progress");
      expect(bar).not.toHaveAttribute("value");
    });

    it("renders the active card with a determinate progress bar when totalPosts is known", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: 1_700_000_000_000,
        totalPosts: 100,
        postsIngested: 30,
        status: "active",
      });
      renderWithRoute();
      await waitFor(() => {
        expect(
          screen.getByTestId("kchat-backfill-card"),
        ).toBeInTheDocument();
      });
      const bar = screen.getByLabelText("KChat backfill progress");
      expect(bar).toHaveAttribute("value", "30");
      expect(bar).toHaveAttribute("max", "100");
    });

    it("renders the complete card with the oldestFetched timestamp", async () => {
      const epoch = 1_700_000_000_000;
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: epoch,
        totalPosts: null,
        postsIngested: 0,
        status: "complete",
      });
      renderWithRoute();
      await waitFor(() => {
        expect(
          screen.getByTestId("kchat-backfill-card"),
        ).toBeInTheDocument();
      });
      const status = screen.getByTestId("kchat-backfill-status");
      expect(status).toHaveAttribute("data-status", "complete");
      expect(status.textContent).toMatch(/history fetched back to/i);
    });

    it("renders the complete card without a timestamp when oldestFetched is null", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "complete",
      });
      renderWithRoute();
      await waitFor(() => {
        expect(
          screen.getByTestId("kchat-backfill-card"),
        ).toBeInTheDocument();
      });
      const status = screen.getByTestId("kchat-backfill-status");
      expect(status).toHaveAttribute("data-status", "complete");
      expect(status.textContent).toMatch(/channel history fully fetched/i);
    });

    it("renders the error card with the substrate error message", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "error",
        error: "bridge unavailable",
      });
      renderWithRoute();
      await waitFor(() => {
        expect(
          screen.getByTestId("kchat-backfill-card"),
        ).toBeInTheDocument();
      });
      const status = screen.getByTestId("kchat-backfill-status");
      expect(status).toHaveAttribute("data-status", "error");
      expect(status.textContent).toContain("bridge unavailable");
    });

    it("does NOT render the KChat card for a non-KChat (local_folder) source", async () => {
      window.tessera.sources.getDetail = vi.fn().mockResolvedValue({
        source: {
          id: "src-local",
          sourceType: "local_folder",
          path: "/Users/me/Documents",
          status: "indexed",
          createdAt: new Date().toISOString(),
          lastIndexed: null,
          fileCount: 3,
        },
        files: [],
      });
      renderWithRoute();
      // Wait for the page to render past the loading state by
      // looking for the (always-present) Re-embed button.
      await screen.findByTestId("reembed-button");
      expect(
        screen.queryByTestId("kchat-backfill-card"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("kchat-backfill-button"),
      ).not.toBeInTheDocument();
      // And the polling IPC must not have been called for a
      // non-KChat source (the hook stays quiescent for
      // `channelId === null`).
      expect(window.tessera.kchat.backfillProgress).not.toHaveBeenCalled();
    });
  });

  describe("manual trigger", () => {
    it("clicking Backfill posts calls kchat.backfillChannel exactly once with the channel id", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "idle",
      });
      window.tessera.kchat.backfillChannel = vi.fn().mockResolvedValue({
        outcome: "completed",
        pagesWalked: 1,
        totalPostsIngested: 0,
        totalPostsUnchanged: 0,
        totalPostsSkippedRevoked: 0,
      });
      renderWithRoute();
      const button = await screen.findByTestId("kchat-backfill-button");
      fireEvent.click(button);
      await waitFor(() => {
        expect(window.tessera.kchat.backfillChannel).toHaveBeenCalledTimes(1);
      });
      expect(window.tessera.kchat.backfillChannel).toHaveBeenCalledWith(
        KCHAT_CHANNEL_ID,
      );
    });

    it("disables the Backfill posts button while the IPC is in flight", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "idle",
      });
      let resolveBackfill: (value: unknown) => void = () => undefined;
      window.tessera.kchat.backfillChannel = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveBackfill = resolve;
          }),
      );
      renderWithRoute();
      const button = await screen.findByTestId("kchat-backfill-button");
      fireEvent.click(button);
      await waitFor(() => {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      });
      resolveBackfill({
        outcome: "completed",
        pagesWalked: 1,
        totalPostsIngested: 0,
        totalPostsUnchanged: 0,
        totalPostsSkippedRevoked: 0,
      });
      await waitFor(() => {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      });
    });

    it("disables the Backfill posts button while the poller reports status === \"active\"", async () => {
      // Defence-in-depth: even if the click handler isn't
      // currently in flight, an in-flight backfill seen by the
      // poller must keep the button disabled so the user can't
      // double-trigger.
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 5,
        status: "active",
      });
      renderWithRoute();
      const button = await screen.findByTestId("kchat-backfill-button");
      await waitFor(() => {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      });
      // The label flips to "Backfilling\u2026" to reflect the active
      // poller status.
      expect(button.textContent).toMatch(/Backfilling/i);
    });

    it("surfaces the IPC error in a dedicated banner when the manual trigger rejects", async () => {
      window.tessera.kchat.backfillProgress = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "idle",
      });
      window.tessera.kchat.backfillChannel = vi.fn().mockRejectedValue(
        new Error("Rate limit exceeded for sources:backfillKchatChannel"),
      );
      renderWithRoute();
      const button = await screen.findByTestId("kchat-backfill-button");
      fireEvent.click(button);
      await waitFor(() => {
        expect(screen.getByTestId("kchat-backfill-error")).toHaveTextContent(
          /Rate limit exceeded/i,
        );
      });
      // Button re-enables so the user can retry once the limiter
      // refills.
      await waitFor(() => {
        expect((button as HTMLButtonElement).disabled).toBe(false);
      });
    });
  });

  describe("polling lifecycle", () => {
    it("calls backfillProgress with the channel id on mount", async () => {
      const spy = vi.fn().mockResolvedValue({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "idle",
      });
      window.tessera.kchat.backfillProgress = spy;
      renderWithRoute();
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith(KCHAT_CHANNEL_ID);
      });
    });

    it("stops polling after unmount (cancellation guarantee)", async () => {
      // We can't easily observe the timer queue, but we CAN
      // observe that no new IPCs are issued after unmount. We
      // hold the first poll's promise pending, unmount, then
      // resolve it \u2014 the `cancelled` guard in the hook ensures
      // `setSnap` is never called and no follow-up timer is
      // scheduled, so no further IPC calls should fire.
      let resolvePoll: (value: unknown) => void = () => undefined;
      const spy = vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePoll = resolve;
          }),
      );
      window.tessera.kchat.backfillProgress = spy;
      const { unmount } = renderWithRoute();
      await waitFor(() => {
        expect(spy).toHaveBeenCalledTimes(1);
      });
      unmount();
      // Resolve the pending poll AFTER unmount; the hook's
      // `cancelled` guard must suppress the setState and prevent
      // scheduling a follow-up timer.
      resolvePoll({
        channelId: KCHAT_CHANNEL_ID,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: "idle",
      });
      // Give the microtask queue + any timer slot 50 ms to fire
      // if the cleanup were broken. The poll IPC count must
      // stay at 1.
      await new Promise((r) => setTimeout(r, 50));
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });
});
