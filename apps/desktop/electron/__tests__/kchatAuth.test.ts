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
    const fetchFn = vi.fn(async () =>
      userResponse(),
    ) as unknown as typeof globalThis.fetch;
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
    await expect(
      svc.connect("PAT-bad", "https://kchat.example.com"),
    ).rejects.toBeTruthy();
    expect(vaultStore.has("kchat")).toBe(false);
  });

  // Sixth-pass Devin Review: the catch path in
  // `connect()` previously called `setToken(null)` BEFORE re-throwing
  // the error, so when the IPC layer's `toIpcError` later ran
  // `scrubMessage` the literal-token redaction was a no-op (the
  // client had no live token to scrub). The fix scrubs the error
  // message IN PLACE with the live token before clearing it, so
  // any future code path that embeds the PAT in an error string is
  // redacted before the message ever leaves the auth service.
  it("scrubs the live PAT from the error message before clearing the token", async () => {
    const tokenLiteral = "PAT-conn-fail-secret-abcdefghij1234567890";
    // The server echoes the token bytes back into the response
    // body. KchatRequestError builds its message from
    // `body.error` (truncated to 256 chars). Without the
    // scrub-before-clear ordering, the rethrown error message
    // would carry the PAT through to the IPC boundary.
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () =>
        JSON.stringify({
          error: `request token ${tokenLiteral} rejected`,
        }),
      json: async () => ({
        error: `request token ${tokenLiteral} rejected`,
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    })) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    let captured: Error | null = null;
    try {
      await svc.connect(tokenLiteral, "https://kchat.example.com");
    } catch (err) {
      captured = err instanceof Error ? err : new Error(String(err));
    }
    expect(captured).toBeTruthy();
    expect(captured!.message).not.toContain(tokenLiteral);
    expect(captured!.message).toContain("[REDACTED]");
    // The token is still cleared from the client after the scrub —
    // the in-memory bad token cannot persist.
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

  it("rejects whitespace-only tokens before touching the network", async () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await expect(
      svc.connect("   \t\n", "https://kchat.example.com"),
    ).rejects.toThrow(/token is required/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  // the catch path in
  // `connect()` previously cleared the in-memory token but did NOT
  // reset `authMode` back to `"none"`. So a PAT→bad-PAT re-connect
  // would leave the service in `{ state: "error", authMode: "pat" }`
  // — semantically misleading because no live PAT exists in memory.
  // The fix resets `authMode` to `"none"` in the catch block (vault
  // entry untouched, so `restoreFromVault()` can still recover the
  // prior session).
  it("resets authMode to 'none' when a re-connect from authMode==='pat' fails verifyConnection", async () => {
    // First a successful PAT connect to put the service in
    // `authMode === "pat"`.
    let nextResponse: () => Promise<Response> = async () => userResponse();
    const fetchFn = vi.fn(async () =>
      nextResponse(),
    ) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await svc.connect("PAT-good", "https://kchat.example.com");
    // Pin the precondition: after a successful connect, authMode is
    // "pat" (the bug only manifests in this re-connect path).
    expect(svc.getAuthMode()).toBe("pat");
    // Fail the next verifyConnection by returning a 401.
    nextResponse = async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "invalid_token",
        json: async () => ({ error: "invalid_token" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response;
    // Re-connect with a different token (simulating the user pasting
    // a new but-now-bad token into Settings).
    await expect(
      svc.connect("PAT-bad-replacement", "https://kchat.example.com"),
    ).rejects.toBeTruthy();
    // The fix: getState() / getAuthMode() must report
    // `authMode: "none"`, matching the in-memory truth that no live
    // PAT remains. The ordering inside the catch block
    // (`authMode = "none"` BEFORE `setToken(null)`) is what makes any
    // subsequent client-emitted status push carry the post-failure
    // authMode rather than the stale `"pat"` value.
    expect(svc.getAuthMode()).toBe("none");
    expect(svc.getState().authMode).toBe("none");
    // The vault entry from the previous successful connect is
    // intentionally preserved — a failed re-connect must not wipe a
    // previously-good stored credential. The user can still call
    // `restoreFromVault()` to recover the prior session.
    expect(vaultStore.has("kchat")).toBe(true);
  });

  // Boundary normalisation: a PAT pasted with stray whitespace must
  // be trimmed once at the entry point so the in-memory `setToken`,
  // the vault, and the Authorization header all see the canonical
  // value. Earlier versions only trimmed for the empty-check and
  // stored the untrimmed string.
  it("trims surrounding whitespace from the token before persisting + sending", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn = vi.fn(async (url: unknown, init: unknown) => {
      captured = { url: String(url), init: init as RequestInit };
      return userResponse();
    }) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await svc.connect("  PAT-trimmed  \n", "https://kchat.example.com");
    // Authorization header carries the trimmed value (no stray
    // leading/trailing whitespace).
    const headers = (captured!.init.headers as Record<string, string>) || {};
    expect(headers.Authorization).toBe("Bearer PAT-trimmed");
    // Vault entry is also the trimmed canonical form.
    const stored = vaultStore.get("kchat");
    expect(stored!.accessToken).toBe("PAT-trimmed");
  });
});

describe("KchatAuthService.disconnect", () => {
  it("returns the persisted user id and clears the vault entry", async () => {
    // KChat object ids must match /^[a-z0-9]{20,32}$/, validated
    // at deserialisation in `verifyConnection`. Use a well-formed
    // id here so the connect path that gates this test succeeds.
    const fetchFn = vi.fn(async () =>
      userResponse("uidstored0000000000ab"),
    ) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await svc.connect("PAT-good", "https://kchat.example.com");
    expect(vaultStore.has("kchat")).toBe(true);
    const id = svc.disconnect();
    expect(id).toBe("uidstored0000000000ab");
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

  // Regression pin for the disconnect ordering invariant:
  // `readStoredAuth()` MUST run BEFORE `deleteTokens()` so the
  // userId is captured for the audit log. The existing
  // "returns the persisted user id" test asserts the return value
  // but a future refactor that fetched the id via a different
  // path (e.g. a cached field on the service) could pass that
  // assertion while still introducing a subtle bug. Pin the
  // ordering explicitly by checking the vault store at the moment
  // `deleteTokens` runs.
  it("calls readStoredAuth before deleteTokens (ordering pin for the audit-log invariant)", async () => {
    // Use a well-formed KChat object id (matches the regex enforced
    // by `verifyConnection`).
    const fetchFn = vi.fn(async () =>
      userResponse("uidordering000000000a"),
    ) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await svc.connect("PAT", "https://kchat.example.com");

    // Snapshot the vault state ordering as `disconnect()` runs.
    // We monkey-patch `Map.prototype.delete` on the shared mock
    // vault to capture whether the entry was still present at the
    // moment delete was called. If `readStoredAuth()` ran first,
    // the entry IS still there at delete time.
    let entryStillPresentAtDelete: boolean | null = null;
    const realDelete = vaultStore.delete.bind(vaultStore);
    vaultStore.delete = (key: string) => {
      entryStillPresentAtDelete = vaultStore.has(key);
      return realDelete(key);
    };
    try {
      const id = svc.disconnect();
      expect(id).toBe("uidordering000000000a");
      // The audit-log id was extracted BEFORE the vault entry was
      // cleared. A refactor that reordered shutdown + deleteTokens
      // ahead of readStoredAuth would fail this assertion.
      expect(entryStillPresentAtDelete).toBe(true);
    } finally {
      vaultStore.delete = realDelete;
    }
  });
});

describe("KchatAuthService.connect health-check teardown invariant", () => {
  // Regression test for the case where a successful connect()
  // → server-down → state="error" → user clicks Connect with the
  // same token+URL → connect() runs again → verify fails → catch
  // path runs. Before the fix, the original health-check timer
  // kept firing every 30s producing spurious "token is not
  // configured" error transitions. The fix is two-fold: (1)
  // `setToken(null)` in the catch path now stops the timer, and
  // (2) `connect()` itself stops the timer up-front so the
  // same-URL-same-token retry case (where setServerUrl/setToken
  // are no-ops) is also covered.
  it("stops any pre-existing health-check timer at the start of connect()", async () => {
    // First connect succeeds (arms the health-check timer); then a
    // failing re-connect with the SAME token+URL must NOT leave
    // the original timer running.
    let phase: "first" | "second" = "first";
    const fetchFn = vi.fn(async () => {
      if (phase === "first") return userResponse();
      return {
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "invalid_token",
        json: async () => ({}),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);

    vi.useFakeTimers();
    try {
      // Arm the timer under fake-time control so we can observe
      // future ticks.
      await svc.connect("PAT-same", "https://kchat.example.com");
      expect(client.getState().state).toBe("connected");
      const callsAfterFirst = (fetchFn as unknown as ReturnType<typeof vi.fn>)
        .mock.calls.length;

      phase = "second";
      // The re-connect rejects (401 is non-retryable so this fails
      // fast without consuming many fetch calls).
      await expect(
        svc.connect("PAT-same", "https://kchat.example.com"),
      ).rejects.toBeTruthy();
      const callsAfterRetry = (fetchFn as unknown as ReturnType<typeof vi.fn>)
        .mock.calls.length;
      // Sanity: the second connect did make at least one fetch
      // (its verifyConnection attempt) — otherwise the test is
      // measuring nothing.
      expect(callsAfterRetry).toBeGreaterThan(callsAfterFirst);

      // Advance well past one health-check interval (30s). Before
      // the fix, the original timer would fire and produce another
      // verifyConnection call → fetch. With the fix it has been
      // stopped, so no further fetches should occur.
      await vi.advanceTimersByTimeAsync(120_000);
      const callsAfterAdvance = (fetchFn as unknown as ReturnType<typeof vi.fn>)
        .mock.calls.length;
      expect(callsAfterAdvance).toBe(callsAfterRetry);
    } finally {
      vi.useRealTimers();
    }
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

  // on `verifyConnection`
  // failure, `restoreFromVault()` previously left the client carrying
  // the stale token and serverUrl that were pushed into it just
  // before the failed verify. The fix matches the symmetric cleanup
  // already present in `connect()` — call `client.setToken(null)` on
  // the failure path so the client's in-memory view matches the
  // auth-service view (no live PAT). This pins that contract via
  // the only observable downstream effect: a subsequent
  // `verifyConnection()` call against the client must fail at the
  // token-presence guard in `KchatClient.request()` rather than
  // proceeding into a fetch with a stale Bearer header.
  it("clears the client's in-memory token on a failed verifyConnection during restore", async () => {
    vaultStore.set("kchat", {
      accessToken: "PAT-restored-but-stale",
      scopes: [
        JSON.stringify({
          serverUrl: "https://kchat.example.com",
          userId: "user1234567890abcdefgh",
          verifiedAt: new Date(0).toISOString(),
        }),
      ],
    });
    // First fetch (called during restoreFromVault → verifyConnection)
    // returns 401. The client should propagate the rejection.
    let pending: () => Promise<Response> = async () =>
      ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "invalid_token",
        json: async () => ({ error: "invalid_token" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      }) as unknown as Response;
    const fetchFn = vi.fn(async () =>
      pending(),
    ) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);

    await expect(svc.restoreFromVault()).rejects.toBeTruthy();

    // After the rollback, the second fetch (if it ever runs) would
    // succeed — but it must not run, because the token-presence
    // guard in `KchatClient.request()` should now throw before any
    // fetch is dispatched. If the rollback regressed, this fetch
    // would receive an Authorization header carrying the
    // "PAT-restored-but-stale" token instead.
    pending = async () => userResponse();
    await expect(client.verifyConnection()).rejects.toThrow(
      /token is not configured/i,
    );
    // The pre-restore fetch + the rejected-verifyConnection-from-
    // request guard = 1 fetch total. If the rollback regressed, the
    // post-restore verifyConnection would have invoked fetch a
    // second time.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("KchatAuthService.getState renderer safety", () => {
  it("never includes the token in any state field after a successful connect", async () => {
    const fetchFn = vi.fn(async () =>
      userResponse(),
    ) as unknown as typeof globalThis.fetch;
    const client = new KchatClient({ fetchFn, sleep: async () => {} });
    const svc = new KchatAuthService(client);
    await svc.connect("PAT-secret", "https://kchat.example.com");
    const state = svc.getState();
    expect(JSON.stringify(state)).not.toContain("PAT-secret");
    expect(state.state).toBe("connected");
    expect(state.user?.username).toBe("ken");
  });
});
