import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("electron", () => ({
  shell: { openExternal: vi.fn().mockResolvedValue(undefined) },
  app: { getPath: vi.fn().mockReturnValue("/tmp/devin-test") },
}));

import {
  PROVIDER_OAUTH_CONFIGS,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkcePair,
  getProviderOAuthConfig,
  getRedirectUri,
  refreshProviderToken,
} from "../ipc/connectors/providerOAuth";
import { KNOWN_PROVIDERS } from "../ipc/validate";

describe("PROVIDER_OAUTH_CONFIGS", () => {
  it("exposes a config for every known provider with a unique port", () => {
    const ports = new Set<number>();
    // Derive the roster from `KNOWN_PROVIDERS` (the single allowlist
    // source of truth) so a provider added there without an OAuth
    // config — or one that reuses another's loopback port — fails here
    // instead of silently shipping a broken connect flow.
    for (const id of KNOWN_PROVIDERS) {
      const cfg = PROVIDER_OAUTH_CONFIGS[id];
      expect(cfg).toBeDefined();
      expect(cfg.provider).toBe(id);
      expect(cfg.authUrl).toMatch(/^https:\/\//);
      expect(cfg.tokenUrl).toMatch(/^https:\/\//);
      expect(ports.has(cfg.redirectPort)).toBe(false);
      ports.add(cfg.redirectPort);
    }
    expect(ports.size).toBe(KNOWN_PROVIDERS.length);
  });

  it("requests least-privilege read-only scopes for the new tranche", () => {
    // Guards the security contract: each newly-exposed provider must
    // request only read scopes. A future edit that widens a scope to a
    // write/manage grant breaks this test.
    expect(PROVIDER_OAUTH_CONFIGS.dropbox.scope).toBe(
      "account_info.read files.metadata.read files.content.read",
    );
    expect(PROVIDER_OAUTH_CONFIGS.box.scope).toBe("root_readonly");
    expect(PROVIDER_OAUTH_CONFIGS.linear.scope).toBe("read");
    expect(PROVIDER_OAUTH_CONFIGS.miro.scope).toBe("boards:read");
  });

  it("requests least-privilege read-only scopes for the per-target tranche", () => {
    // Asana / GitLab / Teams / Trello: each scope string must stay
    // read-only. A future widening to a write/manage grant (e.g.
    // `tasks:write`, `api`, `ChannelMessage.Send`) breaks this test —
    // the security contract for 5000 SME tenants.
    expect(PROVIDER_OAUTH_CONFIGS.asana.scope).toBe("projects:read tasks:read");
    expect(PROVIDER_OAUTH_CONFIGS.gitlab.scope).toBe("read_api");
    // `scope` holds API scopes only; `offline_access` is declared via
    // `requestOfflineAccess` (asserted below) and added by
    // `getRequestedScopes`, so it must NOT appear in the raw string.
    expect(PROVIDER_OAUTH_CONFIGS.teams.scope).toBe("ChannelMessage.Read.All");
    expect(PROVIDER_OAUTH_CONFIGS.teams.requestOfflineAccess).toBe(true);
    expect(PROVIDER_OAUTH_CONFIGS.trello.scope).toBe("read");
  });

  it("reserves the 9890-9893 loopback ports for the per-target tranche", () => {
    expect(PROVIDER_OAUTH_CONFIGS.asana.redirectPort).toBe(9890);
    expect(PROVIDER_OAUTH_CONFIGS.gitlab.redirectPort).toBe(9891);
    expect(PROVIDER_OAUTH_CONFIGS.teams.redirectPort).toBe(9892);
    expect(PROVIDER_OAUTH_CONFIGS.trello.redirectPort).toBe(9893);
  });

  it("requests least-privilege read-only scopes for the account-wide tranche", () => {
    // Tranche 3 (Zoom, Google Calendar/Docs/Sheets/Meet, SharePoint):
    // each scope string must stay read-only. A future widening to a
    // write/manage grant breaks this test — the security contract for
    // 5000 SME tenants.
    expect(PROVIDER_OAUTH_CONFIGS.zoom.scope).toBe(
      "cloud_recording:read:list_user_recordings",
    );
    expect(PROVIDER_OAUTH_CONFIGS.google_calendar.scope).toBe(
      "https://www.googleapis.com/auth/calendar.events.readonly",
    );
    expect(PROVIDER_OAUTH_CONFIGS.google_docs.scope).toBe(
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly",
    );
    expect(PROVIDER_OAUTH_CONFIGS.google_sheets.scope).toBe(
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly",
    );
    expect(PROVIDER_OAUTH_CONFIGS.google_meet.scope).toBe(
      "https://www.googleapis.com/auth/meetings.space.readonly",
    );
    expect(PROVIDER_OAUTH_CONFIGS.sharepoint.scope).toBe("Sites.Read.All");
    // SharePoint follows the Microsoft pattern: offline_access via the
    // declarative flag, not the raw scope string.
    expect(PROVIDER_OAUTH_CONFIGS.sharepoint.requestOfflineAccess).toBe(true);
    expect(PROVIDER_OAUTH_CONFIGS.sharepoint.scope).not.toContain(
      "offline_access",
    );
  });

  it("reserves the 9894-9899 loopback ports for the account-wide tranche", () => {
    expect(PROVIDER_OAUTH_CONFIGS.zoom.redirectPort).toBe(9894);
    expect(PROVIDER_OAUTH_CONFIGS.google_calendar.redirectPort).toBe(9895);
    expect(PROVIDER_OAUTH_CONFIGS.google_docs.redirectPort).toBe(9896);
    expect(PROVIDER_OAUTH_CONFIGS.google_sheets.redirectPort).toBe(9897);
    expect(PROVIDER_OAUTH_CONFIGS.google_meet.redirectPort).toBe(9898);
    expect(PROVIDER_OAUTH_CONFIGS.sharepoint.redirectPort).toBe(9899);
  });

  it("flags the account-wide tranche as refreshable OAuth2", () => {
    // All six are browser-OAuth2 providers that issue refresh tokens.
    for (const id of [
      "zoom",
      "google_calendar",
      "google_docs",
      "google_sheets",
      "google_meet",
      "sharepoint",
    ] as const) {
      expect(PROVIDER_OAUTH_CONFIGS[id].supportsRefresh).toBe(true);
      expect(PROVIDER_OAUTH_CONFIGS[id].usePkce).toBe(true);
    }
  });

  it("flags the non-OAuth2 (token) providers as non-refreshable", () => {
    // GitLab (PAT) and Trello (API key + token) carry no refresh token;
    // their stored credential is long-lived and reconnect-on-expiry.
    expect(PROVIDER_OAUTH_CONFIGS.gitlab.supportsRefresh).toBe(false);
    expect(PROVIDER_OAUTH_CONFIGS.trello.supportsRefresh).toBe(false);
    // The browser-OAuth2 members of the tranche do refresh.
    expect(PROVIDER_OAUTH_CONFIGS.asana.supportsRefresh).toBe(true);
    expect(PROVIDER_OAUTH_CONFIGS.teams.supportsRefresh).toBe(true);
  });

  it("requests least-privilege read-only scopes for the per-target tranche 4", () => {
    // Discord / Bitbucket / Airtable / Monday: each scope string must
    // stay read-only. A future widening to a write/manage grant (e.g.
    // `boards:write`, `data.records:write`) breaks this test — the
    // security contract for 5000 SME tenants.
    expect(PROVIDER_OAUTH_CONFIGS.discord.scope).toBe("messages.read");
    expect(PROVIDER_OAUTH_CONFIGS.bitbucket.scope).toBe("repository pullrequest");
    expect(PROVIDER_OAUTH_CONFIGS.airtable.scope).toBe(
      "data.records:read schema.bases:read",
    );
    expect(PROVIDER_OAUTH_CONFIGS.monday.scope).toBe("boards:read me:read");
    // No write/manage scope leaks into any of them.
    for (const id of ["discord", "bitbucket", "airtable", "monday"] as const) {
      expect(PROVIDER_OAUTH_CONFIGS[id].scope).not.toMatch(/write|manage|admin|delete/);
    }
  });

  it("reserves the 9900-9903 loopback ports for tranche 4", () => {
    expect(PROVIDER_OAUTH_CONFIGS.discord.redirectPort).toBe(9900);
    expect(PROVIDER_OAUTH_CONFIGS.bitbucket.redirectPort).toBe(9901);
    expect(PROVIDER_OAUTH_CONFIGS.airtable.redirectPort).toBe(9902);
    expect(PROVIDER_OAUTH_CONFIGS.monday.redirectPort).toBe(9903);
  });

  it("flags the tranche-4 providers as non-refreshable (long-lived credentials)", () => {
    // Discord (bot token), Bitbucket + Airtable (access / personal
    // access tokens) carry no refresh token; Monday's OAuth grant
    // issues a long-lived seat token with no refresh — all four are
    // reconnect-on-expiry. None use PKCE.
    for (const id of ["discord", "bitbucket", "airtable", "monday"] as const) {
      expect(PROVIDER_OAUTH_CONFIGS[id].supportsRefresh).toBe(false);
      expect(PROVIDER_OAUTH_CONFIGS[id].usePkce).toBe(false);
    }
  });

  it("requests least-privilege read-only scopes for the support/CRM tranche 5", () => {
    // ClickUp and Intercom take no `scope` parameter — their access is
    // governed by the authorizing user's workspace permissions / the
    // app's configured data access (see SCOPELESS_PROVIDERS). Salesforce
    // requests only `api` (REST read access; the connector issues SOQL
    // SELECT/GET reads against Cases) plus the `refresh_token` protocol
    // scope. A future widening to a write/manage grant breaks this test.
    expect(PROVIDER_OAUTH_CONFIGS.clickup.scope).toBe("");
    expect(PROVIDER_OAUTH_CONFIGS.intercom.scope).toBe("");
    expect(PROVIDER_OAUTH_CONFIGS.salesforce.scope).toBe("api refresh_token");
    // No write/manage/admin/delete scope leaks into any of them.
    for (const id of ["clickup", "intercom", "salesforce"] as const) {
      expect(PROVIDER_OAUTH_CONFIGS[id].scope).not.toMatch(
        /write|manage|admin|delete|full/,
      );
    }
  });

  it("reserves the 9904-9906 loopback ports for tranche 5", () => {
    expect(PROVIDER_OAUTH_CONFIGS.clickup.redirectPort).toBe(9904);
    expect(PROVIDER_OAUTH_CONFIGS.intercom.redirectPort).toBe(9905);
    expect(PROVIDER_OAUTH_CONFIGS.salesforce.redirectPort).toBe(9906);
  });

  it("flags tranche-5 refresh / PKCE per provider", () => {
    // ClickUp and Intercom issue long-lived, refresh-less tokens and
    // do not support PKCE; Salesforce's web-server flow issues a
    // refresh token (via the `refresh_token` scope) and supports PKCE.
    expect(PROVIDER_OAUTH_CONFIGS.clickup.supportsRefresh).toBe(false);
    expect(PROVIDER_OAUTH_CONFIGS.clickup.usePkce).toBe(false);
    expect(PROVIDER_OAUTH_CONFIGS.intercom.supportsRefresh).toBe(false);
    expect(PROVIDER_OAUTH_CONFIGS.intercom.usePkce).toBe(false);
    expect(PROVIDER_OAUTH_CONFIGS.salesforce.supportsRefresh).toBe(true);
    expect(PROVIDER_OAUTH_CONFIGS.salesforce.usePkce).toBe(true);
  });

  it("declares Intercom's non-standard access-token field, and only Intercom's", () => {
    // Intercom's `/auth/eagle/token` endpoint returns the token in a
    // `token` field rather than the RFC 6749 `access_token`. Guard that
    // the override is set for Intercom and for no other provider (a
    // stray override would silently break a standard provider).
    expect(PROVIDER_OAUTH_CONFIGS.intercom.accessTokenField).toBe("token");
    for (const id of KNOWN_PROVIDERS) {
      if (id === "intercom") continue;
      expect(PROVIDER_OAUTH_CONFIGS[id].accessTokenField).toBeUndefined();
    }
  });

  it("asks Dropbox for offline access so its token can refresh", () => {
    expect(PROVIDER_OAUTH_CONFIGS.dropbox.supportsRefresh).toBe(true);
    expect(
      PROVIDER_OAUTH_CONFIGS.dropbox.extraAuthorizeParams?.token_access_type,
    ).toBe("offline");
  });

  it("requests PKCE for Google / Microsoft / Atlassian", () => {
    expect(PROVIDER_OAUTH_CONFIGS.google_drive.usePkce).toBe(true);
    expect(PROVIDER_OAUTH_CONFIGS.onedrive.usePkce).toBe(true);
    expect(PROVIDER_OAUTH_CONFIGS.jira.usePkce).toBe(true);
    expect(PROVIDER_OAUTH_CONFIGS.confluence.usePkce).toBe(true);
  });

  it("flags Figma classic OAuth as PKCE-less", () => {
    expect(PROVIDER_OAUTH_CONFIGS.figma.usePkce).toBe(false);
  });

  it("flags Notion as supportsRefresh=false", () => {
    expect(PROVIDER_OAUTH_CONFIGS.notion.supportsRefresh).toBe(false);
  });

  it("uses basicAuth for Notion's token exchange", () => {
    expect(PROVIDER_OAUTH_CONFIGS.notion.basicAuth).toBe(true);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes client_id, redirect_uri, state and response_type", () => {
    const cfg = getProviderOAuthConfig("google_drive");
    const url = new URL(
      buildAuthorizeUrl(cfg, {
        clientId: "abc",
        state: "xyz",
        codeChallenge: "ch",
        redirectUri: getRedirectUri(cfg),
      }),
    );
    expect(url.searchParams.get("client_id")).toBe("abc");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("response_type")).toBe("code");
    // Google Drive is pinned to `localhost` (rather than `127.0.0.1`)
    // because that is the URI users have already registered in their
    // pre-existing Google Cloud OAuth client. See
    // `providerOAuth.ts > redirectHost` for the rationale.
    expect(url.searchParams.get("redirect_uri")).toContain("localhost:9876");
    expect(url.searchParams.get("code_challenge")).toBe("ch");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("merges extraAuthorizeParams (e.g. access_type=offline)", () => {
    const cfg = getProviderOAuthConfig("google_drive");
    const url = new URL(
      buildAuthorizeUrl(cfg, {
        clientId: "abc",
        state: "xyz",
        redirectUri: getRedirectUri(cfg),
      }),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("omits scope= for providers with empty scope (Notion)", () => {
    const cfg = getProviderOAuthConfig("notion");
    const url = new URL(
      buildAuthorizeUrl(cfg, {
        clientId: "abc",
        state: "xyz",
        redirectUri: getRedirectUri(cfg),
      }),
    );
    expect(url.searchParams.get("scope")).toBeNull();
  });

  it("omits scope= for the scope-less tranche-5 providers (ClickUp, Intercom)", () => {
    for (const id of ["clickup", "intercom"] as const) {
      const cfg = getProviderOAuthConfig(id);
      const url = new URL(
        buildAuthorizeUrl(cfg, {
          clientId: "abc",
          state: "xyz",
          redirectUri: getRedirectUri(cfg),
        }),
      );
      expect(url.searchParams.get("scope")).toBeNull();
    }
  });

  it("carries Salesforce's `api refresh_token` scope on the authorize URL", () => {
    const cfg = getProviderOAuthConfig("salesforce");
    const url = new URL(
      buildAuthorizeUrl(cfg, {
        clientId: "abc",
        state: "xyz",
        codeChallenge: "ch",
        redirectUri: getRedirectUri(cfg),
      }),
    );
    const scopes = (url.searchParams.get("scope") ?? "").split(" ");
    expect(scopes).toContain("api");
    expect(scopes).toContain("refresh_token");
    expect(scopes).not.toContain("offline_access");
  });

  it("appends offline_access to the scope= for requestOfflineAccess providers", () => {
    // Regression: `requestOfflineAccess` must be the single declarative
    // source for the `offline_access` meta-scope. The flag is set but the
    // raw `scope` string omits `offline_access`, so the authorize request
    // must still carry it — otherwise the provider issues no refresh token
    // and every per-target OAuth provider breaks on first token expiry.
    for (const id of [
      "onedrive",
      "jira",
      "confluence",
      "teams",
      "sharepoint",
    ] as const) {
      const cfg = getProviderOAuthConfig(id);
      expect(cfg.requestOfflineAccess).toBe(true);
      expect(cfg.scope).not.toContain("offline_access");
      const url = new URL(
        buildAuthorizeUrl(cfg, {
          clientId: "abc",
          state: "xyz",
          redirectUri: getRedirectUri(cfg),
        }),
      );
      const scopes = (url.searchParams.get("scope") ?? "").split(" ");
      expect(scopes).toContain("offline_access");
      // Exactly once — no duplication if a config still lists it.
      expect(scopes.filter((s) => s === "offline_access")).toHaveLength(1);
    }
  });
});

describe("getRedirectUri", () => {
  it(
    "pins Google Drive to localhost (not 127.0.0.1) for backward " +
      "compatibility with already-registered Cloud Console clients",
    () => {
      const cfg = getProviderOAuthConfig("google_drive");
      expect(getRedirectUri(cfg)).toBe("http://localhost:9876/callback");
    },
  );

  it("defaults every other provider to 127.0.0.1 per RFC 8252", () => {
    // Enumerate the full roster from `KNOWN_PROVIDERS` (minus the
    // Google Drive special case above) so every provider — including
    // substrate-only ones with no other redirect-URI assertion — is
    // covered, and a future provider is checked automatically.
    const others = KNOWN_PROVIDERS.filter((p) => p !== "google_drive");
    expect(others.length).toBe(KNOWN_PROVIDERS.length - 1);
    for (const provider of others) {
      const cfg = getProviderOAuthConfig(provider);
      expect(getRedirectUri(cfg)).toBe(
        `http://127.0.0.1:${cfg.redirectPort}/callback`,
      );
    }
  });
});

describe("generatePkcePair", () => {
  it("produces a verifier and a SHA-256 base64url challenge", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier.length).toBeGreaterThan(40);
    expect(challenge.length).toBeGreaterThan(40);
    expect(/^[A-Za-z0-9_-]+$/.test(verifier)).toBe(true);
    expect(/^[A-Za-z0-9_-]+$/.test(challenge)).toBe(true);
  });

  it("produces different pairs on each call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

describe("exchangeAuthorizationCode", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends client_id / client_secret in body when basicAuth is off", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });
    const cfg = getProviderOAuthConfig("google_drive");
    const tokens = await exchangeAuthorizationCode(cfg, {
      code: "CODE",
      clientId: "ID",
      clientSecret: "SECRET",
      codeVerifier: "VER",
    });
    expect(tokens.accessToken).toBe("AT");
    expect(tokens.refreshToken).toBe("RT");
    expect(tokens.expiresIn).toBe(3600);
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[0]).toBe(cfg.tokenUrl);
    const body = callArgs[1].body as string;
    expect(body).toContain("client_id=ID");
    expect(body).toContain("client_secret=SECRET");
    expect(body).toContain("code_verifier=VER");
    expect(body).toContain("grant_type=authorization_code");
  });

  it("sends Authorization: Basic for Notion", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "AT",
        expires_in: 3600,
        token_type: "bearer",
      }),
    });
    const cfg = getProviderOAuthConfig("notion");
    await exchangeAuthorizationCode(cfg, {
      code: "CODE",
      clientId: "ID",
      clientSecret: "SECRET",
    });
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    const decoded = Buffer.from(
      headers.Authorization.replace(/^Basic /, ""),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe("ID:SECRET");
    const body = fetchMock.mock.calls[0][1].body as string;
    expect(body).not.toContain("client_id=");
    expect(body).not.toContain("client_secret=");
  });

  it("throws when token exchange returns non-2xx", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_grant"}',
    });
    const cfg = getProviderOAuthConfig("google_drive");
    await expect(
      exchangeAuthorizationCode(cfg, {
        code: "CODE",
        clientId: "ID",
        clientSecret: "SECRET",
        codeVerifier: "VER",
      }),
    ).rejects.toThrow(/Token exchange failed/);
  });

  it("throws when response lacks an access token", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token_type: "Bearer" }),
    });
    const cfg = getProviderOAuthConfig("google_drive");
    await expect(
      exchangeAuthorizationCode(cfg, {
        code: "CODE",
        clientId: "ID",
        clientSecret: "SECRET",
      }),
    ).rejects.toThrow(/no access token/);
  });

  it("reads Intercom's non-standard `token` field as the access token", async () => {
    // Intercom's `/auth/eagle/token` endpoint returns
    // `{ token, type }` rather than the RFC 6749 `{ access_token }`.
    // The `accessTokenField` override must pick up `token`, and the
    // raw secret must NOT leak into the passthrough `extra` payload.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "INTERCOM_AT", type: "bearer" }),
    });
    const tokens = await exchangeAuthorizationCode(
      getProviderOAuthConfig("intercom"),
      { code: "CODE", clientId: "ID", clientSecret: "SECRET" },
    );
    expect(tokens.accessToken).toBe("INTERCOM_AT");
    // Non-expiring, refresh-less → multi-year default and no refresh token.
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.expiresIn).toBe(10 * 365 * 24 * 3600);
    expect(tokens.extra?.token).toBeUndefined();
  });

  it("still reads the standard `access_token` when a custom field is configured but absent", async () => {
    // Defense-in-depth: the `accessTokenField` override falls back to
    // the standard `access_token`, so a provider that later returns the
    // standard field keeps working.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "STD_AT", token_type: "Bearer" }),
    });
    const tokens = await exchangeAuthorizationCode(
      getProviderOAuthConfig("intercom"),
      { code: "CODE", clientId: "ID", clientSecret: "SECRET" },
    );
    expect(tokens.accessToken).toBe("STD_AT");
  });

  it("uses a multi-year `expiresIn` default for non-refreshable providers when the response omits `expires_in` (Notion regression)", async () => {
    // Notion's token-exchange response is documented to omit
    // `expires_in` entirely because its integration tokens are
    // non-expiring. The previous code defaulted to 3600s, making
    // every stored Notion token *look* expired after one hour and
    // triggering the auth-state cleanup path. The fix uses a very
    // large default for providers whose config says
    // `supportsRefresh = false`, so the stored `expiresAt` reads as
    // effectively-non-expiring on inspection.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "AT",
        token_type: "Bearer",
        workspace_id: "WS",
      }),
    });
    const tokens = await exchangeAuthorizationCode(
      getProviderOAuthConfig("notion"),
      {
        code: "CODE",
        clientId: "ID",
        clientSecret: "SECRET",
      },
    );
    // 10 years in seconds.
    expect(tokens.expiresIn).toBe(10 * 365 * 24 * 3600);
  });

  it("keeps the 1-hour default for *refreshable* providers when `expires_in` is missing", async () => {
    // Defensive: Google Drive ought to always return `expires_in`,
    // but if a buggy upstream omits it, the 1-hour default is still
    // the right call for refreshable providers — we'd just refresh
    // an hour from now using the stored refresh token.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "AT",
        token_type: "Bearer",
        // No `expires_in`.
      }),
    });
    const tokens = await exchangeAuthorizationCode(
      getProviderOAuthConfig("google_drive"),
      {
        code: "CODE",
        clientId: "ID",
        clientSecret: "SECRET",
      },
    );
    expect(tokens.expiresIn).toBe(3600);
  });

  it("preserves provider extras on the TokenResponse", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "AT",
        expires_in: 1234,
        token_type: "Bearer",
        workspace_id: "WS",
        workspace_name: "Tessera HQ",
      }),
    });
    const tokens = await exchangeAuthorizationCode(
      getProviderOAuthConfig("notion"),
      {
        code: "CODE",
        clientId: "ID",
        clientSecret: "SECRET",
      },
    );
    expect(tokens.extra?.workspace_id).toBe("WS");
    expect(tokens.extra?.workspace_name).toBe("Tessera HQ");
  });
});

