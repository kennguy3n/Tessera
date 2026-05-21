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

describe("PROVIDER_OAUTH_CONFIGS", () => {
  it("exposes a config for every known provider with a unique port", () => {
    const ports = new Set<number>();
    for (const id of [
      "google_drive",
      "onedrive",
      "notion",
      "jira",
      "confluence",
      "figma",
    ] as const) {
      const cfg = PROVIDER_OAUTH_CONFIGS[id];
      expect(cfg).toBeDefined();
      expect(cfg.provider).toBe(id);
      expect(cfg.authUrl).toMatch(/^https:\/\//);
      expect(cfg.tokenUrl).toMatch(/^https:\/\//);
      expect(ports.has(cfg.redirectPort)).toBe(false);
      ports.add(cfg.redirectPort);
    }
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
    expect(url.searchParams.get("redirect_uri")).toContain("127.0.0.1:9876");
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

  it("throws when response lacks an access_token", async () => {
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
    ).rejects.toThrow(/no access_token/);
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
});
