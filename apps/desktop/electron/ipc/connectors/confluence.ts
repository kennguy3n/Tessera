/**
 * Confluence connector sync logic.
 *
 * Authentication: Atlassian OAuth 2.0 — same authorize/token URLs
 * as Jira; scopes differ.
 *
 * Sync model: list all spaces via `/wiki/api/v2/spaces`, then iterate
 * each space's pages via `/wiki/api/v2/pages?space-id=...`. For each
 * page we fetch its body in `storage` format (Atlassian's XHTML),
 * strip tags to plain text + Markdown-ish headings, and write to
 * `<userData>/confluence-sync/<page-id>.md`.
 *
 * Incremental sync uses the page's `version.number` as a monotonic
 * watermark. The Confluence v2 list endpoint sorts by
 * `-modified-date` but does not expose a last-modified timestamp on
 * the list response payload — only `createdAt` (immutable) and
 * `version.number` (monotonically increasing on every edit). We
 * persist the per-page version number we last indexed and skip pages
 * whose current version matches. This is the correct fix for the
 * earlier bug where `createdAt` was compared against a single global
 * watermark, causing every edit to existing pages to be silently
 * dropped after the first full sync.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import {
  FAILED_RETRY_MAX_ATTEMPTS,
  purgeSyncDir,
  readManifest,
  resolveAccessToken,
  sanitiseRemoteId,
  SourcePathIndex,
  syncDirFor,
  writeManifest,
  type SyncManifestEntry,
} from "./syncDir";
import { isNetworkError } from "./networkErrors";

const ATLASSIAN_API = "https://api.atlassian.com";
const PAGE_LIMIT = 50;

export interface ConfluenceSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

interface ConfluenceResource {
  id: string;
  scopes: string[];
  name: string;
  url: string;
}

interface ConfluenceSpace {
  id: string;
  key: string;
  name: string;
  type?: string;
}

interface ConfluencePage {
  id: string;
  status?: string;
  title: string;
  spaceId: string;
  /**
   * `number` is the monotonic edit counter — increments on every
   * edit including non-content changes like title renames, and is the
   * only monotonically increasing per-page integer the v2 list
   * endpoint exposes. We use it as the incremental-sync watermark.
   *
   * `createdAt` is the ISO-8601 timestamp of when this version was
   * created — i.e. the page's last-modified time. The v2 list
   * endpoint returns both on every page; we persist `createdAt` as
   * the manifest's `remoteModifiedAt` so it carries the same
   * semantics (real ISO timestamp) as every other connector's
   * manifest entry.
   */
  version?: { number?: number; createdAt?: string };
  body?: { storage?: { value?: string }; representation?: string };
  /** Immutable creation timestamp — NOT used for incremental sync. */
  createdAt?: string;
  ownerId?: string;
}

/**
 * Per-page version snapshot persisted between syncs. Stored alongside
 * the manifest in `state.json`. The map is keyed by Confluence page
 * id and tracks the highest `version.number` we have ever indexed
 * for that page. A page whose current version <= the recorded value
 * is skipped.
 */
type PageVersionMap = Record<string, number>;

interface PagesResponse {
  results: ConfluencePage[];
  _links?: { next?: string };
}

interface SpacesResponse {
  results: ConfluenceSpace[];
  _links?: { next?: string };
}

