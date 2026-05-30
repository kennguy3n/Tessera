/**
 * Phase 15 Task 8: artifact auto-save recovery journal.
 *
 * Two failure modes this protects against:
 *
 *   1. **Main-process crash mid-bridge-call** — the renderer fired
 *      `artifacts:update` with new content, the handler had marshalled
 *      the arguments and was inside the `bridge.bridgeUpdateArtifactContent`
 *      N-API call when the process died. The DB row still holds the
 *      previous content; the in-flight content is gone.
 *   2. **Power loss between two consecutive auto-saves** — the user
 *      typed a paragraph after the last successful save, then the
 *      machine lost power before the 2 s debounce fired and the
 *      next `artifacts:update` reached us.
 *
 * Mitigation: every `artifacts:update` handler writes the incoming
 * content to a sibling `.tessera-recovery/<id>.json` sidecar BEFORE
 * calling the bridge, and clears the sidecar AFTER the bridge call
 * succeeds. On artifact open, the handler checks for a stale sidecar
 * and reports it to the renderer, which surfaces a "Restore unsaved
 * changes from <time>?" prompt.
 *
 * Why a separate sidecar rather than a WAL inside the DB:
 *
 *   * The DB itself is protected by SQLite WAL (Phase 15 Task 7).
 *     A second WAL layer wouldn't add coverage — both layers live in
 *     the same database file and a crash that takes out one usually
 *     takes out the other.
 *   * A sidecar file on the user-data directory is observable by
 *     the user (they can find their unsaved work even if the
 *     application refuses to launch).
 *   * Atomic-write semantics (`write → fsync → rename`) on the
 *     sidecar are independent of every SQLite operation, so the
 *     sidecar lands on disk before the bridge call even begins.
 *
 * Compression / encryption: deliberately not. Recovery is a "broken
 * glass" path the user invokes once; the latency of `JSON.stringify`
 * + atomic write is dominated by the debounce window, not by the
 * I/O. Encryption would require a key the recovery path can fetch
 * without the DB being open, which is exactly the failure mode this
 * file is supposed to protect against.
 */
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { app } from "electron";

/**
 * Shape persisted to `<userData>/.tessera-recovery/<artifactId>.json`.
 *
 * `version` lets a future format change be detected on read without
 * silently misinterpreting an older sidecar — `loadRecovery` rejects
 * any envelope whose version it doesn't understand. `timestamp` is
 * the millisecond epoch at the moment we WROTE the sidecar (used by
 * the "newer than the DB row" comparison in the open handler);
 * `content` is the exact string the renderer passed to
 * `artifacts:update`, so restoring is a byte-for-byte replay.
 */
export interface RecoveryEnvelope {
  version: 1;
  artifactId: string;
  content: string;
  /** Epoch ms at sidecar write time. */
  timestamp: number;
}

/**
 * Subdirectory inside Electron's `userData` directory that holds the
 * sidecars. Lifted out as a constant so the test harness can monkey-
 * patch `electron.app.getPath("userData")` and the production path
 * stays a single source of truth.
 */
const RECOVERY_DIR = ".tessera-recovery";

/** Marker tagging V1 envelopes; bump if the shape changes. */
const RECOVERY_VERSION = 1 as const;

/**
 * Test-only override for the recovery directory. Set via
 * {@link setRecoveryDirOverrideForTests} so Vitest specs that don't
 * boot Electron can still exercise the read / write / clear paths
 * against a `tempdir()` instead of touching the real `userData`.
 */
let recoveryDirOverride: string | null = null;

/**
 * Inject a custom recovery directory for the duration of a test run.
 * Production code never calls this; the IPC handlers always go
 * through {@link recoveryDirFor}, which prefers the override when
 * present and falls back to `<userData>/.tessera-recovery` otherwise.
 *
 * Pass `null` to clear the override at test teardown.
 */
export function setRecoveryDirOverrideForTests(dir: string | null): void {
  recoveryDirOverride = dir;
}

/**
 * Resolve the directory that holds recovery sidecars.
 *
 * Production path: `<app.getPath("userData")>/.tessera-recovery`.
 * Test path: whatever {@link setRecoveryDirOverrideForTests} set.
 *
 * Always returns an absolute path so callers can `path.join` an
 * artifact id onto it without worrying about CWD.
 */
function recoveryDirFor(): string {
  if (recoveryDirOverride !== null) return recoveryDirOverride;
  return path.join(app.getPath("userData"), RECOVERY_DIR);
}

/**
 * Compute the absolute sidecar path for one artifact id.
 *
 * Defensive sanitisation: even though the upstream IPC validators
 * (`assertId`) restrict artifact ids to a tight character class, we
 * additionally strip path separators here so that a regression in
 * the validators cannot turn this into a path-traversal sink
 * (e.g. `../../../etc/passwd`). The recovery sidecar must NEVER
 * escape the recovery directory.
 */
function sidecarPathFor(artifactId: string): string {
  const safeId = artifactId.replace(/[/\\]/g, "_").replace(/^\.+/, "_");
  return path.join(recoveryDirFor(), `${safeId}.json`);
}

/**
 * Best-effort `mkdir -p` for the recovery directory. Idempotent;
 * returns silently if the directory already exists. Failures are
 * propagated to the caller so the IPC handler can decide whether
 * to abort the save (the renderer would prefer to fail loudly here
 * rather than silently lose recovery coverage).
 */
