import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ConnectorsList, { CONNECTOR_DESCRIPTORS } from "../components/ConnectorsList";

const mockApi = {
  connectors: {
    status: vi.fn(),
    syncDrive: vi.fn(),
    disconnect: vi.fn(),
    listDriveFiles: vi.fn(),
    selectItems: vi.fn(),
    authenticate: vi.fn(),
    sync: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { tessera: typeof mockApi }).tessera = mockApi as never;
});

describe("ConnectorsList", () => {
  it("renders one row per provider in CONNECTOR_DESCRIPTORS", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });

    await act(async () => {
      render(<ConnectorsList />);
    });

    for (const d of CONNECTOR_DESCRIPTORS) {
      expect(await screen.findByText(d.label)).toBeInTheDocument();
    }
  });

  it("opens the Connect modal and authenticates with provider id", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    mockApi.connectors.authenticate.mockResolvedValue({
      provider: "onedrive",
      connected: true,
      status: "connected",
    });

    await act(async () => {
      render(<ConnectorsList />);
    });

    // 6 disconnected providers — find OneDrive's Connect button
    const connectBtn = await screen.findByLabelText("Connect OneDrive");
    fireEvent.click(connectBtn);

    fireEvent.change(screen.getByLabelText("OAuth Client ID"), {
      target: { value: "ID" },
    });
    fireEvent.change(screen.getByLabelText("OAuth Client Secret"), {
      target: { value: "SECRET" },
    });
    fireEvent.click(screen.getByText("Authenticate"));

    await waitFor(() =>
      expect(mockApi.connectors.authenticate).toHaveBeenCalledWith(
        "onedrive",
        "ID",
        "SECRET",
      ),
    );
  });

  it("shows the offline badge when sync returns offline status", async () => {
    // Render with one provider already connected — pick Figma since
    // we want to assert against a non-Drive provider
    mockApi.connectors.status.mockImplementation(async (p: string) => ({
      provider: p,
      connected: p === "figma",
      status: p === "figma" ? "connected" : "disconnected",
    }));
    mockApi.connectors.sync.mockResolvedValue({
      added: 0,
      modified: 0,
      removed: 0,
      status: "offline",
    });

    await act(async () => {
      render(<ConnectorsList />);
    });
    const syncBtn = await screen.findByLabelText("Sync Figma now");
    await act(async () => {
      fireEvent.click(syncBtn);
    });
    await waitFor(() => expect(screen.getByText("Offline")).toBeInTheDocument());
  });

  it("shows a redirect URI hint matching the per-provider port", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    await act(async () => {
      render(<ConnectorsList />);
    });
    const figma = await screen.findByLabelText("Connect Figma");
    fireEvent.click(figma);
    expect(
      screen.getByText(/127\.0\.0\.1:9881/),
    ).toBeInTheDocument();
  });
});
