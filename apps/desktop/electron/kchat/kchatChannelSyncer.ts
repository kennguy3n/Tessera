/**
 * KChat channel-sync substrate. Houses the shared pieces of the
 * full-channel sync (`runAddKchatChannel` in `ipc/kchat.ts`) and the
 * Block B Task 2 single-file sync (`KchatEventForwarder.handleFileAdded`)
 * so the two stay in lockstep.
 *
 * Three concerns live here:
 *
 *   1. **Manifest** (`KchatChannelManifest` + `readManifest` /
 *      `writeManifest`): on-disk record mapping `fi.id → finalName`
 *      that lets every sync (full or single-file) be convergent
 *      across re-runs and across forwarder/IPC entry points. Lives
 *      OUTSIDE the channel cache directory so the indexer never
 *      treats it as a corpus document.
 *
 *   2. **Per-channel mutex** (`withChannelSyncLock`): FIFO promise
 *      chain so a full sync and a single-file sync for the same
 *      channel cannot interleave their manifest reads/writes (the
 *      forwarder's `file_added` writes would otherwise be lost
 *      when a concurrent full sync's end-of-walk `writeManifest`
 *      overwrote with stale data). Cross-channel calls are
 *      unaffected — each channel id has its own mutex.
 *
 *   3. **Sanitised single-file download** (`downloadKchatFileToCache`):
 *      shared write path that applies the same basename sanitisation,
 *      same `seenNames` dedupe, and same containment check as the
 *      full sync. Both `runAddKchatChannel` and the forwarder call
 *      this so a regression in either layer cannot let a
 *      server-supplied filename escape the cache root.
 *
 * Nothing in this module touches the native bridge or the IPC layer
 * directly — it's a substrate pure enough to be unit-tested in
 * isolation. Bridge calls happen in the callers (the IPC handler
 * for `bridgeAddKchatChannel` / `bridgeLogKchatFileDownloaded`, the
 * forwarder for `bridgeIndexKchatFile` / `bridgeLogKchat*`).
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { KchatFileInfo } from "./kchatTypes";

/**
 * On-disk record of which KChat files have already been downloaded
 * to a channel's local cache, and under which on-disk name.
 *
 * The manifest is the source of truth for convergent sync: every
 * sync (re-)reads it at start to (a) skip re-downloading files
 * whose `fi.id` already appears AND whose recorded on-disk file
 * still exists, and (b) on full sync, unlink any files whose
 * `fi.id` is no longer present on the server roster after the
 * walk completes (server-side deletion between syncs).
 */
export interface KchatChannelManifest {
  /** Schema version; bumped when the on-disk shape changes. */
  version: 1;
  /** Channel id the manifest belongs to (sanity-check on load). */
  channelId: string;
  /**
   * Map from KChat file id (`fi.id`) to the on-disk basename inside
   * `cacheDir` we wrote the bytes under. Recorded names are the
   * already-sanitised, already-deduped form (i.e. the same string
   * we passed to `fs.writeFile` last time around), so consumers do
   * not need to re-run the dedupe step.
   */
  files: Record<string, string>;
}

/** Path of the sidecar manifest file for a given channel cacheDir. */
export function manifestPathFor(cacheDir: string): string {
  // `<parent>/<id>/` → `<parent>/<id>.manifest.json` so the manifest
  // is a sibling of `cacheDir`, never inside it. This guarantees
  // `bridgeAddKchatChannel(cacheDir)` — which scans `cacheDir` —
  // cannot accidentally index the manifest as a corpus document.
  return `${cacheDir.replace(/[/\\]$/, "")}.manifest.json`;
}

export async function readManifest(
  cacheDir: string,
  channelId: string,
): Promise<KchatChannelManifest> {
  try {
    const raw = await fs.readFile(manifestPathFor(cacheDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      (parsed as { channelId?: unknown }).channelId === channelId &&
      typeof (parsed as { files?: unknown }).files === "object" &&
      (parsed as { files: unknown }).files !== null
    ) {
      // Re-validate each entry so a tampered manifest cannot inject
      // arbitrary disk names.
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (parsed as { files: Record<string, unknown> }).files,
      )) {
        if (typeof k === "string" && typeof v === "string") files[k] = v;
      }
      return { version: 1, channelId, files };
    }
  } catch {
    // No manifest yet (first sync) or the file is unreadable / not
    // JSON / wrong shape. Treat as empty — the worst case is one
    // extra re-download of existing files on the next run.
  }
  return { version: 1, channelId, files: {} };
}

