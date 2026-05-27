/**
 * Tessera ↔ KChat Desktop extension localhost API.
 *
 * Phase 14 Task 2. Replaces the Phase 13 socket bridge (now removed)
 * with a minimal HTTP-over-loopback surface the `.kcz` extension
 * installed in KChat Desktop talks to. The wire format is identical
 * to the one declared in `extensions/tessera-kchat/src/types.ts`;
 * this module is the canonical implementation, and the extension is
 * the only caller we ship.
 *
 * Trust model:
 *
 *   - The server binds to `127.0.0.1` only — every other interface
 *     is rejected by the OS, not by an in-process check. The unit
 *     tests in `kchatLocalApi.test.ts` assert the bound address.
 *   - The bearer token is generated fresh on every server start
 *     (`crypto.randomBytes(32)` → base64url), persisted only into
 *     `{userData}/tessera-kchat-port.json` (mode 0600), and never
 *     leaves the local machine. Token comparison is timing-safe.
 *   - Every request first runs through `validateHostHeader()`,
 *     which accepts only `127.0.0.1[:<port>]` — a DNS-rebinding
 *     defence so an attacker who smuggled a `Host: evil.example`
 *     header onto loopback (e.g. through a misconfigured proxy)
 *     gets a 403 instead of a route. The bound port is not
 *     enforced because multiple bound ports across restarts share
 *     the same security posture.
 *   - Authenticated routes additionally call `requireBearer()`,
 *     which performs a timing-safe comparison against the
 *     `Authorization: Bearer <token>` header. Failed comparisons
 *     never update the `lastExtensionContactMs` heartbeat, so a
 *     spamming attacker cannot keep the Settings card's "KChat
 *     Desktop detected" affordance pinned green.
 *   - Every state-changing route requires `Content-Type:
 *     application/json` and rejects payloads larger than 64 KiB,
 *     matching the rate-limiter profile in `ipc/rateLimiter.ts`.
 *
 * The server is otherwise inert: it owns no state machine, no
 * timers, no keep-alive sockets. Requests are dispatched to
 * `LocalApiHandlers` — the orchestrator caller (
 * `electron/ipc/kchat.ts`) supplies the implementation, so this
 * module stays decoupled from the rest of the KChat surface and
 * tests can wire in fakes.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

/** Maximum size of a POST body the server will accept (64 KiB). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Filename of the discovery file under `{userData}`. */
export const PORT_FILE_NAME = "tessera-kchat-port.json";

/** Capability strings advertised in `/api/status`. */
export const LOCAL_API_CAPABILITIES: readonly string[] = [
  "status",
  "list_sources",
  "ingest_channel",
  "share_artifact",
];

export interface TesseraKchatSourceRow {
  sourceId: string;
  kind: "kchat-channel" | "kchat-thread";
  channelId: string;
  channelName: string;
  teamId: string | null;
  state: "idle" | "ingesting" | "ready" | "error";
  lastSyncedAt: string | null;
  errorMessage: string | null;
  tesseraDeeplink: string;
}

export interface LocalApiStatus {
  tesseraVersion: string;
  connected: boolean;
  serverUrl: string | null;
  indexedChannelCount: number;
  lastEventAt: string | null;
  capabilities: readonly string[];
}

export interface IngestChannelRequest {
  channelId: string;
  teamId?: string;
  channelName: string;
}

export interface IngestChannelResponse {
  sourceId: string;
  state: TesseraKchatSourceRow["state"];
}

export interface ShareArtifactRequest {
  artifactId: string;
  channelId: string;
  message?: string;
  includeEvidence?: boolean;
}

export interface ShareArtifactResponse {
  shareId: string;
  postId: string | null;
  permalink: string | null;
}

/**
 * Wire-level error codes returned in the JSON body of every non-2xx
 * response. Each code is paired with a single canonical HTTP status:
 *
 *   - `unauthorized`        → 401. The bearer token is missing or
 *                              does not match. RFC 9110 §15.5.2.
 *   - `forbidden`           → 403. The bearer token is fine, but the
 *                              request is rejected on a separate
 *                              policy grounds (currently: the `Host`
 *                              header is not loopback, which is a
 *                              DNS-rebinding defence). RFC 9110
 *                              §15.5.4.
 *   - `invalid_request`     → 400. The request payload, headers, or
 *                              URL is malformed.
 *   - `not_found`           → 404. The route does not exist or the
 *                              referenced resource is unknown.
 *   - `rate_limited`        → 429. (Reserved; not currently emitted.)
 *   - `internal_error`      → 500. Uncaught exception in a handler.
 *   - `tessera_unavailable` → 503. A handler slot has not been wired
 *                              yet (e.g. Tessera is starting up or
 *                              the orchestrator has not registered
 *                              its concrete handlers).
 *
 * The split between `unauthorized` (401) and `forbidden` (403) is
 * load-bearing: the .kcz extension may legitimately treat a 401 as
 * "my token is stale, refresh the port file" but must treat a 403
 * as "the host rejected this request on policy grounds; do not retry".
 */
