/**
 * Google Drive sync helpers extracted from the legacy `ipc.ts`.
 *
 * Behaviour preserved verbatim from the original handler:
 *   - When called with `selectedFileIds`, pull each file by id.
 *   - When called with no ids, re-pull every file recorded in the
 *     `manifest.json` from the previous sync.
 *   - For Google-native MIME types (docs, sheets, slides) export to
 *     text/plain or text/csv; for everything else download raw bytes.
 *   - Treat 404/410 as a confirmed remote deletion → remove the
 *     local file and the matching source index entry.
 *   - Skip files larger than 100 MB.
 *   - Persist the post-sync state in `<userData>/gdrive-sync/manifest.json`.
 *
 * This module is the canonical implementation; the legacy ipc.ts
 * forwards `connectors:gdrive:sync` here so the public IPC surface
 * is unchanged.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { resolveAccessToken, SourcePathIndex, syncDirFor } from "./syncDir";

export interface GdriveBridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

export interface GdriveSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

const MAX_SYNC_FILE_BYTES = 100 * 1024 * 1024;

const EXPORT_MIME_MAP: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

interface DriveMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
}

function manifestPathFor(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "gdrive"), "manifest.json");
}

async function readGdriveManifest(userDataDir: string): Promise<string[]> {
  try {
    const data = await fsp.readFile(manifestPathFor(userDataDir), "utf-8");
    const arr = JSON.parse(data) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function writeGdriveManifest(
  userDataDir: string,
  paths: string[],
): Promise<void> {
  const dir = syncDirFor(userDataDir, "gdrive");
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(manifestPathFor(userDataDir), JSON.stringify(paths), "utf8");
}

function fileIdFromLocalPath(p: string): string {
  const basename = path.basename(p);
  const dotIdx = basename.indexOf(".");
  return dotIdx > 0 ? basename.substring(0, dotIdx) : basename;
}

export async function syncGoogleDrive(ctx: {
  accessToken: string;
  /**
   * Just-in-time refresh hook. When set (production wiring from
   * `handlers.ts > runConnectorSync`), it is called at the top of
   * each iteration so a sync that outlives the access token's
   * remaining lifetime can transparently refresh via the stored
   * refresh token. When omitted (tests), the static `accessToken`
   * field is used verbatim.
   * (gdrive.ts:123-126).
   */
  getAccessToken?: () => Promise<string>;
  userDataDir: string;
  bridge: GdriveBridgeHooks;
  selectedFileIds?: string[];
}): Promise<GdriveSyncResult> {
  let added = 0;
  let modified = 0;
  let removed = 0;
  const syncedPaths: string[] = [];
  const failedFileIds: string[] = [];

  // Resolve which file ids to sync. If the renderer passed an
  // explicit selection, use it; otherwise re-sync every previously
  // synced file by reading the manifest.
  let resolvedFileIds = ctx.selectedFileIds;
  if (!resolvedFileIds || resolvedFileIds.length === 0) {
    const manifest = await readGdriveManifest(ctx.userDataDir);
    if (manifest.length === 0) {
      return { added: 0, modified: 0, removed: 0, status: "synced" };
    }
    resolvedFileIds = manifest.map(fileIdFromLocalPath);
  }

  const syncDir = syncDirFor(ctx.userDataDir, "gdrive");
  await fsp.mkdir(syncDir, { recursive: true });

  // Source-by-path index, materialised inside the try block below so
  // an unlikely `bridge.listSources()` throw is still caught by the
  // writeManifest cleanup path (defense-in-depth mirrored from
  // figma.ts; the `!` definite-assignment assertion is safe because
  // every read of `sourceIndex` is inside the try block, after
  // assignment). The cache lets the per-file existence check be O(1)
  // instead of the previous `bridge.listSources().find(...)`
  // per-iteration scan (O(files × sources)). Same pattern as the
  // other five connectors;
  let sourceIndex!: SourcePathIndex;

  // Wrap the iteration + manifest persistence in try/finally so partial
  // progress is *always* committed before the function returns or
  // rethrows. Without this, a transport-level `fetch` rejection
  // (DNS failure, socket reset mid-stream, AbortError on a long
  // download) mid-loop would skip the manifest write and re-pull every
  // file that already landed on disk on the next sync — wasting API
  // quota and incrementing `added` again for files the bridge already
  // tracks. This brings gdrive into parity with the other five
  // connectors (Notion, Jira, Confluence, Figma, OneDrive) that were
  // built with this defense-in-depth pattern from the start.
  try {
    // Materialise the source-by-path index inside the try block so an
    // unlikely `bridge.listSources()` throw is still caught by the
    // writeManifest cleanup below.
    sourceIndex = SourcePathIndex.fromBridge(ctx.bridge);
    for (const fileId of resolvedFileIds) {
      // Refresh-on-demand at the top of every iteration. A Drive
      // sync of a large account can easily exceed the access
      // token's ~1h lifetime; without this, all fetches after the
      // 60-minute mark return HTTP 401 and the rest of the sync is
      // lost until the user clicks Sync Now again. The callback
      // (production wiring) hits the in-process cache + only
      // exchanges the refresh token when within 60s of expiry, so
      // the overhead per iteration is a single map lookup and a
      // millisecond-precision comparison.
      const accessToken = await resolveAccessToken(ctx);
      const metaResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!metaResp.ok) {
        if (metaResp.status === 404 || metaResp.status === 410) {
          failedFileIds.push(fileId);
        }
        // Drain the response body so undici can return the underlying
        // socket to the keep-alive pool immediately. Without this, an
        // unconsumed body keeps the socket pinned until GC reaps the
        // Response — noticeable when many files in a single sync are
        // 404/410/5xx (e.g. a large carry-forward retry queue). The
        // export and download branches below drain on their non-ok
        // paths for the same reason.
        await metaResp.text().catch(() => undefined);
        continue;
      }
      const meta = (await metaResp.json()) as DriveMeta;
      if (meta.mimeType === "application/vnd.google-apps.folder") continue;
      const fileSize = Number(meta.size ?? "0");
      if (fileSize > MAX_SYNC_FILE_BYTES) continue;

      let contentBytes: ArrayBuffer;
      const exportMime = EXPORT_MIME_MAP[meta.mimeType];
      if (exportMime) {
        const exportResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!exportResp.ok) {
          // Drain body before skipping so the underlying socket is
          // returned to the pool immediately.
          await exportResp.text().catch(() => undefined);
          continue;
        }
        contentBytes = await exportResp.arrayBuffer();
      } else {
        const dlResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
          { headers: { Authorization: `Bearer ${accessToken}` } },
        );
        if (!dlResp.ok) {
          await dlResp.text().catch(() => undefined);
          continue;
        }
        contentBytes = await dlResp.arrayBuffer();
      }

      if (contentBytes.byteLength === 0) continue;
      const ext = exportMime
        ? exportMime === "text/csv"
          ? ".csv"
          : ".txt"
        : meta.name.includes(".")
          ? meta.name.substring(meta.name.lastIndexOf("."))
          : "";
      const localPath = path.join(syncDir, `${fileId}${ext}`);
      await fsp.writeFile(localPath, Buffer.from(contentBytes));

      try {
        const existing = sourceIndex.get(localPath);
        if (existing) {
          ctx.bridge.reindexSource(existing.id);
          modified += 1;
        } else {
          const registered = ctx.bridge.addLocalFile(localPath);
          sourceIndex.add(registered);
          added += 1;
        }
        syncedPaths.push(localPath);
      } catch {
        // Indexing failed — leave file on disk for next pass
      }
    }

    // Remove local files + source index entries for 404/410 deletions
    if (failedFileIds.length > 0) {
      try {
        const entries = await fsp.readdir(syncDir);
        for (const failedId of failedFileIds) {
          for (const entry of entries) {
            const entryId = fileIdFromLocalPath(entry);
            if (entryId === failedId) {
              const localPath = path.join(syncDir, entry);
              const src = sourceIndex.get(localPath);
              if (src) {
                try {
                  ctx.bridge.removeSource(src.id);
                } catch {
                  // best effort
                }
                sourceIndex.remove(localPath);
              }
              await fsp.unlink(localPath).catch(() => undefined);
              removed += 1;
            }
          }
        }
      } catch {
        // syncDir may not exist
      }
    }
  } finally {
    // Persist manifest with whatever progress we have. The original
    // error (if any) is wrapped in a fresh try/catch so a manifest-
    // write failure (e.g. disk full) doesn't shadow the underlying
    // network or auth error the caller actually needs to see.
    try {
      const existingManifest = await readGdriveManifest(ctx.userDataDir);
      const failedIdSet = new Set(failedFileIds);
      const surviving = existingManifest.filter(
        (p) => !failedIdSet.has(fileIdFromLocalPath(p)),
      );
      const merged = Array.from(new Set([...surviving, ...syncedPaths]));
      if (merged.length > 0) {
        await writeGdriveManifest(ctx.userDataDir, merged);
      } else {
        // Every previously-tracked file has been confirmed remotely
        // deleted (404/410) and no new files were synced this pass.
        // Remove the manifest entirely — otherwise the next sync would
        // re-read the stale id list, re-issue HEAD requests for each
        // deleted file, and 404 forever in a wasted-API-call loop.
        await fsp
          .unlink(manifestPathFor(ctx.userDataDir))
          .catch(() => undefined);
      }
    } catch {
      // best-effort — don't shadow the original throw
    }
  }

  return { added, modified, removed, status: "synced" };
}

