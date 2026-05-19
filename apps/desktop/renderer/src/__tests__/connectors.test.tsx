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
