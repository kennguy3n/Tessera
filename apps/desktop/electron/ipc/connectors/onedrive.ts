/**
 * OneDrive / Microsoft Graph connector sync logic.
 *
 * Authentication: standard OAuth 2.0 authorization code grant against
 * the Microsoft identity platform v2.0 endpoint.
 *
 * Sync model: pull the user's items via the Microsoft Graph
 * `/me/drive/root/delta` endpoint. Delta tokens are persisted across
 * runs so each subsequent sync only pulls the changed items.
 *
 * What gets indexed:
 *   - Office documents (.docx, .xlsx, .pptx) — downloaded as their
 *     native binary; the local indexer in `tessera_sources` handles
 *     the actual text extraction via the docx / xlsx pipelines.
 *   - Plain text, Markdown, CSV, JSON — downloaded as-is.
 *   - PDFs — downloaded; the local indexer handles text extraction.
 *   - OneNote / EPUB / RTF — downloaded as-is.
 *   - Folders — skipped (only their items are indexed).
 *   - Files larger than `MAX_BYTES_PER_FILE` — skipped to avoid
 *     ballooning local storage on stray large items.
 *
 * Local layout:
 *     <userData>/onedrive-sync/<remoteId>.<ext>
 */

import * as fsp from "fs/promises";
import { createWriteStream } from "fs";
import { Readable } from "stream";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
import { pipeline } from "stream/promises";
import * as path from "path";

import {
  manifestPathFor,
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

export interface OneDriveSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

interface DriveItem {
  id: string;
  name: string;
  size?: number;
  file?: { mimeType?: string };
  folder?: unknown;
  deleted?: { state?: string };
  lastModifiedDateTime?: string;
  "@microsoft.graph.downloadUrl"?: string;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const DEFAULT_PAGE_SIZE = 200;
const MAX_BYTES_PER_FILE = 100 * 1024 * 1024;
// Allowlist of mime prefixes / extensions we know the local indexer
// can extract text from. Everything else is downloaded verbatim but
// indexed as raw bytes (the indexer will still produce metadata-only
// chunks).
const TEXTLIKE_MIME_PREFIXES = [
  "text/",
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
];

interface DeltaState {
  deltaLink: string | null;
}

function deltaStatePath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "onedrive"), "delta.json");
}

async function loadDeltaState(userDataDir: string): Promise<DeltaState> {
  try {
    const raw = await fsp.readFile(deltaStatePath(userDataDir), "utf8");
    return JSON.parse(raw) as DeltaState;
  } catch {
    return { deltaLink: null };
  }
}

async function saveDeltaState(
  userDataDir: string,
  state: DeltaState,
): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "onedrive"), { recursive: true });
  await fsp.writeFile(
    deltaStatePath(userDataDir),
    JSON.stringify(state),
    "utf8",
  );
}

function extensionFor(item: DriveItem): string {
  const dot = item.name.lastIndexOf(".");
  if (dot > 0 && dot < item.name.length - 1) {
    return item.name.slice(dot);
  }
  // Fall back to a generic .bin so the local indexer can still walk
  // the file. The chunker treats binary-looking content as a no-op,
  // so this is safe.
  return ".bin";
}

function isIndexable(item: DriveItem): boolean {
  if (item.folder) return false;
  if (item.deleted) return false;
  // Microsoft Graph can return drive items that are neither files nor
  // folders — remote items pointing at content in a shared drive,
  // packages (.zip-like bundles surfaced as a single addressable
  // item), and OneNote sections in some tenants — all of which lack
  // the `file` facet entirely. If we let those fall through to the
  // extension regex below, a remote-item shortcut named `report.docx`
  // would pass the allowlist and the downloader would issue a content
  // request that the API rejects. Gate on the `file` facet so only
  // genuine drive files are even considered for download.
  if (!item.file) return false;
  if ((item.size ?? 0) > MAX_BYTES_PER_FILE) return false;
  const mime = item.file?.mimeType ?? "";
  if (TEXTLIKE_MIME_PREFIXES.some((p) => mime.startsWith(p))) return true;
  // OneNote / EPUB / RTF have distinctive MIME types Graph returns but
  // not always reliably (some tenants return `application/octet-stream`
  // for OneNote), so we match by both MIME and extension. Office files
  // (docx/xlsx/pptx) are matched by extension only because the local
  // indexer routes on extension anyway.
  if (
    mime === "application/onenote" ||
    mime === "application/msonenote" ||
    mime === "application/epub+zip" ||
    mime === "application/rtf" ||
    mime === "text/rtf"
  ) {
    return true;
  }
  // Extension matcher must mirror the indexable types documented in
  // the module header. Anything added here MUST also be reflected in
  // the "What gets indexed" doc block above.
  if (
    /\.(docx|xlsx|pptx|csv|md|rst|txt|html?|pdf|json|ya?ml|epub|rtf|one|onepkg)$/i.test(
      item.name,
    )
  ) {
    return true;
  }
  return false;
}

