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
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as nodeOs from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import { promises as dnsPromises } from "dns";

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
  // `shell.openExternal` is the OS-deeplink surface used by the
  // `kchat:openInDesktop` + `kchat:openDesktopExtensions` handlers
  // (Phase 14 Task 6). The handlers wrap it in try/catch and
  // resolve `{ opened: true, url }` on success, so a no-op stub
  // here is sufficient to exercise the registration surface; the
  // happy-path side-effect (the OS opening the deeplink in KChat
  // Desktop) is end-to-end and asserted by the manual review
  // checklist, not by this unit test. The stub returns a resolved
  // promise so the handlers' `await shell.openExternal(...)`
  // settles synchronously in tests.
  shell: {
    openExternal: vi.fn(() => Promise.resolve()),
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
  // Block B Task 1: napi pass-through called by the WS forwarder,
  // not by any `kchat:*` IPC handler. We still wire it on the
  // bridge mock so the surface matches the production
  // `NativeBridge` shape and IPC tests that construct a fake
  // bridge type-check against it. Tests for the forwarder live in
  // `__tests__/kchatEventForwarder.test.ts`.
  bridgeLogKchatFileEventReceived: vi.fn(),
  // Block B Task 2: napi pass-throughs called by the WS forwarder
  // on every `file_added` event. They are not exercised by any
  // `kchat:*` IPC handler, but the mock surface must mirror the
  // production `NativeBridge` shape so callers (and the type
  // checker) see a consistent type. Default returns:
  //   - `bridgeIsKchatChannelLinked` → `false` (unlinked, the
  //     forwarder's no-op branch — safe default for IPC tests).
  //   - `bridgeIndexKchatFile` → `{ wasLinked: false, indexed:
  //     false, sourceId: "" }`. Tests that exercise the
  //     linked-channel path live in `kchatEventForwarder.test.ts`
  //     and override these.
  bridgeIsKchatChannelLinked: vi.fn(() => false),
  bridgeIndexKchatFile: vi.fn(() => ({
    wasLinked: false,
    indexed: false,
    sourceId: "",
  })),
  // Block B Task 3 (Phase 11): the connect/disconnect IPC
  // handlers call these on the substrate so the ACL projection
  // knows which user id to compare against on the next
  // membership refresh. The full ACL surface
  // (`bridgeRefreshKchatAcl`, `bridgeRevokeKchatSource`, audit
  // helpers) is exercised by the forwarder tests; here we only
  // care that connect/disconnect set/clear the principal.
  bridgeSetKchatPrincipal: vi.fn(),
  bridgeClearKchatPrincipal: vi.fn(),
  bridgeRefreshKchatAcl: vi.fn(() => ({
    outcome: "granted",
    memberCount: 0,
    principalPresent: true,
    // Block B Task 4 (Phase 11): the refresh outcome carries
    // the substrate's cryptoshred counters on the revoke path;
    // non-revoke outcomes always emit zero.
    chunksDropped: 0,
    filesDropped: 0,
    // Fifth-pass Devin Review fix: VACUUM outcome surface;
    // happy-path no-op flows true / undefined.
    vacuumSucceeded: true,
    vacuumError: undefined,
  })),
  // Block B Task 4 (Phase 11): the revoke outcome carries the
  // substrate's cryptoshred counters. The IPC suite does not
  // exercise the revoke path itself (that's a forwarder
  // concern), so the default zero counts here are sufficient.
  bridgeRevokeKchatSource: vi.fn(() => ({
    outcome: "revoked",
    chunksDropped: 0,
    filesDropped: 0,
    vacuumSucceeded: true,
    vacuumError: undefined,
  })),
  bridgeLogKchatAclRefreshed: vi.fn(),
  bridgeLogKchatChannelAccessRevoked: vi.fn(),
  // Block B Task 4 (Phase 11): cryptoshred audit logger;
  // the IPC layer does not invoke it directly (the forwarder
  // does), but the bridge interface requires it to be present.
  bridgeLogKchatSourceCryptoshredded: vi.fn(),
  // Block C Task 4 (Phase 13): historical-backfill bridge
  // surface. The IPC suite exercises the orchestrator via
  // `sources:backfillKchatChannel`; defaults below produce a
  // clean fresh-walk-with-end-of-history result (no resume
  // cursor, REST loop terminates on first page). Individual
  // tests override these to drive specific paths.
  bridgeGetKchatBackfillState: vi.fn(() => ({
    outcome: "idle",
    sourceId: "src-uuid",
    oldestPostId: undefined,
    completedAt: undefined,
  })),
  bridgeIngestKchatBackfillPage: vi.fn(() => ({
    outcome: "ingested",
    sourceId: "src-uuid",
    postsIngested: 0,
    postsUnchanged: 0,
    postsSkippedRevoked: 0,
    oldestPostIdInPage: undefined,
  })),
  bridgeMarkKchatBackfillComplete: vi.fn(() => ({
    outcome: "completed",
    sourceId: "src-uuid",
  })),
  bridgeLogKchatBackfillStarted: vi.fn(),
  bridgeLogKchatBackfillPageIngested: vi.fn(),
  bridgeLogKchatBackfillCompleted: vi.fn(),
  bridgeLogKchatBackfillAborted: vi.fn(),
  // Block D Task 1 (Phase 14): retrieval bridge mocks.
  bridgeSearchKchatPosts: vi.fn(() => [] as Array<unknown>),
  bridgeLogKchatPostSearchExecuted: vi.fn(),
  // Phase 13 Theme 2 Task 13: thread-context retrieval mock.
  bridgeFetchKchatThreadContext: vi.fn(() => [] as Array<unknown>),
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
  // Block C Task 4 (Phase 13): the historical-backfill
  // orchestrator drives this REST method page-by-page.
  getPostsForChannel: ReturnType<typeof vi.fn>;
  // Phase 13 Theme 2 Task 9: name-enrichment helpers wired into
  // `kchat:searchPosts` to render `@username` + `#channel` in
  // citation rows. Default: reject — tests that exercise the
  // enrichment path set explicit implementations; other tests
  // verify the catch-and-degrade posture via the rejection.
  getUsersByIds: ReturnType<typeof vi.fn>;
  getChannel: ReturnType<typeof vi.fn>;
  scrubMessage: ReturnType<typeof vi.fn>;
}
const clientMock: StubClient = {
  listTeams: vi.fn(),
  listChannels: vi.fn(),
  listChannelMembers: vi.fn(),
  listChannelFiles: vi.fn(),
  uploadFile: vi.fn(),
  downloadFile: vi.fn(),
  getPostsForChannel: vi.fn(),
  getUsersByIds: vi.fn(),
  getChannel: vi.fn(),
  // Default: pass-through. Tests that need to assert scrub
  // behaviour replace this implementation in their own `beforeEach`.
  scrubMessage: vi.fn((msg: string) => msg),
};
const serviceMock = {
  getClient: () => clientMock,
  getState: vi.fn(),
  // Phase 13 Theme 2 Task 9: the IPC layer subscribes to status
  // transitions to clear the name caches on disconnect. Tests
  // don't drive this subscriber, so we return a no-op
  // unsubscribe so the registration path completes cleanly.
  onStatusChange: vi.fn(() => () => {}),
  connect: vi.fn(),
  disconnect: vi.fn(),
};

vi.mock("../appState", () => ({
  getBridge: () => bridgeMock,
  getKchatAuthService: () => serviceMock,
  // Block B Task 4 (Phase 11) second-pass Devin Review
  // ANALYSIS_0002: `registerKchatHandlers` populates this slot
  // with the auto-resync closure that powers the forwarder's
  // `outcome=regranted` re-sync hook. The IPC test suite
  // doesn't exercise the forwarder side of the contract, so we
  // accept the registration into a no-op stub — the test still
  // verifies the IPC handlers themselves register correctly.
  setKchatChannelResyncImpl: vi.fn(),
  // Block C Task 4 (Phase 13): the backfill orchestrator slot
  // installed by `registerKchatHandlers`. Same pattern as the
  // resync slot above — the IPC handler is exercised directly
  // by the tests (via `sources:backfillKchatChannel`), so we
  // only need a no-op sink for the slot installation.
  setKchatBackfillImpl: vi.fn(),
}));

import {
  registerKchatHandlers,
  _resetKchatNameCachesForTest,
} from "../ipc/kchat";
import { enforceKchatServerUrl } from "../kchat/ssrfGuard";
import * as ssrfGuardModule from "../kchat/ssrfGuard";
import type { KchatBackfillRunOutcome } from "../../shared/types";

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
  // ANALYSIS_0003 (Devin Review pass 4 on d0731ec): the
  // `runningBackfillCounters` / `inFlightBackfillKchatChannel`
  // maps are scoped inside the `registerKchatHandlers` closure
  // and reset automatically on every `registerKchatHandlers()`
  // call below. The `KCHAT_USERNAME_CACHE` /
  // `KCHAT_CHANNEL_NAME_CACHE` are module-scoped (production-
  // correct: a live `KchatAuthService` reconnect via the status
  // listener must keep clearing the same cache instance the
  // enrichment path reads), so they DO NOT reset automatically.
  // Closing the footgun before it bites a future test author:
  // reset the module-scoped caches AND tear down the status
  // listener before re-installing the IPC layer, so every test
  // starts from a clean module state regardless of whether the
  // test itself remembers to call `_resetKchatNameCachesForTest`
  // explicitly. The redundant per-test invocations elsewhere in
  // the file are intentionally kept as documentation that the
  // test exercises cache state.
  _resetKchatNameCachesForTest();
  registerKchatHandlers();
});

