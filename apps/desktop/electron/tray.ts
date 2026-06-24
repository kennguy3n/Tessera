import { Tray, Menu, type MenuItemConstructorOptions } from "electron";
import { createTrayImage } from "./trayIcon";

/**
 * LW-9: minimize-to-tray with full suspension.
 *
 * When "Close to tray" is enabled, closing the window hides it instead
 * of quitting and the main process reclaims its resident cost:
 *   - all sidecars (text / vision / diffusion) are stopped — they
 *     restart on demand when the user next triggers a generation;
 *   - the automation scheduler is paused;
 *   - the database connection and the file watcher stay alive (both
 *     cheap, and the watcher must keep observing so the index is fresh
 *     when the user returns).
 * On restore the scheduler resumes; sidecars stay stopped until the
 * user actually asks for generation.
 *
 * The Electron-native bits (`Tray`, `Menu`) are kept behind thin
 * wrappers; the orchestration (`suspendForTray` / `resumeForTray`) and
 * the menu template builder are pure + dependency-injected so they are
 * unit-testable without a display server.
 */

// One tray per main process (module-singleton, matching the rest of the
// Electron layer). `null` until `createTray` runs / after `destroyTray`.
let tray: Tray | null = null;

/**
 * Pure builder for the tray context-menu template. Kept separate from
 * the native `Menu.buildFromTemplate` call so the menu's shape (labels,
 * ordering, the show/quit wiring) can be asserted in a unit test
 * without standing up a real `Tray`.
 */
export function buildTrayMenuTemplate(actions: {
  onShow: () => void;
  onQuit: () => void;
}): MenuItemConstructorOptions[] {
  return [
    { label: "Show Tessera", click: actions.onShow },
    { type: "separator" },
    { label: "Quit Tessera", click: actions.onQuit },
  ];
}

/**
 * Create the system tray icon (macOS menu bar / Windows system tray /
 * Linux appindicator) with a Show / Quit context menu. Clicking the
 * icon itself shows the window (the platform-conventional affordance).
 *
 * Idempotent: a second call returns the existing tray rather than
 * leaking a duplicate icon.
 */
export function createTray(actions: {
  onShow: () => void;
  onQuit: () => void;
}): Tray {
  if (tray) return tray;
  tray = new Tray(createTrayImage());
  tray.setToolTip("Tessera");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate(actions)));
  // Left-click (Windows/Linux) and a plain click (macOS) bring the
  // window back — the same affordance as the "Show Tessera" menu item.
  tray.on("click", () => actions.onShow());
  return tray;
}

/**
 * Tear down the tray icon. Called from the quit path so a relaunched
 * main process (and the test harness) does not stack duplicate icons.
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

/**
 * Whether a system tray icon is currently installed. `createTray` is
 * wrapped in a try/catch on the boot path because tray creation fails
 * on Linux sessions without a StatusNotifier host (some tiling WMs /
 * Wayland compositors with no appindicator). The window `close`
 * handler MUST consult this before hiding-to-tray: hiding with no tray
 * icon to click would lock the user out with no way back (LW-9 review,
 * PR #111).
 */
export function hasTray(): boolean {
  return tray !== null;
}

/** Test-only alias of {@link hasTray}; kept for existing call sites. */
export function _hasTrayForTests(): boolean {
  return hasTray();
}

export interface SuspendForTrayDeps {
  /** Flip the process-wide suspended flag (see `appSuspension.ts`). */
  setAppSuspended: (next: boolean) => void;
  /**
   * Read the live suspended flag. `suspendForTray` consults this after
   * its `await` points so a resume (tray click) that raced in mid-
   * suspend can short-circuit the remaining reclaim — see the guard
   * before `stopAllSidecars` below.
   */
  isAppSuspended: () => boolean;
  /** Pause the automation scheduler (drains any in-flight tick). */
  stopScheduler: () => Promise<void>;
  /** Stop every resident sidecar (text / vision / diffusion). */
  stopAllSidecars: () => Promise<void>;
  /** Tell the renderer to pause its polling intervals. */
  notifyRenderer: (channel: "app:suspend" | "app:resume") => void;
}

/**
 * Suspend the app into the tray. Ordering matters:
 *
 *   1. Set the suspended flag FIRST so a scheduler tick that is about
 *      to start self-gates immediately (it checks `isAppSuspended()`),
 *      and so any background connector-sync loop added later inherits
 *      the gate for free.
 *   2. Signal the renderer to pause its polling intervals.
 *   3. Pause the scheduler — this awaits the in-flight tick so no
 *      bridge call is left racing the sidecar teardown.
 *   4. Stop the sidecars last (the heaviest reclaim).
 *
 * Never throws: it runs off a window `close`/`hide` event where an
 * unhandled rejection would be silent, and a failed reclaim must not
 * wedge the hide. Each step is independently guarded so a throw in one
 * does not skip the rest.
 */
export async function suspendForTray(deps: SuspendForTrayDeps): Promise<void> {
  deps.setAppSuspended(true);
  try {
    deps.notifyRenderer("app:suspend");
  } catch (e) {
    console.warn("[tessera] tray suspend: renderer notify failed:", e);
  }
  try {
    await deps.stopScheduler();
  } catch (e) {
    console.warn("[tessera] tray suspend: scheduler pause failed:", e);
  }
  // Resume-during-suspend guard. `resumeForTray` clears the suspended
  // flag and restarts the scheduler synchronously, so if the user
  // clicked the tray icon while we were draining the in-flight tick
  // above, bail out before the heaviest (and only destructive) reclaim:
  // tearing down sidecars now could kill one the user just started by
  // triggering a generation right after restoring. The scheduler stop
  // above is already race-safe — `stopScheduler` clears its interval
  // synchronously before awaiting, so a resume's `startScheduler` that
  // landed during the drain survives untouched. Sidecars are the one
  // step whose effect outlives the await, hence the dedicated guard.
  if (!deps.isAppSuspended()) return;
  try {
    await deps.stopAllSidecars();
  } catch (e) {
    console.warn("[tessera] tray suspend: sidecar stop failed:", e);
  }
}

export interface ResumeForTrayDeps {
  setAppSuspended: (next: boolean) => void;
  /** Restart the automation scheduler. */
  startScheduler: () => void;
  notifyRenderer: (channel: "app:suspend" | "app:resume") => void;
}

/**
 * Resume the app from the tray. Clears the suspended flag, restarts the
 * scheduler, and tells the renderer to resume polling. Sidecars are
 * intentionally NOT restarted here — they stay stopped until the user
 * actually requests a generation (the LW-9 "sidecars stay stopped on
 * restore" contract), so a user who just wants to read their workspace
 * pays no model-RAM cost.
 */
export function resumeForTray(deps: ResumeForTrayDeps): void {
  deps.setAppSuspended(false);
  deps.startScheduler();
  try {
    deps.notifyRenderer("app:resume");
  } catch (e) {
    console.warn("[tessera] tray resume: renderer notify failed:", e);
  }
}
