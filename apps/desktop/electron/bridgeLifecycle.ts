import { BrowserWindow } from "electron";
import type { BridgeStateView } from "../shared/types";

/**
 * LW-8 (cold-start budget): boot-time bridge readiness signal.
 *
 * Background: the cold-start critical path used to be
 *
 *   app ready → … → await initAppState() → createWindow()
 *
 * so the main window — and therefore the first paint the cold-start
 * gate measures — could not appear until the SQLCipher open +
 * tombstone replay + FTS purge sweep inside `initAppState()` had
 * finished. That heavy, I/O-bound work dominated boot-to-first-render.
 *
 * The boot sequence is now inverted (see `main.ts` → `whenReady`):
 *
 *   app ready → … → createWindow() → void initBridgeAndServices()
 *
 * The renderer paints a lightweight "Loading workspace…" skeleton
 * immediately (it has no bridge dependency), then hydrates the real
 * app shell only once the bridge is up. This module is the seam that
 * carries the "bridge is up / failed" transition from the main process
 * to every renderer:
 *
 *   - the main process calls {@link setBridgeState} when
 *     `initBridgeAndServices()` resolves (`"ready"`) or the bridge init
 *     throws (`"error"`);
 *   - each transition is broadcast on {@link BRIDGE_STATE_CHANNEL} to
 *     every live `webContents`;
 *   - a renderer that mounts AFTER the transition already fired (the
 *     event would otherwise be missed) reads the current snapshot via
 *     the {@link BRIDGE_STATE_GET_CHANNEL} invoke handler.
 *
 * The state is intentionally a tiny module-level singleton rather than
 * threaded through `appState`: it must be readable before `appState`
 * is initialised (that is the whole point — the renderer asks "are you
 * ready yet?" precisely while `initAppState()` is still running).
 */

/** Event channel: main → renderer, fired on every state transition. */
export const BRIDGE_STATE_CHANNEL = "app:bridgeState";

/**
 * Invoke channel: renderer → main, returns the current
 * {@link BridgeStateView}. Used by a renderer that subscribes after a
 * transition already fired, so it never waits forever on an event that
 * has already been delivered to no one.
 */
export const BRIDGE_STATE_GET_CHANNEL = "app:bridgeState:get";

let current: BridgeStateView = { state: "initializing", error: null };

/** Return a defensive copy of the current bridge state. */
export function getBridgeStateSnapshot(): BridgeStateView {
  return { state: current.state, error: current.error };
}

/**
 * Send `payload` to every live renderer on `channel`. Skips destroyed
 * windows so a window torn down mid-broadcast cannot throw.
 */
function broadcastToAllWindows(
  channel: string,
  payload: BridgeStateView,
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * Transition the bridge state and broadcast it to every renderer.
 *
 * @param next       the new lifecycle state.
 * @param options.error
 *   human-readable failure reason; recorded only when `next === "error"`
 *   (any error string is cleared on a non-error transition so a stale
 *   message can never linger on the `"ready"`/`"initializing"` states).
 * @param options.broadcast
 *   injectable sender (defaults to broadcasting to every
 *   `BrowserWindow`). Tests pass a spy so the transition logic can be
 *   asserted without a live Electron window. A throwing broadcaster is
 *   swallowed — a renderer that cannot receive the event still learns
 *   the state via the `getBridgeState` invoke on its next mount, so a
 *   send failure must never wedge boot.
 * @returns the new snapshot.
 */
export function setBridgeState(
  next: BridgeStateView["state"],
  options?: {
    error?: string | null;
    broadcast?: (channel: string, payload: BridgeStateView) => void;
  },
): BridgeStateView {
  current = {
    state: next,
    error: next === "error" ? (options?.error ?? "Unknown error") : null,
  };
  const snapshot = getBridgeStateSnapshot();
  const broadcast = options?.broadcast ?? broadcastToAllWindows;
  try {
    broadcast(BRIDGE_STATE_CHANNEL, snapshot);
  } catch (err) {
    // Best-effort: a failed broadcast must not throw out of the boot
    // sequence. The renderer falls back to the invoke handler.
    console.warn(
      "[Tessera] bridge-state broadcast failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
  return snapshot;
}

/**
 * Test-only: reset the module singleton back to `initializing` so each
 * spec starts from a known state. Mirrors the `_reset*ForTests` hooks
 * elsewhere in the Electron layer.
 */
export function _resetBridgeStateForTests(): void {
  current = { state: "initializing", error: null };
}
