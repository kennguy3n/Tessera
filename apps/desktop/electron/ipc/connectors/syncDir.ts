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
 */
export function sanitiseRemoteId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 200 ? safe.slice(0, 200) : safe;
}
