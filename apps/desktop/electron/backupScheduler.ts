/**
 * Automated local backup scheduler.
 *
 * Runs in the Electron main process. When {@link AppConfig.autoBackup}
 * is enabled it performs a hot backup of the encrypted SQLCipher
 * database on the configured cadence
 * ({@link AppConfig.backupIntervalHours}) and prunes the backup
 * directory to {@link AppConfig.backupRetentionCount}, so a user who
 * never opens Settings still gets disk-failure protection out of the
 * box — the whole point of a zero-config backup system.
 *
 * Design notes:
 *
 *   - **Catch-up on launch.** A laptop that is asleep past a scheduled
 *     tick would otherwise never back up. On start the scheduler reads
 *     the newest existing backup's age; if it already exceeds the
 *     interval (or there is no backup at all) it runs one shortly
 *     after launch (after {@link INITIAL_CATCHUP_DELAY_MS} so the
 *     backup copy doesn't contend with first-paint indexing), then
 *     settles into the steady interval cadence.
 *
 *   - **Single-flight.** Backups never overlap. A tick that fires
 *     while a backup (manual or scheduled) is still running coalesces
 *     onto the in-flight promise instead of starting a second copy
 *     against the same shared connection.
 *
 *   - **Direct bridge dispatch.** Like the automations scheduler, the
 *     backup runs directly against the Rust bridge, not through the
 *     renderer IPC — Tessera is a long-running tray app and the user
 *     may have every window closed when a backup is due.
 *
 *   - **Best-effort pruning.** A prune failure never fails the backup:
 *     the fresh copy is already safely on disk, and a stale extra file
 *     is a far better outcome than surfacing the backup as failed.
 */
import { app } from "electron";
import * as path from "path";
import { getBridge, type BackupInfo, type NativeBridge } from "./appState";
import { loadConfig, type AppConfig } from "./config";
import { getLogger } from "./logger";

/**
 * Delay before the first catch-up backup after launch. Gives the app
 * time to finish first paint and any startup indexing before the
 * backup briefly locks the shared connection, so the catch-up never
 * janks the user's first interaction.
 */
export const INITIAL_CATCHUP_DELAY_MS = 60_000;

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Injectable timer + clock seams so the Vitest suite can drive the
 * scheduler deterministically without real wall-clock waits. Production
 * uses the Node globals.
 */
export interface BackupSchedulerDeps {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
  now: () => number;
  getBridge: () => NativeBridge | null;
}

const defaultDeps: BackupSchedulerDeps = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  now: () => Date.now(),
  getBridge: () => getBridge(),
};

let deps: BackupSchedulerDeps = defaultDeps;

// Module-level state — exactly one scheduler per main process, matching
// the automations `scheduler.ts` convention (module state rather than a
// singleton class consumers must thread around).
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let initialHandle: ReturnType<typeof setTimeout> | null = null;
let activeBackup: Promise<BackupInfo> | null = null;
let lastBackupAt: number | null = null;
let lastBackupError: string | null = null;

/**
 * Resolve the directory backups are written to. An empty
 * `config.backupDir` is the sentinel for "use the built-in default"
 * (`<userData>/backups`); the renderer cannot compute `userData`
 * itself, so the resolution lives here on the main side.
 */
export function resolveBackupDir(config: AppConfig = loadConfig()): string {
  const configured = config.backupDir.trim();
  if (configured.length > 0) return configured;
  return path.join(app.getPath("userData"), "backups");
}

/**
 * Run a single backup + prune against the bridge, serialised so two
 * backups never run concurrently against the shared connection. The
 * returned promise resolves with the new backup's metadata; callers
 * that only care about side effects can ignore it.
 *
 * A backup failure rejects (and is recorded in
 * {@link getBackupSchedulerStatus}); a prune failure is swallowed
 * because the fresh copy is already safely on disk.
 */
