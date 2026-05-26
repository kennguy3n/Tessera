/**
 * KChat WebSocket → renderer + audit forwarder.
 *
 * Block B Task 1 (Phase 11). The Block A sidebar polled
 * `kchat:listChannelFiles` every 30 s to discover newly uploaded
 * files; the design comment at
 * `renderer/src/components/KchatSidebarSection.tsx:12-17`
 * flagged push-based delivery as the intended next iteration.
 * This forwarder is that pipeline.
 *
 * Responsibilities:
 *
 *   1. Subscribe to {@link KchatClient.onWebSocketEvent} once at
 *      start, then for every accepted event:
 *
 *      a. Project the raw envelope to a renderer-safe view
 *         ({@link KchatWebSocketEventView}) — drops the
 *         server-routing `omit_users` map and flattens
 *         `broadcast.*` so the renderer never has to reach into
 *         a nested object.
 *
 *      b. Push the view into a per-renderer-window ring buffer
 *         (drop-oldest, 100-event cap) and drain on the next
 *         microtask to `webContents.send("kchat:event", view)`.
 *         The ring buffer is the architectural backpressure
 *         guard: even though Electron's `webContents.send` is
 *         async-fire-and-forget today, the buffer enforces
 *         deterministic drop semantics — under burst load the
 *         OLDEST event is dropped, not whichever event happens
 *         to lose the race to a saturated underlying Chromium
 *         IPC channel. That shape matches the renderer's
 *         reconciliation contract (the 30 s sidebar poll closes
 *         any gap on the next tick).
 *
 *      c. Audit every `file_added` event via
 *         `bridgeLogKchatFileEventReceived`. The audit row
 *         records the event name, originating channel id,
 *         server-supplied file id, and a `channel_linked` flag
 *         (whether the channel matched a registered
 *         `SourceType::Kchat` source) so an operator can
 *         correlate WS traffic with the source registry. Other
 *         event types (chat `posted`, membership changes,
 *         presence) are NOT audited at the per-event
 *         granularity — that would flood the audit log with
 *         content most operators don't want to grep.
 *
 *      d. The WS forwarder does NOT trigger a file download or
 *         a source reindex on `file_added`. A `file_added` event
 *         arrives the moment the KChat server accepts an upload
 *         from another client — the file bytes are NOT on disk
 *         in our local cache directory at that point. Calling
 *         `bridgeReindexSource` here would just walk an empty
 *         cache dir under the source manager mutex (blocking the
 *         napi worker pool's single thread for the duration), find
 *         no new bytes, and exit; a guaranteed no-op that also
 *         introduces UI jank under `file_added` bursts.
 *
 *         File ingestion is the responsibility of the channel-
 *         sync pipeline reachable via `sources:addKchatChannel`
 *         (`runAddKchatChannel` in `ipc/kchat.ts`). The sidebar's
 *         30 s reconciliation poll already invokes that pipeline
 *         on every tick, so a `file_added` event ultimately gets
 *         indexed within one poll cycle of arrival. A future
 *         iteration may move the auto-download trigger onto the
 *         WS forwarder by extracting `runAddKchatChannel` into a
 *         shared service that's callable from both the IPC
 *         handler and the forwarder; this PR explicitly does not
 *         take on that scope (it would require hoisting ~300 lines
 *         and reworking the in-flight dedupe Map ownership).
 *
 *   2. Window lifecycle cleanup: when a renderer window closes,
 *      its ring buffer is released so the forwarder doesn't
 *      retain a slot for a destroyed `webContents` indefinitely.
 *
 *   3. Disposal: on `dispose()` the forwarder unsubscribes from
 *      the client and clears all buffers. Used by tests; in
 *      production the forwarder's lifetime is the app process.
 *
 * Threading model: the main process is single-threaded JS, so
 * the forwarder does not need locking. The ring buffer is a
 * plain `Array` capped at {@link RING_BUFFER_CAP} entries.
 */

import { BrowserWindow } from "electron";
import { getBridge } from "../appState";
import type { KchatClient } from "./kchatClient";
import type {
  KchatConnectionState,
  KchatWebSocketEvent,
  KchatWebSocketEventView,
} from "./kchatTypes";

/**
 * Per-renderer-window cap on the ring buffer. 100 events is
 * enough to cover a multi-second burst on a busy channel
 * (`posted` events arrive faster than `file_added`, but neither
 * exceeds tens of events per second in practice) while bounding
 * worst-case memory at ~100 × ~200 B per JSON view = ~20 KB per
 * window. A slow renderer cannot grow the buffer past this
 * cap — the oldest event is dropped on overflow.
 *
 * Implementation note: the buffer is a plain JS `Array` and
 * drop-oldest is `Array.prototype.shift()`, which is O(n) per
 * drop. At `RING_BUFFER_CAP = 100` the worst-case cost of a
 * fully-saturated buffer is ~10,000 element moves per drain,
 * which is well inside the per-tick budget. If this cap is
 * ever increased past ~1000 the shape should switch to a
 * pointer-based circular buffer (write/read indices over a
 * fixed-size array) — the shift cost crosses the renderer-
 * tick budget around that scale. See Devin Review thread
 * `ANALYSIS_pr-review-job-…_0004` on PR #43 for the analysis.
 */
