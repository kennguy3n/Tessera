/**
 * Offline operation queue for KChat write actions.
 *
 * KChat is a remote (Mattermost-v4) service; Tessera is local-first
 * and must degrade gracefully when the server is unreachable. Three
 * user-initiated write actions are expensive to lose:
 *
 *   - `shareArtifact` — exporting an artifact and uploading it to a
 *     channel. The export bytes are reproducible from the artifact,
 *     so we persist the *request* (artifact id + format + flags),
 *     not the rendered bytes, and re-run the export on replay.
 *   - `ingestChannel` — linking a KChat channel as a Tessera source
 *     (`sources:addKchatChannel`). Re-running it is idempotent at
 *     the IPC layer (the in-flight map + `withChannelSyncLock`
 *     collapse duplicates), so a replayed enqueue can never double
 *     up a source row.
 *   - `postTask` — posting a Tessera task to a channel
 *     (`kchat:postTaskToChannel`). We persist the normalised task,
 *     not the rendered message, and re-render with
 *     `formatTaskForKchat` on replay. Only a transport-level failure
 *     (no post was created) queues, so a replay cannot duplicate a
 *     post the server already accepted.
 *
 * When the IPC handler observes an offline error (see
 * {@link isOfflineError}) it enqueues the request instead of
 * failing it. The queue persists to a single JSON file under the
 * Tessera root so a crash or quit between enqueue and reconnect
 * does not drop pending work. On the next `connected` transition
 * the auth-service status listener calls {@link KchatOfflineQueue.replay},
 * which drains the queue in FIFO order through the registered
 * executors.
 *
 * Design notes:
 *   - **No bytes on disk.** Only the minimal request envelope is
 *     persisted. This keeps the queue file small and avoids holding
 *     a stale rendering of an artifact the user may have since
 *     edited — the replay re-exports from the live artifact.
 *   - **FIFO with stop-on-offline.** Replay processes oldest-first.
 *     If an operation fails again with an offline error, replay
 *     stops immediately and keeps the remaining operations queued:
 *     the server is evidently still unreachable, so hammering the
 *     rest wastes rate-limit tokens and would reorder later
 *     successes ahead of this one. A *non-offline* failure (e.g.
 *     the artifact was deleted) increments the attempt counter and,
 *     past {@link MAX_REPLAY_ATTEMPTS}, drops the operation to the
 *     dead-letter list so one poisoned request cannot wedge the
 *     queue forever.
 *   - **Injectable everything.** The constructor takes the file
 *     path, a clock, an id generator, and an `fs` shim so the unit
 *     tests can drive persist/replay deterministically without
 *     touching the real home directory.
 */
import { randomUUID } from "crypto";
import * as fsPromises from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { TaskForKchat } from "./kchatTaskSync";

/** Discriminator for a queued operation. */
export type KchatQueuedOpType =
  | "shareArtifact"
  | "ingestChannel"
  | "postTask";

/** Persisted request envelope for a deferred `shareArtifact`. */
export interface KchatShareArtifactRequest {
  artifactId: string;
  channelId: string;
  format: string;
  includeCitations: boolean;
  includeEvidencePack: boolean;
  /**
   * Delivery mode (`"attachment"` | `"deeplink"`). Optional for
   * backward-compatibility with queue files written before Task 4;
   * a missing value replays as the original attachment behaviour.
   */
  delivery?: string;
}

/** Persisted request envelope for a deferred channel ingest. */
export interface KchatIngestChannelRequest {
  channelId: string;
  channelName: string;
}

/**
 * Persisted request envelope for a deferred `postTaskToChannel`.
 * Only the normalised task plus its target channel is stored; the
 * KChat message body is re-rendered from the task on replay
 * (`formatTaskForKchat`), mirroring how `shareArtifact` re-exports
 * its bytes rather than persisting them.
 */
export interface KchatPostTaskRequest {
  channelId: string;
  task: TaskForKchat;
}

/** Map of op-type to its payload shape. */
export interface KchatQueuedPayloadMap {
  shareArtifact: KchatShareArtifactRequest;
  ingestChannel: KchatIngestChannelRequest;
  postTask: KchatPostTaskRequest;
}

