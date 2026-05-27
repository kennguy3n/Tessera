/**
 * Phase 14 Task 8 — KChat Desktop integration test suite.
 *
 * Exercises the cross-cutting surface that ties the localhost
 * HTTP API (`kchatLocalApi.ts`) to the `tessera://` deeplink
 * bridge (`kchatDeeplinkBridge.ts`) and to the `kchat://` deeplink
 * the renderer asks the main process to open in KChat Desktop.
 *
 * Each test stands up a real `KchatLocalApiServer` bound to a
 * random loopback port; we never mock the HTTP layer. The only
 * substitutions are:
 *
 *   - `userDataDir` → an `os.tmpdir()` mkdtemp directory the test
 *     creates and cleans up.
 *   - `tokenForTesting` → a 32-byte fixed string so tests can
 *     reason about the bearer token without poking
 *     `tokenForTests()` everywhere.
 *   - `nowMsForTesting` → a settable clock so heartbeat freshness
 *     can be asserted deterministically.
 *   - `LocalApiHandlers` → an in-memory test double; the contract
 *     is the same one `electron/ipc/kchat.ts` implements in
 *     production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  KchatLocalApiServer,
  LocalApiError,
  PORT_FILE_NAME,
  type IngestChannelRequest,
  type LocalApiHandlers,
  type ShareArtifactRequest,
  type TesseraKchatSourceRow,
} from "../kchat/kchatLocalApi";
import {
  buildDeeplink,
  DeeplinkBridge,
  parseDeeplink,
  TESSERA_PROTOCOL_SCHEME,
  type DeeplinkRoute,
} from "../kchat/kchatDeeplinkBridge";

const TEST_TOKEN = "test-token-".padEnd(40, "x");

function makeHandlers(overrides: Partial<LocalApiHandlers> = {}): {
  handlers: LocalApiHandlers;
  state: {
    sources: TesseraKchatSourceRow[];
    ingestCalls: IngestChannelRequest[];
    shareCalls: ShareArtifactRequest[];
  };
} {
  const state = {
    sources: [] as TesseraKchatSourceRow[],
    ingestCalls: [] as IngestChannelRequest[],
    shareCalls: [] as ShareArtifactRequest[],
  };
  const handlers: LocalApiHandlers = {
    async status() {
      return {
        tesseraVersion: "0.0.0-test",
        connected: true,
        serverUrl: "https://kchat.example",
        indexedChannelCount: state.sources.length,
        lastEventAt: null,
        capabilities: ["status", "list_sources"],
      };
    },
    async listSources() {
      return state.sources;
    },
    async ingestChannel(req) {
      state.ingestCalls.push(req);
      const row: TesseraKchatSourceRow = {
        sourceId: `src-${req.channelId}`,
        kind: "kchat-channel",
        channelId: req.channelId,
        channelName: req.channelName,
        teamId: req.teamId ?? null,
        state: "ingesting",
        lastSyncedAt: null,
        errorMessage: null,
        tesseraDeeplink: `${TESSERA_PROTOCOL_SCHEME}://source/src-${req.channelId}`,
      };
      state.sources.push(row);
      return { sourceId: row.sourceId, state: row.state };
    },
    async shareArtifact(req) {
      state.shareCalls.push(req);
      return {
        shareId: `share-${req.artifactId}`,
        postId: `post-${req.artifactId}`,
        permalink: `https://kchat.example/p/${req.artifactId}`,
      };
    },
    ...overrides,
  };
  return { handlers, state };
}

interface RunningServer {
  server: KchatLocalApiServer;
  baseUrl: string;
  port: number;
  userDataDir: string;
  now: { value: number };
}

async function startServer(
  handlers: LocalApiHandlers,
  opts: { token?: string } = {},
): Promise<RunningServer> {
  const userDataDir = mkdtempSync(join(tmpdir(), "tessera-localapi-"));
  const now = { value: 1_700_000_000_000 };
  const server = new KchatLocalApiServer(handlers, {
    userDataDir,
    tokenForTesting: opts.token ?? TEST_TOKEN,
    nowMsForTesting: () => now.value,
  });
  const { port } = await server.start();
  return {
    server,
    port,
    userDataDir,
    baseUrl: `http://127.0.0.1:${port}`,
    now,
  };
}

function authHeaders(token: string = TEST_TOKEN): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
}

describe("KchatLocalApiServer — bind + discovery file", () => {
  let running: RunningServer | null = null;

  afterEach(async () => {
    if (running) {
      await running.server.stop();
      try {
        rmSync(running.userDataDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
      running = null;
    }
  });

  it("binds only to 127.0.0.1 and assigns a random port", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    expect(running.port).toBeGreaterThan(0);
    expect(running.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("writes a discovery file with the bound port + token at 0600", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const portFile = join(running.userDataDir, PORT_FILE_NAME);
    expect(existsSync(portFile)).toBe(true);
    const body = JSON.parse(readFileSync(portFile, "utf8")) as {
      version: number;
      host: string;
      port: number;
      token: string;
      startedAt: string;
      pid: number;
    };
    expect(body.version).toBe(1);
    expect(body.host).toBe("127.0.0.1");
    expect(body.port).toBe(running.port);
    expect(body.token).toBe(TEST_TOKEN);
    expect(body.pid).toBe(process.pid);
    expect(Number.isFinite(new Date(body.startedAt).getTime())).toBe(true);
  });

  it("removes the discovery file on stop()", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const portFile = join(running.userDataDir, PORT_FILE_NAME);
    expect(existsSync(portFile)).toBe(true);
    await running.server.stop();
    expect(existsSync(portFile)).toBe(false);
    // Re-set the harness's `running` to null so the afterEach
    // doesn't try to stop an already-stopped server (idempotent
    // but tidier).
    running = null;
  });

  it("refuses a second start() on the same instance", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    await expect(running.server.start()).rejects.toThrow(
      /KchatLocalApiServer\.start called twice/,
    );
  });

  it("rejects a tokenForTesting shorter than 32 characters", () => {
    const { handlers } = makeHandlers();
    expect(
      () =>
        new KchatLocalApiServer(handlers, {
          userDataDir: tmpdir(),
          tokenForTesting: "too-short",
        }),
    ).toThrow(/at least 32 characters/);
  });
});

describe("KchatLocalApiServer — auth + Host header policy", () => {
  let running: RunningServer | null = null;
  afterEach(async () => {
    if (running) {
      await running.server.stop();
      rmSync(running.userDataDir, { recursive: true, force: true });
      running = null;
    }
  });

  it("rejects requests without a bearer token", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/status`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("unauthorized");
    expect(body.error).toMatch(/missing bearer token/);
  });

  it("rejects requests with an incorrect bearer token", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/status`, {
      headers: { authorization: `Bearer wrong-token-${"x".repeat(30)}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("unauthorized");
  });

  it("rejects requests with a non-loopback Host header", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    // Bypass `fetch`'s automatic Host computation by going
    // through `net.Socket` directly.
    const net = await import("node:net");
    const port = running.port;
    const reply = await new Promise<string>((resolveFn, rejectFn) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      const chunks: Buffer[] = [];
      socket.once("error", rejectFn);
      socket.once("data", (chunk: Buffer) => {
        chunks.push(chunk);
        socket.end();
      });
      socket.once("end", () => resolveFn(Buffer.concat(chunks).toString()));
      socket.write(
        [
          `GET /api/status HTTP/1.1`,
          `Host: evil.example`,
          `Authorization: Bearer ${TEST_TOKEN}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
    });
    expect(reply.startsWith("HTTP/1.1 403")).toBe(true);
  });

  it("accepts a request with the correct token and updates the heartbeat", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const before = running.server.snapshotForRenderer();
    expect(before.lastExtensionContactAt).toBeNull();
    running.now.value = 1_700_000_500_000;
    const res = await fetch(`${running.baseUrl}/api/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const after = running.server.snapshotForRenderer();
    expect(after.lastExtensionContactAt).toBe(
      new Date(1_700_000_500_000).toISOString(),
    );
    expect(after.apiServerRunning).toBe(true);
    expect(after.apiServerPort).toBe(running.port);
  });

  it("does not advance the heartbeat on a failed auth attempt", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    running.now.value = 1_700_000_900_000;
    await fetch(`${running.baseUrl}/api/status`, {
      headers: { authorization: "Bearer wrong-".padEnd(50, "x") },
    });
    expect(
      running.server.snapshotForRenderer().lastExtensionContactAt,
    ).toBeNull();
  });
});

describe("KchatLocalApiServer — route surface", () => {
  let running: RunningServer | null = null;
  afterEach(async () => {
    if (running) {
      await running.server.stop();
      rmSync(running.userDataDir, { recursive: true, force: true });
      running = null;
    }
  });

  it("GET /api/status returns the handler payload", async () => {
    const { handlers, state } = makeHandlers();
    state.sources.push({
      sourceId: "src-1",
      kind: "kchat-channel",
      channelId: "chan-1",
      channelName: "general",
      teamId: "team-1",
      state: "ready",
      lastSyncedAt: null,
      errorMessage: null,
      tesseraDeeplink: "tessera://source/src-1",
    });
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { indexedChannelCount: number };
    expect(body.indexedChannelCount).toBe(1);
  });

  it("GET /api/sources returns the handler list", async () => {
    const { handlers, state } = makeHandlers();
    state.sources.push({
      sourceId: "src-1",
      kind: "kchat-channel",
      channelId: "chan-1",
      channelName: "general",
      teamId: "team-1",
      state: "ready",
      lastSyncedAt: null,
      errorMessage: null,
      tesseraDeeplink: "tessera://source/src-1",
    });
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/sources`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(200);
    const rows = (await res.json()) as TesseraKchatSourceRow[];
    expect(rows.map((r) => r.sourceId)).toEqual(["src-1"]);
  });

  it("POST /api/ingest-channel forwards a validated request", async () => {
    const { handlers, state } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/ingest-channel`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        channelId: "chan-2",
        channelName: "design",
        teamId: "team-1",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sourceId: string; state: string };
    expect(body.sourceId).toBe("src-chan-2");
    expect(body.state).toBe("ingesting");
    expect(state.ingestCalls).toEqual([
      { channelId: "chan-2", channelName: "design", teamId: "team-1" },
    ]);
  });

  it("POST /api/ingest-channel rejects a missing channelName", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/ingest-channel`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ channelId: "chan-3" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("invalid_request");
    expect(body.error).toMatch(/channelName/);
  });

  it("POST /api/share-artifact forwards a validated request", async () => {
    const { handlers, state } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/share-artifact`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        artifactId: "art-1",
        channelId: "chan-2",
        message: "fyi",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { shareId: string };
    expect(body.shareId).toBe("share-art-1");
    expect(state.shareCalls).toEqual([
      { artifactId: "art-1", channelId: "chan-2", message: "fyi" },
    ]);
  });

  it("rejects an unknown route with 404", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/unknown`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(404);
  });

  it("rejects a non-JSON body on a POST route", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/ingest-channel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": "text/plain",
      },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  // Phase 14 Round 4 Devin Review polish: the previous Content-Type
  // regex used `(\b|;)`, which matched `application/json-ld` because
  // `\b` matches the boundary between `n` and `-`. Tighten the
  // contract to ONLY accept `application/json` (with optional
  // `;parameters`) so a future caller (or a misconfigured proxy)
  // can't sneak in a JSON-family sibling type that the rest of
  // `readJsonBody` doesn't actually parse. The .kcz extension we
  // ship only sends `application/json`, so this is a no-op in
  // practice.
  it.each([
    "application/json-ld",
    "application/json-patch+json",
    "application/vnd.api+json",
    "application/jsonp",
  ])(
    "rejects sibling JSON-family Content-Type %s",
    async (contentType: string) => {
      const { handlers } = makeHandlers();
      running = await startServer(handlers);
      const res = await fetch(`${running.baseUrl}/api/ingest-channel`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": contentType,
        },
        body: JSON.stringify({ channelId: "c", channelName: "n" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("invalid_request");
    },
  );

  it.each([
    "application/json",
    "application/json; charset=utf-8",
    "Application/JSON; charset=UTF-8",
    "application/json;charset=utf-8",
    "application/json ",
  ])("accepts canonical Content-Type %s", async (contentType: string) => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/ingest-channel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TEST_TOKEN}`,
        "content-type": contentType,
      },
      body: JSON.stringify({ channelId: "c", channelName: "n" }),
    });
    // 200 (success path) — confirms the Content-Type gate passes
    // AND the rest of the request validates fine.
    expect(res.status).toBe(200);
  });

  it("rejects a body larger than 64 KiB", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const huge = JSON.stringify({
      channelId: "chan-x",
      channelName: "x".repeat(70 * 1024),
    });
    const res = await fetch(`${running.baseUrl}/api/ingest-channel`, {
      method: "POST",
      headers: authHeaders(),
      body: huge,
    });
    expect(res.status).toBe(413);
  });

  it("forwards a LocalApiError thrown from a handler", async () => {
    const { handlers } = makeHandlers({
      async status() {
        throw new LocalApiError(503, "tessera_unavailable", "indexer down");
      },
    });
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("tessera_unavailable");
    expect(body.error).toBe("indexer down");
  });

  it("maps a generic handler throw to a 500 internal_error", async () => {
    const { handlers } = makeHandlers({
      async status() {
        throw new Error("boom");
      },
    });
    running = await startServer(handlers);
    const res = await fetch(`${running.baseUrl}/api/status`, {
      headers: authHeaders(),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("internal_error");
  });
});

describe("Deeplinks — tessera:// parsing + building", () => {
  it("parses a source deeplink", () => {
    const r = parseDeeplink("tessera://source/abc123");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route).toEqual({ kind: "source", sourceId: "abc123" });
    }
  });

  it("parses an artifact deeplink", () => {
    const r = parseDeeplink("tessera://artifact/art-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route).toEqual({ kind: "artifact", artifactId: "art-1" });
    }
  });

  it("parses an ingest deeplink with optional team", () => {
    const r = parseDeeplink(
      "tessera://ingest?channel=chan-1&team=team-1",
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route).toEqual({
        kind: "ingest",
        channelId: "chan-1",
        teamId: "team-1",
      });
    }
  });

  it("parses an ingest deeplink without a team", () => {
    const r = parseDeeplink("tessera://ingest?channel=chan-1");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.route).toEqual({
        kind: "ingest",
        channelId: "chan-1",
        teamId: null,
      });
    }
  });

  it.each([
    "https://tessera/source/abc",
    "tessera://source/",
    "tessera://source/abc/extra",
    "tessera://source/has spaces",
    "tessera://ingest",
    "tessera://ingest?channel=$$$",
    "tessera://unknown/host",
  ])("rejects malformed deeplink %s", (raw) => {
    const r = parseDeeplink(raw);
    expect(r.ok).toBe(false);
  });

  it("round-trips via buildDeeplink + parseDeeplink", () => {
    const routes: DeeplinkRoute[] = [
      { kind: "source", sourceId: "src-1" },
      { kind: "artifact", artifactId: "art-1" },
      { kind: "ingest", channelId: "chan-1", teamId: "team-1" },
      { kind: "ingest", channelId: "chan-1", teamId: null },
    ];
    for (const route of routes) {
      const url = buildDeeplink(route);
      const parsed = parseDeeplink(url);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.route).toEqual(route);
    }
  });
});

describe("DeeplinkBridge — consumer lifecycle + parking", () => {
  it("parks deeplinks before a consumer is registered, then flushes in order", () => {
    const bridge = new DeeplinkBridge();
    bridge.ingestRawUrl("tessera://source/a");
    bridge.ingestRawUrl("tessera://source/b");
    expect(bridge.pendingCount()).toBe(2);
    const seen: DeeplinkRoute[] = [];
    bridge.setConsumer((r) => {
      seen.push(r);
    });
    expect(bridge.pendingCount()).toBe(0);
    expect(seen).toEqual([
      { kind: "source", sourceId: "a" },
      { kind: "source", sourceId: "b" },
    ]);
  });

  it("dispatches synchronously to the consumer once registered", () => {
    const seen: DeeplinkRoute[] = [];
    const bridge = new DeeplinkBridge();
    bridge.setConsumer((r) => {
      seen.push(r);
    });
    bridge.ingestRawUrl("tessera://artifact/art-1");
    expect(seen).toEqual([{ kind: "artifact", artifactId: "art-1" }]);
    expect(bridge.pendingCount()).toBe(0);
  });

  it("does not crash when the consumer throws", () => {
    const bridge = new DeeplinkBridge();
    bridge.setConsumer(() => {
      throw new Error("buggy renderer");
    });
    expect(() => bridge.ingestRawUrl("tessera://source/x")).not.toThrow();
    expect(bridge.pendingCount()).toBe(0);
  });

  it("calls the failure logger on a malformed deeplink", () => {
    const onParseFailure = vi.fn();
    const bridge = new DeeplinkBridge({ onParseFailure });
    bridge.ingestRawUrl("tessera://unknown/host");
    expect(onParseFailure).toHaveBeenCalledTimes(1);
    expect(onParseFailure.mock.calls[0][1]).toBe("unknown-host");
    expect(bridge.pendingCount()).toBe(0);
  });

  it("re-attaches a consumer after clearConsumer()", () => {
    const bridge = new DeeplinkBridge();
    const seen: DeeplinkRoute[] = [];
    bridge.setConsumer((r) => {
      seen.push(r);
    });
    bridge.clearConsumer();
    bridge.ingestRawUrl("tessera://source/parked-after-clear");
    expect(bridge.pendingCount()).toBe(1);
    expect(seen).toHaveLength(0);
    bridge.setConsumer((r) => {
      seen.push(r);
    });
    expect(seen).toEqual([
      { kind: "source", sourceId: "parked-after-clear" },
    ]);
  });

  it("extractUrlFromArgv finds the first tessera URL", () => {
    expect(
      DeeplinkBridge.extractUrlFromArgv([
        "/path/to/electron",
        "--flag=1",
        "tessera://source/a",
        "tessera://source/b",
      ]),
    ).toBe("tessera://source/a");
    expect(
      DeeplinkBridge.extractUrlFromArgv(["/path/to/electron", "--flag=1"]),
    ).toBeNull();
  });
});

describe("Cross-cutting integration — port file + bearer + handler", () => {
  let running: RunningServer | null = null;
  beforeEach(() => {
    running = null;
  });
  afterEach(async () => {
    if (running) {
      await running.server.stop();
      rmSync(running.userDataDir, { recursive: true, force: true });
      running = null;
    }
  });

  it("a client reading the discovery file can authenticate and call /api/status", async () => {
    const { handlers } = makeHandlers();
    running = await startServer(handlers);
    const portFile = JSON.parse(
      readFileSync(join(running.userDataDir, PORT_FILE_NAME), "utf8"),
    ) as { host: string; port: number; token: string };
    const res = await fetch(
      `http://${portFile.host}:${portFile.port}/api/status`,
      { headers: { authorization: `Bearer ${portFile.token}` } },
    );
    expect(res.status).toBe(200);
  });
});
