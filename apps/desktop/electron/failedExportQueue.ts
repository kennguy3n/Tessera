/**
 * Phase 15 Task 10: persisted failure queue for artifact exports.
 *
 * Exports can fail for a variety of recoverable + non-recoverable
 * reasons:
 *
 *   * **Recoverable**: target disk full, write directory permission
 *     denied (user clicked Cancel on the OS sandbox prompt and we
 *     want to re-prompt later), printer driver missing, network
 *     share temporarily unreachable, Typst compiler ENOMEM during
 *     a large render.
 *   * **Non-recoverable**: malformed source content (Typst syntax
 *     error in user authored body), unsupported export format for
 *     this artifact type.
 *
 * Before this module the renderer just surfaced a toast on failure
 * and forgot the request — the user had to remember the export
 * format + destination path and try again by hand. The
 * `FailedExportQueue` persists each failure and exposes
 * `artifacts:failedExports` / `artifacts:retryExport(id)` IPC so
 * the renderer can render a "Failed exports" badge in Settings
 * with a one-click retry per row.
 *
 * Persistence model: dedicated `failed-exports.json` file under
 * `<userData>`, not folded into `config.json`. Two reasons:
 *
 *   1. Lifecycle decoupling — failed exports churn (one entry per
 *      failed click, removed on success). A churning array inside
 *      `config.json` would (a) bloat the file the renderer reads
 *      on every settings UI tick and (b) force every export-side
 *      mutation to round-trip through the config zod schema for
 *      no semantic benefit.
 *   2. Failure-mode independence — the export queue must remain
 *      readable even if `config.json` is corrupt. Sharing the
 *      file would mean a corrupt config (which already heals via
 *      zod) silently wipes the user's pending retries.
 *
 * Concurrency: the queue uses a `serializeWrites` mutex so that
 * concurrent failures (e.g. a bulk-export that loses N files in
 * parallel) cannot interleave and lose entries via lost-update.
 * Reads are unsynchronised (the on-disk JSON is monotonically
 * grown by writers and overwritten atomically) so the UI's
 * snapshot read is always self-consistent — it sees either the
 * pre-write or post-write state, never a torn intermediate.
 */
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { app } from "electron";

/**
 * Maximum number of pending failures we retain. Beyond this, the
 * oldest entry is dropped on insert (FIFO eviction).
 *
 * 100 is generous — a normal user might hit single-digit failures
 * across a session, and a pathological case (bulk-exporting a
 * malformed template to 1000 artifacts) would still be capped at
 * a useful set for the user to inspect rather than swelling the
 * config file unboundedly. Larger caps don't buy anything: if
 * the user has 100+ failed exports they need to fix their
 * environment, not retry them all individually.
 */
export const FAILED_EXPORTS_MAX = 100;

/**
 * On-disk shape of one failed export entry. `id` is generated
 * server-side (not derived from the artifact id) so a single
 * artifact can have multiple distinct pending failures (e.g.
 * "PDF to ~/Desktop failed" AND "DOCX to ~/Reports failed").
 * The renderer uses `id` as the React key and as the argument to
 * `artifacts:retryExport(id)`.
 *
 * `format` and `filePath` are the EXACT arguments that would be
 * passed to `artifacts:exportToFile` on retry — no parsing
 * required, no UI to re-fill. This is what makes the retry
 * one-click rather than a re-open-the-export-dialog flow.
 */
export interface FailedExportEntry {
  /** Stable ID generated at enqueue time. */
  id: string;
  artifactId: string;
  format: string;
  /** Original destination path (may be empty if user picked dialog). */
  filePath: string;
  /** Human-readable failure reason from the original exporter throw. */
  errorMessage: string;
  /** Epoch ms at enqueue time. */
  failedAt: number;
  /** How many retries have been attempted (excludes the original failed call). */
  retryCount: number;
}

/** On-disk envelope; bumped if the entry shape changes. */
interface FailedExportsFile {
  version: 1;
  entries: FailedExportEntry[];
}

const FILE_VERSION = 1 as const;
const FILE_NAME = "failed-exports.json";

/** Test override mirroring the recovery + PID modules. */
let pathOverride: string | null = null;

export function setFailedExportsPathOverrideForTests(p: string | null): void {
  pathOverride = p;
}

function filePathFor(): string {
  if (pathOverride !== null) return pathOverride;
  return path.join(app.getPath("userData"), FILE_NAME);
}

/**
 * In-process serializer — every mutating call goes through this
 * promise chain so two concurrent `enqueue` calls cannot read,
 * mutate, and write the same on-disk snapshot in parallel (the
 * classic lost-update bug). The serializer is module-scoped so
 * it correctly serializes across multiple importing modules in
 * the same Node process.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function serializeWrites<T>(fn: () => Promise<T>): Promise<T> {
  // Devin Review ANALYSIS-0003: only one callback on `.then()`.
  // `writeChain` is set to `next.catch(() => undefined)` immediately
  // after every call, so it can never reach a rejected state — the
  // two-arg form `then(onFulfilled, onRejected)` would have been
  // dead code (the rejection branch is unreachable). Keeping the
  // chain alive across rejections of `fn` itself is still handled
  // by the `.catch(() => undefined)` below.
  const next = writeChain.then(() => fn());
  writeChain = next.catch(() => undefined);
  return next;
}

/**
 * Read the queue from disk. Returns an empty list when the file
 * doesn't exist OR when it's malformed (a fresh install never has
 * the file; a corrupt file from a partial write is treated as
 * "no pending failures" rather than crashing the renderer).
 *
 * Synchronous variant only used by the file-not-found probe; all
 * production reads go through {@link listFailedExports}.
 */
