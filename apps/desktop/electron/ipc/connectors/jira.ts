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
  maxWatermark,
  nextFailedRetryQueue,
  purgeSyncDir,
  readManifest,
  resolveAccessToken,
  sanitiseRemoteId,
  SourcePathIndex,
  syncDirFor,
  writeManifest,
  type FailedRetryEntry,
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
  /**
   * Issue keys the previous sync attempted but failed to write. The
   * next pass folds them into the JQL via `OR key IN (...)` so they
   * get re-fetched even if the watermark has advanced past their
   * `updated` timestamp — see `nextFailedRetryQueue` in `syncDir.ts`
   * for the carry-forward reasoning.
   */
  failedRetries: FailedRetryEntry[];
}

function statePath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "jira"), "state.json");
}

async function loadJiraState(userDataDir: string): Promise<JiraState> {
  try {
    const raw = await fsp.readFile(statePath(userDataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<JiraState>;
    return {
      cloudId: parsed.cloudId ?? null,
      lastSyncIso: parsed.lastSyncIso ?? null,
      // Filter out any retry entries whose remoteId is not a JQL-safe
      // identifier (i.e. would be mutated by `jqlEscapeKey`). Such
      // entries can only come from state.json corruption or a future
      // schema change — they are unsafe to interpolate into JQL and
      // also unsafe to use as raw API keys (the escape would silently
      // resolve to a *different* issue). Dropping at load time lets
      // the queue self-heal on the next sync without any special-case
      // logic downstream.
      failedRetries: Array.isArray(parsed.failedRetries)
        ? parsed.failedRetries.filter(
            (e): e is FailedRetryEntry =>
              typeof e?.remoteId === "string" &&
              e.remoteId.length > 0 &&
              jqlEscapeKey(e.remoteId) === e.remoteId,
          )
        : [],
    };
  } catch {
    return { cloudId: null, lastSyncIso: null, failedRetries: [] };
  }
}

async function saveJiraState(userDataDir: string, s: JiraState): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "jira"), { recursive: true });
  await fsp.writeFile(statePath(userDataDir), JSON.stringify(s), "utf8");
}

/**
 * Escape a Jira issue key for inclusion inside a JQL `IN (...)`
 * clause. Issue keys are alphanumeric + `-` by construction, but we
 * still strip anything outside that set defensively in case a
 * corrupted state file ever contains user-provided text.
 */
function jqlEscapeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "");
}

/**
 * Strict ISO-8601 watermark validator. The watermark we persist is
 * always the value Jira's API returned for `issue.fields.updated`
 * (e.g. `2024-06-01T10:00:00.000+0000`). A corrupted or tampered
 * state.json file containing a `"` could otherwise break out of the
 * JQL string literal at `updated >= "<watermark>"` and inject JQL
 * syntax. The risk is low (local file, written by us), but defending
 * here matches the same posture we already apply to `jqlEscapeKey`
 * and removes any future surprise if upstream `updated` formatting
 * changes.
 *
 * Accepted: `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, `YYYY-MM-DD HH:mm`,
 * and the same with optional `:ss(.SSS)?` and an optional timezone
 * suffix (`Z`, `+0000`, `+00:00`).
 */
const JIRA_WATERMARK_PATTERN =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function sanitiseJqlWatermark(value: string | null): string | null {
  if (!value) return null;
  return JIRA_WATERMARK_PATTERN.test(value) ? value : null;
}

