/**
 * Figma connector sync logic (Task 5).
 *
 * Authentication: Figma OAuth 2.0 (`figma.com/oauth`,
 * `api.figma.com/v1/oauth/token`).
 *
 * Sync model: Figma's API does not surface a "list all files I can
 * see" endpoint. Instead we list the user's teams via the (now
 * Personal-style) `/v1/me` endpoint to recover a team_id, then list
 * each team's projects → files. For each file we GET `/v1/files/{key}`
 * with `depth=2` (no rasterisation) and extract:
 *
 *   - File metadata (name, last_modified)
 *   - All `TEXT` node character payloads
 *   - All component names + descriptions
 *   - Top-level comments (separate `/v1/files/{key}/comments` endpoint)
 *
 * The output is a Markdown summary written to
 * `<userData>/figma-sync/<file-key>.md` and indexed locally.
 *
 * Incremental sync uses each file's `last_modified` against a stored
 * watermark.
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

const FIGMA_API = "https://api.figma.com/v1";

export interface FigmaSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

interface FigmaTeam {
  id: string;
  name: string;
}

interface FigmaProject {
  id: string;
  name: string;
}

interface FigmaProjectsResponse {
  name: string;
  projects: FigmaProject[];
}

interface FigmaFileSummary {
  key: string;
  name: string;
  thumbnail_url?: string;
  last_modified: string;
}

interface FigmaProjectFilesResponse {
  name: string;
  files: FigmaFileSummary[];
}

interface FigmaNode {
  id?: string;
  name?: string;
  type?: string;
  characters?: string;
  description?: string;
  children?: FigmaNode[];
}

interface FigmaFile {
  document: FigmaNode;
  name: string;
  lastModified: string;
  components?: Record<string, { name: string; description?: string }>;
  componentSets?: Record<string, { name: string; description?: string }>;
}

interface FigmaComment {
  message: string;
  user: { handle?: string };
  created_at: string;
}

interface FigmaCommentsResponse {
  comments: FigmaComment[];
}

function figmaHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
}

async function listTeams(accessToken: string): Promise<FigmaTeam[]> {
  // The public OAuth scope does not give us a "list teams" endpoint
  // directly; instead we read the user's recent files and follow
  // their team metadata. As a fallback, the renderer can supply a
  // team_id explicitly via the sync ctx.
  const resp = await fetch(`${FIGMA_API}/me`, { headers: figmaHeaders(accessToken) });
  if (!resp.ok) return [];
  const data = (await resp.json()) as { teams?: FigmaTeam[] };
  return data.teams ?? [];
}

async function listProjects(
  teamId: string,
  accessToken: string,
): Promise<FigmaProject[]> {
  const resp = await fetch(`${FIGMA_API}/teams/${teamId}/projects`, {
    headers: figmaHeaders(accessToken),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Figma list projects failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  const data = (await resp.json()) as FigmaProjectsResponse;
  return data.projects;
}

async function listProjectFiles(
  projectId: string,
  accessToken: string,
): Promise<FigmaFileSummary[]> {
  const resp = await fetch(`${FIGMA_API}/projects/${projectId}/files`, {
    headers: figmaHeaders(accessToken),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Figma list files failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  const data = (await resp.json()) as FigmaProjectFilesResponse;
  return data.files;
}

async function getFile(
  key: string,
  accessToken: string,
): Promise<FigmaFile> {
  // depth=4 keeps the response tractable; we mainly need TEXT
  // nodes which sit close to the leaves but skipping artboards
  // entirely would lose component naming context.
  const resp = await fetch(`${FIGMA_API}/files/${key}?depth=4`, {
    headers: figmaHeaders(accessToken),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Figma get file failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as FigmaFile;
}

async function getComments(
  key: string,
  accessToken: string,
): Promise<FigmaComment[]> {
  const resp = await fetch(`${FIGMA_API}/files/${key}/comments`, {
    headers: figmaHeaders(accessToken),
  });
  if (!resp.ok) return [];
  const data = (await resp.json()) as FigmaCommentsResponse;
  return data.comments;
}

function collectTextNodes(node: FigmaNode, out: string[]): void {
  if (node.type === "TEXT" && node.characters && node.characters.trim()) {
    out.push(node.characters.trim());
  }
  for (const child of node.children ?? []) {
    collectTextNodes(child, out);
  }
}

function renderFigmaFile(
  key: string,
  file: FigmaFile,
  comments: FigmaComment[],
): string {
  const texts: string[] = [];
  collectTextNodes(file.document, texts);

  const lines: string[] = [
    `# ${file.name}`,
    "",
    `- File key: ${key}`,
    `- Last modified: ${file.lastModified}`,
    "",
    "## Text layers",
  ];
  if (texts.length === 0) {
    lines.push("_(no text layers found)_");
  } else {
    for (const t of texts.slice(0, 1_000)) {
      lines.push(`- ${t.replace(/\s+/g, " ")}`);
    }
  }

  const components = Object.values(file.components ?? {});
  if (components.length > 0) {
    lines.push("", "## Components");
    for (const c of components) {
      lines.push(
        `- ${c.name}${c.description ? ` — ${c.description.replace(/\s+/g, " ")}` : ""}`,
      );
    }
  }

  const sets = Object.values(file.componentSets ?? {});
  if (sets.length > 0) {
    lines.push("", "## Component sets");
    for (const s of sets) {
      lines.push(
        `- ${s.name}${s.description ? ` — ${s.description.replace(/\s+/g, " ")}` : ""}`,
      );
    }
  }

  if (comments.length > 0) {
    lines.push("", "## Comments");
    for (const c of comments.slice(0, 200)) {
      lines.push(
        `- ${c.user?.handle ?? "anon"} (${c.created_at}): ${c.message.replace(/\s+/g, " ")}`,
      );
    }
  }

  return lines.join("\n");
}

export interface FigmaBridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

interface FigmaState {
  lastSyncIso: string | null;
  teamIds: string[];
}

function statePath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "figma"), "state.json");
}

async function loadState(userDataDir: string): Promise<FigmaState> {
  try {
    const raw = await fsp.readFile(statePath(userDataDir), "utf8");
    return JSON.parse(raw) as FigmaState;
  } catch {
    return { lastSyncIso: null, teamIds: [] };
  }
}

async function saveState(userDataDir: string, s: FigmaState): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "figma"), { recursive: true });
  await fsp.writeFile(statePath(userDataDir), JSON.stringify(s), "utf8");
}

export async function syncFigma(ctx: {
  accessToken: string;
  userDataDir: string;
  bridge: FigmaBridgeHooks;
  /** Optional override — when null, we re-resolve from /v1/me. */
  teamIds?: string[] | null;
}): Promise<FigmaSyncResult> {
  const dir = syncDirFor(ctx.userDataDir, "figma");
  await fsp.mkdir(dir, { recursive: true });

  const state = await loadState(ctx.userDataDir);
  let teamIds = ctx.teamIds ?? state.teamIds;
  if (teamIds.length === 0) {
    const teams = await listTeams(ctx.accessToken);
    teamIds = teams.map((t) => t.id);
  }
  if (teamIds.length === 0) {
    // The OAuth scope may not have surfaced teams. Persist an empty
    // sync rather than crashing — the user gets an actionable
    // "no team membership" Toast at the UI layer.
    await saveState(ctx.userDataDir, { lastSyncIso: state.lastSyncIso, teamIds: [] });
    return { added: 0, modified: 0, removed: 0, status: "no-teams" };
  }

  const manifest = await readManifest(ctx.userDataDir, "figma");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) entriesById.set(e.remoteId, e);

  let added = 0;
  let modified = 0;
  const removed = 0;
  let watermark = state.lastSyncIso;

  for (const teamId of teamIds) {
    let projects: FigmaProject[];
    try {
      projects = await listProjects(teamId, ctx.accessToken);
    } catch {
      continue;
    }
    for (const project of projects) {
      let files: FigmaFileSummary[];
      try {
        files = await listProjectFiles(project.id, ctx.accessToken);
      } catch {
        continue;
      }
      for (const summary of files) {
        if (watermark && summary.last_modified <= watermark) continue;
        let file: FigmaFile;
        try {
          file = await getFile(summary.key, ctx.accessToken);
        } catch {
          continue;
        }
        const comments = await getComments(summary.key, ctx.accessToken);
        const body = renderFigmaFile(summary.key, file, comments);

        const localPath = path.join(
          dir,
          `${sanitiseRemoteId(summary.key)}.md`,
        );
        await fsp.writeFile(localPath, body, "utf8");

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
        entriesById.set(summary.key, {
          localPath,
          remoteId: summary.key,
          remoteModifiedAt: summary.last_modified,
        });
        if (!watermark || summary.last_modified > watermark) {
          watermark = summary.last_modified;
        }
      }
    }
  }

  await saveState(ctx.userDataDir, { lastSyncIso: watermark, teamIds });
  await writeManifest(ctx.userDataDir, {
    version: 1,
    provider: "figma",
    entries: Array.from(entriesById.values()),
  });

  return { added, modified, removed, status: "synced" };
}

export async function disconnectFigma(
  userDataDir: string,
  bridge: FigmaBridgeHooks,
): Promise<void> {
  const manifest = await readManifest(userDataDir, "figma");
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
  await purgeSyncDir(userDataDir, "figma");
}

export const __test = { collectTextNodes, renderFigmaFile };