export async function listFailedExports(): Promise<FailedExportEntry[]> {
  const file = filePathFor();
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf-8");
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return [];
    }
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== FILE_VERSION ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    return [];
  }
  // Structurally validate each entry; anything that doesn't match
  // the documented shape is silently dropped so a forward-compat
  // shape extension or a partial write doesn't poison the renderer
  // UI. We deliberately do NOT throw on per-entry corruption — the
  // worst case ("renderer doesn't see one failed export") is far
  // better than the failure mode ("settings page crashes").
  //
  // Defense-in-depth (Devin Review PR #69, store.rs:423 follow-up):
  // also require `filePath` to be a non-empty ABSOLUTE path. The
  // queue is only ever written with an already-resolved absolute
  // destination (see `enqueue` callers), so any entry on disk with
  // a relative path is the signature of a tampered queue file. We
  // drop those entries here rather than passing them to the retry
  // handler, where a relative path would resolve against the
  // process cwd and could land outside the safe-export allowlist
  // (the allowlist check exits early on non-absolute inputs). The
  // retry handler ALSO rejects non-absolute paths as a second
  // layer of defense; this filter just keeps the renderer-visible
  // list clean so the user never sees a "broken" retry button.
  const entries = (parsed as { entries: unknown[] }).entries.filter(
    (e): e is FailedExportEntry => {
      if (e === null || typeof e !== "object") return false;
      const candidate = e as Record<string, unknown>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.artifactId === "string" &&
        typeof candidate.format === "string" &&
        typeof candidate.filePath === "string" &&
        candidate.filePath.length > 0 &&
        path.isAbsolute(candidate.filePath) &&
        typeof candidate.errorMessage === "string" &&
        typeof candidate.failedAt === "number" &&
        typeof candidate.retryCount === "number"
      );
    },
  );
  return entries;
}

/**
 * Internal atomic write: serialise + fsync + rename, identical
 * crash-safety contract to `artifactRecovery.writeRecovery`.
 */
async function writeQueueAtomically(
  entries: FailedExportEntry[],
): Promise<void> {
  const file = filePathFor();
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.floor(
    Math.random() * 1e9,
  )}`;
  const body: FailedExportsFile = { version: FILE_VERSION, entries };
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify(body));
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/**
 * Append a failure to the queue. Generates the `id` server-side
 * (timestamp + random suffix — collision-free at any plausible
 * insertion rate; we don't need cryptographic uniqueness because
 * the IDs are scoped to one user's queue).
 *
 * FIFO-evicts the oldest entry when {@link FAILED_EXPORTS_MAX} is
 * reached. The evicted entry is silently dropped — the renderer
 * always shows the current snapshot and the user will see the
 * eviction as "the queue stopped growing", which is the right
 * behaviour for a "broken environment" recovery surface.
 */
export async function enqueueFailedExport(args: {
  artifactId: string;
  format: string;
  filePath: string;
  errorMessage: string;
}): Promise<FailedExportEntry> {
  return serializeWrites(async () => {
    const existing = await listFailedExports();
    const entry: FailedExportEntry = {
      id: `fx_${Date.now()}_${Math.floor(Math.random() * 1e9).toString(36)}`,
      artifactId: args.artifactId,
      format: args.format,
      filePath: args.filePath,
      errorMessage: args.errorMessage,
      failedAt: Date.now(),
      retryCount: 0,
    };
    let next = [...existing, entry];
    if (next.length > FAILED_EXPORTS_MAX) {
      // Drop oldest first.
      next = next.slice(next.length - FAILED_EXPORTS_MAX);
    }
    await writeQueueAtomically(next);
    return entry;
  });
}

/**
 * Remove a queue entry by id. Called from `artifacts:retryExport`
 * after a successful retry (so the entry leaves the queue once
 * the export actually lands on disk).
 *
 * Returns true if the entry was found, false if not (idempotent
 * — a duplicate dequeue is a no-op rather than an error).
 */
export async function removeFailedExport(id: string): Promise<boolean> {
  return serializeWrites(async () => {
    const existing = await listFailedExports();
    const next = existing.filter((e) => e.id !== id);
    if (next.length === existing.length) return false;
    await writeQueueAtomically(next);
    return true;
  });
}

/**
 * Bump the `retryCount` of a queue entry without removing it.
 * Called from `artifacts:retryExport` when the retry ALSO fails —
 * the entry stays in the queue so the user can try again, but
 * the count reflects how many attempts have been made.
 *
 * Returns the updated entry, or null if the id was already gone
 * (race with a concurrent removeFailedExport).
 */
export async function bumpRetryCount(
  id: string,
): Promise<FailedExportEntry | null> {
  return serializeWrites(async () => {
    const existing = await listFailedExports();
    const idx = existing.findIndex((e) => e.id === id);
    if (idx === -1) return null;
    const next = [...existing];
    next[idx] = { ...next[idx], retryCount: next[idx].retryCount + 1 };
    await writeQueueAtomically(next);
    return next[idx];
  });
}

/**
 * Find a queue entry by id without mutation. Used by
 * `artifacts:retryExport` to pull the original arguments for the
 * retry call. Returns null if the id was already removed.
 */
export async function getFailedExport(
  id: string,
): Promise<FailedExportEntry | null> {
  const all = await listFailedExports();
  return all.find((e) => e.id === id) ?? null;
}

/**
 * Synchronous best-effort delete of the underlying file. Test-only;
 * production never deletes the file outright (entries are removed
 * one-by-one via `removeFailedExport`).
 */
export function clearAllFailedExportsForTests(): void {
  const file = filePathFor();
  try {
    fsSync.unlinkSync(file);
  } catch {
    // ignore
  }
}
