/**
 * Renderer test suite for `KchatSettingsCard.tsx`. Phase 14.
 *
 * The card has a single connection mode (Personal Access Token).
 * When the Tessera `.kcz` extension installed in KChat Desktop
 * is reachable AND has recently checked in, an additional
 * "enhanced integration active" affordance is rendered with a
 * button that invokes the `kchat://app/settings/extensions`
 * deeplink.
 *
 * Detection is driven by polling `kchat.desktopBridgeStatus()`:
 * the card treats the integration as live when the snapshot has
 * `apiServerRunning === true` AND `lastExtensionContactAt` is
 * within `EXTENSION_HEARTBEAT_STALE_MS` (90 s) of the current
 * clock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import KchatSettingsCard, {
  getStoredDefaultTeamId,
  isExtensionDetected,
  setStoredDefaultTeamId,
} from "../components/KchatSettingsCard";
import { ToastProvider } from "../components/Toast";

function makeApi(overrides: Partial<typeof window.tessera.kchat> = {}) {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    status: vi.fn().mockResolvedValue({ state: "disconnected" as const }),
    connect: vi.fn().mockResolvedValue({
      id: "user-1",
      username: "alice",
      email: "alice@example.com",
      firstName: "Alice",
      lastName: "Anderson",
    }),
    disconnect: vi.fn().mockResolvedValue({ disconnected: true }),
    listTeams: vi.fn().mockResolvedValue([
      {
        id: "team-1",
        name: "team-one",
        display_name: "Team One",
        type: "O" as const,
      },
      {
        id: "team-2",
        name: "team-two",
        display_name: "Team Two",
        type: "O" as const,
      },
    ]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    listChannelFiles: vi.fn().mockResolvedValue([]),
    shareArtifact: vi.fn(),
    addChannelSource: vi.fn(),
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
      .mockResolvedValue({
        opened: true,
        url: "kchat://app/settings/extensions",
      }),
    backfillProgress: vi.fn(),
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

afterEach(() => {
  vi.useRealTimers();
});

describe("KchatSettingsCard", () => {
  it("renders nothing when feature is disabled", async () => {
    const api = makeApi({
      isAvailable: vi.fn().mockResolvedValue(false),
    });
    const { container } = wrap(<KchatSettingsCard api={api} />);
    await waitFor(() => expect(api.isAvailable).toHaveBeenCalled());
    expect(
      container.querySelector('[data-testid="kchat-settings-card"]'),
    ).toBeNull();
  });

  it("renders the disconnected card with Server URL + token inputs", async () => {
    const api = makeApi();
    wrap(<KchatSettingsCard api={api} />);
    expect(
      await screen.findByTestId("kchat-settings-card"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/server url/i)).toHaveValue(
      "https://kchat.com",
    );
    expect(
      screen.getByLabelText(/personal access token/i),
    ).toBeInTheDocument();
    expect(screen.getByTestId("kchat-connect")).toHaveTextContent(/connect/i);
  });

  it("calls connect with the entered URL + token and updates the UI on success", async () => {
    const stateAfterConnect = {
      state: "connected" as const,
      serverUrl: "https://kchat.example",
      user: {
        id: "user-1",
        username: "alice",
        email: "a@x.io",
        firstName: "Alice",
        lastName: "Anderson",
      },
    };
    const api = makeApi();
    (api.status as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ state: "disconnected" })
      .mockResolvedValue(stateAfterConnect);

    wrap(<KchatSettingsCard api={api} />);
    await screen.findByTestId("kchat-connect");

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "https://kchat.example" },
    });
    fireEvent.change(screen.getByLabelText(/personal access token/i), {
      target: { value: "secret-pat-token" },
    });
    fireEvent.click(screen.getByTestId("kchat-connect"));

    await waitFor(() =>
      expect(api.connect).toHaveBeenCalledWith(
        "secret-pat-token",
        "https://kchat.example",
      ),
    );
    expect(await screen.findByTestId("kchat-disconnect")).toBeInTheDocument();
    expect(screen.getByTestId("kchat-connected-user")).toHaveTextContent(
      "Alice Anderson (@alice)",
    );
  });

  it("rejects connect when the server URL is missing http(s)", async () => {
    const api = makeApi();
    wrap(<KchatSettingsCard api={api} />);
    await screen.findByTestId("kchat-connect");

    fireEvent.change(screen.getByLabelText(/server url/i), {
      target: { value: "kchat.com" },
    });
    fireEvent.change(screen.getByLabelText(/personal access token/i), {
      target: { value: "pat" },
    });
    fireEvent.click(screen.getByTestId("kchat-connect"));

    await waitFor(() => expect(api.connect).not.toHaveBeenCalled());
  });

  it("populates the default-team selector after connect and persists choice", async () => {
    const api = makeApi();
    (api.status as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "connected" as const,
      serverUrl: "https://kchat.example",
      user: {
        id: "user-1",
        username: "alice",
        email: "a@x.io",
        firstName: "A",
        lastName: "A",
      },
    });

    wrap(<KchatSettingsCard api={api} />);
    const teamSelect = await screen.findByTestId("kchat-default-team");
    expect(teamSelect).toHaveValue("team-1");
    expect(getStoredDefaultTeamId()).toBe("team-1");

    fireEvent.change(teamSelect, { target: { value: "team-2" } });
    expect(getStoredDefaultTeamId()).toBe("team-2");
  });

  it("clears stored default-team on disconnect", async () => {
    const api = makeApi();
    (api.status as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        state: "connected" as const,
        serverUrl: "https://kchat.example",
        user: {
          id: "user-1",
          username: "alice",
          email: "a@x.io",
          firstName: "A",
          lastName: "A",
        },
      })
      .mockResolvedValue({ state: "disconnected" as const });
    setStoredDefaultTeamId("team-pinned");

    wrap(<KchatSettingsCard api={api} />);
    await screen.findByTestId("kchat-disconnect");
    fireEvent.click(screen.getByTestId("kchat-disconnect"));

    await waitFor(() => expect(api.disconnect).toHaveBeenCalled());
    await waitFor(() => expect(getStoredDefaultTeamId()).toBeNull());
  });

  it("shows the inline error when the connection state is `error`", async () => {
    const api = makeApi();
    (api.status as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      state: "error" as const,
      serverUrl: "https://kchat.example",
      error: "Connection refused",
    });

    wrap(<KchatSettingsCard api={api} />);
    const err = await screen.findByTestId("kchat-error");
    expect(err).toHaveTextContent("Connection refused");
  });

  it("does not render the 'KChat Desktop detected' affordance when the extension has never checked in", async () => {
    const api = makeApi();
    wrap(<KchatSettingsCard api={api} />);
    await screen.findByTestId("kchat-settings-card");
    await waitFor(() =>
      expect(api.desktopBridgeStatus).toHaveBeenCalled(),
    );
    expect(
      screen.queryByTestId("kchat-desktop-detected"),
    ).toBeNull();
  });

  it("renders the 'KChat Desktop detected' affordance when the extension has recently checked in", async () => {
    const api = makeApi({
      desktopBridgeStatus: vi.fn().mockResolvedValue({
        apiServerRunning: true,
        apiServerPort: 51234,
        portFilePath: "/tmp/tessera-kchat-port.json",
        lastExtensionContactAt: new Date().toISOString(),
      }),
    });
    wrap(<KchatSettingsCard api={api} />);
    await screen.findByTestId("kchat-settings-card");
    expect(
      await screen.findByTestId("kchat-desktop-detected"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("kchat-open-desktop-extensions"),
    ).toHaveTextContent(/Open KChat Desktop extensions/i);
  });

  it("invokes openDesktopExtensions when the affordance button is clicked", async () => {
    const api = makeApi({
      desktopBridgeStatus: vi.fn().mockResolvedValue({
        apiServerRunning: true,
        apiServerPort: 51234,
        portFilePath: "/tmp/tessera-kchat-port.json",
        lastExtensionContactAt: new Date().toISOString(),
      }),
    });
    wrap(<KchatSettingsCard api={api} />);
    const btn = await screen.findByTestId("kchat-open-desktop-extensions");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(api.openDesktopExtensions).toHaveBeenCalledTimes(1),
    );
  });

  it("treats a heartbeat older than the stale window as 'not detected'", async () => {
    const api = makeApi({
      desktopBridgeStatus: vi.fn().mockResolvedValue({
        apiServerRunning: true,
        apiServerPort: 51234,
        portFilePath: "/tmp/tessera-kchat-port.json",
        lastExtensionContactAt: new Date(
          Date.now() - 5 * 60_000, // 5 minutes ago
        ).toISOString(),
      }),
    });
    wrap(<KchatSettingsCard api={api} />);
    await screen.findByTestId("kchat-settings-card");
    await waitFor(() =>
      expect(api.desktopBridgeStatus).toHaveBeenCalled(),
    );
    // Wait briefly so the React batch processes the IPC resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(
      screen.queryByTestId("kchat-desktop-detected"),
    ).toBeNull();
  });
});

describe("isExtensionDetected", () => {
  it("returns false when status is null", () => {
    expect(isExtensionDetected(null, Date.now())).toBe(false);
  });

  it("returns false when the API server is not running", () => {
    expect(
      isExtensionDetected(
        {
          apiServerRunning: false,
          apiServerPort: null,
          portFilePath: null,
          lastExtensionContactAt: new Date().toISOString(),
        },
        Date.now(),
      ),
    ).toBe(false);
  });

  it("returns false when the extension has never checked in", () => {
    expect(
      isExtensionDetected(
        {
          apiServerRunning: true,
          apiServerPort: 1,
          portFilePath: "/x",
          lastExtensionContactAt: null,
        },
        Date.now(),
      ),
    ).toBe(false);
  });

  it("returns true when the heartbeat is within the staleness window", () => {
    const now = Date.now();
    expect(
      isExtensionDetected(
        {
          apiServerRunning: true,
          apiServerPort: 1,
          portFilePath: "/x",
          lastExtensionContactAt: new Date(now - 5_000).toISOString(),
        },
        now,
      ),
    ).toBe(true);
  });

  it("returns false when the heartbeat is past the staleness window", () => {
    const now = Date.now();
    expect(
      isExtensionDetected(
        {
          apiServerRunning: true,
          apiServerPort: 1,
          portFilePath: "/x",
          lastExtensionContactAt: new Date(now - 5 * 60_000).toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });

  it("returns false when the heartbeat string is malformed", () => {
    expect(
      isExtensionDetected(
        {
          apiServerRunning: true,
          apiServerPort: 1,
          portFilePath: "/x",
          lastExtensionContactAt: "not-an-iso-string",
        },
        Date.now(),
      ),
    ).toBe(false);
  });
});
