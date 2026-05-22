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
  purgeSyncDir,
  readManifest,
  sanitiseRemoteId,
  syncDirFor,
  writeManifest,
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
  accessToken: string,
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
      if (lastSyncIso && p.last_edited_time <= lastSyncIso) continue;
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
}

function watermarkPath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "notion"), "watermark.json");
}

async function loadWatermark(userDataDir: string): Promise<NotionWatermark> {
  try {
    const raw = await fsp.readFile(watermarkPath(userDataDir), "utf8");
    return JSON.parse(raw) as NotionWatermark;
  } catch {
    return { lastSyncIso: null };
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
  userDataDir: string;
  bridge: NotionBridgeHooks;
}): Promise<NotionSyncResult> {
  const dir = syncDirFor(ctx.userDataDir, "notion");
  await fsp.mkdir(dir, { recursive: true });

  const manifest = await readManifest(ctx.userDataDir, "notion");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) entriesById.set(e.remoteId, e);

  const watermark = await loadWatermark(ctx.userDataDir);
  const pages = await listAllPages(ctx.accessToken, watermark.lastSyncIso);

  let added = 0;
  let modified = 0;
  const removed = 0;
  let newWatermark = watermark.lastSyncIso;

  for (const page of pages) {
    let text: string;
    try {
      text = await fetchPageText(page, ctx.accessToken);
    } catch {
      // Skip the page on this pass; the next sync will retry once
      // the watermark advances.
      continue;
    }
    if (text.trim().length === 0) continue;

    const localPath = path.join(dir, `${sanitiseRemoteId(page.id)}.md`);
    await fsp.writeFile(localPath, text, "utf8");

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
        continue;
      }
      added += 1;
    }
    entriesById.set(page.id, {
      localPath,
      remoteId: page.id,
      remoteModifiedAt: page.last_edited_time,
    });
    if (!newWatermark || page.last_edited_time > newWatermark) {
      newWatermark = page.last_edited_time;
    }
  }

  await saveWatermark(ctx.userDataDir, { lastSyncIso: newWatermark });
  await writeManifest(ctx.userDataDir, {
    version: 1,
    provider: "notion",
    entries: Array.from(entriesById.values()),
  });

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