export type LocalApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "rate_limited"
  | "internal_error"
  | "tessera_unavailable";

export class LocalApiError extends Error {
  override readonly name = "LocalApiError";
  constructor(
    public readonly status: number,
    public readonly code: LocalApiErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Behaviour the orchestrator supplies. Each method is async and
 * may throw `LocalApiError` to surface a typed error envelope.
 */
export interface LocalApiHandlers {
  status(): Promise<LocalApiStatus>;
  listSources(): Promise<readonly TesseraKchatSourceRow[]>;
  ingestChannel(req: IngestChannelRequest): Promise<IngestChannelResponse>;
  shareArtifact(req: ShareArtifactRequest): Promise<ShareArtifactResponse>;
}

export interface LocalApiServerOptions {
  /** Absolute path of the Electron userData directory. */
  userDataDir: string;
  /** Process id written into the port file (default `process.pid`). */
  pid?: number;
  /** Override server factory (tests). Default `node:http.createServer`. */
  createServerFn?: typeof createServer;
  /** Inject a bearer token (tests). Default = random 32 bytes. */
  tokenForTesting?: string;
  /** Override file-write hook (tests). */
  fsWriter?: PortFileWriter;
  /** Inject a clock (tests). Default `Date.now`. */
  nowMsForTesting?: () => number;
}

export interface PortFileWriter {
  writeAtomic(path: string, contents: string): void;
  unlink(path: string): void;
}

const DEFAULT_FS_WRITER: PortFileWriter = {
  writeAtomic(path, contents) {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // POSIX-only chmod; on Windows the umask covers it.
    }
    renameSync(tmp, path);
  },
  unlink(path) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort cleanup; the next start overwrites the file.
    }
  },
};

/**
 * Loopback HTTP server. Constructed once per Electron main-process
 * lifetime; `start()` returns the bound port and writes the
 * discovery file. `stop()` removes the file and closes the server.
 */
export class KchatLocalApiServer {
  private readonly handlers: LocalApiHandlers;
  private readonly userDataDir: string;
  private readonly token: string;
  private readonly pid: number;
  private readonly fsWriter: PortFileWriter;
  private readonly createServerFn: typeof createServer;
  private server: Server | null = null;
  private boundPort: number | null = null;
  private portFileAbsPath: string | null = null;
  /**
   * Monotonic-millisecond timestamp (via `Date.now()`) of the
   * most recent successful authenticated request from the .kcz
   * extension. `null` until the extension has been heard from at
   * least once since this process started. Used by
   * `snapshotForRenderer()` so the Settings card can show the
   * "KChat Desktop detected" affordance without polling KChat
   * Desktop.
   */
  private lastExtensionContactMs: number | null = null;
  /** Injected clock for tests; defaults to `Date.now`. */
  private readonly nowMs: () => number;

  constructor(handlers: LocalApiHandlers, opts: LocalApiServerOptions) {
    this.handlers = handlers;
    this.userDataDir = opts.userDataDir;
    this.pid = opts.pid ?? process.pid;
    this.fsWriter = opts.fsWriter ?? DEFAULT_FS_WRITER;
    this.createServerFn = opts.createServerFn ?? createServer;
    this.nowMs = opts.nowMsForTesting ?? (() => Date.now());
    if (opts.tokenForTesting !== undefined) {
      if (opts.tokenForTesting.length < 32) {
        throw new Error(
          "tokenForTesting must be at least 32 characters",
        );
      }
      this.token = opts.tokenForTesting;
    } else {
      this.token = randomBytes(32).toString("base64url");
    }
  }

  /** Absolute path the discovery file will be written to. */
  portFilePath(): string {
    if (this.portFileAbsPath !== null) return this.portFileAbsPath;
    return resolvePath(this.userDataDir, PORT_FILE_NAME);
  }

  /** The bearer token — exposed for tests only. */
  tokenForTests(): string {
    return this.token;
  }

  /** Currently bound port, or `null` while stopped. */
  port(): number | null {
    return this.boundPort;
  }