export async function writeManifest(
  cacheDir: string,
  manifest: KchatChannelManifest,
): Promise<void> {
  // Write to a temp file then rename to make the manifest update
  // atomic from a crash-recovery perspective: a torn JSON file
  // would be rejected by `readManifest` and the next sync would
  // fall back to "download everything", which is wasteful but not
  // unsafe. The atomic-rename keeps the steady-state case clean.
  const target = manifestPathFor(cacheDir);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest));
  await fs.rename(tmp, target);
}

// ----------------------------------------------------------------
// Per-channel sync mutex (FIFO promise chain)
// ----------------------------------------------------------------

/**
 * FIFO mutex over a `() => Promise<unknown>` body. One instance per
 * channel id — created lazily by `withChannelSyncLock`. A new
 * `lock()` call appends to `tail`; the next caller awaits the
 * settled state of `tail` before its `work()` runs.
 *
 * We swallow prior-holder errors when chaining: a single-file
 * sync's failure must NOT poison the lock for the full sync that
 * follows (and vice versa). The caller still observes its own
 * `work()` error.
 */
class ChannelSyncMutex {
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;

  get isIdle(): boolean {
    return this.active === 0;
  }

  async lock<T>(work: () => Promise<T>): Promise<T> {
    const myTurn = this.tail;
    let release!: () => void;
    // Install the new tail synchronously so the *next* caller's
    // `lock()` reads it before this body has even started.
    this.tail = new Promise<void>((r) => {
      release = r;
    });
    this.active += 1;
    try {
      // Wait for the previous holder. Swallow its error so a
      // misbehaving prior caller doesn't reject every subsequent
      // caller's promise.
      try {
        await myTurn;
      } catch {
        /* prior holder failed — proceed anyway */
      }
      return await work();
    } finally {
      this.active -= 1;
      release();
    }
  }
}

const channelMutexes = new Map<string, ChannelSyncMutex>();

/**
 * Run `work` under the per-channel mutex for `channelId`.
 *
 * The Block B Task 2 forwarder uses this so its single-file
 * `file_added` path serialises with the IPC handler's full-sync
 * path (`runAddKchatChannel`) and with other single-file
 * `file_added` events for the same channel. Different channels
 * run in parallel unimpeded.
 *
 * Mutex instances are kept until the channel goes idle (no callers
 * queued), at which point the entry is removed from the map. This
 * matters for a long-lived process that touches thousands of
 * channels over its lifetime — without cleanup, every channel id
 * ever observed would accumulate a `ChannelSyncMutex` permanently.
 */
export async function withChannelSyncLock<T>(
  channelId: string,
  work: () => Promise<T>,
): Promise<T> {
  let mu = channelMutexes.get(channelId);
  if (!mu) {
    mu = new ChannelSyncMutex();
    channelMutexes.set(channelId, mu);
  }
  try {
    return await mu.lock(work);
  } finally {
    // Best-effort cleanup. We only delete if the mutex is idle AND
    // still the one in the map (a concurrent caller may have
    // already swapped in a new instance — though under the current
    // lazy-create flow they wouldn't, this guard is cheap insurance
    // for future refactors).
    if (mu.isIdle && channelMutexes.get(channelId) === mu) {
      channelMutexes.delete(channelId);
    }
  }
}

// Test-only helper. Vitest tests need to assert that the mutex
// map is empty between scenarios so a leaked entry would surface
// loudly instead of silently accumulating across tests. The
// `_test_*` prefix marks it as not for production use.
export function _test_channelMutexCount(): number {
  return channelMutexes.size;
}

// ----------------------------------------------------------------
// Sanitised single-file download
// ----------------------------------------------------------------

/**
 * Result of [`downloadKchatFileToCache`]. Returned to the caller so
 * it can decide whether to call the bridge index path (only when
 * `wrote === true`) and update the manifest.
 */
export interface DownloadKchatFileResult {
  /**
   * `true` when the bytes were written to disk in this call.
   * `false` when a containment-check rejection forced a skip.
   */
  wrote: boolean;
  /**
   * The sanitised + deduped basename we attempted (e.g.
   * `report-fid123.pdf` after a basename collision was resolved).
   *
   * `null` ONLY in the (currently unreachable) edge case where a
   * basename cannot be constructed at all. On the happy path AND
   * on containment rejection this is the actual basename so the
   * caller can record it in audit logs — in particular on
   * rejection the offending name is preserved as forensic
   * evidence of a misbehaving server.
   */
  finalName: string | null;
  /**
   * Byte length of the bytes written (or `0` for skip).
   * The caller forwards this to the audit row.
   */
  bytesWritten: number;
  /**
   * `true` iff `wrote === false` because the sanitised path
   * resolved outside `cacheDir`. The caller should audit-log
   * `finalName` (the offending basename) as a forensic record of
   * the rejection rather than discarding the diagnostic.
   */
  containmentRejected: boolean;
}

