import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ConnectorStatus from "../components/ConnectorStatus";
import DriveFilePicker from "../components/DriveFilePicker";
import {
  CONNECTOR_DESCRIPTORS,
  CONNECTOR_CATEGORY_ORDER,
  UNCATEGORIZED_LABEL,
  connectorMatchesQuery,
  groupConnectorsByCategory,
  type ConnectorDescriptor,
} from "../components/connectorDescriptors";

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
      "(regression: badge previously persisted across non-network errors)",
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
      "(regression: misleading freshness for offline syncs)",
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
    "clears the Offline badge on every thrown sync error, regardless " +
      "of message shape, because `runConnectorSync` (electron side) " +
      "is the single owner of network-error classification and " +
      "converts every NetworkError to a `{ status: 'offline' }` " +
      "return — anything that still throws to the renderer is by " +
      "definition not a network error (rate limit, NotConnectedError, " +
      "bridge fault). Previously the renderer reimplemented a weaker " +
      "regex copy of `isNetworkError` here, which created a drift " +
      "surface between renderer and main-process classifiers.",
    async () => {
      mockApi.connectors.status.mockResolvedValue({
        provider: "notion",
        connected: true,
        status: "connected",
      });
      // A network-shaped message reaching the renderer would be a bug
      // in `runConnectorSync`, not in the renderer. We assert the
      // renderer no longer guesses at it: the badge clears, the next
      // poll surfaces whatever the real connector status is, and the
      // user gets an accurate signal instead of a stale "Offline" left
      // over from heuristics.
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

      // The badge must NOT light up from a thrown error: the contract
      // is that offline state lives entirely on the structured
      // `result.status === 'offline'` field returned by the main
      // process. Asserting `queryByText` returns null guards against
      // any future re-introduction of an in-renderer message classifier.
      await waitFor(() => {
        expect(screen.queryByText("Offline")).not.toBeInTheDocument();
      });
    },
  );

  it(
    "clears stale Offline badge on disconnect so a reconnect cycle " +
      "does not show Offline when the network is healthy " +
      "(regression: stale-badge across reconnect)",
    async () => {
      // connected + offline (sync failed due to network).
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

      // user clicks Disconnect. After the call, pollStatus
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

      // user reconnects (OAuth). Status now returns
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

  it(
    "renders a network-specific Offline message when the IPC handler " +
      "returns `offline: true` (regression: offline status propagation)",
    async () => {
      // The IPC handler now catches `NetworkError` from the Drive API
      // path (DNS, TCP, TLS, undici reject) and returns a soft-offline
      // payload instead of throwing — the same contract the
      // multi-provider sync wrapper uses. The picker must surface
      // this specifically (not as "fetch failed" or "Auth expired"),
      // because the user's actual problem is transport, not auth, and
      // a wrong message would push them into a re-auth flow that
      // cannot possibly succeed while the network is down.
      mockApi.connectors.listDriveFiles.mockResolvedValue({
        nextPageToken: null,
        files: [],
        offline: true,
      });

      render(<DriveFilePicker onSelect={vi.fn()} onCancel={vi.fn()} />);

      await waitFor(() => {
        expect(
          screen.getByText(
            /You appear to be offline\. Check your network connection and try again\./,
          ),
        ).toBeInTheDocument();
      });
      // No raw error banner / auth-expired text should leak through —
      // those would mislead the user into re-authenticating.
      expect(screen.queryByText("Auth expired")).not.toBeInTheDocument();
      expect(screen.queryByText(/fetch failed/i)).not.toBeInTheDocument();
    },
  );

  it(
    "renders a Reconnect button (and fires onReconnect) only when the " +
      "onReconnect prop is supplied",
    async () => {
      mockApi.connectors.status.mockResolvedValue({
        provider: "notion",
        connected: true,
        status: "connected",
      });
      const onReconnect = vi.fn();
      render(<ConnectorStatus provider="notion" onReconnect={onReconnect} />);

      const reconnect = await screen.findByLabelText("Reconnect Notion");
      await act(async () => {
        fireEvent.click(reconnect);
      });
      expect(onReconnect).toHaveBeenCalledTimes(1);
    },
  );

  it("omits the Reconnect button when onReconnect is not supplied", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "notion",
      connected: true,
      status: "connected",
    });
    render(<ConnectorStatus provider="notion" />);

    await waitFor(() => {
      expect(screen.getByText("Sync Now")).toBeInTheDocument();
    });
    expect(screen.queryByLabelText("Reconnect Notion")).not.toBeInTheDocument();
  });
});

