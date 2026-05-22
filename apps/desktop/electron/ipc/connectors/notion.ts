/**
 * Notion connector sync logic (Task 2).
 *
 * Authentication: OAuth 2.0 against `api.notion.com/v1/oauth/token`
 * using HTTP Basic auth (Notion's documented integration flow).
 *
 * Sync model: page through `/v1/search?filter={value:page,property:object}`
 * and `/v1/search?filter={value:database,property:object}`. For each
 * page we extract its plain-text content via the `/v1/blocks/{id}/children`
 * endpoint walking the block tree. The flattened text is written to
 * `<userData>/notion-sync/<page-id>.md` and indexed locally.
 *
 * Incremental sync is keyed off Notion's `last_edited_time` on each
 * page. We persist the maximum `last_edited_time` we've seen and skip
 * pages older than that on subsequent passes.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import {
  isAfterWatermark,
  maxWatermark,
  nextFailedRetryQueue,
  purgeSyncDir,
  readManifest,
  resolveAccessToken,
  sanitiseRemoteId,
  syncDirFor,
  writeManifest,
  type AccessTokenSource,
  type FailedRetryEntry,
  type SyncManifestEntry,
} from "./syncDir";

export interface NotionSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";
const PAGE_SIZE = 50;

interface NotionPage {
  id: string;
  last_edited_time: string;
  archived?: boolean;
  parent?: { type: string; database_id?: string; page_id?: string };
  properties?: Record<string, unknown>;
}

interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

interface SearchResponse {
  results: NotionPage[];
  next_cursor: string | null;
  has_more: boolean;
}

interface BlocksResponse {
  results: NotionBlock[];
  next_cursor: string | null;
  has_more: boolean;
}

function notionHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/**
 * Walk a block tree and join the readable text on each block into a
 * single Markdown-flavoured string. Notion's block model has dozens
 * of types; we handle the common readable ones explicitly and fall
 * back to inspecting `rich_text` so we never lose user content even
 * for newly-released block types.
 */
function blockText(block: NotionBlock): string {
  // Notion stores each block's content under a property whose key
  // matches the block's `type` field. The caller passes that key
  // explicitly so this helper can also pull from a sibling property
  // (e.g. `caption`) on block types that ship more than one
  // rich-text payload.
  const richTextOf = (key: string): string => {
    const payload = block[key] as
      | { rich_text?: Array<{ plain_text?: string }> }
      | undefined;
    if (!payload?.rich_text) return "";
    return payload.rich_text.map((rt) => rt.plain_text ?? "").join("");
  };
  switch (block.type) {
    case "paragraph":
      return richTextOf("paragraph");
    case "heading_1":
      return `# ${richTextOf("heading_1")}`;
    case "heading_2":
      return `## ${richTextOf("heading_2")}`;
    case "heading_3":
      return `### ${richTextOf("heading_3")}`;
    case "bulleted_list_item":
      return `- ${richTextOf("bulleted_list_item")}`;
    case "numbered_list_item":
      return `1. ${richTextOf("numbered_list_item")}`;
    case "to_do":
      return `- [ ] ${richTextOf("to_do")}`;
    case "quote":
      return `> ${richTextOf("quote")}`;
    case "code": {
      const payload = block.code as
        | { rich_text?: Array<{ plain_text?: string }>; language?: string }
        | undefined;
      const code = payload?.rich_text?.map((rt) => rt.plain_text ?? "").join("") ?? "";
      return `\`\`\`${payload?.language ?? ""}\n${code}\n\`\`\``;
    }
    case "callout":
      return richTextOf("callout");
    case "toggle":
      return richTextOf("toggle");
    default: {
      // Best-effort: try `rich_text` on the block's typed payload.
      const payload = block[block.type] as
        | { rich_text?: Array<{ plain_text?: string }> }
        | undefined;
      if (payload?.rich_text) {
        return payload.rich_text.map((rt) => rt.plain_text ?? "").join("");
      }
      return "";
    }
  }
}

