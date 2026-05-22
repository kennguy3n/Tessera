/**
 * Confluence connector sync logic (Task 4).
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
  purgeSyncDir,
  readManifest,
  sanitiseRemoteId,
  syncDirFor,
  writeManifest,
  type SyncManifestEntry,
} from "./syncDir";

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
   * `version.number` increments on every edit, including non-content
   * changes like title renames. It is the only monotonically
   * increasing per-page integer exposed by the v2 list endpoint, so
   * we use it as the incremental-sync watermark.
   */
  version?: { number?: number };
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
 * no information about the page's current state). See Devin Review
 * wave 9 ANALYSIS_0004.
 */
type PageSpaceMap = Record<string, string>;

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
   * files (pre-wave-9) lack this field; loaded entries without a
   * recorded space id are treated as "unknown" and always carried
   * forward, which is the safe default while the state self-heals
   * over subsequent successful syncs.
   */
  pageSpaces: PageSpaceMap;
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
    };
  } catch {
    return { cloudId: null, pageVersions: {}, pageSpaces: {} };
  }
}

async function saveState(userDataDir: string, s: ConfluenceState): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "confluence"), { recursive: true });
  await fsp.writeFile(statePath(userDataDir), JSON.stringify(s), "utf8");
}

export async function syncConfluence(ctx: {
  accessToken: string;
  userDataDir: string;
  bridge: ConfluenceBridgeHooks;
  cloudId?: string | null;
}): Promise<ConfluenceSyncResult> {
  const dir = syncDirFor(ctx.userDataDir, "confluence");
  await fsp.mkdir(dir, { recursive: true });

  const state = await loadState(ctx.userDataDir);
  let cloudId = ctx.cloudId ?? state.cloudId;
  if (!cloudId) {
    const resources = await listAccessibleResources(ctx.accessToken);
    const resource =
      resources.find((r) => r.scopes.some((s) => s.includes("confluence"))) ??
      resources[0];
    if (!resource) {
      throw new Error("No Atlassian sites accessible to Confluence");
    }
    cloudId = resource.id;
  }

  const spaces = await listAllSpaces(cloudId, ctx.accessToken);
  const manifest = await readManifest(ctx.userDataDir, "confluence");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) entriesById.set(e.remoteId, e);

  let added = 0;
  let modified = 0;
  let removed = 0;
  // Tracks the pages and spaces actually observed during this pass.
  // After the iteration completes the finally block consults these
  // sets to decide — for each entry already in `state.pageVersions`
  // that we did NOT see this pass — whether to drop it (its space
  // listed successfully, page is gone) or carry it forward (its space
  // failed to list, we know nothing new about the page).
  //
  // We intentionally do NOT seed `nextVersions` from `state.pageVersions`
  // up front: that would prevent us from distinguishing "saw and
  // still alive" from "didn't see at all", and would re-introduce the
  // dangling-version concern noted in wave 7. The carry-forward step
  // runs in the finally block, AFTER iteration, with the explicit
  // success/observation context. See Devin Review wave 9 ANALYSIS_0004.
  const nextVersions: PageVersionMap = {};
  const nextPageSpaces: PageSpaceMap = {};
  const successfullyListedSpaceIds = new Set<string>();

  // Wrap the iteration + save in try/finally so progress is *always*
  // persisted before the function returns or rethrows. Without this,
  // an unexpected error anywhere inside the loops (`listPagesInSpace`
  // rejecting after partial iteration, a bridge-layer crash, a future
  // code path that forgets a try/catch) would skip `saveState` and
  // `writeManifest` entirely — making every page successfully fetched
  // in this pass invisible to the next sync. Mirrors the
  // defense-in-depth pattern in figma.ts. See Devin Review wave 7
  // ANALYSIS_0002 (architectural consistency).
  //
  // NOTE: Confluence intentionally does NOT need a separate failed-
  // retry queue like Notion/Jira/Figma. Its incremental algorithm uses
  // per-page `version.number` rather than a single global watermark:
  // when a page fetch/write fails, we simply skip the
  // `nextVersions[page.id] = currentVersion` assignment for that page.
  // On the next sync `previousVersion` for that page remains stale and
  // `currentVersion > previousVersion` triggers a natural retry via
  // the same code path that handles fresh edits. No separate queue is
  // required because there is no "watermark advances past failed
  // item" failure mode here. See Devin Review wave 7 ANALYSIS_0002.
  try {
    for (const space of spaces) {
      let pages: ConfluencePage[];
      try {
        pages = await listPagesInSpace(cloudId, ctx.accessToken, space.id);
      } catch {
        // Failed to list pages in this space — skip it. The next sync
        // will re-list. Other spaces still process normally.
        // Crucially we do NOT mark this space as successfully listed,
        // so the post-loop carry-forward in the finally block keeps
        // every previously-known page in this space alive in state.
        // Without that, the next sync would re-fetch and re-render
        // every page in the affected space from scratch — expensive
        // for large workspaces and unnecessary because the page
        // contents haven't actually changed. See Devin Review wave 9
        // ANALYSIS_0004.
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

        const body = renderPage(page, space);
        const localPath = path.join(dir, `${sanitiseRemoteId(page.id)}.md`);
        try {
          await fsp.writeFile(localPath, body, "utf8");
        } catch {
          // Disk write failed (permission, ENOSPC, etc.) — do NOT
          // advance `nextVersions[page.id]`, so the next sync sees the
          // page as still-changed and naturally retries it. This is
          // the Confluence equivalent of pushing to `failedThisPass`
          // in the watermark-based connectors.
          continue;
        }

        const existing = ctx.bridge
          .listSources()
          .find((s) => s.path === localPath);
        if (existing) {
          try {
            ctx.bridge.reindexSource(existing.id);
          } catch {
            // best-effort
          }
          modified += 1;
        } else {
          try {
            ctx.bridge.addLocalFile(localPath);
          } catch {
            // Same reasoning as the writeFile catch above — leave
            // `nextVersions[page.id]` unset so we retry naturally.
            continue;
          }
          added += 1;
        }
        entriesById.set(page.id, {
          localPath,
          remoteId: page.id,
          // Persist the version number as the remote modification
          // identifier so the manifest mirrors what the watermark uses.
          remoteModifiedAt: currentVersion > 0 ? String(currentVersion) : null,
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
    // (legacy state pre-wave-9, or pages whose space we never had
    // a record for) are carried forward as a safe default — they
    // will self-heal as soon as their space lists successfully and
    // we either re-observe them (setting nextPageSpaces) or confirm
    // their deletion. See Devin Review wave 9 ANALYSIS_0004.
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
        //      always returned `removed: 0` even after deletions). See
        //      Devin Review wave 11 ANALYSIS_0005 (🚩, confluence.ts:336).
        const manifestEntry = entriesById.get(pageId);
        if (manifestEntry) {
          const existingSource = ctx.bridge
            .listSources()
            .find((s) => s.path === manifestEntry.localPath);
          if (existingSource) {
            try {
              ctx.bridge.removeSource(existingSource.id);
            } catch {
              // best-effort
            }
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
    await saveState(ctx.userDataDir, {
      cloudId,
      pageVersions: nextVersions,
      pageSpaces: nextPageSpaces,
    });
    await writeManifest(ctx.userDataDir, {
      version: 1,
      provider: "confluence",
      entries: Array.from(entriesById.values()),
    });
  }

  return { added, modified, removed, status: "synced" };
}

export async function disconnectConfluence(
  userDataDir: string,
  bridge: ConfluenceBridgeHooks,
): Promise<void> {
  const manifest = await readManifest(userDataDir, "confluence");
  const localPaths = new Set(manifest.entries.map((e) => e.localPath));
  for (const source of bridge.listSources()) {
    if (localPaths.has(source.path)) {
      try {
        bridge.removeSource(source.id);
      } catch {
        // best-effort
      }
    }
  }
  await purgeSyncDir(userDataDir, "confluence");
}

export const __test = { storageToText };
