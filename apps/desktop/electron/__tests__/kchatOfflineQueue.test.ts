/**
 * Unit tests for the KChat offline write queue (Session 8 Task 1).
 *
 * Drives persist/replay deterministically through an in-memory `fs`
 * shim, a fixed clock, and a deterministic id generator so no real
 * home directory or wall clock is touched. Covers:
 *   - FIFO replay order through registered executors
 *   - persistence across a fresh instance (crash/restart survival)
 *   - exact-duplicate collapse on enqueue
 *   - stop-on-offline (preserve order, no attempt increment)
 *   - dead-lettering after MAX_REPLAY_ATTEMPTS deterministic failures
 *   - offline-error classification (isOfflineError)
 *   - corrupt/partial queue file → empty queue (no wedge)
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  KchatOfflineQueue,
  MAX_REPLAY_ATTEMPTS,
  isOfflineError,
  isNonReplayableCommit,
  type KchatQueueFs,
} from "../kchat/kchatOfflineQueue";

/** Minimal in-memory fs/promises shim with atomic-rename semantics. */
class MemoryFs implements KchatQueueFs {
  files = new Map<string, string>();
  dirs = new Set<string>();
  writes = 0;

  async readFile(p: string, _enc: "utf8"): Promise<string> {
    const v = this.files.get(p);
    if (v === undefined) {
      const err = new Error(`ENOENT: no such file ${p}`) as Error & {
        code?: string;
      };
      err.code = "ENOENT";
      throw err;
    }
    return v;
  }

