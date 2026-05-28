/**
 * Tests for the `KchatClient` REST + WebSocket helper in
 * `electron/kchat/kchatClient.ts`.
 *
 * The client is exercised through dependency injection (custom
 * `fetch`, `sleep`, `random`, `WebSocket`) so the test runs
 * deterministically with no real network. Coverage:
 *
 *   1. Server URL trimming + token redaction (the auth header is
 *      attached to every request; the token never appears in any
 *      sanitised state object).
 *   2. `/users/me` → `verifyConnection` happy path + transition
 *      to `connected` with sanitised user (no `last_picture_update`
 *      bytes-leak).
 *   3. Retry-with-backoff on 503 (transient) — succeeds on 2nd try.
 *   4. Non-retryable 401 surfaces as `KchatRequestError` with the
 *      correct status code and a connection-state transition to
 *      `error`.
 *   5. Rate limiter is consumed once per request (token-bucket
 *      key derived from the rate-limit profile name).
 *   6. WebSocket: a custom WS ctor is invoked with the
 *      `ws://server/api/v4/websocket` URL, the auth challenge is
 *      sent on `onopen` with the token, and parsed `posted`
 *      events flow to listeners.
 *   7. `disconnect`-by-user does NOT trigger reconnect (the
 *      `wsClosedByUser` flag is honoured).
 */
import { describe, it, expect, vi } from "vitest";

import {
  DEFAULT_KCHAT_SERVER,
  KchatClient,
  KchatRequestError,
  WebSocketLike,
} from "../kchat/kchatClient";
import { RateLimiter } from "../ipc/rateLimiter";

interface MockResponse {
  status: number;
  statusText?: string;
  body?: unknown;
  bodyText?: string;
  bodyBytes?: Uint8Array;
}

function ok<T>(body: T, status = 200): MockResponse {
  return { status, body };
}

function makeFetch(
  responses: MockResponse[] | ((url: string, init: RequestInit) => MockResponse),
): {
  fn: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fn = (async (url: unknown, init: unknown) => {
    const u = String(url);
    const i = init as RequestInit;
    calls.push({ url: u, init: i });
    const r =
      typeof responses === "function"
        ? responses(u, i)
        : responses[Math.min(index++, responses.length - 1)];
    const status = r.status;
    const statusText = r.statusText ?? (status === 200 ? "OK" : "ERR");
    const ok = status >= 200 && status < 300;
    const text =
      r.bodyText ??
      (r.body === undefined
        ? ""
        : typeof r.body === "string"
          ? r.body
          : JSON.stringify(r.body));
    return {
      ok,
      status,
      statusText,
      text: async () => text,
      json: async () => (r.body === undefined ? null : r.body),
      arrayBuffer: async () => {
        if (r.bodyBytes) {
          return r.bodyBytes.buffer.slice(
            r.bodyBytes.byteOffset,
            r.bodyBytes.byteOffset + r.bodyBytes.byteLength,
          );
        }
        return new TextEncoder().encode(text).buffer;
      },
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { fn, calls };
}

function mockWebSocketCtor() {
  const instances: Array<{
    url: string;
    sent: string[];
    closed: boolean;
    inst: WebSocketLike;
  }> = [];
  const ctor = function (url: string) {
    const sent: string[] = [];
    const inst: WebSocketLike = {
      readyState: 0,
      send: (data: string) => sent.push(data),
      close: () => {
        rec.closed = true;
        if (inst.onclose) inst.onclose({});
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const rec = { url, sent, closed: false, inst };
    instances.push(rec);
    return inst;
  } as unknown as new (url: string) => WebSocketLike;
  return { ctor, instances };
}

function buildClient(overrides: Partial<{
  fetchFn: typeof globalThis.fetch;
  webSocketCtor: ReturnType<typeof mockWebSocketCtor>["ctor"];
  rateLimiter: RateLimiter;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
  logWarn: (message: string, context: Record<string, unknown>) => void;
}> = {}) {
  const client = new KchatClient({
    fetchFn: overrides.fetchFn,
    webSocketCtor: overrides.webSocketCtor,
    rateLimiter: overrides.rateLimiter,
    sleep: overrides.sleep ?? (async () => {}),
    random: overrides.random ?? (() => 0.5),
    now: overrides.now,
    logWarn: overrides.logWarn,
  });
  return client;
}

describe("KchatClient.setServerUrl", () => {
  it("trims trailing slashes and falls back to the default on empty", () => {
    const c = buildClient();
    c.setServerUrl("https://example.com/");
    expect(c.getServerUrl()).toBe("https://example.com");
    c.setServerUrl("");
    expect(c.getServerUrl()).toBe(DEFAULT_KCHAT_SERVER);
  });
});

describe("KchatClient.verifyConnection", () => {
  it("attaches Bearer token, parses /users/me, transitions to connected", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      ok({
        id: "abc123def456ghi7890jkl",
        username: "ken",
        email: "ken@example.com",
        first_name: "Ken",
        last_name: "Nguyen",
        roles: "system_user",
        last_picture_update: 42,
      }),
    ]);
    const c = buildClient({ fetchFn });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");

    const user = await c.verifyConnection();
    expect(user.id).toBe("abc123def456ghi7890jkl");
    expect(calls[0].url).toBe("https://kchat.example.com/api/v4/users/me");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer PAT-secret");
    expect(c.getState().state).toBe("connected");
    // Sanitised state must NOT carry the token in any field.
    expect(JSON.stringify(c.getState())).not.toContain("PAT-secret");
  });

  it("retries on 503 with backoff and succeeds on the second attempt", async () => {
    const sleepSpy = vi.fn(async () => {});
    const { fn: fetchFn, calls } = makeFetch([
      { status: 503, statusText: "Overloaded", body: { id: "err" } },
      ok({
        id: "abc123def456ghi7890jkl",
        username: "ken",
        email: "k@e.com",
        first_name: "K",
        last_name: "N",
        roles: "system_user",
      }),
    ]);
    const c = buildClient({ fetchFn, sleep: sleepSpy });
    c.setToken("PAT");
    const user = await c.verifyConnection();
    expect(user.username).toBe("ken");
    expect(calls).toHaveLength(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on 401 and surfaces KchatRequestError", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      {
        status: 401,
        statusText: "Unauthorized",
        body: { error: "invalid_token" },
      },
    ]);
    const c = buildClient({ fetchFn });
    c.setToken("BAD");
    await expect(c.verifyConnection()).rejects.toBeInstanceOf(
      KchatRequestError,
    );
    expect(calls).toHaveLength(1);
    expect(c.getState().state).toBe("error");
  });

  it("surfaces a clear error when no token is configured", async () => {
    const { fn: fetchFn } = makeFetch([]);
    const c = buildClient({ fetchFn });
    await expect(c.verifyConnection()).rejects.toThrow(/token is not configured/);
    expect(c.getState().state).toBe("error");
  });
});

describe("KchatClient.listTeams / listChannels / listChannelMembers", () => {
  it("calls /users/{me}/teams and /users/{me}/teams/{id}/channels", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const teamsResp = ok([
      { id: "tid000000000000000000ab", name: "core", display_name: "Core" },
    ]);
    const channelsResp = ok([
      {
        id: "chid0000000000000000abcd",
        team_id: "tid000000000000000000ab",
        name: "design",
        display_name: "Design",
        type: "O",
        total_msg_count: 0,
        create_at: 0,
        update_at: 0,
      },
    ]);
    const membersResp = ok([
      {
        channel_id: "chid0000000000000000abcd",
        user_id: "user1234567890abcdefgh",
        roles: "channel_user",
        last_viewed_at: 0,
        msg_count: 0,
      },
    ]);
    const { fn: fetchFn, calls } = makeFetch([
      userResp,
      teamsResp,
      channelsResp,
      membersResp,
    ]);
    const c = buildClient({ fetchFn });
    c.setToken("T");

    const teams = await c.listTeams();
    expect(teams[0].id).toBe("tid000000000000000000ab");
    const channels = await c.listChannels("tid000000000000000000ab");
    expect(channels[0].name).toBe("design");
    const members = await c.listChannelMembers("chid0000000000000000abcd");
    expect(members[0].user_id).toBe("user1234567890abcdefgh");
    // verifyConnection was implicit on listTeams (no prior verify).
    expect(calls[0].url).toMatch(/\/api\/v4\/users\/me$/);
    expect(calls[1].url).toMatch(
      /\/api\/v4\/users\/user1234567890abcdefgh\/teams$/,
    );
    expect(calls[2].url).toMatch(
      /\/api\/v4\/users\/user1234567890abcdefgh\/teams\/tid000000000000000000ab\/channels$/,
    );
  });
});

