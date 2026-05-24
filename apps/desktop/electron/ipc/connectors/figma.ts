/**
 * Figma connector sync logic.
 *
 * Authentication: Figma OAuth 2.0 (`figma.com/oauth`,
 * `api.figma.com/v1/oauth/token`).
 *
 * Sync model: Figma's API does not surface a "list all files I can
 * see" endpoint. Instead we list the user's teams via the (now
 * Personal-style) `/v1/me` endpoint to recover a team_id, then list
 * each team's projects → files. For each file we GET `/v1/files/{key}`
 * with `depth=4` (no rasterisation; tractable response size while still
 * surfacing the TEXT nodes and component metadata we index) and extract:
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
  isAfterWatermark,
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
import { isNetworkError } from "./networkErrors";

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
    // Attach the HTTP status on the thrown error so the retry-queue
    // logic in `syncFigma` can distinguish "file was deleted /
    // unshared" (4xx → stop retrying) from "transient network or
    // server failure" (anything else → keep retrying).
    const err = new Error(
      `Figma get file failed: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    ) as Error & { status?: number };
    err.status = resp.status;
    throw err;
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
  /**
   * File keys the previous sync attempted but failed to fetch or
   * write. The next pass forcibly re-fetches each one (by id, via
   * the regular `/files/{key}` endpoint) before applying the
   * watermark filter — otherwise the watermark would advance past
   * the failed file's `last_modified` and the file would never be
   * retried until the user edited it again. See `nextFailedRetryQueue`
   * in `syncDir.ts` for the carry-forward semantics this list feeds.
   */
  failedRetries: FailedRetryEntry[];
}

function statePath(userDataDir: string): string {
  return path.join(syncDirFor(userDataDir, "figma"), "state.json");
}