/** A single persisted queue entry. */
export interface KchatQueuedOperation<
  T extends KchatQueuedOpType = KchatQueuedOpType,
> {
  /** Stable id assigned at enqueue time; used for dedupe + logging. */
  id: string;
  type: T;
  payload: KchatQueuedPayloadMap[T];
  /** Epoch ms the request was first queued. */
  enqueuedAt: number;
  /** Number of replay attempts that have failed so far. */
  attempts: number;
  /** Last failure message (scrubbed by the caller), or null. */
  lastError: string | null;
}

/** Executor invoked to actually perform a queued operation on replay. */
export type KchatQueueExecutor<T extends KchatQueuedOpType> = (
  payload: KchatQueuedPayloadMap[T],
) => Promise<void>;

/** Registry of per-type executors supplied by the IPC layer. */
export interface KchatQueueExecutors {
  shareArtifact?: KchatQueueExecutor<"shareArtifact">;
  ingestChannel?: KchatQueueExecutor<"ingestChannel">;
  postTask?: KchatQueueExecutor<"postTask">;
}

/** Outcome summary returned by {@link KchatOfflineQueue.replay}. */
export interface KchatReplaySummary {
  /** Operations that executed successfully and were removed. */
  replayed: number;
  /** Operations dropped to dead-letter after exhausting attempts. */
  deadLettered: number;
  /** Operations still queued (server still offline or not yet reached). */
  remaining: number;
}

/** Minimal `fs/promises` surface the queue depends on (injectable). */
export interface KchatQueueFs {
  readFile(p: string, enc: "utf8"): Promise<string>;
  writeFile(p: string, data: string, enc: "utf8"): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(p: string, opts: { recursive: true }): Promise<unknown>;
}

export interface KchatOfflineQueueOptions {
  /** Absolute path of the JSON queue file. */
  filePath?: string;
  /** Clock for `enqueuedAt`; defaults to `Date.now`. */
  now?: () => number;
  /** Id generator; defaults to `crypto.randomUUID`. */
  randomId?: () => string;
  /** `fs/promises` shim; defaults to the real module. */
  fs?: KchatQueueFs;
}

/**
 * Past this many failed replays an operation is dead-lettered
 * rather than retried forever. Offline failures do NOT count
 * toward this cap (they stop replay without incrementing), so the
 * counter only advances on genuine, non-transient errors.
 */
export const MAX_REPLAY_ATTEMPTS = 5;

/**
 * Maximum `cause`-chain depth {@link isOfflineError} walks. Node's
 * `fetch` nests the transport errno at most ~2 levels deep; the cap
 * bounds the recursion so a corrupted or adversarial cyclic chain
 * can't run away even though the `cause !== err` self-reference
 * guard catches the trivial single-hop loop.
 */
const MAX_CAUSE_DEPTH = 5;

/** Current on-disk schema version for the queue file. */
const QUEUE_SCHEMA_VERSION = 1;

interface PersistedQueueFile {
  version: number;
  operations: KchatQueuedOperation[];
}

/**
 * Default queue-file location: `~/.tessera/kchat-offline-queue.json`.
 * Lives alongside the channel cache dir root so a single
 * `~/.tessera` cleanup removes all KChat local state.
 */
export function defaultOfflineQueuePath(): string {
  return path.join(os.homedir(), ".tessera", "kchat-offline-queue.json");
}

/**
 * Does `err` carry the `nonReplayableCommit` marker? Such an error
 * signals a multi-phase operation that has already committed an
 * irreversible side-effect (e.g. a `shareArtifact` whose primary upload
 * landed before the evidence-pack phase failed). Re-running the whole
 * request would duplicate that side-effect, so the operation must never
 * be offline-queued ({@link isOfflineError} returns false for it) and
 * must never be retried on replay (it is dead-lettered immediately).
 */
export function isNonReplayableCommit(err: unknown): boolean {
  return (
    err != null &&
    (err as { nonReplayableCommit?: unknown }).nonReplayableCommit === true
  );
}