describe("KchatClient.uploadFile + downloadFile", () => {
  it("uploads multipart and parses the file_info response", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: unknown, init: unknown) => {
      captured = { url: String(url), init: init as RequestInit };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({
          file_infos: [
            {
              id: "fid000000000000000000abcd",
              user_id: "uid",
              channel_id: "chid",
              name: "x.md",
              size: 4,
              mime_type: "text/markdown",
              extension: "md",
              create_at: 0,
              update_at: 0,
            },
          ],
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    }) as typeof globalThis.fetch;

    const c = buildClient({ fetchFn });
    c.setToken("T");
    const info = await c.uploadFile(
      "chid0000000000000000abcd",
      "report.md",
      Buffer.from("hi"),
      "text/markdown",
    );
    expect(info.id).toBe("fid000000000000000000abcd");
    expect(captured).not.toBeNull();
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(headers.Authorization).toBe("Bearer T");
  });

  it("downloads file bytes via arrayBuffer", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { fn: fetchFn } = makeFetch([{ status: 200, bodyBytes: bytes }]);
    const c = buildClient({ fetchFn });
    c.setToken("T");
    const out = await c.downloadFile("fid000000000000000000abcd");
    expect(out).toEqual(bytes);
  });

  // Defense-in-depth: even though the production call sites validate
  // channelId, filename, and contentType upstream, the upload method
  // itself must reject CR/LF in any of those values so a future
  // caller that bypasses upstream validation cannot inject a forged
  // multipart part.
  it("rejects CR/LF injection in filename", async () => {
    const c = buildClient();
    c.setToken("T");
    await expect(
      c.uploadFile(
        "chid0000000000000000abcd",
        'evil.md"\r\nContent-Disposition: form-data; name="injected',
        Buffer.from("x"),
      ),
    ).rejects.toThrow(/filename must not contain quotes|CR or LF/);
  });

  it("rejects CR/LF injection in contentType", async () => {
    const c = buildClient();
    c.setToken("T");
    await expect(
      c.uploadFile(
        "chid0000000000000000abcd",
        "x.md",
        Buffer.from("x"),
        "text/plain\r\nX-Injected: yes",
      ),
    ).rejects.toThrow(/CR or LF/);
  });

  it("rejects CR/LF injection in channelId", async () => {
    const c = buildClient();
    c.setToken("T");
    await expect(
      c.uploadFile(
        "chid\r\n--evil",
        "x.md",
        Buffer.from("x"),
      ),
    ).rejects.toThrow(/CR or LF/);
  });
});

describe("KchatClient.uploadFile retry semantics (seventh-pass invariant)", () => {
  // `POST /api/v4/files` is non-idempotent: the KChat server may
  // persist the file and crash before sending us the response, in
  // which case a retry would produce a duplicate file in the
  // channel. The seventh-pass fix (Devin Review ANALYSIS_0005)
  // constrains uploadFile's retry-set to 408/429 only — transport-
  // layer codes where the server is documented to NOT have processed
  // the request. 5xx responses must surface to the caller on the
  // first attempt rather than being retried into a duplicate.
  //
  // These tests pin that contract by counting the number of fetches
  // the client issues per status code.

  function freshLimiter() {
    return new RateLimiter();
  }

  it("does NOT retry uploadFile on 503 (5xx is server-may-have-processed)", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      { status: 503, statusText: "Overloaded", body: { error: "x" } },
    ]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("T");
    await expect(
      c.uploadFile(
        "chid0000000000000000abcd",
        "report.md",
        Buffer.from("hi"),
        "text/markdown",
      ),
    ).rejects.toThrow(/KChat 503|Overloaded/);
    // Single attempt: the 503 surfaces immediately rather than
    // being retried into a possible duplicate upload.
    expect(calls.length).toBe(1);
  });

  it("does NOT retry uploadFile on 500 / 502 / 504 (every 5xx is non-retryable for POST /files)", async () => {
    for (const status of [500, 502, 504]) {
      const { fn: fetchFn, calls } = makeFetch([
        { status, statusText: "Server error", body: { error: "x" } },
      ]);
      const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
      c.setToken("T");
      await expect(
        c.uploadFile(
          "chid0000000000000000abcd",
          "report.md",
          Buffer.from("hi"),
          "text/markdown",
        ),
      ).rejects.toThrow(new RegExp(`KChat ${status}|Server error`));
      expect(calls.length).toBe(1);
    }
  });

  it("DOES retry uploadFile on 429 (rate-limit — server did not process)", async () => {
    const sleepSpy = vi.fn(async () => {});
    const { fn: fetchFn, calls } = makeFetch([
      { status: 429, statusText: "Too Many Requests", body: { error: "rl" } },
      {
        status: 200,
        statusText: "OK",
        body: {
          file_infos: [
            {
              id: "fid000000000000000000abcd",
              user_id: "uid",
              channel_id: "chid",
              name: "report.md",
              size: 2,
              mime_type: "text/markdown",
              extension: "md",
              create_at: 0,
              update_at: 0,
            },
          ],
        },
      },
    ]);
    const c = buildClient({
      fetchFn,
      sleep: sleepSpy,
      rateLimiter: freshLimiter(),
    });
    c.setToken("T");
    const info = await c.uploadFile(
      "chid0000000000000000abcd",
      "report.md",
      Buffer.from("hi"),
      "text/markdown",
    );
    expect(info.id).toBe("fid000000000000000000abcd");
    // 2 attempts: 429 then 200. 429 is in the
    // NON_IDEMPOTENT_RETRYABLE_STATUSES set because the server is
    // documented to NOT have processed the request.
    expect(calls.length).toBe(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  it("DOES retry uploadFile on 408 (request timeout — server did not process)", async () => {
    const sleepSpy = vi.fn(async () => {});
    const { fn: fetchFn, calls } = makeFetch([
      { status: 408, statusText: "Request Timeout", body: { error: "to" } },
      {
        status: 200,
        statusText: "OK",
        body: {
          file_infos: [
            {
              id: "fid000000000000000000abcd",
              user_id: "uid",
              channel_id: "chid",
              name: "report.md",
              size: 2,
              mime_type: "text/markdown",
              extension: "md",
              create_at: 0,
              update_at: 0,
            },
          ],
        },
      },
    ]);
    const c = buildClient({
      fetchFn,
      sleep: sleepSpy,
      rateLimiter: freshLimiter(),
    });
    c.setToken("T");
    const info = await c.uploadFile(
      "chid0000000000000000abcd",
      "report.md",
      Buffer.from("hi"),
      "text/markdown",
    );
    expect(info.id).toBe("fid000000000000000000abcd");
    expect(calls.length).toBe(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  it("idempotent GET listChannelFiles still retries on 503 (default retry-set unchanged)", async () => {
    // Belt-and-braces: the seventh-pass change must NOT regress
    // retry behaviour for idempotent verbs. listChannelFiles is a
    // GET; a 503 there is safe to retry because GETs cannot
    // produce duplicate side-effects.
    const sleepSpy = vi.fn(async () => {});
    const { fn: fetchFn, calls } = makeFetch([
      { status: 503, statusText: "Overloaded", body: { error: "x" } },
      { status: 200, statusText: "OK", body: [] },
    ]);
    const c = buildClient({
      fetchFn,
      sleep: sleepSpy,
      rateLimiter: freshLimiter(),
    });
    c.setToken("T");
    const files = await c.listChannelFiles(
      "chid0000000000000000abcd",
      0,
      60,
    );
    expect(files).toEqual([]);
    expect(calls.length).toBe(2);
  });
});

describe("KchatClient.setToken null invariant", () => {
  // setToken(null) must tear down the WebSocket so the reconnect
  // loop cannot fire `connectWebSocket()` with no token and produce
  // an infinite "KChat token is not configured" loop.
  it("clears the active WebSocket and cancels reconnect when token becomes null", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("T");
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    expect(instances[0].closed).toBe(false);
    c.setToken(null);
    expect(instances[0].closed).toBe(true);
  });

  // Replacing the token with a different non-null value must also
  // tear down the WS — the identity of the underlying user/session
  // has changed, so the existing WebSocket is no longer
  // authoritative. Leaving it open would let events bound to the
  // previous user keep streaming into the renderer.
  it("tears down the active WebSocket when the token is rotated", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-original");
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    expect(instances[0].closed).toBe(false);
    c.setToken("PAT-rotated");
    expect(instances[0].closed).toBe(true);
  });

  // Same-value setToken calls must be no-ops on the WebSocket;
  // otherwise a re-render that re-applies the cached token would
  // bounce the WS unnecessarily.
  it("is a no-op on the WebSocket when the token is unchanged", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-stable");
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    c.setToken("PAT-stable");
    expect(instances[0].closed).toBe(false);
  });
});

describe("KchatClient.setServerUrl invariant", () => {
  // A KChat instance switch (self-hosted → kchat.com or vice
  // versa) must tear down any existing WebSocket pointing at the
  // old server. Otherwise the renderer would receive events from
  // the previous instance while REST calls have already moved to
  // the new one.
  it("tears down the active WebSocket when the server URL changes", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setServerUrl("https://old.kchat.example.com");
    c.setToken("PAT");
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    expect(instances[0].closed).toBe(false);
    c.setServerUrl("https://new.kchat.example.com");
    expect(instances[0].closed).toBe(true);
  });

  // Same-value setServerUrl calls must NOT bounce the WebSocket.
  it("is a no-op on the WebSocket when the URL is unchanged (after slash trim)", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT");
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    // Same canonical URL after trailing-slash normalisation.
    c.setServerUrl("https://kchat.example.com/");
    expect(instances[0].closed).toBe(false);
  });
});