async function graphFetch(url: string, accessToken: string): Promise<Response> {
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
}

async function downloadItem(
  item: DriveItem,
  accessToken: string,
  localPath: string,
): Promise<boolean> {
  const downloadUrl =
    item["@microsoft.graph.downloadUrl"] ??
    `${GRAPH_BASE}/me/drive/items/${item.id}/content`;
  // The pre-signed `@microsoft.graph.downloadUrl` does NOT need the
  // Authorization header, but always sending it is safe (Microsoft
  // documents both cases). When we fall back to the items/content
  // endpoint the header is required.
  const resp = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    // Drain the body so undici returns the socket to the keep-alive
    // pool immediately instead of pinning it until GC.
    await resp.text().catch(() => undefined);
    return false;
  }
  // LW-6: stream the body straight to disk instead of buffering the
  // whole file via `arrayBuffer()`. OneDrive files are capped at
  // `MAX_BYTES_PER_FILE` (100 MB); buffering one meant a transient
  // ~100 MB `ArrayBuffer` plus a second ~100 MB `Buffer` copy on the
  // V8/native heap — a ~200 MB spike per large file that blows the
  // lightweight RSS budget. Streaming keeps only one chunk in flight.
  //
  // Write to a sibling `.partial` file and rename on success so a
  // mid-stream failure (the body cut the doc comment in the caller
  // calls out) can never leave a truncated file that the bridge would
  // then index as a corrupt source. `rename` is atomic within a
  // filesystem, and the sync dir + temp file always share one.
  if (!resp.body) {
    // 200 with no body: nothing to write. Treat as a skip rather than
    // creating a zero-byte source.
    return false;
  }
  const tmpPath = `${localPath}.partial`;
  try {
    // `resp.body` is the DOM `ReadableStream`; `Readable.fromWeb` is typed
    // against Node's `stream/web` `ReadableStream`. They are structurally
    // compatible at runtime (Node 20 / Electron 31 unify the stream
    // implementations) but differ in .d.ts identity, so bridge the nominal
    // gap with a typed cast rather than `any`.
    await pipeline(
      Readable.fromWeb(
        resp.body as unknown as NodeWebReadableStream<Uint8Array>,
      ),
      createWriteStream(tmpPath),
    );
    await fsp.rename(tmpPath, localPath);
  } catch (err) {
    // Best-effort cleanup of the partial file before propagating so the
    // caller's per-item catch (network -> offline, else skip) sees the
    // same error surface as before and no truncated file survives.
    await fsp.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  return true;
}