async function listAccessibleResources(
  accessToken: string,
): Promise<ConfluenceResource[]> {
  const resp = await fetch(`${ATLASSIAN_API}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Confluence accessible-resources failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as ConfluenceResource[];
}

async function listAllSpaces(
  cloudId: string,
  accessToken: string,
): Promise<ConfluenceSpace[]> {
  const spaces: ConfluenceSpace[] = [];
  let url: string | undefined = `${ATLASSIAN_API}/ex/confluence/${cloudId}/wiki/api/v2/spaces?limit=${PAGE_LIMIT}`;
  while (url) {
    const resp: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Confluence spaces list failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
      );
    }
    const data = (await resp.json()) as SpacesResponse;
    spaces.push(...data.results);
    // v2 pagination: `_links.next` is a *relative* path; prepend
    // the cloud-id-anchored base. When missing, the loop ends.
    if (data._links?.next) {
      url = `${ATLASSIAN_API}/ex/confluence/${cloudId}${data._links.next}`;
    } else {
      url = undefined;
    }
  }
  return spaces;
}

/**
 * Page through every page in a space. We deliberately do NOT
 * short-circuit pagination based on the previous sync's watermark
 * — the v2 list endpoint sorts by `-modified-date` but the
 * payload does not surface the modification timestamp, only the
 * version number. Because we don't know how many pages have changed
 * since the last sync, we have to walk the whole list. Filtering by
 * version vs the persisted `PageVersionMap` happens in the caller:
 * pages whose `version.number` is unchanged are dropped without
 * re-rendering their body.
 *
 * For very large Confluence instances this could be made smarter by
 * walking only until we hit `PAGE_LIMIT` consecutive unchanged
 * pages, but that optimisation requires confidence that the v2
 * sort is stable and total-ordered — which the documentation does
 * not guarantee. The current implementation is correct (no missed
 * edits) and pays the cost of one extra list call per space per
 * sync, which is bounded by the user's catalog and well within
 * Atlassian's rate-limits.
 */
async function listPagesInSpace(
  cloudId: string,
  accessToken: string,
  spaceId: string,
): Promise<ConfluencePage[]> {
  const pages: ConfluencePage[] = [];
  const base = new URL(
    `${ATLASSIAN_API}/ex/confluence/${cloudId}/wiki/api/v2/pages`,
  );
  base.searchParams.set("space-id", spaceId);
  base.searchParams.set("limit", String(PAGE_LIMIT));
  base.searchParams.set("body-format", "storage");
  base.searchParams.set("sort", "-modified-date");

  let url: string | undefined = base.toString();
  while (url) {
    const resp: Response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Confluence pages list failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
      );
    }
    const data = (await resp.json()) as PagesResponse;
    pages.push(...data.results);
    if (data._links?.next) {
      url = `${ATLASSIAN_API}/ex/confluence/${cloudId}${data._links.next}`;
    } else {
      url = undefined;
    }
  }
  return pages;
}

/**
 * Strip Confluence storage-format XHTML into plain text.
 *
 * We do NOT pull in a full HTML parser dependency for this — the
 * storage format is small, well-formed XHTML and the index only
 * needs readable text, not perfect structure. A pragmatic
 * tag-stripping pass produces good-enough chunks for retrieval.
 */
function storageToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-6]|li|tr|td|th|div|section|article)>/gi, "\n")
    .replace(/<(h1|h2|h3|h4|h5|h6)[^>]*>/gi, (_m, tag: string) => {
      const n = Number(tag[1]);
      return `\n${"#".repeat(n)} `;
    })
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderPage(page: ConfluencePage, space: ConfluenceSpace): string {
  const lines: string[] = [
    `# ${page.title}`,
    "",
    `- Space: ${space.name} (${space.key})`,
    `- Page id: ${page.id}`,
    `- Version: ${page.version?.number ?? "—"}`,
    "",
  ];
  const html = page.body?.storage?.value ?? "";
  if (html.length > 0) {
    lines.push(storageToText(html));
  } else {
    lines.push("_(empty page)_");
  }
  return lines.join("\n");
}

export interface ConfluenceBridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

/**
 * Reverse lookup from page id to the space it lives in, persisted
 * across syncs. Required so the next sync's carry-forward logic can
 * decide — for any previously-seen page that was *not* observed this
 * pass — whether it should be dropped (its space listed successfully
 * and the page is gone) or kept (its space failed to list and we have
 * no information about the page's current state).
 */
type PageSpaceMap = Record<string, string>;

