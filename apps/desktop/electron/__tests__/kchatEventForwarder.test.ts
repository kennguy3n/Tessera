/**
 * Tests for the `KchatEventForwarder` push pipeline introduced in
 * Phase 11 Block B Task 1.
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

// We mock `electron` so importing the forwarder works under
// vitest, then mock `../appState` so `getBridge()` is observable.
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
}

let bridgeMock: BridgeMockShape | null = null;
vi.mock("../appState", () => ({
  getBridge: () => bridgeMock,
}));

import {
  KchatEventForwarder,
  RING_BUFFER_CAP,
  toRendererEventView,
  KCHAT_EVENT_CHANNEL,
  KCHAT_STATUS_CHANNEL,
} from "../kchat/kchatEventForwarder";
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

  // Regression pin for the second- and third-pass Devin Review on
  // PR #43 (`BUG_pr-review-job-...0001` + `ANALYSIS_pr-review-job-
  // ...0001`): the forwarder must audit the `file_added` event with
  // `triggered_reindex=false` (the always-false sentinel) and must
  // not consult the source registry. The first-pass implementation
  // did a source lookup + reindex spawn; both were removed because
  // the file isn't on disk yet at `file_added` time. The bridge no
  // longer exposes the lookup helper at all (it was dead code after
  // the lookup call site was removed) so the mock shape doesn't
  // include it — a regression that re-added the lookup would fail
  // to type-check against the trimmed `NativeBridge`.
  it("audits file_added with triggered_reindex=false and no source-registry interaction", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
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
    // The side-effect path is `async` (returns a Promise that
    // resolves to undefined; the body itself is synchronous).
    // Yield once for the resolution and once for the chained
    // `.catch(...)` so the assertions observe the post-call
    // bridge state.
    await Promise.resolve();
    await Promise.resolve();
    expect(
      bridgeMock!.bridgeLogKchatFileEventReceived,
    ).toHaveBeenCalledWith("file_added", "chan-A", "file-XYZ", false);
    fwd.dispose();
  });

  // A `file_added` event for a channel that may or may not be
  // linked as a source: the audit row still fires (the forwarder
  // doesn't consult the source registry at this layer).
  it("audits file_added even when no channel-id is present in broadcast", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
    });
    const client = new FakeClient();
    fwd.start(client as unknown as KchatClient);

    client.triggerWsEvent(
      makeRawEvent({
        event: "file_added",
        data: { file_id: "file-ABC" },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      bridgeMock!.bridgeLogKchatFileEventReceived,
    ).toHaveBeenCalledWith("file_added", "chan-A", "file-ABC", false);
    fwd.dispose();
  });

  it("does not audit non-file_added events", async () => {
    const w1 = new FakeWindow();
    const fwd = new KchatEventForwarder({
      listWindows: () => [w1] as unknown as Electron.BrowserWindow[],
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
});
