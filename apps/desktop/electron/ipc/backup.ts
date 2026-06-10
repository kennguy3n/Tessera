/**
 * IPC handlers for the `backup:*` channels — the renderer-facing surface
 * of the local backup & recovery system.
 *
 * All cryptographic and atomicity guarantees live Rust-side in
 * `tessera_core::backup` (hot copy via the SQLite Online Backup API,
 * SHA-256 bundle manifests, atomic staged restores). These handlers are
 * the thin main-process layer that:
 *
 *   - resolves the effective backup directory (the `<userData>/backups`
 *     sentinel can only be expanded on the main side);
 *   - assembles the sidecar entries for bundle export/import (the
 *     renderer must never learn the on-disk config path);
 *   - keeps the persisted {@link AppConfig} and the live
 *     {@link backupScheduler} in lock-step so a cadence change takes
 *     effect without an app restart.
 *
 * The renderer never sees the SQLCipher key or re-derives the database
 * path; both were captured Rust-side at `initBridge`. A restore (single
 * file or bundle) is always *staged* for the next launch rather than
 * applied to the live connection, so these handlers can never corrupt an
 * open database.
 */
import { getBridge } from "../appState";
import type {
  BackupInfo,
  BackupRestoreResult,
  BackupStatus,
  BundleImportReport,
  BundleInfo,
} from "../../shared/types";
import { getConfigPath, loadConfig, updateConfig } from "../config";
import {
  getBackupSchedulerStatus,
  refreshBackupScheduler,
  resolveBackupDir,
  runBackupNow,
} from "../backupScheduler";
import { idempotentHandle } from "./register";
import {
  BackupConfigureSchema,
  BackupRestoreSchema,
  BundleExportSchema,
  BundleImportSchema,
} from "./schemas";

/**
 * Archive name + manifest role for the app config folded into a
 * workspace bundle. Kept as constants so export (which packs it) and
 * import (which restores it) can never drift to different names — a
 * mismatch would silently skip the config on restore.
 */
const CONFIG_ARCNAME = "tessera-config.json";
const CONFIG_ROLE = "app-config";

/** Build the current effective {@link BackupStatus} snapshot. */
function buildStatus(): BackupStatus {
  const config = loadConfig();
  const sched = getBackupSchedulerStatus();
  return {
    autoBackup: config.autoBackup,
    backupDir: resolveBackupDir(config),
    backupIntervalHours: config.backupIntervalHours,
    backupRetentionCount: config.backupRetentionCount,
    schedulerRunning: sched.running,
    backupInFlight: sched.inFlight,
    lastBackupAt: sched.lastBackupAt,
    lastBackupError: sched.lastBackupError,
  };
}

export function registerBackupHandlers(): void {
  // `backup:create` — run a hot backup now (manual "Back up now"
  // button / catch-up). Routed through the scheduler's `runBackupNow`
  // so it shares the single-flight guard and prune step with the
  // automatic path; two concurrent "Back up now" clicks coalesce onto
  // one copy instead of racing on the shared connection.
  idempotentHandle("backup:create", async (): Promise<BackupInfo> => {
    return runBackupNow();
  });

  // `backup:list` — newest-first listing for the Settings panel and the
  // HomePage "last backup" indicator. A missing directory yields an
  // empty list (handled Rust-side), so a fresh install renders cleanly
  // rather than erroring.
  idempotentHandle("backup:list", async (): Promise<BackupInfo[]> => {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeListBackups(resolveBackupDir());
  });

  // `backup:status` — effective config + scheduler health for the
  // Settings panel and HomePage indicator in a single round-trip.
  idempotentHandle("backup:status", async (): Promise<BackupStatus> => {
    return buildStatus();
  });

  // `backup:restore` — validate that the chosen backup decrypts under
  // the live key, then stage it for the next launch. Never mutates the
  // live DB; the swap happens in `initAppState` before the bridge opens
  // the database. Returns `requiresRestart: true` so the renderer can
  // prompt the user to relaunch.
  idempotentHandle(
    "backup:restore",
    async (_event, raw: unknown): Promise<BackupRestoreResult> => {
      const { backupPath } = BackupRestoreSchema.parse(raw);
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const stagedPath = bridge.bridgeStageRestore(backupPath);
      return { stagedPath, requiresRestart: true };
    },
  );

  // `backup:configure` — partial update of the backup scheduler config.
  // Persists via `updateConfig`, then `refreshBackupScheduler` re-reads
  // it so a cadence / enabled change takes effect immediately (no
  // restart). Returns the new effective status.
  idempotentHandle(
    "backup:configure",
    async (_event, raw: unknown): Promise<BackupStatus> => {
      const patch = BackupConfigureSchema.parse(raw);
      // The schema is `.strict()`, so an unknown key has already thrown
      // above rather than silently slipping through; `updateConfig`
      // shallow-merges this validated partial over the current config,
      // touching only the fields the renderer actually sent.
      updateConfig(patch);
      refreshBackupScheduler();
      return buildStatus();
    },
  );

  // `backup:exportBundle` — write a full `.tessera-backup` archive (hot
  // DB copy + the app config JSON) to the user-chosen path. The renderer
  // supplies only the destination; the handler resolves the config path
  // itself so the renderer never learns the on-disk layout.
  idempotentHandle(
    "backup:exportBundle",
    async (_event, raw: unknown): Promise<BundleInfo> => {
      const { outPath } = BundleExportSchema.parse(raw);
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      // The config file always exists by the time any window can invoke
      // this (it's written on first launch), but the Rust exporter
      // tolerates a missing sidecar defensively too.
      const extras = [
        { role: CONFIG_ROLE, arcname: CONFIG_ARCNAME, path: getConfigPath() },
      ];
      return bridge.bridgeExportBundle(outPath, extras);
    },
  );

  // `backup:importBundle` — verify every entry's SHA-256 against the
  // manifest, stage the contained database for the next launch, and
  // atomically restore the app config sidecar back to its canonical
  // path. Returns the staged DB path so the renderer can prompt for a
  // restart.
  idempotentHandle(
    "backup:importBundle",
    async (_event, raw: unknown): Promise<BundleImportReport> => {
      const { bundlePath } = BundleImportSchema.parse(raw);
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const targets = [{ arcname: CONFIG_ARCNAME, path: getConfigPath() }];
      return bridge.bridgeImportBundle(bundlePath, targets);
    },
  );
}
