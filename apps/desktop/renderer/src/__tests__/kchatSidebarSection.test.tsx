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
    // lifetime. Regression pin for Devin Review ANALYSIS_0005
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
    // Advance well past several 10s ticks. With the bug present, the
    // interval would fire 3 more times → 3 more `status` calls.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(status.mock.calls.length).toBe(statusCallsAfterProbe);
    expect(
      (api.isAvailable as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(isAvailableCallsAfterProbe);
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

// Eleventh-pass Devin Review ANALYSIS_0004: the unread-count poll
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
