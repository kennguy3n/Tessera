/**
 * OAuth refresh race-condition regression suite.
 *
 * Two concurrent `getValidAccessToken` callers for the same provider
 * MUST collapse onto a single in-flight refresh exchange:
 *
 *   1. Only ONE network round-trip to the provider's token endpoint.
 *      Atlassian / OneDrive / sometimes-Google rotate the refresh
 *      token on each successful exchange — a second request would
 *      arrive with an already-invalidated refresh token and silently
 *      sign the user out of the connector.
 *
 *   2. Only ONE `storeTokens` write to the vault. A lost-update on
 *      the rotated refresh token would leave the vault holding a
 *      revoked credential.
 *
 * The suite mocks `refreshProviderToken` so the test never needs
 * real HTTP, and counts the calls. The mock blocks on a Promise the
 * test controls so we can fire the second caller while the first is
 * still mid-exchange — the registry's "in-flight" branch is the
 * only code path that satisfies the assertion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  dialog: {},
}));

// Intercept the network call. The mock is wired up before the module
// under test imports `refreshProviderToken`. Vitest hoists `vi.mock`
// to the top of the file, so `refreshMock` must be declared inside
// `vi.hoisted` to share the same hoist phase. Each test installs its
// own implementation via `refreshMock.mockImplementation(…)`.
const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));
vi.mock("../ipc/connectors/providerOAuth", async () => {
  const actual = await vi.importActual<
    typeof import("../ipc/connectors/providerOAuth")
  >("../ipc/connectors/providerOAuth");
  return {
    ...actual,
    refreshProviderToken: refreshMock,
  };
});

import {
  __resetOAuthRefreshRegistryForTests,
  getValidAccessTokenForProvider,
} from "../ipc/connectors/handlers";
import type { IpcContext } from "../ipc/context";

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
}

interface MockCtx {
  ctx: IpcContext;
  store: Map<string, StoredTokens>;
  storeWrites: number;
}

function makeCtx(initial: Partial<Record<string, StoredTokens>>): MockCtx {
  const store = new Map<string, StoredTokens>(
    Object.entries(initial).filter(([, v]) => v !== undefined) as [
      string,
      StoredTokens,
    ][],
  );
  let storeWrites = 0;
  const tokenVault = {
    getTokens: (p: string) => store.get(p) ?? null,
    storeTokens: (p: string, t: StoredTokens) => {
      storeWrites += 1;
      store.set(p, t);
    },
    deleteTokens: (p: string) => {
      store.delete(p);
    },
  } as unknown as IpcContext["tokenVault"];
  const ctx = {
    tokenVault,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as IpcContext;
  // `storeWrites` needs to be read after each `storeTokens` call;
  // expose via a getter so callers see the latest value.
  return {
    ctx,
    store,
    get storeWrites() {
      return storeWrites;
    },
  };
}

describe("OAuth refresh race-condition guard", () => {
  beforeEach(() => {
    refreshMock.mockReset();
    __resetOAuthRefreshRegistryForTests();
  });

  it("collapses two concurrent refreshes onto a single network exchange", async () => {
    // Block the refresh inside the test so the second caller is
    // guaranteed to arrive while the first is still in-flight.
    let resolveRefresh: (() => void) | null = null;
    refreshMock.mockImplementation(() => {
      return new Promise<{
        accessToken: string;
        refreshToken: string | null;
        expiresIn: number;
        tokenType: string;
      }>((resolve) => {
        resolveRefresh = () =>
          resolve({
            accessToken: "fresh-access-token",
            refreshToken: "rotated-refresh-token",
            expiresIn: 3600,
            tokenType: "Bearer",
          });
      });
    });

    const expired = Date.now() - 60 * 1000;
    const seed: StoredTokens = {
      accessToken: "stale-access-token",
      refreshToken: "original-refresh-token",
      expiresAt: expired,
      scopes: ["files.readonly"],
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
    };
    const m = makeCtx({ google_drive: seed });

    // Two concurrent callers. The second is awaited AFTER the first
    // has yielded into the in-flight refresh exchange — both end up
    // in the same microtask wave because we never resolved the
    // refresh promise in between, so the second caller's
    // `getTokens` returns the stale `expiresAt` and it follows the
    // refresh path. The race-guard MUST recognise the in-flight
    // promise and attach to it rather than launching its own.
    const p1 = getValidAccessTokenForProvider(m.ctx, "google_drive");
    const p2 = getValidAccessTokenForProvider(m.ctx, "google_drive");

    // Yield to the microtask queue so both callers have entered
    // the refresh path before we resolve the mock.
    await Promise.resolve();
    await Promise.resolve();

    expect(refreshMock).toHaveBeenCalledTimes(1);

    // Resolve the in-flight exchange and let both callers complete.
    if (!resolveRefresh) {
      throw new Error("refresh mock was never invoked");
    }
    resolveRefresh();
    const [t1, t2] = await Promise.all([p1, p2]);

    expect(t1).toBe("fresh-access-token");
    expect(t2).toBe("fresh-access-token");
    // Both callers must observe the SAME fresh token — strict-equal
    // identity rules out "second caller got the stale value somehow".
    expect(t1).toBe(t2);

    // Exactly one network call AND exactly one vault write — the
    // load-bearing race-guard properties enforces.
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(m.storeWrites).toBe(1);
  });

  it("collapses N>2 concurrent refreshes onto a single network exchange", async () => {
    // The Map-based guard must hold for the cluster scenario
    // (e.g. a `Promise.all` over five different paginated API
    // calls all noticing an expired token on the first request).
    let resolveRefresh: (() => void) | null = null;
    refreshMock.mockImplementation(() => {
      return new Promise<{
        accessToken: string;
        refreshToken: string | null;
        expiresIn: number;
        tokenType: string;
      }>((resolve) => {
        resolveRefresh = () =>
          resolve({
            accessToken: "fresh-access-token-N",
            refreshToken: "rotated",
            expiresIn: 3600,
            tokenType: "Bearer",
          });
      });
    });

    const expired = Date.now() - 60 * 1000;
    const m = makeCtx({
      onedrive: {
        accessToken: "stale",
        refreshToken: "orig",
        expiresAt: expired,
        scopes: [],
        clientId: "cid",
        clientSecret: "csec",
      },
    });

    const promises = Array.from({ length: 5 }, () =>
      getValidAccessTokenForProvider(m.ctx, "onedrive"),
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(refreshMock).toHaveBeenCalledTimes(1);

    if (!resolveRefresh) {
      throw new Error("refresh mock was never invoked");
    }
    resolveRefresh();
    const tokens = await Promise.all(promises);

    expect(tokens.every((t) => t === "fresh-access-token-N")).toBe(true);
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(m.storeWrites).toBe(1);
  });

  it("keeps refreshes for different providers independent", async () => {
    // A Drive refresh in-flight must NOT block a concurrent Jira
    // refresh — they touch different token endpoints and different
    // vault entries. The registry is keyed by ProviderId for this
    // exact reason.
    let resolveDrive: (() => void) | null = null;
    let resolveJira: (() => void) | null = null;
    refreshMock.mockImplementation((config: { provider: string }) => {
      if (config.provider === "google_drive") {
        return new Promise((resolve) => {
          resolveDrive = () =>
            resolve({
              accessToken: "drive-fresh",
              refreshToken: "drive-rot",
              expiresIn: 3600,
              tokenType: "Bearer",
            });
        });
      }
      return new Promise((resolve) => {
        resolveJira = () =>
          resolve({
            accessToken: "jira-fresh",
            refreshToken: "jira-rot",
            expiresIn: 3600,
            tokenType: "Bearer",
          });
      });
    });

    const expired = Date.now() - 60 * 1000;
    const m = makeCtx({
      google_drive: {
        accessToken: "drive-stale",
        refreshToken: "drive-orig",
        expiresAt: expired,
        scopes: [],
        clientId: "cid-drive",
        clientSecret: "csec-drive",
      },
      jira: {
        accessToken: "jira-stale",
        refreshToken: "jira-orig",
        expiresAt: expired,
        scopes: [],
        clientId: "cid-jira",
        clientSecret: "csec-jira",
      },
    });

    const driveP = getValidAccessTokenForProvider(m.ctx, "google_drive");
    const jiraP = getValidAccessTokenForProvider(m.ctx, "jira");

    await Promise.resolve();
    await Promise.resolve();

    // Both providers must have an in-flight refresh — neither
    // blocked the other.
    expect(refreshMock).toHaveBeenCalledTimes(2);

    if (!resolveDrive || !resolveJira) {
      throw new Error("one of the refresh mocks was never invoked");
    }
    resolveDrive();
    resolveJira();
    const [driveTok, jiraTok] = await Promise.all([driveP, jiraP]);

    expect(driveTok).toBe("drive-fresh");
    expect(jiraTok).toBe("jira-fresh");
    expect(refreshMock).toHaveBeenCalledTimes(2);
    expect(m.storeWrites).toBe(2);
  });

  it("a failed refresh does NOT poison the next caller's retry", async () => {
    // If the refresh fails with a transient error the registry
    // entry must be cleared so the next caller can retry. Otherwise
    // a single offline blip would leave the connector permanently
    // unable to refresh.
    refreshMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce({
        accessToken: "retry-success",
        refreshToken: "rotated",
        expiresIn: 3600,
        tokenType: "Bearer",
      });

    const expired = Date.now() - 60 * 1000;
    const m = makeCtx({
      jira: {
        accessToken: "stale",
        refreshToken: "orig",
        expiresAt: expired,
        scopes: [],
        clientId: "cid",
        clientSecret: "csec",
      },
    });

    await expect(
      getValidAccessTokenForProvider(m.ctx, "jira"),
    ).rejects.toThrow();

    // Second caller (the retry) must NOT be wedged on a stale
    // registry entry — it must launch its own refresh exchange.
    const fresh = await getValidAccessTokenForProvider(m.ctx, "jira");
    expect(fresh).toBe("retry-success");
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });
});