describe("KchatClient.downloadFile server-id validation", () => {
  // downloadFile() interpolates `fileId` into the request URL.
  // The fileId may have come from a `listChannelFiles()` response
  // (server-supplied) — the trust-boundary check inside
  // downloadFile must reject anything that doesn't match the KChat
  // object-id shape, regardless of how it got there.
  it("rejects fileId values containing path-control bytes", async () => {
    const c = buildClient();
    c.setToken("T");
    await expect(c.downloadFile("../etc/passwd")).rejects.toThrow(
      /not a valid KChat object id/,
    );
  });

  it("rejects fileId values that are too short", async () => {
    const c = buildClient();
    c.setToken("T");
    await expect(c.downloadFile("short")).rejects.toThrow(
      /not a valid KChat object id/,
    );
  });

  it("rejects fileId values containing uppercase characters", async () => {
    const c = buildClient();
    c.setToken("T");
    await expect(
      c.downloadFile("FID000000000000000000ABCD"),
    ).rejects.toThrow(/not a valid KChat object id/);
  });

  it("rejects fileId values containing URL-control characters", async () => {
    const c = buildClient();
    c.setToken("T");
    await expect(
      c.downloadFile("fid000000000000?query=1"),
    ).rejects.toThrow(/not a valid KChat object id/);
  });
});

