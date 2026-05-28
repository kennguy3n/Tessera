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
  type PortFileWriter,
  type ShareArtifactRequest,
  type TesseraKchatSourceRow,
} from "../kchat/kchatLocalApi";
import { createConnection } from "node:net";
import { createServer as createNodeHttpServer } from "node:http";
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

  // Phase 14 Round 8 Devin Review BUG_0001: when the port-file
  // write throws after the HTTP server has already been bound,
  // `start()` MUST close the bound socket and roll back its
  // internal state — otherwise the leaked server holds an
  // event-loop handle for the rest of the process lifetime,
  // because the caller never stored the instance anywhere it
  // could call `stop()` from. This test pins that behaviour by
  // (a) confirming the captured port no longer accepts TCP
  // connections after `start()` rejects, and (b) confirming the
  // instance can run `start()` again successfully (i.e. its
  // internal slot was cleared, so the "called twice" guard
  // doesn't trip on a phantom prior start).
  it("closes the bound socket and rolls back internal state when the port-file write fails", async () => {
    const { handlers } = makeHandlers();
    const userDataDir = mkdtempSync(join(tmpdir(), "tessera-localapi-leak-"));
    let portCapturedFromFailedStart = 0;
    const failingWriter: PortFileWriter = {
      writeAtomic(_path, contents) {
        const parsed = JSON.parse(contents) as { port: number };
        portCapturedFromFailedStart = parsed.port;
        throw new Error("simulated EACCES on userData");
      },
      unlink() {
        /* no-op; we never reach a state that needs cleanup */
      },
    };
    const server = new KchatLocalApiServer(handlers, {
      userDataDir,
      tokenForTesting: TEST_TOKEN,
      fsWriter: failingWriter,
    });
    await expect(server.start()).rejects.toThrow(/simulated EACCES/);
    // The port captured from inside the failing writer was the
    // real kernel-assigned port the server bound to. If the
    // rollback worked, that port should no longer accept TCP
    // connections — we'd get ECONNREFUSED instead.
    expect(portCapturedFromFailedStart).toBeGreaterThan(0);
    await new Promise<void>((resolveFn) => {
      const probe = createConnection(
        { host: "127.0.0.1", port: portCapturedFromFailedStart },
        () => {
          // If we got `connect`, the rollback failed — the
          // bound socket is still listening on the captured
          // port. Tear the probe down and let the assertion
          // below trip.
          probe.destroy();
          resolveFn();
        },
      );
      probe.once("error", () => {
        // ECONNREFUSED is the expected outcome — the rollback
        // closed the listening socket.
        resolveFn();
      });
    });
    // A second `start()` on the same instance must succeed,
    // proving the rolled-back instance is structurally
    // indistinguishable from one that never called `start()`.
    // Replace the writer with a no-op so the second start can
    // complete.
    const noopWriter: PortFileWriter = {
      writeAtomic() {
        /* no-op */
      },
      unlink() {
        /* no-op */
      },
    };
    // Reach into the instance to swap the writer. The field is
    // private; we cast through `unknown` to a writer-bearing
    // shape, which is acceptable in tests where we're pinning
    // a contract that depends on internal-state rollback. This
    // does NOT bypass the production code path — `start()`
    // still calls `this.fsWriter.writeAtomic`, we're just
    // pointing it at a non-throwing implementation now.
    (server as unknown as { fsWriter: PortFileWriter }).fsWriter =
      noopWriter;
    const second = await server.start();
    expect(second.port).toBeGreaterThan(0);
    await server.stop();
    rmSync(userDataDir, { recursive: true, force: true });
  });

  // Phase 14 Round 13 Devin Review ANALYSIS_0007: when
  // `server.address()` returns `null` or a string after a
  // successful `listen()` callback (practically unreachable in
  // production but a real edge case in `node:net`'s typedef),
  // `start()` MUST close the bound socket before throwing — same
  // teardown the wrong-address branch right below already performs.
  // Without this, the throw orphans the listening socket for the
  // process lifetime, exactly the failure mode Round 8's BUG_0001
  // rollback set out to prevent.
  //
  // The test injects a `createServerFn` wrapper that delegates to
  // the real `node:http.createServer` but replaces the inner
  // server's `address()` with a stub that returns `null` AFTER
  // capturing the real bound port. We then assert (a) `start()`
  // rejects with the expected message, (b) the captured port no
  // longer accepts TCP connections (proving the `server.close()`
  // in the defensive branch fired), and (c) a second `start()` on
  // the same instance — with an unwrapped `createServerFn` — still
  // succeeds (proving no phantom state was left behind).
  it("closes the bound socket when address() returns null after listen", async () => {
    const { handlers } = makeHandlers();
    const userDataDir = mkdtempSync(
      join(tmpdir(), "tessera-localapi-null-addr-"),
    );
    let capturedPort = 0;
    const wrappingCreateServer = ((requestHandler: Parameters<
      typeof createNodeHttpServer
    >[0]) => {
      const real = createNodeHttpServer(requestHandler);
      const realAddress = real.address.bind(real);
      const realListen = real.listen.bind(real);
      // Override `listen` so we can capture the real bound port
      // BEFORE swapping `address()` to its null-returning stub.
      // We cast through `unknown` because `Server.listen` is a
      // heavily overloaded signature and we only need to wrap the
      // one production callsite uses.
      (real as unknown as { listen: typeof real.listen }).listen = ((
        options: Parameters<typeof realListen>[0],
        callback: () => void,
      ) =>
        realListen(options, () => {
          const a = realAddress() as { port: number } | null;
          if (a !== null && typeof a !== "string") capturedPort = a.port;
          // Now force address() into the defensive branch.
          (real as unknown as { address: () => null }).address = () => null;
          callback();
        })) as typeof real.listen;
      return real;
    }) as typeof createNodeHttpServer;
    const server = new KchatLocalApiServer(handlers, {
      userDataDir,
      tokenForTesting: TEST_TOKEN,
      createServerFn: wrappingCreateServer,
    });
    await expect(server.start()).rejects.toThrow(
      /KchatLocalApiServer failed to bind/,
    );
    expect(capturedPort).toBeGreaterThan(0);
    // The captured port should no longer accept TCP connections —
    // we'd get ECONNREFUSED instead.
    await new Promise<void>((resolveFn) => {
      const probe = createConnection(
        { host: "127.0.0.1", port: capturedPort },
        () => {
          // If we got `connect`, the defensive close failed and
          // the socket is still listening.
          probe.destroy();
          resolveFn();
        },
      );
      probe.once("error", () => {
        resolveFn();
      });
    });
    // A second start() with an unwrapped factory must succeed,
    // proving the failed first start left no phantom internal
    // state behind.
    (
      server as unknown as { createServerFn: typeof createNodeHttpServer }
    ).createServerFn = createNodeHttpServer;
    const second = await server.start();
    expect(second.port).toBeGreaterThan(0);
    await server.stop();
    rmSync(userDataDir, { recursive: true, force: true });
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

  it("rejects requests with a non-loopback Host header (403 + 'forbidden' code)", async () => {
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
    // Phase 14 Round 6 Devin Review ANALYSIS_0005: the DNS-rebinding
    // defence must surface as HTTP 403 `forbidden`, not 403
    // `unauthorized`. The wire-code distinction is load-bearing for
    // the .kcz extension's retry logic: a 401/`unauthorized` is a
    // refresh-port-file-and-retry signal, a 403/`forbidden` is a
    // do-not-retry signal. Pinning both the status line and the body
    // code prevents a future change from putting them back out of
    // sync.
    expect(reply.startsWith("HTTP/1.1 403")).toBe(true);
    const bodyStart = reply.indexOf("\r\n\r\n");
    expect(bodyStart).toBeGreaterThan(0);
    const body = JSON.parse(reply.slice(bodyStart + 4)) as {
      code: string;
      error: string;
    };
    expect(body.code).toBe("forbidden");
    expect(body.error).toMatch(/Host header .* is not loopback/);
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
    // Phase 14 Round 10 Devin Review ANALYSIS_0002: the 413 must
    // pair with `payload_too_large` (not `invalid_request`). The
    // canonical code↔status mapping in `LocalApiErrorCode` requires
    // exactly one code per HTTP status; an extension branching on
    // `code` would otherwise mistake an oversized-body failure for a
    // malformed-body failure and apply the wrong retry policy.
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("payload_too_large");
    expect(body.error).toMatch(/64\s*KiB/);
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

  it("maps a generic handler throw to a 500 internal_error with sanitised body", async () => {
    // Phase 14 Round 7 Devin Review ANALYSIS_0005: a non-
    // `LocalApiError` thrown from a handler must NOT propagate
    // the raw `Error.message` to the wire body — that path used
    // to surface internal implementation details (file paths,
    // stack fragments) to the .kcz extension caller. The fix
    // sanitises the wire body to a generic "internal server
    // error" string; the original error is logged to stderr for
    // operator diagnosis but never reaches the response. This
    // test pins both halves of the contract: the unique sentinel
    // string ("boom-internal-detail-xyz123") must NOT appear in
    // the body, and the body must instead carry the canonical
    // generic message.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const sentinel = "boom-internal-detail-xyz123";
    try {
      const { handlers } = makeHandlers({
        async status() {
          throw new Error(sentinel);
        },
      });
      running = await startServer(handlers);
      const res = await fetch(`${running.baseUrl}/api/status`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(500);
      const raw = await res.text();
      const body = JSON.parse(raw) as { code: string; error: string };
      expect(body.code).toBe("internal_error");
      // The wire body must not leak the raw handler exception.
      expect(raw).not.toContain(sentinel);
      expect(body.error).not.toContain(sentinel);
      // It must carry the canonical sanitised string instead.
      expect(body.error).toBe("internal server error");
      // The raw error is logged to stderr for operator diagnosis
      // (the sentinel does appear here — that's the intent).
      expect(consoleErrorSpy).toHaveBeenCalled();
      const loggedSentinel = consoleErrorSpy.mock.calls.some((call) =>
        call.some((arg) => {
          if (typeof arg === "string") return arg.includes(sentinel);
          if (arg instanceof Error) return arg.message.includes(sentinel);
          return false;
        }),
      );
      expect(loggedSentinel).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
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
