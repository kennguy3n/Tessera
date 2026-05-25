import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import KchatSettingsCard, {
  getStoredDefaultTeamId,
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
      first_name: "Alice",
      last_name: "Anderson",
    }),
    disconnect: vi.fn().mockResolvedValue({ disconnected: true }),
    listTeams: vi.fn().mockResolvedValue([
      { id: "team-1", name: "team-one", display_name: "Team One", type: "O" as const },
      { id: "team-2", name: "team-two", display_name: "Team Two", type: "O" as const },
    ]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    listChannelFiles: vi.fn().mockResolvedValue([]),
    shareArtifact: vi.fn(),
    addChannelSource: vi.fn(),
    ...overrides,
  } as unknown as typeof window.tessera.kchat;
}

function wrap(node: React.ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("KchatSettingsCard", () => {
  it("renders nothing when feature is disabled", async () => {
    const api = makeApi({ isAvailable: vi.fn().mockResolvedValue(false) });
    const { container } = wrap(<KchatSettingsCard api={api} />);
    // Wait for the effect to run
    await waitFor(() => expect(api.isAvailable).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="kchat-settings-card"]')).toBeNull();
  });

  it("renders the disconnected card with Server URL + token inputs", async () => {
    const api = makeApi();
    wrap(<KchatSettingsCard api={api} />);
    expect(await screen.findByTestId("kchat-settings-card")).toBeInTheDocument();
    expect(screen.getByLabelText(/server url/i)).toHaveValue("https://kchat.com");
    expect(screen.getByLabelText(/personal access token/i)).toBeInTheDocument();
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
        first_name: "Alice",
        last_name: "Anderson",
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
        first_name: "A",
        last_name: "A",
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
          first_name: "A",
          last_name: "A",
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
});
