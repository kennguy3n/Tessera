/**
 * Jira connector sync logic (Task 3).
 *
 * Authentication: Atlassian OAuth 2.0 (3LO). After token exchange we
 * call `api.atlassian.com/oauth/token/accessible-resources` to find
 * the user's cloud ids.
 *
 * Sync model: walk every issue (across every visible project) via
 * `/rest/api/3/search` with JQL. Each issue is rendered to a small
 * Markdown blob containing the summary, status, assignee, description
 * (`renderedFields.description` falls back to ADF→text), and the most
 * recent comments. The blob is written to
 * `<userData>/jira-sync/<issue-key>.md` and indexed locally.
 *
 * Incremental sync uses the issue `updated` field plus a JQL
 * `updated >= "<watermark>"` clause on subsequent passes.
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
const PAGE_SIZE = 50;

export interface JiraSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

interface JiraAccessibleResource {
  id: string;
  url: string;
  name: string;
  scopes: string[];
  avatarUrl?: string;
}

interface JiraIssueFields {
  summary?: string;
  status?: { name?: string };
  assignee?: { displayName?: string; emailAddress?: string };
  reporter?: { displayName?: string; emailAddress?: string };
  priority?: { name?: string };
  issuetype?: { name?: string };
  project?: { key?: string; name?: string };
  description?: unknown;
  updated?: string;
  comment?: {
    comments?: Array<{
      author?: { displayName?: string };
      body?: unknown;
      created?: string;
    }>;
  };
}

interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
  renderedFields?: { description?: string; comment?: unknown };
}

interface JiraSearchResponse {
  startAt: number;
  maxResults: number;
  total: number;
  issues: JiraIssue[];
}

async function listAccessibleResources(
  accessToken: string,
): Promise<JiraAccessibleResource[]> {
  const resp = await fetch(`${ATLASSIAN_API}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Jira accessible-resources failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as JiraAccessibleResource[];
}

function adfToText(node: unknown): string {
  // Atlassian Document Format → plain text.
  // We only walk the read-only subset we need for indexing; this is
  // not a faithful renderer.
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text" && typeof n.text === "string") return n.text;
  const parts: string[] = [];
  for (const c of n.content ?? []) {
    const text = adfToText(c);
    if (text.length > 0) parts.push(text);
  }
  const joiner = n.type === "paragraph" || n.type === "heading" ? "\n" : " ";
  return parts.join(joiner);
}

function descriptionToText(field: unknown): string {
  if (typeof field === "string") return field;
  if (field && typeof field === "object") return adfToText(field);
  return "";
}

function renderIssue(issue: JiraIssue): string {
  const f = issue.fields;
  const lines: string[] = [
    `# ${issue.key}: ${f.summary ?? "(no summary)"}`,
    "",
    `- Type: ${f.issuetype?.name ?? "—"}`,
    `- Status: ${f.status?.name ?? "—"}`,
    `- Priority: ${f.priority?.name ?? "—"}`,
    `- Project: ${f.project?.name ?? f.project?.key ?? "—"}`,
    `- Assignee: ${f.assignee?.displayName ?? "—"}`,
    `- Reporter: ${f.reporter?.displayName ?? "—"}`,
    `- Updated: ${f.updated ?? "—"}`,
    "",
    "## Description",
    descriptionToText(f.description) || "_(no description)_",
  ];
  const comments = f.comment?.comments ?? [];
  if (comments.length > 0) {
    lines.push("", "## Recent comments");
    for (const c of comments.slice(-10)) {
      lines.push(
        "",
        `**${c.author?.displayName ?? "Unknown"}** — ${c.created ?? ""}`,
        descriptionToText(c.body),
      );
    }
  }
  return lines.join("\n");
}

async function searchIssues(
  cloudId: string,
  accessToken: string,
  jql: string,
  startAt: number,
): Promise<JiraSearchResponse> {
  const url = new URL(`${ATLASSIAN_API}/ex/jira/${cloudId}/rest/api/3/search`);
  url.searchParams.set("jql", jql);
  url.searchParams.set("startAt", String(startAt));
  url.searchParams.set("maxResults", String(PAGE_SIZE));
  url.searchParams.set(
    "fields",
    "summary,status,assignee,reporter,priority,issuetype,project,description,updated,comment",
  );
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Jira search failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }
  return (await resp.json()) as JiraSearchResponse;
}

export interface JiraBridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

interface JiraState {
  cloudId: string | null;
  lastSyncIso: string | null;
}

function statePath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "jira"), "state.json");
}

async function loadJiraState(userDataDir: string): Promise<JiraState> {
  try {
    const raw = await fsp.readFile(statePath(userDataDir), "utf8");
    return JSON.parse(raw) as JiraState;
  } catch {
    return { cloudId: null, lastSyncIso: null };
  }
}

async function saveJiraState(userDataDir: string, s: JiraState): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "jira"), { recursive: true });
  await fsp.writeFile(statePath(userDataDir), JSON.stringify(s), "utf8");
}

export async function syncJira(ctx: {
  accessToken: string;
  userDataDir: string;
  bridge: JiraBridgeHooks;
  /** Optional override — when null, we re-resolve from accessible-resources. */
  cloudId?: string | null;
}): Promise<JiraSyncResult> {
  const dir = syncDirFor(ctx.userDataDir, "jira");
  await fsp.mkdir(dir, { recursive: true });

  const state = await loadJiraState(ctx.userDataDir);
  let cloudId = ctx.cloudId ?? state.cloudId;
  if (!cloudId) {
    const resources = await listAccessibleResources(ctx.accessToken);
    // Use the first resource that grants Jira scopes; in practice
    // each Atlassian Cloud site is its own resource entry.
    const resource =
      resources.find((r) => r.scopes.some((s) => s.includes("jira"))) ??
      resources[0];
    if (!resource) {
      throw new Error("No Atlassian sites are accessible — re-authenticate");
    }
    cloudId = resource.id;
  }

  const manifest = await readManifest(ctx.userDataDir, "jira");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) entriesById.set(e.remoteId, e);

  let added = 0;
  let modified = 0;
  const removed = 0;
  let watermark = state.lastSyncIso;

  const jql = watermark
    ? `updated >= "${watermark}" ORDER BY updated DESC`
    : `ORDER BY updated DESC`;

  let startAt = 0;
  for (let safety = 0; safety < 1000; safety += 1) {
    const page = await searchIssues(cloudId, ctx.accessToken, jql, startAt);
    for (const issue of page.issues) {
      const body = renderIssue(issue);
      const localPath = path.join(
        dir,
        `${sanitiseRemoteId(issue.key)}.md`,
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
      const updated = issue.fields.updated ?? null;
      entriesById.set(issue.key, {
        localPath,
        remoteId: issue.key,
        remoteModifiedAt: updated,
      });
      if (updated && (!watermark || updated > watermark)) {
        watermark = updated;
      }
    }
    startAt += page.issues.length;
    if (startAt >= page.total || page.issues.length === 0) break;
  }

  await saveJiraState(ctx.userDataDir, {
    cloudId,
    lastSyncIso: watermark,
  });
  await writeManifest(ctx.userDataDir, {
    version: 1,
    provider: "jira",
    entries: Array.from(entriesById.values()),
  });

  return { added, modified, removed, status: "synced" };
}

export async function disconnectJira(
  userDataDir: string,
  bridge: JiraBridgeHooks,
): Promise<void> {
  const manifest = await readManifest(userDataDir, "jira");
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
  await purgeSyncDir(userDataDir, "jira");
}