async function fetchAllBlocks(
  blockId: string,
  accessToken: string,
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | null = null;
  for (let safety = 0; safety < 200; safety += 1) {
    const url = new URL(`${NOTION_API}/blocks/${blockId}/children`);
    url.searchParams.set("page_size", "100");
    if (cursor) url.searchParams.set("start_cursor", cursor);
    const resp = await fetch(url.toString(), { headers: notionHeaders(accessToken) });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Notion blocks fetch failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
      );
    }
    const data = (await resp.json()) as BlocksResponse;
    for (const b of data.results) {
      blocks.push(b);
      if (b.has_children) {
        try {
          const children = await fetchAllBlocks(b.id, accessToken);
          for (const c of children) blocks.push(c);
        } catch {
          // Best-effort: keep what we got rather than discarding the page.
        }
      }
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return blocks;
}

/**
 * Fetch a single page by id. Used by the failed-retry queue to
 * resurrect pages that the previous sync attempted but errored on:
 * Notion's search-index watermark would otherwise advance past them
 * (because some *other* page newer than the failed one succeeded
 * during the same pass) and the failed page would never reappear in
 * the watermark-filtered search results. A direct GET is the only
 * way to recover it without forcing the user to re-edit the page.
 */
async function fetchPageById(
  pageId: string,
  accessToken: string,
): Promise<NotionPage | null> {
  const resp = await fetch(`${NOTION_API}/pages/${pageId}`, {
    headers: notionHeaders(accessToken),
  });
  if (resp.status === 404 || resp.status === 410) return null;
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Notion page fetch failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as NotionPage;
}

async function fetchPageText(
  page: NotionPage,
  accessToken: string,
): Promise<string> {
  // Title is stored on the `title` property; the property's name
  // varies by database schema, so we walk all properties looking for
  // a `title` payload.
  const lines: string[] = [];
  for (const prop of Object.values(page.properties ?? {})) {
    const p = prop as { type?: string; title?: Array<{ plain_text?: string }> };
    if (p?.type === "title" && p.title) {
      const title = p.title.map((t) => t.plain_text ?? "").join("");
      if (title.length > 0) lines.push(`# ${title}`);
      break;
    }
  }
  const blocks = await fetchAllBlocks(page.id, accessToken);
  for (const b of blocks) {
    const text = blockText(b);
    if (text.length > 0) lines.push(text);
  }
  return lines.join("\n\n");
}

/**
 * Page through every (non-archived) page visible to the integration
 * and return the ones edited since `lastSyncIso`. We deliberately do
 * NOT short-circuit pagination based on the result ordering: Notion's
 * `/v1/search` documents `sort` as a *best-effort* hint, not a
 * guarantee. The previous implementation broke out of the scan loop
 * the first time it observed `last_edited_time <= lastSyncIso`, which
 * would silently miss any newer page that happened to be returned
 * out of order (e.g. due to eventual consistency on the search index,
 * or shard ordering for very large workspaces).
 *
 * The cost is one extra REST call per `PAGE_SIZE` block — bounded by
 * the user's workspace size — which is well within Notion's published
 * rate limits and matches what other vendors (Confluence, Atlassian,
 * Microsoft Graph) require for safe incremental sync. Correctness
 * over a marginal API saving.
 */
async function listAllPages(
  tokenSource: AccessTokenSource,
  lastSyncIso: string | null,
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let cursor: string | null = null;
  for (let safety = 0; safety < 200; safety += 1) {
    const body: Record<string, unknown> = {
      filter: { value: "page", property: "object" },
      page_size: PAGE_SIZE,
      sort: { direction: "descending", timestamp: "last_edited_time" },
    };
    if (cursor) body.start_cursor = cursor;
    // Refresh-on-demand per page — a workspace-wide search of a
    // large Notion account can paginate for many minutes. See Devin
    // Review wave 13 BUG_0001 / ANALYSIS_0007.
    const accessToken = await resolveAccessToken(tokenSource);
    const resp = await fetch(`${NOTION_API}/search`, {
      method: "POST",
      headers: notionHeaders(accessToken),
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Notion search failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
      );
    }
    const data = (await resp.json()) as SearchResponse;
    for (const p of data.results) {
      if (p.archived) continue;
      // Filter against the persisted watermark on every page, never
      // stopping the scan early. See the function-level doc comment
      // for why this is correct over the previous short-circuit.
      // `isAfterWatermark` parses both sides to epoch ms before
      // comparing — the previous lexicographic compare was a
      // footgun if Notion ever returns a mix of `Z` / `+00:00` /
      // millisecond-precision suffixes for `last_edited_time` (see
      // `parseWatermarkIso` in `syncDir.ts` and the Devin Review
      // wave 7 finding).
      if (lastSyncIso && !isAfterWatermark(p.last_edited_time, lastSyncIso)) continue;
      pages.push(p);
    }
    if (!data.has_more || !data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return pages;
}

export interface NotionBridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

interface NotionWatermark {
  lastSyncIso: string | null;
  /**
   * Items the *previous* sync pass observed but failed to fetch.
   * Carried forward so the next pass can retry them directly by id
   * — see the doc comment on `fetchPageById` and on
   * `nextFailedRetryQueue` for the bug this prevents.
   */
  failedRetries: FailedRetryEntry[];
}

function watermarkPath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "notion"), "watermark.json");
}