describe("KchatClient.scrubMessage", () => {
  it("replaces the active PAT with [REDACTED]", () => {
    const c = buildClient();
    c.setToken("PAT-supersecret-token");
    const scrubbed = c.scrubMessage(
      "request failed: Authorization: Bearer PAT-supersecret-token; reason=401",
    );
    expect(scrubbed).not.toContain("PAT-supersecret-token");
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("replaces Bearer patterns even when no active token is set", () => {
    const c = buildClient();
    const scrubbed = c.scrubMessage(
      "logged header: Bearer abcdef0123456789",
    );
    expect(scrubbed).toContain("Bearer [REDACTED]");
    expect(scrubbed).not.toContain("abcdef0123456789");
  });

  it("returns the message unchanged when it contains no token bytes", () => {
    const c = buildClient();
    c.setToken("PAT-T");
    expect(c.scrubMessage("KChat 502 Bad Gateway: /api/v4/users/me")).toBe(
      "KChat 502 Bad Gateway: /api/v4/users/me",
    );
  });

  it("does not redact short tokens that would alias on words", () => {
    const c = buildClient();
    // Length guard in scrubMessage: tokens shorter than 8 chars are
    // not redacted because they would alias on common English text.
    c.setToken("short");
    expect(c.scrubMessage("the short story")).toBe("the short story");
  });

  it("escapes regex metacharacters in the active token", () => {
    const c = buildClient();
    // PATs in some KChat deployments include `.` and `+` — the
    // escape pass must treat them as literals so the redaction is
    // accurate and doesn't accidentally consume more bytes.
    c.setToken("a.b+c/d=e1234");
    const out = c.scrubMessage(
      "failed for token=a.b+c/d=e1234 and aXbYcZdQe1234",
    );
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("aXbYcZdQe1234");
    expect(out).not.toContain("a.b+c/d=e1234");
  });
});

describe("KchatClient.connectionState error-field scrubbing (sixth-pass invariant)", () => {
  // Sixth-pass Devin Review (ANALYSIS_0004) flagged that the
  // `kchat:status` IPC handler returned `svc.getState()` without
  // running it through `scrubMessage`, so a state.error containing
  // a token would cross the renderer boundary unscrubbed. The fix
  // moved the scrub into `transition()` so the invariant
  // "`connectionState.error` never contains the PAT" holds for
  // every reader regardless of which IPC handler surfaces it.
  // These tests pin the invariant at the write site, where it
  // matters: any future reader (kchat:status, log dumps, state
  // listeners) inherits the redaction automatically.
  it("scrubs the active PAT from state.error when verifyConnection fails on 401", async () => {
    const tokenLiteral = "PAT-supersecret-token-bytes-1234567890";
    // The mock server echoes the token-bearing string verbatim
    // back into the response body. KchatRequestError builds its
    // message from `body.error` (truncated to 256 chars), so the
    // un-scrubbed path would land the PAT in
    // `connectionState.error` via verifyConnection's catch.
    const { fn: fetchFn } = makeFetch([
      {
        status: 401,
        statusText: "Unauthorized",
        body: {
          error: `request token ${tokenLiteral} rejected`,
        },
      },
    ]);
    const c = buildClient({ fetchFn });
    c.setToken(tokenLiteral);
    await expect(c.verifyConnection()).rejects.toBeInstanceOf(
      KchatRequestError,
    );
    const state = c.getState();
    expect(state.state).toBe("error");
    expect(typeof state.error).toBe("string");
    expect(state.error).not.toContain(tokenLiteral);
    expect(state.error).toContain("[REDACTED]");
  });

  it("scrubs the PAT from state.error pushed to status listeners", async () => {
    const tokenLiteral = "PAT-listener-secret-9876543210abcdef";
    const { fn: fetchFn } = makeFetch([
      {
        status: 500,
        statusText: "Internal Server Error",
        body: {
          error: `dumped Authorization header: Bearer ${tokenLiteral}`,
        },
      },
    ]);
    const c = buildClient({ fetchFn });
    c.setToken(tokenLiteral);
    const observed: string[] = [];
    c.onStatusChange((s) => {
      if (typeof s.error === "string") observed.push(s.error);
    });
    await expect(c.verifyConnection()).rejects.toBeInstanceOf(
      KchatRequestError,
    );
    // Status listeners receive the scrubbed copy too — they cannot
    // observe a transient pre-scrub state because scrubbing
    // happens before the listener fan-out in `transition()`.
    expect(observed.length).toBeGreaterThan(0);
    for (const m of observed) {
      expect(m).not.toContain(tokenLiteral);
    }
    // Generic Bearer regex catches the header-shape leakage too.
    for (const m of observed) {
      expect(m).not.toMatch(/Bearer\s+PAT-/);
    }
  });

  it("leaves error untouched when it does not contain token bytes", async () => {
    const { fn: fetchFn } = makeFetch([
      {
        status: 502,
        statusText: "Bad Gateway",
        body: { error: "upstream timeout" },
      },
    ]);
    const c = buildClient({ fetchFn });
    c.setToken("PAT-some-unrelated-token-here");
    await expect(c.verifyConnection()).rejects.toBeInstanceOf(
      KchatRequestError,
    );
    const state = c.getState();
    expect(state.state).toBe("error");
    // Non-token messages pass through unmodified — verifies the
    // scrub is targeted (no false positives that would mask
    // legitimate operator-visible error text).
    expect(state.error).toContain("502");
    expect(state.error).toContain("Bad Gateway");
  });
});

describe("KchatClient server-id validation at deserialisation boundary", () => {
  // The KChat server is trusted for authentication but its
  // response bodies are NOT trusted for ids that will be
  // interpolated into URL paths. Every list* method validates
  // server-supplied ids at deserialisation so a compromised
  // server cannot inject `../`, `?`, `#`, etc. into a downstream
  // request — even if the next caller forgets to revalidate.
  //
  // Each test uses a private `RateLimiter` so the shared default
  // bucket is not exhausted across the file.

  function freshLimiter() {
    return new RateLimiter();
  }

  it("verifyConnection rejects /users/me responses with malformed user.id", async () => {
    const { fn: fetchFn } = makeFetch([
      ok({
        id: "../etc/passwd",
        username: "ken",
        email: "k@e.com",
        first_name: "K",
        last_name: "N",
        roles: "system_user",
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("PAT");
    await expect(c.verifyConnection()).rejects.toThrow(
      /not a valid KChat object id/,
    );
    // And the state must transition to error so the renderer can
    // surface the failure (otherwise a malformed response would
    // look like a network error in the UI).
    expect(c.getState().state).toBe("error");
  });

  it("listTeams rejects teams with malformed ids", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const teamsResp = ok([
      // First team is well-formed, second injects `..` in the id.
      { id: "tid000000000000000000ab", name: "core", display_name: "Core" },
      { id: "tid00..0000000000000000", name: "evil", display_name: "Evil" },
    ]);
    const { fn: fetchFn } = makeFetch([userResp, teamsResp]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("PAT");
    await expect(c.listTeams()).rejects.toThrow(/not a valid KChat object id/);
  });

  it("listChannels rejects channels with malformed id or team_id", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const channelsResp = ok([
      {
        id: "chid?inject=1",
        team_id: "tid000000000000000000ab",
        name: "design",
        display_name: "Design",
        type: "O",
        total_msg_count: 0,
        create_at: 0,
        update_at: 0,
      },
    ]);
    const { fn: fetchFn } = makeFetch([userResp, channelsResp]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("PAT");
    await expect(
      c.listChannels("tid000000000000000000ab"),
    ).rejects.toThrow(/not a valid KChat object id/);
  });

  it("listChannelMembers rejects members with malformed user_id", async () => {
    const membersResp = ok([
      {
        channel_id: "chid0000000000000000abcd",
        user_id: "user../evil",
        roles: "channel_user",
        last_viewed_at: 0,
        msg_count: 0,
      },
    ]);
    const { fn: fetchFn } = makeFetch([membersResp]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("PAT");
    await expect(
      c.listChannelMembers("chid0000000000000000abcd"),
    ).rejects.toThrow(/not a valid KChat object id/);
  });

  it("listChannelFiles rejects files with malformed ids before they reach the indexer", async () => {
    const filesResp = ok([
      {
        id: "fid?injection",
        user_id: "u",
        channel_id: "c",
        name: "report.pdf",
        size: 1,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 0,
        update_at: 0,
      },
    ]);
    const { fn: fetchFn } = makeFetch([filesResp]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("PAT");
    await expect(
      c.listChannelFiles("chid0000000000000000abcd", 0, 60),
    ).rejects.toThrow(/not a valid KChat object id/);
  });

  // -------------------------------------------------------------
  // Phase 13 Theme 2 Task 11: `listChannelFiles` now also
  // validates `fi.user_id` at the deserialisation boundary
  // because the renderer-facing file preview surfaces the
  // uploader (post-sanitisation) and feeds the id through the
  // shared `getUsersByIds` enrichment path. A substrate that
  // returns a well-formed file id but a malformed user id must
  // be rejected — otherwise the username cache could be poisoned
  // with a key like `../etc/passwd` and `getUsersByIds(["../"])`
  // would throw a generic shape error mid-batch, suppressing the
  // valid rows' enrichment.
  // -------------------------------------------------------------
  it("listChannelFiles rejects files with a malformed user_id (Phase 13 Theme 2 Task 11)", async () => {
    const filesResp = ok([
      {
        // Valid file id (26-char lowercase alphanumeric).
        id: "f".repeat(26),
        // Malformed user id — short + containing a separator.
        user_id: "u/evil",
        channel_id: "c".repeat(26),
        name: "report.pdf",
        size: 1,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 0,
        update_at: 0,
      },
    ]);
    const { fn: fetchFn } = makeFetch([filesResp]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("PAT");
    await expect(
      c.listChannelFiles("chid0000000000000000abcd", 0, 60),
    ).rejects.toThrow(/fileInfo\.user_id.*not a valid KChat object id/);
  });

  it("getFileInfo rejects a malformed user_id (Phase 13 Theme 2 Task 11)", async () => {
    const fileResp = ok({
      // Valid file id (the validator the request URL went
      // through enforces this at the caller boundary too).
      id: "f".repeat(26),
      // Malformed user id at the deserialisation boundary.
      user_id: "u",
      channel_id: "c".repeat(26),
      name: "report.pdf",
      size: 1,
      mime_type: "application/pdf",
      extension: "pdf",
      create_at: 0,
      update_at: 0,
    });
    const { fn: fetchFn } = makeFetch([fileResp]);
    const c = buildClient({ fetchFn, rateLimiter: freshLimiter() });
    c.setToken("PAT");
    await expect(c.getFileInfo("f".repeat(26))).rejects.toThrow(
      /fileInfo\.user_id.*not a valid KChat object id/,
    );
  });
});

describe("KchatClient health check teardown invariants", () => {
  // Helper that exposes the private timer via the public start/stop
  // surface — we count timer activity via vi.useFakeTimers and the
  // number of fetches the health-check loop triggers.

  // Pre-condition for every assertion in this suite: a successful
  // verifyConnection() followed by startHealthCheck() leaves a
  // timer running. Subsequent state transitions on the token /
  // server URL are expected to stop that timer.

  it("setToken(null) stops the health-check timer (fixes the re-connect-after-error spurious-tick loop)", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    // Initial verify succeeds; subsequent health-check ticks would
    // fail loudly if the timer kept running because the second
    // response is a 503.
    const { fn: fetchFn, calls } = makeFetch([
      userResp,
      { status: 503, statusText: "Server down", body: { error: "x" } },
    ]);
    vi.useFakeTimers();
    try {
      const c = buildClient({
        fetchFn,
        sleep: async () => {},
        rateLimiter: new RateLimiter(),
      });
      c.setToken("PAT");
      await c.verifyConnection();
      c.startHealthCheck();
      const callsBefore = calls.length;
      // Tear down via setToken(null) — this is the failing-reconnect
      // catch path.
      c.setToken(null);
      // Advance well past the health-check interval. If the timer
      // is still running it would fire and try to re-verify.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setToken rotation (A → B) stops the health-check timer so the new caller can re-arm it", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const { fn: fetchFn, calls } = makeFetch([userResp, userResp]);
    vi.useFakeTimers();
    try {
      const c = buildClient({
        fetchFn,
        sleep: async () => {},
        rateLimiter: new RateLimiter(),
      });
      c.setToken("PAT-A");
      await c.verifyConnection();
      c.startHealthCheck();
      const callsBefore = calls.length;
      c.setToken("PAT-B");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("setToken same-value is a no-op on the health-check timer", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    // Three responses: initial verify, two health-check ticks.
    const { fn: fetchFn, calls } = makeFetch([userResp, userResp, userResp]);
    vi.useFakeTimers();
    try {
      const c = buildClient({
        fetchFn,
        sleep: async () => {},
        rateLimiter: new RateLimiter(),
      });
      c.setToken("PAT-stable");
      await c.verifyConnection();
      c.startHealthCheck();
      const callsBefore = calls.length;
      c.setToken("PAT-stable");
      // Same-value: the timer must still be running, so advancing
      // the clock should trigger health-check ticks (verifyConnection
      // re-fetches /users/me each tick).
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls.length).toBeGreaterThan(callsBefore);
      c.stopHealthCheck();
    } finally {
      vi.useRealTimers();
    }
  });

  it("setServerUrl change stops the health-check timer (prevents racing the new server's setup)", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const { fn: fetchFn, calls } = makeFetch([userResp]);
    vi.useFakeTimers();
    try {
      const c = buildClient({
        fetchFn,
        sleep: async () => {},
        rateLimiter: new RateLimiter(),
      });
      c.setServerUrl("https://old.kchat.example.com");
      c.setToken("PAT");
      await c.verifyConnection();
      c.startHealthCheck();
      const callsBefore = calls.length;
      c.setServerUrl("https://new.kchat.example.com");
      await vi.advanceTimersByTimeAsync(120_000);
      expect(calls.length).toBe(callsBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("KchatClient.connectWebSocket", () => {
  it("opens ws URL, sends the auth challenge with the token, and dispatches events", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    const events: unknown[] = [];
    c.onWebSocketEvent((e) => events.push(e));
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(
      "wss://kchat.example.com/api/v4/websocket",
    );
    // Simulate the WS hand-shake.
    instances[0].inst.onopen?.({});
    expect(instances[0].sent[0]).toContain("PAT-secret");
    // Push a `posted` event and verify dispatch.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        data: { channel_name: "design" },
        broadcast: { channel_id: "chid" },
        seq: 1,
      }),
    });
    expect(events).toHaveLength(1);
    expect((events[0] as { event: string }).event).toBe("posted");
  });

  it("drops malformed WS frames that lack a broadcast or data object", async () => {
    // Regression for fifth-pass Devin Review on PR #43 (the
    // `broadcast` guard — `ANALYSIS_pr-review-job-...0001`) plus
    // the sixth-pass extension to the symmetric `data` guard
    // (`BUG_pr-review-job-...0001`). KChat's protocol always
    // includes both a `broadcast` object AND a `data` object on
    // every event, but the WS peer is treated as fully untrusted
    // — a malformed payload missing either (or with either as
    // `null` or an array) must not reach the listener set,
    // because every downstream consumer destructures
    // `parsed.broadcast.*` / `parsed.data.*` directly and would
    // otherwise throw. The renderer's `event.data.create_at` access
    // in `KchatSidebarSection` is the critical case — it would
    // TypeError in the renderer event loop with no try/catch above
    // it, surfacing as an unhandled exception in the UI.
    //
    // The trust boundary is `handleWsMessage`. We feed it six
    // malformed frames plus one well-formed control, and assert
    // only the control reaches the listener. We also assert the
    // eighth-pass drop-warn observability path
    // (`ANALYSIS_pr-review-job-...0005`) — every drop must emit
    // one structured warning per `(eventName, reason)` tuple
    // within the cooldown window, so operators can correlate
    // missing-event reports with trust-boundary drops in
    // production (the original silent-`return` left this
    // invisible).
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    // Pin the clock so the cooldown logic is deterministic. Each
    // call to `now()` returns the next pinned timestamp; the test
    // bumps `clock` by 1 ms per drop so every (eventName, reason)
    // tuple is well inside the 60 s cooldown window — successive
    // drops for the SAME tuple are suppressed, drops for distinct
    // tuples each emit one warning.
    let clock = 1_700_000_000_000;
    const c = buildClient({
      webSocketCtor: ctor,
      logWarn,
      now: () => {
        const t = clock;
        clock += 1;
        return t;
      },
    });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    const events: unknown[] = [];
    c.onWebSocketEvent((e) => events.push(e));
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});

    // 1. Missing `broadcast` entirely.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({ event: "posted", data: {}, seq: 1 }),
    });
    // 2. `broadcast: null`.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        data: {},
        broadcast: null,
        seq: 2,
      }),
    });
    // 3. `broadcast` is an array (typeof === "object" but
    //    structurally wrong — the early Array.isArray guard must
    //    reject this).
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        data: {},
        broadcast: [],
        seq: 3,
      }),
    });
    // 4. Missing `data` entirely. The renderer's
    //    `event.data.create_at` access in `KchatSidebarSection`
    //    would TypeError without this guard.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        broadcast: { channel_id: "chid" },
        seq: 4,
      }),
    });
    // 5. `data: null`.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        broadcast: { channel_id: "chid" },
        data: null,
        seq: 5,
      }),
    });
    // 6. `data` is an array.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        broadcast: { channel_id: "chid" },
        data: [],
        seq: 6,
      }),
    });
    // 7. Well-formed control.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        data: { channel_name: "design" },
        broadcast: { channel_id: "chid" },
        seq: 7,
      }),
    });

    expect(events).toHaveLength(1);
    expect((events[0] as { seq: number }).seq).toBe(7);

    // Six malformed frames, all under "posted" event name, split
    // across two reasons:
    //   - `malformed-broadcast`: frames 1, 2, 3
    //   - `malformed-data`: frames 4, 5, 6
    // Two distinct (eventName, reason) tuples → exactly two
    // warnings (the cooldown suppresses the 2nd and 3rd drop in
    // each tuple). The first call to each tuple emits the warning
    // because the cooldown map is empty at process start.
    expect(logWarn).toHaveBeenCalledTimes(2);
    const calls = logWarn.mock.calls;
    const reasons = calls.map((c) => (c[1] as { reason: string }).reason);
    expect(reasons).toContain("malformed-broadcast");
    expect(reasons).toContain("malformed-data");
    for (const [msg, ctx] of calls) {
      expect(msg).toBe(
        "[KchatClient] dropped malformed WS frame at trust boundary",
      );
      const c = ctx as { event: string; reason: string; cooldownMs: number };
      expect(c.event).toBe("posted");
      expect(c.cooldownMs).toBe(60_000);
    }
  });

  it("rate-limits drop warnings per (eventName, reason) tuple", async () => {
    // Eighth-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0005`) flagged that the silent
    // drop with no logging would hide protocol-evolution gaps
    // from operators. The fix adds drop-warn logging, but a
    // naive `console.warn` on every drop would let a malicious
    // or buggy peer flood the main-process console with 1000
    // warnings/s. The cooldown logic is the architectural
    // backpressure for that.
    //
    // This test pins the clock and:
    //   - Feeds 5 malformed frames at the SAME (eventName,
    //     reason) tuple, within the 60 s cooldown window →
    //     exactly ONE warning fires.
    //   - Advances the clock past the cooldown → the NEXT
    //     malformed frame for the same tuple fires a SECOND
    //     warning (the cooldown is per-tuple, not global, and
    //     re-arms after `WS_DROP_WARN_COOLDOWN_MS`).
    //   - Feeds a DIFFERENT (eventName, reason) tuple inside
    //     the first cooldown window → that distinct tuple is
    //     not suppressed; it fires its own warning.
    // Net: 3 warnings total across 7 dropped frames.
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    let clock = 0;
    const c = buildClient({
      webSocketCtor: ctor,
      logWarn,
      now: () => clock,
    });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    c.onWebSocketEvent(() => {
      /* test only inspects logWarn */
    });
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});

    // Five identical malformed frames within the cooldown window
    // → one warning.
    for (let i = 0; i < 5; i++) {
      clock = 1_000 + i; // all within the 60 s cooldown
      instances[0].inst.onmessage?.({
        data: JSON.stringify({ event: "posted", data: {}, seq: i }),
      });
    }
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[1]).toMatchObject({
      event: "posted",
      reason: "malformed-broadcast",
    });

    // A different (eventName, reason) tuple inside the same
    // cooldown window → distinct tuple, distinct warning.
    clock = 1_500;
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "typing",
        broadcast: { channel_id: "c1" },
        data: null,
        seq: 10,
      }),
    });
    expect(logWarn).toHaveBeenCalledTimes(2);
    expect(logWarn.mock.calls[1]?.[1]).toMatchObject({
      event: "typing",
      reason: "malformed-data",
    });

    // Advance the clock past the cooldown for the first tuple,
    // then repeat the original malformed shape → cooldown has
    // re-armed, so a second warning fires.
    clock = 60_000 + 1_001; // > cooldown after the first warning
    instances[0].inst.onmessage?.({
      data: JSON.stringify({ event: "posted", data: {}, seq: 100 }),
    });
    expect(logWarn).toHaveBeenCalledTimes(3);
    expect(logWarn.mock.calls[2]?.[1]).toMatchObject({
      event: "posted",
      reason: "malformed-broadcast",
    });
  });

  it("warns at the trust boundary when the WS frame omits the event field", async () => {
    // Frames with no string `event` field hit the earliest guard
    // in `handleWsMessage`. The eighth-pass drop-warn extension
    // (`ANALYSIS_pr-review-job-...0005`) also covers this drop
    // site — operators need to see "the peer is sending frames
    // with no event name" diagnostics, not just the `broadcast` /
    // `data` malformations covered above.
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    const c = buildClient({ webSocketCtor: ctor, logWarn });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});
    instances[0].inst.onmessage?.({
      data: JSON.stringify({ seq: 1, data: {}, broadcast: {} }),
    });
    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn.mock.calls[0]?.[1]).toMatchObject({
      event: "<no-event>",
      reason: "missing-event",
    });
  });

  it("warns at the trust boundary when seq is not a number", async () => {
    // Eleventh-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0005`) flagged that the trust
    // boundary validated `event` / `broadcast` / `data` but did NOT
    // validate `seq`, even though `KchatWebSocketEvent.seq` is
    // declared `number`. A malicious server sending a string-typed
    // `seq` would flow through the guards and reach downstream
    // consumers as a typed `number` that's actually a string —
    // breaking any arithmetic (e.g. future gap-detection logic
    // mentioned in the type docs) the renderer eventually runs.
    //
    // Fix asserts the seq field at the same trust boundary as the
    // other typed fields. This test feeds string + missing + bool
    // + null `seq` shapes; all must drop with `malformed-seq`. A
    // well-formed control afterward must still reach the listener.
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    let clock = 0;
    const c = buildClient({
      webSocketCtor: ctor,
      logWarn,
      now: () => clock,
    });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    const events: unknown[] = [];
    c.onWebSocketEvent((e) => events.push(e));
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});

    const badSeqShapes = [
      { event: "posted", data: {}, broadcast: {}, seq: "not-a-number" },
      { event: "posted", data: {}, broadcast: {} },
      { event: "posted", data: {}, broadcast: {}, seq: true },
      { event: "posted", data: {}, broadcast: {}, seq: null },
    ];
    for (let i = 0; i < badSeqShapes.length; i++) {
      // Advance the clock past the per-tuple cooldown so each
      // shape's warning fires (the (event="posted", reason="malformed-seq")
      // tuple is the same for all four; without clock advance only
      // the first would warn).
      // 60_000 is `WS_DROP_WARN_COOLDOWN_MS` in `kchatClient.ts`;
      // not imported here to keep this test file's surface narrow.
      clock += 60_001;
      instances[0].inst.onmessage?.({ data: JSON.stringify(badSeqShapes[i]) });
    }
    expect(logWarn).toHaveBeenCalledTimes(4);
    for (const call of logWarn.mock.calls) {
      expect(call[1]).toMatchObject({
        event: "posted",
        reason: "malformed-seq",
      });
    }
    // Control: well-formed event still reaches the listener.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        data: {},
        broadcast: {},
        seq: 7,
      }),
    });
    expect(events).toHaveLength(1);
    expect((events[0] as { seq: number }).seq).toBe(7);
  });

  it("silently drops Mattermost control responses (seq_reply) without warning", async () => {
    // Tenth-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0001`) flagged that the
    // Mattermost / KChat WebSocket protocol carries client-request
    // RESPONSES on the same wire as server-pushed EVENTS. Responses
    // are framed with `seq_reply` + `status` (NO `event` field) and
    // are sent in reply to the `authentication_challenge` we issue
    // on every `onopen`. The eighth-pass drop-warn path classified
    // these as `missing-event` and emitted a warning per reconnect,
    // which is operationally misleading noise on a healthy
    // connection.
    //
    // This test feeds the canonical OK + FAIL auth-challenge
    // response shapes (and a synthetic `seq_reply: 99` to prove the
    // discriminator works on any sequence number) and asserts:
    //   1. No warning fires.
    //   2. The forwarder remains alive and continues delivering
    //      legitimate server-pushed events afterward.
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    const c = buildClient({ webSocketCtor: ctor, logWarn });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    const events: unknown[] = [];
    c.onWebSocketEvent((e) => events.push(e));
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});

    // Mattermost OK response to authentication_challenge.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({ status: "OK", seq_reply: 0 }),
    });
    // Mattermost FAIL response shape.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        status: "FAIL",
        seq_reply: 1,
        error: { id: "api.invalid_token", message: "Invalid token" },
      }),
    });
    // Synthetic response on a different seq.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({ seq_reply: 99, status: "OK" }),
    });
    expect(logWarn).not.toHaveBeenCalled();

    // Well-formed event reaches the listener — proving the WS
    // reader loop is still alive after the control-frame sequence.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        data: { channel_name: "design" },
        broadcast: { channel_id: "chid" },
        seq: 1,
      }),
    });
    expect(events).toHaveLength(1);
  });

  it("does not crash on JSON literals that parse to non-object values", async () => {
    // Ninth-pass Devin Review on PR #43
    // (`BUG_pr-review-job-...0001`) flagged that `JSON.parse("null")`
    // returns the JS value `null`, and the subsequent
    // `parsed.event` access would throw
    // `TypeError: Cannot read properties of null (reading 'event')`.
    // The error would propagate unhandled out of `ws.onmessage`,
    // taking the WS reader loop down on a malicious or buggy peer
    // that sends any of the JSON literals that don't parse to a
    // non-null object: `"null"`, `"42"`, `"true"`, `"\"x\""`, `"[]"`.
    //
    // The fix is a PARSE-TYPE guard at the top of `handleWsMessage`,
    // ahead of the existing STRUCTURAL guards for `broadcast` and
    // `data`. This test feeds every literal that the JSON grammar
    // accepts but the protocol contract rejects, plus one
    // well-formed control. The forwarder must remain alive (the
    // control reaches the listener) and every non-object literal
    // must drop with a `missing-event` warning. The test also
    // asserts that the synchronous handler does not throw — the
    // `ws.onmessage` adapter has no try/catch, so an uncaught
    // throw would surface as a test failure here.
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    const c = buildClient({ webSocketCtor: ctor, logWarn });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    const events: unknown[] = [];
    c.onWebSocketEvent((e) => events.push(e));
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});

    // Each of these is a *valid* JSON document on the wire, but
    // none of them parse to an object — `parsed.event` would
    // throw on `null` and silently return `undefined` on the rest.
    // The PARSE-TYPE guard at the trust boundary drops all of them.
    const nonObjectFrames = ["null", "42", "true", "false", '"x"', "[]"];
    for (const raw of nonObjectFrames) {
      expect(() => {
        instances[0].inst.onmessage?.({ data: raw });
      }).not.toThrow();
    }

    // Well-formed control reaches the listener — proving the WS
    // reader loop is still alive after the malformed frames.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        data: { channel_name: "design" },
        broadcast: { channel_id: "chid" },
        seq: 99,
      }),
    });
    expect(events).toHaveLength(1);
    expect((events[0] as { seq: number }).seq).toBe(99);
  });

  it("caps the drop-warn cooldown map under adversarial event-name flood", async () => {
    // Ninth-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0001`) flagged that the
    // `wsDropWarnCooldown` map could grow without bound if a
    // peer floods malformed frames with thousands of unique
    // made-up event names. The fix caps the map at 256 entries
    // and clears it entirely when the cap is reached. This test
    // sends 300 unique-event-name malformed frames in a row and
    // asserts that:
    //
    //   1. Every cleared-slate warning fires (so the operator
    //      retains visibility — no silent suppression by a
    //      saturated map).
    //   2. The forwarder doesn't crash or stall.
    //   3. A subsequent malformed frame at one of the EARLIEST
    //      event names (the ones that would have been evicted by
    //      the cap) fires a fresh warning, proving the cap reset
    //      worked and the cooldown is no longer suppressing it.
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    let clock = 0;
    const c = buildClient({
      webSocketCtor: ctor,
      logWarn,
      now: () => clock,
    });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});

    // Send 300 frames each with a UNIQUE made-up event name —
    // beyond the 256-entry cap. Each frame has missing `broadcast`,
    // so they all hit the `malformed-broadcast` drop site.
    for (let i = 0; i < 300; i++) {
      clock += 1;
      instances[0].inst.onmessage?.({
        data: JSON.stringify({
          event: `attack-${i}`,
          data: {},
          seq: i,
        }),
      });
    }
    // Every distinct tuple emitted exactly one warning, so 300
    // warnings total. The cap doesn't suppress warnings — it
    // resets the *cooldown* memory.
    expect(logWarn).toHaveBeenCalledTimes(300);

    // Now repeat one of the earliest event names. Without the
    // cap-reset path that entry would still be in the map and
    // the cooldown would suppress the warning. With the
    // cap-reset (the map was cleared when entry 257 arrived),
    // the entry is gone and a fresh warning fires.
    clock += 1;
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "attack-0",
        data: {},
        seq: 1000,
      }),
    });
    expect(logWarn).toHaveBeenCalledTimes(301);
  });

  it("clears the trust-boundary drop-warn cooldown on disconnect", async () => {
    // Ninth-pass Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0001`) flagged that the
    // `wsDropWarnCooldown` map is keyed by the untrusted
    // `eventName` and never shrinks. Across many reconnects a
    // peer cycling unique made-up event names could grow the map
    // without bound (the cooldown alone doesn't evict). The fix
    // is twofold: a hard cap at 256 entries (clear when reached)
    // AND a clean-slate reset on every `disconnectWebSocket()`.
    // This test exercises the disconnect arm: warn at a tuple,
    // disconnect, reconnect, warn at the SAME tuple. The cooldown
    // must have been reset, so the second warning fires (whereas
    // without the reset it would be suppressed by the 60 s
    // cooldown from before disconnect).
    const { ctor, instances } = mockWebSocketCtor();
    const logWarn = vi.fn();
    let clock = 1_000;
    const c = buildClient({
      webSocketCtor: ctor,
      logWarn,
      now: () => clock,
    });
    c.setServerUrl("https://kchat.example.com");
    c.setToken("PAT-secret");
    await c.connectWebSocket();
    instances[0].inst.onopen?.({});

    // First connection: malformed frame fires a warning.
    instances[0].inst.onmessage?.({
      data: JSON.stringify({ event: "posted", data: {}, seq: 1 }),
    });
    expect(logWarn).toHaveBeenCalledTimes(1);

    // Disconnect, reconnect, advance clock by only 1 ms (well
    // inside the 60 s cooldown window). If the cooldown survived
    // the disconnect, this would suppress the warning. With the
    // ninth-pass fix the cooldown is cleared on disconnect, so
    // the SAME tuple fires a second warning on the new connection.
    c.disconnectWebSocket();
    clock += 1;
    await c.connectWebSocket();
    instances[1].inst.onopen?.({});
    instances[1].inst.onmessage?.({
      data: JSON.stringify({ event: "posted", data: {}, seq: 2 }),
    });
    expect(logWarn).toHaveBeenCalledTimes(2);
  });

  it("user-initiated disconnect does NOT schedule a reconnect", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setToken("T");
    await c.connectWebSocket();
    c.disconnectWebSocket();
    expect(instances[0].closed).toBe(true);
    // No second WS instance should be created.
    expect(instances).toHaveLength(1);
  });
});

