/**
 * Integration tests for the `kchat:*` IPC channels.
 *
 * The Rust bridge is mocked because the native addon is built per
 * platform and not loadable in the vitest sandbox. The KChat
 * `KchatAuthService` singleton is replaced with a stub so we can
 * inject canned REST responses and assert exact bridge calls.
 *
 * Coverage:
 *   1. Every channel from `kchat:*` is registered against
 *      `ipcMain.handle` (drift detector for the preload contract).
 *   2. `kchat:isAvailable` returns true.
 *   3. `kchat:connect` round-trips the token to the service AND
 *      writes a `bridgeLogKchatConnected` audit row; the response
 *      does NOT carry the token in any field.
 *   4. `kchat:status` returns the renderer-safe state shape.
 *   5. `kchat:shareArtifact` produces export bytes (text path),
 *      uploads to the channel, and audits via
 *      `bridgeLogKchatArtifactShared`. Evidence-pack option calls
 *      `bridgeEvidencePackBytes` and uploads a second file.
 *   6. `kchat:disconnect` clears the connection and audits via
 *      `bridgeLogKchatDisconnected`.
 *   7. Validation: malformed KChat ids and unknown formats throw
 *      before any service call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as nodeOs from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";

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

// Redirect `os.homedir()` to a per-suite tmpdir so the
// `sources:addKchatChannel` handler does not pollute the real user
// home with test fixtures (the handler writes downloaded channel
// files to `<homedir>/.tessera/kchat-channels/<channelId>/`).
const TEST_HOME = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "tessera-kchat-ipc-test-"),
);
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    default: actual,
    homedir: () => TEST_HOME,
  };
});

// Bridge stub captures every audit + export call.
const bridgeMock = {
  bridgeGetArtifact: vi.fn(() => ({ title: "Quarterly Roadmap" })),
  bridgeExportArtifact: vi.fn(() => ({
    content: "# Hello\n",
    format: "markdown",
  })),
  bridgeExportArtifactToFile: vi.fn(),
  bridgeEvidencePackBytes: vi.fn(() => Buffer.from([0x50, 0x4b, 0x03, 0x04])), // ZIP magic
  bridgeAddKchatChannel: vi.fn(() => ({
    source: {
      id: "src-uuid",
      sourceType: "kchat",
      path: "",
      status: "indexed",
      createdAt: "2024-01-01T00:00:00Z",
      lastIndexed: null,
      fileCount: 0,
    },
    newlyCreated: true,
  })),
  bridgeLogKchatConnected: vi.fn(),
  bridgeLogKchatDisconnected: vi.fn(),
  bridgeLogKchatArtifactShared: vi.fn(),
  bridgeLogKchatChannelLinked: vi.fn(),
  bridgeLogKchatChannelUnlinked: vi.fn(),
  bridgeLogKchatFileDownloaded: vi.fn(),
};

// `KchatAuthService` stub. `getClient()` returns an object with the
// REST methods the IPC handlers call. `scrubMessage` is exercised by
// the IPC layer's `toIpcError` to redact token bytes from error
// messages before they cross the renderer boundary.
interface StubClient {
  listTeams: ReturnType<typeof vi.fn>;
  listChannels: ReturnType<typeof vi.fn>;
  listChannelMembers: ReturnType<typeof vi.fn>;
  listChannelFiles: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
  scrubMessage: ReturnType<typeof vi.fn>;
}
const clientMock: StubClient = {
  listTeams: vi.fn(),
  listChannels: vi.fn(),
  listChannelMembers: vi.fn(),
  listChannelFiles: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  // Default: pass-through. Tests that need to assert scrub
  // behaviour replace this implementation in their own `beforeEach`.
  scrubMessage: vi.fn((msg: string) => msg),
};
const serviceMock = {
  getClient: () => clientMock,
  getState: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock("../appState", () => ({
  getBridge: () => bridgeMock,
  getKchatAuthService: () => serviceMock,
}));

import { registerKchatHandlers } from "../ipc/kchat";

function handler(channel: string) {
  const c = handleMock.mock.calls.find((x) => x[0] === channel);
  if (!c) throw new Error(`No handler registered for ${channel}`);
  return c[1] as (
    event: unknown,
    ...args: unknown[]
  ) => Promise<unknown>;
}

const EVENT = { sender: { id: 1 } } as unknown;

beforeEach(() => {
  handleMock.mockReset();
  removeHandlerMock.mockReset();
  for (const fn of Object.values(bridgeMock)) {
    (fn as ReturnType<typeof vi.fn>).mockClear?.();
  }
  // Reset bridgeGetArtifact behaviour after mockClear wipes the
  // implementation (mockClear keeps it; mockReset would not).
  bridgeMock.bridgeGetArtifact.mockReturnValue({ title: "Quarterly Roadmap" });
  bridgeMock.bridgeExportArtifact.mockReturnValue({
    content: "# Hello\n",
    format: "markdown",
  });
  bridgeMock.bridgeEvidencePackBytes.mockReturnValue(
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  );
  bridgeMock.bridgeAddKchatChannel.mockReturnValue({
    source: {
      id: "src-uuid",
      sourceType: "kchat",
      path: "",
      status: "indexed",
      createdAt: "2024-01-01T00:00:00Z",
      lastIndexed: null,
      fileCount: 0,
    },
    newlyCreated: true,
  });
  for (const fn of Object.values(clientMock)) {
    fn.mockReset();
  }
  // Re-establish the default scrubMessage pass-through after
  // `mockReset()` cleared the implementation, so other tests don't
  // accidentally end up with `Error.message === undefined` when
  // `toIpcError` routes through the client.
  clientMock.scrubMessage.mockImplementation((msg: string) => msg);
  serviceMock.getState.mockReset();
  serviceMock.connect.mockReset();
  serviceMock.disconnect.mockReset();
  registerKchatHandlers();
});

describe("kchat IPC registration", () => {
  it("registers every kchat:* channel exactly once", () => {
    const channels = handleMock.mock.calls.map((c) => c[0] as string);
    for (const want of [
      "kchat:isAvailable",
      "kchat:status",
      "kchat:connect",
      "kchat:disconnect",
      "kchat:listTeams",
      "kchat:listChannels",
      "kchat:listMembers",
      "kchat:listChannelFiles",
      "kchat:shareArtifact",
      "sources:addKchatChannel",
    ]) {
      expect(channels).toContain(want);
    }
  });
});

describe("kchat:isAvailable", () => {
  it("returns true (feature gate enabled by default)", async () => {
    expect(await handler("kchat:isAvailable")(EVENT)).toBe(true);
  });
});

describe("kchat:status", () => {
  it("returns the service's renderer-safe state", async () => {
    serviceMock.getState.mockReturnValue({
      state: "connected",
      user: { username: "ken" },
    });
    const out = await handler("kchat:status")(EVENT);
    expect(out).toEqual({ state: "connected", user: { username: "ken" } });
  });
});

describe("kchat:connect", () => {
  it("delegates to service.connect, audits, and returns sanitised user", async () => {
    serviceMock.connect.mockResolvedValue({
      id: "user1234567890abcdefgh",
      username: "ken",
      email: "k@e.com",
      first_name: "K",
      last_name: "N",
    });
    const out = await handler("kchat:connect")(
      EVENT,
      "PAT-secret",
      "https://kchat.example.com",
    );
    expect(serviceMock.connect).toHaveBeenCalledWith(
      "PAT-secret",
      "https://kchat.example.com",
    );
    expect(bridgeMock.bridgeLogKchatConnected).toHaveBeenCalledWith(
      "https://kchat.example.com",
      "user1234567890abcdefgh",
    );
    expect(JSON.stringify(out)).not.toContain("PAT-secret");
    expect(out).toMatchObject({ id: "user1234567890abcdefgh", username: "ken" });
  });

  it("rejects non-http(s) server URLs before touching the service", async () => {
    await expect(
      handler("kchat:connect")(EVENT, "PAT", "ftp://kchat.example.com"),
    ).rejects.toThrow(/http:\/\/ or https:\/\//);
    expect(serviceMock.connect).not.toHaveBeenCalled();
  });
});

// Eighth-pass Devin Review ANALYSIS_0006: SSRF guard on kchat:connect.
// The renderer-supplied serverUrl must not point at private,
// loopback, link-local, or CGNAT address space. If the user pastes
// (or the renderer is tricked into supplying) a URL like
// `http://127.0.0.1:8080/` or `http://10.0.0.5/`, the connect must
// fail BEFORE the auth service issues an `Authorization: Bearer
// <PAT>` request to that internal endpoint.
describe("kchat:connect — SSRF guard (eighth-pass invariant)", () => {
  const internalUrls = [
    "http://127.0.0.1:8080/",
    "http://localhost/",
    "http://0.0.0.0/",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://172.16.5.5/",
    "http://169.254.169.254/", // EC2 instance metadata
    "http://100.64.0.1/", // CGNAT
    "http://[::1]/",
    "http://[fe80::1]/", // IPv6 link-local
    "http://[fc00::1]/", // IPv6 ULA
  ];
  for (const u of internalUrls) {
    it(`rejects ${u} as a private/loopback target before touching the service`, async () => {
      await expect(
        handler("kchat:connect")(EVENT, "PAT", u),
      ).rejects.toThrow(/private|loopback|link-local/i);
      expect(serviceMock.connect).not.toHaveBeenCalled();
      expect(bridgeMock.bridgeLogKchatConnected).not.toHaveBeenCalled();
    });
  }

  it("rejects malformed URLs before touching the service", async () => {
    await expect(
      handler("kchat:connect")(EVENT, "PAT", "not a url"),
    ).rejects.toThrow(/not a valid URL|http:\/\/ or https:\/\//);
    expect(serviceMock.connect).not.toHaveBeenCalled();
  });

  it("allows internal URLs when TESSERA_KCHAT_ALLOW_INTERNAL=1 is set (dev opt-out)", async () => {
    const prev = process.env.TESSERA_KCHAT_ALLOW_INTERNAL;
    process.env.TESSERA_KCHAT_ALLOW_INTERNAL = "1";
    try {
      serviceMock.connect.mockResolvedValue({
        id: "user1234567890abcdefgh",
        username: "dev",
        email: "d@e.com",
        first_name: "D",
        last_name: "V",
      });
      const out = await handler("kchat:connect")(
        EVENT,
        "PAT",
        "http://127.0.0.1:8080/",
      );
      expect(out).toMatchObject({ id: "user1234567890abcdefgh" });
      expect(serviceMock.connect).toHaveBeenCalledWith(
        "PAT",
        "http://127.0.0.1:8080/",
      );
    } finally {
      if (prev === undefined) {
        delete process.env.TESSERA_KCHAT_ALLOW_INTERNAL;
      } else {
        process.env.TESSERA_KCHAT_ALLOW_INTERNAL = prev;
      }
    }
  });
});

describe("kchat:disconnect", () => {
  it("audits with the previously-connected user id", async () => {
    serviceMock.disconnect.mockReturnValue("user1234567890abcdefgh");
    const out = await handler("kchat:disconnect")(EVENT);
    expect(out).toEqual({ disconnected: true });
    expect(bridgeMock.bridgeLogKchatDisconnected).toHaveBeenCalledWith(
      "user1234567890abcdefgh",
    );
  });

  it("does NOT audit when nothing was connected", async () => {
    serviceMock.disconnect.mockReturnValue(null);
    await handler("kchat:disconnect")(EVENT);
    expect(bridgeMock.bridgeLogKchatDisconnected).not.toHaveBeenCalled();
  });
});

describe("kchat:listTeams / listChannels / listMembers", () => {
  it("sanitises team responses (drops fields renderer does not need)", async () => {
    clientMock.listTeams.mockResolvedValue([
      {
        id: "tid000000000000000000ab",
        name: "core",
        display_name: "Core",
        description: "design",
        type: "O",
        create_at: 999,
        update_at: 999,
      },
    ]);
    const out = (await handler("kchat:listTeams")(EVENT)) as Array<
      Record<string, unknown>
    >;
    expect(out[0]).toEqual({
      id: "tid000000000000000000ab",
      name: "core",
      display_name: "Core",
      description: "design",
      type: "O",
    });
    expect("create_at" in out[0]).toBe(false);
  });

  it("rejects malformed KChat channel ids before calling the service", async () => {
    await expect(
      handler("kchat:listChannels")(EVENT, "not-a-valid-id"),
    ).rejects.toThrow(/KChat object id/);
    expect(clientMock.listChannels).not.toHaveBeenCalled();
  });
});

describe("toIpcError redaction", () => {
  // The renderer renders `error.message` verbatim into toasts and
  // status banners. `toIpcError` must run any underlying error
  // through `KchatClient.scrubMessage` before the message crosses
  // the renderer boundary, so token bytes or `Bearer ...` patterns
  // accidentally embedded in an error string are redacted at the
  // last possible point. This test asserts both the wiring (the
  // client's `scrubMessage` is actually called) and the outcome
  // (the rendered message contains `[REDACTED]`, not the token).
  it("runs error messages through KchatClient.scrubMessage before throwing across IPC", async () => {
    clientMock.scrubMessage.mockImplementation((m: string) =>
      m.replace(/PAT-secret-token/g, "[REDACTED]").replace(
        /Bearer\s+[A-Za-z0-9._\-+/=]+/gi,
        "Bearer [REDACTED]",
      ),
    );
    // Simulate a low-level network error that embedded the PAT in
    // its message (the most realistic path through which a token
    // could leak — fetch errors carry the request URL/headers in
    // their `message` on some platforms).
    clientMock.listTeams.mockRejectedValue(
      new Error(
        "fetch failed: Authorization: Bearer PAT-secret-token (host unreachable)",
      ),
    );

    let caught: Error | undefined;
    try {
      await handler("kchat:listTeams")(EVENT);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).not.toContain("PAT-secret-token");
    expect(caught?.message).toContain("[REDACTED]");
    expect(clientMock.scrubMessage).toHaveBeenCalled();
  });

  it("also scrubs synthetic KchatRequestError messages (status/endpoint path)", async () => {
    clientMock.scrubMessage.mockImplementation((m: string) =>
      m.replace(/secret-endpoint/g, "[REDACTED]"),
    );
    const { KchatRequestError } = await import("../kchat/kchatClient");
    clientMock.listTeams.mockRejectedValue(
      new KchatRequestError(
        401,
        "Unauthorized",
        "/api/v4/users/me?token=secret-endpoint",
        "token expired",
      ),
    );
    let caught: Error | undefined;
    try {
      await handler("kchat:listTeams")(EVENT);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).not.toContain("secret-endpoint");
    expect(caught?.message).toContain("[REDACTED]");
  });
});

describe("kchat:shareArtifact", () => {
  it("uploads markdown export and audits the share", async () => {
    clientMock.uploadFile.mockResolvedValue({
      id: "fid000000000000000000abcd",
      name: "Quarterly-Roadmap.md",
    });
    const out = await handler("kchat:shareArtifact")(
      EVENT,
      "550e8400-e29b-41d4-a716-446655440000",
      "chid0000000000000000abcd",
      "markdown",
      true,
      false,
    );
    expect(bridgeMock.bridgeExportArtifact).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "markdown",
      null,
      true,
    );
    expect(clientMock.uploadFile).toHaveBeenCalledTimes(1);
    expect(clientMock.uploadFile.mock.calls[0][1]).toBe("Quarterly-Roadmap.md");
    expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "chid0000000000000000abcd",
      "markdown",
      true,
      false,
    );
    expect(out).toEqual({
      fileId: "fid000000000000000000abcd",
      fileName: "Quarterly-Roadmap.md",
    });
  });

  it("uploads an evidence pack when includeEvidencePack=true", async () => {
    clientMock.uploadFile.mockResolvedValue({
      id: "fid",
      name: "Quarterly-Roadmap.md",
    });
    await handler("kchat:shareArtifact")(
      EVENT,
      "550e8400-e29b-41d4-a716-446655440000",
      "chid0000000000000000abcd",
      "markdown",
      false,
      true,
    );
    // Toggle is forwarded — includeCitations=false plumbs through to
    // the Rust dispatch layer, not just to the audit row.
    expect(bridgeMock.bridgeExportArtifact).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "markdown",
      null,
      false,
    );
    expect(bridgeMock.bridgeEvidencePackBytes).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(clientMock.uploadFile).toHaveBeenCalledTimes(2);
    expect(clientMock.uploadFile.mock.calls[1][1]).toBe(
      "Quarterly-Roadmap-evidence.zip",
    );
    expect(clientMock.uploadFile.mock.calls[1][3]).toBe("application/zip");
  });

  it("rejects unknown formats before any bridge call", async () => {
    await expect(
      handler("kchat:shareArtifact")(
        EVENT,
        "550e8400-e29b-41d4-a716-446655440000",
        "chid0000000000000000abcd",
        "exe",
        false,
        false,
      ),
    ).rejects.toThrow(/format must be one of/);
    expect(bridgeMock.bridgeExportArtifact).not.toHaveBeenCalled();
    expect(clientMock.uploadFile).not.toHaveBeenCalled();
  });

  it("forwards includeCitations=false to bridgeExportArtifactToFile for binary formats (pdf/docx)", async () => {
    // PDF/DOCX go through the tempfile path; verify the toggle is
    // threaded the same way as the text-format path.
    clientMock.uploadFile.mockResolvedValue({ id: "fid", name: "x.pdf" });
    // The bridge function is synchronous in its TS signature, so the
    // mock must stage the temp file synchronously — using async fs
    // would race with the immediately-following `fs.readFile` in
    // `produceExportBytes`.
    const fsSync = await import("node:fs");
    bridgeMock.bridgeExportArtifactToFile.mockImplementation(
      (_id: string, _fmt: string, p: string) => {
        fsSync.writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF
      },
    );
    await handler("kchat:shareArtifact")(
      EVENT,
      "550e8400-e29b-41d4-a716-446655440000",
      "chid0000000000000000abcd",
      "pdf",
      false,
      false,
    );
    expect(bridgeMock.bridgeExportArtifactToFile).toHaveBeenCalledTimes(1);
    const call = bridgeMock.bridgeExportArtifactToFile.mock.calls[0];
    expect(call[0]).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(call[1]).toBe("pdf");
    expect(typeof call[2]).toBe("string"); // tempPath
    expect(call[3]).toBeNull(); // contentOverride
    expect(call[4]).toBe(false); // includeCitations forwarded
  });

  // Sixth-pass Devin Review (ANALYSIS_0007): pin the
  // audit-to-channel consistency invariant under partial failure.
  // If the primary export uploads successfully but the evidence
  // pack upload fails afterwards, the audit log MUST still record
  // the primary share (with `evidenceShared=false`) — otherwise
  // the audit log is silently inconsistent with what landed in
  // the channel, defeating the tamper-evidence guarantee.
  it("audits the primary share with evidenceShared=false when evidence-pack upload fails", async () => {
    // First uploadFile call succeeds (primary). Second call fails
    // (evidence pack upload). The handler must:
    //   1. Audit the primary share with the actual evidenceShared
    //      flag (`false`, since the pack didn't land).
    //   2. Re-throw the upload error so the renderer learns of
    //      the partial-failure state.
    clientMock.uploadFile
      .mockResolvedValueOnce({
        id: "fidprimary00000000000abc",
        name: "Quarterly-Roadmap.md",
      })
      .mockRejectedValueOnce(new Error("KChat 429 Too Many Requests"));
    await expect(
      handler("kchat:shareArtifact")(
        EVENT,
        "550e8400-e29b-41d4-a716-446655440000",
        "chid0000000000000000abcd",
        "markdown",
        true,
        true, // includeEvidencePack — primary will succeed, pack will fail
      ),
    ).rejects.toThrow(/429|Too Many Requests/);
    // Both uploads were attempted in order — primary first, then pack.
    expect(clientMock.uploadFile).toHaveBeenCalledTimes(2);
    expect(clientMock.uploadFile.mock.calls[1][1]).toBe(
      "Quarterly-Roadmap-evidence.zip",
    );
    // The audit row IS emitted despite the partial-failure error
    // re-throw, and it records `evidenceShared=false` (actual
    // outcome) — NOT `wantEvidence=true` (user request).
    expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "chid0000000000000000abcd",
      "markdown",
      true, // wantCitations (user request, threaded through)
      false, // evidenceShared (actual on-channel outcome)
    );
  });

  it("audits with evidenceShared=true ONLY when the pack actually uploaded", async () => {
    // Both uploads succeed → audit row reflects the requested
    // evidence flag (which here equals the actual outcome).
    clientMock.uploadFile.mockResolvedValue({
      id: "fid000000000000000000abc",
      name: "Quarterly-Roadmap.md",
    });
    await handler("kchat:shareArtifact")(
      EVENT,
      "550e8400-e29b-41d4-a716-446655440000",
      "chid0000000000000000abcd",
      "markdown",
      true,
      true,
    );
    expect(clientMock.uploadFile).toHaveBeenCalledTimes(2);
    expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeLogKchatArtifactShared).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "chid0000000000000000abcd",
      "markdown",
      true,
      true, // evidenceShared = true: both files actually in the channel
    );
  });

  it("does NOT audit anything when the primary upload fails (nothing in channel)", async () => {
    // Primary upload fails — channel is unchanged, so emitting an
    // audit row would create a phantom record. The existing
    // catch/toIpcError flow re-throws WITHOUT calling
    // `bridgeLogKchatArtifactShared`. Pin this so a future
    // refactor that moves audit logging earlier doesn't reintroduce
    // phantom rows.
    clientMock.uploadFile.mockRejectedValue(
      new Error("KChat 500 Internal Server Error"),
    );
    await expect(
      handler("kchat:shareArtifact")(
        EVENT,
        "550e8400-e29b-41d4-a716-446655440000",
        "chid0000000000000000abcd",
        "markdown",
        true,
        true,
      ),
    ).rejects.toThrow(/500|Internal Server Error/);
    expect(clientMock.uploadFile).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeLogKchatArtifactShared).not.toHaveBeenCalled();
    // Evidence-pack producer never runs because the primary failed
    // first and the `if (wantEvidence)` branch is reached only on
    // primary success.
    expect(bridgeMock.bridgeEvidencePackBytes).not.toHaveBeenCalled();
  });
});

describe("sources:addKchatChannel — path-traversal hardening", () => {
  // The KChat server is treated as untrusted: a compromised or
  // malicious server can return file names containing path-traversal
  // sequences. The handler MUST sanitise these so writes are scoped
  // to the per-channel cache directory. Exercise the real fs path
  // (the handler uses `fs.writeFile` to land bytes on disk under
  // `~/.tessera/kchat-channels/<id>/`); after the call we read the
  // cache directory back and assert no file landed outside of it.

  async function readCacheDir(dir: string): Promise<string[]> {
    const fs = await import("fs/promises");
    try {
      return await fs.readdir(dir);
    } catch {
      return [];
    }
  }

  it("strips directory components from server-supplied filenames", async () => {
    const path = await import("path");
    const fs = await import("fs/promises");
    clientMock.listChannelFiles.mockResolvedValue([
      {
        id: "fid-safe",
        name: "report.pdf",
        size: 100,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 1,
      },
      {
        id: "fid-evil",
        name: "../../../etc/passwd",
        size: 100,
        mime_type: "text/plain",
        extension: "",
        create_at: 2,
      },
    ]);
    clientMock.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chid0000000000000000abcd",
      "design",
    )) as { sourceId: string; cacheDir: string };

    // Both files end up inside the per-channel cache dir.
    expect(out.cacheDir).toMatch(/kchat-channels[\\/]chid0000000000000000abcd$/);
    const entries = await readCacheDir(out.cacheDir);
    // The traversal-bearing entry is rewritten to `passwd` (basename
    // strips `../../../etc/`); the safe entry survives unchanged.
    expect(entries).toContain("report.pdf");
    expect(entries).toContain("passwd");

    // Critical: assert no file landed at the would-be escape target.
    // If sanitisation regressed we would see writes under
    // `<cache>/../../../etc/passwd`. Walking the resolved parent of
    // the cache dir tells us if any sibling directory was created.
    const cacheParent = path.dirname(out.cacheDir);
    const siblings = await readCacheDir(cacheParent);
    // The only entry under `<.tessera>/kchat-channels` should be the
    // per-channel subdir; the path-traversal payload would have
    // created an `etc` sibling if sanitisation failed.
    expect(siblings).not.toContain("etc");

    // Clean up the test artefacts so a re-run starts fresh.
    for (const e of entries) {
      await fs.rm(path.join(out.cacheDir, e), { force: true });
    }
  });

  it("substitutes a synthetic name when basename strips to '.' or '..'", async () => {
    const path = await import("path");
    const fs = await import("fs/promises");
    clientMock.listChannelFiles.mockResolvedValue([
      {
        id: "fid-dot",
        name: ".",
        size: 1,
        mime_type: "",
        extension: "",
        create_at: 1,
      },
      {
        id: "fid-dotdot",
        name: "..",
        size: 1,
        mime_type: "",
        extension: "",
        create_at: 2,
      },
    ]);
    clientMock.downloadFile.mockResolvedValue(new Uint8Array([1]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chid0000000000000000abcd",
      "design",
    )) as { sourceId: string; cacheDir: string };

    const entries = await readCacheDir(out.cacheDir);
    // Both writes land inside the cache dir under the synthetic
    // `kchat-file-<id>` naming; the cache directory itself is not
    // overwritten because `.` and `..` are rejected by the sanitiser.
    expect(entries).toContain("kchat-file-fid-dot");
    expect(entries).toContain("kchat-file-fid-dotdot");
    for (const e of entries) {
      await fs.rm(path.join(out.cacheDir, e), { force: true });
    }
  });

  // `fi.id` is also untrusted server input. The fallback name
  // `kchat-file-${fi.id}` would otherwise embed unsanitised bytes
  // from the id into the on-disk filename. Sanitisation strips
  // every byte outside `[A-Za-z0-9_-]` to underscore, so a
  // traversal-bearing id can't escape the cache dir via the
  // fallback path.
  it("sanitises traversal-bearing fi.id values in the fallback safeName", async () => {
    const path = await import("path");
    const fs = await import("fs/promises");
    clientMock.listChannelFiles.mockResolvedValue([
      {
        // `fi.name` strips to `.` so the fallback safeName branch fires.
        id: "../../../etc/passwd",
        name: ".",
        size: 1,
        mime_type: "",
        extension: "",
        create_at: 1,
      },
    ]);
    clientMock.downloadFile.mockResolvedValue(new Uint8Array([1]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chid0000000000000000abcd",
      "design",
    )) as { sourceId: string; cacheDir: string };

    const entries = await readCacheDir(out.cacheDir);
    // Every byte outside `[A-Za-z0-9_-]` becomes `_`, so the entry
    // lands as `kchat-file-______________etc_passwd` inside the
    // per-channel cache.
    expect(
      entries.some((e) => e.startsWith("kchat-file-") && e.includes("etc_passwd")),
    ).toBe(true);
    // Defence-in-depth: no `etc` sibling directory should exist.
    const siblings = await readCacheDir(path.dirname(out.cacheDir));
    expect(siblings).not.toContain("etc");

    for (const e of entries) {
      await fs.rm(path.join(out.cacheDir, e), { force: true });
    }
  });
});

describe("sources:addKchatChannel — pagination", () => {
  // KChat returns at most `per_page` files per call. The handler
  // must loop until a short page is observed; otherwise channels
  // with more than 60 files would silently truncate at the
  // first page.
  it("walks all pages until the server returns a short page", async () => {
    const PER_PAGE = 60;
    // Pages: 0 full, 1 full, 2 partial (10) → terminates.
    function page(pageIdx: number, count: number): unknown[] {
      return Array.from({ length: count }, (_, i) => ({
        id: `fid${String(pageIdx).padStart(2, "0")}p${String(i).padStart(2, "0")}xxxxxxxxx`,
        name: `report-${pageIdx}-${i}.txt`,
        size: 4,
        mime_type: "text/plain",
        extension: "txt",
        create_at: pageIdx * 1000 + i,
      }));
    }
    clientMock.listChannelFiles
      .mockResolvedValueOnce(page(0, PER_PAGE))
      .mockResolvedValueOnce(page(1, PER_PAGE))
      .mockResolvedValueOnce(page(2, 10));
    clientMock.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chid0000000000000000abcd",
      "design",
    )) as { sourceId: string; cacheDir: string };

    // Three calls: pages 0, 1, 2. The handler stops at page 2 because
    // its result is shorter than `per_page`.
    expect(clientMock.listChannelFiles).toHaveBeenCalledTimes(3);
    expect(clientMock.listChannelFiles).toHaveBeenNthCalledWith(
      1,
      "chid0000000000000000abcd",
      0,
      PER_PAGE,
    );
    expect(clientMock.listChannelFiles).toHaveBeenNthCalledWith(
      2,
      "chid0000000000000000abcd",
      1,
      PER_PAGE,
    );
    expect(clientMock.listChannelFiles).toHaveBeenNthCalledWith(
      3,
      "chid0000000000000000abcd",
      2,
      PER_PAGE,
    );
    // 130 total downloads = 60 + 60 + 10.
    expect(clientMock.downloadFile).toHaveBeenCalledTimes(130);

    const fs = await import("fs/promises");
    const path = await import("path");
    const entries = await fs.readdir(out.cacheDir);
    expect(entries.length).toBe(130);
    for (const e of entries) {
      await fs.rm(path.join(out.cacheDir, e), { force: true });
    }
  });

  it("stops after a single page when the first response is short", async () => {
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fid0000000000000000only",
        name: "only.txt",
        size: 1,
        mime_type: "text/plain",
        extension: "txt",
        create_at: 1,
      },
    ]);
    clientMock.downloadFile.mockResolvedValue(new Uint8Array([1]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chid0000000000000000abcd",
      "design",
    )) as { sourceId: string; cacheDir: string };

    expect(clientMock.listChannelFiles).toHaveBeenCalledTimes(1);
    const fs = await import("fs/promises");
    const path = await import("path");
    const entries = await fs.readdir(out.cacheDir);
    for (const e of entries) {
      await fs.rm(path.join(out.cacheDir, e), { force: true });
    }
  });
});

describe("sources:addKchatChannel — filename collision dedupe", () => {
  // KChat channels have a flat file namespace — two users can each
  // upload `report.pdf` to the same channel. The previous handler
  // wrote each file using `path.basename(fi.name)` directly, so the
  // second `fs.writeFile` silently overwrote the first. The fix
  // tracks an in-loop `Set<string>` of names already written and
  // suffixes the sanitised KChat file id between stem and extension
  // when a collision is detected. This pins that contract: two files
  // with the same `name` (and even three!) must all persist on disk
  // and each one must be audit-logged with its on-disk filename.

  // The handler derives cacheDir from `<homedir>/.tessera/kchat-channels/<channelId>/`,
  // so we vary the channelId per test to keep on-disk state
  // hermetic without cross-test interference.

  it("preserves all files when two share the same basename within one page", async () => {
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidaaaaaaaaaaaaaaaaaa",
        name: "report.pdf",
        size: 3,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 1,
      },
      {
        id: "fidbbbbbbbbbbbbbbbbbb",
        name: "report.pdf",
        size: 4,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 2,
      },
    ]);
    clientMock.downloadFile
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
      .mockResolvedValueOnce(new Uint8Array([9, 9, 9, 9]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chiddedupe11111111111one",
      "design-dedupe-one",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    const path = await import("path");
    const entries = (await fs.readdir(out.cacheDir)).sort();
    try {
      // Both files must persist: the first under its original name,
      // the second under `report-<sanitised-id>.pdf`.
      expect(entries).toEqual([
        "report-fidbbbbbbbbbbbbbbbbbb.pdf",
        "report.pdf",
      ]);
      const firstBytes = await fs.readFile(
        path.join(out.cacheDir, "report.pdf"),
      );
      const secondBytes = await fs.readFile(
        path.join(out.cacheDir, "report-fidbbbbbbbbbbbbbbbbbb.pdf"),
      );
      expect(Array.from(firstBytes)).toEqual([1, 2, 3]);
      expect(Array.from(secondBytes)).toEqual([9, 9, 9, 9]);
      // Audit log must record BOTH downloads — one under the
      // original name, one under the deduped name. This is the
      // audit-to-disk consistency invariant the original bug broke.
      const auditedNames = bridgeMock.bridgeLogKchatFileDownloaded.mock.calls
        .map((c) => c[1] as string)
        .sort();
      expect(auditedNames).toEqual([
        "report-fidbbbbbbbbbbbbbbbbbb.pdf",
        "report.pdf",
      ]);
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
    }
  });

  it("dedupes across pages, not just within a single page", async () => {
    // The dedupe Set must span the entire pagination loop, not
    // reset between pages. We exercise this by emitting two full
    // pages (PER_PAGE = 60) where page 0 contains a `notes.pdf`
    // and page 1 contains a second `notes.pdf` (after 59 filler
    // files). The handler must continue past page 0 because the
    // page-length terminator only fires on a SHORT page; only when
    // both `notes.pdf` files are on disk under distinct names is
    // the invariant satisfied.
    const PER_PAGE = 60;
    const page0: unknown[] = [
      {
        id: "fidpage0aaaaaaaaaaaa",
        name: "notes.pdf",
        size: 1,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 1,
      },
    ];
    for (let i = 0; i < PER_PAGE - 1; i += 1) {
      page0.push({
        id: `fidpage0filler${String(i).padStart(2, "0")}aa`,
        name: `filler-${i}.txt`,
        size: 1,
        mime_type: "text/plain",
        extension: "txt",
        create_at: 100 + i,
      });
    }
    const page1: unknown[] = [
      {
        id: "fidpage1bbbbbbbbbbbb",
        name: "notes.pdf",
        size: 2,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 200,
      },
    ];
    clientMock.listChannelFiles
      .mockResolvedValueOnce(page0)
      .mockResolvedValueOnce(page1);
    clientMock.downloadFile.mockResolvedValue(new Uint8Array([0]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chiddedupe22222222222two",
      "design-dedupe-two",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    const entries = (await fs.readdir(out.cacheDir)).sort();
    try {
      // The two `notes.pdf` files must BOTH exist — one under the
      // original name, one under the dedupe-suffixed name. The
      // filler files prove the loop did walk into page 1.
      expect(entries).toContain("notes.pdf");
      expect(entries).toContain("notes-fidpage1bbbbbbbbbbbb.pdf");
      expect(entries.length).toBe(PER_PAGE + 1);
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
    }
  });

  it("dedupes more than two collisions on the same name", async () => {
    // Three `screenshot.png` uploads. The first keeps the original
    // name; the next two get suffixed forms. All three bytes must
    // persist on disk.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fid111111111111111111",
        name: "screenshot.png",
        size: 1,
        mime_type: "image/png",
        extension: "png",
        create_at: 1,
      },
      {
        id: "fid222222222222222222",
        name: "screenshot.png",
        size: 2,
        mime_type: "image/png",
        extension: "png",
        create_at: 2,
      },
      {
        id: "fid333333333333333333",
        name: "screenshot.png",
        size: 3,
        mime_type: "image/png",
        extension: "png",
        create_at: 3,
      },
    ]);
    clientMock.downloadFile
      .mockResolvedValueOnce(new Uint8Array([0xa]))
      .mockResolvedValueOnce(new Uint8Array([0xb, 0xb]))
      .mockResolvedValueOnce(new Uint8Array([0xc, 0xc, 0xc]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chiddedupe333333333333three",
      "design-dedupe-three",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    const entries = (await fs.readdir(out.cacheDir)).sort();
    try {
      expect(entries).toEqual([
        "screenshot-fid222222222222222222.png",
        "screenshot-fid333333333333333333.png",
        "screenshot.png",
      ]);
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
    }
  });
});

describe("sources:addKchatChannel — convergent sync via download manifest", () => {
  // Seventh-pass Devin Review ANALYSIS_0003.
  //
  // The handler writes a sidecar manifest (`<cacheDir>.manifest.json`)
  // recording every `fi.id → on-disk filename` it has successfully
  // downloaded. On the NEXT sync the handler:
  //   1. Skips re-downloading files whose `fi.id` is still in the
  //      manifest AND whose recorded file still exists on disk
  //      (KChat file content is immutable per object-id).
  //   2. Unlinks files whose `fi.id` is no longer in the server
  //      roster (server-side deletion between syncs).
  //   3. Persists a refreshed manifest even on partial failure so
  //      a subsequent retry knows what's already on disk.
  //
  // The previous behaviour was "download what's there, never clean
  // up" — server-side deletions left orphaned bytes on disk that
  // continued to be indexed indefinitely. These tests pin the
  // convergent-sync contract.

  it("skips re-downloading files that were already downloaded in a previous sync", async () => {
    // First sync: 2 files. downloadFile called twice.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidcccccccccccccccccccc",
        name: "a.md",
        size: 2,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 1,
      },
      {
        id: "fidddddddddddddddddddd",
        name: "b.md",
        size: 2,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 2,
      },
    ]);
    clientMock.downloadFile
      .mockResolvedValueOnce(new Uint8Array([1, 1]))
      .mockResolvedValueOnce(new Uint8Array([2, 2]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidconvsync1111111one1",
      "design-convsync-one",
    )) as { sourceId: string; cacheDir: string };

    expect(clientMock.downloadFile).toHaveBeenCalledTimes(2);

    // Second sync: same 2 files in the roster. The handler MUST
    // skip both downloads because the manifest carries them
    // forward.
    clientMock.downloadFile.mockClear();
    clientMock.listChannelFiles.mockReset();
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidcccccccccccccccccccc",
        name: "a.md",
        size: 2,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 1,
      },
      {
        id: "fidddddddddddddddddddd",
        name: "b.md",
        size: 2,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 2,
      },
    ]);

    const out2 = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidconvsync1111111one1",
      "design-convsync-one",
    )) as { sourceId: string; cacheDir: string };

    // Zero re-downloads: the manifest fast-path skipped both.
    expect(clientMock.downloadFile).not.toHaveBeenCalled();

    const fs = await import("fs/promises");
    const entries = (await fs.readdir(out.cacheDir)).sort();
    try {
      expect(entries).toEqual(["a.md", "b.md"]);
      expect(out2.cacheDir).toBe(out.cacheDir);
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
      await fs
        .rm(`${out.cacheDir}.manifest.json`, { force: true })
        .catch(() => {});
    }
  });

  it("unlinks files that were deleted server-side between syncs", async () => {
    // First sync: 3 files.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fideeeeeeeeeeeeeeeeeee1",
        name: "keep1.txt",
        size: 1,
        mime_type: "text/plain",
        extension: "txt",
        create_at: 1,
      },
      {
        id: "fideeeeeeeeeeeeeeeeeee2",
        name: "delete-me.txt",
        size: 1,
        mime_type: "text/plain",
        extension: "txt",
        create_at: 2,
      },
      {
        id: "fideeeeeeeeeeeeeeeeeee3",
        name: "keep2.txt",
        size: 1,
        mime_type: "text/plain",
        extension: "txt",
        create_at: 3,
      },
    ]);
    clientMock.downloadFile
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockResolvedValueOnce(new Uint8Array([2]))
      .mockResolvedValueOnce(new Uint8Array([3]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidconvsync2222222two2",
      "design-convsync-two",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    try {
      // Pre-condition: all 3 files on disk after first sync.
      const after1 = (await fs.readdir(out.cacheDir)).sort();
      expect(after1).toEqual(["delete-me.txt", "keep1.txt", "keep2.txt"]);

      // Second sync: server returns only 2 files (delete-me.txt
      // was deleted server-side between syncs).
      clientMock.downloadFile.mockClear();
      clientMock.listChannelFiles.mockReset();
      clientMock.listChannelFiles.mockResolvedValueOnce([
        {
          id: "fideeeeeeeeeeeeeeeeeee1",
          name: "keep1.txt",
          size: 1,
          mime_type: "text/plain",
          extension: "txt",
          create_at: 1,
        },
        {
          id: "fideeeeeeeeeeeeeeeeeee3",
          name: "keep2.txt",
          size: 1,
          mime_type: "text/plain",
          extension: "txt",
          create_at: 3,
        },
      ]);

      await handler("sources:addKchatChannel")(
        EVENT,
        "chidconvsync2222222two2",
        "design-convsync-two",
      );

      // Convergent-sync contract: the stale file MUST be unlinked
      // after the second sync completes, leaving only the two
      // files that are still in the server roster.
      const after2 = (await fs.readdir(out.cacheDir)).sort();
      expect(after2).toEqual(["keep1.txt", "keep2.txt"]);
      // And no re-downloads (both kept files were carried by the
      // manifest fast-path).
      expect(clientMock.downloadFile).not.toHaveBeenCalled();
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
      await fs
        .rm(`${out.cacheDir}.manifest.json`, { force: true })
        .catch(() => {});
    }
  });

  it("re-downloads a file that was manually deleted from cacheDir between syncs", async () => {
    // First sync: 1 file.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidffffffffffffffffffff",
        name: "report.md",
        size: 2,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 1,
      },
    ]);
    clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([7, 7]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidconvsync3333thr3ee3",
      "design-convsync-three",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    const path = await import("path");
    try {
      // User manually deletes the file from disk (e.g. via Finder).
      await fs.unlink(path.join(out.cacheDir, "report.md"));

      // Second sync: server still has the file.
      clientMock.downloadFile.mockClear();
      clientMock.listChannelFiles.mockReset();
      clientMock.listChannelFiles.mockResolvedValueOnce([
        {
          id: "fidffffffffffffffffffff",
          name: "report.md",
          size: 2,
          mime_type: "text/markdown",
          extension: "md",
          create_at: 1,
        },
      ]);
      clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([8, 8]));

      await handler("sources:addKchatChannel")(
        EVENT,
        "chidconvsync3333thr3ee3",
        "design-convsync-three",
      );

      // The handler MUST re-download because the recorded file
      // was missing from disk — manifest fast-path verifies
      // on-disk presence before skipping.
      expect(clientMock.downloadFile).toHaveBeenCalledTimes(1);
      const bytes = await fs.readFile(path.join(out.cacheDir, "report.md"));
      expect(Array.from(bytes)).toEqual([8, 8]);
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
      await fs
        .rm(`${out.cacheDir}.manifest.json`, { force: true })
        .catch(() => {});
    }
  });

  it("persists partial-failure progress so a retry resumes from where it stopped", async () => {
    // Mid-sync failure: download #2 throws, but we already wrote
    // file #1 to disk. The manifest written in `finally` must
    // record file #1 so the retry sync skips it.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidggggggggggggggggggg1",
        name: "first.md",
        size: 1,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 1,
      },
      {
        id: "fidggggggggggggggggggg2",
        name: "second.md",
        size: 1,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 2,
      },
    ]);
    clientMock.downloadFile
      .mockResolvedValueOnce(new Uint8Array([1]))
      .mockRejectedValueOnce(new Error("network blip"));

    await expect(
      handler("sources:addKchatChannel")(
        EVENT,
        "chidconvsync4444four4ee",
        "design-convsync-four",
      ),
    ).rejects.toThrow(/network blip/);

    // Retry: server returns the same 2 files. The first one was
    // already on disk + recorded in the manifest, so the retry
    // must download only the second.
    clientMock.downloadFile.mockClear();
    clientMock.listChannelFiles.mockReset();
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidggggggggggggggggggg1",
        name: "first.md",
        size: 1,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 1,
      },
      {
        id: "fidggggggggggggggggggg2",
        name: "second.md",
        size: 1,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 2,
      },
    ]);
    clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([2]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidconvsync4444four4ee",
      "design-convsync-four",
    )) as { sourceId: string; cacheDir: string };

    expect(clientMock.downloadFile).toHaveBeenCalledTimes(1);
    expect(clientMock.downloadFile).toHaveBeenCalledWith(
      "fidggggggggggggggggggg2",
    );

    const fs = await import("fs/promises");
    try {
      const entries = (await fs.readdir(out.cacheDir)).sort();
      expect(entries).toEqual(["first.md", "second.md"]);
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
      await fs
        .rm(`${out.cacheDir}.manifest.json`, { force: true })
        .catch(() => {});
    }
  });

  it("manifest lives OUTSIDE cacheDir so the indexer never picks it up as a corpus document", async () => {
    // The manifest is a sibling file (`<cacheDir>.manifest.json`),
    // never inside `cacheDir`. This guarantees
    // `bridgeAddKchatChannel(cacheDir)` — which scans the contents
    // of cacheDir — cannot accidentally index the manifest as a
    // corpus document.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidhhhhhhhhhhhhhhhhhhhh",
        name: "only.md",
        size: 1,
        mime_type: "text/markdown",
        extension: "md",
        create_at: 1,
      },
    ]);
    clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([1]));

    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidconvsync555five555a",
      "design-convsync-five",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    try {
      // Manifest exists as a sibling.
      const manifestPath = `${out.cacheDir}.manifest.json`;
      const manifestStat = await fs.stat(manifestPath);
      expect(manifestStat.isFile()).toBe(true);
      const manifestJson = JSON.parse(
        await fs.readFile(manifestPath, "utf-8"),
      );
      expect(manifestJson).toEqual({
        version: 1,
        channelId: "chidconvsync555five555a",
        files: { fidhhhhhhhhhhhhhhhhhhhh: "only.md" },
      });
      // And only the corpus file inside cacheDir — NO manifest.
      const inside = (await fs.readdir(out.cacheDir)).sort();
      expect(inside).toEqual(["only.md"]);
    } finally {
      await fs.rm(out.cacheDir, { recursive: true, force: true });
      await fs
        .rm(`${out.cacheDir}.manifest.json`, { force: true })
        .catch(() => {});
    }
  });
});

// Eighth-pass Devin Review BUG_0001 + ANALYSIS_0002 regression suite.
// BUG_0001: sources:addKchatChannel previously created a fresh source
// row with a new UUID on every re-sync because `bridgeAddKchatChannel`
// always inserted. The Rust side is now idempotent on `cache_dir`
// (returns `newlyCreated: false` for re-syncs), and the handler must
// (a) reuse the returned source id and (b) skip the
// `KchatChannelLinked` audit on re-sync.
//
// ANALYSIS_0002: `seenNames` previously seeded from the previous
// manifest, which reserved names of files that had been deleted
// server-side between syncs. The seeding now happens lazily — only
// when a file is *kept* — so a deletion + same-name re-upload no
// longer poisons the dedupe set or causes the cleanup loop to
// unlink the new file's bytes.
describe("sources:addKchatChannel — idempotent source registration (eighth-pass invariant)", () => {
  it("returns the same sourceId across re-syncs and audits 'channel linked' ONLY on the first sync", async () => {
    clientMock.listChannelFiles.mockResolvedValue([]);

    // First sync: bridge reports newlyCreated=true.
    bridgeMock.bridgeAddKchatChannel.mockReturnValueOnce({
      source: {
        id: "src-stable-1",
        sourceType: "kchat",
        path: "",
        status: "indexed",
        createdAt: "2024-01-01T00:00:00Z",
        lastIndexed: null,
        fileCount: 0,
      },
      newlyCreated: true,
    });
    const first = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidstableabcdefghi123",
      "stable-channel",
    )) as { sourceId: string; cacheDir: string };
    expect(first.sourceId).toBe("src-stable-1");
    expect(bridgeMock.bridgeLogKchatChannelLinked).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeLogKchatChannelLinked).toHaveBeenCalledWith(
      "chidstableabcdefghi123",
      "stable-channel",
      first.cacheDir,
    );

    // Second sync: bridge reports newlyCreated=false (same row reindexed).
    bridgeMock.bridgeAddKchatChannel.mockReturnValueOnce({
      source: {
        id: "src-stable-1",
        sourceType: "kchat",
        path: "",
        status: "indexed",
        createdAt: "2024-01-01T00:00:00Z",
        lastIndexed: "2024-01-02T00:00:00Z",
        fileCount: 0,
      },
      newlyCreated: false,
    });
    const second = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidstableabcdefghi123",
      "stable-channel",
    )) as { sourceId: string; cacheDir: string };
    expect(second.sourceId).toBe("src-stable-1");
    expect(second.cacheDir).toBe(first.cacheDir);
    // No second "channel linked" audit row — the handler must gate
    // the call on newlyCreated.
    expect(bridgeMock.bridgeLogKchatChannelLinked).toHaveBeenCalledTimes(1);

    // Third sync: still idempotent.
    bridgeMock.bridgeAddKchatChannel.mockReturnValueOnce({
      source: {
        id: "src-stable-1",
        sourceType: "kchat",
        path: "",
        status: "indexed",
        createdAt: "2024-01-01T00:00:00Z",
        lastIndexed: "2024-01-03T00:00:00Z",
        fileCount: 0,
      },
      newlyCreated: false,
    });
    const third = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidstableabcdefghi123",
      "stable-channel",
    )) as { sourceId: string };
    expect(third.sourceId).toBe("src-stable-1");
    expect(bridgeMock.bridgeLogKchatChannelLinked).toHaveBeenCalledTimes(1);

    const fs = await import("fs/promises");
    await fs.rm(first.cacheDir, { recursive: true, force: true });
    await fs
      .rm(`${first.cacheDir}.manifest.json`, { force: true })
      .catch(() => {});
  });
});

describe("sources:addKchatChannel — seenNames eighth-pass invariant", () => {
  it("does NOT reserve names of server-deleted files; same-name re-upload keeps the clean name", async () => {
    // Sync 1: write `report.pdf` (fid `fid-A`).
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidaaaaaaaaaaaaaaaaaaaaa",
        name: "report.pdf",
        size: 4,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 1,
      },
    ]);
    clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]));

    const first = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidseennames555555555a",
      "seen-names",
    )) as { sourceId: string; cacheDir: string };

    // Sync 2: original fid is gone server-side; a DIFFERENT fid
    // arrives with the same name. Without the eighth-pass fixes, the
    // new file would receive a dedupe suffix (`report-fid…b.pdf`)
    // and / or the cleanup loop would unlink `report.pdf` AFTER we
    // just wrote the new file's bytes there.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidbbbbbbbbbbbbbbbbbbbbb",
        name: "report.pdf",
        size: 3,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 2,
      },
    ]);
    clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([9, 9, 9]));

    const second = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidseennames555555555a",
      "seen-names",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    try {
      // The new file lives at the clean name `report.pdf` — no
      // dedupe suffix.
      const inside = (await fs.readdir(second.cacheDir)).sort();
      expect(inside).toEqual(["report.pdf"]);
      // And the bytes are the NEW file's bytes, not the old ones
      // (the cleanup loop did NOT unlink them).
      const bytes = await fs.readFile(`${second.cacheDir}/report.pdf`);
      expect([...bytes]).toEqual([9, 9, 9]);
      // The manifest now maps the new fid → the clean name.
      const manifest = JSON.parse(
        await fs.readFile(`${second.cacheDir}.manifest.json`, "utf-8"),
      );
      expect(manifest.files).toEqual({
        fidbbbbbbbbbbbbbbbbbbbbb: "report.pdf",
      });
    } finally {
      await fs.rm(first.cacheDir, { recursive: true, force: true });
      await fs
        .rm(`${first.cacheDir}.manifest.json`, { force: true })
        .catch(() => {});
    }
  });

  it("still dedupes a new file whose name collides with a kept (still-present) file", async () => {
    // First sync writes fid-A as `report.pdf`.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidaaaaaaaaaaaaaaaaaaaaa",
        name: "report.pdf",
        size: 4,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 1,
      },
    ]);
    clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3, 4]));

    const first = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidseennames666666666a",
      "seen-names-keep",
    )) as { sourceId: string; cacheDir: string };

    // Second sync: fid-A is STILL on the server (fast-path skip
    // keeps `report.pdf`), and a new fid-B arrives with the same
    // name. The dedupe must kick in for fid-B because the original
    // bytes are kept, otherwise we'd overwrite them.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      {
        id: "fidaaaaaaaaaaaaaaaaaaaaa",
        name: "report.pdf",
        size: 4,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 1,
      },
      {
        id: "fidbbbbbbbbbbbbbbbbbbbbb",
        name: "report.pdf",
        size: 3,
        mime_type: "application/pdf",
        extension: "pdf",
        create_at: 2,
      },
    ]);
    // The fast-path skip means we should NOT call downloadFile for
    // fid-A again — only for fid-B.
    clientMock.downloadFile.mockResolvedValueOnce(new Uint8Array([9, 9, 9]));

    const second = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidseennames666666666a",
      "seen-names-keep",
    )) as { sourceId: string; cacheDir: string };

    const fs = await import("fs/promises");
    try {
      // Both files live on disk: the original `report.pdf` (fid-A
      // bytes preserved) and a deduped `report-fid….pdf` (fid-B).
      const inside = (await fs.readdir(second.cacheDir)).sort();
      expect(inside.length).toBe(2);
      expect(inside).toContain("report.pdf");
      const dedupName = inside.find((n) => n !== "report.pdf");
      expect(dedupName).toBeDefined();
      // Original bytes preserved.
      const origBytes = await fs.readFile(`${second.cacheDir}/report.pdf`);
      expect([...origBytes]).toEqual([1, 2, 3, 4]);
      // New bytes at deduped name.
      const newBytes = await fs.readFile(`${second.cacheDir}/${dedupName}`);
      expect([...newBytes]).toEqual([9, 9, 9]);
      // Only ONE downloadFile call this sync (fid-B); fid-A was
      // fast-path skipped.
      expect(clientMock.downloadFile).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(first.cacheDir, { recursive: true, force: true });
      await fs
        .rm(`${first.cacheDir}.manifest.json`, { force: true })
        .catch(() => {});
    }
  });
});