async function ensureRecoveryDir(): Promise<void> {
  await fs.mkdir(recoveryDirFor(), { recursive: true });
}

/**
 * Atomic write of one recovery sidecar.
 *
 * Sequence:
 *   1. Stringify the envelope.
 *   2. Write to a `.tmp-<rand>` sibling under the recovery dir.
 *   3. `fsync` the temp file (real I/O barrier — without this the
 *      rename can win the race to disk and we'd land an empty file
 *      after a crash).
 *   4. `rename` the temp file over the final sidecar path —
 *      atomic on POSIX and on NTFS (when the destination is on the
 *      same volume).
 *
 * Step 3's `fsync` is what makes this a real recovery primitive
 * rather than a "best effort" cache. The cost is a single
 * `fdatasync()` per auto-save, which on modern SSDs is sub-
 * millisecond and well inside the existing 2 s debounce budget.
 *
 * If any step throws, the in-flight `.tmp-` file is best-effort
 * cleaned up so we don't leak a tempfile per crash.
 */
export async function writeRecovery(
  artifactId: string,
  content: string,
): Promise<void> {
  await ensureRecoveryDir();
  const finalPath = sidecarPathFor(artifactId);
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.floor(
    Math.random() * 1e9,
  )}`;
  const envelope: RecoveryEnvelope = {
    version: RECOVERY_VERSION,
    artifactId,
    content,
    timestamp: Date.now(),
  };
  const body = JSON.stringify(envelope);

  // Manual handle so we can fsync; `fs.writeFile` doesn't expose the
  // descriptor and skipping the fsync would defeat the point.
  const handle = await fs.open(tmpPath, "w", 0o600);
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await fs.rename(tmpPath, finalPath);
  } catch (e) {
    // Best-effort cleanup of the temp file so a failed rename
    // doesn't leave a tmp-* fragment in the recovery dir.
    await fs.unlink(tmpPath).catch(() => undefined);
    throw e;
  }
}

/**
 * Read the recovery sidecar for one artifact, returning `null` if
 * none exists or the on-disk content is unreadable / from a future
 * format. Used by `artifacts:checkRecovery` and by `artifacts:open`
 * to decide whether to show the "Restore unsaved changes?" prompt.
 *
 * Format-version rejection: a sidecar whose `version` field doesn't
 * match {@link RECOVERY_VERSION} is treated as missing rather than
 * surfaced. This lets a future Tessera write a V2 envelope without
 * an older Tessera misinterpreting it as V1 data — the worst-case
 * outcome is the user loses the recovery copy (the DB is still
 * authoritative), which is strictly better than restoring corrupt
 * content.
 */
export async function loadRecovery(
  artifactId: string,
): Promise<RecoveryEnvelope | null> {
  const finalPath = sidecarPathFor(artifactId);
  let raw: string;
  try {
    raw = await fs.readFile(finalPath, "utf-8");
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return null;
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !("version" in parsed) ||
    (parsed as { version: unknown }).version !== RECOVERY_VERSION
  ) {
    return null;
  }
  // After confirming `parsed` is a non-null object with the right
  // `version` discriminator, walk the remaining required fields
  // via a single typed view so TypeScript's strict
  // object-conversion rules don't reject each per-field cast.
  // Using `Record<string, unknown>` is the lowest-friction
  // structural type that matches "an object whose property types
  // we haven't validated yet".
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.artifactId !== "string" ||
    typeof candidate.content !== "string" ||
    typeof candidate.timestamp !== "number"
  ) {
    return null;
  }
  // Re-narrow to the typed shape after structural validation.
  const env = parsed as RecoveryEnvelope;
  if (env.artifactId !== artifactId) {
    // The sidecar was written for a different artifact (e.g. a
    // collision after the validator stripped path characters from
    // two different ids). Don't restore content from a foreign
    // artifact.
    return null;
  }
  return env;
}

/**
 * Best-effort sidecar removal. Used by `artifacts:update` after a
 * successful bridge write (the DB now holds the canonical copy, so
 * the sidecar is no longer needed) AND by `artifacts:discardRecovery`
 * when the user dismisses the restore prompt.
 *
 * Swallows `ENOENT` so calling it for a non-existent sidecar is a
 * no-op rather than an error — this is the common case (every
 * artifact's first save has no prior sidecar).
 */
export async function clearRecovery(artifactId: string): Promise<void> {
  const finalPath = sidecarPathFor(artifactId);
  try {
    await fs.unlink(finalPath);
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    throw e;
  }
}

/**
 * Synchronous variant of {@link clearRecovery} for use from
 * `will-quit` / `before-quit` handlers, where Electron does not
 * await Promises and the process can exit before an async
 * `unlink` settles. Production calls this from the auto-save
 * post-write hook on the renderer side, but the IPC handlers
 * themselves can use the async variant because they always
 * `await` the bridge call.
 *
 * Exported separately rather than gated on a flag so the call
 * site reads exactly what kind of I/O it's invoking.
 */
export function clearRecoverySync(artifactId: string): void {
  const finalPath = sidecarPathFor(artifactId);
  try {
    fsSync.unlinkSync(finalPath);
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    throw e;
  }
}