describe("KchatClient.shutdown", () => {
  it("clears the token and transitions to disconnected", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const { fn: fetchFn } = makeFetch([userResp]);
    const c = buildClient({ fetchFn });
    c.setToken("PAT");
    await c.verifyConnection();
    expect(c.getState().state).toBe("connected");
    c.shutdown();
    expect(c.getState().state).toBe("disconnected");
    expect(c.getUser()).toBeNull();
  });

  it("preserves external WS and status listeners across a shutdown/reconnect cycle", async () => {
    // Regression for fourth-pass Devin Review on PR #43
    // (BUG_pr-review-job-..._0001). The previous shutdown()
    // implementation called wsListeners.clear() +
    // statusListeners.clear(), which silently stripped the
    // KchatEventForwarder's subscription on the first disconnect
    // and left no path for it to re-attach (its own start() guard
    // is keyed on cached unsubscribe closures and would no-op).
    // Subsequent reconnects therefore had a dead push pipeline.
    // The fix is in KchatClient.shutdown(): only the client's own
    // connection state is torn down; external listener Sets are
    // left intact so the same forwarder subscription remains in
    // place across reconnects.
    const userResp1 = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const userResp2 = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const { fn: fetchFn } = makeFetch([userResp1, userResp2]);
    const c = buildClient({ fetchFn });

    const statusTransitions: string[] = [];
    const wsEvents: unknown[] = [];
    c.onStatusChange((s) => statusTransitions.push(s.state));
    c.onWebSocketEvent((e) => wsEvents.push(e));

    c.setToken("PAT");
    await c.verifyConnection();
    expect(c.getState().state).toBe("connected");

    c.shutdown();
    expect(c.getState().state).toBe("disconnected");

    // Reconnect on the SAME client instance — this is exactly the
    // flow KchatAuthService.disconnect() + connect() exercises.
    c.setToken("PAT");
    await c.verifyConnection();
    expect(c.getState().state).toBe("connected");

    // The status listener must have observed BOTH the
    // post-shutdown `disconnected` transition AND the
    // post-reconnect `connecting`/`connected` transitions. If
    // shutdown had cleared the listener Set the second connect
    // cycle's transitions would be invisible to the subscriber.
    expect(statusTransitions).toContain("disconnected");
    expect(
      statusTransitions.slice(statusTransitions.indexOf("disconnected") + 1),
    ).toContain("connected");

    // Now drive a WebSocket event after the reconnect to prove
    // the WS listener Set also survived the shutdown.
    const { ctor, instances } = mockWebSocketCtor();
    const c2 = buildClient({ webSocketCtor: ctor, fetchFn });
    const c2WsEvents: unknown[] = [];
    c2.onWebSocketEvent((e) => c2WsEvents.push(e));
    c2.shutdown();
    // After shutdown the existing onWebSocketEvent subscription
    // must still be live. Drive a WS event through and assert
    // delivery.
    c2.setServerUrl("https://kchat.example.com");
    c2.setToken("PAT");
    await c2.connectWebSocket();
    expect(instances).toHaveLength(1);
    instances[0].inst.onmessage?.({
      data: JSON.stringify({
        event: "posted",
        broadcast: { channel_id: "ch1" },
        data: { foo: 1 },
        seq: 7,
      }),
    });
    expect(c2WsEvents).toHaveLength(1);
    expect((c2WsEvents[0] as { event: string }).event).toBe("posted");
  });
});

