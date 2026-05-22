import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ConnectorStatus from "../components/ConnectorStatus";
import DriveFilePicker from "../components/DriveFilePicker";

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
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe("ConnectorStatus", () => {
  it("renders provider name and polls status on mount", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "google_drive",
      connected: true,
      status: "connected",
    });

    render(<ConnectorStatus provider="google_drive" />);

    await waitFor(() => {
      expect(screen.getByText("Google Drive")).toBeInTheDocument();
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });

    expect(mockApi.connectors.status).toHaveBeenCalledWith("google_drive");
  });

  it("shows disconnect state when not connected", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "google_drive",
      connected: false,
      status: "disconnected",
    });

    render(<ConnectorStatus provider="google_drive" />);

    await waitFor(() => {
      expect(screen.getByText("Disconnected")).toBeInTheDocument();
    });

    expect(screen.queryByText("Sync Now")).not.toBeInTheDocument();
    expect(screen.queryByText("Disconnect")).not.toBeInTheDocument();
  });

  it("shows sync and disconnect buttons when connected", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "google_drive",
      connected: true,
      status: "connected",
    });

    render(<ConnectorStatus provider="google_drive" />);

    await waitFor(() => {
      expect(screen.getByText("Sync Now")).toBeInTheDocument();
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });
  });

  it("calls syncDrive when sync button is clicked", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "google_drive",
      connected: true,
      status: "connected",
    });
    mockApi.connectors.syncDrive.mockResolvedValue({ added: 2, modified: 0, removed: 0, status: "ok" });

    const onSync = vi.fn();
    render(<ConnectorStatus provider="google_drive" onSync={onSync} />);

    await waitFor(() => {
      expect(screen.getByText("Sync Now")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Sync Now"));
    });

    await waitFor(() => {
      expect(mockApi.connectors.syncDrive).toHaveBeenCalled();
    });
  });

  it("calls disconnect when disconnect button is clicked", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "google_drive",
      connected: true,
      status: "connected",
    });
    mockApi.connectors.disconnect.mockResolvedValue({
      provider: "google_drive",
      connected: false,
      status: "disconnected",
    });

    const onDisconnect = vi.fn();
    render(<ConnectorStatus provider="google_drive" onDisconnect={onDisconnect} />);

    await waitFor(() => {
      expect(screen.getByText("Disconnect")).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Disconnect"));
    });

    await waitFor(() => {
      expect(mockApi.connectors.disconnect).toHaveBeenCalledWith("google_drive");
    });
  });

  it("handles status polling errors gracefully", async () => {
    mockApi.connectors.status.mockRejectedValue(new Error("Network error"));

    render(<ConnectorStatus provider="google_drive" />);

    await waitFor(() => {
      expect(screen.getByText("Disconnected")).toBeInTheDocument();
    });
  });

  it(
    "shows Offline badge when sync returns status === 'offline'",
    async () => {
      mockApi.connectors.status.mockResolvedValue({
        provider: "notion",
        connected: true,
        status: "connected",
      });
      mockApi.connectors.sync.mockResolvedValue({
        added: 0,
        modified: 0,
        removed: 0,
        status: "offline",
      });

      render(<ConnectorStatus provider="notion" />);
      await waitFor(() => {
        expect(screen.getByText("Sync Now")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Sync Now"));
      });

      await waitFor(() => {
        expect(screen.getByText("Offline")).toBeInTheDocument();
      });
    },
  );

  it(
    "clears the Offline badge on subsequent NON-network errors " +
      "(regression: ANALYSIS_0003 — badge previously persisted)",
    async () => {
      // First sync returns "offline" → badge lights up.
      mockApi.connectors.status.mockResolvedValue({
        provider: "notion",
        connected: true,
        status: "connected",
      });
      mockApi.connectors.sync
        .mockResolvedValueOnce({
          added: 0,
          modified: 0,
          removed: 0,
          status: "offline",
        })
        // Second sync throws a NON-network error (e.g. NotConnectedError
        // after the user revoked access in the provider UI).
        .mockRejectedValueOnce(
          new Error("notion is not connected — authenticate first"),
        );

      render(<ConnectorStatus provider="notion" />);
      await waitFor(() => {
        expect(screen.getByText("Sync Now")).toBeInTheDocument();
      });

      // First click → Offline.
      await act(async () => {
        fireEvent.click(screen.getByText("Sync Now"));
      });
      await waitFor(() => {
        expect(screen.getByText("Offline")).toBeInTheDocument();
      });

      // Second click → throws a non-network error. Badge must clear
      // back to "Connected" (or whatever the connected state shows),
      // NOT stay on "Offline".
      await act(async () => {
        fireEvent.click(screen.getByText("Sync Now"));
      });
      await waitFor(() => {
        expect(screen.queryByText("Offline")).not.toBeInTheDocument();
        expect(screen.getByText("Connected")).toBeInTheDocument();
      });
    },
  );

  it(
    "does NOT stamp 'Last sync' timestamp when the sync returned offline " +
      "(regression: wave 9 ANALYSIS_0003 — misleading freshness)",
    async () => {
      mockApi.connectors.status.mockResolvedValue({
        provider: "notion",
        connected: true,
        status: "connected",
      });
      mockApi.connectors.sync.mockResolvedValue({
        added: 0,
        modified: 0,
        removed: 0,
        status: "offline",
      });

      render(<ConnectorStatus provider="notion" />);
      await waitFor(() => {
        expect(screen.getByText("Sync Now")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Sync Now"));
      });

      // Offline badge must light up …
      await waitFor(() => {
        expect(screen.getByText("Offline")).toBeInTheDocument();
      });
      // … but the misleading "Last sync: ..." line must NOT appear,
      // because the attempt never actually transferred. The previous
      // (buggy) code unconditionally stamped the timestamp regardless
      // of result.status, telling the user the data was fresh when in
      // fact this attempt failed at the network layer.
      expect(screen.queryByText(/^Last sync:/)).not.toBeInTheDocument();
    },
  );

  it(
    "stamps 'Last sync' timestamp on a successful (non-offline) sync",
    async () => {
      mockApi.connectors.status.mockResolvedValue({
        provider: "notion",
        connected: true,
        status: "connected",
      });
      mockApi.connectors.sync.mockResolvedValue({
        added: 1,
        modified: 0,
        removed: 0,
        status: "synced",
      });

      render(<ConnectorStatus provider="notion" />);
      await waitFor(() => {
        expect(screen.getByText("Sync Now")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Sync Now"));
      });

      await waitFor(() => {
        expect(screen.getByText(/^Last sync:/)).toBeInTheDocument();
      });
    },
  );

  it(
    "keeps the Offline badge when sync throws a network-shaped error",
    async () => {
      mockApi.connectors.status.mockResolvedValue({
        provider: "notion",
        connected: true,
        status: "connected",
      });
      mockApi.connectors.sync.mockRejectedValue(
        new Error("getaddrinfo ENOTFOUND api.notion.com"),
      );

      render(<ConnectorStatus provider="notion" />);
      await waitFor(() => {
        expect(screen.getByText("Sync Now")).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Sync Now"));
      });

      await waitFor(() => {
        expect(screen.getByText("Offline")).toBeInTheDocument();
      });
    },
  );

  it(
    "clears stale Offline badge on disconnect so a reconnect cycle " +
      "does not show Offline when the network is healthy " +
      "(regression: wave 14 BUG_0001)",
    async () => {
      // Phase 1: connected + offline (sync failed due to network).
      mockApi.connectors.status.mockResolvedValue({
        provider: "google_drive",
        connected: true,
        status: "connected",
      });
      mockApi.connectors.syncDrive.mockResolvedValue({
        added: 0,
        modified: 0,
        removed: 0,
        status: "offline",
      });

      render(<ConnectorStatus provider="google_drive" />);
      await waitFor(() => {
        expect(screen.getByText("Sync Now")).toBeInTheDocument();
      });

      // Sync → Offline badge appears.
      await act(async () => {
        fireEvent.click(screen.getByText("Sync Now"));
      });
      await waitFor(() => {
        expect(screen.getByText("Offline")).toBeInTheDocument();
      });

      // Phase 2: user clicks Disconnect. After the call, pollStatus
      // returns `connected: false` (the connector was torn down).
      mockApi.connectors.disconnect.mockResolvedValue({
        provider: "google_drive",
        connected: false,
        status: "disconnected",
      });
      mockApi.connectors.status.mockResolvedValue({
        provider: "google_drive",
        connected: false,
        status: "disconnected",
      });

      await act(async () => {
        fireEvent.click(screen.getByText("Disconnect"));
      });

      // The badge text must now be "Disconnected" — NOT "Offline".
      // Before the fix, `offline` was still `true` in React state,
      // but with `connected: false` the ternary renders
      // "Disconnected" anyway. The real bug manifests when `connected`
      // flips back to `true` (reconnect) below.
      await waitFor(() => {
        expect(screen.getByText("Disconnected")).toBeInTheDocument();
      });

      // Phase 3: user reconnects (OAuth). Status now returns
      // `connected: true` again. A stale `offline = true` would make
      // the ternary evaluate to "Offline" even though the brand-new
      // OAuth flow proves the network is healthy.
      mockApi.connectors.status.mockResolvedValue({
        provider: "google_drive",
        connected: true,
        status: "connected",
      });

      // Trigger a re-poll by advancing the fake timer past the 10s
      // interval. Use `act` to let React process state updates.
      await act(async () => {
        vi.advanceTimersByTime(11_000);
      });

      await waitFor(() => {
        expect(screen.getByText("Connected")).toBeInTheDocument();
        expect(screen.queryByText("Offline")).not.toBeInTheDocument();
      });
    },
  );
});

describe("DriveFilePicker", () => {
  it("renders header and loading state", async () => {
    mockApi.connectors.listDriveFiles.mockResolvedValue({
      nextPageToken: null,
      files: [],
    });

    render(<DriveFilePicker onSelect={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText("Select files from Google Drive")).toBeInTheDocument();
    expect(screen.getByText("My Drive")).toBeInTheDocument();
  });

  it("displays files from Drive API", async () => {
    mockApi.connectors.listDriveFiles.mockResolvedValue({
      nextPageToken: null,
      files: [
        { id: "f1", name: "report.pdf", mimeType: "application/pdf", size: 102400, modifiedTime: null, isFolder: false, parentId: "root" },
        { id: "f2", name: "Photos", mimeType: "application/vnd.google-apps.folder", size: 0, modifiedTime: null, isFolder: true, parentId: "root" },
      ],
    });

    render(<DriveFilePicker onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      expect(screen.getByText("Photos")).toBeInTheDocument();
    });
  });

  it("shows empty state when no files", async () => {
    mockApi.connectors.listDriveFiles.mockResolvedValue({
      nextPageToken: null,
      files: [],
    });

    render(<DriveFilePicker onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No files in this folder")).toBeInTheDocument();
    });
  });

  it("shows error message on API failure", async () => {
    mockApi.connectors.listDriveFiles.mockRejectedValue(new Error("Auth expired"));

    render(<DriveFilePicker onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Auth expired")).toBeInTheDocument();
    });
  });

  it("calls onCancel when cancel button clicked", async () => {
    mockApi.connectors.listDriveFiles.mockResolvedValue({ nextPageToken: null, files: [] });
    const onCancel = vi.fn();

    render(<DriveFilePicker onSelect={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("selects files and confirms selection", async () => {
    mockApi.connectors.listDriveFiles.mockResolvedValue({
      nextPageToken: null,
      files: [
        { id: "f1", name: "data.csv", mimeType: "text/csv", size: 1024, modifiedTime: null, isFolder: false, parentId: "root" },
      ],
    });

    const onSelect = vi.fn();
    render(<DriveFilePicker onSelect={onSelect} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("data.csv")).toBeInTheDocument();
    });

    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);

    await waitFor(() => {
      expect(screen.getByText("1 file selected")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Add Selected"));
    expect(onSelect).toHaveBeenCalledWith([
      expect.objectContaining({ id: "f1", name: "data.csv" }),
    ]);
  });

  it("navigates into folders via breadcrumbs", async () => {
    mockApi.connectors.listDriveFiles
      .mockResolvedValueOnce({
        nextPageToken: null,
        files: [
          { id: "folder-1", name: "Projects", mimeType: "application/vnd.google-apps.folder", size: 0, modifiedTime: null, isFolder: true, parentId: "root" },
        ],
      })
      .mockResolvedValueOnce({
        nextPageToken: null,
        files: [
          { id: "f-inner", name: "spec.md", mimeType: "text/markdown", size: 2048, modifiedTime: null, isFolder: false, parentId: "folder-1" },
        ],
      });

    render(<DriveFilePicker onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Projects")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Projects"));

    await waitFor(() => {
      expect(screen.getByText("spec.md")).toBeInTheDocument();
    });

    const breadcrumbs = screen.getAllByRole("button").filter(b => b.classList.contains("breadcrumb-link"));
    expect(breadcrumbs.length).toBeGreaterThanOrEqual(2);
  });

  it("disables Add Selected button when nothing is selected", async () => {
    mockApi.connectors.listDriveFiles.mockResolvedValue({
      nextPageToken: null,
      files: [
        { id: "f1", name: "file.txt", mimeType: "text/plain", size: 100, modifiedTime: null, isFolder: false, parentId: "root" },
      ],
    });

    render(<DriveFilePicker onSelect={vi.fn()} onCancel={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("file.txt")).toBeInTheDocument();
    });

    const addBtn = screen.getByText("Add Selected");
    expect(addBtn).toBeDisabled();
    expect(screen.getByText("0 files selected")).toBeInTheDocument();
  });
});