  async writeFile(p: string, data: string, _enc: "utf8"): Promise<void> {
    this.writes += 1;
    this.files.set(p, data);
  }

  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT rename ${from}`);
    this.files.set(to, v);
    this.files.delete(from);
  }

  async mkdir(p: string, _opts: { recursive: true }): Promise<unknown> {
    this.dirs.add(p);
    return undefined;
  }

  /** Seed the queue file directly (simulate a pre-existing file). */
  seed(path: string, content: string): void {
    this.files.set(path, content);
  }
}

const QUEUE_PATH = "/tmp/test-tessera/kchat-offline-queue.json";

function makeQueue(fs: MemoryFs, ids: string[]) {
  let i = 0;
  let clock = 1_000;
  return new KchatOfflineQueue({
    filePath: QUEUE_PATH,
    fs,
    now: () => (clock += 1),
    randomId: () => ids[i++] ?? `gen-${i}`,
  });
}

describe("isOfflineError", () => {
  it("treats a server HTTP response (any status) as NOT offline — it is reachable", () => {
    // A status-bearing KchatRequestError means the server answered.
    // It must propagate to the user, never be silently queued.
    expect(isOfflineError({ status: 500 })).toBe(false);
    expect(isOfflineError({ status: 503 })).toBe(false);
    expect(isOfflineError({ status: 408 })).toBe(false);
    expect(isOfflineError({ status: 429 })).toBe(false);
    expect(isOfflineError({ status: 400 })).toBe(false);
    expect(isOfflineError({ status: 404 })).toBe(false);
  });

  it("classifies transport-level network failures as offline", () => {
    expect(isOfflineError(new Error("fetch failed"))).toBe(true);
    expect(isOfflineError(new Error("connect ECONNREFUSED 127.0.0.1"))).toBe(
      true,
    );
    expect(isOfflineError(new Error("getaddrinfo ENOTFOUND kchat.example"))).toBe(
      true,
    );
    expect(isOfflineError(new Error("request timed out"))).toBe(true);
    expect(isOfflineError(new Error("KChat client not connected"))).toBe(true);
  });

  it("does NOT misclassify a server error whose body mentions 'offline'", () => {
    // Regression: a 500 body containing the word "offline" used to be
    // queued. A reachable server's error must reject, not queue.
    expect(
      isOfflineError(
        Object.assign(
          new Error(
            "KChat 500 Internal Server Error at /api/v4/files: evidence-pack store offline",
          ),
          { status: 500 },
        ),
      ),
    ).toBe(false);
  });

  it("treats an IPC-rewritten KChat error string (status lost) as a server response", () => {
    expect(
      isOfflineError(new Error("KChat 503 Service Unavailable: /api/v4/files")),
    ).toBe(false);
    expect(
      isOfflineError(new Error("KChat 404 Not Found: /api/v4/posts")),
    ).toBe(false);
  });

  it("inspects a nested fetch cause", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = Object.assign(new Error("boom"), {
      code: "ECONNREFUSED",
    });
    expect(isOfflineError(err)).toBe(true);
  });

  it("terminates on a cyclic cause chain instead of recursing forever", () => {
    // A corrupted or adversarial error whose `cause` chain loops
    // (a -> b -> a) must not blow the stack. The depth bound caps
    // the walk; because none of these carry a transport keyword the
    // classification falls through to `false` rather than hanging.
    const a = new Error("layer-a");
    const b = new Error("layer-b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(isOfflineError(a)).toBe(false);
  });

  it("still detects a transport signal within the depth bound", () => {
    // A genuine errno a few levels deep is still classified offline:
    // the cap (5) is comfortably above Node fetch's ~2-level nesting.
    const top = new Error("wrapper");
    const mid = new Error("middle");
    const root = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    (top as { cause?: unknown }).cause = mid;
    (mid as { cause?: unknown }).cause = root;
    expect(isOfflineError(top)).toBe(true);
  });

  it("does not classify a transport signal buried below the depth bound", () => {
    // Build a chain longer than MAX_CAUSE_DEPTH (5) with the offline
    // signal only at the very bottom; the walk stops before reaching
    // it, so the error is treated as non-offline (surfaced, not
    // silently queued) — the conservative outcome for a pathological
    // chain no real code path produces.
    const offline = Object.assign(new Error("fetch failed"), {
      code: "ECONNREFUSED",
    });
    let head: Error = offline;
    for (let i = 0; i < 7; i++) {
      const wrapper = new Error(`wrapper-${i}`);
      (wrapper as { cause?: unknown }).cause = head;
      head = wrapper;
    }
    expect(isOfflineError(head)).toBe(false);
  });

  it("treats AbortError / TimeoutError by name", () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isOfflineError(abort)).toBe(true);
  });

  it("returns false for null/ordinary errors", () => {
    expect(isOfflineError(null)).toBe(false);
    expect(isOfflineError(new Error("artifact not found"))).toBe(false);
  });

  it("refuses to classify a nonReplayableCommit error as offline, even with a transport cause", () => {
    // A share whose primary upload already landed but whose evidence
    // pack then failed offline must NOT be queued (replaying would
    // duplicate the primary). The producer wraps it with the
    // `nonReplayableCommit` marker; `isOfflineError` must honour that
    // marker ahead of the usual transport-keyword / `cause` recursion,
    // so a wrapped "fetch failed" cause can't leak back through.
    const wrapped = Object.assign(new Error("fetch failed"), {
      nonReplayableCommit: true,
      cause: Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
    });
    expect(isNonReplayableCommit(wrapped)).toBe(true);
    expect(isOfflineError(wrapped)).toBe(false);
    // Sanity: without the marker, the same shape IS offline.
    const unmarked = Object.assign(new Error("fetch failed"), {
      cause: Object.assign(new Error("boom"), { code: "ECONNREFUSED" }),
    });
    expect(isNonReplayableCommit(unmarked)).toBe(false);
    expect(isOfflineError(unmarked)).toBe(true);
  });
});

describe("KchatOfflineQueue replay", () => {
  let fs: MemoryFs;

  beforeEach(() => {
    fs = new MemoryFs();
  });

  it("replays queued operations in FIFO order", async () => {
    const q = makeQueue(fs, ["op1", "op2", "op3"]);
    await q.enqueueShareArtifact({
      artifactId: "a1",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    });
    await q.enqueueIngestChannel({ channelId: "c2", channelName: "general" });
    await q.enqueueShareArtifact({
      artifactId: "a3",
      channelId: "c3",
      format: "pdf",
      includeCitations: true,
      includeEvidencePack: false,
    });

    const order: string[] = [];
    q.setExecutors({
      shareArtifact: async (p) => {
        order.push(`share:${p.artifactId}`);
      },
      ingestChannel: async (p) => {
        order.push(`ingest:${p.channelId}`);
      },
    });

    const summary = await q.replay();
    expect(order).toEqual(["share:a1", "ingest:c2", "share:a3"]);
    expect(summary).toEqual({ replayed: 3, deadLettered: 0, remaining: 0 });
    expect(q.size()).toBe(0);
  });

  it("collapses an exact duplicate enqueue (no double upload)", async () => {
    const q = makeQueue(fs, ["op1", "op2"]);
    const payload = {
      artifactId: "a1",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    };
    await q.enqueueShareArtifact({ ...payload });
    await q.enqueueShareArtifact({ ...payload });
    expect(q.size()).toBe(1);
  });

  it("returns the EXISTING op id on a duplicate enqueue (no phantom id)", async () => {
    // Regression: a duplicate enqueue must surface the id of the op
    // actually stored, not the freshly-generated id that was never
    // pushed — otherwise the renderer's `queueId` references an entry
    // that `list()` / `kchat:offlineQueueStatus` can never find.
    const q = makeQueue(fs, ["op1", "op2"]);
    const payload = {
      artifactId: "a1",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    };
    const first = await q.enqueueShareArtifact({ ...payload });
    const second = await q.enqueueShareArtifact({ ...payload });
    expect(first).toBe("op1");
    // The duplicate consumed "op2" from the id factory but must NOT
    // return it; it returns the stored op's id ("op1").
    expect(second).toBe("op1");
    expect(q.list().map((o) => o.id)).toEqual(["op1"]);
  });

  it("does NOT collapse ops that differ in payload", async () => {
    const q = makeQueue(fs, ["op1", "op2"]);
    await q.enqueueShareArtifact({
      artifactId: "a1",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    });
    await q.enqueueShareArtifact({
      artifactId: "a1",
      channelId: "c1",
      format: "pdf",
      includeCitations: false,
      includeEvidencePack: false,
    });
    expect(q.size()).toBe(2);
  });

  it("stops on an offline failure, preserving order and NOT incrementing attempts", async () => {
    const q = makeQueue(fs, ["op1", "op2", "op3"]);
    await q.enqueueShareArtifact({
      artifactId: "a1",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    });
    await q.enqueueShareArtifact({
      artifactId: "a2",
      channelId: "c2",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    });
    await q.enqueueShareArtifact({
      artifactId: "a3",
      channelId: "c3",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    });

    const attempted: string[] = [];
    q.setExecutors({
      shareArtifact: async (p) => {
        attempted.push(p.artifactId);
        if (p.artifactId === "a2") {
          // Transport-level failure (server unreachable) → replay
          // must stop and preserve order without counting an attempt.
          throw new Error("connect ECONNREFUSED 127.0.0.1:443");
        }
      },
    });

    const summary = await q.replay();
    // a1 succeeds, a2 fails offline → stop; a3 never attempted.
    expect(attempted).toEqual(["a1", "a2"]);
    expect(summary).toEqual({ replayed: 1, deadLettered: 0, remaining: 2 });
    const remaining = q.list();
    expect(remaining.map((o) => o.payload)).toEqual([
      expect.objectContaining({ artifactId: "a2" }),
      expect.objectContaining({ artifactId: "a3" }),
    ]);
    // Offline failure must not count as an attempt.
    expect(remaining[0].attempts).toBe(0);
  });

  it("dead-letters a poisoned op after MAX_REPLAY_ATTEMPTS deterministic failures", async () => {
    const q = makeQueue(fs, ["op1"]);
    await q.enqueueShareArtifact({
      artifactId: "poison",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    });
    q.setExecutors({
      shareArtifact: async () => {
        // Deterministic (non-offline) failure every time.
        throw new Error("artifact not found");
      },
    });

    // Each replay increments attempts by 1 (deterministic failure).
    for (let i = 1; i < MAX_REPLAY_ATTEMPTS; i++) {
      const s = await q.replay();
      expect(s).toEqual({ replayed: 0, deadLettered: 0, remaining: 1 });
      expect(q.list()[0].attempts).toBe(i);
    }
    // Final attempt hits the cap → dead-lettered, removed from queue.
    const final = await q.replay();
    expect(final).toEqual({ replayed: 0, deadLettered: 1, remaining: 0 });
    expect(q.size()).toBe(0);
  });

  it("drops (dead-letters) a nonReplayableCommit failure immediately without retrying", async () => {
    // A queued shareArtifact whose primary upload lands on replay but
    // whose evidence pack then fails offline surfaces as a
    // `nonReplayableCommit` error. Retrying would re-upload the primary
    // (duplicate), so replay must drop the op on the first occurrence
    // rather than re-queue it for another attempt.
    const q = makeQueue(fs, ["op1", "op2"]);
    await q.enqueueShareArtifact({
      artifactId: "a1",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: true,
    });
    await q.enqueueIngestChannel({ channelId: "c2", channelName: "general" });

    let shareAttempts = 0;
    let ingestRan = false;
    q.setExecutors({
      shareArtifact: async () => {
        shareAttempts += 1;
        // Primary already committed; evidence pack failed offline.
        throw Object.assign(new Error("fetch failed"), {
          nonReplayableCommit: true,
        });
      },
      ingestChannel: async () => {
        ingestRan = true;
      },
    });

    const summary = await q.replay();
    // The share op is dropped (dead-lettered), NOT re-queued, and the
    // later ingest op still replays — one committed-share failure must
    // not block the rest of the queue.
    expect(summary).toEqual({ replayed: 1, deadLettered: 1, remaining: 0 });
    expect(shareAttempts).toBe(1);
    expect(ingestRan).toBe(true);
    expect(q.size()).toBe(0);

    // A second replay does not re-run the share executor (it's gone).
    await q.replay();
    expect(shareAttempts).toBe(1);
  });

  it("persists across a fresh instance (crash/restart survival)", async () => {
    const q1 = makeQueue(fs, ["op1"]);
    await q1.enqueueIngestChannel({ channelId: "c9", channelName: "ops" });
    expect(fs.files.has(QUEUE_PATH)).toBe(true);

    // New instance reading the same file picks up the pending op.
    const q2 = makeQueue(fs, ["should-not-be-used"]);
    await q2.load();
    expect(q2.size()).toBe(1);

    const seen: string[] = [];
    q2.setExecutors({
      ingestChannel: async (p) => {
        seen.push(p.channelId);
      },
    });
    const summary = await q2.replay();
    expect(seen).toEqual(["c9"]);
    expect(summary.replayed).toBe(1);
  });

  it("treats a corrupt queue file as empty (never wedges)", async () => {
    fs.seed(QUEUE_PATH, "{ this is not valid json ");
    const q = makeQueue(fs, ["op1"]);
    await q.load();
    expect(q.size()).toBe(0);
    // Still usable after a corrupt read.
    await q.enqueueIngestChannel({ channelId: "c1", channelName: "x" });
    expect(q.size()).toBe(1);
  });

  it("drops version-skewed / malformed entries on load", async () => {
    fs.seed(
      QUEUE_PATH,
      JSON.stringify({
        version: 1,
        operations: [
          { id: "ok", type: "ingestChannel", payload: { channelId: "c", channelName: "n" }, enqueuedAt: 1, attempts: 0, lastError: null },
          { id: "bad-type", type: "frobnicate", payload: {} },
          { type: "ingestChannel", payload: { channelId: "c", channelName: "n" } },
          { id: "bad-payload", type: "shareArtifact", payload: { artifactId: 123 } },
        ],
      }),
    );
    const q = makeQueue(fs, []);
    await q.load();
    expect(q.size()).toBe(1);
    expect(q.list()[0].id).toBe("ok");
  });

  it("keeps an op queued when no executor is registered for its type", async () => {
    const q = makeQueue(fs, ["op1"]);
    await q.enqueueShareArtifact({
      artifactId: "a1",
      channelId: "c1",
      format: "markdown",
      includeCitations: false,
      includeEvidencePack: false,
    });
    // No executors registered.
    const summary = await q.replay();
    expect(summary).toEqual({ replayed: 0, deadLettered: 0, remaining: 1 });
    expect(q.size()).toBe(1);
  });

  it("serialises concurrent replays (returns the same in-flight drain)", async () => {
    const q = makeQueue(fs, ["op1"]);
    await q.enqueueIngestChannel({ channelId: "c1", channelName: "x" });
    let calls = 0;
    q.setExecutors({
      ingestChannel: async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 5));
      },
    });
    const [a, b] = await Promise.all([q.replay(), q.replay()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
  });

  it("replays a queued postTask through its executor with the stored task", async () => {
    const q = makeQueue(fs, ["op1"]);
    await q.enqueuePostTask({
      channelId: "c1",
      task: { id: "t1", title: "Ship it", priority: "high" },
    });
    const seen: Array<{ channelId: string; taskId: string }> = [];
    q.setExecutors({
      postTask: async (p) => {
        seen.push({ channelId: p.channelId, taskId: p.task.id });
      },
    });
    const summary = await q.replay();
    expect(seen).toEqual([{ channelId: "c1", taskId: "t1" }]);
    expect(summary).toEqual({ replayed: 1, deadLettered: 0, remaining: 0 });
  });

  it("collapses duplicate postTask enqueues and returns the existing id", async () => {
    const q = makeQueue(fs, ["op1", "op2"]);
    const req = {
      channelId: "c1",
      task: { id: "t1", title: "Ship it" },
    };
    const first = await q.enqueuePostTask({ ...req });
    const second = await q.enqueuePostTask({ ...req });
    expect(first).toBe("op1");
    expect(second).toBe("op1");
    expect(q.size()).toBe(1);
  });

  it("survives a reload from disk (postTask payload round-trips)", async () => {
    const q1 = makeQueue(fs, ["op1"]);
    await q1.enqueuePostTask({
      channelId: "c9",
      task: { id: "t9", title: "Reconcile", dueDate: "2026-06-10" },
    });

    // Fresh instance backed by the same fs re-reads the persisted file.
    const q2 = makeQueue(fs, ["unused"]);
    await q2.load();
    expect(q2.size()).toBe(1);
    const op = q2.list()[0];
    expect(op.type).toBe("postTask");
    expect(op.payload).toEqual({
      channelId: "c9",
      task: { id: "t9", title: "Reconcile", dueDate: "2026-06-10" },
    });
  });

  it("discards a persisted postTask whose task is missing required fields", async () => {
    await fs.writeFile(
      QUEUE_PATH,
      JSON.stringify({
        version: 1,
        operations: [
          {
            id: "ok",
            type: "postTask",
            payload: { channelId: "c1", task: { id: "t1", title: "fine" } },
          },
          // task without a title → dropped on load.
          {
            id: "bad",
            type: "postTask",
            payload: { channelId: "c1", task: { id: "t2" } },
          },
        ],
      }),
    );
    const q = makeQueue(fs, []);
    await q.load();
    expect(q.size()).toBe(1);
    expect(q.list()[0].id).toBe("ok");
  });
});