describe("refreshProviderToken", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws for providers that don't support refresh", async () => {
    const cfg = getProviderOAuthConfig("notion");
    await expect(
      refreshProviderToken(cfg, {
        refreshToken: "RT",
        clientId: "ID",
        clientSecret: "SECRET",
      }),
    ).rejects.toThrow(/does not support refresh/);
  });

  it("returns a new access token + preserves refresh when one is not returned", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "NEW_AT",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });
    const tokens = await refreshProviderToken(
      getProviderOAuthConfig("google_drive"),
      {
        refreshToken: "ORIG_RT",
        clientId: "ID",
        clientSecret: "SECRET",
      },
    );
    expect(tokens.accessToken).toBe("NEW_AT");
    expect(tokens.refreshToken).toBe("ORIG_RT");
  });

  it("returns rotated refresh token when the provider supplies one (Atlassian)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "NEW_AT",
        refresh_token: "NEW_RT",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    });
    const tokens = await refreshProviderToken(
      getProviderOAuthConfig("jira"),
      {
        refreshToken: "ORIG_RT",
        clientId: "ID",
        clientSecret: "SECRET",
      },
    );
    expect(tokens.refreshToken).toBe("NEW_RT");
  });

  it("throws on a non-2xx response", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"error":"invalid_token"}',
    });
    await expect(
      refreshProviderToken(getProviderOAuthConfig("google_drive"), {
        refreshToken: "RT",
        clientId: "ID",
        clientSecret: "SECRET",
      }),
    ).rejects.toThrow(/Token refresh failed/);
  });

  it("honours a custom accessTokenField on refresh, symmetric with exchange", async () => {
    // No shipping provider currently sets both `accessTokenField` and
    // `supportsRefresh`, but the two code paths must stay symmetric so a
    // future provider that does won't silently read the wrong field on
    // refresh. Synthesize such a config and assert the override wins and
    // the raw secret is stripped from `extra`.
    const cfg = {
      ...getProviderOAuthConfig("google_drive"),
      accessTokenField: "token",
      supportsRefresh: true,
    } as const;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        token: "REFRESHED_AT",
        refresh_token: "NEW_RT",
        expires_in: 3600,
        type: "bearer",
      }),
    });
    const tokens = await refreshProviderToken(cfg, {
      refreshToken: "ORIG_RT",
      clientId: "ID",
      clientSecret: "SECRET",
    });
    expect(tokens.accessToken).toBe("REFRESHED_AT");
    expect(tokens.refreshToken).toBe("NEW_RT");
    expect(tokens.extra).not.toHaveProperty("token");
    expect(tokens.extra).not.toHaveProperty("access_token");
  });
});