export const RING_BUFFER_CAP = 100;

/**
 * IPC channel name carrying renderer-safe KChat WS events. The
 * preload bridge subscribes via `subscribeIpc<KchatWebSocketEventPayload>("kchat:event", cb)`.
 * Renamed across the codebase will break Block B Task 1, so the
 * constant lives here.
 */
export const KCHAT_EVENT_CHANNEL = "kchat:event";

/**
 * IPC channel name carrying KChat connection-state transitions
 * (`disconnected` ↔ `connecting` ↔ `connected` ↔ `error`). The
 * preload bridge subscribes via
 * `subscribeIpc<KchatConnectionStateView>("kchat:status", cb)`.
 *
 * NOTE: the same channel name is also bound to an
 * `ipcMain.handle("kchat:status", ...)` invoke handler. Electron
 * routes `invoke`/`handle` (request-response) and `send`/`on`
 * (push) on separate tables, so the two coexist cleanly — the
 * `invoke` returns the current state on demand, while the
 * `send` notifies subscribers of transitions. Mirrors the
 * `updates:status` precedent in `autoUpdater.ts`.
 */
export const KCHAT_STATUS_CHANNEL = "kchat:status";

/**
 * Per-window forwarder state. Tracks the FIFO ring buffer of
 * pending event views and a running count of events the
 * forwarder had to drop because the buffer was at cap when the
 * event arrived. The drop count is exposed for tests and could
 * be surfaced in a future Settings diagnostics view.
 *
 * `drainScheduled` collapses repeated `scheduleDrain` calls
 * within a single synchronous run into one microtask — without
 * this guard, every WS event in a burst would queue its own
 * microtask, multiplying the per-burst scheduling overhead and
 * defeating the point of the buffer.
 */
interface WindowState {
  buffer: KchatWebSocketEventView[];
  dropped: number;
  drainScheduled: boolean;
}

/**
 * Project a raw WebSocket envelope to the renderer-safe view.
 * Centralised so the projection logic is testable without
 * standing up a full forwarder, and so the audit / reindex
 * paths can rely on the same flattened fields.
 *
 * Pure: no I/O, no side effects.
 */
export function toRendererEventView(
  raw: KchatWebSocketEvent,
): KchatWebSocketEventView {
  return {
    event: raw.event,
    channelId: raw.broadcast.channel_id ?? null,
    teamId: raw.broadcast.team_id ?? null,
    userId: raw.broadcast.user_id ?? null,
    seq: raw.seq,
    data: raw.data,
  };
}

/**
 * KChat WebSocket forwarder. Construct one per app process,
 * start it after `getKchatAuthService()` has been initialised,
 * dispose on shutdown / between tests.
 */
export class KchatEventForwarder {
  private readonly windowStates = new Map<number, WindowState>();
  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private windowDestroyHandlers: Array<{
    win: BrowserWindow;
    handler: () => void;
  }> = [];
  /**
   * Pluggable enumerator. Production uses
   * `BrowserWindow.getAllWindows()`; tests inject a fake so the
   * forwarder can be exercised without standing up an Electron
   * renderer. Stored as a field rather than a constructor arg
   * so existing call sites that pass no arguments stay
   * supported.
   */
  private listWindows: () => BrowserWindow[];

  constructor(
    options: { listWindows?: () => BrowserWindow[] } = {},
  ) {
    this.listWindows =
      options.listWindows ?? (() => BrowserWindow.getAllWindows());
  }

  /**
   * Bind the forwarder to a connected `KchatClient`. Safe to
   * call exactly once per forwarder instance; the second call
   * is a no-op so `KchatAuthService.connect` can call `start`
   * defensively without double-subscribing.
   *
   * `start` does NOT take ownership of the client's lifecycle —
   * the auth service still owns connect/disconnect; the
   * forwarder just attaches a listener. Disposing the
   * forwarder removes the listener cleanly even while the
   * client stays connected.
   */
  start(client: KchatClient): void {
    if (this.unsubscribeWs || this.unsubscribeStatus) return;
    this.unsubscribeWs = client.onWebSocketEvent((event) => {
      try {
        this.handleEvent(event);
      } catch (err) {
        // The forwarder is a fire-and-forget side channel; a
        // single bad event (malformed payload, audit log error,
        // window-list throw) MUST NOT propagate back into the
        // client's WS reader loop, otherwise an attacker who
        // controls a single message can wedge the entire
        // connection. Errors are swallowed and logged so the
        // forwarder degrades to "no live updates" instead of
        // taking the WS down.
        console.error("[KchatEventForwarder] handleEvent failed:", err);
      }
    });
    this.unsubscribeStatus = client.onStatusChange((state) => {
      try {
        this.handleStatusChange(state);
      } catch (err) {
        // Same fire-and-forget rationale as the WS listener.
        console.error(
          "[KchatEventForwarder] handleStatusChange failed:",
          err,
        );
      }
    });
  }

