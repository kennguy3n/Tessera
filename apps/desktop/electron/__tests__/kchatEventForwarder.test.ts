/**
 * Tests for the `KchatEventForwarder` push pipeline introduced in
 * Block B Task 1.
 *
 * The forwarder is the bridge between the main-process
 * `KchatClient.onWebSocketEvent` listener set and the renderer-
 * facing `kchat:event` / `kchat:status` IPC channels. The
 * production code lives in `electron/kchat/kchatEventForwarder.ts`.
 *
 * The test surface is deterministic: we inject a fake
 * `BrowserWindow` enumerator via the forwarder's `listWindows`
 * option so the tests run without standing up an Electron
 * renderer, and we drive the forwarder's WS / status listeners by
 * calling a manually-implemented `KchatClient` stand-in that
 * exposes `triggerWsEvent(...)` / `triggerStatusChange(...)`
 * helpers. The native bridge is mocked via `vi.mock("../appState",
 * ...)` so the `file_added` audit side-effect is observable
 * without booting tessera_bridge.node.
 *
 * Coverage:
 *
 *   1. Per-event renderer projection: `broadcast.*` flattens to
 *      `channelId/teamId/userId`, `data` is passed through,
 *      `omit_users` is dropped.
 *
 *   2. Ring buffer drop-oldest semantics: pushing more than
 *      `RING_BUFFER_CAP` events causes the *oldest* event to be
 *      dropped and the dropped count to increment. (The drain is
 *      synchronous in production today so the buffer rarely fills
 *      in practice; the test exercises the architectural
 *      guarantee.)
 *
 *   3. Per-window state isolation: two windows have independent
 *      buffers and independent dropped counts. A `closed` event on
 *      one window must not affect the other.
 *
 *   4. `file_added` side-effect: every `file_added` event lands a
 *      `bridgeLogKchatFileEventReceived(...)` audit row with
 *      `triggered_reindex=false`. The forwarder does not call
 *      any source-registry or reindex bridge methods — the
 *      second-pass Devin Review on PR #43 (`BUG_pr-review-job-
 *      ...0001`) caught that a `file_added` event arrives BEFORE
 *      the new file is downloaded into the cache directory, so
 *      reindex was a blocking no-op under the source-manager
 *      mutex; the third-pass review (`ANALYSIS_pr-review-job-
 *      ...0001`) followed up by removing the now-dead source
 *      lookup surface. The audit flag is preserved as a reserved
 *      slot for the future auto-sync iteration; for now it is
 *      always `false`. When the bridge is absent, no audit row
 *      is observable but the forwarder MUST NOT throw.
 *
 *   5. Status push: `client.onStatusChange` callbacks are
 *      forwarded over `kchat:status` to every non-destroyed
 *      window.
 *
 *   6. Disposal: `dispose()` releases both subscriptions and
 *      clears per-window state; subsequent calls to `start(...)`
 *      re-subscribe cleanly.
 *
 *   7. Hostile-payload tolerance: a listener throw must NOT
 *      escape the forwarder's WS handler back into the client's
 *      multicast loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as nodeOs from "os";
import * as nodePath from "path";
import * as nodeFs from "fs";
import * as nodeFsPromises from "fs/promises";

// Redirect `os.homedir()` to a per-suite tmpdir so the Block B
// Task 2 single-file sync (which writes downloaded bytes to
// `<homedir>/.tessera/kchat-channels/<channelId>/`) does not
// pollute the real user home with test fixtures. Mirrors the
// pattern in `kchatIpc.test.ts`.
const TEST_HOME = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "tessera-kchat-fwd-test-"),
);
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os");
  return {
    ...actual,
    default: actual,
    homedir: () => TEST_HOME,
  };
});

// We mock `electron` so importing the forwarder works under
// vitest. The native bridge (formerly imported as a free
// `getBridge` from `../appState`) is now injected through the
// forwarder's constructor `getBridge` option — ninth-pass Devin
// Review on PR #43 (`ANALYSIS_pr-review-job-...0003`) flagged the
// circular `appState` ↔ `kchatEventForwarder` import as fragile,
// and the fix replaces the module-level import with a DI accessor.
// Tests now build the bridge mock locally and pass
// `getBridge: () => bridgeMock` to every `new
// KchatEventForwarder({ ... })` call site.
vi.mock("electron", () => {
  return {
    BrowserWindow: class {
      static getAllWindows() {
        return [];
      }
    },
  };
});

interface BridgeMockShape {
  bridgeLogKchatFileEventReceived: ReturnType<typeof vi.fn>;
  bridgeIsKchatChannelLinked: ReturnType<typeof vi.fn>;
  bridgeIndexKchatFile: ReturnType<typeof vi.fn>;
  bridgeLogKchatFileDownloaded: ReturnType<typeof vi.fn>;
  // Block B Task 3 — ACL projection bridge surface.
  bridgeRefreshKchatAcl: ReturnType<typeof vi.fn>;
  bridgeRevokeKchatSource: ReturnType<typeof vi.fn>;
  bridgeLogKchatAclRefreshed: ReturnType<typeof vi.fn>;
  bridgeLogKchatChannelAccessRevoked: ReturnType<typeof vi.fn>;
  // Block B Task 4 — cryptoshred audit surface.
  bridgeLogKchatSourceCryptoshredded: ReturnType<typeof vi.fn>;
  // Block C Task 1 — chat-post ingest / edit /
  // delete bridge surface + matching audit logger surface.
  bridgeIngestKchatPost: ReturnType<typeof vi.fn>;
  bridgeEditKchatPost: ReturnType<typeof vi.fn>;
  bridgeDeleteKchatPost: ReturnType<typeof vi.fn>;
  bridgeLogKchatPostIngested: ReturnType<typeof vi.fn>;
  bridgeLogKchatPostEdited: ReturnType<typeof vi.fn>;
  bridgeLogKchatPostDeleted: ReturnType<typeof vi.fn>;
  // Session 8 Task 6 — inbound task auto-create target.
  bridgeCreateTask: ReturnType<typeof vi.fn>;
}

let bridgeMock: BridgeMockShape | null = null;

import {
  KchatEventForwarder,
  RING_BUFFER_CAP,
  toRendererEventView,
  KCHAT_EVENT_CHANNEL,
  KCHAT_STATUS_CHANNEL,
} from "../kchat/kchatEventForwarder";
import {
  manifestPathFor,
  writeManifest,
} from "../kchat/kchatChannelSyncer";
import type { PostNotification } from "../kchat/kchatNotify";
import { kchatChannelCacheDir } from "../kchat/kchatPaths";
import type {
  KchatClient,
  KchatStatusListener,
  KchatWebSocketListener,
} from "../kchat/kchatClient";
import type {
  KchatConnectionState,
  KchatWebSocketEvent,
} from "../kchat/kchatTypes";

/**
 * Minimal stand-in for the parts of `KchatClient` the forwarder
 * actually uses. We expose the captured listeners so tests can
 * drive them directly.
 */
class FakeClient {
  wsListeners = new Set<KchatWebSocketListener>();
  statusListeners = new Set<KchatStatusListener>();

  onWebSocketEvent(listener: KchatWebSocketListener): () => void {
    this.wsListeners.add(listener);
    return () => this.wsListeners.delete(listener);
  }

  onStatusChange(listener: KchatStatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  triggerWsEvent(event: KchatWebSocketEvent): void {
    for (const l of [...this.wsListeners]) l(event);
  }

  triggerStatusChange(state: KchatConnectionState): void {
    for (const l of [...this.statusListeners]) l(state);
  }

  // Block B Task 2: the forwarder's `handleFileAdded` calls
  // `client.getFileInfo` and `client.downloadFile` to resolve
  // and fetch the file referenced by a `file_added` event.
  // Tests inject canned responses via these `vi.fn`s.
  getFileInfo = vi.fn(async (fileId: string) => {
    return {
      id: fileId,
      name: `${fileId}.txt`,
      size: 4,
      mime_type: "text/plain",
      extension: "txt",
      create_at: 1,
      update_at: 1,
      delete_at: 0,
      user_id: "u-1",
      channel_id: "c-1",
      post_id: "p-1",
    };
  });

  downloadFile = vi.fn(async (_fileId: string) =>
    new Uint8Array([0x6f, 0x6b, 0x21, 0x0a]),
  );

  // the forwarder's
  // `handleMembershipEvent` walks `listChannelMembers` to build
  // the authoritative roster fed to `bridgeRefreshKchatAcl`.
  // Default fixture: a single membership row that contains the
  // "principal" so the projection lands as `granted`. Tests that
  // exercise the `revoked` / `regranted` paths override via
  // `.mockImplementation(...)`.
  listChannelMembers = vi.fn(
    async (channelId: string, _page = 0, _perPage = 200) => [
      {
        channel_id: channelId,
        user_id: "principal",
        roles: "channel_user",
        last_viewed_at: 0,
        msg_count: 0,
        mention_count: 0,
        notify_props: {},
        last_update_at: 0,
      },
    ],
  );

  // Session 8 Task 3: the watch side-effect resolves the post
  // author's username for the notification title via
  // `getUsersByIds`, and reads the local user id via `getUser`
  // for self-suppression. Defaults: the local user is `self`, and
  // any looked-up id resolves to a `<id>-name` username so a test
  // can assert the resolved name landed in the notification.
  getUser = vi.fn(() => ({
    id: "self",
    username: "self-user",
    email: "self@example.com",
    first_name: "",
    last_name: "",
  }));

  getUsersByIds = vi.fn(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      username: `${id}-name`,
      email: `${id}@example.com`,
      first_name: "",
      last_name: "",
    })),
  );
}

/**
 * Fake `BrowserWindow` exposing only the surface the forwarder
 * touches: `id`, `isDestroyed()`, `webContents.send(...)`, and
 * the `closed` event lifecycle.
 *
 * `sends` captures every `(channel, payload)` pair the
 * forwarder pushes so a test can assert delivery order and
 * payload shape without rendering anything.
 */
