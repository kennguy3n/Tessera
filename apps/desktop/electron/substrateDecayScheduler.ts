/**
 * Knowledge-substrate decay scheduler.
 *
 * Runs in the Electron main process. Every {@link DECAY_INTERVAL_MS}
 * (6 hours) it asks the native bridge to run a substrate decay sweep —
 * recomputing every memory's retention score and applying the
 * `Candidate -> Archived` / `Superseded -> Archived` transitions that
 * keep the memory plane bounded over time (see
 * `tessera_substrate::SubstrateManager::run_decay_sweep`).
 *
 * Like {@link module:scheduler} (the automations scheduler) it dispatches
 * **directly** against the bridge rather than routing through the
 * renderer IPC: decay must keep running on its cadence even when every
 * window is closed but the tray icon is still alive. The `substrate:
 * runDecaySweep` IPC channel exists for *manual* / on-demand sweeps
 * triggered from the UI; this timer is the unattended background driver.
 *
 * The sweep is cheap (a single load → score → save round trip over the
 * persisted memory blob) and side-effect-free outside the substrate's
 * own sibling DB files, so a failure here is always non-fatal: we log
 * and let the next tick retry.
 */
import { getBridge } from "./appState";
import { getLogger } from "./logger";

/** 6 hours, per the Session 1 task specification. */
export const DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000;

let tickHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Run exactly one decay sweep against the bridge. Never throws — a
 * missing bridge (early boot / headless test) or a bridge-side error is
 * logged and swallowed so a bad sweep can neither crash the main
 * process nor cancel the recurring timer.
 */
export function runSubstrateDecaySweepOnce(): void {
  const bridge = getBridge();
  if (!bridge || typeof bridge.bridgeRunDecaySweep !== "function") {
    // Bridge not initialised yet (or built without the substrate
    // surface). Nothing to sweep; the next tick will retry once the
    // bridge is up.
    return;
  }
  try {
    const report = bridge.bridgeRunDecaySweep();
    getLogger().info("substrate.decaySweep.ok", {
      scored: report.scored,
      candidatesArchived: report.candidatesArchived,
      supersededArchived: report.supersededArchived,
    });
  } catch (err) {
    getLogger().warn("substrate.decaySweep.failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the 6-hour decay timer. Idempotent: a second call while a timer
 * is already running is a no-op (mirrors `startScheduler`), so a
 * hot-reload / test relaunch can't stack intervals. The interval is
 * `unref`'d so it never by itself keeps the process alive.
 */
export function startSubstrateDecayScheduler(): void {
  if (tickHandle !== null) return;
  tickHandle = setInterval(runSubstrateDecaySweepOnce, DECAY_INTERVAL_MS);
  // Don't let the decay timer hold the event loop open on its own; the
  // app stays alive for real work (windows / tray), not for this timer.
  tickHandle.unref?.();
}

/**
 * Stop the decay timer. Idempotent and synchronous (the sweep itself is
 * synchronous, so there is no in-flight async work to await — unlike the
 * automations scheduler). Safe to call from the `will-quit` cleanup
 * chain even if the scheduler was never started.
 */
export function stopSubstrateDecayScheduler(): void {
  if (tickHandle !== null) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}
