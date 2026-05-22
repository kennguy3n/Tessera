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
    // Per-provider single-shot URI fetch (legacy IPC; still part of
    // the API surface for callers that need it but no longer used by
    // `ConnectorsList` after wave 20). Default returns the wave-20
    // canonical URI so any code that still exercises this path keeps
    // matching the OAuth-config single-source-of-truth.
    getRedirectUri: vi.fn(async (provider: string) => {
      const map: Record<string, string> = {
        google_drive: "http://localhost:9876/callback",
        onedrive: "http://127.0.0.1:9877/callback",
        notion: "http://127.0.0.1:9878/callback",
        jira: "http://127.0.0.1:9879/callback",
        confluence: "http://127.0.0.1:9880/callback",
        figma: "http://127.0.0.1:9881/callback",
      };
      return map[provider];
    }),
    // Bulk URI fetch — the canonical path used by `ConnectorsList`
    // since wave 20 (one IPC round-trip at mount time, no per-
    // provider hardcoded fallback in the renderer). The values
    // mirror `providerOAuth.ts > PROVIDER_OAUTH_CONFIGS` so the test
    // surface stays in sync with production.
    getAllRedirectUris: vi.fn(async () => ({
      google_drive: "http://localhost:9876/callback",
      onedrive: "http://127.0.0.1:9877/callback",
      notion: "http://127.0.0.1:9878/callback",
      jira: "http://127.0.0.1:9879/callback",
      confluence: "http://127.0.0.1:9880/callback",
      figma: "http://127.0.0.1:9881/callback",
    })),
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
    // Wave 20 removed the hardcoded fallback from the descriptor —
    // the modal shows "Loading…" until `getAllRedirectUris` resolves,
    // then displays the canonical value from `providerOAuth.ts >
    // PROVIDER_OAUTH_CONFIGS`. Wait for the resolved URI rather than
    // asserting synchronously against the fallback.
    expect(
      await screen.findByText(/127\.0\.0\.1:9881/),
    ).toBeInTheDocument();
  });

  it(
    "omits providers listed in `excludeProviders` " +
      "(regression: Google Drive rendered twice on SourcesPage)",
    async () => {
      // `SourcesPage` keeps a dedicated `ConnectorStatus` card for
      // Google Drive (its file-picker flow lives there) and renders
      // `<ConnectorsList excludeProviders={["google_drive"]} />` to
      // avoid showing the Drive card a second time. This test asserts
      // the prop actually filters the list.
      mockApi.connectors.status.mockResolvedValue({
        provider: "x",
        connected: false,
        status: "disconnected",
      });
      await act(async () => {
        render(<ConnectorsList excludeProviders={["google_drive"]} />);
      });
      // Every non-excluded provider must still appear.
      for (const d of CONNECTOR_DESCRIPTORS) {
        if (d.provider === "google_drive") continue;
        expect(await screen.findByText(d.label)).toBeInTheDocument();
      }
      // And Google Drive must NOT be present.
      expect(screen.queryByLabelText("Connect Google Drive")).toBeNull();
      expect(screen.queryByText("Google Drive")).toBeNull();
    },
  );

  it(
    "shows the Google Drive redirect URI as `localhost:9876` (matches " +
      "OAuth config; regression for redirect_uri_mismatch bug)",
    async () => {
      // The UI used to hard-code `127.0.0.1:9876` for Google Drive,
      // but the actual OAuth flow registers `localhost:9876` as the
      // redirect URI (back-compat with users' pre-Phase-10 Google
      // Cloud Console configuration). The UI must show the same URI
      // the OAuth flow sends, otherwise users see
      // `redirect_uri_mismatch` on every connect attempt.
      mockApi.connectors.status.mockResolvedValue({
        provider: "x",
        connected: false,
        status: "disconnected",
      });
      await act(async () => {
        render(<ConnectorsList />);
      });
      const drive = await screen.findByLabelText("Connect Google Drive");
      await act(async () => {
        fireEvent.click(drive);
      });
      // Wait until the bulk redirect-URI map resolves — wave 20
      // collapsed the per-provider `getRedirectUri(provider)` fan-out
      // into a single `getAllRedirectUris()` call at mount and
      // removed the renderer's hardcoded fallback values, so the
      // modal's URI block now renders "Loading…" until this IPC
      // resolves and then the canonical value from
      // `providerOAuth.ts > PROVIDER_OAUTH_CONFIGS`.
      await waitFor(() =>
        expect(mockApi.connectors.getAllRedirectUris).toHaveBeenCalled(),
      );
      const localhostNode = await screen.findByText(
        /localhost:9876\/callback/,
      );
      expect(localhostNode).toBeInTheDocument();
      // And the buggy 127.0.0.1:9876 string must NOT appear.
      expect(
        screen.queryByText(/127\.0\.0\.1:9876/),
      ).not.toBeInTheDocument();
    },
  );
});