describe("kchat IPC registration", () => {
  // Devin Review pass 2 on f686e5c (ANALYSIS_0004): the master list
  // is the canonical registration contract — any new `kchat:*` /
  // `sources:*` channel added to `registerKchatHandlers` must be
  // listed here. The dedicated per-channel tests further down still
  // exercise behaviour, but the master list is what catches a future
  // refactor that accidentally drops a registration entirely.
  //
  // Phase 14 replaces the Phase 13 extension-bridge channels
  // (`kchat:extensionStatus`, `kchat:extensionConnect`,
  // `kchat:extensionDisconnect`) with the three deeplink / local-
  // API affordances the Settings card + sidebar invoke:
  // `kchat:openInDesktop` (renderer → main → `shell.openExternal`),
  // `kchat:openDesktopExtensions` (zero-arg shortcut to the
  // `kchat://app/settings/extensions` deeplink), and
  // `kchat:desktopBridgeStatus` (renderer-facing projection of the
  // localhost API server's last-heartbeat snapshot).
  const EXPECTED_KCHAT_CHANNELS: readonly string[] = [
    "kchat:isAvailable",
    "kchat:status",
    "kchat:connect",
    "kchat:disconnect",
    "kchat:openInDesktop",
    "kchat:openDesktopExtensions",
    "kchat:desktopBridgeStatus",
    "kchat:listTeams",
    "kchat:listChannels",
    "kchat:listMembers",
    "kchat:listChannelFiles",
    "kchat:shareArtifact",
    "sources:addKchatChannel",
    "sources:backfillKchatChannel",
    "kchat:backfillProgress",
    "kchat:searchPosts",
    "kchat:fetchThreadContext",
  ];

  it("registers every kchat:* / sources:* channel from the master list", () => {
    const channels = handleMock.mock.calls.map((c) => c[0] as string);
    for (const want of EXPECTED_KCHAT_CHANNELS) {
      expect(channels).toContain(want);
    }
  });

  it("does not register any unexpected `kchat:*` / `sources:addKchatChannel` / `sources:backfillKchatChannel` channels", () => {
    // Counter-assertion that makes the master list authoritative in
    // BOTH directions: adding a channel to `registerKchatHandlers`
    // without listing it in `EXPECTED_KCHAT_CHANNELS` also fails the
    // suite, so the contract can't silently drift.
    const channels = handleMock.mock.calls.map((c) => c[0] as string);
    const kchatChannels = channels.filter(
      (c) =>
        c.startsWith("kchat:") ||
        c === "sources:addKchatChannel" ||
        c === "sources:backfillKchatChannel",
    );
    const expectedSet = new Set(EXPECTED_KCHAT_CHANNELS);
    const unexpected = kchatChannels.filter((c) => !expectedSet.has(c));
    expect(unexpected).toEqual([]);
  });

  it("every registered kchat:* / sources:* channel has a matching ipcRenderer.invoke in preload.ts", () => {
    // Source-text regression: the preload is the only surface through
    // which the renderer can reach these channels. A handler that's
    // registered in `registerKchatHandlers` but missing from
    // `preload.ts` is silently unreachable from the renderer.
    // Reading source text avoids needing to spin up a real Electron
    // `contextBridge` (same pattern as sandboxPreloadContract.test.ts).
    // Uses the top-of-file `nodeFs` / `nodePath` imports rather than
    // inline `require()` / `await import()` calls so the file doesn't
    // need `eslint-disable` directives that drift against
    // `@typescript-eslint` rule renames between major versions (the
    // prior `no-require-imports` directive name didn't match the
    // project's active `no-var-requires` rule and broke CI lint), and
    // so the test doesn't need to be marked `async` purely to
    // satisfy the dynamic-import pattern when the underlying
    // `readFileSync` is synchronous. Main resolved the original lint
    // breakage with `const fs = await import("fs")`; this branch
    // converged on reusing the existing top-of-file imports because
    // the file already imports `nodeFs` / `nodePath` for the same
    // purpose elsewhere, making the dynamic imports dead weight.
    const preloadSource: string = nodeFs.readFileSync(
      nodePath.resolve(__dirname, "..", "preload.ts"),
      "utf-8",
    );
    for (const channel of EXPECTED_KCHAT_CHANNELS) {
      expect(
        preloadSource,
        `preload.ts must contain ipcRenderer.invoke("${channel}") — the renderer has no way to reach this handler otherwise`,
      ).toContain(`"${channel}"`);
    }
  });

  it("registers each `kchat:*` / `sources:*` channel exactly once (no double-registration)", () => {
    // Defence-in-depth against a refactor that calls
    // `registerKchatHandlers` twice (e.g. hot-reload regression).
    // `idempotentHandle` is supposed to guard this at runtime, but
    // the test makes the invariant a contract.
    const channels = handleMock.mock.calls.map((c) => c[0] as string);
    const counts = new Map<string, number>();
    for (const c of channels) {
      if (
        c.startsWith("kchat:") ||
        c === "sources:addKchatChannel" ||
        c === "sources:backfillKchatChannel"
      ) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    for (const [channel, count] of counts) {
      expect(count, `${channel} registered ${count} times`).toBe(1);
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
    // Block B Task 3 (Phase 11): the substrate must learn whose
    // membership matters for ACL projection on the next refresh.
    expect(bridgeMock.bridgeSetKchatPrincipal).toHaveBeenCalledWith(
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

  // The "allows internal URLs when TESSERA_KCHAT_ALLOW_INTERNAL=1 is
  // set (dev opt-out)" test that previously lived here used
  // `process.env.TESSERA_KCHAT_ALLOW_INTERNAL = "1"` + a `finally`
  // restore to exercise the bypass branch. That pattern was
  // sequential-only under shared vitest worker pools — if a
  // parallel test read `TESSERA_KCHAT_ALLOW_INTERNAL` between this
  // test's mutation and restoration, it would see the wrong value.
  // Migrated to direct injection via
  // `enforceKchatServerUrl(url, { allowInternal })` — see the
  // `SSRF guard dev-opt-out (direct injection)` describe block
  // below for the replacement coverage. Same architectural pattern
  // as PR #57 (`ExtensionSocketDiscovery`) and PR #59
  // (`vaultCrypto` / `sidecar` platform injection).
  //
  // The IPC-integration coverage for the bypass branch is preserved
  // by the "IPC handler delegates to the SSRF guard …" test below,
  // which uses `vi.spyOn(ssrfGuardModule, "enforceKchatServerUrl")`
  // to stub the bypass + verify the wiring — no env mutation needed.

  it("IPC handler delegates to enforceKchatServerUrl with the operator-typed url and no opts (env-driven default preserved)", async () => {
    // Restores the IPC-integration coverage that the env-mutating
    // bypass test used to provide, without mutating `process.env`.
    // The Devin Review Pass 3 finding flagged that the new
    // direct-injection tests cover the guard contract precisely
    // but don't verify the IPC handler's wiring to the guard. Per
    // standing directive (correct long-term fix, not the easy
    // patch), this test pins the wiring contract via a module-
    // namespace spy: the IPC handler MUST call
    // `enforceKchatServerUrl(url)` with no second argument so the
    // env-driven default `process.env.TESSERA_KCHAT_ALLOW_INTERNAL`
    // remains the production opt-out mechanism. A future refactor
    // that accidentally passes `{ allowInternal: false }` would
    // silently break the documented dev opt-out and this test
    // would catch it.
    const spy = vi
      .spyOn(ssrfGuardModule, "enforceKchatServerUrl")
      .mockResolvedValue(new URL("http://127.0.0.1:8080/"));
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
      // Verify the wiring: the IPC handler must call the guard
      // with the raw URL and NO opts (so the env-driven default
      // takes effect in production). Asserting on `spy.mock.calls`
      // directly catches a future regression where someone wires
      // `enforceKchatServerUrl(url, { allowInternal: false })` or
      // `{ readEnv: () => undefined }` and accidentally bypasses
      // the documented dev opt-out.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(["http://127.0.0.1:8080/"]);
      expect(serviceMock.connect).toHaveBeenCalledWith(
        "PAT",
        "http://127.0.0.1:8080/",
      );
    } finally {
      spy.mockRestore();
    }
  });
});

// Phase 14-followup: the dev-opt-out branch of `enforceKchatServerUrl`
// is now tested directly with an injected `allowInternal` instead of
// via `process.env` mutation through the `kchat:connect` IPC handler.
// Direct tests are higher-leverage because:
//   - They don't mutate `process.env` (parallel-safe under
//     `--pool=threads`).
//   - They pin the guard's contract precisely (return parsed URL on
//     bypass, throw with a renderer-safe error otherwise).
//   - They cover the explicit-`false`-overrides-env case that the
//     prior IPC-level test couldn't reach (the IPC handler always
//     reads from env, not from a caller-supplied flag).
// Production behaviour is preserved by the nullish-coalescing
// default in `enforceKchatServerUrl` (`opts?.allowInternal ??
// process.env.TESSERA_KCHAT_ALLOW_INTERNAL === "1"`) — the
// production caller in `ipc/kchat.ts` passes no `opts` and gets the
// env-driven default unchanged.
describe("SSRF guard dev-opt-out (direct injection)", () => {
  it("returns the parsed URL when allowInternal=true (bypass enabled)", async () => {
    const out = await enforceKchatServerUrl("http://127.0.0.1:8080/", {
      allowInternal: true,
    });
    expect(out.hostname).toBe("127.0.0.1");
    expect(out.port).toBe("8080");
    expect(out.protocol).toBe("http:");
  });

  it("rejects internal URLs when allowInternal=false (bypass disabled)", async () => {
    await expect(
      enforceKchatServerUrl("http://127.0.0.1:8080/", {
        allowInternal: false,
      }),
    ).rejects.toThrow(/private, loopback, or link-local/);
  });

  it("rejects internal URLs when no opts and readEnv returns undefined (env-unset)", async () => {
    // Deterministic coverage of the env-unset production-default
    // branch: no `opts.allowInternal`, `readEnv` simulates an
    // unset env. The prior version of this test depended on the
    // CI process env actually being undefined; the `readEnv`
    // injection makes it independent of ambient env state.
    await expect(
      enforceKchatServerUrl("http://127.0.0.1:8080/", {
        readEnv: () => undefined,
      }),
    ).rejects.toThrow(/private, loopback, or link-local/);
  });

  it("allows internal URLs when no opts and readEnv returns \"1\" (env-set)", async () => {
    // Symmetric coverage of the env-set production-default branch:
    // no `opts.allowInternal`, `readEnv` simulates the documented
    // dev-opt-out `TESSERA_KCHAT_ALLOW_INTERNAL=1`. This is the
    // path the production caller in `ipc/kchat.ts` takes when a
    // developer sets the env locally; previously couldn't be
    // tested without mutating `process.env`.
    const out = await enforceKchatServerUrl("http://127.0.0.1:8080/", {
      readEnv: () => "1",
    });
    expect(out.hostname).toBe("127.0.0.1");
  });

  it("treats readEnv values other than \"1\" as not-set (strict equality)", async () => {
    // Pins the strict `=== "1"` comparison in the guard. A future
    // refactor that loosens this (e.g. `=== "true"` or truthy
    // coercion) would silently widen the bypass surface — e.g.
    // setting `TESSERA_KCHAT_ALLOW_INTERNAL=0` to "explicitly
    // disable" would unexpectedly enable the bypass under truthy
    // coercion. Tests three off-spec strings that all map to
    // "not the dev opt-out".
    for (const v of ["0", "true", "yes"]) {
      await expect(
        enforceKchatServerUrl("http://127.0.0.1:8080/", {
          readEnv: () => v,
        }),
      ).rejects.toThrow(/private, loopback, or link-local/);
    }
  });

  it("explicit allowInternal=false overrides readEnv=\"1\" (nullish-coalescing precedence)", async () => {
    // Pins the `??` (nullish-coalescing) precedence: when both
    // `opts.allowInternal` and the env are set, the explicit
    // caller-supplied value wins. The prior IPC-level test
    // couldn't exercise this case (the IPC handler always
    // forwards to `enforceKchatServerUrl(url)` with no opts).
    // Without the `readEnv` injection point, this test would
    // either have to mutate `process.env` (race-prone) or test a
    // structurally-guaranteed-true case (`false ?? undefined ===
    // false`) that wouldn't catch a regression from `??` to `||`.
    // With `readEnv: () => "1"`, the test exercises the actual
    // regression case: `false ?? <env-says-true>` must stay `false`.
    // If the operator regresses to `||`, this test fires immediately
    // because `false || true === true` → the call would resolve
    // instead of throw.
    await expect(
      enforceKchatServerUrl("http://127.0.0.1:8080/", {
        allowInternal: false,
        readEnv: () => "1",
      }),
    ).rejects.toThrow(/private, loopback, or link-local/);
  });

  it("explicit allowInternal=true overrides readEnv=undefined (no false fallthrough)", async () => {
    // Symmetric to the `false`-overrides-env-1 test above: an
    // explicit `true` from a caller must NOT fall through to
    // `readEnv` even when the env is unset. With `??`, this is
    // guaranteed (`true ?? anything === true`). With `||`, it
    // would also pass (`true || anything === true`) — so this
    // test is less defensive than the `false`-overrides-env-1
    // case, but it documents the symmetric direction and would
    // catch a hypothetical regression that drops the
    // caller-supplied value entirely (e.g.
    // `readEnv("X") === "1"` instead of `opts?.allowInternal ??
    // readEnv("X") === "1"`).
    const out = await enforceKchatServerUrl("http://127.0.0.1:8080/", {
      allowInternal: true,
      readEnv: () => undefined,
    });
    expect(out.hostname).toBe("127.0.0.1");
  });

  it("does not mutate process.env when called (parallel-safety meta-test)", async () => {
    // The whole point of the injection refactor: the function
    // doesn't touch `process.env`. If a future refactor
    // reintroduces env mutation (e.g. a cache line like
    // `process.env.X = "1"`), this test catches it immediately.
    // Same architectural pattern as the
    // `extensionSocketPath.test.ts` parallel-safety meta-test
    // added in PR #57. Runs both the explicit-`true` path and
    // the env-driven path to cover both branches of the
    // `??` evaluation.
    const snapshot = Object.assign({}, process.env);
    await enforceKchatServerUrl("http://127.0.0.1:8080/", {
      allowInternal: true,
    });
    await enforceKchatServerUrl("http://127.0.0.1:8080/", {
      readEnv: () => "1",
    });
    expect(process.env).toEqual(snapshot);
  });

  it("default readEnv reads from process.env (production wiring smoke test)", async () => {
    // Verifies the no-opts production path actually wires through
    // to `process.env` (not some hardcoded `undefined`). Reads
    // `process.env.TESSERA_KCHAT_ALLOW_INTERNAL` (which is
    // typically undefined in CI) and asserts the no-opts call
    // behaves as if `readEnv` returned that same value. Does NOT
    // mutate — pure read-only smoke test of the default wiring.
    const envValue = process.env.TESSERA_KCHAT_ALLOW_INTERNAL;
    const expectsBypass = envValue === "1";
    if (expectsBypass) {
      const out = await enforceKchatServerUrl("http://127.0.0.1:8080/");
      expect(out.hostname).toBe("127.0.0.1");
    } else {
      await expect(
        enforceKchatServerUrl("http://127.0.0.1:8080/"),
      ).rejects.toThrow(/private, loopback, or link-local/);
    }
  });
});

// Ninth-pass Devin Review BUG_0001: the IPv6 ULA / link-local
// prefix checks (`fc`/`fd`/`fe80:`) must NOT misfire on regular DNS
// hostnames that happen to begin with the same two-letter prefix.
// Real-world examples flagged by the bot: `fcc.example.com`,
// `fdic.gov`, `fchat.example.com`. A hostname-form string never
// contains `:`, so we gate the IPv6 prefix match on `host.includes(":")`.
describe("kchat:connect — IPv6 ULA prefix check does not false-positive on DNS hostnames (ninth-pass invariant)", () => {
  const lookalikeHosts = [
    "https://fcc.example.com/",
    "https://fdic.gov/",
    "https://fchat.example.com/",
    "https://fe80-corp.io/",
  ];
  for (const u of lookalikeHosts) {
    it(`accepts ${u} as a public hostname (literal-IP check must not match)`, async () => {
      // Pin DNS to a public IP so the second-layer DNS guard also
      // passes and the call reaches the service. Tests asserting
      // the literal-IP layer alone would only assert "not
      // private/loopback" — we want a stronger end-to-end
      // assertion that the connect path completes.
      // `dns.lookup` is overloaded — with `{ all: true }` it
      // returns `LookupAddress[]`, with a string it returns a
      // single `LookupAddress`. We always call with `{ all: true }`,
      // so pin the spy to that branch via a typed cast.
      const spy = vi
        .spyOn(dnsPromises, "lookup")
        .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
      try {
        serviceMock.connect.mockResolvedValue({
          id: "user1234567890abcdefgh",
          username: "pub",
          email: "p@e.com",
          first_name: "P",
          last_name: "U",
        });
        const out = await handler("kchat:connect")(EVENT, "PAT", u);
        expect(out).toMatchObject({ id: "user1234567890abcdefgh" });
        expect(serviceMock.connect).toHaveBeenCalledWith("PAT", u);
      } finally {
        spy.mockRestore();
      }
    });
  }
});

// Ninth-pass Devin Review ANALYSIS_0002: the SSRF guard's DNS-
// based check must NOT silently pass when the lookup throws a
// non-ENOTFOUND error. A malicious or slow DNS resolver could time
// out our pre-flight lookup but still hand `fetch` a private IP on
// the actual connect, bypassing the rebinding mitigation entirely.
// Correct posture: fail-closed on any DNS error except
// ENOTFOUND/EAI_NONAME (those mean "host doesn't exist" and the
// network layer will report it cleanly anyway).
describe("kchat:connect — DNS error fail-closed posture (ninth-pass invariant)", () => {
  it("allows ENOTFOUND through so the network layer can surface a clean error", async () => {
    const spy = vi.spyOn(dnsPromises, "lookup").mockImplementation(() => {
      const e = new Error("getaddrinfo ENOTFOUND") as Error & {
        code: string;
      };
      e.code = "ENOTFOUND";
      throw e;
    });
    try {
      serviceMock.connect.mockResolvedValue({
        id: "user1234567890abcdefgh",
        username: "ku",
        email: "k@u.com",
        first_name: "K",
        last_name: "U",
      });
      const out = await handler(
        "kchat:connect",
      )(EVENT, "PAT", "https://nope.invalid/");
      expect(out).toMatchObject({ id: "user1234567890abcdefgh" });
      expect(serviceMock.connect).toHaveBeenCalledWith(
        "PAT",
        "https://nope.invalid/",
      );
    } finally {
      spy.mockRestore();
    }
  });

  const failClosedCodes = ["ETIMEOUT", "EAI_AGAIN", "ESERVFAIL", "ECONNREFUSED"];
  for (const code of failClosedCodes) {
    it(`fails closed on DNS error '${code}' (does not call the service)`, async () => {
      const spy = vi.spyOn(dnsPromises, "lookup").mockImplementation(() => {
        const e = new Error(`getaddrinfo ${code}`) as Error & {
          code: string;
        };
        e.code = code;
        throw e;
      });
      try {
        await expect(
          handler("kchat:connect")(EVENT, "PAT", "https://kchat.example.com/"),
        ).rejects.toThrow(/SSRF guard|DNS error/);
        expect(serviceMock.connect).not.toHaveBeenCalled();
        expect(bridgeMock.bridgeLogKchatConnected).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  }

  it("fails closed on an unexpected non-coded DNS error", async () => {
    const spy = vi
      .spyOn(dnsPromises, "lookup")
      .mockImplementation(() => {
        throw new Error("DNS layer exploded");
      });
    try {
      await expect(
        handler("kchat:connect")(EVENT, "PAT", "https://kchat.example.com/"),
      ).rejects.toThrow(/SSRF guard|DNS error/);
      expect(serviceMock.connect).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// Eleventh-pass Devin Review ANALYSIS_0002: the SSRF guard's literal-
// IP check must cover the non-dotted-decimal IPv4 forms that
// `getaddrinfo` accepts (and resolves to `127.0.0.1` etc) but a
// naive dotted-quad regex misses. Without coverage at the literal
// layer, a request like `http://0x7f000001/` would skip the literal
// check entirely and rely solely on the DNS layer; if the DNS
// resolver canonicalises to dotted-decimal the DNS check still
// catches it, but defense-in-depth requires the literal layer to
// match too. We pin `dnsPromises.lookup` to a *public* IP per case
// so the assertion is "the literal check fires" rather than "the
// DNS check catches it" — that way a future regression in the
// literal check is detected immediately rather than masked.
describe("kchat:connect — SSRF guard catches non-dotted-decimal IPv4 forms (eleventh-pass invariant)", () => {
  const nonDottedInternalUrls = [
    "http://0x7f000001/", // hex single-integer (127.0.0.1)
    "http://2130706433/", // decimal single-integer (127.0.0.1)
    "http://0177.0.0.1/", // dotted-octal (127.0.0.1)
    "http://127.1/", // 2-part dotted (127.0.0.1)
    "http://0xa.0.0.5/", // mixed: hex first octet (10.0.0.5)
    "http://0x0a000005/", // hex single-integer (10.0.0.5)
    "http://3232235521/", // decimal single-integer (192.168.0.1)
  ];
  for (const u of nonDottedInternalUrls) {
    it(`rejects ${u} at the literal-IP layer (before DNS)`, async () => {
      // Pin DNS to a public IP — if the test fails despite this,
      // it means the DNS layer was relied on to catch the address,
      // which is exactly the defense-in-depth gap we want to close.
      const spy = vi
        .spyOn(dnsPromises, "lookup")
        .mockResolvedValue([
          { address: "93.184.216.34", family: 4 },
        ] as never);
      try {
        await expect(
          handler("kchat:connect")(EVENT, "PAT", u),
        ).rejects.toThrow(/private|loopback|link-local/i);
        expect(serviceMock.connect).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  }

  it("still accepts decimal single-integer that maps to a PUBLIC IPv4", async () => {
    // 1.1.1.1 = 16843009. Public DNS-resolvable address, must NOT
    // be rejected by the literal check.
    const spy = vi
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([{ address: "1.1.1.1", family: 4 }] as never);
    try {
      serviceMock.connect.mockResolvedValue({
        id: "user1234567890abcdefgh",
        username: "pub",
        email: "p@e.com",
        first_name: "P",
        last_name: "U",
      });
      const out = await handler("kchat:connect")(
        EVENT,
        "PAT",
        "http://16843009/",
      );
      expect(out).toMatchObject({ id: "user1234567890abcdefgh" });
    } finally {
      spy.mockRestore();
    }
  });
});

// Twelfth-pass Devin Review ANALYSIS_0002: IPv4-mapped IPv6 has two
// textual forms — `::ffff:<dotted-decimal>` (the legacy / human form
// `inet_pton` emits) AND `::ffff:<hi-hextet>:<lo-hextet>` (the
// canonical compact-hex form produced by some browsers and resolvers
// that aren't aware of the mapped-IPv4 special case). The dotted
// form was already caught by the literal-IP check; the hex form
// previously fell through to the DNS layer. We now canonicalise the
// hex form back to dotted IPv4 and recurse the v4 check so both
// shapes are rejected at the literal layer (defense-in-depth — the
// literal check is the first line of defence and shouldn't lean on
// DNS).
describe("kchat:connect — SSRF guard catches hex-form IPv4-mapped IPv6 literals (twelfth-pass invariant)", () => {
  const hexMappedInternalUrls = [
    "http://[::ffff:7f00:1]/", // 127.0.0.1 (loopback)
    "http://[::ffff:0a00:5]/", // 10.0.0.5 (RFC1918)
    "http://[::ffff:c0a8:1]/", // 192.168.0.1 (RFC1918)
    "http://[::ffff:a9fe:1]/", // 169.254.0.1 (link-local)
    "http://[::ffff:6440:1]/", // 100.64.0.1 (CGNAT)
  ];
  for (const u of hexMappedInternalUrls) {
    it(`rejects ${u} at the literal-IP layer (before DNS)`, async () => {
      // Pin DNS to a public IP — if the test fails despite this it
      // means the DNS layer was relied on to catch the address,
      // exactly the defense-in-depth gap we want to close.
      const spy = vi
        .spyOn(dnsPromises, "lookup")
        .mockResolvedValue([
          { address: "93.184.216.34", family: 4 },
        ] as never);
      try {
        await expect(
          handler("kchat:connect")(EVENT, "PAT", u),
        ).rejects.toThrow(/private|loopback|link-local/i);
        expect(serviceMock.connect).not.toHaveBeenCalled();
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  }

  it("still accepts hex-form mapped IPv6 that decodes to a public IPv4", async () => {
    // `::ffff:5db8:d822` → 93.184.216.34 (example.com)
    const spy = vi
      .spyOn(dnsPromises, "lookup")
      .mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as never);
    try {
      serviceMock.connect.mockResolvedValue({
        id: "user1234567890abcdefgh",
        username: "pub",
        email: "p@e.com",
        first_name: "P",
        last_name: "U",
      });
      const out = await handler("kchat:connect")(
        EVENT,
        "PAT",
        "http://[::ffff:5db8:d822]/",
      );
      expect(out).toMatchObject({ id: "user1234567890abcdefgh" });
    } finally {
      spy.mockRestore();
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
    // Block B Task 3 (Phase 11): clearing the principal prevents
    // a stale id from being compared against future membership
    // refreshes after the user has disconnected.
    expect(bridgeMock.bridgeClearKchatPrincipal).toHaveBeenCalledTimes(1);
  });

  it("does NOT audit when nothing was connected", async () => {
    serviceMock.disconnect.mockReturnValue(null);
    await handler("kchat:disconnect")(EVENT);
    expect(bridgeMock.bridgeLogKchatDisconnected).not.toHaveBeenCalled();
    // Block B Task 3 (Phase 11): when there was no connection
    // to drop, the principal was never set in this session, so
    // the handler skips the bridge-clear too. This mirrors the
    // audit-row gate on the same branch — both side-effects are
    // gated on `userId` being non-null.
    expect(bridgeMock.bridgeClearKchatPrincipal).not.toHaveBeenCalled();
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

describe("sources:addKchatChannel — per-channel-id in-flight dedupe (tenth-pass invariant)", () => {
  // Tenth-pass Devin Review ANALYSIS_0006.
  //
  // Two concurrent `sources:addKchatChannel` invocations for the SAME
  // channelId must collapse into a single piece of work. If the
  // dedupe is missing, both calls would walk the file roster
  // independently, race on `fs.writeFile`s, and produce duplicate
  // `KchatChannelLinked` audit rows for what users perceive as one
  // operation. Calls for DIFFERENT channelIds must NOT block each
  // other.

  it("collapses two concurrent calls for the same channelId into a single sync (one download per file, one bridgeAddKchatChannel, one audit row)", async () => {
    // Both calls share the same channelId. We stall the first
    // listChannelFiles long enough for the second invocation to land
    // and discover the in-flight Promise.
    let release: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    clientMock.listChannelFiles.mockImplementationOnce(
      async (_id: string, _page: number, _per: number) => {
        await blocker;
        return [
          {
            id: "fidconcurrentaaaaaaaa",
            name: "design.md",
            size: 5,
            mime_type: "text/markdown",
            extension: "md",
            create_at: 1,
          },
        ];
      },
    );
    clientMock.downloadFile.mockResolvedValue(new Uint8Array([1, 2, 3, 4, 5]));

    const first = handler("sources:addKchatChannel")(
      EVENT,
      "chidconcurrent000000aa",
      "concurrent-channel",
    ) as Promise<{ sourceId: string; cacheDir: string }>;
    const second = handler("sources:addKchatChannel")(
      EVENT,
      "chidconcurrent000000aa",
      "concurrent-channel",
    ) as Promise<{ sourceId: string; cacheDir: string }>;

    // Let the work proceed.
    release();
    const [a, b] = await Promise.all([first, second]);

    // Identical outcome — both callers see the same sourceId and
    // cacheDir because they share the same Promise.
    expect(a).toEqual(b);
    // Only one pagination loop ran.
    expect(clientMock.listChannelFiles).toHaveBeenCalledTimes(1);
    // Only one downloadFile call (the single file).
    expect(clientMock.downloadFile).toHaveBeenCalledTimes(1);
    // The native bridge sees a single `bridgeAddKchatChannel` call
    // and a single `bridgeLogKchatChannelLinked` audit append.
    expect(bridgeMock.bridgeAddKchatChannel).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeLogKchatChannelLinked).toHaveBeenCalledTimes(1);

    const fs = await import("fs/promises");
    await fs.rm(a.cacheDir, { recursive: true, force: true });
    await fs
      .rm(`${a.cacheDir}.manifest.json`, { force: true })
      .catch(() => {});
  });

  it("does NOT block calls for a different channelId — both syncs run independently and in parallel", async () => {
    let releaseA: () => void = () => {};
    const blockerA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    // First call (channel A) stalls; second call (channel B) must
    // proceed without waiting on it.
    clientMock.listChannelFiles
      .mockImplementationOnce(
        async (_id: string, _page: number, _per: number) => {
          await blockerA;
          return [];
        },
      )
      .mockImplementationOnce(
        async (_id: string, _page: number, _per: number) => [],
      );

    const a = handler("sources:addKchatChannel")(
      EVENT,
      "chidparallelaaaaaaaaaa",
      "channel-a",
    ) as Promise<{ sourceId: string; cacheDir: string }>;
    const b = handler("sources:addKchatChannel")(
      EVENT,
      "chidparallelbbbbbbbbbb",
      "channel-b",
    ) as Promise<{ sourceId: string; cacheDir: string }>;

    // Channel B must settle WITHOUT releasing the channel-A blocker.
    // We yield twice to let microtasks drain (downloadFile → write →
    // bridgeAddKchatChannel) and then assert B has resolved.
    const bSettled = await Promise.race([
      b.then(() => "b-settled" as const),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 200),
      ),
    ]);
    expect(bSettled).toBe("b-settled");

    // Now finish A.
    releaseA();
    const aResult = await a;
    const bResult = await b;
    expect(aResult.cacheDir).not.toBe(bResult.cacheDir);
    expect(clientMock.listChannelFiles).toHaveBeenCalledTimes(2);

    const fs = await import("fs/promises");
    await fs.rm(aResult.cacheDir, { recursive: true, force: true });
    await fs.rm(bResult.cacheDir, { recursive: true, force: true });
    await fs
      .rm(`${aResult.cacheDir}.manifest.json`, { force: true })
      .catch(() => {});
    await fs
      .rm(`${bResult.cacheDir}.manifest.json`, { force: true })
      .catch(() => {});
  });

  it("releases the in-flight slot on rejection so a retry can run a fresh sync", async () => {
    // First call fails; the slot must be released. The retry sees
    // an empty roster (no in-flight Promise) and runs fresh —
    // resulting in TWO listChannelFiles calls overall, not one.
    clientMock.listChannelFiles
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValueOnce([]);

    await expect(
      handler("sources:addKchatChannel")(
        EVENT,
        "chidretrycccccccccccc",
        "retry-channel",
      ),
    ).rejects.toThrow(/transient network error/);

    // Retry succeeds.
    const out = (await handler("sources:addKchatChannel")(
      EVENT,
      "chidretrycccccccccccc",
      "retry-channel",
    )) as { sourceId: string; cacheDir: string };
    expect(out.sourceId).toBeDefined();
    expect(clientMock.listChannelFiles).toHaveBeenCalledTimes(2);

    const fs = await import("fs/promises");
    await fs.rm(out.cacheDir, { recursive: true, force: true });
    await fs
      .rm(`${out.cacheDir}.manifest.json`, { force: true })
      .catch(() => {});
  });

  it("validates renderer input BEFORE consulting the in-flight map (malformed channelId rejects immediately)", async () => {
    // A malformed channelId must throw at the assert-step regardless
    // of whether another in-flight sync exists for some other id.
    // We assert this by firing a malformed call with no pending work
    // in the map.
    await expect(
      handler("sources:addKchatChannel")(EVENT, "!!!notvalid!!!", "bad-id"),
    ).rejects.toThrow(/channelId/);
    expect(clientMock.listChannelFiles).not.toHaveBeenCalled();
  });
});

// ─── Block C Task 4 (Phase 13) — `sources:backfillKchatChannel` ──────
//
// The orchestrator walks `getPostsForChannel` page-by-page from
// the persisted cursor (or from the newest post on a fresh walk)
// and feeds each page to `bridgeIngestKchatBackfillPage`. The
// tests below pin every branch of the loop: end-of-history,
// resume, short-circuit at state read (already_completed /
// unlinked / access_revoked), mid-walk access revocation, REST
// error, and the per-channel safety cap. Audit-row emission is
// asserted directly against the bridge mock.

const CHANNEL_ID = "chidbackfilloraaaaaaaaaaaa"; // 26 chars
const SOURCE_ID = "src-backfill-test";

interface PostFixture {
  id: string;
  channelId: string;
  rootId: string | null;
  userId: string;
  message: string;
  createAt: number;
  editAt: number;
}

function makePost(id: string, body: string, createAt: number): PostFixture {
  return {
    id,
    channelId: CHANNEL_ID,
    rootId: null,
    userId: "userdriverbackfilltttt", // 22 chars
    message: body,
    createAt,
    editAt: 0,
  };
}

function makePage(
  posts: PostFixture[],
  prevPostId: string | null,
): {
  posts: PostFixture[];
  prevPostId: string | null;
  nextPostId: string | null;
  hasMore: boolean;
} {
  return {
    posts,
    prevPostId,
    nextPostId: null,
    hasMore: prevPostId !== null,
  };
}

describe("sources:backfillKchatChannel — orchestrator", () => {
  beforeEach(() => {
    // Reset bridgeMock backfill state to clean defaults
    // (`mockClear` from the outer beforeEach keeps the
    // implementation; we restate it here so per-test overrides
    // applied earlier don't leak between cases).
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValue({
      outcome: "idle",
      sourceId: SOURCE_ID,
      oldestPostId: undefined,
      completedAt: undefined,
    });
    bridgeMock.bridgeMarkKchatBackfillComplete.mockReturnValue({
      outcome: "completed",
      sourceId: SOURCE_ID,
    });
  });

  it("walks pages to end-of-history and emits Started/PageIngested/Completed audit rows", async () => {
    // Page 1: 2 posts, server says older posts exist (prevPostId
    // populated). Page 2: 1 post, server says no more older posts
    // (prevPostId === null). The orchestrator must call
    // mark-complete and emit the Completed audit row.
    clientMock.getPostsForChannel
      .mockResolvedValueOnce(
        makePage(
          [
            makePost("postnewa00000000000000000a", "newer", 2000),
            makePost("postnewa00000000000000000b", "older", 1500),
          ],
          "postnewa00000000000000000b",
        ),
      )
      .mockResolvedValueOnce(
        makePage([makePost("postnewa00000000000000000c", "oldest", 1000)], null),
      );

    bridgeMock.bridgeIngestKchatBackfillPage
      .mockReturnValueOnce({
        outcome: "ingested",
        sourceId: SOURCE_ID,
        postsIngested: 2,
        postsUnchanged: 0,
        postsSkippedRevoked: 0,
        oldestPostIdInPage: "postnewa00000000000000000b",
      })
      .mockReturnValueOnce({
        outcome: "ingested",
        sourceId: SOURCE_ID,
        postsIngested: 1,
        postsUnchanged: 0,
        postsSkippedRevoked: 0,
        oldestPostIdInPage: "postnewa00000000000000000c",
      });

    const out = (await handler("sources:backfillKchatChannel")(
      EVENT,
      CHANNEL_ID,
    )) as KchatBackfillRunOutcome;

    expect(out).toEqual({
      outcome: "completed",
      pagesWalked: 2,
      totalPostsIngested: 3,
      totalPostsUnchanged: 0,
      totalPostsSkippedRevoked: 0,
    });

    // First call: no `before=` (fresh walk).
    expect(clientMock.getPostsForChannel).toHaveBeenNthCalledWith(
      1,
      CHANNEL_ID,
      expect.objectContaining({ before: undefined, perPage: 200 }),
    );
    // Second call: uses the REST server's `prevPostId` from page 1
    // as the `before=` cursor for page 2.
    expect(clientMock.getPostsForChannel).toHaveBeenNthCalledWith(
      2,
      CHANNEL_ID,
      expect.objectContaining({
        before: "postnewa00000000000000000b",
        perPage: 200,
      }),
    );

    // Audit row sequence: Started (fresh, cursor undefined), two
    // PageIngested rows (1, 2), Completed; no Aborted.
    expect(bridgeMock.bridgeLogKchatBackfillStarted).toHaveBeenCalledWith(
      CHANNEL_ID,
      SOURCE_ID,
      undefined,
    );
    expect(bridgeMock.bridgeLogKchatBackfillPageIngested).toHaveBeenCalledTimes(
      2,
    );
    expect(bridgeMock.bridgeLogKchatBackfillCompleted).toHaveBeenCalledWith(
      CHANNEL_ID,
      SOURCE_ID,
      2,
      3,
      0,
    );
    expect(bridgeMock.bridgeLogKchatBackfillAborted).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeMarkKchatBackfillComplete).toHaveBeenCalledTimes(1);
  });

  it("resumes from the substrate-persisted cursor (uses oldestPostId as initial before=)", async () => {
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "idle",
      sourceId: SOURCE_ID,
      oldestPostId: "postresuuumeeecursorrrr111",
      completedAt: undefined,
    });
    clientMock.getPostsForChannel.mockResolvedValueOnce(
      makePage([makePost("postresuuumeeecursorrrr112", "first", 100)], null),
    );
    bridgeMock.bridgeIngestKchatBackfillPage.mockReturnValueOnce({
      outcome: "ingested",
      sourceId: SOURCE_ID,
      postsIngested: 1,
      postsUnchanged: 0,
      postsSkippedRevoked: 0,
      oldestPostIdInPage: "postresuuumeeecursorrrr112",
    });

    await handler("sources:backfillKchatChannel")(EVENT, CHANNEL_ID);

    // The first REST call must pass the resume cursor as
    // `before=`, and the Started audit row must reflect a
    // non-fresh resume.
    expect(clientMock.getPostsForChannel).toHaveBeenNthCalledWith(
      1,
      CHANNEL_ID,
      expect.objectContaining({ before: "postresuuumeeecursorrrr111" }),
    );
    expect(bridgeMock.bridgeLogKchatBackfillStarted).toHaveBeenCalledWith(
      CHANNEL_ID,
      SOURCE_ID,
      "postresuuumeeecursorrrr111",
    );
  });

  it("short-circuits at state read when completedAt is already set", async () => {
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "idle",
      sourceId: SOURCE_ID,
      oldestPostId: "postwasaaaalwwwallkedalrdy",
      completedAt: "2024-06-01T12:00:00Z",
    });

    const out = (await handler("sources:backfillKchatChannel")(
      EVENT,
      CHANNEL_ID,
    )) as KchatBackfillRunOutcome;

    expect(out).toEqual({
      outcome: "skipped",
      reason: "already_completed",
      pagesWalked: 0,
      totalPostsIngested: 0,
      totalPostsUnchanged: 0,
      totalPostsSkippedRevoked: 0,
      completedAt: "2024-06-01T12:00:00Z",
    });
    // No REST traffic, no audit rows, no substrate writes.
    expect(clientMock.getPostsForChannel).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeLogKchatBackfillStarted).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeIngestKchatBackfillPage).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeMarkKchatBackfillComplete).not.toHaveBeenCalled();
  });

  it("short-circuits at state read when source is access_revoked", async () => {
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "access_revoked",
      sourceId: SOURCE_ID,
      oldestPostId: undefined,
      completedAt: undefined,
    });

    const out = (await handler("sources:backfillKchatChannel")(
      EVENT,
      CHANNEL_ID,
    )) as KchatBackfillRunOutcome;

    expect(out.outcome).toBe("skipped");
    expect(out.reason).toBe("access_revoked");
    expect(clientMock.getPostsForChannel).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeLogKchatBackfillStarted).not.toHaveBeenCalled();
  });

  it("short-circuits at state read when source is unlinked", async () => {
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "unlinked",
      sourceId: undefined,
      oldestPostId: undefined,
      completedAt: undefined,
    });

    const out = (await handler("sources:backfillKchatChannel")(
      EVENT,
      CHANNEL_ID,
    )) as KchatBackfillRunOutcome;

    expect(out.outcome).toBe("skipped");
    expect(out.reason).toBe("unlinked");
    expect(clientMock.getPostsForChannel).not.toHaveBeenCalled();
  });

  it("aborts walk and emits Aborted audit when substrate reports access_revoked mid-walk", async () => {
    clientMock.getPostsForChannel
      .mockResolvedValueOnce(
        makePage(
          [makePost("postmidwwwwalkrevokeppppa1", "ok", 2000)],
          "postmidwwwwalkrevokeppppa1",
        ),
      )
      .mockResolvedValueOnce(
        makePage(
          [makePost("postmidwwwwalkrevokeppppa2", "later", 1500)],
          "postmidwwwwalkrevokeppppa2",
        ),
      );

    bridgeMock.bridgeIngestKchatBackfillPage
      .mockReturnValueOnce({
        outcome: "ingested",
        sourceId: SOURCE_ID,
        postsIngested: 1,
        postsUnchanged: 0,
        postsSkippedRevoked: 0,
        oldestPostIdInPage: "postmidwwwwalkrevokeppppa1",
      })
      .mockReturnValueOnce({
        outcome: "access_revoked",
        sourceId: SOURCE_ID,
        postsIngested: 0,
        postsUnchanged: 0,
        postsSkippedRevoked: 0,
        oldestPostIdInPage: undefined,
      });

    const out = (await handler("sources:backfillKchatChannel")(
      EVENT,
      CHANNEL_ID,
    )) as KchatBackfillRunOutcome;

    expect(out.outcome).toBe("aborted");
    expect(out.reason).toBe("access_revoked");
    expect(out.pagesWalked).toBe(1); // only the first (Ingested) page counts
    expect(out.totalPostsIngested).toBe(1);
    expect(bridgeMock.bridgeLogKchatBackfillAborted).toHaveBeenCalledWith(
      CHANNEL_ID,
      SOURCE_ID,
      "access_revoked",
      1,
      1,
    );
    expect(bridgeMock.bridgeMarkKchatBackfillComplete).not.toHaveBeenCalled();
  });

  it("aborts walk on REST error and emits Aborted audit", async () => {
    clientMock.getPostsForChannel.mockRejectedValueOnce(
      new Error("transient backfill network error"),
    );

    await expect(
      handler("sources:backfillKchatChannel")(EVENT, CHANNEL_ID),
    ).rejects.toThrow(/transient backfill network error/);

    expect(bridgeMock.bridgeLogKchatBackfillAborted).toHaveBeenCalledWith(
      CHANNEL_ID,
      SOURCE_ID,
      "error",
      0,
      0,
    );
    expect(bridgeMock.bridgeMarkKchatBackfillComplete).not.toHaveBeenCalled();
  });

  it("hits safety cap when cumulative posts exceed 50_000 and emits Aborted/safety_cap", async () => {
    // Synthesise a page large enough to trip the cap on the
    // first iteration. The substrate mock will report all 50_001
    // posts as ingested; the orchestrator's `totalPostsTouched`
    // counter (page.posts.length aggregate) is what's compared
    // against the cap. The mock client bypasses the production
    // 200/perPage clamp.
    const bigPostList: PostFixture[] = [];
    for (let i = 0; i < 50_001; i += 1) {
      // Pad to 26 chars (KChat object id shape) with a stable
      // base + zero-padded index. Padding via slice keeps the
      // synthesised ids in the valid `[a-z0-9]{20,32}` range
      // the assertKchatId / assertCallerObjectId would accept.
      const idx = i.toString(36).padStart(5, "0");
      bigPostList.push(
        makePost(`postsafetycaaaa${idx}aaaaaa`.slice(0, 26), `body ${i}`, i),
      );
    }
    clientMock.getPostsForChannel.mockResolvedValueOnce(
      // prevPostId populated so the loop would otherwise keep
      // going; the cap is what stops us.
      makePage(bigPostList, "postnext0000next0000next00"),
    );
    bridgeMock.bridgeIngestKchatBackfillPage.mockReturnValueOnce({
      outcome: "ingested",
      sourceId: SOURCE_ID,
      postsIngested: bigPostList.length,
      postsUnchanged: 0,
      postsSkippedRevoked: 0,
      oldestPostIdInPage: bigPostList[bigPostList.length - 1].id,
    });

    const out = (await handler("sources:backfillKchatChannel")(
      EVENT,
      CHANNEL_ID,
    )) as KchatBackfillRunOutcome;

    expect(out.outcome).toBe("aborted");
    expect(out.reason).toBe("safety_cap");
    expect(bridgeMock.bridgeLogKchatBackfillAborted).toHaveBeenCalledWith(
      CHANNEL_ID,
      SOURCE_ID,
      "safety_cap",
      1,
      bigPostList.length,
    );
    expect(clientMock.getPostsForChannel).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeMarkKchatBackfillComplete).not.toHaveBeenCalled();
  });

  it("dedupes concurrent IPC calls for the same channel via the in-flight map", async () => {
    // Block the first REST call on a controllable Promise so
    // both IPC requests overlap in time. If the orchestrator
    // were not dedup'd, both calls would issue their own REST
    // round-trip and produce two Started audit rows.
    let resolvePage!: (v: ReturnType<typeof makePage>) => void;
    clientMock.getPostsForChannel.mockReturnValueOnce(
      new Promise((res) => {
        resolvePage = res;
      }) as ReturnType<typeof clientMock.getPostsForChannel>,
    );
    bridgeMock.bridgeIngestKchatBackfillPage.mockReturnValueOnce({
      outcome: "ingested",
      sourceId: SOURCE_ID,
      postsIngested: 0,
      postsUnchanged: 0,
      postsSkippedRevoked: 0,
      oldestPostIdInPage: undefined,
    });

    const p1 = handler("sources:backfillKchatChannel")(EVENT, CHANNEL_ID);
    const p2 = handler("sources:backfillKchatChannel")(EVENT, CHANNEL_ID);
    resolvePage(makePage([], null));

    const [o1, o2] = (await Promise.all([p1, p2])) as KchatBackfillRunOutcome[];

    expect(o1.outcome).toBe("completed");
    expect(o2).toBe(o1); // same Promise resolution surface
    expect(clientMock.getPostsForChannel).toHaveBeenCalledTimes(1);
    expect(bridgeMock.bridgeLogKchatBackfillStarted).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed channelId without touching REST or bridge", async () => {
    await expect(
      handler("sources:backfillKchatChannel")(EVENT, "!!!notvalid!!!"),
    ).rejects.toThrow(/channelId/);
    expect(clientMock.getPostsForChannel).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeGetKchatBackfillState).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Block D Task 1 (Phase 14) — kchat:searchPosts retrieval IPC
// ---------------------------------------------------------------------
// Validates the renderer-facing post-body retrieval path:
//
//   1. Argument validation (query: string ≤ 10k, limit: 1..1000).
//   2. Mapping from `bridgeSearchKchatPosts` rows to the renderer
//      `KchatPostSearchHit` shape (camelCase, `kind: "kchat_post"`
//      discriminator, permalink composition).
//   3. Permalink composition: present when connected, `null` when
//      disconnected.
//   4. Audit emission: `bridgeLogKchatPostSearchExecuted` is called
//      with the SHA-256 truncated hash (hex, 16 chars), the hit
//      count, the distinct-source count, and a non-negative
//      latency. The raw query is NEVER passed to the audit logger.
//   5. Audit failure does NOT crash the search (best-effort).
//   6. Empty / blank query short-circuits the bridge call.
// =====================================================================
describe("kchat:searchPosts (Block D Task 1)", () => {
  // A minimal valid napi row matching the bridge's
  // `KchatPostSearchHitInfo` shape.
  function makeBridgeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      content: "we agreed to push Q3 launch to Sept 15",
      excerpt: "we agreed to push Q3 launch to Sept 15",
      sourcePath: "/var/cache/tessera/kchat/channel-xyz",
      sourceId: "src-uuid-1",
      chunkHash: "blake3hash1",
      chunkIndex: 0,
      byteOffset: 0,
      relevance: 0.5,
      postId: "post-abc",
      channelId: "channel-xyz",
      rootId: null,
      senderUserId: "user-ken",
      createdAtMs: 1_700_000_000_000,
      editedAtMs: 0,
      ...overrides,
    };
  }

  it("returns AEAD-verified hits mapped to renderer shape with permalink when connected", async () => {
    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com/",
      user: { username: "ken" },
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow(),
      makeBridgeRow({
        postId: "post-def",
        chunkHash: "blake3hash2",
        relevance: 0.25,
        sourceId: "src-uuid-2",
      }),
    ]);

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch deadline",
      10,
    )) as Array<Record<string, unknown>>;

    expect(bridgeMock.bridgeSearchKchatPosts).toHaveBeenCalledWith(
      "Q3 launch deadline",
      10,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      kind: "kchat_post",
      chunkContent: "we agreed to push Q3 launch to Sept 15",
      chunkHash: "blake3hash1",
      postId: "post-abc",
      channelId: "channel-xyz",
      senderUserId: "user-ken",
      relevanceScore: 0.5,
      // Trailing slash on serverUrl is stripped, then redirect form
      // is composed.
      permalink:
        "https://kchat.example.com/_redirect/pl/post-abc",
    });
    expect(out[1]).toMatchObject({
      postId: "post-def",
      relevanceScore: 0.25,
      permalink: "https://kchat.example.com/_redirect/pl/post-def",
    });
  });

  it("emits audit row with SHA-256 truncated hash, hit count, distinct sources, and latency", async () => {
    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow(),
      makeBridgeRow({
        postId: "post-def",
        sourceId: "src-uuid-1", // same source, distinct-count should stay 1
      }),
      makeBridgeRow({
        postId: "post-ghi",
        sourceId: "src-uuid-2", // distinct-count -> 2
      }),
    ]);

    await handler("kchat:searchPosts")(EVENT, "secret-query-text", 25);

    expect(bridgeMock.bridgeLogKchatPostSearchExecuted).toHaveBeenCalledTimes(
      1,
    );
    const args =
      bridgeMock.bridgeLogKchatPostSearchExecuted.mock.calls[0];
    const [queryHash, hits, sourcesTouched, latencyMs] = args;
    // 16 hex chars (= 64 bits of SHA-256).
    expect(queryHash).toMatch(/^[0-9a-f]{16}$/);
    // The audit row MUST NOT carry the raw query.
    expect(queryHash).not.toContain("secret-query-text");
    expect(hits).toBe(3);
    expect(sourcesTouched).toBe(2);
    expect(typeof latencyMs).toBe("number");
    expect(latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("emits the same hash for the same trimmed query (deterministic) and a different hash for a different query", async () => {
    serviceMock.getState.mockReturnValue({ state: "disconnected" });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValue([]);

    await handler("kchat:searchPosts")(EVENT, "  hello world  ", 10);
    await handler("kchat:searchPosts")(EVENT, "hello world", 10);
    await handler("kchat:searchPosts")(EVENT, "different query", 10);

    const h1 =
      bridgeMock.bridgeLogKchatPostSearchExecuted.mock.calls[0][0];
    const h2 =
      bridgeMock.bridgeLogKchatPostSearchExecuted.mock.calls[1][0];
    const h3 =
      bridgeMock.bridgeLogKchatPostSearchExecuted.mock.calls[2][0];
    expect(h1).toBe(h2); // whitespace-normalised before hashing
    expect(h1).not.toBe(h3);
  });

  it("leaves permalink null when the user is disconnected", async () => {
    serviceMock.getState.mockReturnValue({ state: "disconnected" });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([makeBridgeRow()]);

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(1);
    expect(out[0].permalink).toBeNull();
  });

  it("does NOT crash the search when audit logger throws (best-effort posture)", async () => {
    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([makeBridgeRow()]);
    bridgeMock.bridgeLogKchatPostSearchExecuted.mockImplementationOnce(() => {
      throw new Error("audit logger poisoned");
    });
    // Silence the expected console.error noise from the
    // best-effort audit failure path.
    const consoleErr = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;
    expect(out).toHaveLength(1);
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });

  it("rejects malformed query (non-string) without touching the bridge", async () => {
    await expect(
      handler("kchat:searchPosts")(EVENT, 42, 10),
    ).rejects.toThrow(/query/);
    expect(bridgeMock.bridgeSearchKchatPosts).not.toHaveBeenCalled();
    expect(bridgeMock.bridgeLogKchatPostSearchExecuted).not.toHaveBeenCalled();
  });

  it("rejects out-of-range limit", async () => {
    await expect(
      handler("kchat:searchPosts")(EVENT, "Q3", 0),
    ).rejects.toThrow(/limit/);
    await expect(
      handler("kchat:searchPosts")(EVENT, "Q3", 1_000_000),
    ).rejects.toThrow(/limit/);
    expect(bridgeMock.bridgeSearchKchatPosts).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------
  // Phase 13 Theme 2 Task 9: KChat name-enrichment tests.
  //
  // These tests use VALID KChat object-id format (26 lowercase
  // alphanumeric chars) so the per-id `assertCallerObjectId`
  // check inside `getUsersByIds` / `getChannel` lets the bulk
  // lookup proceed. The legacy tests above use unvalidated test
  // ids ("user-ken" / "channel-xyz") which fail the per-id
  // validator; that exercises the catch-and-degrade branch where
  // each hit's `senderUsername` / `channelDisplayName` stays
  // `null`. Both branches are part of the contract.
  // -------------------------------------------------------------
  const VALID_USER_ID = "u".repeat(26);
  const VALID_USER_ID_2 = "v".repeat(26);
  const VALID_CHANNEL_ID = "c".repeat(26);
  const VALID_CHANNEL_ID_2 = "d".repeat(26);

  it("enriches hits with sender username + channel display name via bulk lookup (Phase 13 Theme 2 Task 9)", async () => {
    // Lazy import: the reset helper lives in the IPC module
    // alongside the cache itself, exported only for tests so we
    // start from a known-empty state regardless of test order.
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
    ]);
    clientMock.getChannel.mockResolvedValueOnce({
      id: VALID_CHANNEL_ID,
      team_id: "t".repeat(26),
      display_name: "Engineering",
    });

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      senderUserId: VALID_USER_ID,
      senderUsername: "ken",
      channelId: VALID_CHANNEL_ID,
      channelDisplayName: "Engineering",
    });
    // Bulk-user lookup is called once with the deduped id array.
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(clientMock.getUsersByIds).toHaveBeenCalledWith([VALID_USER_ID]);
    // Per-channel lookup runs once for the unique channel id.
    expect(clientMock.getChannel).toHaveBeenCalledTimes(1);
    expect(clientMock.getChannel).toHaveBeenCalledWith(VALID_CHANNEL_ID);
  });

  it("deduplicates lookups across multiple hits referencing the same sender/channel (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    // Three hits, only two distinct senders / one distinct channel.
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        postId: "post-a",
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
      makeBridgeRow({
        postId: "post-b",
        senderUserId: VALID_USER_ID, // same sender
        channelId: VALID_CHANNEL_ID, // same channel
        sourceId: "src-b",
      }),
      makeBridgeRow({
        postId: "post-c",
        senderUserId: VALID_USER_ID_2,
        channelId: VALID_CHANNEL_ID, // same channel as #1, #2
        sourceId: "src-c",
      }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
      { id: VALID_USER_ID_2, username: "alex" },
    ]);
    clientMock.getChannel.mockResolvedValueOnce({
      id: VALID_CHANNEL_ID,
      team_id: "t".repeat(26),
      display_name: "Engineering",
    });

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(3);
    expect(out[0].senderUsername).toBe("ken");
    expect(out[1].senderUsername).toBe("ken");
    expect(out[2].senderUsername).toBe("alex");
    expect(out[0].channelDisplayName).toBe("Engineering");
    expect(out[1].channelDisplayName).toBe("Engineering");
    expect(out[2].channelDisplayName).toBe("Engineering");

    // Bulk-lookup is called with deduplicated ids — 2 users
    // (not 3), 1 channel (not 3).
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
    const passedUserIds = clientMock.getUsersByIds.mock.calls[0][0] as string[];
    expect(new Set(passedUserIds)).toEqual(
      new Set([VALID_USER_ID, VALID_USER_ID_2]),
    );
    expect(clientMock.getChannel).toHaveBeenCalledTimes(1);
    expect(clientMock.getChannel).toHaveBeenCalledWith(VALID_CHANNEL_ID);
  });

  it("caches names across calls so a repeated search does NOT re-hit the bulk endpoints (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValue([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
    ]);
    clientMock.getChannel.mockResolvedValueOnce({
      id: VALID_CHANNEL_ID,
      team_id: "t".repeat(26),
      display_name: "Engineering",
    });

    // Two consecutive searches against the same workspace.
    await handler("kchat:searchPosts")(EVENT, "Q3", 10);
    await handler("kchat:searchPosts")(EVENT, "Q3", 10);

    // Bulk lookups still ran only once — the second search was
    // served entirely from the IPC-layer LRU cache.
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(clientMock.getChannel).toHaveBeenCalledTimes(1);
  });

  it("leaves enriched fields null when bulk lookup throws (best-effort posture) (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
    ]);
    // Both lookups fail. The IPC handler MUST still return the
    // hit — the renderer falls back to displaying raw ids.
    clientMock.getUsersByIds.mockRejectedValueOnce(
      new Error("transient 503"),
    );
    clientMock.getChannel.mockRejectedValueOnce(
      new Error("network unreachable"),
    );

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(1);
    expect(out[0].senderUsername).toBeNull();
    expect(out[0].channelDisplayName).toBeNull();
    // The raw ids round-trip so the renderer can render a
    // fallback row.
    expect(out[0].senderUserId).toBe(VALID_USER_ID);
    expect(out[0].channelId).toBe(VALID_CHANNEL_ID);
  });

  it("does not call the bulk endpoints when there are zero hits (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([]);

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "needle that finds nothing",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out).toEqual([]);
    expect(clientMock.getUsersByIds).not.toHaveBeenCalled();
    expect(clientMock.getChannel).not.toHaveBeenCalled();
  });

  it("does not call the bulk endpoints when the user is disconnected (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({ state: "disconnected" });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
    ]);

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(1);
    // Disconnected: permalink is null and enrichment is skipped
    // (the bulk REST calls would fail synchronously anyway). The
    // renderer renders the row with raw-id fallbacks.
    expect(out[0].permalink).toBeNull();
    expect(out[0].senderUsername).toBeNull();
    expect(out[0].channelDisplayName).toBeNull();
    expect(clientMock.getUsersByIds).not.toHaveBeenCalled();
    expect(clientMock.getChannel).not.toHaveBeenCalled();
  });

  it("recovers gracefully when only one of the two lookups fails (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
    ]);
    // Users resolve OK, channels fail. The username should be
    // populated; the channel display name should be null.
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
    ]);
    clientMock.getChannel.mockRejectedValueOnce(
      new Error("403 forbidden"),
    );

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out[0].senderUsername).toBe("ken");
    expect(out[0].channelDisplayName).toBeNull();
  });

  it("partial-result resilience: an unresolved user id leaves only that hit's senderUsername null (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        postId: "post-a",
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
      makeBridgeRow({
        postId: "post-b",
        senderUserId: VALID_USER_ID_2, // intentionally NOT in lookup response
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-b",
      }),
    ]);
    // KChat's `POST /users/ids` omits ids not visible to the
    // authenticated principal. The handler treats the missing
    // id as a graceful null, not an error.
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
    ]);
    clientMock.getChannel.mockResolvedValueOnce({
      id: VALID_CHANNEL_ID,
      team_id: "t".repeat(26),
      display_name: "Engineering",
    });

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(2);
    expect(out[0].senderUsername).toBe("ken");
    expect(out[1].senderUsername).toBeNull();
    // Channel lookup succeeded so both hits carry the same name.
    expect(out[0].channelDisplayName).toBe("Engineering");
    expect(out[1].channelDisplayName).toBe("Engineering");
  });

  it("uses one parallel batch of getChannel calls across multiple channels (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        postId: "post-a",
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
      makeBridgeRow({
        postId: "post-b",
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID_2,
        sourceId: "src-b",
      }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
    ]);
    clientMock.getChannel.mockImplementation(async (id: string) => ({
      id,
      team_id: "t".repeat(26),
      display_name: id === VALID_CHANNEL_ID ? "Engineering" : "Product",
    }));

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3",
      10,
    )) as Array<Record<string, unknown>>;

    expect(out[0].channelDisplayName).toBe("Engineering");
    expect(out[1].channelDisplayName).toBe("Product");
    // Two distinct channels => two getChannel calls, ONE bulk
    // user lookup.
    expect(clientMock.getChannel).toHaveBeenCalledTimes(2);
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------
  // Phase 13 Theme 2 Task 9 — Devin Review pass 1 (fafc5f6)
  // ANALYSIS_0001 / 0004 / 0005 regression tests.
  // -------------------------------------------------------------

  it("ANALYSIS_0001: audit latencyMs measures only the bridge call, NOT the enrichment network time (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    _resetKchatNameCachesForTest();
    defaultRateLimiter.reset();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
      }),
    ]);

    // Make the enrichment take ≥ 50 ms (well above scheduler
    // jitter on every supported runner) by delaying the bulk
    // lookups. If the audit metric included this wait, the
    // assertion below would observe ≥ 50 ms and fail. The fix
    // captures `latencyMs = Date.now() - start` BEFORE calling
    // `enrichKchatPostHits`, so the audit metric stays bounded
    // by the synchronous bridge call (well under 10 ms).
    clientMock.getUsersByIds.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve([{ id: VALID_USER_ID, username: "ken" }]),
            60,
          );
        }),
    );
    clientMock.getChannel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                id: VALID_CHANNEL_ID,
                team_id: "t".repeat(26),
                display_name: "Engineering",
              }),
            60,
          );
        }),
    );

    await handler("kchat:searchPosts")(EVENT, "Q3 launch", 10);

    expect(bridgeMock.bridgeLogKchatPostSearchExecuted).toHaveBeenCalledTimes(
      1,
    );
    const [, , , latencyMs] =
      bridgeMock.bridgeLogKchatPostSearchExecuted.mock.calls[0];
    // The substrate-side bridge is a synchronous mock (it
    // returns immediately). 25 ms gives generous headroom for
    // scheduler jitter on slow CI runners while still being far
    // below the artificial 60 ms enrichment delay. If the metric
    // accidentally folds in enrichment, this assertion fails.
    expect(latencyMs).toBeLessThan(25);
  });

  it("ANALYSIS_0004: empty-string display_name / username is NOT cached (defence-in-depth against protocol drift) (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    _resetKchatNameCachesForTest();
    defaultRateLimiter.reset();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValue([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
    ]);
    // Server returns empty-string display strings (simulates
    // protocol drift or a maliciously crafted response). The
    // cache must reject these so the renderer falls back to the
    // raw ids, preserving the row.
    clientMock.getUsersByIds.mockResolvedValue([
      { id: VALID_USER_ID, username: "" },
    ]);
    clientMock.getChannel.mockResolvedValue({
      id: VALID_CHANNEL_ID,
      team_id: "t".repeat(26),
      display_name: "",
    });

    // First call: enrichment runs, but the empty strings must
    // NOT be cached as positive values. The hit's enriched
    // fields stay `null` (so the renderer falls back to ids).
    const out1 = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;
    expect(out1[0].senderUsername).toBeNull();
    expect(out1[0].channelDisplayName).toBeNull();

    // Second call: because the empty values were NOT cached,
    // the bulk endpoints are re-invoked. (Were the empty strings
    // cached, the second pass would short-circuit and the
    // call counts below would stay at 1.) The retry semantics
    // are correct: a future well-formed response IS allowed to
    // populate the cache without us having to invalidate first.
    await handler("kchat:searchPosts")(EVENT, "Q3 launch", 10);
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(2);
    expect(clientMock.getChannel).toHaveBeenCalledTimes(2);
  });

  it("ANALYSIS_0005: onStatusChange subscriber is registered exactly once across re-mounts (idempotency guard) (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest, registerKchatHandlers } =
      await import("../ipc/kchat");
    _resetKchatNameCachesForTest();
    serviceMock.onStatusChange.mockClear();

    // Re-invoke the handler-registration entrypoint three
    // times. Without the guard, every call would stack another
    // listener on top of `KchatAuthService.onStatusChange` —
    // which would then over-clear the caches on every status
    // push (effectively disabling the cache after the first
    // re-mount).
    registerKchatHandlers();
    registerKchatHandlers();
    registerKchatHandlers();

    expect(serviceMock.onStatusChange).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------
  // Phase 13 Theme 2 Task 9 — Devin Review pass 2 (bef2fa0)
  // ANALYSIS_0001 (parallel fetches) / 0002 (malformed-id filter)
  // / 0003 (connected-only enrichment) / 0005 (unsubscribe handle)
  // regression tests.
  // -------------------------------------------------------------

  it("pass2-ANALYSIS_0001: user + channel enrichment lookups run concurrently, not sequentially (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    _resetKchatNameCachesForTest();
    defaultRateLimiter.reset();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
      }),
    ]);

    // Each REST call takes 80 ms. If they run SEQUENTIALLY,
    // wall-clock is ≥ 160 ms. If they run CONCURRENTLY,
    // wall-clock stays close to 80 ms. The threshold below
    // (130 ms) is safely between the two so the test
    // distinguishes the two execution shapes on every supported
    // runner (including slow CI).
    clientMock.getUsersByIds.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve([{ id: VALID_USER_ID, username: "ken" }]),
            80,
          );
        }),
    );
    clientMock.getChannel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                id: VALID_CHANNEL_ID,
                team_id: "t".repeat(26),
                display_name: "Engineering",
              }),
            80,
          );
        }),
    );

    const t0 = Date.now();
    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;
    const elapsedMs = Date.now() - t0;

    // Sanity: both enrichment fields landed (so the test
    // actually exercised the parallel branch).
    expect(out[0].senderUsername).toBe("ken");
    expect(out[0].channelDisplayName).toBe("Engineering");
    // The actual parallel-execution check. If a future change
    // accidentally re-introduces sequential awaits, elapsed
    // would jump past 130 ms and the test fails.
    expect(elapsedMs).toBeLessThan(130);
  });

  it("pass2-ANALYSIS_0002: malformed senderUserId / channelId is filtered out of bulk lookups (does not suppress other hits) (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    _resetKchatNameCachesForTest();
    defaultRateLimiter.reset();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    // Two hits: the first carries a substrate-corrupted (or
    // legacy non-compliant) sender id, the second carries a
    // valid one. Pre-fix, the per-id assertion inside
    // `getUsersByIds` would throw on the malformed id and the
    // catch-and-degrade branch would null out BOTH hits'
    // `senderUsername` (suppressing the valid one too). Post
    // fix, the malformed id is filtered out of the bulk request
    // and the valid id is resolved normally.
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: "user-malformed", // does NOT match the regex
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-a",
      }),
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
        sourceId: "src-b",
      }),
    ]);
    // The bulk endpoint must be called with ONLY the valid id;
    // we assert on that below by inspecting the call args.
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
    ]);
    clientMock.getChannel.mockResolvedValueOnce({
      id: VALID_CHANNEL_ID,
      team_id: "t".repeat(26),
      display_name: "Engineering",
    });

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;

    // The malformed id was filtered — the corresponding hit
    // keeps senderUsername null (renderer falls back to raw
    // id), while the valid hit is enriched.
    expect(out[0].senderUsername).toBeNull();
    expect(out[1].senderUsername).toBe("ken");
    // Both hits share the same channel id, so the channel
    // lookup runs once and both get the display name.
    expect(out[0].channelDisplayName).toBe("Engineering");
    expect(out[1].channelDisplayName).toBe("Engineering");
    // The bulk POST must have received only the valid id (the
    // malformed one was filtered upstream of the call).
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(clientMock.getUsersByIds).toHaveBeenCalledWith([VALID_USER_ID]);
  });

  it("pass2-ANALYSIS_0003: enrichment skipped during 'connecting' state (only runs when fully 'connected') (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    _resetKchatNameCachesForTest();
    defaultRateLimiter.reset();

    // Mid-handshake state: serverUrl is set but the auth
    // service has NOT transitioned to `connected` yet. The
    // verification request may still be in flight; running
    // enrichment now would surface as failed lookups. The
    // fix gates enrichment on `state === "connected"`.
    serviceMock.getState.mockReturnValue({
      state: "connecting",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
      }),
    ]);

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;

    // The bridge result is returned; permalink stays null
    // (composing it requires a stable serverUrl, but the
    // existing renderer treats null-permalink as "Open in
    // KChat" disabled which is the correct UX during a
    // mid-handshake search).
    expect(out).toHaveLength(1);
    expect(out[0].senderUsername).toBeNull();
    expect(out[0].channelDisplayName).toBeNull();
    // The two enrichment endpoints must NOT have been
    // exercised during a `connecting` state.
    expect(clientMock.getUsersByIds).not.toHaveBeenCalled();
    expect(clientMock.getChannel).not.toHaveBeenCalled();
  });

  it("pass2-ANALYSIS_0005: _resetKchatNameCachesForTest calls the onStatusChange unsubscribe handle (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest, registerKchatHandlers } =
      await import("../ipc/kchat");

    // Install a tracked unsubscribe spy and re-wire
    // `serviceMock.onStatusChange` so it returns it. The reset
    // helper must call this spy when it detaches the listener.
    const unsubscribeSpy = vi.fn();
    serviceMock.onStatusChange.mockReturnValue(unsubscribeSpy);

    // First reset flushes any prior install state from earlier
    // tests so we start from a known clean slate.
    _resetKchatNameCachesForTest();
    serviceMock.onStatusChange.mockClear();
    // Install fresh; the install path stores the spy as the
    // module-level unsubscribe handle.
    registerKchatHandlers();
    expect(serviceMock.onStatusChange).toHaveBeenCalledTimes(1);

    // Now reset: this must call the stored unsubscribe handle.
    _resetKchatNameCachesForTest();
    expect(unsubscribeSpy).toHaveBeenCalledTimes(1);

    // After reset, the install flag is `false` again — a
    // subsequent registerKchatHandlers must re-subscribe.
    registerKchatHandlers();
    expect(serviceMock.onStatusChange).toHaveBeenCalledTimes(2);
  });

  it("pass3-ANALYSIS_0001: channelTask is fault-isolated symmetrically with userTask (Phase 13 Theme 2 Task 9)", async () => {
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    _resetKchatNameCachesForTest();
    defaultRateLimiter.reset();

    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
    bridgeMock.bridgeSearchKchatPosts.mockReturnValueOnce([
      makeBridgeRow({
        senderUserId: VALID_USER_ID,
        channelId: VALID_CHANNEL_ID,
      }),
    ]);

    // User branch succeeds normally and populates the username
    // cache. Channel branch's `Promise.allSettled` resolves with
    // a fulfilled result, but we simulate a throw from the
    // `.set()` step by feeding a channel object that triggers
    // the cache's empty-string-reject path AT FIRST, then
    // (separately) verify that a hypothetical synchronous throw
    // inside the loop body cannot abort the second-pass
    // application loop. We achieve this by mocking the channel
    // response with an `id` that the cache's `set` will throw on
    // — we use a Proxy whose `set` trap throws to confirm the
    // outer try/catch swallows the throw and the second pass
    // still runs.
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_USER_ID, username: "ken" },
    ]);
    // Channel fetch resolves with a value whose `id` getter
    // throws when accessed during the `.set(r.value.id, …)`
    // step. This is the only way to force a throw inside the
    // post-allSettled loop (the cache itself cannot reject by
    // contract). Pre-fix the throw would propagate up through
    // the IIFE's async function, reject the channelTask
    // promise, abort `Promise.all`, and skip the second-pass
    // loop — so even though the username was cached, the hit
    // would never get its `senderUsername` populated. Post-fix
    // the symmetric try/catch swallows the throw and the
    // second pass runs.
    const throwingChannel = new Proxy(
      {
        id: VALID_CHANNEL_ID,
        team_id: "t".repeat(26),
        display_name: "Engineering",
      },
      {
        get(target, prop) {
          if (prop === "id") {
            throw new Error("simulated channel.id getter throw");
          }
          return (target as Record<string | symbol, unknown>)[prop];
        },
      },
    );
    clientMock.getChannel.mockResolvedValueOnce(throwingChannel);

    const out = (await handler("kchat:searchPosts")(
      EVENT,
      "Q3 launch",
      10,
    )) as Array<Record<string, unknown>>;

    // The user-side enrichment must still land on the hit
    // (proving the second-pass loop ran).
    expect(out[0].senderUsername).toBe("ken");
    // Channel side stayed null — the throw was swallowed
    // symmetrically (renderer falls back to raw id).
    expect(out[0].channelDisplayName).toBeNull();
  });
});