describe("KchatClient rate limiter integration", () => {
  it("consumes one token per request from the shared limiter", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const { fn: fetchFn } = makeFetch([userResp]);
    const consumeSpy = vi.fn();
    const stubLimiter = {
      consume: consumeSpy,
    } as unknown as RateLimiter;
    const c = buildClient({ fetchFn, rateLimiter: stubLimiter });
    c.setToken("T");
    await c.verifyConnection();
    expect(consumeSpy).toHaveBeenCalled();
    const args = consumeSpy.mock.calls[0];
    expect(args[0]).toBe("kchat:request");
  });

  it("uses a single global upload key (not per-channel) so concurrent shares share one bucket", async () => {
    // Per-channel scoping would let a user sharing into N channels
    // simultaneously consume Nx the server-side upload quota. We
    // assert the key is the bare profile name so the bucket is
    // shared across channels.
    const uploadResp = ok({
      file_infos: [
        {
          id: "fid",
          name: "x.bin",
          size: 1,
          mime_type: "application/octet-stream",
          extension: "bin",
          create_at: 1,
        },
      ],
    });
    const { fn: fetchFn } = makeFetch([uploadResp, uploadResp]);
    const consumeSpy = vi.fn();
    const stubLimiter = {
      consume: consumeSpy,
    } as unknown as RateLimiter;
    const c = buildClient({ fetchFn, rateLimiter: stubLimiter });
    c.setToken("T");
    await c.uploadFile("chid-a", "x.bin", new Uint8Array([0]));
    await c.uploadFile("chid-b", "x.bin", new Uint8Array([0]));
    const uploadCalls = consumeSpy.mock.calls.filter(
      (cl) => cl[0] === "kchat:upload",
    );
    expect(uploadCalls).toHaveLength(2);
    // Neither call should embed the channel id in the key.
    for (const cl of uploadCalls) {
      expect(cl[0]).not.toContain("chid-a");
      expect(cl[0]).not.toContain("chid-b");
    }
  });
});