  /**
   * Renderer-facing projection used by the Settings card. The
   * `lastExtensionContactAt` field is the wall-clock ISO-8601
   * stamp of the heartbeat recorded by `requireBearer()`; the
   * Settings card decides on freshness via its own clock.
   */
  snapshotForRenderer(): {
    apiServerRunning: boolean;
    apiServerPort: number | null;
    portFilePath: string | null;
    lastExtensionContactAt: string | null;
  } {
    return {
      apiServerRunning: this.server !== null,
      apiServerPort: this.boundPort,
      portFilePath: this.portFileAbsPath,
      lastExtensionContactAt:
        this.lastExtensionContactMs === null
          ? null
          : new Date(this.lastExtensionContactMs).toISOString(),
    };
  }

  async start(): Promise<{ port: number; token: string }> {
    if (this.server !== null) {
      throw new Error("KchatLocalApiServer.start called twice");
    }
    const server = this.createServerFn((req, res) => {
      this.dispatch(req, res).catch((err) => {
        respondError(
          res,
          new LocalApiError(
            500,
            "internal_error",
            err instanceof Error ? err.message : String(err),
          ),
        );
      });
    });
    server.maxConnections = 16;
    server.keepAliveTimeout = 1_500;
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    await new Promise<void>((resolveFn, rejectFn) => {
      server.once("error", rejectFn);
      // Bind to 127.0.0.1 explicitly. Passing the literal string is
      // load-bearing: `listen(0)` without a host argument resolves
      // to `0.0.0.0` on Linux, which would expose the server on the
      // LAN. Test asserts the bound address.
      server.listen({ host: "127.0.0.1", port: 0 }, () => {
        server.removeListener("error", rejectFn);
        resolveFn();
      });
    });
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === "string") {
      throw new Error("KchatLocalApiServer failed to bind");
    }
    if (address.address !== "127.0.0.1") {
      // Defence in depth: the listen() call already requested
      // 127.0.0.1, but some runtimes resolve "localhost" to
      // a wildcard address in unusual configurations.
      server.close();
      throw new Error(
        `KchatLocalApiServer bound to ${address.address}, expected 127.0.0.1`,
      );
    }
    this.server = server;
    this.boundPort = address.port;
    this.portFileAbsPath = resolvePath(this.userDataDir, PORT_FILE_NAME);
    const portFileContents = JSON.stringify(
      {
        version: 1,
        host: "127.0.0.1",
        port: address.port,
        token: this.token,
        startedAt: new Date().toISOString(),
        pid: this.pid,
      },
      null,
      2,
    );
    this.fsWriter.writeAtomic(this.portFileAbsPath, portFileContents);
    return { port: address.port, token: this.token };
  }

  async stop(): Promise<void> {
    if (this.portFileAbsPath !== null) {
      this.fsWriter.unlink(this.portFileAbsPath);
      this.portFileAbsPath = null;
    }
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    await new Promise<void>((resolveFn) => {
      server.close(() => resolveFn());
    });
  }

  private async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      if (!req.url) {
        throw new LocalApiError(400, "invalid_request", "missing URL");
      }
      this.validateHostHeader(req);
      const path = (req.url.split("?", 1)[0] ?? "").trim();
      if (req.method === "GET" && path === "/api/status") {
        this.requireBearer(req);
        const value = await this.handlers.status();
        respond(res, 200, value);
        return;
      }
      if (req.method === "GET" && path === "/api/sources") {
        this.requireBearer(req);
        const value = await this.handlers.listSources();
        respond(res, 200, value);
        return;
      }
      if (req.method === "POST" && path === "/api/ingest-channel") {
        this.requireBearer(req);
        const body = await readJsonBody<IngestChannelRequest>(req);
        validateIngestChannelRequest(body);
        const value = await this.handlers.ingestChannel(body);
        respond(res, 200, value);
        return;
      }
      if (req.method === "POST" && path === "/api/share-artifact") {
        this.requireBearer(req);
        const body = await readJsonBody<ShareArtifactRequest>(req);
        validateShareArtifactRequest(body);
        const value = await this.handlers.shareArtifact(body);
        respond(res, 200, value);
        return;
      }
      throw new LocalApiError(404, "not_found", "route not found");
    } catch (err) {
      respondError(
        res,
        err instanceof LocalApiError
          ? err
          : new LocalApiError(
              500,
              "internal_error",
              err instanceof Error ? err.message : String(err),
            ),
      );
    }
  }

  private validateHostHeader(req: IncomingMessage): void {
    const host = req.headers.host;
    if (!host) {
      throw new LocalApiError(
        400,
        "invalid_request",
        "missing Host header",
      );
    }
    // Allow only `127.0.0.1:<port>` to defeat DNS-rebinding attacks
    // that swing a public hostname onto loopback. The bound port is
    // not enforced here — multiple bound ports across restarts share
    // the same security posture.
    //
    // The wire-format error code is `forbidden`, not `unauthorized`:
    // the request HAS a bearer token (or could acquire one), but is
    // rejected on a separate policy grounds (the Host header). The
    // distinction matters for the .kcz extension's retry logic — a
    // 401 `unauthorized` is a "refresh the port file and retry"
    // signal, whereas a 403 `forbidden` is a "this transport is
    // structurally blocked; do not retry". Aligning the HTTP status
    // and the error code keeps that signal coherent (see
    // `LocalApiErrorCode` jsdoc above for the canonical mapping).
    const match = /^127\.0\.0\.1(?::(\d+))?$/.exec(host);
    if (!match) {
      throw new LocalApiError(
        403,
        "forbidden",
        `Host header ${JSON.stringify(host)} is not loopback`,
      );
    }
  }

  private requireBearer(req: IncomingMessage): void {
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new LocalApiError(
        401,
        "unauthorized",
        "missing bearer token",
      );
    }
    const provided = header.slice("Bearer ".length).trim();
    const expected = this.token;
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new LocalApiError(
        401,
        "unauthorized",
        "invalid bearer token",
      );
    }
    // Record the heartbeat AFTER the constant-time comparison so a
    // failed-auth attempt cannot move the timestamp forward. The
    // Settings card uses this to know whether the .kcz extension
    // is alive on the other side.
    this.lastExtensionContactMs = this.nowMs();
  }
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const contentType = req.headers["content-type"] ?? "";
  // Accept ONLY `application/json` (optionally followed by whitespace
  // and `;parameters`). The previous `^application\/json(\b|;)`
  // pattern matched `application/json-ld`, `application/json-patch+json`,
  // etc. because `\b` matches between `n` and `-` (the hyphen is a
  // non-word character). The .kcz extension we ship only sends
  // `application/json`, so a stricter check has no behavioural cost
  // and closes the door on a future caller (or a stray proxy) sneaking
  // in a sibling JSON-family subtype the rest of `readJsonBody`
  // doesn't actually parse.
  if (!/^application\/json(?:\s*$|\s*;)/i.test(contentType)) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "Content-Type must be application/json",
    );
  }
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf =
      chunk instanceof Buffer
        ? chunk
        : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new LocalApiError(
        413,
        "invalid_request",
        "request body exceeds 64 KiB",
      );
    }
    chunks.push(buf);
  }
  if (total === 0) {
    throw new LocalApiError(400, "invalid_request", "empty body");
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new LocalApiError(
      400,
      "invalid_request",
      `body is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function validateIngestChannelRequest(
  body: IngestChannelRequest,
): void {
  if (!body || typeof body !== "object") {
    throw new LocalApiError(400, "invalid_request", "body must be an object");
  }
  if (typeof body.channelId !== "string" || body.channelId.length === 0) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "channelId is required",
    );
  }
  if (
    typeof body.channelName !== "string" ||
    body.channelName.length === 0 ||
    body.channelName.length > 256
  ) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "channelName is required (max 256 chars)",
    );
  }
  if (
    body.teamId !== undefined &&
    (typeof body.teamId !== "string" || body.teamId.length === 0)
  ) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "teamId must be a non-empty string when present",
    );
  }
}

function validateShareArtifactRequest(body: ShareArtifactRequest): void {
  if (!body || typeof body !== "object") {
    throw new LocalApiError(400, "invalid_request", "body must be an object");
  }
  if (
    typeof body.artifactId !== "string" ||
    body.artifactId.length === 0
  ) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "artifactId is required",
    );
  }
  if (
    typeof body.channelId !== "string" ||
    body.channelId.length === 0
  ) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "channelId is required",
    );
  }
  if (
    body.message !== undefined &&
    (typeof body.message !== "string" || body.message.length > 8 * 1024)
  ) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "message must be a string (max 8 KiB) when present",
    );
  }
  if (
    body.includeEvidence !== undefined &&
    typeof body.includeEvidence !== "boolean"
  ) {
    throw new LocalApiError(
      400,
      "invalid_request",
      "includeEvidence must be a boolean when present",
    );
  }
}

function respond(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(payload.length),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function respondError(res: ServerResponse, err: LocalApiError): void {
  respond(res, err.status, { error: err.message, code: err.code });
}
