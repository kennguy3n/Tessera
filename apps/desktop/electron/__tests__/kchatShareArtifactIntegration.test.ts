/**
 * End-to-end integration test for `kchat:shareArtifact` with the
 * evidence-pack option (Phase 13 Theme 2 Task 12).
 *
 * The existing `kchat:shareArtifact` test coverage in
 * `kchatIpc.test.ts` mocks `KchatClient` directly — every test in
 * that file replaces `clientMock.uploadFile` with a `vi.fn()` and
 * asserts the call arguments. That coverage is sufficient for
 * verifying the handler's *call shape* (audit / partial-failure /
 * call ordering invariants), but it does NOT exercise the path
 * where the real `KchatClient.uploadFile()` builds a multipart
 * body, opens a TCP connection, sends the bytes, and parses the
 * server response.
 *
 * This file fills that gap. It stands up a localhost Node HTTP
 * server that imitates the KChat `/api/v4/files` upload endpoint
 * (multipart parse + canned success response), constructs a REAL
 * `KchatClient` instance pointed at that server, and exercises the
 * full `kchat:shareArtifact` IPC handler path:
 *
 *   handler
 *     → produceExportBytes (real Markdown export bytes)
 *     → KchatClient.uploadFile (REAL multipart wire-format)
 *     → localhost server (REAL TCP, REAL HTTP)
 *     → response parsed back into `KchatFileInfo`
 *     → bridge.bridgeEvidencePackBytes (REAL ZIP-magic bytes)
 *     → KchatClient.uploadFile a second time (REAL multipart)
 *     → server receives both bodies in the documented order
 *     → bridge.bridgeLogKchatArtifactShared audit row
 *
 * What the test asserts (beyond what the mocked-client tests do):
 *
 *   1. Both uploads actually traverse the network stack. The
 *      server's request log records exactly two POSTs to
 *      `/api/v4/files`, in the documented order (primary first,
 *      evidence pack second).
 *   2. Each request carries a `multipart/form-data; boundary=...`
 *      Content-Type with a matching boundary in the body — the
 *      hand-rolled multipart formatter in `KchatClient.uploadFile`
 *      survives a real `req.headers` round-trip.
 *   3. Each request body includes the `channel_id` form field
 *      bound to the channel id the handler resolved.
 *   4. Each request body contains a `files` part with the right
 *      `filename="..."` and `Content-Type:` header. The primary
 *      file lands as `<title>.md` with `text/markdown; charset=
 *      utf-8`; the evidence pack lands as `<title>-evidence.zip`
 *      with `application/zip`. The base name matches between the
 *      two.
 *   5. The primary file's payload contains the exact bytes the
 *      bridge returned for the markdown export.
 *   6. The evidence pack's payload contains the exact bytes the
 *      bridge returned from `bridgeEvidencePackBytes` (verified by
 *      hashing both sides — defends against silent truncation in
 *      the multipart concat path under large payloads).
 *   7. Each request carries the bearer token in `Authorization`
 *      (the audit + auth posture is preserved over the wire, not
 *      lost in a mock-skipped path).
 *
 * The native Rust bridge is mocked (same reason as
 * `kchatIpc.test.ts` — the addon is built per platform and is not
 * loadable in vitest). The bridge mock exposes the exact surface
 * the handler reads from: `bridgeGetArtifact`,
 * `bridgeExportArtifact`, `bridgeEvidencePackBytes`, and
 * `bridgeLogKchatArtifactShared`.
 *
 * The Rate Limiter is replaced with a fresh instance per test (the
 * default module-level limiter would leak token-bucket state
 * across tests).
 *
 * SSRF: the integration test deliberately points at
 * `http://127.0.0.1:<port>` which is loopback. The handler under
 * test (`kchat:shareArtifact`) does NOT re-validate the server URL
 * — that gate lives upstream in `KchatAuthService.connect()`.
 * Since we wire a pre-constructed `KchatClient` directly via the
 * `serviceMock`, no SSRF check fires in this test path. That is
 * the correct posture: production code paths reach this handler
 * only after `connect()` has accepted the URL once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as http from "http";
import * as crypto from "crypto";
import { AddressInfo } from "net";

// ---------- Electron + appState mocks (same shape as kchatIpc.test.ts) ----------

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  app: {
    getPath: () => "/tmp",
    getAppPath: () => "/tmp",
  },
  BrowserWindow: {
    fromWebContents: () => null,
  },
}));

// The evidence-pack bytes are arbitrary opaque payload from the
// renderer's perspective — what matters is that whatever bytes the
// bridge returns ALSO appear on the server side. We seed with a
// distinctive run-unique buffer so the assertion side can match
// exactly (and a future refactor that introduces accidental
// duplication / truncation / encoding-mangling will fail this
// test).
const EVIDENCE_PACK_PAYLOAD = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]), // ZIP local-file-header magic
  crypto.randomBytes(2048), // simulate a non-trivially-sized pack
]);

const MARKDOWN_PAYLOAD = "# Integration Test Artifact\n\nBody.\n";

const bridgeMock = {
  bridgeGetArtifact: vi.fn(() => ({ title: "Integration Test Artifact" })),
  bridgeExportArtifact: vi.fn(() => ({
    content: MARKDOWN_PAYLOAD,
    format: "markdown",
  })),
  bridgeExportArtifactToFile: vi.fn(),
  bridgeEvidencePackBytes: vi.fn(() => EVIDENCE_PACK_PAYLOAD),
  bridgeLogKchatArtifactShared: vi.fn(),
  // The handler only touches the four bridge methods above for
  // the share path. The other slots are mounted as no-ops so the
  // bridge surface type-checks against the production
  // `NativeBridge` shape consumed by the appState mock.
  bridgeAddKchatChannel: vi.fn(),
  bridgeLogKchatConnected: vi.fn(),
  bridgeLogKchatDisconnected: vi.fn(),
  bridgeLogKchatChannelLinked: vi.fn(),
  bridgeLogKchatChannelUnlinked: vi.fn(),
  bridgeLogKchatFileDownloaded: vi.fn(),
  bridgeLogKchatFileEventReceived: vi.fn(),
  bridgeIsKchatChannelLinked: vi.fn(() => false),
  bridgeIndexKchatFile: vi.fn(() => ({
    wasLinked: false,
    indexed: false,
    sourceId: "",
  })),
  bridgeSetKchatPrincipal: vi.fn(),
  bridgeClearKchatPrincipal: vi.fn(),
  bridgeRefreshKchatAcl: vi.fn(() => ({
    outcome: "granted" as const,
    memberCount: 0,
    revocations: [] as Array<{ sourceId: string }>,
  })),
  bridgeRevokeKchatSource: vi.fn(),
  bridgeIngestKchatPosts: vi.fn(),
  bridgeIngestKchatPostsCount: vi.fn(() => 0),
  bridgeIsKchatChannelSourceActive: vi.fn(() => true),
  bridgeMarkKchatChannelBackfillCompleted: vi.fn(),
  bridgeGetKchatChannelBackfillStatus: vi.fn(() => null),
  bridgeLogKchatBackfillStarted: vi.fn(),
  bridgeLogKchatBackfillPageIngested: vi.fn(),
  bridgeLogKchatBackfillCompleted: vi.fn(),
};

// Service stub: returns a real `KchatClient` instance configured
// against the local test HTTP server. The instance is created
// inside `beforeEach` after the server is listening.
let liveClient: import("../kchat/kchatClient").KchatClient | null = null;
const serviceMock = {
  getClient: () => {
    if (!liveClient) {
      throw new Error(
        "Integration-test KchatClient was not initialised — beforeEach should have wired it.",
      );
    }
    return liveClient;
  },
  getState: vi.fn(),
  onStatusChange: vi.fn(() => () => {}),
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock("../appState", () => ({
  getBridge: () => bridgeMock,
  getKchatAuthService: () => serviceMock,
  setKchatChannelResyncImpl: vi.fn(),
  setKchatBackfillImpl: vi.fn(),
}));

import { registerKchatHandlers } from "../ipc/kchat";
import { KchatClient } from "../kchat/kchatClient";
import { RateLimiter } from "../ipc/rateLimiter";

function handler(channel: string) {
  const c = handleMock.mock.calls.find((x) => x[0] === channel);
  if (!c) throw new Error(`No handler registered for ${channel}`);
  return c[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

const EVENT = { sender: { id: 1 } } as unknown;

// ---------- Local HTTP server (KChat /api/v4/files imitation) ----------

interface CapturedUpload {
  method: string;
  url: string;
  contentType: string | undefined;
  authorization: string | undefined;
  rawBody: Buffer;
}

interface UploadServer {
  url: string; // e.g. http://127.0.0.1:51234
  uploads: CapturedUpload[];
  close: () => Promise<void>;
}

async function startUploadServer(): Promise<UploadServer> {
  const uploads: CapturedUpload[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      uploads.push({
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: req.headers["content-type"],
        authorization: req.headers["authorization"],
        rawBody,
      });
      // KChat-shaped upload response. The handler reads
      // `file_infos[0].{id,name}` from this payload.
      const idx = uploads.length;
      const responseBody = JSON.stringify({
        file_infos: [
          {
            id: `fid${String(idx).padStart(23, "0")}`,
            name: extractFilenameFromMultipart(rawBody) ?? `file-${idx}`,
            user_id: "u".repeat(26),
            size: rawBody.length,
            mime_type: "application/octet-stream",
            extension: "bin",
            create_at: 0,
          },
        ],
      });
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Length", Buffer.byteLength(responseBody));
      res.end(responseBody);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    uploads,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

/**
 * Multipart helpers — minimal RFC-2046 parsing scoped to what the
 * KChat-shaped uploader produces. We do NOT pull in a parser
 * dependency; that would defeat the integration goal of verifying
 * the bytes the production code emits without rewriting them.
 */
function extractBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  // Phase 13 Theme 2 Task 13 — Devin Review pass 2 ANALYSIS_0005:
  // position-independent so a future `KchatClient.uploadFile` that
  // appends additional Content-Type parameters (e.g. `charset`)
  // does not silently fail the test with a confusing "boundary is
  // null" error. RFC 7231 §3.1.1.1 allows boundary to appear at any
  // position within the parameter list.
  const m = /(?:^|;\s*)boundary=([^;]+)/i.exec(contentType);
  return m ? m[1].trim() : null;
}

function extractFilenameFromMultipart(body: Buffer): string | null {
  // Search for the literal `filename="..."` substring. Filenames
  // are URI-encoded so they cannot contain a real `"`.
  const s = body.toString("latin1");
  const m = /filename="([^"]+)"/.exec(s);
  return m ? decodeURIComponent(m[1]) : null;
}

interface MultipartPart {
  headers: Record<string, string>;
  body: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const open = Buffer.from(`--${boundary}\r\n`, "latin1");
  const close = Buffer.from(`\r\n--${boundary}--\r\n`, "latin1");
  const sep = Buffer.from(`\r\n--${boundary}\r\n`, "latin1");
  // Strip the closing delimiter, then walk the parts.
  const endIdx = body.indexOf(close);
  if (endIdx < 0) {
    throw new Error("multipart body missing closing boundary");
  }
  const inner = body.subarray(0, endIdx);
  // First part starts right after `--boundary\r\n`; subsequent
  // parts are separated by `\r\n--boundary\r\n`.
  if (inner.indexOf(open) !== 0) {
    throw new Error("multipart body missing opening boundary");
  }
  const afterFirstOpen = inner.subarray(open.length);
  const partsRaw: Buffer[] = [];
  let cursor = 0;
  while (cursor < afterFirstOpen.length) {
    const nextSep = afterFirstOpen.indexOf(sep, cursor);
    if (nextSep < 0) {
      partsRaw.push(afterFirstOpen.subarray(cursor));
      break;
    }
    partsRaw.push(afterFirstOpen.subarray(cursor, nextSep));
    cursor = nextSep + sep.length;
  }
  return partsRaw.map((part) => {
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n", "latin1"));
    if (headerEnd < 0) {
      throw new Error("multipart part missing header/body separator");
    }
    const headerBlock = part.subarray(0, headerEnd).toString("latin1");
    const partBody = part.subarray(headerEnd + 4);
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      headers[line.slice(0, colon).trim().toLowerCase()] = line
        .slice(colon + 1)
        .trim();
    }
    return { headers, body: partBody };
  });
}