/**
 * Per-page write-failure attempt counter, keyed by page id. The
 * `version` field disambiguates a page that fails repeatedly at the
 * same version (genuinely broken — retry budget should deplete) from
 * a page whose remote `version.number` advances between attempts (a
 * fresh edit upstream — retry budget should reset). Without this
 * field, a single permanently-failing page could mask subsequent
 * recovery: e.g. the user fixes the antivirus rule that was locking
 * the file, Confluence advances the version, and we should let the
 * page through again without the count clamping it forever. See
 * `FAILED_RETRY_MAX_ATTEMPTS` and the failure-cap regression test
 * in `connectorsSync.test.ts` for the contract this field encodes.
 */
interface FailedWriteEntry {
  /**
   * The remote `version.number` we keep failing to write. If the
   * page advances to a newer version upstream, this entry is
   * superseded and `attempts` resets to 1.
   */
  version: number;
  /**
   * How many times in a row we have failed to write/index this page
   * at `version`. Capped at `FAILED_RETRY_MAX_ATTEMPTS` — once we
   * reach that, the sync advances `pageVersions[page.id]` to the
   * failing version and stops retrying until either (a) the user
   * deletes the connector state, or (b) the upstream version
   * advances and resets the counter.
   */
  attempts: number;
}
type FailedWriteMap = Record<string, FailedWriteEntry>;

interface ConfluenceState {
  cloudId: string | null;
  /**
   * Per-page version snapshot from the previous sync. Pages whose
   * current `version.number` matches the recorded value are skipped.
   */
  pageVersions: PageVersionMap;
  /**
   * Per-page space id, used for the carry-forward decision when a
   * space's pages listing fails on the current pass. Legacy state
   * files (predating this field) lack it; loaded entries without a
   * recorded space id are treated as "unknown" and always carried
   * forward, which is the safe default while the state self-heals
   * over subsequent successful syncs.
   */
  pageSpaces: PageSpaceMap;
  /**
   * Pages we have failed to write to disk or register with the
   * bridge. Bounded by `FAILED_RETRY_MAX_ATTEMPTS` per page so a
   * permanently-failing page (filesystem permission, antivirus lock,
   * path collides with a directory, etc.) eventually stops burning
   * one API call per sync forever. Prior to this field, the
   * version-keyed retry contract had no cap and would keep
   * re-fetching such pages indefinitely.
   *
   * Legacy state files predating this field load as `{}`, which is
   * the correct "no failures recorded yet" default and lets the cap
   * engage on the very next failure.
   */
  failedWrites: FailedWriteMap;
}

function statePath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "confluence"), "state.json");
}

async function loadState(userDataDir: string): Promise<ConfluenceState> {
  try {
    const raw = await fsp.readFile(statePath(userDataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<ConfluenceState> & {
      // Legacy field from the pre-fix watermark scheme; harmlessly
      // dropped on the next save.
      lastSyncIso?: string | null;
    };
    return {
      cloudId: parsed.cloudId ?? null,
      pageVersions: parsed.pageVersions ?? {},
      pageSpaces: parsed.pageSpaces ?? {},
      // Defensive sanitisation: if a corrupted state.json has a
      // non-object or array-shaped `failedWrites`, drop it rather than
      // letting bad data feed into the retry-cap arithmetic below.
      // Same posture as the `pageSpaces` default — unknown entries
      // reset to the safe "no failures recorded" baseline which lets
      // the cap engage cleanly on the next failed write.
      failedWrites:
        parsed.failedWrites &&
        typeof parsed.failedWrites === "object" &&
        !Array.isArray(parsed.failedWrites)
          ? (parsed.failedWrites as FailedWriteMap)
          : {},
    };
  } catch {
    return {
      cloudId: null,
      pageVersions: {},
      pageSpaces: {},
      failedWrites: {},
    };
  }
}

async function saveState(userDataDir: string, s: ConfluenceState): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "confluence"), { recursive: true });
  await fsp.writeFile(statePath(userDataDir), JSON.stringify(s), "utf8");
}