/**
 * Disconnect the Google Drive connector: remove every source that
 * was created by a previous sync, purge the local file mirror, and
 * tear down the sync directory.
 *
 * Returns the number of bridge sources that were successfully
 * removed so the calling IPC handler can include the count in the
 * `ConnectorDisconnected` audit event (the audit code). The
 * `manifest.length` is intentionally NOT the right number to report
 * — a previous sync may have failed mid-flight, leaving some
 * manifest entries without corresponding bridge sources, or the
 * user may have manually deleted some sources between syncs. Using
 * the count of actually-removed sources gives a faithful audit
 * trail of "what state the connector left the index in".
 */
export async function disconnectGoogleDrive(
  userDataDir: string,
  bridge: GdriveBridgeHooks,
): Promise<{ filesRemoved: number }> {
  const syncDir = syncDirFor(userDataDir, "gdrive");
  const manifest = await readGdriveManifest(userDataDir);
  const syncedSet = new Set(manifest);
  const sources = bridge.listSources();
  let filesRemoved = 0;
  for (const src of sources) {
    if (syncedSet.has(src.path)) {
      try {
        bridge.removeSource(src.id);
        filesRemoved += 1;
      } catch {
        // best effort
      }
    }
  }
  await Promise.all(
    manifest.map((p) => fsp.unlink(p).catch(() => undefined)),
  );
  await fsp.unlink(manifestPathFor(userDataDir)).catch(() => undefined);
  await fsp.rm(syncDir, { recursive: true, force: true }).catch(() => undefined);
  return { filesRemoved };
}

export const __test = { manifestPathFor };