describe("connectorDescriptors", () => {
  it("ships exactly the 10 Connectors v2 providers, each fully categorized", () => {
    const providers = CONNECTOR_DESCRIPTORS.map((d) => d.provider);
    expect(providers).toEqual([
      "google_drive",
      "onedrive",
      "notion",
      "jira",
      "confluence",
      "figma",
      "hubspot",
      "slack",
      "email",
      "github",
    ]);
    // Every descriptor must carry a known category plus
    // scope-transparency copy so no card renders without its
    // grouping or its "what we read / never touch" disclosure.
    for (const d of CONNECTOR_DESCRIPTORS) {
      expect(d.category).toBeDefined();
      expect(CONNECTOR_CATEGORY_ORDER).toContain(d.category);
      expect((d.reads ?? []).length).toBeGreaterThan(0);
      expect((d.neverTouches ?? []).length).toBeGreaterThan(0);
    }
  });

  describe("connectorMatchesQuery", () => {
    const drive = CONNECTOR_DESCRIPTORS.find(
      (d) => d.provider === "google_drive",
    )!;

    it("matches everything on an empty / whitespace query", () => {
      expect(connectorMatchesQuery(drive, "")).toBe(true);
      expect(connectorMatchesQuery(drive, "   ")).toBe(true);
    });

    it("matches case-insensitively on the label", () => {
      expect(connectorMatchesQuery(drive, "google")).toBe(true);
      expect(connectorMatchesQuery(drive, "GOOGLE DRIVE")).toBe(true);
    });

    it("matches on provider id, category, and keyword aliases", () => {
      expect(connectorMatchesQuery(drive, "google_drive")).toBe(true);
      expect(connectorMatchesQuery(drive, "storage")).toBe(true);
      expect(connectorMatchesQuery(drive, "gdrive")).toBe(true);
    });

    it("returns false when nothing matches", () => {
      expect(connectorMatchesQuery(drive, "salesforce")).toBe(false);
    });
  });

  describe("groupConnectorsByCategory", () => {
    it("groups descriptors in CONNECTOR_CATEGORY_ORDER and omits empty buckets", () => {
      const groups = groupConnectorsByCategory(CONNECTOR_DESCRIPTORS);
      const categories = groups.map((g) => g.category);
      // Order must be a subsequence of the canonical order (empty
      // buckets dropped, no reordering).
      const orderIndex = categories.map((c) =>
        CONNECTOR_CATEGORY_ORDER.indexOf(c as never),
      );
      const sorted = [...orderIndex].sort((a, b) => a - b);
      expect(orderIndex).toEqual(sorted);
      // Every shipped descriptor is accounted for exactly once.
      const total = groups.reduce((n, g) => n + g.descriptors.length, 0);
      expect(total).toBe(CONNECTOR_DESCRIPTORS.length);
    });

    it("collects unknown / missing categories into a trailing 'Other' bucket", () => {
      const orphan: ConnectorDescriptor = {
        provider: "mystery",
        label: "Mystery",
        consoleUrl: "https://example.com",
        help: "",
      };
      const groups = groupConnectorsByCategory([
        ...CONNECTOR_DESCRIPTORS,
        orphan,
      ]);
      const last = groups[groups.length - 1];
      expect(last.category).toBe(UNCATEGORIZED_LABEL);
      expect(last.descriptors.map((d) => d.provider)).toContain("mystery");
    });

    it("preserves original relative order within a bucket", () => {
      const groups = groupConnectorsByCategory(CONNECTOR_DESCRIPTORS);
      const storage = groups.find((g) => g.category === "Storage");
      expect(storage?.descriptors.map((d) => d.provider)).toEqual([
        "google_drive",
        "onedrive",
      ]);
    });
  });
});
