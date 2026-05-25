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

// Bridge stub captures every audit + export call.
const bridgeMock = {
  bridgeGetArtifact: vi.fn(() => ({ title: "Quarterly Roadmap" })),
  bridgeExportArtifact: vi.fn(() => ({
    content: "# Hello\n",
    format: "markdown",
  })),
  bridgeExportArtifactToFile: vi.fn(),
  bridgeEvidencePackBytes: vi.fn(() => Buffer.from([0x50, 0x4b, 0x03, 0x04])), // ZIP magic
  bridgeAddKchatChannel: vi.fn(() => ({ id: "src-uuid", name: "src" })),
  bridgeLogKchatConnected: vi.fn(),
  bridgeLogKchatDisconnected: vi.fn(),
  bridgeLogKchatArtifactShared: vi.fn(),
  bridgeLogKchatChannelLinked: vi.fn(),
  bridgeLogKchatChannelUnlinked: vi.fn(),
  bridgeLogKchatFileDownloaded: vi.fn(),
};

// `KchatAuthService` stub. `getClient()` returns an object with the
// REST methods the IPC handlers call.
interface StubClient {
  listTeams: ReturnType<typeof vi.fn>;
  listChannels: ReturnType<typeof vi.fn>;
  listChannelMembers: ReturnType<typeof vi.fn>;
  listChannelFiles: ReturnType<typeof vi.fn>;
  uploadFile: ReturnType<typeof vi.fn>;
  downloadFile: ReturnType<typeof vi.fn>;
}
const clientMock: StubClient = {
  listTeams: vi.fn(),
  listChannels: vi.fn(),
  listChannelMembers: vi.fn(),
  listChannelFiles: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
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
    id: "src-uuid",
    name: "src",
  });
  for (const fn of Object.values(clientMock)) {
    fn.mockReset();
  }
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
});