describe("KchatClient.verifyConnection({ silent })", () => {
  // The periodic health check fires `verifyConnection({ silent: true })`
  // every 30s. A healthy probe must NOT push a transient
  // `connecting` state to subscribers — that would flicker any
  // renderer surface that mirrors the connection state.
  it("does not transition to 'connecting' on a successful silent probe", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const { fn: fetchFn } = makeFetch([userResp, userResp]);
    const c = buildClient({ fetchFn });
    c.setToken("T");
    // Prime: one normal verification so we start in `connected`.
    await c.verifyConnection();

    const transitions: string[] = [];
    const unsubscribe = c.onStatusChange((s) => transitions.push(s.state));
    await c.verifyConnection({ silent: true });
    unsubscribe();
    // The only transition emitted should be `connected` (or none,
    // if the new state equals the previous). It MUST NOT include
    // `connecting`.
    expect(transitions).not.toContain("connecting");
  });

  it("still transitions to 'error' on a failed silent probe", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const failResp: MockResponse = {
      status: 401,
      body: '{"message":"bad token"}',
      headers: { "content-type": "application/json" },
    };
    const { fn: fetchFn } = makeFetch([userResp, failResp]);
    const c = buildClient({ fetchFn });
    c.setToken("T");
    await c.verifyConnection();

    const transitions: string[] = [];
    const unsubscribe = c.onStatusChange((s) => transitions.push(s.state));
    await expect(c.verifyConnection({ silent: true })).rejects.toBeDefined();
    unsubscribe();
    expect(transitions).toContain("error");
  });
});

describe("KchatClient.connectWebSocket — URL derivation", () => {
  // The WS URL is built via the `URL` constructor so scheme
  // conversion is explicit (https → wss, http → ws) and any other
  // scheme is rejected outright.
  it("converts https to wss and preserves a non-root base path", async () => {
    const userResp = ok({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
      roles: "system_user",
    });
    const { fn: fetchFn } = makeFetch([userResp]);
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ fetchFn, webSocketCtor: ctor });
    c.setServerUrl("https://kchat.example.com/k");
    c.setToken("T");
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(
      "wss://kchat.example.com/k/api/v4/websocket",
    );
  });

  it("converts http to ws and tolerates trailing slashes", async () => {
    const { ctor, instances } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    c.setServerUrl("http://localhost:8065/");
    c.setToken("T");
    await c.connectWebSocket();
    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(
      "ws://localhost:8065/api/v4/websocket",
    );
  });

  it("rejects non-http(s) server URLs", async () => {
    const { ctor } = mockWebSocketCtor();
    const c = buildClient({ webSocketCtor: ctor });
    // `setServerUrl` doesn't validate (the IPC handler does), so
    // an attacker-injected `ftp://` would land here. The WS path
    // must refuse rather than silently produce a bogus URL.
    c.setServerUrl("ftp://kchat.example.com");
    c.setToken("T");
    await expect(c.connectWebSocket()).rejects.toThrow(
      /must use http or https/,
    );
  });
});

/**
 * Block C Task 1 (Phase 12): REST surface for chat-post
 * ingestion. `getPost` fetches a single envelope (used by the
 * `post_edited` recovery path), `getPostsForChannel` paginates
 * (used by the future Block C Task 4 backfill watermark loop).
 * Both must (a) drive their requests through `kchat:request`
 * (covered by the existing rate-limiter contract tests for the
 * shared `request()` helper), (b) re-validate every server-
 * supplied id at the deserialisation boundary, and (c) project
 * the snake_case wire shape to the renderer-safe camelCase
 * {@link KchatPostInfo} shape consistently.
 */