/**
 * Dependencies of [`downloadKchatFileToCache`]. Threaded as a
 * parameter object so unit tests can swap in a fake client without
 * having to construct a full `KchatClient`.
 */
export interface DownloadKchatFileDeps {
  downloadFile(fileId: string): Promise<Uint8Array>;
}

/**
 * Download a single KChat file into `cacheDir` and write it to
 * disk under a sanitised, deduped, contained basename.
 *
 * Shared between the full-sync (`runAddKchatChannel`) and the
 * Block B Task 2 single-file sync (`KchatEventForwarder`). Both
 * call paths apply identical safety guarantees:
 *
 *   - **Basename sanitisation**: `path.basename(fi.name)` strips
 *     any server-injected directory component; `.` / `..` /
 *     empty names fall back to `kchat-file-<sanitisedId>` (or
 *     `kchat-file-<page>-<idx>` when the id is unusable).
 *   - **Dedupe**: if `seenNames` already contains the proposed
 *     name, a `<stem>-<sanitisedId>.<ext>` suffix is inserted so
 *     two server files with the same `fi.name` don't overwrite
 *     each other's bytes.
 *   - **Containment**: the resolved absolute path MUST live
 *     inside `resolvedCacheDir`. A containment-check failure
 *     short-circuits with `wrote: false, finalName: null` — the
 *     caller is responsible for the appropriate audit/logging.
 *
 * The caller passes `seenNames` (mutated in-place when the write
 * succeeds) so a pagination loop's collision-avoidance state
 * survives across calls. For a single-file sync, the caller can
 * pass a `Set` seeded from the manifest values so a `file_added`
 * push doesn't collide with names already recorded from a prior
 * full sync.
 *
 * `idHints.page` / `idHints.idx` are used only for the fallback
 * basename (`kchat-file-<page>-<idx>`) when `fi.id` is empty or
 * unsanitisable. Single-file callers pass `{ page: 0, idx: 0 }`
 * which is fine — the fallback only fires for malformed input.
 */
export async function downloadKchatFileToCache(
  deps: DownloadKchatFileDeps,
  cacheDir: string,
  fi: Pick<KchatFileInfo, "id" | "name">,
  seenNames: Set<string>,
  idHints: { page: number; idx: number } = { page: 0, idx: 0 },
): Promise<DownloadKchatFileResult> {
  const resolvedCacheDir = path.resolve(cacheDir);
  const baseName = path.basename(fi.name ?? "");
  const sanitisedId = (fi.id ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
  const idFallback = sanitisedId
    ? `kchat-file-${sanitisedId}`
    : `kchat-file-${idHints.page}-${idHints.idx}`;
  const safeName =
    baseName && baseName !== "." && baseName !== ".."
      ? baseName
      : idFallback;

  let finalName = safeName;
  if (seenNames.has(finalName)) {
    const ext = path.extname(safeName);
    const stem = ext
      ? safeName.slice(0, safeName.length - ext.length)
      : safeName;
    const suffix = sanitisedId || `${idHints.page}-${idHints.idx}`;
    finalName = `${stem}-${suffix}${ext}`;
    if (seenNames.has(finalName)) {
      finalName = `${stem}-${suffix}-${seenNames.size}${ext}`;
    }
  }

  const targetPath = path.resolve(cacheDir, finalName);
  if (
    targetPath === resolvedCacheDir ||
    !targetPath.startsWith(resolvedCacheDir + path.sep)
  ) {
    // Sanitised name still escaped — refuse to write. Return the
    // offending basename (NOT `null`) so the caller can record it
    // in the audit log: an empty string would lose the only
    // forensic clue about which server-supplied name escaped.
    return {
      wrote: false,
      finalName,
      bytesWritten: 0,
      containmentRejected: true,
    };
  }

  const bytes = await deps.downloadFile(fi.id);
  await fs.writeFile(targetPath, bytes);
  // Mark as taken AFTER the write succeeds so a failed download
  // (e.g. transient network error mid-pagination) doesn't reserve
  // the slot and force a deduped name on retry. The caller catches
  // the throw and surfaces it; we don't add to `seenNames` until
  // the bytes are durably on disk.
  seenNames.add(finalName);
  return {
    wrote: true,
    finalName,
    bytesWritten: bytes.byteLength,
    containmentRejected: false,
  };
}
