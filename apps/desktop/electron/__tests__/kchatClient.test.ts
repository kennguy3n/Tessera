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
import { describe, it, expect, vi, beforeEach } from "vitest";

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
}> = {}) {
  const client = new KchatClient({
    fetchFn: overrides.fetchFn,
    webSocketCtor: overrides.webSocketCtor,
    rateLimiter: overrides.rateLimiter,
    sleep: overrides.sleep ?? (async () => {}),
    random: overrides.random ?? (() => 0.5),
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
  it("clears the token, transitions to disconnected, and clears listeners", async () => {
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