async function loadState(userDataDir: string): Promise<FigmaState> {
  try {
    const raw = await fsp.readFile(statePath(userDataDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<FigmaState>;
    return {
      lastSyncIso: parsed.lastSyncIso ?? null,
      teamIds: Array.isArray(parsed.teamIds) ? parsed.teamIds : [],
      failedRetries: Array.isArray(parsed.failedRetries)
        ? parsed.failedRetries
        : [],
    };
  } catch {
    return { lastSyncIso: null, teamIds: [], failedRetries: [] };
  }
}

async function saveState(userDataDir: string, s: FigmaState): Promise<void> {
  await fsp.mkdir(syncDirFor(userDataDir, "figma"), { recursive: true });
  await fsp.writeFile(statePath(userDataDir), JSON.stringify(s), "utf8");
}

export async function syncFigma(ctx: {
  accessToken: string;
  /** Just-in-time refresh hook — called per team/project/file so a
   *  multi-team scan does NOT outlive the access token. */
  getAccessToken?: () => Promise<string>;
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
    // Mirror the Jira/Confluence pattern: route this initial
    // team-discovery call through the same JIT-refresh chokepoint
    // (`resolveAccessToken`) as every per-file fetch later in the
    // function, instead of bypassing it via the static
    // `ctx.accessToken`. Figma was the only remaining caller in this
    // file using the static token, making it the lone exception to
    // the pattern the rest of the file follows. The risk this closes
    // matches Jira/Confluence exactly: a long-deferred sync (e.g. the
    // Electron app was suspended by the OS and resumed hours later)
    // would hit this call with an expired access token, `listTeams`
    // would silently return `[]` (its 401 → `return []` fallback),
    // the `no-teams` early-return below would fire, and the user
    // would see "no team membership" in the UI when the actual
    // problem is a refreshable token expiry.
    const teams = await listTeams(await resolveAccessToken(ctx));
    teamIds = teams.map((t) => t.id);
  }
  if (teamIds.length === 0) {
    // The OAuth scope may not have surfaced teams. Persist an empty
    // sync rather than crashing — the user gets an actionable
    // "no team membership" Toast at the UI layer. Preserve any
    // pending failed-retry entries so the next pass (once teams are
    // available) can still recover them.
    await saveState(ctx.userDataDir, {
      lastSyncIso: state.lastSyncIso,
      teamIds: [],
      failedRetries: state.failedRetries,
    });
    return { added: 0, modified: 0, removed: 0, status: "no-teams" };
  }

  const manifest = await readManifest(ctx.userDataDir, "figma");
  const entriesById = new Map<string, SyncManifestEntry>();
  for (const e of manifest.entries) entriesById.set(e.remoteId, e);

  // Source-by-path index, materialised ONCE per sync pass inside the
  // try block below so the hot loop's existence check is O(1)
  // instead of the previous `bridge.listSources().find(...)` per-file
  // scan (O(files × sources)). Declared here as a `let` so the
  // `syncFileByKey` closure can reference it; assigned inside the
  // try/finally block so an unlikely `bridge.listSources()` throw at
  // the top of the sync is still caught by the saveState +
  // writeManifest cleanup path (matches the defense-in-depth contract
  // exercised by the listSources-throw regression test in
  // `connectorsSync.test.ts`).
  let sourceIndex!: SourcePathIndex;

  let added = 0;
  let modified = 0;
  // Cascading-deletion counter: incremented in `syncFileByKey` when
  // `getFile` returns 404/410 *and* the file used to be tracked in
  // the manifest (i.e. we cleaned up a local file + bridge source
  // that the user no longer has access to). The previous shape
  // declared this `const removed = 0` and never incremented it,
  // leaving Figma's renderer-facing sync result silently mis-counting
  // upstream deletions — an asymmetry vs OneDrive/Confluence that
  // is now resolved here, in `notion.ts`, and in `jira.ts` so all
  // six providers agree on what `removed` means in the IPC payload.
  let removed = 0;
  // The previous-sync watermark is read-only during this run and used
  // solely to decide which files to skip. The new watermark we will
  // persist is tracked separately. Conflating the two caused the bug
  // where the first sync (with `state.lastSyncIso === null`) wrote
  // the first file's timestamp into `watermark` mid-loop, then
  // skipped every subsequent file with an equal-or-earlier
  // `last_modified` for the rest of the run — silently dropping the
  // majority of the user's files.
  const compareWatermark = state.lastSyncIso;
  let nextWatermark = state.lastSyncIso;

  const succeededIds = new Set<string>();
  const failedThisPass: Array<{ remoteId: string; remoteModifiedAt: string | null }> = [];
  // Parallel index over `failedThisPass.remoteId` so the Phase-2
  // dedup check is O(1) instead of O(n) per file. For a Figma
  // account with many teams and a noisy Phase 1 (transient 5xx on
  // dozens of files), the legacy `failedThisPass.some(…)` made the
  // outer loop quadratic.
  // INVARIANT: every push to `failedThisPass` MUST also add to this
  // set — the `recordFailure` helper below is the only call site.
  const failedThisPassIds = new Set<string>();
  const recordFailure = (remoteId: string, remoteModifiedAt: string | null): void => {
    failedThisPass.push({ remoteId, remoteModifiedAt });
    failedThisPassIds.add(remoteId);
  };
  // File keys still owed a retry after this pass. Items get removed
  // from this set as we observe them (either successfully synced or
  // confirmed-gone via 404). Anything that remains at end-of-pass
  // gets re-recorded as a failure by the post-loop sweep below so
  // the retry queue carries it forward — see the post-loop sweep
  // for why the legacy "mark survivors as succeeded" default was
  // unsafe.
  const pendingRetries = new Set(state.failedRetries.map((e) => e.remoteId));

  /**
   * Sync one file by key. Records success/failure on the per-pass
   * trackers above and writes the local file + manifest entry. Used
   * by both the watermark scan (which passes the summary it already
   * has from `listProjectFiles`) and the retry phase below (which
   * fetches the file directly with no preceding listing).
   */
  const syncFileByKey = async (
    fileKey: string,
    remoteModifiedAt: string | null,
  ): Promise<void> => {
    // Refresh-on-demand at the top of every file. The retry queue
    // and watermark scan both call into here, and each file fetches
    // both metadata and comments — so the token may expire mid-pass
    // on a large account.
    const accessToken = await resolveAccessToken(ctx);
    let file: FigmaFile;
    try {
      file = await getFile(fileKey, accessToken);
    } catch (err) {
      // NetworkError from a `getFile` mid-pass means transport failed
      // (DNS, socket reset, undici-level abort) — NOT a per-file
      // problem we should record in the retry queue. If we swallow
      // it here, the per-file `failureCount` advances toward
      // `FAILED_RETRY_MAX_ATTEMPTS` for files that are perfectly
      // fine, just temporarily unreachable, and after enough offline
      // syncs we'd evict legitimate files from the queue entirely.
      // Bubble it up so `runConnectorSync` (`handlers.ts:476`) turns
      // the whole pass into `{ status: 'offline' }`. The 404/410
      // cascade and the generic `recordFailure` branch below remain
      // for actual API-level errors.
      if (isNetworkError(err)) throw err;
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 410) {
        // File was deleted or unshared — cascade the deletion to
        // the local sync dir and the bridge source registry so the
        // user's index does not keep stale copies of files they no
        // longer have access to. Previously this branch only
        // stopped retrying and silently kept the local file +
        // source entry, which surfaced as an inconsistency vs
        // OneDrive (`onedrive.ts` deleted-item branch) and
        // Confluence (`confluence.ts` post-loop carry-forward).
        const prior = entriesById.get(fileKey);
        if (prior) {
          const existingSource = sourceIndex.get(prior.localPath);
          if (existingSource) {
            try {
              ctx.bridge.removeSource(existingSource.id);
            } catch {
              // best-effort — a bridge crash here MUST NOT mask the
              // upstream 404 we are reacting to.
            }
            sourceIndex.remove(prior.localPath);
          }
          try {
            await fsp.unlink(prior.localPath);
          } catch {
            // already gone on disk — desired end state.
          }
          entriesById.delete(fileKey);
          removed += 1;
        }
        pendingRetries.delete(fileKey);
        succeededIds.add(fileKey);
        return;
      }
      recordFailure(fileKey, remoteModifiedAt);
      return;
    }
    // Comments are a best-effort enrichment, not the indexable
    // payload — losing them must NOT abort the rest of the sync.
    // `getComments` already swallows HTTP errors (returns `[]`), but a
    // fetch-level rejection (DNS failure, socket reset mid-stream)
    // would otherwise propagate out of `syncFileByKey`, escape both
    // the Phase 1 retry loop and the Phase 2 watermark scan, and skip
    // the `saveState` / `writeManifest` calls at the bottom of
    // `syncFigma` — losing every successful file in the same pass.
    let comments: FigmaComment[];
    try {
      comments = await getComments(fileKey, accessToken);
    } catch {
      comments = [];
    }
    const body = renderFigmaFile(fileKey, file, comments);

    const localPath = path.join(dir, `${sanitiseRemoteId(fileKey)}.md`);
    try {
      await fsp.writeFile(localPath, body, "utf8");
    } catch {
      recordFailure(fileKey, remoteModifiedAt);
      return;
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
        recordFailure(fileKey, remoteModifiedAt);
        return;
      }
      sourceIndex.add(registered);
      added += 1;
    }
    entriesById.set(fileKey, {
      localPath,
      remoteId: fileKey,
      remoteModifiedAt,
    });
    // Use epoch-ms comparison via `maxWatermark` rather than the
    // string compare we used to do — see `parseWatermarkIso` in
    // `syncDir.ts` for the failure mode (mixed `Z` / `+00:00` /
    // millisecond-precision suffixes producing wrong-order results).
    nextWatermark = maxWatermark(nextWatermark, remoteModifiedAt);
    pendingRetries.delete(fileKey);
    succeededIds.add(fileKey);
  };

  // Wrap both phases in try/finally so progress is *always* persisted
  // before the function returns or rethrows. Without this, an
  // unexpected error anywhere inside the loops (network rejection on
  // a non-`getFile` call site, a bridge-layer crash, a future code
  // path that forgets a try/catch) would skip `saveState` and
  // `writeManifest` entirely — making every file successfully fetched
  // in this pass invisible to the next sync and forcing redundant
  // re-fetching.
  try {
    // Materialise the source-by-path index inside the try block so an
    // unlikely `bridge.listSources()` throw is still caught by the
    // saveState + writeManifest cleanup below — see the regression
    // test "persists the watermark + manifest even when the iteration
    // throws an unexpected error" in `connectorsSync.test.ts`.
    sourceIndex = SourcePathIndex.fromBridge(ctx.bridge);

    // Phase 1 — explicitly retry every file the previous pass failed
    // on. We have no `last_modified` for retries at this point, so we
    // pass through `null` and let the watermark advance only when the
    // watermark scan below sees newer files.
    for (const entry of state.failedRetries) {
      await syncFileByKey(entry.remoteId, entry.remoteModifiedAt);
    }

    // Phase 2 — the normal watermark-filtered scan.
    for (const teamId of teamIds) {
      let projects: FigmaProject[];
      try {
        // Refresh-on-demand per team. Multi-team accounts can
        // outlive a 1h access token here.
        const accessToken = await resolveAccessToken(ctx);
        projects = await listProjects(teamId, accessToken);
      } catch (err) {
        // NetworkError must NOT be swallowed: it means the access
        // token refresh failed because the host is offline, or the
        // listing call itself failed transport-level. Either way the
        // correct surface is `{ status: 'offline' }` from
        // `runConnectorSync` (`handlers.ts:476`), not a `continue`
        // that silently turns into `{ status: 'synced', added: 0 }`.
        // Non-network errors (API-level 5xx for a single team, perm
        // revoked since accessible-resources was called, etc.) keep
        // the per-team skip behaviour.
        if (isNetworkError(err)) throw err;
        continue;
      }
      for (const project of projects) {
        let files: FigmaFileSummary[];
        try {
          // Refresh per project too — listProjectFiles is a single
          // call but the loop body below can take a while (one
          // getFile + one getComments per file). Keeps the refresh
          // footprint tight.
          const accessToken = await resolveAccessToken(ctx);
          files = await listProjectFiles(project.id, accessToken);
        } catch (err) {
          // Same rationale as the per-team catch above: NetworkError
          // means offline and must bubble up; API-level errors stay
          // per-project.
          if (isNetworkError(err)) throw err;
          continue;
        }
        for (const summary of files) {
          // `isAfterWatermark` parses both sides to epoch ms before
          // comparing — see `parseWatermarkIso` in `syncDir.ts`. The
          // previous lexicographic compare on raw ISO strings would
          // produce wrong results if Figma ever mixes timezone
          // suffixes (it currently does not, but the hardening
          // closes that hypothetical mismatch).
          if (
            compareWatermark &&
            !isAfterWatermark(summary.last_modified, compareWatermark)
          ) {
            continue;
          }
          // O(1) dedup via the parallel Set; the legacy O(n) linear
          // `failedThisPass.some(...)` made the outer loop quadratic
          // on accounts with noisy Phase 1 retries.
          if (succeededIds.has(summary.key) || failedThisPassIds.has(summary.key)) {
            // Already handled in Phase 1; skip the duplicate fetch.
            continue;
          }
          await syncFileByKey(summary.key, summary.last_modified);
        }
      }
    }

    // Post-loop sweep over any retry key that survived both phases
    // without being explicitly succeeded or failed. By construction
    // this should be the empty set: Phase 1 iterates every entry in
    // `state.failedRetries` via `syncFileByKey`, which routes to
    // exactly one of three terminal paths per call —
    //   (a) success → `succeededIds.add` + `pendingRetries.delete`,
    //   (b) 404/410 cascade → `succeededIds.add` + `pendingRetries.delete`,
    //   (c) `recordFailure(...)` → `failedThisPassIds.add`.
    // likewise either succeeds (path a) or records a
    // failure (path c) for every file it touches. So under the
    // current code shape, no key reaches this loop without being in
    // one of the two sets.
    // The previous shape exploited this and *unconditionally* added
    // orphan keys to `succeededIds` ("file moved out of accessible
    // project, stop retrying it"). The hidden assumption that the
    // loop body is dead made it a foot-gun for the next maintainer:
    // any new error path that left a retry key un-recorded — a
    // `resolveAccessToken` throw inside a future Promise.all batch,
    // an early `return` added to `syncFileByKey`, a team-listProjects
    // failure that silently skips files — would clear the entries
    // from the retry queue without ever calling the upstream API.
    // The user would never see the retry counter advance toward
    // `FAILED_RETRY_MAX_ATTEMPTS`; they'd just notice files quietly
    // dropping out of sync.
    // Flip the default to *preserve* instead of *drop*: any orphan
    // key gets re-recorded as a failure so `nextFailedRetryQueue`
    // carries it forward with one increment to `failureCount`,
    // matching the conservative semantics every other connector
    // already uses for unhandled error paths. Production behaviour
    // is unchanged whenever the invariant holds; the only
    // observable difference is that an as-yet-unwritten bug in this
    // file would now show up as "retry counter creeps up on a file
    // we never actually fetched" instead of "file silently vanished
    // from the retry queue", which is the strictly better failure
    // mode.
    for (const key of pendingRetries) {
      if (succeededIds.has(key) || failedThisPassIds.has(key)) continue;
      const prior = state.failedRetries.find((e) => e.remoteId === key);
      recordFailure(key, prior?.remoteModifiedAt ?? null);
    }
  } finally {
    // Persist progress in a nested try/catch so a state-write error
    // (e.g. disk full) doesn't shadow the original upstream error the
    // try block raised.
    try {
      await saveState(ctx.userDataDir, {
        lastSyncIso: nextWatermark,
        teamIds,
        failedRetries: nextFailedRetryQueue(state.failedRetries, {
          succeeded: succeededIds,
          failed: failedThisPass,
        }),
      });
      await writeManifest(ctx.userDataDir, {
        version: 1,
        provider: "figma",
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
export async function disconnectFigma(
  userDataDir: string,
  bridge: FigmaBridgeHooks,
): Promise<{ filesRemoved: number }> {
  const manifest = await readManifest(userDataDir, "figma");
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
  await purgeSyncDir(userDataDir, "figma");
  return { filesRemoved };
}

export const __test = { collectTextNodes, renderFigmaFile };