async function loadWatermark(userDataDir: string): Promise<NotionWatermark> {
  try {
    const raw = await fsp.readFile(watermarkPath(userDataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<NotionWatermark>;
    return {
      lastSyncIso: parsed.lastSyncIso ?? null,
      failedRetries: Array.isArray(parsed.failedRetries)
        ? parsed.failedRetries
        : [],
    };
  } catch {
    return { lastSyncIso: null, failedRetries: [] };
  }
}

async function saveWatermark(
  userDataDir: string,
  wm: NotionWatermark,
): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "notion"), { recursive: true });
  await fsp.writeFile(watermarkPath(userDataDir), JSON.stringify(wm), "utf8");
}

export async function syncNotion(ctx: {
  accessToken: string;
  /** Just-in-time refresh hook — called at every loop boundary so a
   *  large-workspace sync does NOT outlive the access token. See
   *  Devin Review wave 13 BUG_0001 / ANALYSIS_0007. */
  getAccessToken?: () => Promise<string>;
  userDataDir: string;
  bridge: NotionBridgeHooks;
}): Promise<NotionSyncResult> {
  const dir = syncDirFor(ctx.userDataDir, "notion");
  await fsp.mkdir(dir, { recursive: true });

  const manifest = await readManifest(ctx.userDataDir, "notion");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) entriesById.set(e.remoteId, e);

  const watermark = await loadWatermark(ctx.userDataDir);

  // Per-pass success / failure trackers — declared *before* Phase 1
  // so the Phase-1 catch can record retried-but-still-failing pages
  // in `failedThisPass`. The previous shape declared `failedThisPass`
  // further down and the Phase-1 catch silently swallowed errors,
  // which meant `nextFailedRetryQueue` saw the entry in `previous`
  // but in neither `succeeded` nor `failed` — carrying it forward
  // with the *original* `failureCount` and never reaching
  // `FAILED_RETRY_MAX_ATTEMPTS`. Result: a permanently failing page
  // (e.g. permissions revoked, OAuth scope changed) wasted one API
  // call per sync forever. See Devin Review wave 7 BUG_0001.
  const succeededIds = new Set<string>();
  const failedThisPass: Array<{ remoteId: string; remoteModifiedAt: string | null }> = [];

  let added = 0;
  let modified = 0;
  // Cascading-deletion counter: incremented in the Phase-1 branch
  // below when `fetchPageById` returns null (HTTP 404/410 — the
  // page was deleted in Notion or moved out of the integration's
  // visible scope) *and* the page used to be tracked in the
  // manifest. The previous shape declared this `const removed = 0`
  // and never incremented it, leaving Notion's sync result silently
  // mis-counting upstream deletions vs OneDrive/Confluence. See
  // Devin Review wave 13 ANALYSIS_0001. The cascade also unlinks
  // the local markdown file and detaches the bridge source so the
  // user's index does not keep stale copies of pages they no
  // longer have access to.
  let removed = 0;
  let newWatermark = watermark.lastSyncIso;

  // Wrap the iteration + save in try/finally so progress is *always*
  // persisted before the function returns or rethrows. Without this,
  // an unexpected error anywhere inside the phases (e.g. an
  // unhandled `fsp.writeFile` OS error, a bridge-layer crash, or a
  // future code path that forgets a try/catch) would skip
  // `saveWatermark` and `writeManifest` entirely — making every
  // page successfully fetched in this pass invisible to the next
  // sync and forcing redundant re-fetching. This mirrors the
  // defense-in-depth pattern in figma.ts. See Devin Review wave 7
  // ANALYSIS_0004 (architectural consistency).
  try {
    // Phase 1 — explicitly re-fetch every page that the *previous*
    // pass attempted but failed on. The watermark search below would
    // miss them if any successful page from this pass advances the
    // watermark past the failed page's `last_edited_time` (which is
    // common in practice, because Notion's `/search` returns newest
    // first and a transient failure usually fires on a single page
    // while other newer pages succeed). Without this phase those
    // failed pages would never be retried until the user edited them
    // again — see the wave-5 Devin Review finding on this file.
    const retryPages: NotionPage[] = [];
    for (const entry of watermark.failedRetries) {
      try {
        // Refresh-on-demand at the top of every Phase-1 retry. The
        // retry queue can carry thousands of permanently-failing ids
        // on accounts with revoked-then-restored integration scopes,
        // so the loop alone can outlive a 1h access token. See Devin
        // Review wave 13 BUG_0001.
        const accessToken = await resolveAccessToken(ctx);
        const page = await fetchPageById(entry.remoteId, accessToken);
        if (page === null) {
          // Notion returned 404/410 — the page was deleted or moved
          // out of the integration's visible scope. Cascade the
          // deletion to the local sync dir and the bridge source
          // registry so the user's index does not keep stale copies
          // of pages they no longer have access to. Previously this
          // branch only dropped from the retry queue and silently
          // kept the local file + source entry, which surfaced as
          // an inconsistency with OneDrive/Confluence which DO
          // cascade upstream deletions. See Devin Review wave 13
          // ANALYSIS_0001.
          const prior = entriesById.get(entry.remoteId);
          if (prior) {
            const existingSource = ctx.bridge
              .listSources()
              .find((s) => s.path === prior.localPath);
            if (existingSource) {
              try {
                ctx.bridge.removeSource(existingSource.id);
              } catch {
                // best-effort — a bridge crash here MUST NOT mask
                // the upstream 404 we are reacting to.
              }
            }
            try {
              await fsp.unlink(prior.localPath);
            } catch {
              // already gone on disk — desired end state.
            }
            entriesById.delete(entry.remoteId);
            removed += 1;
          }
          succeededIds.add(entry.remoteId);
          continue;
        }
        retryPages.push(page);
      } catch {
        // Fetch failed *again* — record the failure so
        // `nextFailedRetryQueue` bumps `failureCount` toward
        // `FAILED_RETRY_MAX_ATTEMPTS` and we eventually give up rather
        // than pinging a permanently-broken id every sync forever.
        failedThisPass.push({
          remoteId: entry.remoteId,
          remoteModifiedAt: entry.remoteModifiedAt,
        });
      }
    }

    // Phase 2 — the normal watermark scan. Pages that appear in both
    // phases (which can happen if the previous failure ran against a
    // page whose `last_edited_time` is newer than the persisted
    // watermark) are de-duplicated by id so we don't fetch their
    // blocks twice.
    const scanned = await listAllPages(ctx, watermark.lastSyncIso);
    const seenIds = new Set<string>(retryPages.map((p) => p.id));
    const allPages: NotionPage[] = [...retryPages];
    for (const p of scanned) {
      if (seenIds.has(p.id)) continue;
      seenIds.add(p.id);
      allPages.push(p);
    }

    for (const page of allPages) {
      let text: string;
      try {
        // Refresh-on-demand at the top of every Phase-2 page. The
        // page-text fetch chases child blocks recursively, so each
        // iteration can issue dozens of API calls against the
        // freshly resolved token. See Devin Review wave 13 BUG_0001.
        const accessToken = await resolveAccessToken(ctx);
        text = await fetchPageText(page, accessToken);
      } catch {
        // Record the failure so the *next* sync's Phase 1 picks it up
        // and retries by id. The watermark may legitimately advance
        // past this page on this pass (driven by other successful
        // pages); that's fine because we no longer rely on the
        // watermark to surface it.
        failedThisPass.push({
          remoteId: page.id,
          remoteModifiedAt: page.last_edited_time,
        });
        continue;
      }
      if (text.trim().length === 0) {
        // No content to index, but the page is reachable — drop it
        // from the retry queue too.
        succeededIds.add(page.id);
        continue;
      }

      const localPath = path.join(dir, `${sanitiseRemoteId(page.id)}.md`);
      try {
        await fsp.writeFile(localPath, text, "utf8");
      } catch {
        // Disk write failed (ENOSPC, permission denied, quota,
        // antivirus interception, …). Record the failure so the next
        // sync's Phase 1 picks it up by id rather than silently
        // skipping it forever. Without this, the watermark may have
        // already advanced past this page on this pass (driven by
        // other successful pages), and the next pass would never
        // re-fetch the failed page until the user edits it again in
        // Notion. This matches the defensive pattern in
        // `jira.ts` / `confluence.ts` / `figma.ts`. See Devin Review
        // wave 7C BUG_0001 (notion.ts:449).
        failedThisPass.push({
          remoteId: page.id,
          remoteModifiedAt: page.last_edited_time,
        });
        continue;
      }

      const existing = ctx.bridge.listSources().find((s) => s.path === localPath);
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
          // Index registration failed — treat as a failure so the next
          // sync retries.
          failedThisPass.push({
            remoteId: page.id,
            remoteModifiedAt: page.last_edited_time,
          });
          continue;
        }
        added += 1;
      }
      entriesById.set(page.id, {
        localPath,
        remoteId: page.id,
        remoteModifiedAt: page.last_edited_time,
      });
      // Use epoch-ms comparison via `maxWatermark` rather than the
      // string compare we used to do — see `parseWatermarkIso` in
      // `syncDir.ts` for the failure mode (mixed `Z` / `+00:00` /
      // millisecond-precision suffixes producing wrong-order results).
      newWatermark = maxWatermark(newWatermark, page.last_edited_time);
      succeededIds.add(page.id);
    }
  } finally {
    // Reconcile Phase-1 fetchPageById failures against the Phase-2
    // watermark scan: a page that failed by-id in Phase 1 but then
    // succeeded via the watermark scan in Phase 2 should NOT be
    // carried forward to the retry queue — it was effectively
    // re-synced in this pass. Without this reconciliation the
    // conservative semantics of `nextFailedRetryQueue` (failed wins
    // over succeeded for the same pass — see
    // `failedRetryQueue.test.ts:124-142`) would waste one API call
    // per sync re-fetching it. We deliberately keep the generic
    // helper's conservative semantics untouched (other connectors
    // benefit from the over-retry default) and do the same-pass
    // reconciliation here at the Notion-specific call site instead.
    // See Devin Review wave 7C ANALYSIS_0001 (notion.ts:416-423).
    // Dedupe by remoteId first. A page CAN appear twice in
    // `failedThisPass` in one pathological case: it was already in the
    // retry queue → Phase 1 `fetchPageById` threw with non-404 →
    // entry pushed; then the user edited it since the last watermark
    // so Phase 2's scan re-surfaced the same id → `fetchPageText`
    // also failed → entry pushed again. Without this dedupe, the
    // single iteration of `nextFailedRetryQueue` walks two entries
    // with the same id, bumps `failureCount` by +2 instead of +1, and
    // the page hits `FAILED_RETRY_MAX_ATTEMPTS` one pass earlier
    // than designed. Keep the most recent `remoteModifiedAt` (later
    // entries reflect the freshest server-side timestamp). See Devin
    // Review wave 11 ANALYSIS_0001 (notion.ts:517).
    const dedupedFailures = new Map<string, { remoteId: string; remoteModifiedAt: string | null }>();
    for (const entry of failedThisPass) {
      dedupedFailures.set(entry.remoteId, entry);
    }
    const reconciledFailures = Array.from(dedupedFailures.values()).filter(
      (entry) => !succeededIds.has(entry.remoteId),
    );
    // Persist progress in a nested try/catch so a state-write error
    // (e.g. disk full) doesn't shadow the original upstream error the
    // try block raised. See Devin Review wave 12 ANALYSIS_0004
    // (confluence.ts variant; cross-cutting fix applied to all 5
    // connectors).
    try {
      await saveWatermark(ctx.userDataDir, {
        lastSyncIso: newWatermark,
        failedRetries: nextFailedRetryQueue(watermark.failedRetries, {
          succeeded: succeededIds,
          failed: reconciledFailures,
        }),
      });
      await writeManifest(ctx.userDataDir, {
        version: 1,
        provider: "notion",
        entries: Array.from(entriesById.values()),
      });
    } catch {
      // best-effort — original error (if any) is preserved
    }
  }

  return { added, modified, removed, status: "synced" };
}

export async function disconnectNotion(
  userDataDir: string,
  bridge: NotionBridgeHooks,
): Promise<void> {
  const manifest = await readManifest(userDataDir, "notion");
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
  await purgeSyncDir(userDataDir, "notion");
}