export async function syncConfluence(ctx: {
  accessToken: string;
  /** Just-in-time refresh hook — called per space and per page so a
   *  large-tenant scan does NOT outlive the access token. */
  getAccessToken?: () => Promise<string>;
  userDataDir: string;
  bridge: ConfluenceBridgeHooks;
  cloudId?: string | null;
}): Promise<ConfluenceSyncResult> {
  const dir = syncDirFor(ctx.userDataDir, "confluence");
  await fsp.mkdir(dir, { recursive: true });

  const state = await loadState(ctx.userDataDir);
  let cloudId = ctx.cloudId ?? state.cloudId;
  if (!cloudId) {
    // Mirror the Jira fix: route accessible-resources through the
    // same JIT refresh chokepoint as the rest of the connector
    // instead of bypassing it via `ctx.accessToken`. The Confluence
    // sync was the only remaining caller in this file using the
    // static token, which made it the lone exception to the pattern
    // every other API call follows.
    const resources = await listAccessibleResources(
      await resolveAccessToken(ctx),
    );
    const resource =
      resources.find((r) => r.scopes.some((s) => s.includes("confluence"))) ??
      resources[0];
    if (!resource) {
      throw new Error("No Atlassian sites accessible to Confluence");
    }
    cloudId = resource.id;
  }

  const spaces = await listAllSpaces(cloudId, await resolveAccessToken(ctx));
  const manifest = await readManifest(ctx.userDataDir, "confluence");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) entriesById.set(e.remoteId, e);

  // Materialise the bridge's source-by-path index ONCE per sync pass
  // instead of paying `O(pages × sources)` for the per-iteration
  // `bridge.listSources().find(...)` check. The cache stays coherent
  // with the bridge as we add (via `addLocalFile`) and remove (via
  // the deletion-cascade) sources during the pass.
  // "Confluence per-page loop calls
  // bridge.listSources() on every iteration".
  // Declared `let` and assigned inside the try block below so a
  // `bridge.listSources()` throw at the top of the sync is still
  // caught by the saveState + writeManifest cleanup path (defense-
  // in-depth contract mirrored from figma.ts; the `!` definite-
  // assignment assertion is safe because every code path that reads
  // `sourceIndex` is inside the try block, after the assignment).
  let sourceIndex!: SourcePathIndex;

  let added = 0;
  let modified = 0;
  let removed = 0;
  // Tracks the pages and spaces actually observed during this pass.
  // After the iteration completes the finally block consults these
  // sets to decide — for each entry already in `state.pageVersions`
  // that we did NOT see this pass — whether to drop it (its space
  // listed successfully, page is gone) or carry it forward (its space
  // failed to list, we know nothing new about the page).
  // We intentionally do NOT seed `nextVersions` from `state.pageVersions`
  // up front: that would prevent us from distinguishing "saw and
  // still alive" from "didn't see at all", and would re-introduce a
  // dangling-version concern (entries kept alive without observation).
  // The carry-forward step runs in the finally block, AFTER
  // iteration, with the explicit success/observation context.
  const nextVersions: PageVersionMap = {};
  const nextPageSpaces: PageSpaceMap = {};
  // Fresh per-pass map: any page id NOT explicitly carried into
  // `nextFailedWrites` during this pass naturally drops from the
  // retry budget on save. That keeps the contract simple — a
  // successful write is implicitly a "reset to zero" because the
  // pageId never makes it into the new map.
  const nextFailedWrites: FailedWriteMap = {};
  const successfullyListedSpaceIds = new Set<string>();

  // Wrap the iteration + save in try/finally so progress is *always*
  // persisted before the function returns or rethrows. Without this,
  // an unexpected error anywhere inside the loops (`listPagesInSpace`
  // rejecting after partial iteration, a bridge-layer crash, a future
  // code path that forgets a try/catch) would skip `saveState` and
  // `writeManifest` entirely — making every page successfully fetched
  // in this pass invisible to the next sync. Mirrors the
  // defense-in-depth pattern in figma.ts.
  // NOTE: Confluence intentionally does NOT need a separate failed-
  // retry queue like Notion/Jira/Figma. Its incremental algorithm uses
  // per-page `version.number` rather than a single global watermark:
  // when a page fetch/write fails, we simply skip the
  // `nextVersions[page.id] = currentVersion` assignment for that page.
  // On the next sync `previousVersion` for that page remains stale and
  // `currentVersion > previousVersion` triggers a natural retry via
  // the same code path that handles fresh edits. No separate queue is
  // required because there is no "watermark advances past failed
  // item" failure mode here.
  try {
    // Materialise the source-by-path index inside the try block so an
    // unlikely `bridge.listSources()` throw is still caught by the
    // saveState + writeManifest cleanup below (defense-in-depth
    // contract; the listSources-throw regression test in
    // `connectorsSync.test.ts` locks this in).
    sourceIndex = SourcePathIndex.fromBridge(ctx.bridge);
    for (const space of spaces) {
      let pages: ConfluencePage[];
      try {
        // Refresh-on-demand per space. A tenant with hundreds of
        // spaces can take tens of minutes to walk; without this, all
        // calls after the access token expires fail with 401.
        const accessToken = await resolveAccessToken(ctx);
        pages = await listPagesInSpace(cloudId, accessToken, space.id);
      } catch (err) {
        // NetworkError must NOT be swallowed here. If the user's
        // wifi drops between the initial accessible-resources call
        // and this per-space iteration, every remaining space would
        // silently `continue` and the function would return
        // `{ status: 'synced', added: 0, ... }` instead of the
        // correct `{ status: 'offline' }`. The runConnectorSync
        // outer catch at `handlers.ts:476` is the single owner of
        // network-error→offline translation; let it do its job.
        // Non-network errors (API-level 5xx, listing API removed a
        // space we still have in state, etc.) keep the per-space
        // skip behaviour described below.
        if (isNetworkError(err)) throw err;
        // Failed to list pages in this space — skip it. The next sync
        // will re-list. Other spaces still process normally.
        // Crucially we do NOT mark this space as successfully listed,
        // so the post-loop carry-forward in the finally block keeps
        // every previously-known page in this space alive in state.
        // Without that, the next sync would re-fetch and re-render
        // every page in the affected space from scratch — expensive
        // for large workspaces and unnecessary because the page
        // contents haven't actually changed.
        continue;
      }
      successfullyListedSpaceIds.add(space.id);
      for (const page of pages) {
        const currentVersion = page.version?.number ?? 0;
        const previousVersion = state.pageVersions[page.id] ?? 0;
        // Skip unchanged pages — their local file and source index
        // entry are already up-to-date from the previous sync. We
        // still record the version into `nextVersions` so the
        // watermark survives.
        if (
          currentVersion > 0 &&
          currentVersion === previousVersion &&
          entriesById.has(page.id)
        ) {
          nextVersions[page.id] = currentVersion;
          nextPageSpaces[page.id] = space.id;
          continue;
        }

        // Retry-budget check. If this page has already failed
        // `FAILED_RETRY_MAX_ATTEMPTS` times AT THE CURRENT REMOTE
        // VERSION, give up: advance `nextVersions[page.id]` to the
        // failing version so future syncs treat the page as "caught
        // up" (i.e. won't re-render the body or re-attempt the disk
        // write) until upstream Confluence advances the version
        // again. Without this gate, a permanently-broken page would
        // burn one API call per sync indefinitely.
        // The version-keyed comparison is important: if the page has
        // moved to a newer version upstream (`prior.version !==
        // currentVersion`), that is fresh content and the retry
        // counter should reset — we re-enter the write path below
        // and the new attempt starts at 1 in `nextFailedWrites`.
        const prior = state.failedWrites[page.id];
        if (
          prior &&
          prior.version === currentVersion &&
          prior.attempts >= FAILED_RETRY_MAX_ATTEMPTS
        ) {
          nextVersions[page.id] = currentVersion;
          nextPageSpaces[page.id] = space.id;
          // Carry the cap forward so we keep skipping this page at
          // this version until it actually changes upstream.
          nextFailedWrites[page.id] = prior;
          continue;
        }

        // Helper used at both failure call sites (writeFile catch and
        // addLocalFile catch) so the budget arithmetic is identical
        // for both failure modes.
        const recordWriteFailure = (): void => {
          const baseAttempts =
            prior && prior.version === currentVersion ? prior.attempts : 0;
          nextFailedWrites[page.id] = {
            version: currentVersion,
            attempts: baseAttempts + 1,
          };
        };

        const body = renderPage(page, space);
        const localPath = path.join(dir, `${sanitiseRemoteId(page.id)}.md`);
        try {
          await fsp.writeFile(localPath, body, "utf8");
        } catch {
          // Disk write failed (permission, ENOSPC, etc.) — do NOT
          // advance `nextVersions[page.id]`, so the next sync sees the
          // page as still-changed and naturally retries it. This is
          // the Confluence equivalent of pushing to `failedThisPass`
          // in the watermark-based connectors. Increment the
          // version-keyed write-failure counter so the retry budget
          // depletes across syncs — once it hits MAX, the gate above
          // will short-circuit this page until upstream changes the
          // version.
          recordWriteFailure();
          continue;
        }

        const existing = sourceIndex.get(localPath);
        if (existing) {
          try {
            ctx.bridge.reindexSource(existing.id);
          } catch {
            // best-effort
          }
          modified += 1;
        } else {
          let registered: { id: string; path: string };
          try {
            registered = ctx.bridge.addLocalFile(localPath);
          } catch {
            // Same reasoning as the writeFile catch above — leave
            // `nextVersions[page.id]` unset so we retry naturally.
            // Also count this as a write failure so the retry budget
            // depletes; addLocalFile and writeFile share the same
            // cap because both must succeed to call this page
            // "indexed".
            recordWriteFailure();
            continue;
          }
          // Keep the path index coherent so a (future) duplicate page
          // arriving later in the same pass would be detected as
          // already-registered. Page ids are unique today so the
          // collision is structurally impossible, but recording the
          // add is the only thing that lets the index stay a single
          // source of truth across iterations.
          sourceIndex.add(registered);
          added += 1;
        }
        entriesById.set(page.id, {
          localPath,
          remoteId: page.id,
          // Use the actual ISO-8601 timestamp of when this page version
          // was created — i.e. the page's last-modified time, surfaced
          // by the v2 list endpoint as `version.createdAt`. This keeps
          // the manifest's `remoteModifiedAt` field semantically
          // consistent with every other connector (gdrive's
          // `modifiedTime`, notion's `last_edited_time`, onedrive's
          // `lastModifiedDateTime`, jira's `fields.updated`, figma's
          // `last_modified_at`) instead of the prior shape which
          // stringified the version integer (`"1"`, `"2"`, ...) and
          // would parse as `NaN` through `parseWatermarkIso`.
          // The version-as-watermark contract is preserved entirely by
          // `state.pageVersions[page.id]` above; the manifest's
          // `remoteModifiedAt` is purely metadata for diagnostics and
          // cross-connector tooling that might read manifests
          // uniformly. Falling back to `null` (rather than
          // `String(version.number)`) is the conservative default
          // when the API ever omits `createdAt` for a page (this
          // matches the manifest-entry construction immediately
          // above).
          remoteModifiedAt: page.version?.createdAt ?? null,
        });
        nextVersions[page.id] = currentVersion;
        nextPageSpaces[page.id] = space.id;
      }
    }
  } finally {
    // Carry forward previously-known pages whose space did NOT list
    // successfully this pass. For pages whose space listed but were
    // not returned (genuine deletions) we leave the entry out so
    // state self-prunes. Pages whose recorded space is unknown
    // (legacy state predating the pageSpaces field, or pages whose
    // space we never had a record for) are carried forward as a safe
    // default — they
    // will self-heal as soon as their space lists successfully and
    // we either re-observe them (setting nextPageSpaces) or confirm
    // their deletion.
    for (const [pageId, prevVersion] of Object.entries(state.pageVersions)) {
      if (pageId in nextVersions) continue;
      const recordedSpace = state.pageSpaces[pageId];
      if (recordedSpace && successfullyListedSpaceIds.has(recordedSpace)) {
        // Space listed cleanly, page not in results — the page was
        // deleted (or moved out of the integration's scope) on the
        // Confluence side. Cascade the deletion into the local
        // workspace so search results don't keep returning content
        // that no longer exists upstream:
        //   1. Drop the version-state entry (already implicit via the
        //      missing `nextVersions[pageId]` assignment).
        //   2. Remove the manifest entry so the next sync's seed of
        //      `entriesById` doesn't reintroduce it.
        //   3. Unregister the local file from the bridge's source
        //      index so it stops appearing in search.
        //   4. Unlink the on-disk file so it doesn't linger in the
        //      `confluence-sync/` directory forever.
        //   5. Increment `removed` so the IPC return value
        //      surfaces the deletion to the renderer status panel
        //      (matches OneDrive's contract; previously Confluence
        //      always returned `removed: 0` even after deletions).
        const manifestEntry = entriesById.get(pageId);
        if (manifestEntry) {
          const existingSource = sourceIndex.get(manifestEntry.localPath);
          if (existingSource) {
            try {
              ctx.bridge.removeSource(existingSource.id);
            } catch {
              // best-effort
            }
            sourceIndex.remove(manifestEntry.localPath);
          }
          try {
            await fsp.unlink(manifestEntry.localPath);
          } catch {
            // already gone
          }
          entriesById.delete(pageId);
          removed += 1;
        }
        continue;
      }
      nextVersions[pageId] = prevVersion;
      if (recordedSpace) nextPageSpaces[pageId] = recordedSpace;
    }
    // Persist progress in a nested try/catch so a state-write error
    // (e.g. disk full, sync dir suddenly read-only) doesn't shadow the
    // original error the try block raised. The whole point of running
    // this in `finally` is best-effort progress save; if it fails the
    // caller still needs to see the *original* upstream error (network
    // failure, auth expiry, etc.), not a derived "ENOSPC" from the
    // recovery step.
    try {
      await saveState(ctx.userDataDir, {
        cloudId,
        pageVersions: nextVersions,
        pageSpaces: nextPageSpaces,
        // `nextFailedWrites` is fresh per pass: any pageId not
        // explicitly carried into it (either via a fresh failure this
        // pass, or because the prior cap is still in effect at the
        // same version) naturally drops. A successful write is
        // implicitly a "reset to zero" because the pageId never made
        // it into the new map.
        failedWrites: nextFailedWrites,
      });
      await writeManifest(ctx.userDataDir, {
        version: 1,
        provider: "confluence",
        entries: Array.from(entriesById.values()),
      });
    } catch {
      // best-effort — original error (if any) is preserved
    }
  }

  return { added, modified, removed, status: "synced" };
}

// See the doc comment on `disconnectGoogleDrive` for the rationale
// behind returning `filesRemoved` (count of bridge sources actually
// removed, not the manifest length) so the calling IPC handler can
// include the count in the `ConnectorDisconnected` audit event.
export async function disconnectConfluence(
  userDataDir: string,
  bridge: ConfluenceBridgeHooks,
): Promise<{ filesRemoved: number }> {
  const manifest = await readManifest(userDataDir, "confluence");
  const localPaths = new Set(manifest.entries.map((e) => e.localPath));
  let filesRemoved = 0;
  for (const source of bridge.listSources()) {
    if (localPaths.has(source.path)) {
      try {
        bridge.removeSource(source.id);
        filesRemoved += 1;
      } catch {
        // best-effort
      }
    }
  }
  await purgeSyncDir(userDataDir, "confluence");
  return { filesRemoved };
}

export const __test = { storageToText };