describe("KchatClient.getPost", () => {
  function fresh() {
    return new RateLimiter();
  }
  it("flattens the snake_case envelope and validates each id", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      ok({
        id: "pid000000000000000000abcd",
        channel_id: "chid0000000000000000abcd",
        root_id: "",
        user_id: "uid000000000000000000abcd",
        message: "hi there",
        create_at: 1_700_000_000_000,
        edit_at: 0,
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    const p = await c.getPost("pid000000000000000000abcd");
    expect(p).toEqual({
      id: "pid000000000000000000abcd",
      channelId: "chid0000000000000000abcd",
      rootId: null,
      userId: "uid000000000000000000abcd",
      message: "hi there",
      createAt: 1_700_000_000_000,
      editAt: 0,
    });
    expect(calls[0].url).toContain("/api/v4/posts/pid000000000000000000abcd");
  });

  it("rejects a server-supplied post id that does not match the KChat id shape", async () => {
    const { fn: fetchFn } = makeFetch([
      ok({
        id: "../etc/passwd",
        channel_id: "chid0000000000000000abcd",
        root_id: null,
        user_id: "uid000000000000000000abcd",
        message: "hi",
        create_at: 1,
        edit_at: 0,
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(
      c.getPost("pid000000000000000000abcd"),
    ).rejects.toThrow(/not a valid KChat object id/);
  });

  it("throws when required fields are missing (e.g. message=undefined)", async () => {
    const { fn: fetchFn } = makeFetch([
      ok({
        id: "pid000000000000000000abcd",
        channel_id: "chid0000000000000000abcd",
        user_id: "uid000000000000000000abcd",
        // message intentionally absent
        create_at: 1_700_000_000_000,
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(
      c.getPost("pid000000000000000000abcd"),
    ).rejects.toThrow(/post\.message missing/);
  });

  it("rejects the caller-supplied postId before contacting the server", async () => {
    const { fn: fetchFn, calls } = makeFetch([]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(c.getPost("../etc/passwd")).rejects.toThrow(
      /not a valid KChat object id/,
    );
    expect(calls.length).toBe(0);
  });
});

describe("KchatClient.getPostsForChannel", () => {
  function fresh() {
    return new RateLimiter();
  }
  it("projects the (order, posts-map) wire shape into a flat array", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      ok({
        order: ["pid000000000000000000a002", "pid000000000000000000a001"],
        posts: {
          pid000000000000000000a001: {
            id: "pid000000000000000000a001",
            channel_id: "chid0000000000000000abcd",
            root_id: "",
            user_id: "uid000000000000000000abcd",
            message: "first",
            create_at: 1,
            edit_at: 0,
          },
          pid000000000000000000a002: {
            id: "pid000000000000000000a002",
            channel_id: "chid0000000000000000abcd",
            root_id: "",
            user_id: "uid000000000000000000abcd",
            message: "second",
            create_at: 2,
            edit_at: 0,
          },
        },
        prev_post_id: "pid000000000000000000a000",
        next_post_id: "",
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    const page = await c.getPostsForChannel("chid0000000000000000abcd");
    expect(page.posts.map((p) => p.message)).toEqual(["second", "first"]);
    expect(page.posts[0].id).toBe("pid000000000000000000a002");
    expect(page.prevPostId).toBe("pid000000000000000000a000");
    expect(page.nextPostId).toBeNull();
    expect(page.hasMore).toBe(true);
    expect(calls[0].url).toContain(
      "/api/v4/channels/chid0000000000000000abcd/posts?per_page=60",
    );
  });

  it("interpolates before / after / since when provided", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      ok({ order: [], posts: {}, prev_post_id: "", next_post_id: "" }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await c.getPostsForChannel("chid0000000000000000abcd", {
      before: "pid000000000000000000a001",
      sinceMs: 1_700_000_000_000,
      perPage: 30,
    });
    const url = calls[0].url;
    expect(url).toContain("per_page=30");
    expect(url).toContain("before=pid000000000000000000a001");
    expect(url).toContain("since=1700000000000");
  });

  it("clamps perPage at 200 client-side", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      ok({ order: [], posts: {}, prev_post_id: "", next_post_id: "" }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await c.getPostsForChannel("chid0000000000000000abcd", { perPage: 10_000 });
    expect(calls[0].url).toContain("per_page=200");
  });

  it("hasMore=false when prev_post_id is empty", async () => {
    const { fn: fetchFn } = makeFetch([
      ok({
        order: ["pid000000000000000000a001"],
        posts: {
          pid000000000000000000a001: {
            id: "pid000000000000000000a001",
            channel_id: "chid0000000000000000abcd",
            root_id: "",
            user_id: "uid000000000000000000abcd",
            message: "only post",
            create_at: 1,
            edit_at: 0,
          },
        },
        prev_post_id: "",
        next_post_id: "",
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    const page = await c.getPostsForChannel("chid0000000000000000abcd");
    expect(page.hasMore).toBe(false);
    expect(page.prevPostId).toBeNull();
  });

  it("rejects a server-supplied malformed id in the posts map", async () => {
    const { fn: fetchFn } = makeFetch([
      ok({
        order: ["pid000000000000000000a001"],
        posts: {
          pid000000000000000000a001: {
            id: "../etc/passwd",
            channel_id: "chid0000000000000000abcd",
            root_id: "",
            user_id: "uid000000000000000000abcd",
            message: "x",
            create_at: 1,
            edit_at: 0,
          },
        },
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(
      c.getPostsForChannel("chid0000000000000000abcd"),
    ).rejects.toThrow(/not a valid KChat object id/);
  });

  it("rejects the caller-supplied channelId before contacting the server", async () => {
    const { fn: fetchFn, calls } = makeFetch([]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(c.getPostsForChannel("../etc/passwd")).rejects.toThrow(
      /not a valid KChat object id/,
    );
    expect(calls.length).toBe(0);
  });
});

// =====================================================================
// Phase 13 Theme 2 Task 9: name-enrichment endpoints
// =====================================================================
describe("KchatClient.getUsersByIds (Phase 13 Theme 2 Task 9)", () => {
  function fresh() {
    return new RateLimiter();
  }
  it("POSTs the id array to /api/v4/users/ids and parses the response", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      ok([
        {
          id: "user1234567890abcdefgh",
          username: "ken",
          email: "k@example.com",
          first_name: "K",
          last_name: "N",
          roles: "system_user",
        },
        {
          id: "user2234567890abcdefgh",
          username: "alex",
          email: "a@example.com",
          first_name: "A",
          last_name: "L",
          roles: "system_user",
        },
      ]),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");

    const users = await c.getUsersByIds([
      "user1234567890abcdefgh",
      "user2234567890abcdefgh",
    ]);

    expect(users).toHaveLength(2);
    expect(users[0].username).toBe("ken");
    expect(users[1].username).toBe("alex");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/v4\/users\/ids$/);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(calls[0].init.body).toBe(
      JSON.stringify(["user1234567890abcdefgh", "user2234567890abcdefgh"]),
    );
  });

  it("short-circuits to [] when called with an empty list (no network call)", async () => {
    const { fn: fetchFn, calls } = makeFetch([]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    const users = await c.getUsersByIds([]);
    expect(users).toEqual([]);
    // The empty-input short-circuit MUST NOT touch the network.
    // Calling /users/ids with an empty body is wasteful, and we
    // don't want the rate limiter token consumed for nothing.
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed caller-supplied ids before contacting the server (boundary check)", async () => {
    const { fn: fetchFn, calls } = makeFetch([]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(
      c.getUsersByIds(["user1234567890abcdefgh", "../etc/passwd"]),
    ).rejects.toThrow(/not a valid KChat object id/);
    expect(calls.length).toBe(0);
  });

  it("rejects malformed server-supplied ids in the response (defence-in-depth)", async () => {
    const { fn: fetchFn } = makeFetch([
      ok([
        {
          id: "../etc/passwd",
          username: "evil",
          email: "e@example.com",
          first_name: "",
          last_name: "",
          roles: "system_user",
        },
      ]),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(
      c.getUsersByIds(["user1234567890abcdefgh"]),
    ).rejects.toThrow(/not a valid KChat object id/);
  });
});

describe("KchatClient.getChannel (Phase 13 Theme 2 Task 9)", () => {
  function fresh() {
    return new RateLimiter();
  }
  it("GETs /api/v4/channels/{id} and parses the response", async () => {
    const { fn: fetchFn, calls } = makeFetch([
      ok({
        id: "chid0000000000000000abcd",
        team_id: "tid000000000000000000ab",
        name: "general",
        display_name: "General",
        type: "O",
        purpose: "",
        header: "",
        total_msg_count: 0,
        create_at: 0,
        update_at: 0,
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");

    const channel = await c.getChannel("chid0000000000000000abcd");
    expect(channel.display_name).toBe("General");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/api\/v4\/channels\/chid0000000000000000abcd$/);
    expect(calls[0].init.method).toBe("GET");
  });

  it("rejects the caller-supplied channelId before contacting the server", async () => {
    const { fn: fetchFn, calls } = makeFetch([]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(c.getChannel("../etc/passwd")).rejects.toThrow(
      /not a valid KChat object id/,
    );
    expect(calls.length).toBe(0);
  });

  it("rejects malformed server-supplied channel.id / team_id in the response (defence-in-depth)", async () => {
    const { fn: fetchFn } = makeFetch([
      ok({
        id: "../etc/passwd",
        team_id: "tid000000000000000000ab",
        name: "evil",
        display_name: "Evil",
        type: "O",
        purpose: "",
        header: "",
        total_msg_count: 0,
        create_at: 0,
        update_at: 0,
      }),
    ]);
    const c = buildClient({ fetchFn, rateLimiter: fresh() });
    c.setToken("T");
    await expect(c.getChannel("chid0000000000000000abcd")).rejects.toThrow(
      /not a valid KChat object id/,
    );
  });
});