/**
 * Heuristic: does `err` indicate the KChat server was **unreachable**
 * — i.e. the request never produced an HTTP response — as opposed to
 * a server that responded with an error status?
 *
 * Only genuine transport-level failures are treated as "queue, don't
 * fail":
 *   - Node `fetch` network failures: `TypeError: fetch failed`
 *     with a `cause` carrying an errno code
 *     (`ENOTFOUND`/`ECONNREFUSED`/`ETIMEDOUT`/`EAI_AGAIN`/…).
 *   - An AbortError / timeout surfaced by the client.
 *   - The client's own "not configured / not connected" guards.
 *
 * A request that produced **any** HTTP response — including 5xx and
 * 429 — is NOT offline. The server is reachable; the operation
 * failed server-side, and `KchatClient` already exhausts its retry
 * budget on the retryable statuses before surfacing the error. The
 * upload/post paths (`uploadFile`, `createPost`) deliberately surface
 * 5xx immediately (see `NON_IDEMPOTENT_RETRYABLE_STATUSES` in
 * `kchatClient.ts`) so the IPC handler can re-throw it to the user;
 * silently queueing a 5xx would hide a real server fault and risk a
 * duplicate side-effect on replay. Status-bearing errors therefore
 * short-circuit to `false` here — this also prevents a server error
 * body that happens to contain a word like "offline" from being
 * misclassified as a connectivity failure.
 */
export function isOfflineError(err: unknown): boolean {
  return isOfflineErrorAtDepth(err, 0);
}

/**
 * Recursive worker for {@link isOfflineError}. The `depth` parameter
 * is an implementation detail of the `cause`-chain walk and is kept
 * off the public signature; callers always start at depth 0 via the
 * wrapper above.
 */