async function pullDeltaPage(
  url: string,
  accessToken: string,
): Promise<{
  items: DriveItem[];
  nextLink: string | null;
  deltaLink: string | null;
}> {
  const resp = await graphFetch(url, accessToken);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `OneDrive delta request failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  const data = (await resp.json()) as {
    value: DriveItem[];
    "@odata.nextLink"?: string;
    "@odata.deltaLink"?: string;
  };
  return {
    items: data.value ?? [],
    nextLink: data["@odata.nextLink"] ?? null,
    deltaLink: data["@odata.deltaLink"] ?? null,
  };
}

export interface OneDriveBridgeHooks {
  /** Add a local file to the source index, returning the source id. */
  addLocalFile(localPath: string): { id: string; path: string };
  /** Force a re-index of an existing source. */
  reindexSource(sourceId: string): void;
  /** Remove a source from the index by id. */
  removeSource(sourceId: string): void;
  /** List currently-indexed sources. */
  listSources(): Array<{ id: string; path: string }>;
}

export async function syncOneDrive(ctx: {
  accessToken: string;
  /** Just-in-time refresh hook — called per delta page so a long
   *  sync does NOT outlive the access token's lifetime. */
  getAccessToken?: () => Promise<string>;
  userDataDir: string;
  bridge: OneDriveBridgeHooks;
}): Promise<OneDriveSyncResult> {
  const dir = syncDirFor(ctx.userDataDir, "onedrive");
  await fsp.mkdir(dir, { recursive: true });

  const manifest = await readManifest(ctx.userDataDir, "onedrive");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) {
    entriesById.set(e.remoteId, e);
  }

  const state = await loadDeltaState(ctx.userDataDir);
  let url =
    state.deltaLink ??
    `${GRAPH_BASE}/me/drive/root/delta?$top=${DEFAULT_PAGE_SIZE}`;

  let added = 0;
  let modified = 0;
  let removed = 0;
  let deltaLink: string | null = null;

  // Source-by-path index, materialised inside the try block below so
  // an unlikely `bridge.listSources()` throw is still caught by the
  // saveDeltaState + writeManifest cleanup path (defense-in-depth
  // mirrored from the other five connectors; the `!` definite-
  // assignment assertion is safe because every read of `sourceIndex`
  // is inside the try block, after assignment). The cache lets the
  // hot loop's existence check be O(1) instead of the previous
  // `bridge.listSources().find(...)` per-item scan
  // (O(deltaItems × sources)). Matches the same O(1) cache pattern
  // used by notion.ts/jira.ts/confluence.ts/figma.ts/gdrive.ts.
  let sourceIndex!: SourcePathIndex;

  // Wrap the pagination loop in try/finally so progress is *always*
  // persisted before the function returns or rethrows. Without this, a
  // transient error on page N of M (HTTP 500, network drop, JSON parse
  // failure) would discard every item already downloaded and indexed
  // from pages 1..N-1 because `saveDeltaState` and `writeManifest`
  // would never run — the next sync would start over from the
  // initial delta URL, re-downloading the entire drive. Mirrors the
  // same defense-in-depth applied in notion.ts, jira.ts, figma.ts, and
  // confluence.ts.
  // Why save partial state on error is safe: the Microsoft Graph
  // delta endpoint is monotonic — re-requesting the same `deltaLink`
  // is idempotent. The upsert logic in this same loop is also
  // idempotent (it matches by `remoteId` against `entriesById`), so
  // any items that *were* persisted to the manifest mid-failure will
  // be silently no-op'd on the retry rather than re-added as
  // duplicates.
  try {
    // Materialise the source-by-path index inside the try block so an
    // unlikely `bridge.listSources()` throw is still caught by the
    // saveDeltaState + writeManifest cleanup below.
    sourceIndex = SourcePathIndex.fromBridge(ctx.bridge);

    for (let safety = 0; safety < 500; safety += 1) {
      // Refresh-on-demand at the top of every page. OneDrive uses
      // server-driven pagination via `@odata.nextLink`; a workspace
      // with deep history can paginate for tens of minutes — long
      // enough for a single static access token to expire mid-loop
      // and 401 the remainder of the sync.
      const accessToken = await resolveAccessToken(ctx);
      const page = await pullDeltaPage(url, accessToken);
      for (const item of page.items) {
        if (item.deleted) {
          const prior = entriesById.get(item.id);
          if (prior) {
            const existingSource = sourceIndex.get(prior.localPath);
            if (existingSource) {
              try {
                ctx.bridge.removeSource(existingSource.id);
              } catch {
                // best-effort
              }
              sourceIndex.remove(prior.localPath);
            }
            try {
              await fsp.unlink(prior.localPath);
            } catch {
              // already gone
            }
            entriesById.delete(item.id);
            removed += 1;
          }
          continue;
        }
        if (!isIndexable(item)) continue;

        const ext = extensionFor(item);
        const localPath = path.join(dir, `${sanitiseRemoteId(item.id)}${ext}`);
        // Per-item try/catch around the download. The three things
        // `downloadItem` can throw are: (a) the `fetch` rejecting on a
        // genuine transport-level network failure (DNS, socket reset,
        // wifi drop), (b) `resp.arrayBuffer()` rejecting if the body
        // stream is cut mid-read, and (c) `fsp.writeFile` rejecting on
        // a filesystem error (ENOSPC, EACCES). Without this catch,
        // case (c) — a single broken file out of potentially thousands
        // in the delta page — would abort the entire OneDrive sync,
        // and the `finally` block would persist `deltaLink: null`
        // (because we never reach the page's `deltaLink` checkpoint),
        // forcing the next sync to re-walk from the initial delta URL.
        // That's a real cost on large workspaces.
        // Re-throwing on `isNetworkError(err)` preserves the offline
        // detection contract owned by `runConnectorSync`'s outer catch
        // — the same posture every other connector applies. Non-network
        // errors (the filesystem and arrayBuffer cases above) get the
        // same treatment as the existing `!resp.ok` branch immediately
        // below: skip the file and continue. The next sync's delta
        // token will re-surface any item whose contents the upstream
        // still considers changed, so a transient ENOSPC doesn't
        // permanently shadow the file.
        let ok: boolean;
        try {
          ok = await downloadItem(item, accessToken, localPath);
        } catch (err) {
          if (isNetworkError(err)) throw err;
          continue;
        }
        if (!ok) continue;

        const existingSource = sourceIndex.get(localPath);
        if (existingSource) {
          try {
            ctx.bridge.reindexSource(existingSource.id);
          } catch {
            // best-effort: leave the file on disk so a future sync can retry
          }
          modified += 1;
        } else {
          let registered: { id: string; path: string };
          try {
            registered = ctx.bridge.addLocalFile(localPath);
          } catch {
            continue;
          }
          sourceIndex.add(registered);
          added += 1;
        }
        entriesById.set(item.id, {
          localPath,
          remoteId: item.id,
          remoteModifiedAt: item.lastModifiedDateTime ?? null,
        });
      }

      if (page.deltaLink) {
        deltaLink = page.deltaLink;
        break;
      }
      if (page.nextLink) {
        url = page.nextLink;
      } else {
        // No nextLink + no deltaLink should not happen per the Graph API
        // contract, but if it does, we exit cleanly.
        break;
      }
    }
  } finally {
    // Persist *whatever* progress we made — even on the unhappy path
    // where the loop threw mid-pagination. `deltaLink` may still be
    // null in that case; that's correct, because we have not yet
    // reached a checkpoint the Graph API guarantees is consistent.
    // Leaving `deltaLink: null` causes the next sync to re-scan from
    // the start, which re-walks (but does not duplicate) any items
    // already in the manifest. The whole block is wrapped in a nested
    // try/catch so a state-write error (e.g. disk full) doesn't shadow
    // the original upstream error the try block raised.
    try {
      await saveDeltaState(ctx.userDataDir, { deltaLink });
      await writeManifest(ctx.userDataDir, {
        version: 1,
        provider: "onedrive",
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
export async function disconnectOneDrive(
  userDataDir: string,
  bridge: OneDriveBridgeHooks,
): Promise<{ filesRemoved: number }> {
  const manifest = await readManifest(userDataDir, "onedrive");
  const sources = bridge.listSources();
  const localPaths = new Set(manifest.entries.map((e) => e.localPath));
  let filesRemoved = 0;
  for (const source of sources) {
    if (localPaths.has(source.path)) {
      try {
        bridge.removeSource(source.id);
        filesRemoved += 1;
      } catch {
        // best-effort
      }
    }
  }
  await purgeSyncDir(userDataDir, "onedrive");
  return { filesRemoved };
}

// Exposed for tests that want to clear the delta marker between runs.
export const __test = {
  deltaStatePath,
  manifestPathFor: (userData: string) => manifestPathFor(userData, "onedrive"),
};