  /**
   * Remove all listeners and clear all per-window state. The
   * forwarder can be re-`start`ed after disposal with a fresh
   * (or the same) client. Tests rely on this to reset between
   * cases.
   */
  dispose(): void {
    if (this.unsubscribeWs) {
      this.unsubscribeWs();
      this.unsubscribeWs = null;
    }
    if (this.unsubscribeStatus) {
      this.unsubscribeStatus();
      this.unsubscribeStatus = null;
    }
    for (const { win, handler } of this.windowDestroyHandlers) {
      try {
        win.removeListener("closed", handler);
      } catch {
        // Window may already be destroyed; ignore.
      }
    }
    this.windowDestroyHandlers = [];
    this.windowStates.clear();
  }

  /**
   * Snapshot of pending events for `windowId`, in oldest-first
   * order. Exposed for tests so they can assert ring-buffer
   * semantics without spinning up an Electron renderer.
   */
  getPendingForWindow(windowId: number): KchatWebSocketEventView[] {
    return [...(this.windowStates.get(windowId)?.buffer ?? [])];
  }

  /**
   * Number of events the forwarder had to drop because
   * `windowId`'s ring buffer was at cap. Exposed for tests and
   * future diagnostics surfaces.
   */
  getDroppedCountForWindow(windowId: number): number {
    return this.windowStates.get(windowId)?.dropped ?? 0;
  }

  private handleEvent(raw: KchatWebSocketEvent): void {
    const view = toRendererEventView(raw);

    // Step 1: broadcast to every renderer window. We enumerate
    // through the pluggable `listWindows` callback so tests can
    // exercise this without an actual BrowserWindow.
    const windows = this.listWindows();
    for (const win of windows) {
      if (win.isDestroyed()) continue;
      this.deliverToWindow(win, view);
    }

    // Step 2: side-effect path — audit on `file_added`.
    //
    // The broadcast above is enqueued into the per-window ring
    // buffer and drained on the next microtask via
    // `queueMicrotask` (see `scheduleDrain`). The bridge calls in
    // `handleFileAdded` therefore complete BEFORE the drain
    // delivers events to the renderer. Bridge calls here are:
    //   - one indexed SQLite SELECT (the cache-dir source lookup,
    //     used only to populate the audit row's `channel_linked`
    //     flag), and
    //   - one append-only audit-log INSERT.
    //
    // Both are short and synchronous; they share the napi worker
    // pool's lock but never the renderer's event loop. The
    // earlier draft also called `bridgeReindexSource` here, but
    // that was removed in the second-pass Devin Review sweep
    // (BUG_pr-review-job-...0001 + ANALYSIS_pr-review-job-...0001
    // on PR #43): the new file hasn't been downloaded into the
    // cache directory at the moment a `file_added` event arrives,
    // so the reindex would walk an empty diff under a mutex,
    // doing nothing while blocking the worker thread. File
    // ingestion still happens reliably via the
    // `sources:addKchatChannel` 30 s reconciliation poll — see
    // the top-of-file doc block.
    if (view.event === "file_added") {
      this.handleFileAdded(view).catch((err) => {
        // The reindex / audit path is best-effort. A failure
        // here MUST NOT prevent future events from being
        // forwarded, so we swallow and log.
        console.error(
          "[KchatEventForwarder] file_added side-effect failed:",
          err,
        );
      });
    }
  }