export async function syncJira(ctx: {
  accessToken: string;
  /** Just-in-time refresh hook — called per JQL page so a
   *  long-running sync does NOT outlive the access token. */
  getAccessToken?: () => Promise<string>;
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
    // Resolve via the JIT refresh hook (when present) instead of the
    // static `ctx.accessToken`. Earlier hardening added
    // `resolveAccessToken` for hot-loop API calls; the
    // accessible-resources lookup happens early enough that it usually
    // hits the static field, but routing it through the same chokepoint
    // means a long-deferred sync (e.g. the connector was queued while
    // the OS was suspended and now runs hours later) still picks up a
    // refreshed token rather than 401-ing on the very first request.
    // Cheap, defensive, and removes the only remaining caller in this
    // file that bypasses the standard token-resolution path.
    const resources = await listAccessibleResources(
      await resolveAccessToken(ctx),
    );
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

  // Source-by-path index, materialised inside the try block below so
  // an unlikely `bridge.listSources()` throw is caught by the
  // saveState + writeManifest cleanup path (defense-in-depth mirrored
  // from figma.ts; the `!` definite-assignment assertion is safe
  // because every read of `sourceIndex` is inside the try block,
  // after assignment). The cache lets the hot loop's existence
  // check be O(1) instead of the previous
  // `bridge.listSources().find(...)` per-issue scan
  // (O(issues × sources)).
  let sourceIndex!: SourcePathIndex;

  let added = 0;
  let modified = 0;
  // Cascading-deletion counter: incremented in the post-loop pass
  // below when a retry key we asked for via the `key in (…)` JQL
  // clause does NOT come back in the search response *and* the
  // issue used to be tracked in the manifest. Jira does not expose a
  // per-key 404 endpoint, so the absence-of-result signal is the
  // best-available deletion detection. The previous shape declared
  // this `const removed = 0` and never incremented it, leaving
  // Jira's sync result silently mis-counting upstream deletions vs
  // OneDrive/Confluence.
  let removed = 0;
  let watermark = state.lastSyncIso;
  const succeededIds = new Set<string>();
  const failedThisPass: Array<{ remoteId: string; remoteModifiedAt: string | null }> = [];
  // Parallel index over `failedThisPass.remoteId` so the post-loop
  // dedup check is O(1) instead of O(n) per retry key.
  // architectural symmetry). INVARIANT: every push to
  // `failedThisPass` MUST also add to this set — the `recordFailure`
  // helper below is the only call site.
  const failedThisPassIds = new Set<string>();
  const recordFailure = (remoteId: string, remoteModifiedAt: string | null): void => {
    failedThisPass.push({ remoteId, remoteModifiedAt });
    failedThisPassIds.add(remoteId);
  };

  // Fold any carry-forward retry keys into the JQL so the previous
  // pass's failures get re-fetched alongside the normal
  // updated-since scan. Without this, an item that errored mid-sync
  // would be skipped forever (the watermark would advance past its
  // `updated` timestamp on later passes).
  // `loadJiraState` already filters out entries whose remoteId is not
  // JQL-safe (would be mutated by `jqlEscapeKey`), so the values in
  // `state.failedRetries` should already be safe to interpolate.
  // BUT we re-apply `jqlEscapeKey` here at the interpolation site as
  // defense-in-depth: the load-time filter and the use-site
  // interpolation are linked only by a hidden invariant ("loadJiraState
  // already filters"), and a future contributor adding a new
  // failure-recording path that bypasses `loadJiraState` could
  // silently break it without any compile-time signal. Re-escaping at
  // every interpolation site removes that hidden coupling — the JQL
  // safety contract now lives entirely on this expression rather than
  // being split between two distant functions. The double-escape is
  // a no-op for already-JQL-safe keys (identity transformation on the
  // alphanumeric+`-` alphabet), so this is purely a robustness
  // improvement with zero behaviour change today.
  const retryKeys = state.failedRetries.map((e) => jqlEscapeKey(e.remoteId));
  // Strict-validate the watermark before interpolating into JQL.
  // `sanitiseJqlWatermark` returns null on anything that isn't a
  // well-formed ISO-8601 timestamp, which causes the watermark
  // clause below to be dropped entirely — the sync degrades to a
  // full re-scan rather than risking JQL injection from a corrupted
  // state.json. The watermark is always re-derived from issue
  // updates within the same pass, so the next save will restore it.
  const safeWatermark = sanitiseJqlWatermark(watermark);
  const watermarkClause = safeWatermark ? `updated >= "${safeWatermark}"` : null;
  const retryClause =
    retryKeys.length > 0
      ? `key in (${retryKeys.join(",")})`
      : null;
  // JQL composition. The four cases:
  // 1. Valid watermark + retries → `(updated >= W) OR (key in K)`,
  //    so newly-updated issues AND carry-forward retry keys are both
  //    fetched in a single pass.
  // 2. Valid watermark, no retries → `updated >= W ORDER BY …`.
  // 3. No watermark + retries (first sync with pre-existing
  //    retries) → `key in (K) ORDER BY …`. The retries are
  //    re-fetched explicitly; there is no watermark to widen with.
  // 4. No watermark, no retries → bare full scan.
  // The interesting *edge* case is "watermark was present but
  // rejected by `sanitiseJqlWatermark`" AND retries exist.
  // Previously this took path (3), which emitted `key in (K)`
  // alone — silently skipping every issue updated between the
  // corrupt-state sync and the next pass (one-pass-late visibility
  // on every other edit). The correct degraded behaviour: when the
  // watermark was *rejected* (non-null input, null output), degrade
  // to a full scan even when retries exist — retries naturally
  // surface via `ORDER BY updated DESC` because their `updated` is
  // bounded above by the prior pass's watermark.
  const watermarkWasRejected = watermark !== null && safeWatermark === null;
  let jql: string;
  if (watermarkClause && retryClause) {
    jql = `(${watermarkClause}) OR (${retryClause}) ORDER BY updated DESC`;
  } else if (watermarkClause) {
    jql = `${watermarkClause} ORDER BY updated DESC`;
  } else if (retryClause && !watermarkWasRejected) {
    // No watermark ever existed (first sync) but retries are
    // present — fetch them explicitly. This path is NOT taken when
    // the watermark was rejected because the full scan below
    // handles that case more safely.
    jql = `${retryClause} ORDER BY updated DESC`;
  } else {
    // Either (a) no watermark + no retries → first-ever full scan,
    // or (b) watermark was rejected → degraded full scan that self-
    // heals the watermark from the first issue's `updated`.
    jql = `ORDER BY updated DESC`;
  }

  // Wrap the iteration + cleanup + save in try/finally so progress
  // is *always* persisted before the function returns or rethrows.
  // Without this, an unexpected error anywhere inside the loops
  // (network rejection on `searchIssues` after partial pages, a
  // bridge-layer crash, or a future code path that forgets a
  // try/catch) would skip `saveJiraState` and `writeManifest`
  // entirely — making every issue successfully fetched in this pass
  // invisible to the next sync and forcing redundant re-fetching.
  // This mirrors the defense-in-depth pattern in figma.ts.
  try {
    // Materialise the source-by-path index inside the try block so an
    // unlikely `bridge.listSources()` throw is still caught by the
    // saveState + writeManifest cleanup below.
    sourceIndex = SourcePathIndex.fromBridge(ctx.bridge);
    let startAt = 0;
    for (let safety = 0; safety < 1000; safety += 1) {
      // Refresh-on-demand at the top of every JQL page. A wide
      // updated-since scan on a large Jira project can paginate for
      // far longer than the access token's 1h lifetime.
      const accessToken = await resolveAccessToken(ctx);
      const page = await searchIssues(cloudId, accessToken, jql, startAt);
      for (const issue of page.issues) {
        const updated = issue.fields.updated ?? null;
        let body: string;
        try {
          body = renderIssue(issue);
        } catch {
          recordFailure(issue.key, updated);
          continue;
        }
        const localPath = path.join(
          dir,
          `${sanitiseRemoteId(issue.key)}.md`,
        );
        try {
          await fsp.writeFile(localPath, body, "utf8");
        } catch {
          recordFailure(issue.key, updated);
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
            recordFailure(issue.key, updated);
            continue;
          }
          sourceIndex.add(registered);
          added += 1;
        }
        entriesById.set(issue.key, {
          localPath,
          remoteId: issue.key,
          remoteModifiedAt: updated,
        });
        // Use epoch-ms comparison via `maxWatermark` rather than the
        // string compare we used to do — see `parseWatermarkIso` in
        // `syncDir.ts` for the failure mode (mixed `Z` / `+00:00` /
        // millisecond-precision suffixes producing wrong-order results).
        watermark = maxWatermark(watermark, updated);
        succeededIds.add(issue.key);
      }
      startAt += page.issues.length;
      if (startAt >= page.total || page.issues.length === 0) break;
    }

    // Any retry key that the search response did not return at all
    // (e.g. the issue was deleted in Jira, or moved to a project the
    // OAuth scope no longer includes) counts as "succeeded" for the
    // queue's purpose — it's been resolved one way or another and we
    // should stop pinging it every sync. When the key was also
    // present in the prior manifest, cascade the deletion to the
    // local sync dir and the bridge source so the user's index does
    // not keep stale copies of issues they no longer have access to.
    // The dedup check is O(1) via the `failedThisPassIds` parallel
    // Set rather than the legacy O(n) `failedThisPass.some(…)` (the
    // same change is in `figma.ts`).
    for (const key of retryKeys) {
      if (succeededIds.has(key) || failedThisPassIds.has(key)) continue;
      const prior = entriesById.get(key);
      if (prior) {
        const existingSource = sourceIndex.get(prior.localPath);
        if (existingSource) {
          try {
            ctx.bridge.removeSource(existingSource.id);
          } catch {
            // best-effort — a bridge crash here MUST NOT mask the
            // upstream deletion-detection we are reacting to.
          }
          sourceIndex.remove(prior.localPath);
        }
        try {
          await fsp.unlink(prior.localPath);
        } catch {
          // already gone on disk — desired end state.
        }
        entriesById.delete(key);
        removed += 1;
      }
      succeededIds.add(key);
    }
  } finally {
    // Persist progress in a nested try/catch so a state-write error
    // (e.g. disk full) doesn't shadow the original upstream error the
    // try block raised.
    try {
      await saveJiraState(ctx.userDataDir, {
        cloudId,
        lastSyncIso: watermark,
        failedRetries: nextFailedRetryQueue(state.failedRetries, {
          succeeded: succeededIds,
          failed: failedThisPass,
        }),
      });
      await writeManifest(ctx.userDataDir, {
        version: 1,
        provider: "jira",
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
export async function disconnectJira(
  userDataDir: string,
  bridge: JiraBridgeHooks,
): Promise<{ filesRemoved: number }> {
  const manifest = await readManifest(userDataDir, "jira");
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
  await purgeSyncDir(userDataDir, "jira");
  return { filesRemoved };
}
