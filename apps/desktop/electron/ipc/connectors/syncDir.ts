/**
 * Per-provider local sync directory helpers (Phase 10 Tasks 1–6).
 *
 * Every connector writes the files it pulled down to
 * `<userData>/<provider>-sync/<file-id>.<ext>` so the local indexer
 * can treat them as ordinary text files. Disconnect removes the whole
 * directory.
 *
 * The manifest file at `<userData>/<provider>-sync/manifest.json`
 * lists the local paths of every file written by the previous sync
 * pass. This lets the "Sync Now" button do a no-arg refresh (re-pull
 * every previously-synced item) and lets disconnect clean up index
 * entries without scanning the filesystem.
 */

import { createHash } from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";

export interface SyncManifestEntry {
  /** Local absolute path. */
  localPath: string;
  /** Provider-side id of the item this path was synced from. */
  remoteId: string;
  /** ISO-8601 of the provider-side modification time at the last sync. */
  remoteModifiedAt: string | null;
  /** Hash of the content at last sync (best-effort). */
  contentHash?: string;
}

export interface SyncManifest {
  version: 1;
  provider: string;
  entries: SyncManifestEntry[];
}

export function syncDirFor(userDataDir: string, provider: string): string {
  return path.join(userDataDir, `${provider}-sync`);
}

export function manifestPathFor(userDataDir: string, provider: string): string {
  return path.join(syncDirFor(userDataDir, provider), "manifest.json");
}

export async function readManifest(
  userDataDir: string,
  provider: string,
): Promise<SyncManifest> {
  const fp = manifestPathFor(userDataDir, provider);
  try {
    const raw = await fsp.readFile(fp, "utf8");
    const parsed = JSON.parse(raw) as SyncManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { version: 1, provider, entries: [] };
    }
    return parsed;
  } catch {
    return { version: 1, provider, entries: [] };
  }
}