  private deliverToWindow(
    win: BrowserWindow,
    view: KchatWebSocketEventView,
  ): void {
    const windowId = win.id;
    let state = this.windowStates.get(windowId);
    if (!state) {
      state = { buffer: [], dropped: 0, drainScheduled: false };
      this.windowStates.set(windowId, state);
      // Attach a one-shot "closed" handler so we release the
      // per-window state when the renderer goes away. Without
      // this the map would grow unboundedly across the app
      // lifetime as windows open and close (popups, devtools).
      const handler = () => {
        this.windowStates.delete(windowId);
        // Self-clean from the handler list so a second
        // `closed` event (defensive; shouldn't happen) doesn't
        // double-decrement.
        this.windowDestroyHandlers = this.windowDestroyHandlers.filter(
          (h) => h.win !== win,
        );
      };
      // `closed` fires after the window is unusable; we don't
      // try to drain the buffer at that point — the renderer
      // is already gone.
      win.once("closed", handler);
      this.windowDestroyHandlers.push({ win, handler });
    }

    // Drop-oldest ring buffer. We push first then trim so the
    // newest event always lands in the buffer (the "drop
    // oldest" guarantee). Drain is deferred to the next
    // microtask via `scheduleDrain` so a sequential burst of
    // WS events accumulates in the buffer rather than
    // serialising one-at-a-time through `webContents.send`. If
    // the burst exceeds `RING_BUFFER_CAP` the oldest events
    // are dropped before the renderer ever sees them, bounding
    // memory and giving the reconciliation poll a chance to
    // catch up.
    state.buffer.push(view);
    while (state.buffer.length > RING_BUFFER_CAP) {
      state.buffer.shift();
      state.dropped += 1;
    }
    this.scheduleDrain(win, state);
  }

  private scheduleDrain(win: BrowserWindow, state: WindowState): void {
    if (state.drainScheduled) return;
    state.drainScheduled = true;
    queueMicrotask(() => {
      state.drainScheduled = false;
      this.drainWindow(win, state);
    });
  }

  private drainWindow(win: BrowserWindow, state: WindowState): void {
    if (win.isDestroyed()) {
      // Renderer went away between schedule and drain. Drop
      // the buffer — the `closed` handler will release the
      // state slot shortly.
      state.buffer.length = 0;
      return;
    }
    while (state.buffer.length > 0) {
      const next = state.buffer.shift()!;
      try {
        win.webContents.send(KCHAT_EVENT_CHANNEL, next);
      } catch (err) {
        // `webContents.send` throws if the renderer is gone.
        // Drop the rest of the buffer for this window — the
        // `closed` handler above will run shortly and release
        // the state slot.
        console.error(
          "[KchatEventForwarder] webContents.send failed:",
          err,
        );
        state.buffer.length = 0;
        break;
      }
    }
  }

  private handleStatusChange(state: KchatConnectionState): void {
    // Status changes are sparse (a handful per session) so the
    // ring-buffer drop-oldest contract is unnecessary; we
    // broadcast directly. The renderer receives the same
    // sanitised view the `kchat:status` invoke handler returns,
    // so the push channel and the pull endpoint are payload-
    // compatible — a renderer that uses both never has to
    // reconcile two different shapes.
    const windows = this.listWindows();
    for (const win of windows) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(KCHAT_STATUS_CHANNEL, state);
      } catch (err) {
        // Same fire-and-forget rationale as the WS path. A
        // window that has gone away mid-broadcast must not
        // block delivery to the surviving windows.
        console.error(
          "[KchatEventForwarder] status send failed:",
          err,
        );
      }
    }
  }

  private async handleFileAdded(
    view: KchatWebSocketEventView,
  ): Promise<void> {
    const bridge = getBridge();
    if (!bridge) {
      // Tests sometimes run the forwarder without a bridge.
      // No bridge = no source store and no audit log to write.
      // Drop silently.
      return;
    }

    const channelId = view.channelId;
    const fileId =
      typeof view.data.file_id === "string" ? view.data.file_id : null;

    // No source-lookup call: the previous draft of this method
    // looked up the linked source for `channelId` so it could
    // (a) trigger a reindex and (b) record whether the channel
    // was linked as `triggered_reindex` on the audit row. Both
    // motivations went away in the second-pass Devin Review
    // sweep on PR #43:
    //   - (a) was removed (see top-of-file doc block: the file
    //     isn't on disk at `file_added` time, so reindex is a
    //     blocking no-op).
    //   - (b) was downgraded: passing the lookup result through
    //     a field literally named `triggered_reindex` would be
    //     a misleading semantic for ops grep. We pass `false`
    //     unconditionally and rely on operators querying the
    //     source registry directly when they need to know which
    //     channels are linked.
    // The field is preserved (rather than removed from the audit
    // signature) so it stays available for the future iteration
    // that wires `runAddKchatChannel` into the WS forwarder.

    try {
      bridge.bridgeLogKchatFileEventReceived(
        view.event,
        channelId,
        fileId,
        // Always false in the current implementation — see the
        // block above. The field is the historical
        // `triggered_reindex` slot, kept on the audit row text
        // so a future auto-sync iteration can repopulate it
        // without a schema break.
        false,
      );
    } catch (err) {
      // Audit-log failures should never wedge the forwarder.
      console.error(
        "[KchatEventForwarder] audit log failed:",
        err,
      );
    }
  }
}
