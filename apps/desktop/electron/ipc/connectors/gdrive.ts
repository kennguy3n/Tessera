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
 * This module is the canonical implementation post-Phase 10; the
 * legacy ipc.ts forwards `connectors:gdrive:sync` here so the public
 * IPC surface is unchanged.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import { syncDirFor } from "./syncDir";

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

  // Wrap the iteration + manifest persistence in try/finally so partial
  // progress is *always* committed before the function returns or
  // rethrows. Without this, a transport-level `fetch` rejection
  // (DNS failure, socket reset mid-stream, AbortError on a long
  // download) mid-loop would skip the manifest write and re-pull every
  // file that already landed on disk on the next sync — wasting API
  // quota and incrementing `added` again for files the bridge already
  // tracks. This brings gdrive into parity with the other five
  // connectors (Notion, Jira, Confluence, Figma, OneDrive) that were
  // built with this defense-in-depth pattern from the start. See
  // Devin Review wave 12 ANALYSIS_0001 (gdrive.ts:111-169).
  try {
    for (const fileId of resolvedFileIds) {
      const metaResp = await fetch(
        `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime`,
        { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
      );
      if (!metaResp.ok) {
        if (metaResp.status === 404 || metaResp.status === 410) {
          failedFileIds.push(fileId);
        }
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
          { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
        );
        if (!exportResp.ok) continue;
        contentBytes = await exportResp.arrayBuffer();
      } else {
        const dlResp = await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
          { headers: { Authorization: `Bearer ${ctx.accessToken}` } },
        );
        if (!dlResp.ok) continue;
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
        const sources = ctx.bridge.listSources();
        const existing = sources.find((s) => s.path === localPath);
        if (existing) {
          ctx.bridge.reindexSource(existing.id);
          modified += 1;
        } else {
          ctx.bridge.addLocalFile(localPath);
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
              const src = ctx.bridge
                .listSources()
                .find((s) => s.path === localPath);
              if (src) {
                try {
                  ctx.bridge.removeSource(src.id);
                } catch {
                  // best effort
                }
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
    // network or auth error the caller actually needs to see. See
    // Devin Review wave 12 ANALYSIS_0004 (cross-connector pattern).
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

export async function disconnectGoogleDrive(
  userDataDir: string,
  bridge: GdriveBridgeHooks,
): Promise<void> {
  const syncDir = syncDirFor(userDataDir, "gdrive");
  const manifest = await readGdriveManifest(userDataDir);
  const syncedSet = new Set(manifest);
  const sources = bridge.listSources();
  for (const src of sources) {
    if (syncedSet.has(src.path)) {
      try {
        bridge.removeSource(src.id);
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
}

export const __test = { manifestPathFor };
