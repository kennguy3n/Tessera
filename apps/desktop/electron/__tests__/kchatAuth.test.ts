/**
 * Tests for `KchatAuthService` (electron/kchat/kchatAuth.ts).
 *
 * The token vault is mocked so the test does not write to the real
 * userData directory; the underlying `KchatClient` is wired through
 * the production code path (`new KchatAuthService()`) with a
 * fetch-injected client we install via the optional ctor arg.
 *
 * Coverage:
 *   1. `connect()` persists the PAT in the vault under the
 *      `kchat` provider and writes a JSON-encoded metadata
 *      envelope in `scopes[0]`.
 *   2. `connect()` clears the in-memory token AND skips the vault
 *      write when verification fails — so a known-bad PAT does not
 *      get written to disk.
 *   3. `restoreFromVault()` re-hydrates the URL, token, and runs
 *      `verifyConnection()` against the configured server.
 *   4. `disconnect()` returns the previously persisted user id (so
 *      the audit row can name them) and deletes the vault entry.
 *   5. The renderer-facing `getState()` never carries the token in
 *      any field, even after a successful connect.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const vaultStore = new Map<string, { accessToken: string; scopes: string[] }>();

vi.mock("../tokenVault", () => ({
  storeTokens: (p: string, t: { accessToken: string; scopes: string[] }) =>
    vaultStore.set(p, { accessToken: t.accessToken, scopes: [...t.scopes] }),
  getTokens: (p: string) => vaultStore.get(p) ?? null,
  hasTokens: (p: string) => vaultStore.has(p),
  deleteTokens: (p: string) => {
    vaultStore.delete(p);
  },
  listProviders: () => [...vaultStore.keys()],
  encryptionUnavailableReason: () => null,
}));

import { KchatAuthService } from "../kchat/kchatAuth";
import { KchatClient } from "../kchat/kchatClient";

function userResponse(id = "user1234567890abcdefgh") {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => ({
      id,
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    }),
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

beforeEach(() => {
  vaultStore.clear();
});

describe("KchatAuthService.connect", () => {
  it("persists the PAT under provider 'kchat' and records server + user metadata", async () => {
    const fetchFn = vi.fn(async () => userResponse()) as unknown as
      typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    const user = await svc.connect("PAT-good", "https://kchat.example.com");
    expect(user.id).toBe("user1234567890abcdefgh");
    const stored = vaultStore.get("kchat");
    expect(stored).toBeTruthy();
    expect(stored!.accessToken).toBe("PAT-good");
    const meta = JSON.parse(stored!.scopes[0]) as {
      serverUrl: string;
      userId: string;
    };
    expect(meta.serverUrl).toBe("https://kchat.example.com");
    expect(meta.userId).toBe("user1234567890abcdefgh");
  });

  it("does NOT write a known-bad token to the vault on auth failure", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "invalid_token",
      json: async () => ({}),
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await expect(svc.connect("PAT-bad", "https://kchat.example.com")).rejects
      .toBeTruthy();
    expect(vaultStore.has("kchat")).toBe(false);
  });

  it("rejects empty tokens before touching the network", async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await expect(svc.connect("", "https://kchat.example.com")).rejects.toThrow(
      /token is required/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("KchatAuthService.disconnect", () => {
  it("returns the persisted user id and clears the vault entry", async () => {
    const fetchFn = vi.fn(async () => userResponse("uid-stored")) as unknown as
      typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await svc.connect("PAT-good", "https://kchat.example.com");
    expect(vaultStore.has("kchat")).toBe(true);
    const id = svc.disconnect();
    expect(id).toBe("uid-stored");
    expect(vaultStore.has("kchat")).toBe(false);
  });

  it("returns null when nothing is persisted (idempotent disconnect)", () => {
    const client = new KchatClient({
      fetchFn: vi.fn() as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const svc = new KchatAuthService(client);
    expect(svc.disconnect()).toBeNull();
  });
});

describe("KchatAuthService.restoreFromVault", () => {
  it("returns null when no token is stored", async () => {
    const client = new KchatClient({
      fetchFn: vi.fn() as unknown as typeof globalThis.fetch,
      sleep: async () => {},
    });
    const svc = new KchatAuthService(client);
    expect(await svc.restoreFromVault()).toBeNull();
  });

  it("re-hydrates from the stored envelope and re-verifies against the saved URL", async () => {
    vaultStore.set("kchat", {
      accessToken: "PAT-restored",
      scopes: [
        JSON.stringify({
          serverUrl: "https://kchat.example.com",
          userId: "user1234567890abcdefgh",
          verifiedAt: new Date(0).toISOString(),
        }),
      ],
    });
    const seen: string[] = [];
    const fetchFn = vi.fn(async (url: unknown) => {
      seen.push(String(url));
      return userResponse();
    }) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    const user = await svc.restoreFromVault();
    expect(user?.id).toBe("user1234567890abcdefgh");
    expect(seen[0]).toBe("https://kchat.example.com/api/v4/users/me");
  });
});

describe("KchatAuthService.getState renderer safety", () => {
  it("never includes the token in any state field after a successful connect", async () => {
    const fetchFn = vi.fn(async () => userResponse()) as unknown as
      typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await svc.connect("PAT-secret", "https://kchat.example.com");
    const state = svc.getState();
    expect(JSON.stringify(state)).not.toContain("PAT-secret");
    expect(state.state).toBe("connected");
    expect(state.user?.username).toBe("ken");
  });
});