export async function writeManifest(
  userDataDir: string,
  manifest: SyncManifest,
): Promise<void> {
  const dir = syncDirFor(userDataDir, manifest.provider);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    manifestPathFor(userDataDir, manifest.provider),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

/**
 * Remove the entire sync directory for the given provider, including
 * the manifest. Best-effort: if a file is in use, log and move on
 * — the directory will be recreated on the next sync.
 */
export async function purgeSyncDir(
  userDataDir: string,
  provider: string,
): Promise<void> {
  const dir = syncDirFor(userDataDir, provider);
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

/**
 * Sanitise a remote item id for use as a local filename.
 *
 * Notion / Atlassian / OneDrive ids can contain `/`, `:`, `!`, etc.
 * which are unsafe across all three desktop filesystems. We replace
 * every non-alphanumeric character with `_` and cap at 200 chars to
 * stay inside the per-filename limit on every supported platform.
 *
 * Collision-resistance: a naive `replace` strategy alone is
 * vulnerable to two distinct remote ids mapping to the same filename
 * — e.g. `page:123` and `page/123` both become `page_123`, which
 * would clobber each other in the manifest and on disk. Today every
 * shipping provider uses ids that contain only `[A-Za-z0-9._-]` (UUID
 * for Notion, `ABC-123` for Jira, numeric for Confluence, opaque
 * base-62 keys for Figma/Drive), so the substitution is a no-op and
 * no collision can occur. But that's a brittle invariant to rely on:
 * a future provider, or a provider that changes its id format, could
 * silently corrupt synced files. To make the helper bulletproof
 * without forcing a file-rename migration on existing users, we only
 * append a short content-addressed suffix when the substitution
 * actually changed the input — i.e. only when the input contained an
 * unsafe character. For every id current providers emit, the output
 * is bit-identical to the pre-suffix behaviour. See Devin Review
 * wave 7B ANALYSIS_0007 (syncDir.ts:99-101).
 */
const COLLISION_HASH_LEN = 8;
const REMOTE_ID_MAX_LEN = 200;
export function sanitiseRemoteId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  if (safe === id) {
    return safe.length > REMOTE_ID_MAX_LEN
      ? safe.slice(0, REMOTE_ID_MAX_LEN)
      : safe;
  }
  // The substitution changed the string: at least one character was
  // remapped to `_`, which means a collision is possible with another
  // id that differs only in those positions. Disambiguate with a
  // truncated SHA-1 of the ORIGINAL id (not of `safe`, so siblings
  // that sanitise to the same prefix still get distinct suffixes).
  const hash = createHash("sha1").update(id).digest("hex").slice(
    0,
    COLLISION_HASH_LEN,
  );
  const suffix = `_${hash}`;
  const head = safe.slice(0, REMOTE_ID_MAX_LEN - suffix.length);
  return `${head}${suffix}`;
}

/**
 * Maximum number of "failed last sync" remote ids we keep around per
 * provider. Bounded so that a stuck connector (e.g. an account that
 * lost permission to a thousand items at once) can't grow the state
 * file unboundedly. If the queue overflows we drop the oldest entries
 * — those items will only be retried when they're edited again,
 * which is the same behaviour as before this fix.
 */
export const FAILED_RETRY_QUEUE_MAX = 200;

/**
 * Per-item failure record persisted between syncs.
 *
 * Connectors that use a monotonic timestamp watermark (Notion, Jira,
 * Figma) need to remember individual items that *transiently* failed
 * to fetch so the next sync can retry them — otherwise the watermark
 * silently moves past the failed item's modification time and the
 * item is never retried until the user edits it again. (See the
 * Devin Review wave 5 finding on `notion.ts:304-341`.) The
 * `failureCount` lets us cap retries: an item that fails too many
 * passes in a row is almost certainly permanently gone (deleted,
 * permissions revoked, OAuth scope changed) and continuing to ping it
 * every sync just wastes API quota.
 */
export interface FailedRetryEntry {
  /** Provider-side id of the item that failed. */
  remoteId: string;
  /**
   * ISO-8601 of the provider-side modification time observed when the
   * item failed. Used purely for diagnostics — the retry path fetches
   * by id, not by timestamp.
   */
  remoteModifiedAt: string | null;
  /** How many consecutive sync passes this item has failed. */
  failureCount: number;
}

/**
 * Retries are abandoned after this many consecutive failures for the
 * same item. The runtime cost of retrying is one API call per failed
 * item per sync, so even a very loose cap stays cheap; the cap exists
 * to make sure perma-broken items don't accumulate forever.
 */
export const FAILED_RETRY_MAX_ATTEMPTS = 5;

/**
 * Parse an ISO-8601 timestamp into a UTC epoch-millis value suitable
 * for `<` / `>` / `<=` comparison between syncs.
 *
 * The connectors used to rely on lexicographic string comparison of
 * `last_modified` / `last_edited_time` against the persisted
 * watermark. That works *only* if every value the provider returns
 * uses the identical timezone suffix and the identical sub-second
 * precision — e.g. `2024-06-01T12:00:00Z` is lexicographically less
 * than `2024-06-01T12:00:00.001Z` but greater than
 * `2024-06-01T12:00:00+00:00`. Figma and Notion currently happen to
 * return a stable shape, but the comparison is a footgun for any
 * future provider (Atlassian already mixes both forms in different
 * endpoints) and a Devin Review wave 7 finding flagged it as fragile.
 *
 * Returning `null` (rather than throwing) for unparsable input lets
 * callers fall back to the same behaviour they had before this fix:
 * the watermark scan skips the unparsable value, the unfiltered
 * scan keeps it.
 */
export function parseWatermarkIso(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * `true` iff `candidate` is *strictly* newer than `watermark`. A
 * `null`/unparsable `watermark` means "no previous sync, accept
 * everything"; a `null`/unparsable `candidate` is treated as
 * permanently skippable.
 */
export function isAfterWatermark(
  candidate: string | null | undefined,
  watermark: string | null | undefined,
): boolean {
  const c = parseWatermarkIso(candidate);
  if (c === null) return false;
  const w = parseWatermarkIso(watermark);
  if (w === null) return true;
  return c > w;
}

/**
 * Return whichever of `a` / `b` is the later timestamp. `null` /
 * unparsable inputs are treated as `-Infinity`. The return value is
 * the original ISO-8601 string (not the epoch ms) so the watermark
 * we persist preserves whatever precision/timezone the provider gave
 * us — important for diagnostics and for verbatim "last sync" UI
 * surfaces.
 */
export function maxWatermark(
  a: string | null | undefined,
  b: string | null | undefined,
): string | null {
  const am = parseWatermarkIso(a);
  const bm = parseWatermarkIso(b);
  if (am === null && bm === null) return null;
  if (am === null) return b ?? null;
  if (bm === null) return a ?? null;
  return am >= bm ? (a ?? null) : (b ?? null);
}

/**
 * Compute the next-sync retry queue from the previous queue plus the
 * outcome of this sync pass:
 *   - `attempted`  — items the previous queue asked us to retry.
 *   - `succeeded`  — items that were synced successfully this pass
 *                    (regardless of whether they came from the queue
 *                     or the normal watermark scan).
 *   - `failed`     — items that errored on this pass.
 *
 * The result is bounded by `FAILED_RETRY_QUEUE_MAX` (FIFO eviction)
 * and excludes items whose `failureCount` has hit
 * `FAILED_RETRY_MAX_ATTEMPTS`.
 */
export function nextFailedRetryQueue(
  previous: FailedRetryEntry[],
  events: {
    succeeded: Iterable<string>;
    failed: Iterable<{ remoteId: string; remoteModifiedAt: string | null }>;
  },
): FailedRetryEntry[] {
  const succeeded = new Set(events.succeeded);
  const prevById = new Map<string, FailedRetryEntry>();
  for (const e of previous) prevById.set(e.remoteId, e);

  // Drop succeeded items from the carry-forward; they've been
  // re-synced and don't need retrying.
  for (const id of succeeded) prevById.delete(id);

  // Bump or insert each failed item.
  for (const f of events.failed) {
    const existing = prevById.get(f.remoteId);
    const next: FailedRetryEntry = existing
      ? {
          remoteId: f.remoteId,
          remoteModifiedAt: f.remoteModifiedAt ?? existing.remoteModifiedAt,
          failureCount: existing.failureCount + 1,
        }
      : {
          remoteId: f.remoteId,
          remoteModifiedAt: f.remoteModifiedAt,
          failureCount: 1,
        };
    if (next.failureCount > FAILED_RETRY_MAX_ATTEMPTS) {
      // Give up on this item; remove from the queue rather than
      // pinging it forever.
      prevById.delete(f.remoteId);
      continue;
    }
    // Re-inserting moves the entry to the end so FIFO eviction below
    // drops the oldest perma-failing ids first.
    prevById.delete(f.remoteId);
    prevById.set(f.remoteId, next);
  }

  const entries = Array.from(prevById.values());
  if (entries.length <= FAILED_RETRY_QUEUE_MAX) return entries;
  return entries.slice(entries.length - FAILED_RETRY_QUEUE_MAX);
}
