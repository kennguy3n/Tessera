import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useKchatBackfillProgress } from "../hooks/useKchatBackfillProgress";

/**
 * Hook-level tests for `useKchatBackfillProgress`.
 *
 * The component-level tests in `sourceDetailKchatBackfill.test.tsx`
 * cover the full SourceDetailPage projection of every status
 * branch; this file pins the polling-loop semantics in isolation —
 * specifically the transport-error surfacing introduced by Devin
 * Review pass 3 on d7290e0.
 *
 * The fix preserves the self-heal property (a transient transport
 * failure does not flicker the UI from a valid snapshot into an
 * error) while ensuring a permanently broken bridge can't pin the
 * card in a silent "Loading…" state indefinitely.
 */
describe("useKchatBackfillProgress", () => {
  const CHANNEL_ID = "chid26charactersaaaaaaaaaa";
  const TICK = 25;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null while no channelId is supplied (quiescent)", async () => {
    const spy = vi.fn();
    window.tessera.kchat.backfillProgress = spy;
    const { result } = renderHook(() =>
      useKchatBackfillProgress(null, TICK),
    );
    // Give the queue a few ticks to be sure the hook didn't poll.
    await new Promise((r) => setTimeout(r, 60));
    expect(result.current).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("surfaces the IPC's snapshot on the first successful poll", async () => {
    const snap = {
      channelId: CHANNEL_ID,
      oldestFetched: 1700,
      totalPosts: null,
      postsIngested: 2,
      status: "active" as const,
    };
    window.tessera.kchat.backfillProgress = vi
      .fn()
      .mockResolvedValue(snap);
    const { result } = renderHook(() =>
      useKchatBackfillProgress(CHANNEL_ID, TICK),
    );
    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current).toEqual(snap);
  });

  it("rides out 1\u20132 consecutive transport failures without surfacing an error (self-heal preserved,", async () => {
    // Two failing ticks (below threshold), then a successful tick.
    // The hook must NOT emit a synthetic error view; the eventual
    // success snapshot must surface to the caller unchanged.
    const snap = {
      channelId: CHANNEL_ID,
      oldestFetched: 1500,
      totalPosts: null,
      postsIngested: 5,
      status: "active" as const,
    };
    const spy = vi
      .fn()
      .mockRejectedValueOnce(new Error("transport blip 1"))
      .mockRejectedValueOnce(new Error("transport blip 2"))
      .mockResolvedValue(snap);
    window.tessera.kchat.backfillProgress = spy;

    const { result } = renderHook(() =>
      useKchatBackfillProgress(CHANNEL_ID, TICK),
    );

    // Wait until the success path lands. The intermediate failing
    // polls must NEVER have surfaced a synthetic error view to
    // the caller \u2014 the previous snapshot (`null`, since this is
    // the first run) is held.
    await waitFor(() => {
      expect(result.current).toEqual(snap);
    });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("surfaces a synthetic `status: \"error\"` view after \u2265 3 consecutive transport failures", async () => {
    // The hook keeps polling even after surfacing the error \u2014
    // the loop self-heals on the next successful tick. Here the
    // mock keeps rejecting so the synthetic error sticks.
    const spy = vi
      .fn()
      .mockRejectedValue(new Error("preload bridge missing"));
    window.tessera.kchat.backfillProgress = spy;

    const { result } = renderHook(() =>
      useKchatBackfillProgress(CHANNEL_ID, TICK),
    );

    await waitFor(
      () => {
        expect(result.current).not.toBeNull();
      },
      { timeout: 2000 },
    );
    // Match the structural shape: synthetic transport-error view.
    expect(result.current!.status).toBe("error");
    expect(result.current!.channelId).toBe(CHANNEL_ID);
    expect(result.current!.oldestFetched).toBeNull();
    expect(result.current!.totalPosts).toBeNull();
    expect(result.current!.postsIngested).toBe(0);
    expect(result.current!.error).toMatch(/transport failure/i);
  });

  it("self-heals: a successful tick AFTER the synthetic error replaces it with the live snapshot", async () => {
    // 3 failures \u2192 synthetic error surfaces; 4th call (held
    // pending) gives the error a chance to settle in `result`;
    // resolving the 4th \u2192 hook replaces the synthetic error
    // with the new live snapshot. This pins the self-heal
    // property: the polling loop never gives up, and the
    // surfaced error is transient.
    const liveSnap = {
      channelId: CHANNEL_ID,
      oldestFetched: 1900,
      totalPosts: null,
      postsIngested: 9,
      status: "active" as const,
    };
    let resolveFourth!: (v: unknown) => void;
    const fourthPending = new Promise<unknown>((resolve) => {
      resolveFourth = resolve;
    });
    const spy = vi
      .fn()
      .mockRejectedValueOnce(new Error("blip 1"))
      .mockRejectedValueOnce(new Error("blip 2"))
      .mockRejectedValueOnce(new Error("blip 3"))
      .mockReturnValueOnce(fourthPending)
      .mockResolvedValue(liveSnap);
    window.tessera.kchat.backfillProgress = spy;

    const { result } = renderHook(() =>
      useKchatBackfillProgress(CHANNEL_ID, TICK),
    );

    // First: wait for the synthetic error to surface (held in
    // place because the 4th call is pending).
    await waitFor(
      () => {
        expect(result.current?.status).toBe("error");
      },
      { timeout: 2000 },
    );
    expect(spy).toHaveBeenCalledTimes(4);

    // Then: resolve the 4th call and assert the snapshot replaces
    // the synthetic error.
    act(() => {
      resolveFourth(liveSnap);
    });
    await waitFor(
      () => {
        expect(result.current).toEqual(liveSnap);
      },
      { timeout: 2000 },
    );
  });

  it("resets the consecutive-failure counter on a successful tick", async () => {
    // Sequence: success, fail, fail, success, fail, fail, then
    // hold the 7th call pending. None of the failure windows hit
    // 3 consecutive without an intermediate success, and the
    // pending 7th call freezes the polling loop \u2014 so the
    // synthetic error MUST NOT surface; the hook should hold the
    // last good snapshot (`b`) across the post-`b` failure pair.
    const a = {
      channelId: CHANNEL_ID,
      oldestFetched: 1000,
      totalPosts: null,
      postsIngested: 1,
      status: "active" as const,
    };
    const b = {
      channelId: CHANNEL_ID,
      oldestFetched: 900,
      totalPosts: null,
      postsIngested: 3,
      status: "active" as const,
    };
    const seventhPending = new Promise<unknown>(() => {
      // Never resolves \u2014 freezes the polling loop after the
      // 6th call lands. The cleanup function (unmount on test
      // teardown) cancels the hook, so this pending promise
      // doesn't leak.
    });
    const spy = vi
      .fn()
      .mockResolvedValueOnce(a)
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockResolvedValueOnce(b)
      .mockRejectedValueOnce(new Error("blip"))
      .mockRejectedValueOnce(new Error("blip"))
      .mockReturnValueOnce(seventhPending);
    window.tessera.kchat.backfillProgress = spy;

    const { result } = renderHook(() =>
      useKchatBackfillProgress(CHANNEL_ID, TICK),
    );

    // Eventually settle on `b` (the second successful tick).
    await waitFor(
      () => {
        expect(result.current).toEqual(b);
      },
      { timeout: 2000 },
    );

    // Wait until 6 calls have landed (the post-`b` failure pair
    // completes). The 7th is pending and freezes the loop here.
    await waitFor(
      () => {
        expect(spy.mock.calls.length).toBeGreaterThanOrEqual(6);
      },
      { timeout: 2000 },
    );
    // Counter sits at exactly 2 (below threshold), and the next
    // tick is frozen on the pending 7th call. The snapshot must
    // remain `b` indefinitely.
    expect(result.current).toEqual(b);
  });

  it("does NOT surface a synthetic error after unmount even if a failing tick was in flight (cancellation)", async () => {
    // Reject the first tick AFTER unmount; the `cancelled` guard
    // must short-circuit the threshold check so we never set
    // state on an unmounted component (React would warn) and so a
    // stale failure counter from a previous mount can't leak.
    let rejectFirst!: (e: unknown) => void;
    const pending = new Promise<unknown>((_, reject) => {
      rejectFirst = reject;
    });
    const spy = vi.fn().mockReturnValueOnce(pending);
    window.tessera.kchat.backfillProgress = spy;

    const { result, unmount } = renderHook(() =>
      useKchatBackfillProgress(CHANNEL_ID, TICK),
    );
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    unmount();
    // Resolve as rejection AFTER unmount.
    act(() => {
      rejectFirst(new Error("post-unmount"));
    });
    // Give the microtask queue + a few ticks to fire if the
    // cancellation guard were broken.
    await new Promise((r) => setTimeout(r, 80));
    // `result.current` is captured at the last render before
    // unmount; the post-unmount rejection must NOT have set state.
    expect(result.current).toBeNull();
  });
});