function isOfflineErrorAtDepth(err: unknown, depth: number): boolean {
  if (err == null) return false;

  // A post-commit failure is not safely replayable — surface it to the
  // user instead of offline-queueing. Checked first, ahead of the
  // `cause` recursion below, so a wrapped transport error can't leak
  // back through as "offline".
  if (isNonReplayableCommit(err)) return false;

  // Duck-type KchatRequestError without importing it (avoids a
  // cycle with kchatClient). A numeric `status` means the server
  // responded — by definition reachable, so never offline.
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return false;

  const rawMessage = errorMessage(err);
  // The IPC layer can re-synthesise `KchatRequestError` as a plain
  // `Error` whose message is `KChat <status> <statusText>: <endpoint>`
  // (the numeric `status` is lost in that rewrite). That still
  // represents a server response, so it is NOT offline either.
  if (/\bKChat \d{3}\b/.test(rawMessage)) return false;

  const message = rawMessage.toLowerCase();
  // Only specific transport-level signals count. Deliberately NOT the
  // bare word "network": it is not a real Node/undici failure string
  // and over-matches arbitrary application errors (e.g. a mid-sync
  // "transient network error" that the convergent-sync resume path
  // already handles by rejecting). Genuine unreachability always
  // surfaces as one of the concrete signals below.
  const offlineNeedles = [
    "fetch failed",
    "econnrefused",
    "enotfound",
    "etimedout",
    "eai_again",
    "econnreset",
    "socket hang up",
    "timed out",
    "getaddrinfo",
    "not configured",
    "not connected",
  ];
  if (offlineNeedles.some((needle) => message.includes(needle))) return true;

  // Inspect a wrapped `cause` (Node's fetch nests the errno here).
  // Node's `fetch` nests at most ~2 levels, so cap the recursion to
  // stay robust against a corrupted/adversarial cyclic cause chain
  // (e.g. `a.cause = b; b.cause = a`) that the `cause !== err`
  // self-reference guard alone wouldn't catch.
  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err && depth < MAX_CAUSE_DEPTH) {
    return isOfflineErrorAtDepth(cause, depth + 1);
  }

  // AbortError surfaced by an aborted/timed-out request.
  const name = (err as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/** Extract a string message from an arbitrary thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export class KchatOfflineQueue {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly fs: KchatQueueFs;

  private operations: KchatQueuedOperation[] = [];
  private executors: KchatQueueExecutors = {};
  private loaded = false;
  /** Serialises replays so a reconnect storm can't double-drain. */
  private replayInFlight: Promise<KchatReplaySummary> | null = null;
  /**
   * Tail of the persist chain. Every {@link persist} call appends to
   * this promise so writes run strictly one-at-a-time (single writer),
   * even though `enqueue` and `replay` invoke `persist` independently.
   */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(options: KchatOfflineQueueOptions = {}) {
    this.filePath = options.filePath ?? defaultOfflineQueuePath();
    this.now = options.now ?? (() => Date.now());
    this.randomId = options.randomId ?? (() => randomUUID());
    this.fs = options.fs ?? (fsPromises as unknown as KchatQueueFs);
  }

  /** Register the executors used to perform operations on replay. */
  setExecutors(executors: KchatQueueExecutors): void {
    this.executors = { ...this.executors, ...executors };
  }

  /** Number of operations currently queued (after load). */
  size(): number {
    return this.operations.length;
  }

  /** Immutable snapshot of the queued operations. */
  list(): ReadonlyArray<KchatQueuedOperation> {
    return this.operations.map((op) => ({ ...op }));
  }

  /**
   * Load the queue from disk into memory. Idempotent: subsequent
   * calls are no-ops unless {@link reset} cleared the loaded flag.
   * A missing or corrupt file resets to an empty queue (best
   * effort — a single bad write must never wedge all future
   * shares).
   */
  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await this.fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedQueueFile>;
      this.operations = sanitizeOperations(parsed?.operations);
    } catch {
      // ENOENT on first run, or a malformed/partial file. Either
      // way the safe state is an empty queue.
      this.operations = [];
    }
    this.loaded = true;
  }

  /**
   * Enqueue a `shareArtifact` request. Returns the assigned id so
   * the IPC layer can surface it to the renderer ("queued for
   * delivery") and tests can assert ordering.
   */
  async enqueueShareArtifact(
    payload: KchatShareArtifactRequest,
  ): Promise<string> {
    return this.enqueue("shareArtifact", payload);
  }

  /** Enqueue a channel-ingest request. */
  async enqueueIngestChannel(
    payload: KchatIngestChannelRequest,
  ): Promise<string> {
    return this.enqueue("ingestChannel", payload);
  }

  /** Enqueue a deferred task-post request. */
  async enqueuePostTask(payload: KchatPostTaskRequest): Promise<string> {
    return this.enqueue("postTask", payload);
  }

  private async enqueue<T extends KchatQueuedOpType>(
    type: T,
    payload: KchatQueuedPayloadMap[T],
  ): Promise<string> {
    await this.load();
    const id = this.randomId();
    const op: KchatQueuedOperation<T> = {
      id,
      type,
      payload,
      enqueuedAt: this.now(),
      attempts: 0,
      lastError: null,
    };
    // Collapse an exact duplicate already pending (same type +
    // identical payload). A double-click while offline should not
    // enqueue the same share twice — the replay would upload two
    // identical files. When a duplicate exists we return *its* id
    // rather than the freshly generated one: the caller surfaces the
    // returned id to the renderer as `queueId`, and a phantom id that
    // matches no entry in `list()` would break any subsequent
    // `kchat:offlineQueueStatus` lookup the renderer does.
    const existing = this.findDuplicate(op as KchatQueuedOperation);
    if (existing) return existing.id;
    this.operations.push(op as KchatQueuedOperation);
    await this.persist();
    return id;
  }

  private findDuplicate(
    candidate: KchatQueuedOperation,
  ): KchatQueuedOperation | undefined {
    const key = duplicateKey(candidate);
    return this.operations.find((op) => duplicateKey(op) === key);
  }

  /**
   * Drain the queue in FIFO order through the registered
   * executors. Concurrency-safe: a replay already in flight is
   * returned to the second caller rather than starting a second
   * drain (two near-simultaneous `connected` transitions must not
   * race the same operations).
   */
  async replay(): Promise<KchatReplaySummary> {
    if (this.replayInFlight) return this.replayInFlight;
    this.replayInFlight = this.runReplay();
    try {
      return await this.replayInFlight;
    } finally {
      this.replayInFlight = null;
    }
  }

  private async runReplay(): Promise<KchatReplaySummary> {
    await this.load();
    let replayed = 0;
    let deadLettered = 0;
    const remaining: KchatQueuedOperation[] = [];
    let serverOffline = false;

    for (const op of this.operations) {
      if (serverOffline) {
        // The server is unreachable again; keep every later op in
        // its original order for the next reconnect.
        remaining.push(op);
        continue;
      }
      const executor = this.executorFor(op.type);
      if (!executor) {
        // No executor wired (shouldn't happen in production). Keep
        // the op so a correctly-wired process can replay it later.
        remaining.push(op);
        continue;
      }
      try {
        await executor(op.payload as never);
        replayed += 1;
      } catch (err) {
        if (isNonReplayableCommit(err)) {
          // The operation already committed an irreversible side-effect
          // on this attempt (e.g. the primary upload landed before the
          // evidence pack failed). Retrying would duplicate it, so drop
          // the op immediately rather than re-queue it.
          op.lastError = errorMessage(err);
          deadLettered += 1;
          continue;
        }
        if (isOfflineError(err)) {
          // Still offline — stop draining, preserve order, do NOT
          // count this as a failed attempt.
          op.lastError = errorMessage(err);
          remaining.push(op);
          serverOffline = true;
          continue;
        }
        // Deterministic failure: count the attempt and dead-letter
        // once the cap is hit so one bad op can't block the rest.
        op.attempts += 1;
        op.lastError = errorMessage(err);
        if (op.attempts >= MAX_REPLAY_ATTEMPTS) {
          deadLettered += 1;
        } else {
          remaining.push(op);
        }
      }
    }

    this.operations = remaining;
    await this.persist();
    return { replayed, deadLettered, remaining: remaining.length };
  }

  private executorFor(
    type: KchatQueuedOpType,
  ): KchatQueueExecutor<KchatQueuedOpType> | undefined {
    return this.executors[type] as
      | KchatQueueExecutor<KchatQueuedOpType>
      | undefined;
  }

  /** Remove all queued operations and persist the empty state. */
  async clear(): Promise<void> {
    await this.load();
    this.operations = [];
    await this.persist();
  }

  /**
   * Reset in-memory state so the next {@link load} re-reads disk.
   * Test-only helper; production never needs to forget the queue.
   */
  _resetForTest(): void {
    this.operations = [];
    this.loaded = false;
    this.replayInFlight = null;
    this.persistChain = Promise.resolve();
  }

  /**
   * Persist the queue with an atomic write (tmp + rename) so a crash
   * mid-write cannot truncate the queue file.
   *
   * `enqueue` and `replay` both call `persist` and are not serialised
   * against each other, which exposes two distinct hazards that a
   * single shared `.tmp` path cannot solve on its own:
   *
   *   1. **Interleaved writes.** Two overlapping `writeFile` + `rename`
   *      sequences sharing one temp path can move the wrong content.
   *   2. **Stale-snapshot lost update.** Even with distinct temp paths,
   *      if `replay` serialises its post-drain snapshot and an
   *      `enqueue` then appends + persists before `replay`'s `rename`
   *      lands, `replay`'s later `rename` overwrites the queue file
   *      with the stale snapshot — the just-enqueued op survives in
   *      memory but is lost on disk until the next write.
   *
   * Both are eliminated by making persistence a strict single writer:
   * each call appends to {@link persistChain} and only snapshots
   * `this.operations` once its turn actually runs, so the last write
   * always reflects the latest in-memory state and no two writes
   * overlap. The unique temp suffix (`pid` + random token) is kept as
   * defence-in-depth (e.g. a second process pointed at the same file)
   * and uses `randomUUID` directly — not the injectable `randomId` —
   * so it never perturbs the operation-id sequence tests depend on.
   */
  private persist(): Promise<void> {
    const run = this.persistChain.then(() => this.writeSnapshot());
    // Keep the chain alive even when a write rejects so a single failed
    // persist does not wedge every subsequent one; the rejection is
    // still surfaced to *this* caller via the returned `run`.
    this.persistChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Serialise the current in-memory queue to disk atomically. Always
   * invoked from within the {@link persistChain} turn, so `JSON.stringify`
   * captures a consistent snapshot of `this.operations` at the moment
   * this write runs.
   */
  private async writeSnapshot(): Promise<void> {
    const payload: PersistedQueueFile = {
      version: QUEUE_SCHEMA_VERSION,
      operations: this.operations,
    };
    const serialized = JSON.stringify(payload, null, 2);
    await this.fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await this.fs.writeFile(tmp, serialized, "utf8");
    await this.fs.rename(tmp, this.filePath);
  }
}