export function runBackupNow(): Promise<BackupInfo> {
  if (activeBackup) return activeBackup;
  const run = (async (): Promise<BackupInfo> => {
    const bridge = deps.getBridge();
    if (!bridge) {
      throw new Error("Backup unavailable: native bridge not initialized.");
    }
    const config = loadConfig();
    const dir = resolveBackupDir(config);
    // The N-API call is synchronous (the SQLite Online Backup API
    // copies under the connection lock); we await a resolved promise
    // only so the single-flight guard and the timer callback don't
    // have to special-case the throw path.
    const info = bridge.bridgeCreateBackup(dir);
    try {
      const removed = bridge.bridgePruneBackups(
        dir,
        config.backupRetentionCount,
      );
      if (removed.length > 0) {
        getLogger().info(
          `[Tessera] Backup pruned ${removed.length} old file(s) beyond retention ${config.backupRetentionCount}.`,
        );
      }
    } catch (pruneErr) {
      // Best-effort: a stale extra backup is preferable to reporting
      // the (successful) backup as failed.
      getLogger().warn(
        `[Tessera] Backup prune failed (backup itself succeeded): ${String(pruneErr)}`,
      );
    }
    return info;
  })();
  // Publish the *chained* promise (not the raw `run`) as the in-flight
  // handle. Consumers of `activeBackup` — the single-flight guard above
  // and `stopBackupScheduler`'s drain — must observe completion only
  // after the `.then`/`.catch` side effects (`lastBackupAt`,
  // `lastBackupError`) have run and the guard has been cleared.
  // Publishing `run` instead would let them resolve a microtask early,
  // before `lastBackupError` is recorded and `activeBackup` is nulled.
  const chained = run
    .then((info) => {
      lastBackupAt = deps.now();
      lastBackupError = null;
      return info;
    })
    .catch((err: unknown) => {
      lastBackupError = err instanceof Error ? err.message : String(err);
      getLogger().error(
        `[Tessera] Automatic backup failed: ${lastBackupError}`,
      );
      throw err;
    })
    .finally(() => {
      activeBackup = null;
    }) as Promise<BackupInfo>;
  activeBackup = chained;
  return chained;
}

/** Fire a backup but never reject — for the timer callbacks. */
function runBackupSilently(): void {
  void runBackupNow().catch(() => {
    /* recorded in lastBackupError; see runBackupNow */
  });
}

/**
 * (Re)start the scheduler from the current persisted config. Idempotent
 * and safe to call repeatedly — it tears down any existing timers
 * first, so it doubles as the "config changed" refresh hook. When
 * `autoBackup` is disabled it simply stops and returns.
 */
export function startBackupScheduler(
  overrideDeps?: Partial<BackupSchedulerDeps>,
): void {
  if (overrideDeps) deps = { ...defaultDeps, ...overrideDeps };
  clearTimers();

  const config = loadConfig();
  if (!config.autoBackup) return;

  const intervalMs = config.backupIntervalHours * MS_PER_HOUR;

  // Decide whether a catch-up backup is already due. A missing
  // directory / empty list (no backup ever) is treated as "due now".
  let dueNow = true;
  const bridge = deps.getBridge();
  if (bridge) {
    try {
      const existing = bridge.bridgeListBackups(resolveBackupDir(config));
      if (existing.length > 0) {
        const newest = existing[0].createdAtMs;
        dueNow = deps.now() - newest >= intervalMs;
      }
    } catch {
      // If we cannot list (e.g. bridge race), fall through to the
      // catch-up path — an extra backup is harmless.
      dueNow = true;
    }
  }

  if (dueNow) {
    initialHandle = deps.setTimeout(() => {
      initialHandle = null;
      runBackupSilently();
    }, INITIAL_CATCHUP_DELAY_MS);
  }

  intervalHandle = deps.setInterval(() => {
    runBackupSilently();
  }, intervalMs);
}

/** Clear both timers without touching an in-flight backup. */
function clearTimers(): void {
  if (intervalHandle) {
    deps.clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (initialHandle) {
    deps.clearTimeout(initialHandle);
    initialHandle = null;
  }
}

/**
 * Re-read config and apply any change to the cadence / enabled state.
 * Called by the `backup:configure` IPC handler after persisting new
 * settings so a cadence change takes effect without an app restart.
 */
export function refreshBackupScheduler(): void {
  startBackupScheduler();
}

/**
 * Stop the scheduler and wait for any in-flight backup to drain.
 * Callers on the quit path must `await` this so a backup copy isn't
 * torn down mid-write. Timers are cleared synchronously so no new
 * backup can start once this is invoked.
 */
export async function stopBackupScheduler(): Promise<void> {
  clearTimers();
  if (activeBackup) {
    try {
      await activeBackup;
    } catch {
      /* recorded in lastBackupError */
    }
  }
}

/** Read-only status object for the Settings → Backup panel / tests. */
export interface BackupSchedulerStatus {
  running: boolean;
  inFlight: boolean;
  lastBackupAt: number | null;
  lastBackupError: string | null;
}

export function getBackupSchedulerStatus(): BackupSchedulerStatus {
  return {
    running: intervalHandle !== null,
    inFlight: activeBackup !== null,
    lastBackupAt,
    lastBackupError,
  };
}

/**
 * Reset all module state + restore production deps. Test-only seam so
 * each Vitest case starts from a clean scheduler.
 */
export function _resetBackupSchedulerForTests(): void {
  clearTimers();
  deps = defaultDeps;
  activeBackup = null;
  lastBackupAt = null;
  lastBackupError = null;
}
