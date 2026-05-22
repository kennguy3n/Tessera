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

/**
 * Shape of the access-token source every connector accepts in its
 * sync context. The static `accessToken` field is the initial value
 * resolved by `runConnectorSync` *before* the rate-limit budget is
 * spent (so a `NotConnectedError` short-circuits without burning the
 * 30s budget); the optional `getAccessToken` callback is the
 * just-in-time refresh hook the production wiring threads through
 * from `handlers.ts > getValidAccessToken`. Test code that doesn't
 * care about mid-sync refresh can omit the callback entirely and the
 * helper below falls back to the static value — see
 * `resolveAccessToken` for the precedence rule.
 *
 * The reason for accepting BOTH instead of only the callback is twofold:
 *
 *   1. The very first fetch in each connector (the `listAccessibleResources`,
 *      `me`, `/v1/me`, etc.) happens before we have any reason to
 *      believe the cached token will expire. Forcing every test to
 *      construct a callback for that single fetch adds a lot of
 *      ceremony for zero correctness benefit.
 *   2. The bug surface this refactor closes (gdrive 401s after
 *      1h syncs) only manifests inside the per-item hot loop. That's
 *      where `resolveAccessToken` is called, and that's where the
 *      callback path is exercised.
 */
export interface AccessTokenSource {
  /** Static initial token, used by the first few setup fetches and
   *  by tests that don't supply `getAccessToken`. */
  accessToken: string;
  /** Just-in-time refresh hook called from inside hot loops so a
   *  long-running sync (>1h) does NOT outlive the OAuth token's
   *  remaining lifetime. Production wiring passes a closure over
   *  `getValidAccessToken(ctx, provider)` which transparently
   *  refreshes via the refresh token when within 60s of expiry. */
  getAccessToken?: () => Promise<string>;
}

/**
 * Returns the most up-to-date access token for the next API call.
 * Prefers the just-in-time refresh callback when present (production
 * code path), falls back to the static field when omitted (test code
 * path). This is the single chokepoint every connector's hot loop
 * calls per iteration so mid-sync token expiry is recoverable rather
 * than fatal. See `AccessTokenSource` for the rationale.
 */
export async function resolveAccessToken(
  ctx: AccessTokenSource,
): Promise<string> {
  if (ctx.getAccessToken) return await ctx.getAccessToken();
  return ctx.accessToken;
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
 * is bit-identical to the pre-suffix behaviour.
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
 * endpoints) and a
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

/**
 * Path-keyed index of the bridge's known sources, used to translate
 * each connector's hot loop from `bridge.listSources().find(...)`
 * (O(pages × sources)) to `index.get(localPath)` (O(1)).
 *
 * The bridge surfaces source metadata as a flat array; we paid that
 * cost once per *iteration* in the original implementation, which
 * meant a Confluence tenant with N pages and M existing sources did
 * N × M comparisons just to figure out which pages were already
 * registered. For modest tenants (N=100, M=100) that's 10 000
 * comparisons; for enterprise tenants (N=10 000, M=5 000) it climbs
 * to 50 million. None of those comparisons are wasted — every page
 * still needs the existence check — but they're all redundant: the
 * bridge's source list is stable across a single sync pass except
 * for the entries WE add via `addLocalFile`, which we know about.
 *
 * `SourcePathIndex` materialises the list once and then keeps itself
 * coherent as the connector mutates the source set:
 *   - `index.get(path)` returns the cached entry, or `undefined`.
 *   - `index.add(entry)` records a freshly-added source so subsequent
 *     iterations in the same sync pass see it as existing (matches
 *     the previous `listSources().find()` behaviour exactly).
 *   - `index.remove(path)` records a deletion-cascade so the same
 *     pass doesn't try to re-register the path under a stale id.
 *
 * Coherence is important: the deletion-cascade blocks in Confluence
 * and Jira walk dropped pages AFTER the main loop and then call
 * `bridge.removeSource`. If a later iteration in a future refactor
 * tried to re-add the same path, the cached entry would be stale.
 * Calling `index.remove(path)` after each `removeSource` keeps the
 * cache in sync with the bridge.
 *
 * bridge.listSources() on every iteration — O(n²) for large spaces".
 */
export interface SourceMeta {
  id: string;
  path: string;
}

export class SourcePathIndex {
  private readonly byPath: Map<string, SourceMeta>;

  private constructor(initial: ReadonlyArray<SourceMeta>) {
    this.byPath = new Map();
    for (const entry of initial) {
      // The bridge can in theory surface duplicate paths if the user
      // hand-edited the catalog; keep the *first* observed id to
      // preserve the previous `Array.prototype.find` semantics
      // (`find` returns the first match).
      if (!this.byPath.has(entry.path)) this.byPath.set(entry.path, entry);
    }
  }

  /**
   * Construct an index from the bridge's current source list.
   * Materialise this at the top of the sync function, **once per
   * sync pass**, then thread it through the hot loop instead of
   * re-calling `bridge.listSources()` per iteration.
   */
  static fromBridge(bridge: {
    listSources(): ReadonlyArray<SourceMeta>;
  }): SourcePathIndex {
    return new SourcePathIndex(bridge.listSources());
  }

  get(localPath: string): SourceMeta | undefined {
    return this.byPath.get(localPath);
  }

  /**
   * Record a source that was just registered via
   * `bridge.addLocalFile()` so the next iteration in the same sync
   * pass sees it as existing. This matches the previous
   * `listSources().find()` semantics where a freshly-added source was
   * immediately visible (the bridge updates its source list
   * synchronously during `addLocalFile`).
   */
  add(entry: SourceMeta): void {
    this.byPath.set(entry.path, entry);
  }

  /**
   * Record a source that was just dropped via
   * `bridge.removeSource()`. Used by the deletion-cascade blocks in
   * Confluence/Jira/Notion/Figma to keep the cache coherent with the
   * bridge's current view of registered sources.
   */
  remove(localPath: string): void {
    this.byPath.delete(localPath);
  }
}