/** Stable dedupe key for an operation (type + payload identity). */
function duplicateKey(op: KchatQueuedOperation): string {
  return `${op.type}:${JSON.stringify(op.payload)}`;
}

/**
 * Validate and normalise operations read from disk, discarding any
 * entry that doesn't match the expected shape (defends against a
 * hand-edited or version-skewed file).
 */
function sanitizeOperations(value: unknown): KchatQueuedOperation[] {
  if (!Array.isArray(value)) return [];
  const out: KchatQueuedOperation[] = [];
  for (const entry of value) {
    const op = sanitizeOperation(entry);
    if (op) out.push(op);
  }
  return out;
}

function sanitizeOperation(value: unknown): KchatQueuedOperation | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  const type = rec.type;
  if (
    type !== "shareArtifact" &&
    type !== "ingestChannel" &&
    type !== "postTask"
  ) {
    return null;
  }
  const payload = sanitizePayload(type, rec.payload);
  if (!payload) return null;
  const id = typeof rec.id === "string" && rec.id.length > 0 ? rec.id : null;
  if (!id) return null;
  return {
    id,
    type,
    payload,
    enqueuedAt:
      typeof rec.enqueuedAt === "number" && Number.isFinite(rec.enqueuedAt)
        ? rec.enqueuedAt
        : 0,
    attempts:
      typeof rec.attempts === "number" && Number.isFinite(rec.attempts)
        ? rec.attempts
        : 0,
    lastError: typeof rec.lastError === "string" ? rec.lastError : null,
  };
}

