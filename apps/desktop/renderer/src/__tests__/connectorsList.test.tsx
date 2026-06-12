import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import ConnectorsList from "../components/ConnectorsList";
import { CONNECTOR_DESCRIPTORS } from "../components/connectorDescriptors";
import type { ConnectorScopeComparison } from "../types/ipc";

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
    // `ConnectorsList`). Default returns the canonical URI so any
    // code that still exercises this path keeps matching the
    // OAuth-config single-source-of-truth.
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
    // (one IPC round-trip at mount time, no per-provider hardcoded
    // fallback in the renderer). The values
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
    // Read-only scope inspection. Default returns `null` (the
    // not-connected contract) so disconnected-provider tests don't
    // render a "scopes narrowed" banner; individual tests override
    // this when they want to exercise the narrowed-scope path.
    inspectScopes: vi.fn(
      async (_provider: string): Promise<ConnectorScopeComparison | null> =>
        null,
    ),
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
      // Whole-account OAuth2 provider: no per-target fields, so the
      // config bag is empty. The connect path always passes it (the
      // handler treats `{}` and an omitted arg identically).
      expect(mockApi.connectors.authenticate).toHaveBeenCalledWith(
        "onedrive",
        "ID",
        "SECRET",
        {},
      ),
    );
  });

  it("collects per-target config for an OAuth2 provider (Asana project)", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    mockApi.connectors.authenticate.mockResolvedValue({
      provider: "asana",
      connected: true,
      status: "connected",
    });

    await act(async () => {
      render(<ConnectorsList />);
    });

    fireEvent.click(await screen.findByLabelText("Connect Asana"));
    // OAuth2 provider still asks for client credentials …
    fireEvent.change(screen.getByLabelText("OAuth Client ID"), {
      target: { value: "ID" },
    });
    fireEvent.change(screen.getByLabelText("OAuth Client Secret"), {
      target: { value: "SECRET" },
    });
    // … plus the per-target project gid.
    fireEvent.change(screen.getByLabelText("Project ID"), {
      target: { value: "1201234567890123" },
    });
    fireEvent.click(screen.getByText("Authenticate"));

    await waitFor(() =>
      expect(mockApi.connectors.authenticate).toHaveBeenCalledWith(
        "asana",
        "ID",
        "SECRET",
        { project: "1201234567890123" },
      ),
    );
  });

  it("connects a token-method provider without OAuth client inputs (GitLab PAT)", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    mockApi.connectors.authenticate.mockResolvedValue({
      provider: "gitlab",
      connected: true,
      status: "connected",
    });

    await act(async () => {
      render(<ConnectorsList />);
    });

    fireEvent.click(await screen.findByLabelText("Connect GitLab"));
    // Token-method providers must NOT render the OAuth client inputs.
    expect(screen.queryByLabelText("OAuth Client ID")).toBeNull();
    expect(screen.queryByLabelText("OAuth Client Secret")).toBeNull();

    fireEvent.change(screen.getByLabelText("Personal access token"), {
      target: { value: "glpat-secret" },
    });
    fireEvent.change(screen.getByLabelText("Project ID or path"), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByText("Authenticate"));

    await waitFor(() =>
      expect(mockApi.connectors.authenticate).toHaveBeenCalledWith(
        "gitlab",
        "",
        "",
        { personal_access_token: "glpat-secret", project_id: "42" },
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
    // The hardcoded fallback was removed from the descriptor —
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
      // redirect URI (back-compat with users' existing Google Cloud
      // Console configuration). The UI must show the same URI
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
      // Wait until the bulk redirect-URI map resolves — the
      // per-provider `getRedirectUri(provider)` fan-out was collapsed
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

  it("groups connectors under category section headings", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    await act(async () => {
      render(<ConnectorsList />);
    });
    // Wait for the list to settle, then assert the category section
    // headings (rendered as <h3>) are present. The exact set is
    // driven by the descriptors, but Storage/Docs & Wiki/Chat are
    // guaranteed by the 10 shipped providers.
    await screen.findByText("Google Drive");
    for (const heading of ["Storage", "Docs & Wiki", "Chat", "CRM", "Code"]) {
      expect(
        screen.getByRole("heading", { name: heading }),
      ).toBeInTheDocument();
    }
  });

  it("filters the list to connectors matching the search query", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    await act(async () => {
      render(<ConnectorsList />);
    });
    await screen.findByText("Slack");

    const search = screen.getByLabelText("Search connectors");
    await act(async () => {
      fireEvent.change(search, { target: { value: "slack" } });
    });

    // Slack survives the filter; an unrelated provider is removed.
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
    expect(screen.queryByText("Notion")).not.toBeInTheDocument();
  });

  it("matches connectors by keyword alias, not just label", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    await act(async () => {
      render(<ConnectorsList />);
    });
    await screen.findByText("OneDrive");

    const search = screen.getByLabelText("Search connectors");
    await act(async () => {
      // "sharepoint" appears only in OneDrive's keyword aliases.
      fireEvent.change(search, { target: { value: "sharepoint" } });
    });
    expect(screen.getByText("OneDrive")).toBeInTheDocument();
    expect(screen.queryByText("Google Drive")).not.toBeInTheDocument();
  });

  it("shows an empty state with a clear-search action when nothing matches", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    await act(async () => {
      render(<ConnectorsList />);
    });
    await screen.findByText("Figma");

    const search = screen.getByLabelText("Search connectors");
    await act(async () => {
      fireEvent.change(search, { target: { value: "no-such-connector" } });
    });
    expect(screen.getByText("No connectors found")).toBeInTheDocument();
    expect(screen.queryByText("Figma")).not.toBeInTheDocument();

    // The "Clear search" action restores the full list.
    await act(async () => {
      fireEvent.click(screen.getByText("Clear search"));
    });
    expect(await screen.findByText("Figma")).toBeInTheDocument();
  });

  it("renders the scope-transparency disclosure for every connector", async () => {
    mockApi.connectors.status.mockResolvedValue({
      provider: "x",
      connected: false,
      status: "disconnected",
    });
    await act(async () => {
      render(<ConnectorsList />);
    });
    await screen.findByText("Notion");
    // Each connector card carries a "what we read / what we never
    // touch" disclosure; check one provider's accessible label.
    expect(
      screen.getByLabelText("Data access for Notion"),
    ).toBeInTheDocument();
  });

  it(
    "surfaces a 'scopes narrowed' banner with a Reconnect CTA when a " +
      "connected provider did not grant every requested scope",
    async () => {
      // Slack is connected but the user unchecked one scope at the
      // consent screen, so inspectScopes reports it as not fully
      // granted with a concrete `missing` entry.
      mockApi.connectors.status.mockImplementation(async (p: string) => ({
        provider: p,
        connected: p === "slack",
        status: p === "slack" ? "connected" : "disconnected",
      }));
      mockApi.connectors.inspectScopes.mockImplementation(
        async (p: string) =>
          p === "slack"
            ? {
                provider: "slack",
                requested: ["channels:read", "users:read"],
                granted: ["channels:read"],
                missing: ["users:read"],
                fullyGranted: false,
              }
            : null,
      );

      await act(async () => {
        render(<ConnectorsList />);
      });

      // The banner names the missing scope and offers a Reconnect CTA.
      expect(
        await screen.findByText(/Some requested permissions weren't granted/),
      ).toBeInTheDocument();
      expect(screen.getByText(/users:read/)).toBeInTheDocument();
      expect(
        screen.getByLabelText("Reconnect Slack to restore permissions"),
      ).toBeInTheDocument();
    },
  );

  it(
    "does NOT show the 'scopes narrowed' banner when all requested " +
      "scopes were granted",
    async () => {
      mockApi.connectors.status.mockImplementation(async (p: string) => ({
        provider: p,
        connected: p === "slack",
        status: p === "slack" ? "connected" : "disconnected",
      }));
      mockApi.connectors.inspectScopes.mockImplementation(
        async (p: string) =>
          p === "slack"
            ? {
                provider: "slack",
                requested: ["channels:read", "users:read"],
                granted: ["channels:read", "users:read"],
                missing: [],
                fullyGranted: true,
              }
            : null,
      );

      await act(async () => {
        render(<ConnectorsList />);
      });
      await screen.findByText("Slack");
      expect(
        screen.queryByText(/Some requested permissions weren't granted/),
      ).not.toBeInTheDocument();
    },
  );

  it(
    "offers a one-click Reconnect affordance on a connected provider " +
      "that opens the credential modal",
    async () => {
      mockApi.connectors.status.mockImplementation(async (p: string) => ({
        provider: p,
        connected: p === "github",
        status: p === "github" ? "connected" : "disconnected",
      }));

      await act(async () => {
        render(<ConnectorsList />);
      });

      const reconnect = await screen.findByLabelText("Reconnect GitHub");
      await act(async () => {
        fireEvent.click(reconnect);
      });
      // The shared credential modal opens, titled for the provider.
      expect(await screen.findByText("Connect GitHub")).toBeInTheDocument();
    },
  );

  it(
    "clears the 'scopes narrowed' banner immediately on a successful " +
      "reconnect, before the post-reconnect scope re-inspection resolves",
    async () => {
      // Slack is connected with narrowed scopes, so the banner is shown.
      mockApi.connectors.status.mockImplementation(async (p: string) => ({
        provider: p,
        connected: p === "slack",
        status: p === "slack" ? "connected" : "disconnected",
      }));
      // First inspection (mount) reports narrowed scopes; the second
      // (post-reconnect) is left pending so we can prove the banner is
      // cleared from the optimistic state rather than from fresh data —
      // i.e. it never flashes the stale "narrowed" state.
      let inspectCalls = 0;
      let resolvePending: ((v: ConnectorScopeComparison | null) => void) | null =
        null;
      mockApi.connectors.inspectScopes.mockImplementation(
        async (p: string): Promise<ConnectorScopeComparison | null> => {
          if (p !== "slack") return null;
          inspectCalls += 1;
          if (inspectCalls === 1) {
            return {
              provider: "slack",
              requested: ["channels:read", "users:read"],
              granted: ["channels:read"],
              missing: ["users:read"],
              fullyGranted: false,
            };
          }
          return new Promise((resolve) => {
            resolvePending = resolve;
          });
        },
      );
      mockApi.connectors.authenticate.mockResolvedValue({
        provider: "slack",
        connected: true,
        status: "connected",
      });

      await act(async () => {
        render(<ConnectorsList />);
      });
      expect(
        await screen.findByText(/Some requested permissions weren't granted/),
      ).toBeInTheDocument();

      // Reconnect → fill credentials → authenticate.
      fireEvent.click(
        screen.getByLabelText("Reconnect Slack to restore permissions"),
      );
      fireEvent.change(screen.getByLabelText("OAuth Client ID"), {
        target: { value: "ID" },
      });
      fireEvent.change(screen.getByLabelText("OAuth Client Secret"), {
        target: { value: "SECRET" },
      });
      await act(async () => {
        fireEvent.click(screen.getByText("Authenticate"));
      });

      // The post-reconnect inspection is still pending, yet the stale
      // banner is already gone — no flash of the just-fixed state.
      expect(
        screen.queryByText(/Some requested permissions weren't granted/),
      ).not.toBeInTheDocument();

      // Release the pending inspection so no promise is left dangling.
      await act(async () => {
        resolvePending?.(null);
      });
    },
  );
});
