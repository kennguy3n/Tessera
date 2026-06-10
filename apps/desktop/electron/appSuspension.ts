/**
 * LW-9 (minimize-to-tray): process-wide "the app is suspended in the
 * tray" flag.
 *
 * When the window is hidden to the tray the main process tears down its
 * resident cost — sidecars are stopped and the automation scheduler is
 * paused (see `tray.ts` → `suspendForTray`). This module holds the
 * single source of truth for that suspended state so the background
 * dispatchers that survive a hide (the scheduler tick, any future
 * connector-sync loop) can cheaply self-gate instead of each carrying
 * their own ad-hoc flag.
 *
 * It is deliberately a tiny module-singleton (matching `config.ts` /
 * `appState.ts` / `scheduler.ts`) rather than a class: there is exactly
 * one suspension state per Electron main process.
 */
let suspended = false;

/** True while the window is hidden to the tray (resources reclaimed). */
export function isAppSuspended(): boolean {
  return suspended;
}

/**
 * Set the suspended flag. Called by `suspendForTray` / `resumeFromTray`
 * in `tray.ts`. Idempotent — passing the current value is a no-op.
 */
export function setAppSuspended(next: boolean): void {
  suspended = next;
}

/**
 * Test-only: reset the flag so each case starts from the
 * not-suspended baseline. Mirrors the `_reset*ForTests` hooks in
 * `main.ts` / `scheduler.ts`.
 */
export function _resetAppSuspensionForTests(): void {
  suspended = false;
}