class FakeWindow {
  static nextId = 1;
  id: number;
  destroyed = false;
  sends: Array<{ channel: string; payload: unknown }> = [];
  private listeners = new Map<string, Array<() => void>>();
  webContents = {
    send: (channel: string, payload: unknown) => {
      this.sends.push({ channel, payload });
    },
  };

  constructor() {
    this.id = FakeWindow.nextId++;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  once(event: string, cb: () => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(cb);
    this.listeners.set(event, list);
  }

  removeListener(event: string, cb: () => void): void {
    const list = this.listeners.get(event);
    if (!list) return;
    this.listeners.set(
      event,
      list.filter((l) => l !== cb),
    );
  }

  /** Simulate window-close: fires `closed` listeners. */
  close(): void {
    this.destroyed = true;
    const list = this.listeners.get("closed");
    if (!list) return;
    for (const cb of [...list]) cb();
  }
}

/**
 * Poll until `predicate()` returns true, or throw after
 * `timeoutMs`. Used by the Block B Task 2 single-file sync
 * tests so they can wait for real filesystem I/O (mkdir,
 * writeFile, rename) to settle across macrotask boundaries —
 * yielding microtasks alone is not enough because
 * `fs/promises` resolves on the libuv thread pool.
 */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `waitForCondition timed out after ${timeoutMs}ms`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeRawEvent(
  overrides: Partial<KchatWebSocketEvent> = {},
): KchatWebSocketEvent {
  return {
    event: "file_added",
    data: {},
    broadcast: {
      omit_users: {},
      user_id: "user-1",
      channel_id: "chan-A",
      team_id: "team-1",
    },
    seq: 1,
    ...overrides,
  };
}

beforeEach(() => {
  bridgeMock = {
    bridgeLogKchatFileEventReceived: vi.fn(),
    // Default: channel unlinked. Tests that exercise the
    // single-file sync override this to `true`.
    bridgeIsKchatChannelLinked: vi.fn(() => false),
    bridgeIndexKchatFile: vi.fn(() => ({
      wasLinked: true,
      indexed: true,
      sourceId: "src-uuid",
    })),
    bridgeLogKchatFileDownloaded: vi.fn(),
    bridgeRefreshKchatAcl: vi.fn(() => ({
      outcome: "granted",
      memberCount: 0,
      principalPresent: true,
      // refresh outcomes carry
      // cryptoshred counts; non-revoke paths always emit zero.
      chunksDropped: 0,
      filesDropped: 0,
      // post + DEK counts. Mirror
      // the chunks/files zero-on-non-revoke contract.
      postsDropped: 0,
      dekDropped: false,
      // Fifth-pass Devin Review fix
      // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): substrate's
      // Phase 5 `VACUUM` outcome surfaced through the bridge
      // outcome struct. Default-true matches the no-op /
      // granted-path semantics (no VACUUM ran).
      vacuumSucceeded: true,
      vacuumError: undefined,
    })),
    // the bridge's revoke outcome
    // now carries the substrate's cryptoshred counts on both
    // `revoked` and `already_revoked` paths. The default fixture
    // returns the live-evidence shape (1 file, 1 chunk) so the
    // shred audit row always lands in tests that exercise
    // `handleChannelGoneEvent`; tests that exercise the
    // idempotent re-revoke path override with zero counts.
    bridgeRevokeKchatSource: vi.fn(() => ({
      outcome: "revoked",
      chunksDropped: 1,
      filesDropped: 1,
      // post + DEK counts default to
      // zero/false for the file-only happy-path; the dedicated
      // chat-post coverage overrides these.
      postsDropped: 0,
      dekDropped: false,
      // Fifth-pass Devin Review fix
      // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): default-true
      // matches the happy-path multi-row scrub; the dedicated
      // VACUUM-failure regression overrides this to exercise
      // `vacuum_succeeded=false`.
      vacuumSucceeded: true,
      vacuumError: undefined,
    })),
    bridgeLogKchatAclRefreshed: vi.fn(),
    bridgeLogKchatChannelAccessRevoked: vi.fn(),
    bridgeLogKchatSourceCryptoshredded: vi.fn(),
    // the chat-post ingest path
    // returns a substrate outcome short-code + chunk count.
    // Default to `ingested`/`unchanged` so the happy-path
    // dispatch test sees the audit row land with a non-no_post
    // outcome.
    bridgeIngestKchatPost: vi.fn(() => ({
      outcome: "ingested",
      chunkCount: 1,
    })),
    bridgeEditKchatPost: vi.fn(() => ({
      outcome: "edited",
      chunkCount: 1,
    })),
    bridgeDeleteKchatPost: vi.fn(() => ({
      outcome: "deleted",
      chunksDropped: 1,
    })),
    bridgeLogKchatPostIngested: vi.fn(),
    bridgeLogKchatPostEdited: vi.fn(),
    bridgeLogKchatPostDeleted: vi.fn(),
    bridgeCreateTask: vi.fn(() => ({ id: "task-created-1" })),
  };
});

afterEach(() => {
  bridgeMock = null;
});

describe("toRendererEventView", () => {
  it("flattens broadcast envelope and drops omit_users", () => {
    const view = toRendererEventView({
      event: "posted",
      data: { post: "hi" },
      broadcast: {
        omit_users: { "user-spam": true },
        user_id: "user-42",
        channel_id: "chan-7",
        team_id: "team-X",
      },
      seq: 17,
    });
    expect(view).toEqual({
      event: "posted",
      channelId: "chan-7",
      teamId: "team-X",
      userId: "user-42",
      seq: 17,
      data: { post: "hi" },
    });
    // The omit_users surface must NOT appear on the renderer
    // view — it carries KChat-server routing details.
    expect(view).not.toHaveProperty("omit_users");
    expect(view).not.toHaveProperty("broadcast");
  });

  it("returns null for missing channel / team / user ids", () => {
    const view = toRendererEventView({
      event: "hello",
      data: {},
      broadcast: { omit_users: {} },
      seq: 1,
    });
    expect(view.channelId).toBeNull();
    expect(view.teamId).toBeNull();
    expect(view.userId).toBeNull();
  });
});

describe("KchatEventForwarder", () => {
  it("delivers events to every non-destroyed window", async () => {
    const w1 = new FakeWindow();
    const w2 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1, w2] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({ event: "posted", data: { msg: "hi" }, seq: 5 }),
    );
    // Drain is deferred to the next microtask; yield once so
    // the test observes the post-drain state.
    await Promise.resolve();
    expect(w1.sends).toHaveLength(1);
    expect(w2.sends).toHaveLength(1);
    expect(w1.sends[0].channel).toBe(KCHAT_EVENT_CHANNEL);
    expect(w1.sends[0].payload).toMatchObject({
      event: "posted",
      channelId: "chan-A",
      seq: 5,
    });
    expect(w2.sends[0]).toEqual(w1.sends[0]);
    fwd.dispose();
  });