// =====================================================================
// Phase 13 Task 10 — kchat:backfillProgress (progress projection IPC)
// ---------------------------------------------------------------------
// The handler is a pure read of two pieces of state:
//
//   1. `inFlightBackfillKchatChannel.has(id)` — is a walk currently
//      running? Drives the `active` vs `idle/complete` discriminator.
//   2. `bridgeGetKchatBackfillState(cacheDir)` — substrate-persisted
//      state. Surfaces `oldestPostId`, `completedAt`, revocation
//      outcome.
//
// These tests pin every branch the renderer projection depends on:
// - `idle` when no walk has run AND substrate state is idle/unlinked/
//    access_revoked
// - `complete` when substrate state has a `completedAt` (regardless of
//    `inFlight`, because a re-trigger after completion is a no-op)
// - `active` when a walk is in flight AND substrate state has not
//    completed yet
// - `error` with the underlying message when:
//    (a) the native bridge is unavailable, OR
//    (b) the substrate state read throws
// - The handler rejects malformed channelIds at the boundary
// =====================================================================
describe("kchat:backfillProgress — progress projection IPC", () => {
  // 26-char channel id reused across cases. Doesn't share the
  // CHANNEL_ID constant used by the backfill orchestrator
  // describe block above so a future change to that fixture
  // doesn't accidentally couple the two suites.
  const PROGRESS_CHANNEL_ID = "chidprogresstttttttttttttta";

  beforeEach(async () => {
    // Reset the rate-limiter so a previous test in this suite
    // that exhausts the bucket doesn't bleed into the next case.
    // `kchat:backfillProgress` is gated at 2 tokens / 1 s sustained
    // (see RATE_LIMIT_PROFILES["kchat:backfillProgress"]) — too
    // tight to share across cases.
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    defaultRateLimiter.reset();
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValue({
      outcome: "idle",
      sourceId: "src-uuid",
      oldestPostId: undefined,
      completedAt: undefined,
    });
  });

  it("registers the `kchat:backfillProgress` channel", () => {
    const channels = handleMock.mock.calls.map((c) => c[0] as string);
    expect(channels).toContain("kchat:backfillProgress");
  });

  it("returns `status: idle` when no walk has run and state is idle", async () => {
    const out = (await handler("kchat:backfillProgress")(
      EVENT,
      PROGRESS_CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(out.status).toBe("idle");
    expect(out.channelId).toBe(PROGRESS_CHANNEL_ID);
    expect(out.oldestFetched).toBeNull();
    expect(out.totalPosts).toBeNull();
    expect(out.postsIngested).toBe(0);
  });

  it("returns `status: idle` when substrate state is `unlinked` (race against unlink)", async () => {
    // The renderer must NOT show an error for an unlinked
    // channel — that's a normal state during the gap between
    // the user clicking "Remove KChat source" and the substrate
    // GC. The handler projects it to `idle` so the UI shows
    // "no walk has run" rather than a scary error banner.
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "unlinked",
      sourceId: undefined,
      oldestPostId: undefined,
      completedAt: undefined,
    });
    const out = (await handler("kchat:backfillProgress")(
      EVENT,
      PROGRESS_CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(out.status).toBe("idle");
  });

  it("returns `status: idle` when substrate state is `access_revoked`", async () => {
    // Same UX rationale as `unlinked`: revoked sources are still
    // listed in the UI (the user can re-link), and the backfill
    // card shouldn't show an error for a state the user
    // explicitly chose. The substrate-side cryptoshred already
    // removed the data; the renderer just sees `idle`.
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "access_revoked",
      sourceId: "src-uuid",
      oldestPostId: undefined,
      completedAt: undefined,
    });
    const out = (await handler("kchat:backfillProgress")(
      EVENT,
      PROGRESS_CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(out.status).toBe("idle");
  });

  it("returns `status: complete` when substrate state has a `completedAt`", async () => {
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "idle",
      sourceId: "src-uuid",
      oldestPostId: "postnewa00000000000000000a",
      completedAt: "2024-01-01T00:00:00Z",
    });
    const out = (await handler("kchat:backfillProgress")(
      EVENT,
      PROGRESS_CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(out.status).toBe("complete");
    expect(out.channelId).toBe(PROGRESS_CHANNEL_ID);
  });

  it("returns `status: error` when the bridge state read throws", async () => {
    bridgeMock.bridgeGetKchatBackfillState.mockImplementationOnce(() => {
      throw new Error("substrate corruption: dek missing");
    });
    const out = (await handler("kchat:backfillProgress")(
      EVENT,
      PROGRESS_CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(out.status).toBe("error");
    // The substrate error message must reach the renderer so
    // the user has a chance to act on it (e.g. cryptoshred and
    // re-link). The handler scrubs nothing here because the
    // path is internal — there is no token/header to leak.
    expect(out.error).toMatch(/substrate corruption/);
  });

  it("rejects malformed channelIds at the boundary", async () => {
    await expect(
      handler("kchat:backfillProgress")(EVENT, "!!!notvalid!!!"),
    ).rejects.toThrow(/channelId/);
    expect(bridgeMock.bridgeGetKchatBackfillState).not.toHaveBeenCalled();
  });

  it("passes the per-channel cache directory to the bridge state read", async () => {
    // Regression guard: a future refactor that changes the
    // cacheDir derivation must not accidentally start passing
    // the raw channelId or the workspace root. The substrate
    // keys state on the cacheDir, so a regression here would
    // silently make every renderer poll think the walk is
    // `idle` even after a successful completion.
    await handler("kchat:backfillProgress")(EVENT, PROGRESS_CHANNEL_ID);
    expect(bridgeMock.bridgeGetKchatBackfillState).toHaveBeenCalledTimes(1);
    const arg = bridgeMock.bridgeGetKchatBackfillState.mock.calls[0][0] as string;
    expect(arg).toContain(PROGRESS_CHANNEL_ID);
    expect(arg).toMatch(/kchat-channels/);
  });

  it("rate-limits repeated calls per the `kchat:backfillProgress` profile", async () => {
    // The handler is rate-limited at 2 tokens / 1 s sustained
    // with 5 burst — see RATE_LIMIT_PROFILES. We drive enough
    // calls to drain the bucket and assert the next call
    // rejects with the limiter's diagnostic.
    for (let i = 0; i < 5; i++) {
      await handler("kchat:backfillProgress")(EVENT, PROGRESS_CHANNEL_ID);
    }
    await expect(
      handler("kchat:backfillProgress")(EVENT, PROGRESS_CHANNEL_ID),
    ).rejects.toThrow(/Rate limit/i);
  });

  it("surfaces live `postsIngested` and `oldestFetched` while a walk is in flight (ANALYSIS_0001)", async () => {
    // Devin Review on 869295e (ANALYSIS_0001): the handler used to
    // hard-code `postsIngested: 0` and `oldestFetched: null` for the
    // `active` discriminator because the comment claimed the
    // substrate didn't carry a running counter. The orchestrator
    // already accumulates `totalPostsIngested` page-by-page; this
    // fix routes that value through a per-channel in-flight map
    // (`runningBackfillCounters`) which the progress IPC reads.
    //
    // This test exercises the through-line end-to-end:
    //   1. Drive the first page of a walk via the orchestrator.
    //   2. Pause the walk before the second page resolves.
    //   3. Hit the progress IPC and assert it surfaces the live
    //      cumulative count (2 posts) and the oldest `createAt`
    //      (1500ms epoch) ingested so far.
    //   4. Resolve the second page (end-of-history) so the walk
    //      completes, then assert a follow-up progress IPC returns
    //      `complete` with the documented `postsIngested: 0`
    //      fallback (substrate doesn't carry a cumulative counter,
    //      so we can't retroactively attribute the count to the
    //      finished walk).
    //
    // We use the orchestrator's CHANNEL_ID (not the
    // PROGRESS_CHANNEL_ID this describe usually uses) because the
    // live counter is keyed on whichever id the orchestrator
    // happens to be walking.
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    defaultRateLimiter.reset();
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValue({
      outcome: "idle",
      sourceId: SOURCE_ID,
      oldestPostId: undefined,
      completedAt: undefined,
    });
    bridgeMock.bridgeMarkKchatBackfillComplete.mockReturnValue({
      outcome: "completed",
      sourceId: SOURCE_ID,
    });

    // Deferred second-page promise so the orchestrator's REST loop
    // pauses between page 1 and page 2 while we poll the progress
    // IPC. Page 1 has 2 posts at createAt 2000ms / 1500ms (REST
    // returns newest-first so the LAST post is the oldest, which is
    // what `runningBackfillCounters.oldestPostCreateAtMs` should
    // converge to).
    let resolveSecondPage!: (v: unknown) => void;
    const secondPage = new Promise<unknown>((r) => {
      resolveSecondPage = r;
    });
    clientMock.getPostsForChannel
      .mockResolvedValueOnce(
        makePage(
          [
            makePost("postlive00000000000000000a", "newer", 2000),
            makePost("postlive00000000000000000b", "older", 1500),
          ],
          "postlive00000000000000000b",
        ),
      )
      .mockReturnValueOnce(secondPage as never);
    bridgeMock.bridgeIngestKchatBackfillPage.mockReturnValueOnce({
      outcome: "ingested",
      sourceId: SOURCE_ID,
      postsIngested: 2,
      postsUnchanged: 0,
      postsSkippedRevoked: 0,
      oldestPostIdInPage: "postlive00000000000000000b",
    });

    // Start the walk; do NOT await — the second page is pending.
    const walkPromise = handler("sources:backfillKchatChannel")(
      EVENT,
      CHANNEL_ID,
    );

    // Spin the microtask queue until the first page is fully
    // ingested and the orchestrator is waiting on the second page.
    // 50 ticks is overkill (the path is ~6 awaits) but keeps the
    // test robust against future refactors that interleave more
    // awaits before the loop pauses.
    for (let i = 0; i < 50; i++) {
      await Promise.resolve();
    }

    // Reset the rate-limiter so the progress IPC isn't drained by
    // the orchestrator's startup cost (the two share the
    // `defaultRateLimiter` instance even though their token buckets
    // are independent).
    defaultRateLimiter.reset();

    const live = (await handler("kchat:backfillProgress")(
      EVENT,
      CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(live.status).toBe("active");
    expect(live.channelId).toBe(CHANNEL_ID);
    // The exact value the orchestrator just reported — proves the
    // through-line is wired correctly (was hardcoded 0 pre-fix).
    expect(live.postsIngested).toBe(2);
    // The min `createAt` across the page; REST returns newest-first
    // so it is the LAST post in page 1.
    expect(live.oldestFetched).toBe(1500);
    expect(live.totalPosts).toBeNull();

    // Resolve the second page as empty (end-of-history) so the
    // orchestrator finalises the walk.
    resolveSecondPage(makePage([], null));
    await walkPromise;

    // Post-completion: the orchestrator's `.finally()` removed the
    // counters entry, so a subsequent progress IPC falls back to
    // the substrate-side discriminator with the documented `0` /
    // `null` placeholders (substrate doesn't carry a cumulative
    // count, so we cannot retroactively attribute it).
    defaultRateLimiter.reset();
    bridgeMock.bridgeGetKchatBackfillState.mockReturnValueOnce({
      outcome: "idle",
      sourceId: SOURCE_ID,
      oldestPostId: "postlive00000000000000000b",
      completedAt: "2024-01-01T00:00:00Z",
    });
    const after = (await handler("kchat:backfillProgress")(
      EVENT,
      CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(after.status).toBe("complete");
    expect(after.postsIngested).toBe(0);
    expect(after.oldestFetched).toBeNull();
  });

  it("falls back to `postsIngested: 0` / `oldestFetched: null` when no walk is in flight", async () => {
    // Defence-in-depth around the cleanup contract: the in-flight
    // counters map MUST be empty between walks. If a previous walk
    // (in a different test) leaked an entry, this test would see
    // non-zero values for an `idle` channel and the regression
    // would be invisible because the previous test's expectations
    // still pass.
    const out = (await handler("kchat:backfillProgress")(
      EVENT,
      PROGRESS_CHANNEL_ID,
    )) as Record<string, unknown>;
    expect(out.status).toBe("idle");
    expect(out.postsIngested).toBe(0);
    expect(out.oldestFetched).toBeNull();
  });
});

// =====================================================================
// Phase 13 Theme 2 Task 11 — `kchat:listChannelFiles` uploader
// enrichment via the shared `KCHAT_USERNAME_CACHE` /
// `getUsersByIds()` path the citation enrichment uses. The IPC
// handler:
//
//   - Sanitises raw `KchatFileInfo` rows into `RendererFileInfo`
//     (strips `update_at` / `delete_at` / `channel_id` / `post_id`).
//   - Carries `user_id` forward as the cache-key fallback.
//   - Initialises `uploaderUsername: null` so the wire shape is
//     well-formed before enrichment runs.
//   - Calls `enrichKchatFileViews(files, client)` ONLY when the
//     service state is `connected` AND the file list is non-empty.
//   - Swallows enrichment failures so a transient REST error never
//     hides the file list from the renderer.
//
// These tests mirror the post-hit enrichment suite above and use
// the same VALID KChat object-id constants so the
// `assertCallerObjectId` / `isKchatObjectId` defence-in-depth
// branches don't suppress the enrichment.
// =====================================================================
describe("kchat:listChannelFiles — uploader enrichment (Phase 13 Theme 2 Task 11)", () => {
  // Reuse the 26-char object-id constants from the post-search
  // suite by re-declaring them here. We intentionally do NOT
  // import or share — the two suites' fixtures must be able to
  // drift independently.
  const VALID_FILE_USER_ID = "a".repeat(26);
  const VALID_FILE_USER_ID_2 = "b".repeat(26);
  const VALID_FILE_CHANNEL_ID = "e".repeat(26);

  beforeEach(async () => {
    // Reset rate limiter + the module-scoped name caches so the
    // first test under this describe runs against a fresh state
    // — matching the ANALYSIS_0003 reset shape installed in the
    // top-level `beforeEach`. Redundant with the top-level reset
    // but documents the invariant explicitly at the suite level.
    const { defaultRateLimiter } = await import("../ipc/rateLimiter");
    defaultRateLimiter.reset();
    const { _resetKchatNameCachesForTest } = await import("../ipc/kchat");
    _resetKchatNameCachesForTest();
    // Re-register so the status listener that
    // `_resetKchatNameCachesForTest` tore down is installed again
    // for the enrichment path. The top-level beforeEach already
    // does this, but reset-then-register matches the failure mode
    // we want to cover: a subsequent enrichment must always find
    // an attached listener.
    registerKchatHandlers();

    // Default to a connected service state — the enrichment path
    // is gated on this. Individual tests override when they need
    // a different state.
    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
    });
  });

  function makeFile(overrides: {
    id: string;
    user_id: string;
    create_at?: number;
    name?: string;
    extension?: string;
    mime_type?: string;
    size?: number;
  }) {
    return {
      id: overrides.id,
      user_id: overrides.user_id,
      channel_id: VALID_FILE_CHANNEL_ID,
      name: overrides.name ?? `${overrides.id}.txt`,
      extension: overrides.extension ?? "txt",
      mime_type: overrides.mime_type ?? "text/plain",
      size: overrides.size ?? 64,
      create_at: overrides.create_at ?? 1700000000000,
      update_at: 1700000000000,
      delete_at: 0,
      post_id: "p".repeat(26),
    };
  }

  it("enriches each file with the uploader username via a single bulk lookup", async () => {
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "f".repeat(26), user_id: VALID_FILE_USER_ID }),
      makeFile({ id: "g".repeat(26), user_id: VALID_FILE_USER_ID }),
      makeFile({ id: "h".repeat(26), user_id: VALID_FILE_USER_ID_2 }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_FILE_USER_ID, username: "alice" },
      { id: VALID_FILE_USER_ID_2, username: "bob" },
    ]);

    const out = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;

    // Every file is sanitised + enriched.
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      user_id: VALID_FILE_USER_ID,
      uploaderUsername: "alice",
    });
    expect(out[1]).toMatchObject({
      user_id: VALID_FILE_USER_ID,
      uploaderUsername: "alice",
    });
    expect(out[2]).toMatchObject({
      user_id: VALID_FILE_USER_ID_2,
      uploaderUsername: "bob",
    });

    // The deduplicated id set is exactly two ids — the bulk
    // endpoint is hit exactly once for the whole listing.
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
    const calledIds = clientMock.getUsersByIds.mock.calls[0][0] as string[];
    expect(new Set(calledIds)).toEqual(
      new Set([VALID_FILE_USER_ID, VALID_FILE_USER_ID_2]),
    );
  });

  it("reuses the module-level cache across consecutive listings", async () => {
    // First call populates the cache.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "f".repeat(26), user_id: VALID_FILE_USER_ID }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_FILE_USER_ID, username: "alice" },
    ]);
    await handler("kchat:listChannelFiles")(EVENT, VALID_FILE_CHANNEL_ID, 0, 50);
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);

    // Second call resolves from cache — no second REST round trip.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "g".repeat(26), user_id: VALID_FILE_USER_ID }),
    ]);
    const out2 = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(out2[0]).toMatchObject({ uploaderUsername: "alice" });
  });

  it("skips the bulk lookup entirely when zero files are returned", async () => {
    clientMock.listChannelFiles.mockResolvedValueOnce([]);
    const out = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;
    expect(out).toEqual([]);
    // Important: enrichment must NOT consume a rate-limit token
    // or hit the REST endpoint when there is nothing to enrich.
    expect(clientMock.getUsersByIds).not.toHaveBeenCalled();
  });

  it("skips enrichment when the service is not connected", async () => {
    serviceMock.getState.mockReturnValue({
      state: "connecting",
      serverUrl: "https://kchat.example.com",
    });
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "f".repeat(26), user_id: VALID_FILE_USER_ID }),
    ]);
    const out = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(1);
    // `user_id` carries through the sanitiser; `uploaderUsername`
    // stays `null` so the renderer's raw-id fallback path is
    // exercised.
    expect(out[0]).toMatchObject({
      user_id: VALID_FILE_USER_ID,
      uploaderUsername: null,
    });
    expect(clientMock.getUsersByIds).not.toHaveBeenCalled();
  });

  it("leaves uploaderUsername null when the bulk lookup throws (best-effort posture)", async () => {
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "f".repeat(26), user_id: VALID_FILE_USER_ID }),
    ]);
    clientMock.getUsersByIds.mockRejectedValueOnce(
      new Error("transient 503 from /users/ids"),
    );

    const out = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;

    // The file list is still returned (best-effort enrichment
    // never hides files from the renderer).
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      user_id: VALID_FILE_USER_ID,
      uploaderUsername: null,
    });
  });

  it("filters malformed user_id values out of the bulk request set", async () => {
    // One valid id, one short id that fails `isKchatObjectId`.
    // The malformed-id row keeps `uploaderUsername: null`; the
    // valid-id row enriches normally. Critically the bulk
    // endpoint MUST NOT be called with the malformed id — the
    // entire bulk would otherwise throw from the per-id check
    // inside `getUsersByIds` and suppress the valid row's
    // enrichment.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "f".repeat(26), user_id: VALID_FILE_USER_ID }),
      makeFile({ id: "g".repeat(26), user_id: "short" }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_FILE_USER_ID, username: "alice" },
    ]);

    const out = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;

    expect(out[0]).toMatchObject({ uploaderUsername: "alice" });
    expect(out[1]).toMatchObject({ uploaderUsername: null });
    // Bulk request set contains exactly the well-formed id.
    expect(clientMock.getUsersByIds).toHaveBeenCalledTimes(1);
    const called = clientMock.getUsersByIds.mock.calls[0][0] as string[];
    expect(called).toEqual([VALID_FILE_USER_ID]);
  });

  it("leaves uploaderUsername null for files the bulk server response elided", async () => {
    // Server returned only one of the two requested users — the
    // unreturned id's row stays null (mirrors the citation
    // enrichment's partial-response resilience).
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "f".repeat(26), user_id: VALID_FILE_USER_ID }),
      makeFile({ id: "g".repeat(26), user_id: VALID_FILE_USER_ID_2 }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_FILE_USER_ID, username: "alice" },
      // VALID_FILE_USER_ID_2 omitted on purpose.
    ]);

    const out = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;

    expect(out[0]).toMatchObject({ uploaderUsername: "alice" });
    expect(out[1]).toMatchObject({ uploaderUsername: null });
  });

  it("sanitises out the fields the renderer must not see", async () => {
    // Server includes `update_at` / `delete_at` / `channel_id` /
    // `post_id` (per `KchatFileInfo`). The sanitiser must strip
    // these from the wire shape so the renderer cannot leak them
    // into devtools / crash reporters.
    clientMock.listChannelFiles.mockResolvedValueOnce([
      makeFile({ id: "f".repeat(26), user_id: VALID_FILE_USER_ID }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: VALID_FILE_USER_ID, username: "alice" },
    ]);

    const out = (await handler("kchat:listChannelFiles")(
      EVENT,
      VALID_FILE_CHANNEL_ID,
      0,
      50,
    )) as Array<Record<string, unknown>>;

    expect(out[0]).not.toHaveProperty("update_at");
    expect(out[0]).not.toHaveProperty("delete_at");
    expect(out[0]).not.toHaveProperty("channel_id");
    expect(out[0]).not.toHaveProperty("post_id");
    // But the surfaced shape includes the explicit Task 11
    // additions.
    expect(out[0]).toHaveProperty("user_id");
    expect(out[0]).toHaveProperty("uploaderUsername");
  });
});

