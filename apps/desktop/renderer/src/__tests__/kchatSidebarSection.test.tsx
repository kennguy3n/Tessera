import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import KchatSidebarSection from "../components/KchatSidebarSection";

function makeApi(overrides: Partial<typeof window.tessera.kchat> = {}) {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    status: vi.fn().mockResolvedValue({
      state: "connected",
      user: {
        id: "u1",
        username: "alice",
        email: "a@x",
        firstName: "A",
        lastName: "A",
      },
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTeams: vi
      .fn()
      .mockResolvedValue([
        { id: "team-1", name: "t1", display_name: "T1", type: "O" },
      ]),
    listChannels: vi.fn().mockResolvedValue([
      {
        id: "chan-1",
        team_id: "team-1",
        name: "general",
        display_name: "General",
        type: "O",
      },
      {
        id: "chan-2",
        team_id: "team-1",
        name: "side",
        display_name: "Side",
        type: "P",
      },
    ]),
    listMembers: vi.fn(),
    listChannelFiles: vi.fn().mockResolvedValue([
      // create_at far in the future relative to lastSeen=0, so this
      // counts as unread.
      {
        id: "f1",
        name: "doc.pdf",
        extension: "pdf",
        mime_type: "application/pdf",
        size: 100,
        create_at: 1_700_000_000_000,
        update_at: 1_700_000_000_000,
      },
    ]),
    shareArtifact: vi.fn(),
    addChannelSource: vi.fn(),
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}),
    desktopBridgeStatus: vi.fn().mockResolvedValue({
      apiServerRunning: true,
      apiServerPort: 51234,
      portFilePath: "/tmp/tessera-kchat-port.json",
      lastExtensionContactAt: null,
    }),
    openInDesktop: vi
      .fn()
      .mockResolvedValue({ opened: true, url: "kchat://" }),
    openDesktopExtensions: vi
      .fn()
      .mockResolvedValue({ opened: true, url: "kchat://" }),
    ...overrides,
  } as unknown as typeof window.tessera.kchat;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("KchatSidebarSection", () => {
  it("renders nothing when disconnected", async () => {
    const api = makeApi({
      status: vi.fn().mockResolvedValue({ state: "disconnected" }),
    });
    const { container } = render(<KchatSidebarSection api={api} />);
    await waitFor(() => expect(api.status).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="kchat-sidebar"]')).toBeNull();
  });

  it("renders the user + channel count when connected", async () => {
    const api = makeApi();
    render(<KchatSidebarSection api={api} />);
    expect(await screen.findByTestId("kchat-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("kchat-sidebar-user")).toHaveTextContent("@alice");
    // The channel list is fetched asynchronously after the
    // connect status resolves; wait for the second effect to land.
    await waitFor(() =>
      expect(screen.getByTestId("kchat-sidebar-channels")).toHaveTextContent(
        "2 channels",
      ),
    );
  });

  it("shows an unread badge for new files; clicking the badge clears it", async () => {
    const api = makeApi();
    render(<KchatSidebarSection api={api} />);
    await screen.findByTestId("kchat-sidebar");
    // The unread badge should appear once listChannelFiles resolves
    // and the polled count > 0.
    const badge = await screen.findByTestId("kchat-unread-badge");
    expect(badge).toHaveTextContent("2"); // one new file per channel × 2
    fireEvent.click(badge);
    await waitFor(() =>
      expect(
        screen.queryByTestId("kchat-unread-badge"),
      ).not.toBeInTheDocument(),
    );
  });

  it("stops polling kchat.status() when isAvailable() returns false", async () => {
    // When the KChat feature is gated off (enterprise licence not
    // active, future opt-out flag, etc.), `isAvailable()` returns
    // false and the component renders `null`. The 10s status-probe
    // interval must NOT continue firing in that state — otherwise
    // the page would burn an IPC call every tick for its entire
    // lifetime. Regression pin for
    // (fifth pass).
    const status = vi.fn().mockResolvedValue({ state: "disconnected" });
    const api = makeApi({
      isAvailable: vi.fn().mockResolvedValue(false),
      status,
    });
    const { container } = render(<KchatSidebarSection api={api} />);
    // Let the initial probe resolve (it learns `available=false`
    // and bails) and React commit the re-render.
    await waitFor(() => expect(api.isAvailable).toHaveBeenCalledTimes(1));
    // Nothing rendered — the feature is unavailable.
    expect(
      container.querySelector('[data-testid="kchat-sidebar"]'),
    ).toBeNull();
    // The initial probe MAY have invoked `status` once before the
    // effect re-ran with `available=false` (race-free with the
    // `if (available === null)` gate above), but importantly: now
    // that `available` is `false`, neither `status` nor
    // `isAvailable` should fire again, no matter how much time
    // passes.
    const statusCallsAfterProbe = status.mock.calls.length;
    const isAvailableCallsAfterProbe = (
      api.isAvailable as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    // Advance past one full 30 s reconciliation tick. The interval
    // cadence was bumped from 10 s → 30 s in Block B Task 1 when
    // push delivery via `kchat:status` took over the common-path
    // load (the 30 s value matches POLL_INTERVAL_MS for the file
    // reconciliation poll). With the bug present, the interval
    // would fire and issue another `status` call; with the fix,
    // the effect's `available === false` short-circuit at the
    // top of `probe` returns before either IPC fires.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(status.mock.calls.length).toBe(statusCallsAfterProbe);
    expect(
      (api.isAvailable as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(isAvailableCallsAfterProbe);
  });

  it("does not fire downstream effects when a status push lands while isAvailable() is in flight and resolves false", async () => {
    // Twelfth-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0002`) flagged a narrow race:
    // the `onStatusChange` subscription is installed
    // synchronously on mount BEFORE `isAvailable()` resolves
    // (deliberate so a transition during the round-trip is not
    // lost). If a `"connected"` push arrives during that window
    // and `isAvailable()` then resolves false, the previous
    // implementation would have fired the channel-fetch effect,
    // installed the `onEvent` listener, and armed the unread
    // poll for a feature that's gated off — burning rate-limit
    // tokens and holding an IPC listener until the next state
    // change.
    //
    // Fix gated all three downstream effects on `available ===
    // true` (not just `state.state === "connected"`), mirroring
    // the render-time gate at the bottom of the component. This
    // test pins the race shape and asserts none of the three
    // downstream IPCs fire.
    let resolveIsAvailable: ((v: boolean) => void) | null = null;
    const isAvailable = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((r) => {
          resolveIsAvailable = r;
        }),
    );
    let pushStatus: ((s: unknown) => void) | null = null;
    const onStatusChange = vi.fn().mockImplementation(
      (cb: (s: unknown) => void) => {
        pushStatus = cb;
        return () => {};
      },
    );
    const listTeams = vi.fn().mockResolvedValue([]);
    const listChannels = vi.fn().mockResolvedValue([]);
    const listChannelFiles = vi.fn().mockResolvedValue([]);
    const onEvent = vi.fn().mockReturnValue(() => {});
    const api = makeApi({
      isAvailable,
      onStatusChange,
      listTeams,
      listChannels,
      listChannelFiles,
      onEvent,
      // The initial `status()` call also resolves with a
      // `"connected"` value — without the gate this would also
      // trigger the downstream effects via the initial probe path
      // even before the push lands.
      status: vi.fn().mockResolvedValue({
        state: "connected",
        user: {
          id: "u1",
          username: "alice",
          email: "a@x",
          firstName: "A",
          lastName: "A",
        },
      }),
    });
    render(<KchatSidebarSection api={api} />);
    // Race-window: isAvailable is in flight, push fires.
    await waitFor(() => expect(onStatusChange).toHaveBeenCalled());
    expect(pushStatus).not.toBeNull();
    // Simulate a `connected` push arriving DURING the
    // `isAvailable()` round-trip while `available === null`.
    pushStatus!({
      state: "connected",
      user: {
        id: "u1",
        username: "alice",
        email: "a@x",
        firstName: "A",
        lastName: "A",
      },
    });
    // Resolve isAvailable to false AFTER the push. Without the
    // gate fix, the downstream effects would already have fired
    // by the time React commits the `available=false` re-render.
    expect(resolveIsAvailable).not.toBeNull();
    resolveIsAvailable!(false);
    // Give React a chance to flush all effect re-runs.
    await waitFor(() => expect(isAvailable).toHaveBeenCalledTimes(1));
    // Advance past one full reconciliation tick so any latent
    // poll arming would have fired by now.
    await vi.advanceTimersByTimeAsync(35_000);
    // The component should render nothing (feature gated off).
    expect(
      screen.queryByTestId("kchat-sidebar"),
    ).not.toBeInTheDocument();
    // None of the three downstream IPCs should have fired. The
    // pre-fix shape would have called `listTeams` (via the
    // channel-fetch effect) and `onEvent` (via the WS listener
    // install), and armed the recursive poll.
    expect(listTeams).not.toHaveBeenCalled();
    expect(listChannels).not.toHaveBeenCalled();
    expect(listChannelFiles).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("caps per-poll listChannelFiles fan-out to MAX_POLL_CHANNELS", async () => {
    // 25 channels in the default team — the sidebar must only fetch
    // file lists for the first MAX_POLL_CHANNELS (= 10) to avoid
    // burning the global kchat:request token-bucket budget every
    // poll tick. Channels beyond the cap silently don't contribute
    // to the unread count.
    const channels = Array.from({ length: 25 }, (_, i) => ({
      id: `chan-${i}`,
      team_id: "team-1",
      name: `c${i}`,
      display_name: `C${i}`,
      type: "O" as const,
    }));
    const filesByChannel = new Map<string, unknown[]>();
    for (const c of channels) {
      filesByChannel.set(c.id, [
        {
          id: `f-${c.id}`,
          name: "doc.pdf",
          extension: "pdf",
          mime_type: "application/pdf",
          size: 100,
          create_at: 1_700_000_000_000,
          update_at: 1_700_000_000_000,
        },
      ]);
    }
    const listChannelFiles = vi
      .fn()
      .mockImplementation(async (chId: string) =>
        filesByChannel.get(chId) ?? [],
      );
    const api = makeApi({
      listChannels: vi.fn().mockResolvedValue(channels),
      listChannelFiles,
    });
    render(<KchatSidebarSection api={api} />);
    await screen.findByTestId("kchat-sidebar");
    // Wait for the initial poll cycle to flush.
    await waitFor(() => expect(listChannelFiles).toHaveBeenCalled());
    // Settle any async effects.
    await waitFor(() =>
      expect(screen.getByTestId("kchat-sidebar-channels")).toHaveTextContent(
        "25 channels",
      ),
    );
    // Exactly 10 IPC calls — one per polled channel, capped by
    // MAX_POLL_CHANNELS — and they should be the first 10 channel
    // ids in order.
    expect(listChannelFiles.mock.calls).toHaveLength(10);
    const calledIds = listChannelFiles.mock.calls.map((c) => c[0]);
    expect(calledIds).toEqual(
      channels.slice(0, 10).map((c) => c.id),
    );
  });
});

// Eleventh-pass: the unread-count poll
// must NOT overlap itself when `listChannelFiles` runs slow. With
// the old `setInterval` form, two cycles would stack against the
// global `kchat:request` rate-limit budget if a poll took longer
// than `POLL_INTERVAL_MS`; we switched to recursive `setTimeout`
// so cycle N+1 only schedules after cycle N's Promise has settled.
//
// The test pins `listChannelFiles` to a manually-resolved Promise
// so cycle 1 is "stuck" indefinitely, then advances fake timers
// past `POLL_INTERVAL_MS` and asserts no additional calls were
// issued. After we settle cycle 1 the next tick fires and a
// fresh batch arrives.
describe("KchatSidebarSection — unread poll does not overlap when slow (eleventh-pass invariant)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the in-flight poll to settle before scheduling the next tick", async () => {
    const channels = Array.from({ length: 5 }, (_, i) => ({
      id: `chan-${i}`,
      team_id: "team-1",
      name: `c${i}`,
      display_name: `C${i}`,
      type: "O" as const,
    }));
    // Build a queue of resolvers so each `listChannelFiles` call
    // returns a Promise we can resolve at-will from the test body.
    const resolvers: Array<(v: unknown[]) => void> = [];
    const listChannelFiles = vi.fn().mockImplementation(() => {
      return new Promise<unknown[]>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const api = makeApi({
      listChannels: vi.fn().mockResolvedValue(channels),
      listChannelFiles,
    });
    render(<KchatSidebarSection api={api} />);

    // First poll fires immediately after the channel list settles;
    // wait until exactly one channel's file fetch has been issued.
    // We don't wait for all 5 because the loop is serial: only the
    // first call is in-flight while we're "stuck" inside its await.
    await waitFor(() => expect(listChannelFiles).toHaveBeenCalledTimes(1));
    expect(listChannelFiles.mock.calls[0][0]).toBe("chan-0");

    // Advance the clock past 3 × POLL_INTERVAL_MS while the first
    // poll is still stuck. With the old `setInterval` form, the
    // 2nd and 3rd interval ticks would fire and issue further
    // calls (each into chan-0 again). With recursive `setTimeout`
    // chaining, NO further calls happen until the in-flight
    // Promise settles.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(listChannelFiles).toHaveBeenCalledTimes(1);

    // Drain the rest of the first poll cycle by resolving each
    // channel's Promise in turn. Each resolve unblocks the serial
    // loop and triggers the next call.
    for (let i = 0; i < channels.length; i += 1) {
      // Wait for the next resolver to land in the queue.
      await waitFor(() => expect(resolvers.length).toBeGreaterThanOrEqual(i + 1));
      resolvers[i]([]);
    }
    await waitFor(() =>
      expect(listChannelFiles).toHaveBeenCalledTimes(channels.length),
    );

    // Now that the first poll has fully settled, the recursive
    // setTimeout has scheduled the next tick. Advance past the
    // interval and verify a second batch starts.
    await vi.advanceTimersByTimeAsync(30_000);
    await waitFor(() =>
      expect(listChannelFiles).toHaveBeenCalledTimes(channels.length + 1),
    );
    expect(listChannelFiles.mock.calls[channels.length][0]).toBe("chan-0");
  });
});

// Twelfth-pass: when the sidebar is
// unmounted while a poll cycle is mid-flight, the in-flight
// `listChannelFiles` Promise still resolves, and the awaiting
// `pollUnread` continues running through to `setUnread`. React 18
// silently no-ops state updates on unmounted components, but
// stricter future modes surface a warning, and the wasted rate-
// limiter tokens are real today. We pass an `isCancelled` getter
// into `pollUnread` that the effect's `cancelled` flag flips on
// teardown; the cycle then short-circuits both before issuing each
// `listChannelFiles` call and right before `setUnread`.
//
// We can observe the short-circuit indirectly: after unmount,
// resolving the in-flight Promise should NOT lead to additional
// `listChannelFiles` calls (the cancellation aborts the serial
// loop), and no state-update warning should be emitted. We can also
// observe directly: the effect's cleanup runs before the Promise
// settles, so a teardown that arrives between channel 1 and channel
// 2 of a cycle leaves the channel-2+ requests unfired.
describe("KchatSidebarSection — unread poll short-circuits on unmount (twelfth-pass invariant)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not issue further `listChannelFiles` calls once the component has unmounted", async () => {
    const channels = Array.from({ length: 5 }, (_, i) => ({
      id: `chan-${i}`,
      team_id: "team-1",
      name: `c${i}`,
      display_name: `C${i}`,
      type: "O" as const,
    }));
    const resolvers: Array<(v: unknown[]) => void> = [];
    const listChannelFiles = vi.fn().mockImplementation(() => {
      return new Promise<unknown[]>((resolve) => {
        resolvers.push(resolve);
      });
    });
    const api = makeApi({
      listChannels: vi.fn().mockResolvedValue(channels),
      listChannelFiles,
    });
    const { unmount } = render(<KchatSidebarSection api={api} />);

    // Wait until the first call is in-flight, then unmount while
    // the cycle is stuck on chan-0's resolver.
    await waitFor(() => expect(listChannelFiles).toHaveBeenCalledTimes(1));
    expect(listChannelFiles.mock.calls[0][0]).toBe("chan-0");

    unmount();

    // Resolve chan-0. With the cancellation token plumbed into
    // `pollUnread`, the next iteration of the loop checks
    // `isCancelled?.()` and returns BEFORE issuing chan-1's call.
    // Without the fix, chan-1, chan-2, … would fire as the loop
    // continues to drain.
    resolvers[0]([]);
    // Give the microtask queue a chance to advance the loop past
    // the (now-cancelled) `isCancelled` check.
    await vi.advanceTimersByTimeAsync(0);

    expect(listChannelFiles).toHaveBeenCalledTimes(1);

    // Advance through several poll intervals — confirm no further
    // ticks fire either (the effect cleanup cleared the pending
    // setTimeout AND the `cancelled` getter short-circuits any
    // already-in-flight cycle).
    await vi.advanceTimersByTimeAsync(120_000);
    expect(listChannelFiles).toHaveBeenCalledTimes(1);
  });
});

// Block B Task 1: live WebSocket push of `file_added`
// events from the main process drives the unread badge without
// waiting for the 30 s reconciliation poll. The renderer
// subscribes via `kchat.onEvent(...)`; the main-process
// forwarder calls the listener with a flattened
// `KchatWebSocketEventPayload`. We verify the badge increments
// on a `file_added` event for a channel in the live list AND
// remains untouched for an event for a channel we're not
// rendering, an event older than `lastSeen`, or a non-
// file_added event type.
describe("KchatSidebarSection — WebSocket push increments unread badge (Block B Task 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("increments the badge on a file_added event for a live channel", async () => {
    // Hold the file-poll Promise open so the reconciliation
    // path can't race the WS-driven increment.
    const listChannelFiles = vi.fn().mockReturnValue(new Promise(() => {}));
    let onEventListener:
      | ((e: import("../../../shared/types").KchatWebSocketEventPayload) => void)
      | null = null;
    const onEvent = vi.fn().mockImplementation((cb: (e: unknown) => void) => {
      onEventListener = cb as typeof onEventListener;
      return () => {
        onEventListener = null;
      };
    });
    const api = makeApi({ listChannelFiles, onEvent });
    render(<KchatSidebarSection api={api} />);
    await screen.findByTestId("kchat-sidebar");
    // Wait until the WS subscription has been installed by the
    // post-connect effect.
    await waitFor(() => expect(onEvent).toHaveBeenCalled());
    expect(onEventListener).not.toBeNull();

    // Push two `file_added` events for live channels — both
    // should increment the badge. We use a `create_at` far in
    // the future so it post-dates `lastSeen=0`.
    onEventListener!({
      event: "file_added",
      channelId: "chan-1",
      teamId: "team-1",
      userId: "u1",
      seq: 1,
      data: { file_id: "f-A", create_at: 1_900_000_000_000 },
    });
    onEventListener!({
      event: "file_added",
      channelId: "chan-2",
      teamId: "team-1",
      userId: "u1",
      seq: 2,
      data: { file_id: "f-B", create_at: 1_900_000_000_000 },
    });
    await waitFor(() => {
      const badge = screen.getByTestId("kchat-unread-badge");
      expect(badge).toHaveTextContent("2");
    });
  });

  it("ignores file_added events for channels not in the live list", async () => {
    const listChannelFiles = vi.fn().mockReturnValue(new Promise(() => {}));
    let onEventListener:
      | ((e: import("../../../shared/types").KchatWebSocketEventPayload) => void)
      | null = null;
    const onEvent = vi.fn().mockImplementation((cb: (e: unknown) => void) => {
      onEventListener = cb as typeof onEventListener;
      return () => {
        onEventListener = null;
      };
    });
    const api = makeApi({ listChannelFiles, onEvent });
    render(<KchatSidebarSection api={api} />);
    await screen.findByTestId("kchat-sidebar");
    await waitFor(() => expect(onEvent).toHaveBeenCalled());

    onEventListener!({
      event: "file_added",
      channelId: "chan-other-team",
      teamId: "team-other",
      userId: "u1",
      seq: 1,
      data: { file_id: "f-X", create_at: 1_900_000_000_000 },
    });
    // Give React a tick to render any spurious badge.
    await vi.advanceTimersByTimeAsync(50);
    expect(screen.queryByTestId("kchat-unread-badge")).toBeNull();
  });

  it("ignores file_added events older than the last-seen timestamp", async () => {
    window.localStorage.setItem(
      "tessera.kchat.lastSeenAt",
      "1_800_000_000_000".replace(/_/g, ""),
    );
    const listChannelFiles = vi.fn().mockReturnValue(new Promise(() => {}));
    let onEventListener:
      | ((e: import("../../../shared/types").KchatWebSocketEventPayload) => void)
      | null = null;
    const onEvent = vi.fn().mockImplementation((cb: (e: unknown) => void) => {
      onEventListener = cb as typeof onEventListener;
      return () => {
        onEventListener = null;
      };
    });
    const api = makeApi({ listChannelFiles, onEvent });
    render(<KchatSidebarSection api={api} />);
    await screen.findByTestId("kchat-sidebar");
    await waitFor(() => expect(onEvent).toHaveBeenCalled());

    // File predates lastSeen; must NOT increment.
    onEventListener!({
      event: "file_added",
      channelId: "chan-1",
      teamId: "team-1",
      userId: "u1",
      seq: 1,
      data: { file_id: "f-old", create_at: 1_700_000_000_000 },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(screen.queryByTestId("kchat-unread-badge")).toBeNull();
  });

  it("ignores non-file_added event types", async () => {
    const listChannelFiles = vi.fn().mockReturnValue(new Promise(() => {}));
    let onEventListener:
      | ((e: import("../../../shared/types").KchatWebSocketEventPayload) => void)
      | null = null;
    const onEvent = vi.fn().mockImplementation((cb: (e: unknown) => void) => {
      onEventListener = cb as typeof onEventListener;
      return () => {
        onEventListener = null;
      };
    });
    const api = makeApi({ listChannelFiles, onEvent });
    render(<KchatSidebarSection api={api} />);
    await screen.findByTestId("kchat-sidebar");
    await waitFor(() => expect(onEvent).toHaveBeenCalled());

    onEventListener!({
      event: "posted",
      channelId: "chan-1",
      teamId: "team-1",
      userId: "u1",
      seq: 1,
      data: { post: "hi" },
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(screen.queryByTestId("kchat-unread-badge")).toBeNull();
  });

  it("unsubscribes from kchat.onEvent on unmount", async () => {
    const unsubscribe = vi.fn();
    const onEvent = vi.fn().mockReturnValue(unsubscribe);
    const api = makeApi({
      listChannelFiles: vi.fn().mockReturnValue(new Promise(() => {})),
      onEvent,
    });
    const { unmount } = render(<KchatSidebarSection api={api} />);
    await screen.findByTestId("kchat-sidebar");
    await waitFor(() => expect(onEvent).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