function extractFormField(part: MultipartPart): string {
  // `Content-Disposition: form-data; name="channel_id"` for the
  // first part; the value is the part body verbatim (no
  // transfer-encoding applied by the uploader).
  return part.body.toString("utf-8");
}

function sha256(b: Buffer): string {
  return crypto.createHash("sha256").update(b).digest("hex");
}

// ---------- Test scaffolding ----------

let server: UploadServer | null = null;

beforeEach(async () => {
  handleMock.mockReset();
  removeHandlerMock.mockReset();
  for (const fn of Object.values(bridgeMock)) {
    (fn as ReturnType<typeof vi.fn>).mockClear?.();
  }
  bridgeMock.bridgeGetArtifact.mockReturnValue({
    title: "Integration Test Artifact",
  });
  bridgeMock.bridgeExportArtifact.mockReturnValue({
    content: MARKDOWN_PAYLOAD,
    format: "markdown",
  });
  bridgeMock.bridgeEvidencePackBytes.mockReturnValue(EVIDENCE_PACK_PAYLOAD);

  server = await startUploadServer();

  // Fresh `KchatClient` per test so the upload-rate-limiter
  // bucket does not leak across cases. The token here is opaque
  // — the test server does NOT verify it; we only assert it was
  // sent on the wire.
  liveClient = new KchatClient({
    rateLimiter: new RateLimiter(),
  });
  liveClient.setServerUrl(server.url);
  liveClient.setToken("test-pat-token-do-not-use-in-prod");

  registerKchatHandlers();
});