// ------------------------------------------------------------------
// kchat:fetchThreadContext — Phase 13 Theme 2 Task 13
// ------------------------------------------------------------------
describe("kchat:fetchThreadContext (Phase 13 Theme 2 Task 13)", () => {
  // Valid Tessera source UUID shape (assertId allows alphanumerics +
  // _ - : . up to 128 chars).
  const VALID_SOURCE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
  // Valid KChat 26-char object id (lowercase a-z + 0-9).
  const VALID_POST_ID = "abcdefghij1234567890abcdef";

  function makeBridgeContextRow(
    overrides: Partial<Record<string, unknown>> = {},
  ) {
    return {
      postId: VALID_POST_ID,
      channelId: "ch" + "a".repeat(24),
      senderUserId: "u" + "b".repeat(25),
      createdAtMs: 1_700_000_000_000,
      editedAtMs: 0,
      content: "thread root message",
      isRoot: true,
      ...overrides,
    };
  }

  it("rejects malformed sourceId (shell metachar) without touching the bridge", async () => {
    await expect(
      handler("kchat:fetchThreadContext")(EVENT, "../../etc/passwd", VALID_POST_ID),
    ).rejects.toThrow(/sourceId/);
    expect(bridgeMock.bridgeFetchKchatThreadContext).not.toHaveBeenCalled();
  });

  it("rejects malformed postId (uppercase / special chars) without touching the bridge", async () => {
    await expect(
      handler("kchat:fetchThreadContext")(EVENT, VALID_SOURCE_ID, "INVALID-POST-ID!!"),
    ).rejects.toThrow(/postId/);
    expect(bridgeMock.bridgeFetchKchatThreadContext).not.toHaveBeenCalled();
  });

  it("rejects non-string sourceId", async () => {
    await expect(
      handler("kchat:fetchThreadContext")(EVENT, 42, VALID_POST_ID),
    ).rejects.toThrow(/sourceId/);
    expect(bridgeMock.bridgeFetchKchatThreadContext).not.toHaveBeenCalled();
  });

  it("rejects non-string postId", async () => {
    await expect(
      handler("kchat:fetchThreadContext")(EVENT, VALID_SOURCE_ID, null),
    ).rejects.toThrow(/postId/);
    expect(bridgeMock.bridgeFetchKchatThreadContext).not.toHaveBeenCalled();
  });

  it("returns enriched messages with username and channelDisplayName when connected", async () => {
    const senderId = "u" + "b".repeat(25);
    const channelId = "ch" + "a".repeat(24);
    serviceMock.getState.mockReturnValue({
      state: "connected",
      serverUrl: "https://kchat.example.com",
      user: { username: "ken" },
    });
    bridgeMock.bridgeFetchKchatThreadContext.mockReturnValueOnce([
      makeBridgeContextRow({
        senderUserId: senderId,
        channelId,
        isRoot: true,
      }),
      makeBridgeContextRow({
        postId: "reply" + "0".repeat(21),
        senderUserId: senderId,
        channelId,
        isRoot: false,
        content: "thread reply",
      }),
    ]);
    clientMock.getUsersByIds.mockResolvedValueOnce([
      { id: senderId, username: "alice" },
    ]);
    clientMock.getChannel.mockResolvedValueOnce({
      id: channelId,
      display_name: "General",
    });

    const out = (await handler("kchat:fetchThreadContext")(
      EVENT,
      VALID_SOURCE_ID,
      VALID_POST_ID,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      isRoot: true,
      senderUsername: "alice",
      channelDisplayName: "General",
    });
    expect(out[1]).toMatchObject({
      isRoot: false,
      senderUsername: "alice",
      channelDisplayName: "General",
      content: "thread reply",
    });
  });

  it("returns messages with null enrichment when disconnected", async () => {
    serviceMock.getState.mockReturnValue({ state: "disconnected" });
    bridgeMock.bridgeFetchKchatThreadContext.mockReturnValueOnce([
      makeBridgeContextRow(),
    ]);

    const out = (await handler("kchat:fetchThreadContext")(
      EVENT,
      VALID_SOURCE_ID,
      VALID_POST_ID,
    )) as Array<Record<string, unknown>>;

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      senderUsername: null,
      channelDisplayName: null,
    });
    // No enrichment calls when disconnected.
    expect(clientMock.getUsersByIds).not.toHaveBeenCalled();
    expect(clientMock.getChannel).not.toHaveBeenCalled();
  });

  it("returns empty array when bridge returns empty (top-level / unknown post)", async () => {
    bridgeMock.bridgeFetchKchatThreadContext.mockReturnValueOnce([]);

    const out = await handler("kchat:fetchThreadContext")(
      EVENT,
      VALID_SOURCE_ID,
      VALID_POST_ID,
    );

    expect(out).toEqual([]);
  });
});