function sanitizePayload(
  type: KchatQueuedOpType,
  value: unknown,
): KchatQueuedPayloadMap[KchatQueuedOpType] | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (type === "shareArtifact") {
    if (
      typeof rec.artifactId !== "string" ||
      typeof rec.channelId !== "string" ||
      typeof rec.format !== "string"
    ) {
      return null;
    }
    return {
      artifactId: rec.artifactId,
      channelId: rec.channelId,
      format: rec.format,
      includeCitations: rec.includeCitations === true,
      includeEvidencePack: rec.includeEvidencePack === true,
      ...(typeof rec.delivery === "string"
        ? { delivery: rec.delivery }
        : {}),
    };
  }
  if (type === "postTask") {
    if (typeof rec.channelId !== "string") return null;
    const task = sanitizeTaskForKchat(rec.task);
    if (!task) return null;
    return { channelId: rec.channelId, task };
  }
  // ingestChannel
  if (typeof rec.channelId !== "string" || typeof rec.channelName !== "string") {
    return null;
  }
  return { channelId: rec.channelId, channelName: rec.channelName };
}

/**
 * Validate a persisted {@link TaskForKchat}. `id` and `title` are
 * required; the remaining fields are optional strings that are only
 * carried through when present, so a version-skewed or hand-edited
 * file can never inject a non-string into the re-render path.
 */
function sanitizeTaskForKchat(value: unknown): TaskForKchat | null {
  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  if (typeof rec.id !== "string" || typeof rec.title !== "string") return null;
  const task: TaskForKchat = { id: rec.id, title: rec.title };
  if (typeof rec.description === "string") task.description = rec.description;
  if (typeof rec.status === "string") task.status = rec.status;
  if (typeof rec.priority === "string") task.priority = rec.priority;
  if (typeof rec.dueDate === "string") task.dueDate = rec.dueDate;
  if (typeof rec.assignee === "string") task.assignee = rec.assignee;
  return task;
}