  it("skips destroyed windows", async () => {
    const w1 = new FakeWindow();
    const w2 = new FakeWindow();
    w2.destroyed = true;
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1, w2] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(makeRawEvent({ event: "posted" }));
    await Promise.resolve();
    expect(w1.sends).toHaveLength(1);
    expect(w2.sends).toHaveLength(0);
    fwd.dispose();
  });

  it("releases per-window state when the window closes", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(makeRawEvent({ event: "posted" }));
    await Promise.resolve();
    expect(fwd.getPendingForWindow(w1.id)).toEqual([]);
    expect(fwd.getDroppedCountForWindow(w1.id)).toBe(0);

    w1.close();
    // After close, the per-window state slot is released.
    expect(fwd.getPendingForWindow(w1.id)).toEqual([]);
    fwd.dispose();
  });

  it("drops oldest when a single-tick burst exceeds the cap", async () => {
    // The forwarder defers drain to a microtask via
    // `queueMicrotask`, so a sequence of `triggerWsEvent`
    // calls within a single synchronous block accumulates in
    // the buffer before the drain runs. We push
    // RING_BUFFER_CAP + N events; the first N are evicted in
    // FIFO order and `dropped` rises to N.
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    const overage = 7;
    for (let i = 0; i < RING_BUFFER_CAP + overage; i++) {
      client.triggerWsEvent(
        makeRawEvent({ event: "posted", seq: i, data: { idx: i } }),
      );
    }
    // After the burst but BEFORE the microtask boundary the
    // buffer contains exactly RING_BUFFER_CAP entries and
    // the dropped count is `overage`.
    expect(fwd.getPendingForWindow(w1.id)).toHaveLength(RING_BUFFER_CAP);
    expect(fwd.getDroppedCountForWindow(w1.id)).toBe(overage);
    // The OLDEST `overage` events were dropped; the head of
    // the buffer should now be seq=overage.
    expect(fwd.getPendingForWindow(w1.id)[0]).toMatchObject({
      seq: overage,
    });

    // After the microtask boundary the drain runs and the
    // renderer sees exactly RING_BUFFER_CAP events (newest
    // ones, FIFO).
    await Promise.resolve();
    expect(w1.sends).toHaveLength(RING_BUFFER_CAP);
    expect((w1.sends[0].payload as { seq: number }).seq).toBe(overage);
    expect(
      (w1.sends[w1.sends.length - 1].payload as { seq: number }).seq,
    ).toBe(RING_BUFFER_CAP + overage - 1);
    fwd.dispose();
  });

  it("coalesces drains within a single microtask boundary", async () => {
    // The `drainScheduled` guard collapses repeated schedule
    // requests within one synchronous run into a single
    // microtask — this test verifies that 50 events arriving
    // back-to-back result in exactly 1 drain pass (the
    // observable proxy is: the buffer is empty after the
    // first await and all sends happened in the same
    // microtask).
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    for (let i = 0; i < 50; i++) {
      client.triggerWsEvent(makeRawEvent({ event: "posted", seq: i }));
    }
    expect(fwd.getPendingForWindow(w1.id)).toHaveLength(50);
    await Promise.resolve();
    expect(fwd.getPendingForWindow(w1.id)).toHaveLength(0);
    expect(w1.sends).toHaveLength(50);
    fwd.dispose();
  });

  // Block B Task 2: an unlinked channel (no `SourceType::Kchat`
  // source row for `cacheDir`) short-circuits before any REST
  // call. The audit row still fires with
  // `triggered_reindex=false` — i.e. the indexer did NOT accept
  // the event because there was no indexer state to update.
  // This is the dominant case in production (most channels a
  // user can see are NOT linked as corpus sources).
  it("audits file_added with triggered_reindex=false when the channel is unlinked", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-XYZ" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-A",
          team_id: "team-1",
          user_id: "user-1",
        },
      }),
    );
    // Yield several microtasks: the forwarder's
    // `handleFileAdded` Promise resolves after at least one
    // microtask, then the call-site `.catch(...)` adds another.
    // Yielding 5 times covers any extra hop the syncer adds.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(
      bridgeMock!.bridgeLogKchatFileEventReceived,
    ).toHaveBeenCalledWith("file_added", "chan-A", "file-XYZ", false);
    // The forwarder MUST NOT have called the REST client for
    // an unlinked channel (the bridge linked-check is the
    // fast-path early exit).
    expect(client.getFileInfo).not.toHaveBeenCalled();
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeIndexKchatFile).not.toHaveBeenCalled();
    fwd.dispose();
  });

  // A `file_added` event whose `broadcast` envelope omits the
  // `channel_id` field: the audit row still fires (the forwarder
  // doesn't refuse to audit on a missing channel id), but the
  // recorded channel argument is `null` — the projection in
  // `toRendererEventView` falls back to `null` via `?? null`.
  // This pins the contract the audit-log consumer relies on:
  // "channel_id present in the audit row iff the WS frame carried
  // one", so an operator grepping for orphan audit rows can
  // distinguish a server-emitted-without-channel event from a
  // server-emitted-with-channel-X event without having to consult
  // the WS log.
  //
  // The original draft of this test passed `makeRawEvent({ event:
  // "file_added", data: { file_id: "file-ABC" } })`, which kept the
  // default `broadcast.channel_id = "chan-A"` from the factory.
  // The assertion still passed because `chan-A` is what flowed
  // through, but the test title was a lie. Fifth-pass Devin Review
  // on PR #43 (`BUG_pr-review-job-...0001`).
  it("audits file_added even when no channel-id is present in broadcast", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-ABC" },
        // Override the entire broadcast envelope to one that has
        // NO `channel_id`. `omit_users` is the only required field
        // on the KChat protocol broadcast shape; the rest are
        // optional. The forwarder must accept this and pass
        // `null` as the channel argument to the audit bridge.
        broadcast: { omit_users: {} },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      bridgeMock!.bridgeLogKchatFileEventReceived,
    ).toHaveBeenCalledWith("file_added", null, "file-ABC", false);
    fwd.dispose();
  });

  it("does not audit non-file_added events", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(makeRawEvent({ event: "posted" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(bridgeMock!.bridgeLogKchatFileEventReceived).not.toHaveBeenCalled();
    fwd.dispose();
  });

  it("tolerates a missing bridge on file_added", async () => {
    bridgeMock = null;
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    expect(() =>
      client.triggerWsEvent(
        makeRawEvent({ event: "file_added", data: { file_id: "f-1" } }),
      ),
    ).not.toThrow();
    await Promise.resolve();
    fwd.dispose();
  });

  it("forwards status changes to every renderer window", () => {
    const w1 = new FakeWindow();
    const w2 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1, w2] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    client.triggerStatusChange({
      state: "connected",
      serverUrl: "https://kchat.example.com",
      user: {
        id: "u-1",
        username: "alice",
        email: "a@example.com",
        firstName: "Alice",
        lastName: "Anderson",
      },
    });
    expect(w1.sends).toEqual([
      {
        channel: KCHAT_STATUS_CHANNEL,
        payload: expect.objectContaining({ state: "connected" }),
      },
    ]);
    expect(w2.sends).toEqual([
      {
        channel: KCHAT_STATUS_CHANNEL,
        payload: expect.objectContaining({ state: "connected" }),
      },
    ]);
    fwd.dispose();
  });

  it("dispose() unsubscribes both listeners and re-start works", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    expect(client.wsListeners.size).toBe(1);
    expect(client.statusListeners.size).toBe(1);
    fwd.dispose();
    expect(client.wsListeners.size).toBe(0);
    expect(client.statusListeners.size).toBe(0);

    // Re-start: a fresh listener is installed and events flow
    // again.
    fwd.start(client as unknown as KchatClient);
    expect(client.wsListeners.size).toBe(1);
    client.triggerWsEvent(makeRawEvent({ event: "posted" }));
    await Promise.resolve();
    expect(w1.sends).toHaveLength(1);
    fwd.dispose();
  });

  it("start() is idempotent", () => {
    const fwd = new KchatEventForwarder({
      listWindows: () => [] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.start(client as unknown as KchatClient);
    fwd.start(client as unknown as KchatClient);
    expect(client.wsListeners.size).toBe(1);
    expect(client.statusListeners.size).toBe(1);
    fwd.dispose();
  });

  it("dispose() short-circuits a pending drain microtask", async () => {
    // Regression for fourth-pass Devin Review on PR #43
    // (ANALYSIS_pr-review-job-..._0005). `queueMicrotask`
    // cannot be cancelled, so a drain scheduled before
    // `dispose()` will fire after. Without the `disposed`
    // guard the drain would call `webContents.send` on a
    // stale window reference. With the guard the drain
    // observes `disposed === true` and bails out cleanly.
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(makeRawEvent({ event: "posted", seq: 1 }));
    // The drain is queued but not yet run. Dispose
    // immediately, before the microtask boundary.
    fwd.dispose();
    // Yield so the queued microtask gets a chance to fire.
    await Promise.resolve();
    // The window must NOT have received the send — the drain
    // must have short-circuited on the `disposed` flag.
    expect(w1.sends).toHaveLength(0);
  });

  it("start() after dispose() re-arms the forwarder", async () => {
    // Tests recycle forwarders by calling dispose() then
    // start() again. The `disposed` flag is sticky inside
    // dispose() so we explicitly reset it on start() —
    // otherwise the second-cycle forwarder would silently
    // drop every event because `disposed` was still true.
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.dispose();
    // Re-start on a fresh client — same forwarder instance.
    const client2 = new FakeClient();
    fwd.start(client2 as unknown as KchatClient);
    client2.triggerWsEvent(makeRawEvent({ event: "posted", seq: 3 }));
    await Promise.resolve();
    expect(w1.sends).toHaveLength(1);
    expect(w1.sends[0].payload).toMatchObject({ event: "posted", seq: 3 });
    fwd.dispose();
  });

  // ----------------------------------------------------------------
  // Block B Task 2: targeted single-file sync on file_added.
  // ----------------------------------------------------------------

  it("targeted single-file sync downloads, writes, indexes, and audits triggered_reindex=true on a linked channel", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    bridgeMock!.bridgeIndexKchatFile.mockReturnValue({
      wasLinked: true,
      indexed: true,
      sourceId: "src-uuid",
    });
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-NEW-001" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-linked-1",
          team_id: "team-1",
          user_id: "user-1",
        },
      }),
    );
    // The single-file sync awaits real filesystem I/O (mkdir,
    // readFile, writeFile, rename) so the assertions must wait
    // for macrotask boundaries, not just microtasks. We poll
    // until the `bridgeIndexKchatFile` spy fires or a timeout
    // expires.
    await waitForCondition(
      () => bridgeMock!.bridgeIndexKchatFile.mock.calls.length > 0,
    );

    expect(bridgeMock!.bridgeIsKchatChannelLinked).toHaveBeenCalled();
    expect(client.getFileInfo).toHaveBeenCalledWith("file-NEW-001");
    expect(client.downloadFile).toHaveBeenCalledWith("file-NEW-001");
    expect(bridgeMock!.bridgeIndexKchatFile).toHaveBeenCalledTimes(1);
    const [cacheDir, basename] =
      bridgeMock!.bridgeIndexKchatFile.mock.calls[0];
    expect(cacheDir).toContain("chan-linked-1");
    expect(basename).toBe("file-NEW-001.txt");
    // Audit row reflects the successful index.
    expect(
      bridgeMock!.bridgeLogKchatFileEventReceived,
    ).toHaveBeenCalledWith(
      "file_added",
      "chan-linked-1",
      "file-NEW-001",
      true,
    );
    // Per-file download audit row also lands.
    expect(
      bridgeMock!.bridgeLogKchatFileDownloaded,
    ).toHaveBeenCalledWith("chan-linked-1", "file-NEW-001.txt", 4);
    fwd.dispose();
  });

  it("targeted sync audits triggered_reindex=false when substrate dedupes the file (indexed=false)", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    // Substrate reports `indexed=false` — i.e. the file's
    // content hash matched an existing evidence row and no
    // re-extraction was needed.
    bridgeMock!.bridgeIndexKchatFile.mockReturnValue({
      wasLinked: true,
      indexed: false,
      sourceId: "src-uuid",
    });
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-DEDUPED-001" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-linked-2",
          team_id: "team-1",
          user_id: "user-1",
        },
      }),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeIndexKchatFile.mock.calls.length > 0,
    );

    // The download and index calls still ran; the audit row
    // reflects the indexer's decision (no acceptance).
    expect(bridgeMock!.bridgeIndexKchatFile).toHaveBeenCalledTimes(1);
    expect(
      bridgeMock!.bridgeLogKchatFileEventReceived,
    ).toHaveBeenCalledWith(
      "file_added",
      "chan-linked-2",
      "file-DEDUPED-001",
      false,
    );
    fwd.dispose();
  });

  it("targeted sync degrades to triggered_reindex=false when the REST download throws", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    client.downloadFile.mockRejectedValue(
      new Error("transient network failure"),
    );
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-NETWORK-001" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-linked-3",
          team_id: "team-1",
          user_id: "user-1",
        },
      }),
    );
    // The download throw rejects the lock body. Poll on the
    // audit row firing (the forwarder's outer catch always
    // audits before returning).
    await waitForCondition(
      () => bridgeMock!.bridgeLogKchatFileEventReceived.mock.calls.length > 0,
    );

    // The substrate was NOT called because the download
    // failed before the index step.
    expect(bridgeMock!.bridgeIndexKchatFile).not.toHaveBeenCalled();
    // Audit row reflects the failure (triggered_reindex=false).
    expect(
      bridgeMock!.bridgeLogKchatFileEventReceived,
    ).toHaveBeenCalledWith(
      "file_added",
      "chan-linked-3",
      "file-NETWORK-001",
      false,
    );
    fwd.dispose();
  });

  it("serialises concurrent file_added events for the same channel via withChannelSyncLock", async () => {
    // Two file_added events fire back-to-back for the same
    // channel. The per-channel mutex must serialise their
    // `bridgeIndexKchatFile` calls so a manifest write race
    // cannot drop one of the files from the recorded set.
    // We pin the ordering by gating `downloadFile` on a
    // manually-resolved promise per file id and asserting that
    // the second call only starts after the first resolves.
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();

    const downloadStarted: string[] = [];
    let resolveFirst: ((v: Uint8Array) => void) | null = null;
    client.downloadFile.mockImplementation(async (fileId: string) => {
      downloadStarted.push(fileId);
      if (fileId === "file-A") {
        // Block on the first call; the second call should
        // NOT have started by the time we observe `downloadStarted`.
        return new Promise<Uint8Array>((r) => {
          resolveFirst = r;
        });
      }
      return new Uint8Array([0x6f, 0x6b]);
    });
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-A" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-serial",
          team_id: "t",
          user_id: "u",
        },
      }),
    );
    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-B" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-serial",
          team_id: "t",
          user_id: "u",
        },
      }),
    );
    // Yield enough microtasks for the first `handleFileAdded`
    // to start its download. Only the first file's download
    // should have started; the second is queued on the lock.
    await waitForCondition(() => downloadStarted.length === 1);
    expect(downloadStarted).toEqual(["file-A"]);

    // Resolve the first download; the second one should now
    // run to completion.
    resolveFirst?.(new Uint8Array([0x6f, 0x6b]));
    await waitForCondition(
      () => bridgeMock!.bridgeIndexKchatFile.mock.calls.length === 2,
    );

    expect(downloadStarted).toEqual(["file-A", "file-B"]);
    expect(bridgeMock!.bridgeIndexKchatFile).toHaveBeenCalledTimes(2);
    fwd.dispose();
  });

  it("rejects manifest fast-path when the recorded name escapes cacheDir (defence-in-depth containment)", async () => {
    // Block B Task 2 defence-in-depth: the manifest is a
    // human-readable sidecar JSON. If an attacker with
    // filesystem access tampers with it to inject an escaping
    // path (e.g. `../../etc/passwd`), the forwarder's
    // fast-path must NOT call `fs.access` on that path (probing
    // a path outside the cache directory is an information
    // leak) and MUST NOT pass the tampered name to the bridge.
    // Falling through to the download path is the safe
    // behaviour — `downloadKchatFileToCache` re-derives a
    // sanitised, contained basename from the legitimate
    // server-supplied `fi.name`.
    const channelId = "chan-tampered-manifest";
    // Inject `getCacheDir` so the path the test writes to is
    // STRUCTURALLY bound to the path the forwarder resolves.
    // Without injection, both sides happen to align via the
    // file-level `os.homedir` mock + `kchatChannelCacheDir`
    // default — but a future refactor that changes either
    // could silently diverge. The injected resolver pins the
    // wiring contract.
    const getCacheDir = (id: string) => kchatChannelCacheDir(id);
    const cacheDir = getCacheDir(channelId);
    await nodeFs.promises.mkdir(cacheDir, { recursive: true });
    // Pre-seed the manifest with an escaping path. The
    // manifest writer (under our control) would NEVER produce
    // this, but a malicious filesystem actor could.
    await writeManifest(cacheDir, {
      version: 1,
      channelId,
      files: { "file-TAMPER-001": "../../../etc/passwd" },
    });

    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    bridgeMock!.bridgeIndexKchatFile.mockReturnValue({
      wasLinked: true,
      indexed: true,
      sourceId: "src-uuid",
    });
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      getCacheDir,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-TAMPER-001" },
        broadcast: {
          omit_users: {},
          channel_id: channelId,
          team_id: "t",
          user_id: "u",
        },
      }),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeIndexKchatFile.mock.calls.length > 0,
    );

    // The fast-path was rejected, so the syncer re-derived a
    // sanitised basename and called `downloadFile`.
    expect(client.downloadFile).toHaveBeenCalledWith("file-TAMPER-001");
    // The bridge was called with the legitimate sanitised
    // basename — NEVER the tampered escaping path.
    expect(bridgeMock!.bridgeIndexKchatFile).toHaveBeenCalledTimes(1);
    const [, basename] =
      bridgeMock!.bridgeIndexKchatFile.mock.calls[0];
    expect(basename).toBe("file-TAMPER-001.txt");
    expect(basename).not.toContain("..");
    expect(basename).not.toContain("/");
    expect(basename).not.toContain("\\");
    // The manifest now records the legitimate sanitised name
    // (the tampered entry was replaced).
    const finalManifest = JSON.parse(
      await nodeFs.promises.readFile(manifestPathFor(cacheDir), "utf-8"),
    ) as { files: Record<string, string> };
    expect(finalManifest.files["file-TAMPER-001"]).toBe(
      "file-TAMPER-001.txt",
    );
    fwd.dispose();
  });

  // ----------------------------------------------------------------
  // KChat channel ACL projection
  // dispatch.
  //
  // The forwarder dispatches five new event types into the
  // ACL projection path:
  //   - `user_added`, `user_removed`, `channel_member_updated`,
  //     `channel_updated` → walk `listChannelMembers` →
  //     `bridgeRefreshKchatAcl` → audit `bridgeLogKchatAclRefreshed`.
  //   - `channel_archived`, `channel_deleted` →
  //     `bridgeRevokeKchatSource` → audit
  //     `bridgeLogKchatChannelAccessRevoked`.
  //
  // Tests pin both the dispatch surface (correct bridge call for
  // each event name) and the audit shape (outcome short-codes,
  // member count, principal-present flag).
  // ----------------------------------------------------------------

  for (const eventName of [
    "user_added",
    "user_removed",
    "channel_member_updated",
    "channel_updated",
  ] as const) {
    it(`dispatches ${eventName} into bridgeRefreshKchatAcl and audits the outcome`, async () => {
      bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
      const w1 = new FakeWindow();
      const fwd = new KchatEventForwarder({
        listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
        getBridge: () => bridgeMock,
      });
      const client = new FakeClient();
      fwd.start(client as unknown as KchatClient);

      client.triggerWsEvent(
        makeRawEvent({
          event: eventName,
          data: { user_id: "principal" },
          broadcast: {
            omit_users: {},
            channel_id: "chan-acl-1",
            team_id: "team-1",
            user_id: "principal",
          },
          seq: 7,
        }),
      );
      await waitForCondition(
        () => bridgeMock!.bridgeRefreshKchatAcl.mock.calls.length > 0,
      );

      // Bridge called with the cache dir + the roster the
      // FakeClient returned.
      expect(client.listChannelMembers).toHaveBeenCalled();
      expect(bridgeMock!.bridgeRefreshKchatAcl).toHaveBeenCalledTimes(1);
      const [cacheDir, members] =
        bridgeMock!.bridgeRefreshKchatAcl.mock.calls[0];
      expect(cacheDir).toContain("chan-acl-1");
      expect(members).toEqual([
        { userId: "principal", role: "channel_user" },
      ]);

      // Audit row fires with the projection outcome (event name
      // is folded into the outcome short-code).
      expect(bridgeMock!.bridgeLogKchatAclRefreshed).toHaveBeenCalledWith(
        "chan-acl-1",
        0,
        true,
        `granted:${eventName}`,
      );
      // No revoke audit on a granted projection.
      expect(
        bridgeMock!.bridgeLogKchatChannelAccessRevoked,
      ).not.toHaveBeenCalled();
      fwd.dispose();
    });
  }

  it("dispatches a revoked outcome and emits the principal-missing access-revoked audit row", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    // refresh-driven revoke surfaces
    // the substrate's cryptoshred counts so the forwarder can
    // emit both `KchatChannelAccessRevoked` AND
    // `KchatSourceCryptoshredded` audit rows.
    bridgeMock!.bridgeRefreshKchatAcl.mockReturnValue({
      outcome: "revoked",
      memberCount: 3,
      principalPresent: false,
      chunksDropped: 5,
      filesDropped: 2,
      postsDropped: 0,
      dekDropped: false,
      vacuumSucceeded: true,
      vacuumError: undefined,
    });
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "user_removed",
        data: { user_id: "principal" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-acl-revoke",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 8,
      }),
    );
    await waitForCondition(
      () =>
        bridgeMock!.bridgeLogKchatChannelAccessRevoked.mock.calls.length > 0,
    );

    expect(bridgeMock!.bridgeLogKchatAclRefreshed).toHaveBeenCalledWith(
      "chan-acl-revoke",
      3,
      false,
      "revoked:user_removed",
    );
    expect(
      bridgeMock!.bridgeLogKchatChannelAccessRevoked,
    ).toHaveBeenCalledWith(
      "chan-acl-revoke",
      "principal_missing_from_roster",
    );
    // cryptoshred audit row lands
    // with substrate-authoritative counts (chunks_dropped=5,
    // files_dropped=2). The reason matches the sibling
    // access-revoked row so an operator's grep can correlate.
    expect(
      bridgeMock!.bridgeLogKchatSourceCryptoshredded,
    ).toHaveBeenCalledWith(
      "chan-acl-revoke",
      "principal_missing_from_roster",
      5,
      2,
      0,
      false,
      true,
      undefined,
      true,
      undefined,
    );
    fwd.dispose();
  });

  it("dispatches a regranted outcome and schedules a full channel re-sync via scheduleChannelResync", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    // Block B Task 4 second-pass Devin Review: when the substrate transitions a previously-
    // revoked source back to `Connected`, it reports
    // `outcome=regranted` so the forwarder schedules a full
    // channel re-sync (the revoke path scrubbed every chunk +
    // indexed_file row, so the source has zero indexed content
    // until the re-sync re-walks the file roster). The
    // `scheduleChannelResync` callback is fire-and-forget; we
    // assert it lands by polling its mock's call count.
    bridgeMock!.bridgeRefreshKchatAcl.mockReturnValue({
      outcome: "regranted",
      memberCount: 4,
      principalPresent: true,
      chunksDropped: 0,
      filesDropped: 0,
      postsDropped: 0,
      dekDropped: false,
      vacuumSucceeded: true,
      vacuumError: undefined,
    });
    const w1 = new FakeWindow();
    const scheduleResync = vi.fn(async (_channelId: string) => {
      // Production wires this to the IPC handler's
      // `runAddKchatChannel`; the test stub just records calls.
    });
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      scheduleChannelResync: scheduleResync,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "user_added",
        data: { user_id: "principal" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-acl-regrant",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 11,
      }),
    );
    await waitForCondition(
      () => scheduleResync.mock.calls.length > 0,
    );

    expect(scheduleResync).toHaveBeenCalledTimes(1);
    expect(scheduleResync).toHaveBeenCalledWith("chan-acl-regrant");
    // The ACL refresh audit row still lands with the regranted
    // outcome so the operator-side trail records the transition.
    expect(bridgeMock!.bridgeLogKchatAclRefreshed).toHaveBeenCalledWith(
      "chan-acl-regrant",
      4,
      true,
      "regranted:user_added",
    );
    // The regrant path does NOT emit access-revoked or
    // cryptoshred rows — those are revoke-side concerns.
    expect(
      bridgeMock!.bridgeLogKchatChannelAccessRevoked,
    ).not.toHaveBeenCalled();
    expect(
      bridgeMock!.bridgeLogKchatSourceCryptoshredded,
    ).not.toHaveBeenCalled();
    fwd.dispose();
  });

  it("does not schedule a re-sync when the membership refresh lands as granted", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    // Default `bridgeRefreshKchatAcl` mock returns
    // `outcome: "granted"` (set in the per-test bridgeMock
    // factory above). A `granted` outcome means the principal
    // was already in the roster on the previous refresh — there
    // is no `AccessRevoked` → `Connected` transition and
    // therefore no scrubbed content to re-sync. Scheduling a
    // re-sync here would re-fetch the entire channel on every
    // membership event, defeating the targeted-sync design.
    const w1 = new FakeWindow();
    const scheduleResync = vi.fn(async (_channelId: string) => {});
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      scheduleChannelResync: scheduleResync,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "channel_member_updated",
        data: {},
        broadcast: {
          omit_users: {},
          channel_id: "chan-acl-granted",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 12,
      }),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeLogKchatAclRefreshed.mock.calls.length > 0,
    );

    expect(scheduleResync).not.toHaveBeenCalled();
    fwd.dispose();
  });

  it("audits an unlinked membership event without calling the REST client", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(false);
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "channel_member_updated",
        data: {},
        broadcast: {
          omit_users: {},
          channel_id: "chan-unlinked",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 9,
      }),
    );
    // Yield several microtasks so the side-effect promise
    // resolves.
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(client.listChannelMembers).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeRefreshKchatAcl).not.toHaveBeenCalled();
    // Audit row still fires with outcome=unlinked so operators
    // see the no-op in the trail.
    expect(bridgeMock!.bridgeLogKchatAclRefreshed).toHaveBeenCalledWith(
      "chan-unlinked",
      0,
      false,
      "unlinked:channel_member_updated",
    );
    fwd.dispose();
  });

  for (const [eventName, reason] of [
    ["channel_archived", "channel_archived"],
    ["channel_deleted", "channel_deleted"],
  ] as const) {
    it(`dispatches ${eventName} into bridgeRevokeKchatSource and audits with reason=${reason}`, async () => {
      const w1 = new FakeWindow();
      const fwd = new KchatEventForwarder({
        listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
        getBridge: () => bridgeMock,
      });
      const client = new FakeClient();
      fwd.start(client as unknown as KchatClient);

      client.triggerWsEvent(
        makeRawEvent({
          event: eventName,
          data: {},
          broadcast: {
            omit_users: {},
            channel_id: "chan-gone",
            team_id: "team-1",
            user_id: "principal",
          },
          seq: 10,
        }),
      );
      // Wait on the LAST audit call the handler emits
      // (`bridgeLogKchatSourceCryptoshredded`), not the first
      // bridge call (`bridgeRevokeKchatSource`).
      //
      // Why this matters: `handleChannelGoneEvent` runs as
      //   1. (inside `withChannelSyncLock`)
      //      a. `bridgeRevokeKchatSource(cacheDir)` (sync,
      //         records call here).
      //      b. `await secureDeleteChannelArtifacts(cacheDir)`
      //         (async, hits the libuv thread pool).
      //   2. `safeAuditAccessRevoked(...)` → `bridgeLogKchatChannelAccessRevoked`.
      //   3. `safeAuditSourceCryptoshredded(...)` → `bridgeLogKchatSourceCryptoshredded`.
      //
      // Polling on step 1a returns as soon as the bridge call
      // lands, BEFORE step 1b's `fs.rm` resolves. Under
      // cross-suite parallel load (vitest `--pool=threads` with
      // shared worker contention) the libuv pool can be slow
      // enough that the subsequent `bridgeLogKchatChannelAccessRevoked`
      // assertion fires before step 2 runs, producing a
      // flake. Polling on step 3 (the final audit emission)
      // guarantees the whole handler has run.
      await waitForCondition(
        () =>
          bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls
            .length > 0,
      );

      expect(bridgeMock!.bridgeRevokeKchatSource).toHaveBeenCalledTimes(1);
      const [cacheDir] =
        bridgeMock!.bridgeRevokeKchatSource.mock.calls[0];
      expect(cacheDir).toContain("chan-gone");
      expect(
        bridgeMock!.bridgeLogKchatChannelAccessRevoked,
      ).toHaveBeenCalledWith("chan-gone", reason);
      // No `bridgeRefreshKchatAcl` for these — the channel is
      // gone, no roster to fetch.
      expect(bridgeMock!.bridgeRefreshKchatAcl).not.toHaveBeenCalled();
      // No `bridgeLogKchatAclRefreshed` on these paths — the
      // audit shape is the revoke-row + shred-row pair only.
      expect(bridgeMock!.bridgeLogKchatAclRefreshed).not.toHaveBeenCalled();
      // the shred audit row pairs
      // with the access-revoked row on every revoke outcome
      // (default fixture returns chunks_dropped=1, files_dropped=1).
      expect(
        bridgeMock!.bridgeLogKchatSourceCryptoshredded,
      ).toHaveBeenCalledWith(
        "chan-gone",
        reason,
        1,
        1,
        0,
        false,
        true,
        undefined,
        true,
        undefined,
      );
      fwd.dispose();
    });
  }

  it("does not dispatch ACL refresh for non-membership events", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(makeRawEvent({ event: "posted", seq: 11 }));
    client.triggerWsEvent(makeRawEvent({ event: "hello", seq: 12 }));
    for (let i = 0; i < 5; i++) await Promise.resolve();

    expect(client.listChannelMembers).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeRefreshKchatAcl).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeRevokeKchatSource).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeLogKchatAclRefreshed).not.toHaveBeenCalled();
    expect(
      bridgeMock!.bridgeLogKchatChannelAccessRevoked,
    ).not.toHaveBeenCalled();
    // no shred audit row on
    // non-membership events — the contract is "shred follows
    // every substrate revoke", not "shred on every WS event".
    expect(
      bridgeMock!.bridgeLogKchatSourceCryptoshredded,
    ).not.toHaveBeenCalled();
    fwd.dispose();
  });

  /**
   * pin the idempotent re-revoke
   * path. On a repeat `channel_archived` event for a previously
   * revoked source, the substrate returns `already_revoked` with
   * zero cryptoshred counts (the first revoke already scrubbed
   * the evidence). The forwarder still emits BOTH audit rows so
   * an operator sees the repeat event and the zero-count shred
   * signal. This is the Task-4 backfill regression path: a
   * legitimate already-revoked source under the Task-3 build
   * goes through the (idempotent) shred on every revoke.
   */
  it("emits a zero-count shred audit row on an already_revoked outcome", async () => {
    bridgeMock!.bridgeRevokeKchatSource.mockReturnValue({
      outcome: "already_revoked",
      chunksDropped: 0,
      filesDropped: 0,
      postsDropped: 0,
      dekDropped: false,
      vacuumSucceeded: true,
      vacuumError: undefined,
    });
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "channel_archived",
        data: {},
        broadcast: {
          omit_users: {},
          channel_id: "chan-re-archive",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 100,
      }),
    );
    // Wait on the FINAL audit emission
    // (`bridgeLogKchatSourceCryptoshredded`) for consistency
    // with the `channel_archived`/`channel_deleted` parameterised
    // block above. The `already_revoked` outcome still fires both
    // audit rows (access-revoked + shred-with-zero-counts), so
    // polling on the LATER of the two guarantees the entire
    // handler chain has settled before assertions run — even
    // though step 2 (`bridgeLogKchatChannelAccessRevoked`) would
    // fire after `await withChannelSyncLock` resolves (the
    // `secureDeleteChannelArtifacts` already-completed
    // invariant). The consistency matters for future maintainers
    // diagnosing parallel flakes: every channel-gone test in
    // this file uses the same waitForCondition signal.
    await waitForCondition(
      () =>
        bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls.length >
        0,
    );

    // Access-revoked audit row still fires — operators want to
    // see the repeat event.
    expect(
      bridgeMock!.bridgeLogKchatChannelAccessRevoked,
    ).toHaveBeenCalledWith("chan-re-archive", "channel_archived");
    // Shred audit row also fires, but with zero counts — the
    // operator-visible signal that the source was previously
    // scrubbed and the re-revoke found nothing to do.
    expect(
      bridgeMock!.bridgeLogKchatSourceCryptoshredded,
    ).toHaveBeenCalledWith(
      "chan-re-archive",
      "channel_archived",
      0,
      0,
      0,
      false,
      true,
      undefined,
      true,
      undefined,
    );
    fwd.dispose();
  });

  /**
   * pin the `unlinked` outcome —
   * the substrate has no source row for this cache_dir, so no
   * shred ran. The forwarder still emits the access-revoked row
   * (so operators see the event arrived) but suppresses the
   * shred row (there is no evidence to scrub, and emitting a
   * zero-count row for `unlinked` would be misleading: the
   * substrate never ran a shred, so we shouldn't claim it did).
   */
  it("suppresses the shred audit row on an unlinked outcome", async () => {
    bridgeMock!.bridgeRevokeKchatSource.mockReturnValue({
      outcome: "unlinked",
      chunksDropped: 0,
      filesDropped: 0,
      postsDropped: 0,
      dekDropped: false,
      vacuumSucceeded: true,
      vacuumError: undefined,
    });
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "channel_deleted",
        data: {},
        broadcast: {
          omit_users: {},
          channel_id: "chan-never-linked",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 101,
      }),
    );
    // INTENTIONAL ASYMMETRY: this test polls on
    // `bridgeLogKchatChannelAccessRevoked` rather than
    // `bridgeLogKchatSourceCryptoshredded` (the signal used by
    // every other channel-gone test in this file). The
    // `unlinked` outcome SUPPRESSES the shred audit row
    // (`handleChannelGoneEvent` skips `safeAuditSourceCryptoshredded`
    // when `outcome !== "revoked" && outcome !== "already_revoked"`),
    // so polling on the shred row would hang forever. The
    // access-revoked audit row IS the final emission for the
    // unlinked branch, so polling on it correctly signals
    // handler completion. Do NOT "fix this for consistency" —
    // the asymmetry is required by the production handler's
    // outcome-gated audit emission.
    await waitForCondition(
      () =>
        bridgeMock!.bridgeLogKchatChannelAccessRevoked.mock.calls.length > 0,
    );

    expect(
      bridgeMock!.bridgeLogKchatChannelAccessRevoked,
    ).toHaveBeenCalledWith("chan-never-linked", "channel_deleted");
    expect(
      bridgeMock!.bridgeLogKchatSourceCryptoshredded,
    ).not.toHaveBeenCalled();
    fwd.dispose();
  });

  /**
   * pin the filesystem secure-delete
   * helper's wiring through `handleChannelGoneEvent`. When the
   * substrate returns a `revoked` (or `already_revoked`) outcome,
   * the cache directory and its manifest sidecar must be
   * removed; an `unlinked` outcome must NOT touch the filesystem
   * (the helper is best-effort idempotent on missing paths, but
   * we still want to assert the contract).
   */
  it("removes the cache directory and manifest sidecar on a revoke", async () => {
    const channelId = "chan-fs-shred";
    // Inject `getCacheDir` (see tampered-manifest test above
    // for rationale) — pins the test write path to the
    // forwarder's resolved path through the same resolver.
    const getCacheDir = (id: string) => kchatChannelCacheDir(id);
    const cacheDir = getCacheDir(channelId);
    const manifestPath = manifestPathFor(cacheDir);
    await nodeFs.promises.mkdir(cacheDir, { recursive: true });
    await nodeFs.promises.writeFile(
      nodePath.join(cacheDir, "evidence.txt"),
      "secret",
    );
    await writeManifest(cacheDir, {
      version: 1,
      channelId,
      files: { "file-1": "evidence.txt" },
    });

    // Sanity: artifacts exist before the revoke.
    await expect(nodeFs.promises.access(cacheDir)).resolves.toBeUndefined();
    await expect(
      nodeFs.promises.access(manifestPath),
    ).resolves.toBeUndefined();

    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      getCacheDir,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "channel_archived",
        data: {},
        broadcast: {
          omit_users: {},
          channel_id: channelId,
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 102,
      }),
    );
    await waitForCondition(
      () =>
        bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls.length > 0,
    );

    // Cache directory and manifest sidecar are both gone.
    await expect(nodeFs.promises.access(cacheDir)).rejects.toThrow();
    await expect(nodeFs.promises.access(manifestPath)).rejects.toThrow();
    fwd.dispose();
  });

  /**
   * Block B Task 4 third-pass Devin Review fix
   * (filesystem-scrub observability): when `fs.rm` fails (e.g.
   * file locked by another process on Windows), the substrate
   * scrub still succeeded but the on-disk plaintext survives.
   * The audit row must carry `fs_scrub_succeeded=false` plus the
   * `fs_scrub_error` diagnostic so an operator grep finds the
   * channel that needs manual cleanup. Previously the helper
   * returned `void` and the audit row had no way to record this
   * — operators relying on the audit trail could miss retained
   * artifacts.
   */
  it("records fs_scrub_succeeded=false on audit row when filesystem scrub fails", async () => {
    const channelId = "chan-fs-failure";
    // Inject `getCacheDir` (see tampered-manifest test above
    // for rationale) — pins the test write path to the
    // forwarder's resolved path through the same resolver.
    const getCacheDir = (id: string) => kchatChannelCacheDir(id);
    const cacheDir = getCacheDir(channelId);
    await nodeFsPromises.mkdir(cacheDir, { recursive: true });
    await nodeFsPromises.writeFile(
      nodePath.join(cacheDir, "evidence.txt"),
      "secret",
    );

    // Make `fs.rm` on the cache dir fail by chmod-ing the parent
    // directory to read+execute (0o500) — Linux rejects unlink
    // on a child when the containing directory lacks write
    // permission (EACCES). This exercises the production failure
    // path (`fs.rm` rejects) without resorting to fragile module
    // mocks: the helper catches the rejection, sets
    // `cacheDirRemoved=false` + `error="cacheDir(...): ..."`, and
    // the forwarder emits the audit row with the failure flag.
    //
    // (Skipping the corresponding chmod-based path on Windows is
    // intentional: Windows permission semantics differ. The
    // production-path concern flagged by Devin Review's
    // observability finding is fs.rm fault tolerance on Windows
    // file-lock scenarios, but the helper's branching logic is
    // OS-agnostic, so this Linux-based test pins the contract.)
    const parentDir = nodePath.dirname(cacheDir);
    const originalParentMode = (await nodeFsPromises.stat(parentDir)).mode;
    if (process.platform === "win32") {
      // On Windows, chmod doesn't restrict rm; pin the audit
      // contract on Linux/macOS only. The audit-store unit test
      // (`kchat_source_cryptoshredded_helper_routes_to_correct_event_type`)
      // pins the row shape independently of the JS path.
      return;
    }
    await nodeFsPromises.chmod(parentDir, 0o500);

    try {
      const w1 = new FakeWindow();
      const fwd = new KchatEventForwarder({
        listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
        getBridge: () => bridgeMock,
        getCacheDir,
      });
      const client = new FakeClient();
      fwd.start(client as unknown as KchatClient);

      client.triggerWsEvent(
        makeRawEvent({
          event: "channel_deleted",
          data: {},
          broadcast: {
            omit_users: {},
            channel_id: channelId,
            team_id: "team-1",
            user_id: "principal",
          },
          seq: 201,
        }),
      );
      await waitForCondition(
        () =>
          bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls.length > 0,
      );

      const call =
        bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls[0];
      // Args: (channelId, reason, chunksDropped, filesDropped,
      //        postsDropped, dekDropped,
      //        fsScrubSucceeded, fsScrubError,
      //        vacuumSucceeded, vacuumError)
      expect(call[0]).toBe(channelId);
      expect(call[1]).toBe("channel_deleted");
      // post + DEK counts default to
      // zero/false on a file-only revoke (no chat-post evidence).
      expect(call[4]).toBe(0);
      expect(call[5]).toBe(false);
      // Filesystem scrub failure surfaces at positions [6]+[7].
      expect(call[6]).toBe(false);
      expect(call[7]).toContain("cacheDir");
      // The error message mentions an EACCES / permission-denied
      // shape (Linux maps an unwritable parent to EACCES on
      // unlink). We don't pin the exact code string because
      // libc differs across distros; we only pin the substring
      // "cacheDir" which is the helper-side prefix.
      // Fifth-pass Devin Review fix
      // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): the VACUUM
      // surface is independent of the filesystem scrub, so the
      // default-true fixture from the top-of-file mock flows
      // through unchanged.
      expect(call[8]).toBe(true);
      expect(call[9]).toBe(undefined);

      fwd.dispose();
    } finally {
      // Restore parent perms BEFORE the rm cleanup so the
      // suite-wide afterEach can drop the per-test tmpdir.
      await nodeFsPromises.chmod(parentDir, originalParentMode);
      await nodeFsPromises.rm(cacheDir, { recursive: true, force: true });
    }
  });

  /**
   * Block B Task 4 fifth-pass Devin Review fix
   * (ANALYSIS_pr-review-job-ef3c7d6c..._0001): when the substrate's
   * Phase 5 `VACUUM` fails AFTER the DELETE + UPDATE transaction
   * commits, the row-level scrub still ran under
   * `secure_delete = ON` so the cryptographic guarantee holds —
   * but the audit row must record `vacuum_succeeded=false` so an
   * operator grep finds revokes that need a manual `VACUUM`
   * re-run. Previously this code path propagated `?` up to the
   * forwarder's catch block and defaulted the audit row to
   * `outcome=unlinked`, hiding the successful scrub from the
   * trail. Pin the contract: the bridge's
   * `vacuum_succeeded=false` + `vacuum_error` fields thread
   * through to the audit row's call args at positions [6] and
   * [7], the access-revoked row STILL fires (we didn't crash), and
   * the cryptoshred row carries the substrate's row-level counts
   * (not defaulted to zero).
   */
  it("records vacuum_succeeded=false on audit row when substrate VACUUM fails", async () => {
    bridgeMock!.bridgeRevokeKchatSource.mockReturnValue({
      outcome: "revoked",
      chunksDropped: 9,
      filesDropped: 3,
      postsDropped: 0,
      dekDropped: false,
      vacuumSucceeded: false,
      vacuumError: "database or disk is full",
    });
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "channel_deleted",
        data: {},
        broadcast: {
          omit_users: {},
          channel_id: "chan-vacuum-failed",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 301,
      }),
    );
    await waitForCondition(
      () =>
        bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls.length > 0,
    );

    // The row-level scrub committed, so the access-revoked row
    // fires normally — proving the VACUUM failure does NOT cause
    // the forwarder to fall through to its catch block and emit
    // outcome=unlinked.
    expect(
      bridgeMock!.bridgeLogKchatChannelAccessRevoked,
    ).toHaveBeenCalledWith("chan-vacuum-failed", "channel_deleted");

    // The cryptoshred row carries the substrate's row-level
    // counts AND the VACUUM-failure observability fields.
    expect(
      bridgeMock!.bridgeLogKchatSourceCryptoshredded,
    ).toHaveBeenCalledWith(
      "chan-vacuum-failed",
      "channel_deleted",
      9,
      3,
      // file-only happy path → zero
      // posts + DEK never dropped.
      0,
      false,
      // Filesystem scrub still ran cleanly — it's independent
      // of VACUUM.
      true,
      undefined,
      // Fifth-pass fix surface:
      false,
      "database or disk is full",
    );
    fwd.dispose();
  });

  /**
   * dispatch coverage for the chat-
   * post WS events. Pins:
   *   - `posted` → bridge_ingest under withChannelSyncLock,
   *     followed by `bridgeLogKchatPostIngested` audit row.
   *   - `post_edited` → bridge_edit under withChannelSyncLock,
   *     followed by `bridgeLogKchatPostEdited` audit row.
   *   - `post_deleted` → bridge_delete under withChannelSyncLock,
   *     followed by `bridgeLogKchatPostDeleted` audit row.
   *   - Unlinked-channel fast path on each event → no bridge
   *     dispatch, audit row records `outcome=unlinked` with
   *     zero chunks.
   *   - Malformed payload (no `post` field) → `no_post` audit row
   *     without a bridge dispatch.
   */
  function makePostedRaw(
    eventName: "posted" | "post_edited" | "post_deleted",
    channelId: string,
    postEnvelope: object,
    seq: number,
  ): KchatWebSocketEvent {
    return makeRawEvent({
      event: eventName,
      data: { post: JSON.stringify(postEnvelope) },
      broadcast: {
        omit_users: {},
        channel_id: channelId,
        team_id: "team-1",
        user_id: "principal",
      },
      seq,
    });
  }

  it("dispatches posted into bridgeIngestKchatPost and audits the outcome", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    const fwd = new KchatEventForwarder({
      listWindows: () => [new FakeWindow()] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makePostedRaw(
        "posted",
        "chan-post-1",
        {
          id: "pid-1",
          channel_id: "chan-post-1",
          root_id: "",
          user_id: "user-7",
          message: "hello world",
          create_at: 1_700_000_000_000,
          edit_at: 0,
        },
        500,
      ),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeLogKchatPostIngested.mock.calls.length > 0,
    );
    expect(bridgeMock!.bridgeIngestKchatPost).toHaveBeenCalledTimes(1);
    const input = bridgeMock!.bridgeIngestKchatPost.mock.calls[0][0];
    expect(input.postId).toBe("pid-1");
    expect(input.channelId).toBe("chan-post-1");
    expect(input.body).toBe("hello world");
    expect(input.senderUserId).toBe("user-7");
    expect(input.createdAtMs).toBe(1_700_000_000_000);
    expect(bridgeMock!.bridgeLogKchatPostIngested).toHaveBeenCalledWith(
      "chan-post-1",
      "pid-1",
      "ingested",
      1,
    );
    fwd.dispose();
  });

  it("dispatches post_edited into bridgeEditKchatPost and audits the edit outcome", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    bridgeMock!.bridgeEditKchatPost.mockReturnValue({
      outcome: "edited",
      chunkCount: 2,
    });
    const fwd = new KchatEventForwarder({
      listWindows: () => [new FakeWindow()] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makePostedRaw(
        "post_edited",
        "chan-post-2",
        {
          id: "pid-2",
          channel_id: "chan-post-2",
          root_id: "",
          user_id: "user-7",
          message: "edited body",
          create_at: 1_700_000_000_000,
          edit_at: 1_700_000_100_000,
        },
        501,
      ),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeLogKchatPostEdited.mock.calls.length > 0,
    );
    expect(bridgeMock!.bridgeEditKchatPost).toHaveBeenCalledTimes(1);
    expect(bridgeMock!.bridgeIngestKchatPost).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeLogKchatPostEdited).toHaveBeenCalledWith(
      "chan-post-2",
      "pid-2",
      "edited",
      2,
    );
    fwd.dispose();
  });

  it("dispatches post_deleted into bridgeDeleteKchatPost and audits the delete outcome", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    bridgeMock!.bridgeDeleteKchatPost.mockReturnValue({
      outcome: "deleted",
      chunksDropped: 3,
    });
    const fwd = new KchatEventForwarder({
      listWindows: () => [new FakeWindow()] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makePostedRaw(
        "post_deleted",
        "chan-post-3",
        {
          id: "pid-3",
          channel_id: "chan-post-3",
          root_id: "",
          user_id: "user-7",
          message: "",
          create_at: 1_700_000_000_000,
          edit_at: 0,
        },
        502,
      ),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeLogKchatPostDeleted.mock.calls.length > 0,
    );
    expect(bridgeMock!.bridgeDeleteKchatPost).toHaveBeenCalledTimes(1);
    const args = bridgeMock!.bridgeDeleteKchatPost.mock.calls[0];
    expect(args[1]).toBe("pid-3");
    expect(bridgeMock!.bridgeLogKchatPostDeleted).toHaveBeenCalledWith(
      "chan-post-3",
      "pid-3",
      "deleted",
      3,
    );
    fwd.dispose();
  });

  it("short-circuits unlinked channels on posted without invoking the bridge", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(false);
    const fwd = new KchatEventForwarder({
      listWindows: () => [new FakeWindow()] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makePostedRaw(
        "posted",
        "chan-unlinked",
        {
          id: "pid-x",
          channel_id: "chan-unlinked",
          root_id: "",
          user_id: "user-7",
          message: "hi",
          create_at: 1,
          edit_at: 0,
        },
        503,
      ),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeLogKchatPostIngested.mock.calls.length > 0,
    );
    expect(bridgeMock!.bridgeIngestKchatPost).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeLogKchatPostIngested).toHaveBeenCalledWith(
      "chan-unlinked",
      "pid-x",
      "unlinked",
      0,
    );
    fwd.dispose();
  });

  it("audits no_post when posted carries a malformed payload", async () => {
    bridgeMock!.bridgeIsKchatChannelLinked.mockReturnValue(true);
    const fwd = new KchatEventForwarder({
      listWindows: () => [new FakeWindow()] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "posted",
        data: { post: "not-json" },
        broadcast: {
          omit_users: {},
          channel_id: "chan-malformed",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 504,
      }),
    );
    await waitForCondition(
      () => bridgeMock!.bridgeLogKchatPostIngested.mock.calls.length > 0,
    );
    expect(bridgeMock!.bridgeIngestKchatPost).not.toHaveBeenCalled();
    expect(bridgeMock!.bridgeLogKchatPostIngested).toHaveBeenCalledWith(
      "chan-malformed",
      "",
      "no_post",
      0,
    );
    fwd.dispose();
  });

  /**
   * `getCacheDir` injection contract tests.
   *
   * The forwarder accepts an optional `getCacheDir: (channelId)
   * => string` so tests can route the on-disk paths
   * (`bridgeIsKchatChannelLinked`, `bridgeRevokeKchatSource`,
   * `secureDeleteChannelArtifacts`, etc.) to any path they
   * want. Production uses the default which resolves to
   * `~/.tessera/kchat-channels/<channelId>/` via
   * `kchatChannelCacheDir` (the canonical path-helper shared
   * with the IPC handler).
   *
   * Same architectural pattern as PR #57
   * (`ExtensionSocketDiscovery`), PR #59 (`vaultCrypto` /
   * `sidecar` platform injection), PR #61 (`ssrfGuard`
   * `allowInternal` / `readEnv`), and PR #63 (`modelManagement`
   * `manifestPath` / `readEnv`). The seam exists primarily so
   * a future test that wants full filesystem isolation can
   * pass an isolated tmpdir without relying on the file-level
   * `os.homedir` mock at the top of this test file.
   */
  it("threads getCacheDir into bridgeRevokeKchatSource on channel_archived", async () => {
    const customCacheRoot = nodeFs.mkdtempSync(
      nodePath.join(nodeOs.tmpdir(), "tessera-fwd-cachedir-inject-"),
    );
    const seenChannelIds: string[] = [];
    const customGetCacheDir = (channelId: string): string => {
      seenChannelIds.push(channelId);
      // Return a per-channel subdir of an isolated tmpdir.
      // `fs.rm({ force: true, recursive: true })` on a
      // non-existent path resolves immediately so this is
      // cheaper than letting `secureDeleteChannelArtifacts`
      // touch the default `os.homedir()`-rooted path.
      return nodePath.join(customCacheRoot, "kchat-channels", channelId);
    };
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      getCacheDir: customGetCacheDir,
    });
    // try/finally guarantees the tmpdir is reclaimed even if
    // an assertion below throws, matching the
    // `records fs_scrub_succeeded=false on audit row when
    // filesystem scrub fails` test's permission-restore pattern.
    // Without this, a failing assertion would leak the
    // `tessera-fwd-cachedir-inject-*` tmpdir under `os.tmpdir()`
    // until the OS cleaned it up, which under high test churn
    // could accumulate on dev machines.
    try {
      const client = new FakeClient();
      fwd.start(client as unknown as KchatClient);

      client.triggerWsEvent(
        makeRawEvent({
          event: "channel_archived",
          data: {},
          broadcast: {
            omit_users: {},
            channel_id: "chan-injected",
            team_id: "team-1",
            user_id: "principal",
          },
          seq: 200,
        }),
      );
      await waitForCondition(
        () =>
          bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls.length >
          0,
      );

      expect(seenChannelIds).toContain("chan-injected");
      const [cacheDir] =
        bridgeMock!.bridgeRevokeKchatSource.mock.calls[0];
      expect(cacheDir).toBe(
        nodePath.join(customCacheRoot, "kchat-channels", "chan-injected"),
      );
    } finally {
      // Dispose BEFORE the tmpdir cleanup so the forwarder stops
      // accepting new WS events first. If a future maintainer
      // inserts more triggerWsEvent calls or assertions between
      // the waitForCondition and cleanup, this ordering prevents
      // a race where a freshly-dispatched handler would touch the
      // tmpdir mid-rm.
      fwd.dispose();
      // Cleanup so we don't leave the tmpdir around after the test.
      nodeFs.rmSync(customCacheRoot, { recursive: true, force: true });
    }
  });

  it("defaults getCacheDir to kchatChannelCacheDir (os.homedir-rooted)", async () => {
    // No `getCacheDir` injected — verifies the production
    // default resolves through the canonical helper. We assert
    // structural shape rather than the exact path because the
    // file-level `os.homedir` mock at the top of this test
    // file points homedir at `TEST_HOME`, so the path is
    // `TEST_HOME/.tessera/kchat-channels/<channelId>/`. Future
    // refactors that change the default would surface here.
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "channel_archived",
        data: {},
        broadcast: {
          omit_users: {},
          channel_id: "chan-default-cachedir",
          team_id: "team-1",
          user_id: "principal",
        },
        seq: 201,
      }),
    );
    await waitForCondition(
      () =>
        bridgeMock!.bridgeLogKchatSourceCryptoshredded.mock.calls.length >
        0,
    );

    const [cacheDir] =
      bridgeMock!.bridgeRevokeKchatSource.mock.calls[0];
    expect(cacheDir).toBe(
      nodePath.join(
        TEST_HOME,
        ".tessera",
        "kchat-channels",
        "chan-default-cachedir",
      ),
    );
    fwd.dispose();
  });

});

