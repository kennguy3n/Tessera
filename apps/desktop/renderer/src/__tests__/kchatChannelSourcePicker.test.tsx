import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import KchatChannelSourcePicker from "../components/KchatChannelSourcePicker";
import { ToastProvider } from "../components/Toast";

function makeApi(overrides: Partial<typeof window.tessera.kchat> = {}) {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    status: vi.fn().mockResolvedValue({ state: "connected" }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTeams: vi.fn().mockResolvedValue([
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
    ]),
    listMembers: vi.fn(),
    listChannelFiles: vi.fn().mockResolvedValue([
      {
        id: "f-1",
        name: "spec.pdf",
        extension: "pdf",
        mime_type: "application/pdf",
        size: 2048,
        create_at: 1700000000000,
        update_at: 1700000000000,
      },
    ]),
    shareArtifact: vi.fn(),
    addChannelSource: vi.fn().mockResolvedValue({
      sourceId: "src-kchat-1",
      cacheDir: "/cache/kchat/chan-1",
    }),
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as typeof window.tessera.kchat;
}

function wrap(node: React.ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("KchatChannelSourcePicker", () => {
  it("renders teams, channels, and a file preview", async () => {
    const api = makeApi();
    wrap(
      <KchatChannelSourcePicker
        isOpen
        onClose={() => {}}
        api={api}
      />,
    );
    expect(await screen.findByTestId("kchat-source-team")).toBeInTheDocument();
    await waitFor(() => expect(api.listChannels).toHaveBeenCalledWith("team-1"));
    await waitFor(() => expect(api.listChannelFiles).toHaveBeenCalledWith("chan-1", 0, 50));
    const list = await screen.findByTestId("kchat-source-file-list");
    expect(list).toHaveTextContent("spec.pdf");
  });

  it("calls addChannelSource and onAdded when Add is clicked", async () => {
    const api = makeApi();
    const onAdded = vi.fn();
    wrap(
      <KchatChannelSourcePicker
        isOpen
        onClose={() => {}}
        onAdded={onAdded}
        api={api}
      />,
    );
    await screen.findByTestId("kchat-source-add");
    // Wait for the full settle chain to converge before clicking. The
    // picker has three sequential effects:
    //   1. `useEffect[isOpen, kchat]` → `listTeams` → `setSelectedTeam`
    //   2. `useEffect[isOpen, kchat, selectedTeam]` → `listChannels` →
    //      `setSelectedChannel`
    //   3. `useEffect[isOpen, kchat, selectedChannel]` →
    //      `listChannelFiles` → `setFiles`
    // The Add button is `disabled={busy || !selectedChannel}`, so
    // clicking before step 2's `setSelectedChannel` commit re-renders
    // makes the click a no-op (the browser drops events on disabled
    // buttons, and `fireEvent.click` honours that). Waiting only for
    // `listChannels` to have been *called* satisfies the spy assertion
    // before the resulting state commit lands, racing the click under
    // CI's parallel-suite CPU pressure. Wait for the file-list render
    // — that's a guaranteed-after-step-3 signal that the entire chain
    // has settled and the button is enabled. Devin Review on PR #43
    // flagged this race pattern in earlier Block A passes; the same
    // architectural fix applies here.
    await waitFor(() =>
      expect(api.listChannelFiles).toHaveBeenCalledWith("chan-1", 0, 50),
    );
    await screen.findByText("spec.pdf");
    fireEvent.click(screen.getByTestId("kchat-source-add"));
    await waitFor(() =>
      expect(api.addChannelSource).toHaveBeenCalledWith("chan-1", "General"),
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("src-kchat-1"));
  });

  it("surfaces an add-source error inline", async () => {
    const api = makeApi({
      addChannelSource: vi
        .fn()
        .mockRejectedValue(new Error("network error")),
    });
    wrap(
      <KchatChannelSourcePicker isOpen onClose={() => {}} api={api} />,
    );
    await screen.findByTestId("kchat-source-add");
    // Same settle-chain wait as the success-path test above — the
    // Add button is disabled until `selectedChannel` commits, and a
    // racy click before that commit silently no-ops.
    await waitFor(() =>
      expect(api.listChannelFiles).toHaveBeenCalledWith("chan-1", 0, 50),
    );
    await screen.findByText("spec.pdf");
    fireEvent.click(screen.getByTestId("kchat-source-add"));
    expect(await screen.findByTestId("kchat-source-error")).toHaveTextContent(
      /network error/,
    );
  });
});