afterEach(async () => {
  if (server) {
    await server.close();
    server = null;
  }
  liveClient = null;
});

// ---------- The integration test ----------

describe("kchat:shareArtifact — end-to-end evidence-pack upload (integration)", () => {
  it("uploads primary export AND evidence pack over real HTTP to a mocked KChat server", async () => {
    if (!server) throw new Error("test setup did not start the server");

    const artifactId = "550e8400-e29b-41d4-a716-446655440000";
    const channelId = "chid0000000000000000abcd";

    const result = await handler("kchat:shareArtifact")(
      EVENT,
      artifactId,
      channelId,
      "markdown",
      true, // includeCitations — threaded through the bridge
      true, // includeEvidencePack — triggers the second upload
    );

    // ---- 1. Both uploads traversed the network ----
    expect(server.uploads).toHaveLength(2);
    expect(server.uploads[0].method).toBe("POST");
    expect(server.uploads[0].url).toBe("/api/v4/files");
    expect(server.uploads[1].method).toBe("POST");
    expect(server.uploads[1].url).toBe("/api/v4/files");

    // ---- 2. Multipart Content-Type + matching boundary ----
    const ct0 = server.uploads[0].contentType;
    const ct1 = server.uploads[1].contentType;
    // Header starts with `multipart/form-data` + at least one
    // `boundary=` parameter (any position). Matches `extractBoundary`
    // semantics so the two assertions stay symmetric.
    expect(ct0).toMatch(/^multipart\/form-data\s*;.*\bboundary=/i);
    expect(ct1).toMatch(/^multipart\/form-data\s*;.*\bboundary=/i);
    const boundary0 = extractBoundary(ct0);
    const boundary1 = extractBoundary(ct1);
    expect(boundary0).not.toBeNull();
    expect(boundary1).not.toBeNull();
    // Each upload uses a freshly generated boundary; pin the
    // distinctness so a future change that caches the boundary
    // (e.g. caches at the client level, opening up a multipart
    // confusion attack across concurrent uploads) fails the test.
    expect(boundary0).not.toBe(boundary1);

    // ---- 3. & 4. channel_id field + files part with right name ----
    const primaryParts = parseMultipart(
      server.uploads[0].rawBody,
      boundary0 as string,
    );
    const evidenceParts = parseMultipart(
      server.uploads[1].rawBody,
      boundary1 as string,
    );

    // Each upload has exactly two parts: channel_id + files.
    expect(primaryParts).toHaveLength(2);
    expect(evidenceParts).toHaveLength(2);

    // channel_id field (first part of each upload).
    expect(primaryParts[0].headers["content-disposition"]).toContain(
      'name="channel_id"',
    );
    expect(extractFormField(primaryParts[0])).toBe(channelId);
    expect(evidenceParts[0].headers["content-disposition"]).toContain(
      'name="channel_id"',
    );
    expect(extractFormField(evidenceParts[0])).toBe(channelId);

    // files field — primary file uses sanitised artifact title +
    // `.md` extension and `text/markdown; charset=utf-8` Content-Type.
    const primaryFilesPart = primaryParts[1];
    const evidenceFilesPart = evidenceParts[1];
    expect(primaryFilesPart.headers["content-disposition"]).toContain(
      'name="files"',
    );
    expect(evidenceFilesPart.headers["content-disposition"]).toContain(
      'name="files"',
    );
    // Filename is URL-encoded on the wire — round-trip through
    // `decodeURIComponent` for assertion.
    const primaryFilename = decodeURIComponent(
      /filename="([^"]+)"/.exec(
        primaryFilesPart.headers["content-disposition"],
      )?.[1] ?? "",
    );
    const evidenceFilename = decodeURIComponent(
      /filename="([^"]+)"/.exec(
        evidenceFilesPart.headers["content-disposition"],
      )?.[1] ?? "",
    );
    expect(primaryFilename).toBe("Integration-Test-Artifact.md");
    expect(evidenceFilename).toBe("Integration-Test-Artifact-evidence.zip");
    // The evidence-pack base name matches the primary base name
    // (load-bearing: operators correlate the two files in audit
    // by the shared prefix).
    expect(evidenceFilename.startsWith("Integration-Test-Artifact")).toBe(true);

    // Content-Type per part — exact match to `mimeForFormat` for
    // the primary and the hardcoded `application/zip` for the pack.
    expect(primaryFilesPart.headers["content-type"]).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(evidenceFilesPart.headers["content-type"]).toBe("application/zip");

    // ---- 5. Primary body bytes match the exported markdown ----
    expect(primaryFilesPart.body.toString("utf-8")).toBe(MARKDOWN_PAYLOAD);

    // ---- 6. Evidence-pack body bytes hash-match the bridge output ----
    expect(sha256(evidenceFilesPart.body)).toBe(sha256(EVIDENCE_PACK_PAYLOAD));
    expect(evidenceFilesPart.body.length).toBe(EVIDENCE_PACK_PAYLOAD.length);

    // ---- 7. Authorization bearer token on both requests ----
    expect(server.uploads[0].authorization).toBe(
      "Bearer test-pat-token-do-not-use-in-prod",
    );
    expect(server.uploads[1].authorization).toBe(
      "Bearer test-pat-token-do-not-use-in-prod",
    );

    // ---- Bridge audit row emitted exactly once with the
    //      actual on-channel evidence outcome (`true` here) ----
    expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledWith(
      artifactId,
      channelId,
      "markdown",
      true, // wantCitations
      true, // evidenceShared — both uploads succeeded over the wire
    );

    // Bridge content-producer calls landed exactly once each.
    expect(bridgeMock.bridgeExportArtifact).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeEvidencePackBytes).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeEvidencePackBytes).toHaveBeenCalledWith(artifactId);

    // Handler returns the PRIMARY file's id and name (the pack's
    // file id is intentionally not surfaced — the renderer's
    // success toast points at the primary, the audit row covers
    // the pack).
    expect(result).toEqual({
      fileId: "fid00000000000000000000001",
      fileName: "Integration-Test-Artifact.md",
    });
  });

  it("audits evidenceShared=false when the primary succeeds but the pack upload fails over the wire", async () => {
    // Re-stand the server with a route that fails the SECOND
    // request only. This exercises the partial-failure invariant
    // (Sixth-pass Devin Review ANALYSIS_0007) over the real
    // network stack: a 500 on the pack upload must not cancel the
    // primary's audit row but must re-throw so the renderer
    // learns of the divergence.
    if (!server) throw new Error("test setup did not start the server");
    await server.close();
    server = null; // afterEach must not double-close.

    let callCount = 0;
    const partialServer = http.createServer((req, res) => {
      // Drain body so the connection completes cleanly before we
      // write the response — Node will otherwise reset the socket
      // and surface a different error class on the client side.
      req.on("data", () => {});
      req.on("end", () => {
        callCount += 1;
        if (callCount === 1) {
          const body = JSON.stringify({
            file_infos: [
              {
                id: "fidprimary00000000000abc",
                name: "Integration-Test-Artifact.md",
                user_id: "u".repeat(26),
                size: 1,
                mime_type: "text/markdown",
                extension: "md",
                create_at: 0,
              },
            ],
          });
          res.statusCode = 201;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Content-Length", Buffer.byteLength(body));
          res.end(body);
        } else {
          // Pack upload: server-side error. The handler must
          // re-throw so the renderer learns about the divergence.
          // Use 500 (non-retryable for uploads in
          // `NON_IDEMPOTENT_RETRYABLE_STATUSES`) so the test does
          // not depend on retry timing.
          const body = JSON.stringify({
            status_code: 500,
            message: "evidence-pack store offline",
          });
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Content-Length", Buffer.byteLength(body));
          res.end(body);
        }
      });
    });
    await new Promise<void>((resolve) =>
      partialServer.listen(0, "127.0.0.1", resolve),
    );
    const addr = partialServer.address() as AddressInfo;
    try {
      liveClient = new KchatClient({
        rateLimiter: new RateLimiter(),
      });
      liveClient.setServerUrl(`http://127.0.0.1:${addr.port}`);
      liveClient.setToken("test-pat-token-do-not-use-in-prod");
      // Re-register handlers so the closure binds against the
      // refreshed `serviceMock.getClient()` return value.
      handleMock.mockReset();
      registerKchatHandlers();

      await expect(
        handler("kchat:shareArtifact")(
          EVENT,
          "550e8400-e29b-41d4-a716-446655440000",
          "chid0000000000000000abcd",
          "markdown",
          true,
          true,
        ),
      ).rejects.toThrow(/evidence-pack store offline|500|HTTP/);

      // Primary succeeded (callCount=1 was the primary; callCount
      // ended at 2 because the handler issued the pack upload
      // before learning it would fail).
      expect(callCount).toBe(2);

      // Audit row emitted exactly once, with the ACTUAL outcome:
      // evidenceShared=false even though the user requested true.
      expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledTimes(1);
      expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        "chid0000000000000000abcd",
        "markdown",
        true,
        false,
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        partialServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  it("does NOT audit anything when the primary upload itself fails over the wire", async () => {
    if (!server) throw new Error("test setup did not start the server");
    await server.close();
    server = null; // afterEach must not double-close.

    const failServer = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const body = JSON.stringify({
          status_code: 500,
          message: "primary upload backend down",
        });
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Length", Buffer.byteLength(body));
        res.end(body);
      });
    });
    await new Promise<void>((resolve) =>
      failServer.listen(0, "127.0.0.1", resolve),
    );
    const addr = failServer.address() as AddressInfo;
    try {
      liveClient = new KchatClient({
        rateLimiter: new RateLimiter(),
      });
      liveClient.setServerUrl(`http://127.0.0.1:${addr.port}`);
      liveClient.setToken("test-pat-token-do-not-use-in-prod");
      handleMock.mockReset();
      registerKchatHandlers();

      await expect(
        handler("kchat:shareArtifact")(
          EVENT,
          "550e8400-e29b-41d4-a716-446655440000",
          "chid0000000000000000abcd",
          "markdown",
          true,
          true,
        ),
      ).rejects.toThrow(/primary upload backend down|500|HTTP/);

      // Primary upload was attempted; pack upload was NOT (the
      // `if (wantEvidence)` branch is reached only on primary
      // success). The audit row is NOT emitted because the
      // channel is unchanged — emitting it would create a
      // phantom record (Sixth-pass Devin Review ANALYSIS_0007).
      expect(bridgeMock.bridgeLogKchatArtifactShared).not.toHaveBeenCalled();
      expect(bridgeMock.bridgeEvidencePackBytes).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        failServer.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
});