describe("KchatEventForwarder watched-channel notifications (Task 3)", () => {
  const WATCHED = "chan-watched";

  function postedEvent(
    overrides: { userId?: string; message?: string } = {},
  ): KchatWebSocketEvent {
    const userId = overrides.userId ?? "author-1";
    const message = overrides.message ?? "ship it today";
    return makeRawEvent({
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "post-1",
          channel_id: WATCHED,
          user_id: userId,
          message,
          create_at: 1700000000000,
          edit_at: 0,
        }),
      },
      broadcast: {
        omit_users: {},
        channel_id: WATCHED,
        team_id: "team-1",
        user_id: userId,
      },
      seq: 900,
    });
  }

  it("resolves the sender username for the notification title", async () => {
    const notifications: PostNotification[] = [];
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      notify: (n) => notifications.push(n),
      resolveChannelName: () => "general",
      autoCreateTasks: false,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.setWatchedChannels([WATCHED]);

    client.triggerWsEvent(postedEvent({ userId: "author-1" }));
    await waitForCondition(() => notifications.length > 0);

    expect(client.getUsersByIds).toHaveBeenCalledWith(["author-1"]);
    expect(notifications[0].title).toBe("author-1-name in general");
    expect(notifications[0].body).toBe("ship it today");
    fwd.dispose();
  });

  it("caches the username so a second post skips the lookup", async () => {
    const notifications: PostNotification[] = [];
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      notify: (n) => notifications.push(n),
      resolveChannelName: () => "general",
      autoCreateTasks: false,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.setWatchedChannels([WATCHED]);

    client.triggerWsEvent(postedEvent({ userId: "author-1" }));
    await waitForCondition(() => notifications.length > 0);
    client.triggerWsEvent(postedEvent({ userId: "author-1" }));
    await waitForCondition(() => notifications.length > 1);

    // Two notifications, but only one user-resolution round-trip.
    expect(client.getUsersByIds).toHaveBeenCalledTimes(1);
    expect(notifications.map((n) => n.title)).toEqual([
      "author-1-name in general",
      "author-1-name in general",
    ]);
    fwd.dispose();
  });

  it("still notifies (no username) when the lookup fails", async () => {
    const notifications: PostNotification[] = [];
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      notify: (n) => notifications.push(n),
      resolveChannelName: () => "general",
      autoCreateTasks: false,
    });
    const client = new FakeClient();
    client.getUsersByIds.mockRejectedValueOnce(new Error("network down"));
    fwd.start(client as unknown as KchatClient);
    fwd.setWatchedChannels([WATCHED]);

    client.triggerWsEvent(postedEvent({ userId: "author-1" }));
    await waitForCondition(() => notifications.length > 0);

    // Username unresolved -> title falls back to the generic
    // "New message" sender form, but the notification is NOT
    // suppressed (a missing name must never swallow the alert).
    expect(notifications[0].title).toBe("New message in general");
    fwd.dispose();
  });

  it("does not notify for posts in unwatched channels", async () => {
    const notifications: PostNotification[] = [];
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      notify: (n) => notifications.push(n),
      resolveChannelName: () => "general",
      autoCreateTasks: false,
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    // No setWatchedChannels -> nothing is watched.

    client.triggerWsEvent(postedEvent({ userId: "author-1" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(notifications).toHaveLength(0);
    expect(client.getUsersByIds).not.toHaveBeenCalled();
    fwd.dispose();
  });
});

describe("KchatEventForwarder inbound task auto-create (Task 6)", () => {
  const WATCHED = "chan-auto-create";

  function taskEvent(
    overrides: { userId?: string; message?: string } = {},
  ): KchatWebSocketEvent {
    const userId = overrides.userId ?? "author-2";
    const message = overrides.message ?? "TODO: fix the crash";
    return makeRawEvent({
      event: "posted",
      data: {
        post: JSON.stringify({
          id: "post-task-1",
          channel_id: WATCHED,
          user_id: userId,
          message,
          create_at: 1700000000000,
          edit_at: 0,
        }),
      },
      broadcast: {
        omit_users: {},
        channel_id: WATCHED,
        team_id: "team-1",
        user_id: userId,
      },
      seq: 950,
    });
  }

  function makeForwarder(): KchatEventForwarder {
    return new KchatEventForwarder({
      listWindows: () => [new FakeWindow()] as unknown as Electron.BrowserWindow[],
      getBridge: () => bridgeMock,
      notify: () => {},
      resolveChannelName: () => "general",
    });
  }

  it("does NOT auto-create tasks by default (opt-in)", async () => {
    // The forwarder defaults `autoCreateTasks` to false: watching a
    // channel for notifications must not silently write Tessera
    // tasks. An actionable message in a watched channel is detected
    // but no task is created until the user opts in.
    const fwd = makeForwarder();
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.setWatchedChannels([WATCHED]);
    expect(fwd.getAutoCreateTasks()).toBe(false);

    client.triggerWsEvent(taskEvent());
    await new Promise((r) => setTimeout(r, 30));

    expect(bridgeMock?.bridgeCreateTask).not.toHaveBeenCalled();
    fwd.dispose();
  });

  it("auto-creates a task once enabled via setAutoCreateTasks(true)", async () => {
    const fwd = makeForwarder();
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.setWatchedChannels([WATCHED]);
    fwd.setAutoCreateTasks(true);
    expect(fwd.getAutoCreateTasks()).toBe(true);

    client.triggerWsEvent(taskEvent({ message: "TODO: fix the crash" }));
    await waitForCondition(
      () => (bridgeMock?.bridgeCreateTask.mock.calls.length ?? 0) > 0,
    );

    expect(bridgeMock?.bridgeCreateTask).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(
      bridgeMock?.bridgeCreateTask.mock.calls[0][0] as string,
    );
    expect(payload.title).toContain("fix the crash");
    fwd.dispose();
  });

  it("does not auto-create from ordinary (non-task) chatter when enabled", async () => {
    const fwd = makeForwarder();
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.setWatchedChannels([WATCHED]);
    fwd.setAutoCreateTasks(true);

    client.triggerWsEvent(taskEvent({ message: "lunch at noon?" }));
    await new Promise((r) => setTimeout(r, 30));

    expect(bridgeMock?.bridgeCreateTask).not.toHaveBeenCalled();
    fwd.dispose();
  });

  it("auto-creates from the local user's own task message (self not suppressed)", async () => {
    // Asymmetry-by-design: notifications suppress the local user's
    // own posts (noise), but task auto-create does NOT — jotting your
    // own `TODO:` in a watched channel and having it captured is the
    // primary single-user use case. Loop safety comes from the
    // `— via Tessera` footer guard, not from authorship.
    const fwd = makeForwarder();
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);
    fwd.setWatchedChannels([WATCHED]);
    fwd.setAutoCreateTasks(true);

    // `self` is the local user id per FakeClient.getUser().
    client.triggerWsEvent(
      taskEvent({ userId: "self", message: "TODO: write the changelog" }),
    );
    await waitForCondition(
      () => (bridgeMock?.bridgeCreateTask.mock.calls.length ?? 0) > 0,
    );

    expect(bridgeMock?.bridgeCreateTask).toHaveBeenCalledTimes(1);
    fwd.dispose();
  });
});
