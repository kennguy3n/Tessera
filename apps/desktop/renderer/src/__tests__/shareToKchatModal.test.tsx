import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import ShareToKchatModal from "../components/ShareToKchatModal";
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
      { id: "chan-1", team_id: "team-1", name: "general", display_name: "General", type: "O" },
      { id: "chan-2", team_id: "team-1", name: "priv", display_name: "Private", type: "P" },
      { id: "chan-3", team_id: "team-1", name: "dm", display_name: "DM", type: "D" },
    ]),
    listMembers: vi.fn(),
    listChannelFiles: vi.fn().mockResolvedValue([]),
    shareArtifact: vi.fn().mockResolvedValue({ fileId: "file-1", fileName: "x.pdf" }),
    addChannelSource: vi.fn(),
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

describe("ShareToKchatModal", () => {
  it("lists teams and shareable (public+private) channels but hides DMs", async () => {
    const api = makeApi();
    wrap(
      <ShareToKchatModal
        isOpen
        onClose={() => {}}
        artifactId="art-1"
        artifactTitle="Quarterly PRD"
        availableFormats={["markdown", "pdf", "html"]}
        defaultFormat="pdf"
        api={api}
      />,
    );
    const channelSelect = await screen.findByTestId("kchat-share-channel");
    await waitFor(() => {
      const options = channelSelect.querySelectorAll("option");
      // Exactly two visible (general, private); DM omitted.
      const labels = Array.from(options).map((o) => o.textContent ?? "");
      expect(labels.some((l) => l.includes("General"))).toBe(true);
      expect(labels.some((l) => l.includes("Private"))).toBe(true);
      expect(labels.every((l) => !l.includes("DM"))).toBe(true);
    });
  });

  it("renders only the formats the artifact type allows", async () => {
    const api = makeApi();
    wrap(
      <ShareToKchatModal
        isOpen
        onClose={() => {}}
        artifactId="a"
        artifactTitle="T"
        availableFormats={["markdown", "pdf"]}
        defaultFormat="pdf"
        api={api}
      />,
    );
    const formatSelect = (await screen.findByTestId(
      "kchat-share-format",
    )) as HTMLSelectElement;
    const labels = Array.from(formatSelect.options).map((o) => o.value);
    expect(labels).toEqual(["markdown", "pdf"]);
  });

  it("calls shareArtifact with the selected channel, format, and toggles", async () => {
    const api = makeApi();
    const onClose = vi.fn();
    wrap(
      <ShareToKchatModal
        isOpen
        onClose={onClose}
        artifactId="art-42"
        artifactTitle="Quarterly PRD"
        availableFormats={["markdown", "pdf"]}
        defaultFormat="pdf"
        api={api}
      />,
    );

    // Default channel is "General" (chan-1), default format is "pdf".
    // The submit button starts disabled (busy=false but channelId="")
    // until the channels useEffect resolves and auto-picks the first
    // shareable channel. Wait for that before interacting.
    const channelSelect = (await screen.findByTestId(
      "kchat-share-channel",
    )) as HTMLSelectElement;
    await waitFor(() => expect(channelSelect.value).toBe("chan-1"));

    fireEvent.click(screen.getByTestId("kchat-share-citations"));
    // citations starts true → uncheck → false
    fireEvent.click(screen.getByTestId("kchat-share-evidence"));
    // evidence starts false → check → true
    fireEvent.click(screen.getByTestId("kchat-share-submit"));

    await waitFor(() =>
      expect(api.shareArtifact).toHaveBeenCalledWith(
        "art-42",
        "chan-1",
        "pdf",
        false,
        true,
      ),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("surfaces the share error inline", async () => {
    const api = makeApi({
      shareArtifact: vi.fn().mockRejectedValue(new Error("rate-limited")),
    });
    wrap(
      <ShareToKchatModal
        isOpen
        onClose={() => {}}
        artifactId="art-1"
        artifactTitle="T"
        availableFormats={["pdf"]}
        defaultFormat="pdf"
        api={api}
      />,
    );
    await screen.findByTestId("kchat-share-channel");
    fireEvent.click(screen.getByTestId("kchat-share-submit"));
    expect(await screen.findByTestId("kchat-share-error")).toHaveTextContent(
      /rate-limited/,
    );
  });
});
