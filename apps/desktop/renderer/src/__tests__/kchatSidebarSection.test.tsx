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
        first_name: "A",
        last_name: "A",
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
