/**
 * Integration-style tests covering the new Notion / Jira / Confluence /
 * Figma sync impls. Each test stubs `globalThis.fetch` to return
 * provider-shaped JSON, runs the sync, and asserts that the local
 * manifest + bridge mocks reflect the expected work.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
}));

import { syncNotion, disconnectNotion } from "../ipc/connectors/notion";
import { syncJira, disconnectJira } from "../ipc/connectors/jira";
import { syncConfluence, disconnectConfluence } from "../ipc/connectors/confluence";
import { syncFigma, disconnectFigma } from "../ipc/connectors/figma";
import { syncGoogleDrive } from "../ipc/connectors/gdrive";

interface FakeSource {
  id: string;
  path: string;
}

class FakeBridge {
  private sources: FakeSource[] = [];
  added: FakeSource[] = [];
  reindexed: string[] = [];
  removed: string[] = [];
  private idCounter = 1;
  addLocalFile(p: string): FakeSource {
    const s: FakeSource = { id: `src-${this.idCounter++}`, path: p };
    this.sources.push(s);
    this.added.push(s);
    return s;
  }
  reindexSource(id: string): void {
    this.reindexed.push(id);
  }
  removeSource(id: string): void {
    this.removed.push(id);
    this.sources = this.sources.filter((s) => s.id !== id);
  }
  listSources(): FakeSource[] {
    return this.sources.slice();
  }
}

function makeFetchMock() {
  return vi.fn();
}

async function tmpDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `tessera-${prefix}-`));
}

describe("Notion sync", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("notion");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("indexes search-result pages with extracted block text", async () => {
    fetchMock
      // POST /v1/search
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "page-1",
              last_edited_time: "2024-06-01T10:00:00Z",
              archived: false,
              properties: {
                title: { type: "title", title: [{ plain_text: "Hello" }] },
              },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      })
      // GET /v1/blocks/page-1/children
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "b-1",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "World" }] },
            },
            {
              id: "b-2",
              type: "heading_1",
              heading_1: { rich_text: [{ plain_text: "Subhead" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      });

    const r = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
    expect(r.added).toBe(1);
    const local = bridge.added[0].path;
    const content = await fsp.readFile(local, "utf8");
    expect(content).toContain("# Hello");
    expect(content).toContain("World");
    expect(content).toContain("# Subhead");
  });

  it(
    "scans all pages and filters by watermark instead of short-circuiting " +
      "on the first <=watermark hit (regression: Notion search sort is best-effort)",
    async () => {
      // Pre-seed state.json with a watermark so the sync runs in
      // "incremental" mode. Notion docs `sort` as best-effort, so we
      // simulate the search API returning a page OLDER than the
      // watermark *before* a page NEWER than the watermark within
      // the same response. The buggy implementation broke on the
      // first <=watermark hit and never indexed the newer page; the
      // correct implementation must filter each result independently
      // and keep scanning.
      const stateDir = path.join(dir, "notion-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "watermark.json"),
        JSON.stringify({ lastSyncIso: "2024-06-01T00:00:00Z" }),
        "utf8",
      );
      fetchMock
        // POST /v1/search
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              // Page A — older than the watermark, must be skipped.
              {
                id: "page-A",
                last_edited_time: "2024-05-01T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "Old" }] },
                },
              },
              // Page B — newer than the watermark, must be picked up
              // even though it followed a <=watermark page in the
              // response.
              {
                id: "page-B",
                last_edited_time: "2024-07-01T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "New" }] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        })
        // GET /v1/blocks/page-B/children
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "b-1",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Newer content" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        });

      const r = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      expect(r.added).toBe(1);
      const content = await fsp.readFile(bridge.added[0].path, "utf8");
      expect(content).toContain("# New");
      expect(content).toContain("Newer content");
    },
  );

  it("disconnect cleans up sync dir + sources", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "p1",
              last_edited_time: "2024-06-01T00:00:00Z",
              properties: {},
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "b",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "Body" }] },
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
      });
    await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
    const added = bridge.added[0];
    await disconnectNotion(dir, bridge);
    expect(bridge.removed).toContain(added.id);
    await expect(fsp.access(path.join(dir, "notion-sync"))).rejects.toThrow();
  });

  it(
    "retries a transiently-failed page on the next sync via direct GET, " +
      "even when the watermark has advanced past the failed page's edit time " +
      "(regression: wave-5 Devin Review finding on watermark-based incremental sync)",
    async () => {
      // Pass 1: search returns page-fail (older) and page-ok (newer).
      // page-fail's blocks fetch errors out; page-ok succeeds and
      // advances the watermark past page-fail's last_edited_time.
      fetchMock
        // POST /v1/search
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "page-fail",
                last_edited_time: "2024-06-01T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "Fail" }] },
                },
              },
              {
                id: "page-ok",
                last_edited_time: "2024-07-01T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "Ok" }] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        })
        // GET /v1/blocks/page-fail/children — error (transient)
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          text: async () => "Service Unavailable",
        })
        // GET /v1/blocks/page-ok/children — success
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "b-ok",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "ok body" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        });

      const r1 = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      expect(r1.added).toBe(1);
      expect(bridge.added).toHaveLength(1);
      expect(bridge.added[0].path).toContain("page-ok");

      // Watermark should now be the newer page's timestamp.
      const watermark = JSON.parse(
        await fsp.readFile(path.join(dir, "notion-sync", "watermark.json"), "utf8"),
      ) as { lastSyncIso: string; failedRetries: Array<{ remoteId: string }> };
      expect(watermark.lastSyncIso).toBe("2024-07-01T00:00:00Z");
      // The failed page must be recorded for retry.
      expect(watermark.failedRetries.map((e) => e.remoteId)).toEqual(["page-fail"]);

      // Pass 2: state has watermark=2024-07-01 and failedRetries=[page-fail].
      // The naive watermark-only scan would never return page-fail
      // again (its last_edited_time of 2024-06-01 is older than the
      // watermark). The retry queue must force a direct GET of
      // page-fail's page object, then (after the normal search runs)
      // the unified for-loop re-fetches its blocks and indexes it.
      //
      // Mock order MUST mirror the actual fetch sequence in
      // `syncNotion`:
      //   (1) Phase 1: `fetchPageById('page-fail')`
      //   (2) Phase 2: `listAllPages()` → POST /v1/search
      //   (3) For-loop: `fetchPageText('page-fail')` → blocks GET
      fetchMock
        // (1) GET /v1/pages/page-fail
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "page-fail",
            last_edited_time: "2024-06-01T00:00:00Z",
            archived: false,
            properties: {
              title: { type: "title", title: [{ plain_text: "Recovered" }] },
            },
          }),
        })
        // (2) POST /v1/search — no new results above the watermark
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          }),
        })
        // (3) GET /v1/blocks/page-fail/children — now succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "b-fail",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "recovered body" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        });

      const r2 = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      expect(r2.added).toBe(1);
      expect(bridge.added).toHaveLength(2);
      // Verify the recovered file is on disk and contains the title +
      // body that came back from the retry path.
      const recovered = bridge.added.find((s) => s.path.includes("page-fail"));
      expect(recovered).toBeDefined();
      const content = await fsp.readFile(recovered!.path, "utf8");
      expect(content).toContain("# Recovered");
      expect(content).toContain("recovered body");

      // Queue must now be empty.
      const watermark2 = JSON.parse(
        await fsp.readFile(path.join(dir, "notion-sync", "watermark.json"), "utf8"),
      ) as { lastSyncIso: string; failedRetries: Array<{ remoteId: string }> };
      expect(watermark2.failedRetries).toEqual([]);
    },
  );

  it(
    "drops a retry entry when Notion returns 404 for it (page was deleted) " +
      "so we don't keep pinging the missing id forever",
    async () => {
      // Pre-seed state with a failedRetries entry whose page is now
      // gone (404 on direct GET).
      const stateDir = path.join(dir, "notion-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "watermark.json"),
        JSON.stringify({
          lastSyncIso: "2024-06-01T00:00:00Z",
          failedRetries: [
            {
              remoteId: "deleted-page",
              remoteModifiedAt: "2024-05-01T00:00:00Z",
              failureCount: 2,
            },
          ],
        }),
        "utf8",
      );

      fetchMock
        // GET /v1/pages/deleted-page → 404
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => "Not Found",
        })
        // POST /v1/search → no new pages
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          }),
        });

      const r = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      expect(r.added).toBe(0);
      const watermark = JSON.parse(
        await fsp.readFile(path.join(dir, "notion-sync", "watermark.json"), "utf8"),
      ) as { failedRetries: Array<{ remoteId: string }> };
      expect(watermark.failedRetries).toEqual([]);
    },
  );

  it(
    "bumps failureCount and ultimately gives up when a Notion " +
      "Phase-1 retry keeps failing with a non-404 error " +
      "(regression: Devin Review wave 7 BUG_0001 — silently dropped retry " +
      "would have looped forever)",
    async () => {
      // Pre-seed state with a failedRetries entry already at the
      // configured `FAILED_RETRY_MAX_ATTEMPTS - 1` failure count so
      // one more non-404 error during Phase 1 should push it over
      // the cliff and remove it from the queue (rather than carrying
      // it forward unchanged the way the buggy code did).
      const stateDir = path.join(dir, "notion-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "watermark.json"),
        JSON.stringify({
          lastSyncIso: "2024-06-01T00:00:00Z",
          failedRetries: [
            {
              remoteId: "perma-broken",
              remoteModifiedAt: "2024-05-01T00:00:00Z",
              failureCount: 5,
            },
          ],
        }),
        "utf8",
      );

      fetchMock
        // GET /v1/pages/perma-broken → 500 (non-404 transport error)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => "Internal Server Error",
        })
        // POST /v1/search → no new pages
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          }),
        });

      const r = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      expect(r.added).toBe(0);
      const watermark = JSON.parse(
        await fsp.readFile(path.join(dir, "notion-sync", "watermark.json"), "utf8"),
      ) as { failedRetries: Array<{ remoteId: string; failureCount: number }> };
      // The entry should have been dropped because the new failure
      // count (5 + 1 = 6) exceeds FAILED_RETRY_MAX_ATTEMPTS (5). The
      // pre-fix behaviour would have left it in the queue forever
      // with failureCount stuck at 5.
      expect(watermark.failedRetries).toEqual([]);
    },
  );

  it(
    "bumps failureCount by exactly one on a single non-404 Phase-1 failure " +
      "(regression: Devin Review wave 7 BUG_0001 — the catch used to " +
      "swallow the error without recording it)",
    async () => {
      const stateDir = path.join(dir, "notion-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "watermark.json"),
        JSON.stringify({
          lastSyncIso: "2024-06-01T00:00:00Z",
          failedRetries: [
            {
              remoteId: "transiently-broken",
              remoteModifiedAt: "2024-05-01T00:00:00Z",
              failureCount: 1,
            },
          ],
        }),
        "utf8",
      );

      fetchMock
        // GET /v1/pages/transiently-broken → 502
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: async () => "Bad Gateway",
        })
        // POST /v1/search → no new pages
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          }),
        });

      await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      const watermark = JSON.parse(
        await fsp.readFile(path.join(dir, "notion-sync", "watermark.json"), "utf8"),
      ) as { failedRetries: Array<{ remoteId: string; failureCount: number }> };
      expect(watermark.failedRetries).toHaveLength(1);
      expect(watermark.failedRetries[0].remoteId).toBe("transiently-broken");
      expect(watermark.failedRetries[0].failureCount).toBe(2);
    },
  );

  it(
    "records a writeFile failure in the retry queue instead of " +
      "silently advancing the watermark past the page " +
      "(regression: wave 7C BUG_0001)",
    async () => {
      // Fetch two pages in one pass. The first succeeds end-to-end;
      // the second fetches successfully from the API but disk
      // `writeFile` throws ENOSPC. Before the fix, the exception
      // propagated to the outer try/finally and killed the iteration:
      // `failedThisPass` never received page-bad, so the retry queue
      // came back empty AND the watermark had already advanced to
      // page-good's later timestamp. The next sync would never see
      // page-bad again.
      fetchMock
        // POST /v1/search → both pages
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "page-good",
                last_edited_time: "2024-07-01T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "Good" }] },
                },
              },
              {
                id: "page-bad",
                last_edited_time: "2024-06-15T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "Bad" }] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        })
        // GET /v1/blocks/page-good/children
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "g-1",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Good content" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        })
        // GET /v1/blocks/page-bad/children
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "b-1",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Bad content" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        });

      // Force a real I/O failure on the page-bad writeFile call by
      // pre-creating its target path as a *directory*. Node's
      // `fsp.writeFile(p, …)` then throws EISDIR. This is a real
      // failure path (no monkey-patching of `fs/promises`, which is
      // non-configurable in ESM) and exercises the catch block end
      // to end.
      const syncDir = path.join(dir, "notion-sync");
      await fsp.mkdir(syncDir, { recursive: true });
      await fsp.mkdir(path.join(syncDir, "page-bad.md"), { recursive: true });

      const r = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      // page-good was indexed; page-bad was not.
      expect(r.added).toBe(1);
      expect(bridge.added.map((s) => path.basename(s.path))).toEqual([
        "page-good.md",
      ]);

      // The watermark file MUST exist (try/finally guaranteed) and
      // page-bad MUST be in the retry queue with failureCount=1 —
      // not silently lost.
      const watermarkRaw = await fsp.readFile(
        path.join(dir, "notion-sync", "watermark.json"),
        "utf8",
      );
      const watermark = JSON.parse(watermarkRaw) as {
        lastSyncIso: string | null;
        failedRetries: Array<{
          remoteId: string;
          remoteModifiedAt: string | null;
          failureCount: number;
        }>;
      };
      expect(watermark.failedRetries).toHaveLength(1);
      expect(watermark.failedRetries[0].remoteId).toBe("page-bad");
      expect(watermark.failedRetries[0].failureCount).toBe(1);
      expect(watermark.failedRetries[0].remoteModifiedAt).toBe(
        "2024-06-15T00:00:00Z",
      );
    },
  );

  it(
    "drops Phase-1 fetchPageById failures from the retry queue " +
      "when the same page is re-synced successfully via the Phase-2 " +
      "watermark scan (regression: wave 7C ANALYSIS_0001)",
    async () => {
      // Pre-seed a retry queue containing one entry. Phase 1's
      // fetchPageById against that entry returns 502 (transient
      // failure). Phase 2's search lists the same page id with a
      // last_edited_time newer than the watermark; processing it
      // (fetchPageText + writeFile + addLocalFile) succeeds.
      //
      // Before the call-site reconciliation, the page ended up in
      // both `failedThisPass` (from Phase 1) and `succeededIds`
      // (from Phase 2). `nextFailedRetryQueue`'s conservative
      // semantics — documented and tested in
      // `failedRetryQueue.test.ts:124-142` — treats failed as
      // authoritative when the same id appears in both sets,
      // re-inserting it with failureCount=1. The next sync would
      // then waste one API call re-fetching a page we already have.
      //
      // After the reconciliation at the notion.ts call site, the
      // Phase-1 failure is dropped because the Phase-2 success
      // covered the same id within the same pass. The retry queue
      // ends up empty.
      const stateDir = path.join(dir, "notion-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "watermark.json"),
        JSON.stringify({
          lastSyncIso: "2024-06-01T00:00:00Z",
          failedRetries: [
            {
              remoteId: "shared-page",
              remoteModifiedAt: "2024-05-15T00:00:00Z",
              failureCount: 1,
            },
          ],
        }),
        "utf8",
      );

      fetchMock
        // Phase 1: GET /v1/pages/shared-page → 502 (transient).
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: async () => "Bad Gateway",
        })
        // Phase 2: POST /v1/search → same page with newer
        // last_edited_time (i.e. the user touched it between the
        // failed Phase-1 attempt and this Phase-2 scan).
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "shared-page",
                last_edited_time: "2024-07-01T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "Shared" }] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        })
        // GET /v1/blocks/shared-page/children → real content.
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "blk",
                type: "paragraph",
                paragraph: { rich_text: [{ plain_text: "Recovered" }] },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        });

      const r = await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });
      expect(r.added).toBe(1);

      // The retry queue must be empty: the Phase-2 success covers
      // the Phase-1 failure for the same id within the same pass.
      const watermarkRaw = await fsp.readFile(
        path.join(stateDir, "watermark.json"),
        "utf8",
      );
      const watermark = JSON.parse(watermarkRaw) as {
        lastSyncIso: string | null;
        failedRetries: Array<{
          remoteId: string;
          failureCount: number;
        }>;
      };
      expect(watermark.failedRetries).toEqual([]);
      // Watermark advanced to the page's new last_edited_time.
      expect(watermark.lastSyncIso).toBe("2024-07-01T00:00:00Z");
    },
  );

  it(
    "dedupes failedThisPass when the same page id fails in BOTH " +
      "Phase 1 fetchPageById AND Phase 2 fetchPageText so " +
      "failureCount bumps by exactly 1 per sync (regression: " +
      "wave 11 ANALYSIS_0001)",
    async () => {
      // Pre-seed retry queue with one page (failureCount=1) and an
      // older watermark so Phase 2's search will re-surface the same
      // id once its last_edited_time advances past the watermark.
      const stateDir = path.join(dir, "notion-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "watermark.json"),
        JSON.stringify({
          lastSyncIso: "2024-06-01T00:00:00Z",
          failedRetries: [
            {
              remoteId: "shared-page",
              remoteModifiedAt: "2024-05-15T00:00:00Z",
              failureCount: 1,
            },
          ],
        }),
        "utf8",
      );

      fetchMock
        // Phase 1: GET /v1/pages/shared-page → 502 → throws → push #1.
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: async () => "Bad Gateway",
        })
        // Phase 2: POST /v1/search → returns shared-page with a NEW
        // last_edited_time strictly after the watermark, so the
        // listAllPages filter doesn't drop it.
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "shared-page",
                last_edited_time: "2024-07-01T00:00:00Z",
                archived: false,
                properties: {
                  title: { type: "title", title: [{ plain_text: "Shared" }] },
                },
              },
            ],
            has_more: false,
            next_cursor: null,
          }),
        })
        // Phase 2: fetchPageText → fetchAllBlocks GET
        // /v1/blocks/shared-page/children → 502 → throws → push #2.
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: async () => "Bad Gateway",
        });

      await syncNotion({ accessToken: "AT", userDataDir: dir, bridge });

      const watermark = JSON.parse(
        await fsp.readFile(
          path.join(stateDir, "watermark.json"),
          "utf8",
        ),
      ) as {
        lastSyncIso: string | null;
        failedRetries: Array<{ remoteId: string; failureCount: number }>;
      };
      // With the dedupe fix: only one bump → 1 + 1 = 2.
      // Without the fix: two distinct entries in failedThisPass walked
      // sequentially by `nextFailedRetryQueue` → 1 + 1 + 1 = 3.
      expect(watermark.failedRetries).toHaveLength(1);
      expect(watermark.failedRetries[0].remoteId).toBe("shared-page");
      expect(watermark.failedRetries[0].failureCount).toBe(2);
    },
  );
});

describe("Jira sync", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("jira");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("resolves cloud id then renders issues to markdown", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "cloud-1", url: "https://x", name: "site", scopes: ["read:jira-work"] },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          startAt: 0,
          maxResults: 50,
          total: 1,
          issues: [
            {
              id: "i1",
              key: "ABC-1",
              fields: {
                summary: "Test issue",
                status: { name: "Done" },
                project: { key: "ABC", name: "Alpha" },
                description: {
                  type: "doc",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Detail" }],
                    },
                  ],
                },
                updated: "2024-06-01T10:00:00.000+0000",
              },
            },
          ],
        }),
      });

    const r = await syncJira({ accessToken: "AT", userDataDir: dir, bridge });
    expect(r.added).toBe(1);
    const local = bridge.added[0].path;
    const content = await fsp.readFile(local, "utf8");
    expect(content).toContain("# ABC-1: Test issue");
    expect(content).toContain("Detail");
  });

  it("disconnect cleans up", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "cloud-1", url: "https://x", name: "site", scopes: ["read:jira-work"] },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          startAt: 0,
          maxResults: 50,
          total: 1,
          issues: [
            {
              id: "i1",
              key: "ABC-1",
              fields: {
                summary: "x",
                project: { key: "ABC", name: "P" },
                updated: "2024-06-01T10:00:00.000+0000",
              },
            },
          ],
        }),
      });
    await syncJira({ accessToken: "AT", userDataDir: dir, bridge });
    const added = bridge.added[0];
    await disconnectJira(dir, bridge);
    expect(bridge.removed).toContain(added.id);
    await expect(fsp.access(path.join(dir, "jira-sync"))).rejects.toThrow();
  });
});

describe("Confluence sync", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("conf");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("lists spaces, fetches pages, strips storage XHTML to text", async () => {
    fetchMock
      // accessible-resources
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "cloud-1", url: "https://x", name: "site", scopes: ["read:confluence-content.summary"] },
        ],
      })
      // spaces
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [{ id: "s1", key: "TEAM", name: "Team", type: "global" }],
        }),
      })
      // pages in space s1
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "p1",
              title: "Welcome",
              spaceId: "s1",
              version: { number: 3 },
              body: {
                storage: {
                  value: "<p>Hello <strong>world</strong></p><h2>Subhead</h2>",
                },
              },
              createdAt: "2024-06-01T10:00:00Z",
            },
          ],
        }),
      });
    const r = await syncConfluence({
      accessToken: "AT",
      userDataDir: dir,
      bridge,
    });
    expect(r.added).toBe(1);
    const content = await fsp.readFile(bridge.added[0].path, "utf8");
    expect(content).toContain("# Welcome");
    expect(content).toContain("Hello world");
    expect(content).toContain("## Subhead");
  });

  it("disconnect cleans up", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "cloud-1", url: "https://x", name: "site", scopes: ["read:confluence-content.summary"] },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [{ id: "s1", key: "K", name: "N" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            {
              id: "p1",
              title: "T",
              spaceId: "s1",
              body: { storage: { value: "<p>hi</p>" } },
              createdAt: "2024-06-01T10:00:00Z",
            },
          ],
        }),
      });
    await syncConfluence({ accessToken: "AT", userDataDir: dir, bridge });
    const added = bridge.added[0];
    await disconnectConfluence(dir, bridge);
    expect(bridge.removed).toContain(added.id);
    await expect(
      fsp.access(path.join(dir, "confluence-sync")),
    ).rejects.toThrow();
  });

  it(
    "uses version.number as the incremental watermark — skips pages " +
      "whose version is unchanged, re-indexes pages whose version bumped",
    async () => {
      const accessibleResp = {
        ok: true,
        json: async () => [
          {
            id: "cloud-1",
            url: "https://x",
            name: "site",
            scopes: ["read:confluence-content.summary"],
          },
        ],
      };
      const spacesResp = {
        ok: true,
        json: async () => ({
          results: [{ id: "s1", key: "K", name: "N" }],
        }),
      };

      // ---- First sync: index `p1` at version 1, `p2` at version 5 ----
      fetchMock
        .mockResolvedValueOnce(accessibleResp)
        .mockResolvedValueOnce(spacesResp)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "p1",
                title: "Original 1",
                spaceId: "s1",
                version: { number: 1 },
                body: { storage: { value: "<p>v1</p>" } },
                // A 2023 createdAt that was previously triggering the
                // watermark bug. The version-based fix must ignore it.
                createdAt: "2023-01-01T00:00:00Z",
              },
              {
                id: "p2",
                title: "Original 2",
                spaceId: "s1",
                version: { number: 5 },
                body: { storage: { value: "<p>v5</p>" } },
                createdAt: "2023-01-01T00:00:00Z",
              },
            ],
          }),
        });

      let r = await syncConfluence({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
      });
      expect(r.added).toBe(2);
      expect(r.modified).toBe(0);

      // ---- Second sync: p1 unchanged (version still 1), p2 edited
      // (version bumped to 6). Despite both having an old createdAt
      // (which previously caused the early short-circuit), the
      // version comparison must still produce exactly one modified
      // page.
      //
      // Note: after the first sync, `state.cloudId` is persisted so
      // syncConfluence skips the accessible-resources lookup on
      // subsequent runs — only spaces + pages are fetched. ----
      fetchMock
        .mockResolvedValueOnce(spacesResp)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [
              {
                id: "p1",
                title: "Original 1",
                spaceId: "s1",
                version: { number: 1 },
                body: { storage: { value: "<p>v1</p>" } },
                createdAt: "2023-01-01T00:00:00Z",
              },
              {
                id: "p2",
                title: "Edited 2",
                spaceId: "s1",
                version: { number: 6 },
                body: { storage: { value: "<p>v6 edited</p>" } },
                createdAt: "2023-01-01T00:00:00Z",
              },
            ],
          }),
        });

      r = await syncConfluence({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
      });
      expect(r.added).toBe(0);
      // p2 must be detected as modified despite its createdAt being
      // older than the previous "watermark". This is the regression
      // guard.
      expect(r.modified).toBe(1);
    },
  );
});

describe("Figma sync", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("figma");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("walks teams → projects → files and extracts TEXT nodes + comments", async () => {
    fetchMock
      // GET /v1/me — returns user's teams
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ teams: [{ id: "t1", name: "Team A" }] }),
      })
      // GET /v1/teams/t1/projects
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "Team A",
          projects: [{ id: "proj-1", name: "Proj" }],
        }),
      })
      // GET /v1/projects/proj-1/files
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "Proj",
          files: [
            {
              key: "f1",
              name: "Onboarding",
              last_modified: "2024-06-01T10:00:00Z",
            },
          ],
        }),
      })
      // GET /v1/files/f1
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "Onboarding",
          lastModified: "2024-06-01T10:00:00Z",
          document: {
            id: "0:0",
            children: [
              {
                id: "1:1",
                type: "TEXT",
                characters: "Welcome to Tessera",
              },
              {
                id: "1:2",
                type: "FRAME",
                children: [
                  {
                    id: "1:3",
                    type: "TEXT",
                    characters: "Get started",
                  },
                ],
              },
            ],
          },
          components: { c1: { name: "Button", description: "Primary action" } },
        }),
      })
      // GET /v1/files/f1/comments
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          comments: [
            { message: "Looks good", user: { handle: "alice" }, created_at: "2024-06-02T10:00:00Z" },
          ],
        }),
      });

    const r = await syncFigma({ accessToken: "AT", userDataDir: dir, bridge });
    expect(r.added).toBe(1);
    const content = await fsp.readFile(bridge.added[0].path, "utf8");
    expect(content).toContain("Welcome to Tessera");
    expect(content).toContain("Get started");
    expect(content).toContain("Button");
    expect(content).toContain("Primary action");
    expect(content).toContain("Looks good");
  });

  it("returns no-teams when /v1/me has no teams", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ teams: [] }),
    });
    const r = await syncFigma({ accessToken: "AT", userDataDir: dir, bridge });
    expect(r.status).toBe("no-teams");
  });

  it("disconnect cleans up", async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ teams: [{ id: "t1" }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ name: "T", projects: [{ id: "p1", name: "P" }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "P",
          files: [{ key: "f1", name: "F", last_modified: "2024-06-01T00:00:00Z" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          name: "F",
          lastModified: "2024-06-01T00:00:00Z",
          document: { id: "0:0", children: [{ id: "1:1", type: "TEXT", characters: "x" }] },
        }),
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ comments: [] }) });
    await syncFigma({ accessToken: "AT", userDataDir: dir, bridge });
    const added = bridge.added[0];
    await disconnectFigma(dir, bridge);
    expect(bridge.removed).toContain(added.id);
    await expect(fsp.access(path.join(dir, "figma-sync"))).rejects.toThrow();
  });

  it(
    "indexes every file on first sync even when timestamps are not strictly increasing " +
      "(regression: watermark-mutation-during-iteration bug)",
    async () => {
      // Three files where the SECOND file has a strictly newer
      // `last_modified` than the first. The buggy implementation set
      // the watermark to f1's timestamp after processing f1, then
      // skipped f2 and f3 because their timestamps were <= f1's. The
      // correct implementation must only consult the *pre-run*
      // watermark when deciding whether to skip.
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ teams: [{ id: "t1", name: "T" }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "T",
            projects: [{ id: "p1", name: "Proj" }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "Proj",
            files: [
              { key: "f1", name: "File 1", last_modified: "2024-06-01T12:00:00Z" },
              { key: "f2", name: "File 2", last_modified: "2024-06-01T08:00:00Z" },
              { key: "f3", name: "File 3", last_modified: "2024-06-01T12:00:00Z" },
            ],
          }),
        })
        // f1 file body + comments
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "File 1",
            lastModified: "2024-06-01T12:00:00Z",
            document: { id: "0:0", children: [{ id: "1:1", type: "TEXT", characters: "Body 1" }] },
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ comments: [] }) })
        // f2 file body + comments
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "File 2",
            lastModified: "2024-06-01T08:00:00Z",
            document: { id: "0:0", children: [{ id: "1:1", type: "TEXT", characters: "Body 2" }] },
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ comments: [] }) })
        // f3 file body + comments
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "File 3",
            lastModified: "2024-06-01T12:00:00Z",
            document: { id: "0:0", children: [{ id: "1:1", type: "TEXT", characters: "Body 3" }] },
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ comments: [] }) });

      const r = await syncFigma({ accessToken: "AT", userDataDir: dir, bridge });
      expect(r.added).toBe(3);
      expect(bridge.added).toHaveLength(3);
    },
  );

  it(
    "persists state + manifest even when getComments rejects mid-pass " +
      "(regression: BUG_0001 — uncaught fetch rejection aborted whole sync)",
    async () => {
      // Two files, both /v1/files/{key} return OK, but the SECOND
      // file's /v1/files/{key}/comments call rejects with a transport
      // error (DNS / socket reset) — the kind of failure that escapes
      // an un-try/catched `await getComments(...)`. The fix wraps the
      // call in try/catch AND wraps both sync phases in try/finally
      // so saveState + writeManifest run regardless.
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ teams: [{ id: "t1", name: "T" }] }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "T",
            projects: [{ id: "p1", name: "Proj" }],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "Proj",
            files: [
              { key: "f1", name: "File 1", last_modified: "2024-06-01T10:00:00Z" },
              { key: "f2", name: "File 2", last_modified: "2024-06-01T11:00:00Z" },
            ],
          }),
        })
        // f1 body OK + comments OK
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "File 1",
            lastModified: "2024-06-01T10:00:00Z",
            document: { id: "0:0", children: [{ id: "1:1", type: "TEXT", characters: "Body 1" }] },
          }),
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ comments: [] }) })
        // f2 body OK + comments REJECTS (transport-level)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "File 2",
            lastModified: "2024-06-01T11:00:00Z",
            document: { id: "0:0", children: [{ id: "1:1", type: "TEXT", characters: "Body 2" }] },
          }),
        })
        .mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND api.figma.com"));

      const r = await syncFigma({ accessToken: "AT", userDataDir: dir, bridge });
      // Both files were indexed — the comments failure on f2 fell back to "".
      expect(r.added).toBe(2);
      expect(bridge.added).toHaveLength(2);

      // The watermark MUST have been persisted (highest seen timestamp).
      const stateRaw = await fsp.readFile(
        path.join(dir, "figma-sync", "state.json"),
        "utf8",
      );
      const state = JSON.parse(stateRaw);
      expect(state.lastSyncIso).toBe("2024-06-01T11:00:00Z");

      // The manifest must exist with both entries.
      const manifest = JSON.parse(
        await fsp.readFile(
          path.join(dir, "figma-sync", "manifest.json"),
          "utf8",
        ),
      );
      expect(manifest.entries).toHaveLength(2);
      expect(manifest.entries.map((e: { remoteId: string }) => e.remoteId).sort()).toEqual([
        "f1",
        "f2",
      ]);
    },
  );

  it(
    "bumps failureCount by exactly one when a Phase-1 retry fails again " +
      "(regression: Devin Review wave 7 BUG_0001 — the defensive " +
      "cleanup used to add the key to succeededIds unconditionally, " +
      "which caused nextFailedRetryQueue to reset the count to 1)",
    async () => {
      const stateDir = path.join(dir, "figma-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      // Seed state with a retry entry already at failureCount=2 and a
      // saved teamIds list so the sync does NOT short-circuit via the
      // "no-teams" early return (which would skip Phase 1 entirely).
      await fsp.writeFile(
        path.join(stateDir, "state.json"),
        JSON.stringify({
          lastSyncIso: "2024-06-01T00:00:00Z",
          teamIds: ["t1"],
          failedRetries: [
            {
              remoteId: "transiently-broken",
              remoteModifiedAt: "2024-05-01T00:00:00Z",
              failureCount: 2,
            },
          ],
        }),
        "utf8",
      );

      fetchMock
        // Phase 1 retry: GET /v1/files/transiently-broken → 502
        .mockResolvedValueOnce({
          ok: false,
          status: 502,
          text: async () => "Bad Gateway",
        })
        // Phase 2: GET /v1/teams/t1/projects → empty (nothing else to do)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ name: "Team A", projects: [] }),
        });

      await syncFigma({ accessToken: "AT", userDataDir: dir, bridge });
      const state = JSON.parse(
        await fsp.readFile(path.join(dir, "figma-sync", "state.json"), "utf8"),
      ) as { failedRetries: Array<{ remoteId: string; failureCount: number }> };
      expect(state.failedRetries).toHaveLength(1);
      expect(state.failedRetries[0].remoteId).toBe("transiently-broken");
      // With the BUG_0001 fix, the entry stays in failedThisPass only
      // (NOT also in succeededIds), so nextFailedRetryQueue finds the
      // previous entry and bumps the count: 2 → 3. Without the fix, the
      // count would reset to 1 on every pass and the item would be
      // retried indefinitely (never reaching FAILED_RETRY_MAX_ATTEMPTS).
      expect(state.failedRetries[0].failureCount).toBe(3);
    },
  );

  it(
    "persists the watermark + manifest even when the iteration throws " +
      "an unexpected error (regression: Devin Review wave 7 ANALYSIS_0004 " +
      "— try/finally defense-in-depth around saveState + writeManifest)",
    async () => {
      // Seed teamIds so we get past the early "no-teams" return.
      const stateDir = path.join(dir, "figma-sync");
      await fsp.mkdir(stateDir, { recursive: true });
      await fsp.writeFile(
        path.join(stateDir, "state.json"),
        JSON.stringify({
          lastSyncIso: null,
          teamIds: ["t1"],
          failedRetries: [],
        }),
        "utf8",
      );

      // p1 has TWO files; f1 succeeds normally, then bridge.listSources
      // throws on the SECOND call (when f2 is being processed) — this
      // is exactly the failure mode try/finally exists to tolerate
      // (an unexpected error escaping the per-file inner code path
      // would otherwise skip saveState + writeManifest entirely).
      fetchMock
        // GET /v1/teams/t1/projects
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "Team A",
            projects: [{ id: "p1", name: "Proj 1" }],
          }),
        })
        // GET /v1/projects/p1/files → two files
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "Proj 1",
            files: [
              { key: "f1", name: "F1", last_modified: "2024-06-01T10:00:00Z" },
              { key: "f2", name: "F2", last_modified: "2024-06-01T11:00:00Z" },
            ],
          }),
        })
        // GET /v1/files/f1 (Phase 2 — first file)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "F1",
            lastModified: "2024-06-01T10:00:00Z",
            document: {
              id: "0:0",
              children: [{ id: "1", type: "TEXT", characters: "captured" }],
            },
          }),
        })
        // GET /v1/files/f1/comments → empty
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ comments: [] }),
        })
        // GET /v1/files/f2 — succeeds; the throw happens AFTER this in
        // syncFileByKey when listSources gets called for the second
        // time.
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            name: "F2",
            lastModified: "2024-06-01T11:00:00Z",
            document: { id: "0:0", children: [] },
          }),
        })
        // GET /v1/files/f2/comments → empty
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ comments: [] }),
        });

      // Throw on the 2nd `listSources` call only, so f1 completes
      // cleanly before the bridge "crashes" mid-iteration.
      let listCallCount = 0;
      const origList = bridge.listSources.bind(bridge);
      bridge.listSources = () => {
        listCallCount += 1;
        if (listCallCount > 1) {
          throw new Error("Simulated bridge crash mid-sync");
        }
        return origList();
      };

      await expect(
        syncFigma({ accessToken: "AT", userDataDir: dir, bridge }),
      ).rejects.toThrow();

      // Despite the throw, the state + manifest MUST be persisted with
      // the watermark advanced for f1.
      const state = JSON.parse(
        await fsp.readFile(path.join(dir, "figma-sync", "state.json"), "utf8"),
      ) as { lastSyncIso: string | null };
      expect(state.lastSyncIso).toBe("2024-06-01T10:00:00Z");

      const manifest = JSON.parse(
        await fsp.readFile(
          path.join(dir, "figma-sync", "manifest.json"),
          "utf8",
        ),
      ) as { entries: Array<{ remoteId: string }> };
      expect(manifest.entries.map((e) => e.remoteId)).toContain("f1");
    },
  );
});

describe("Jira sync — JQL watermark sanitisation", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("jira-jql");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it(
    "drops a malformed watermark from state.json instead of interpolating " +
      "it into JQL (regression: ANALYSIS_0004 — JQL injection vector)",
    async () => {
      // Pre-seed state.json with a malformed watermark containing a `"`
      // — the kind of value that would otherwise close the JQL string
      // literal and inject syntax. The fix: strict-ISO-8601 validation
      // drops the clause entirely, degrading to a full re-scan.
      const syncDir = path.join(dir, "jira-sync");
      await fsp.mkdir(syncDir, { recursive: true });
      await fsp.writeFile(
        path.join(syncDir, "state.json"),
        JSON.stringify({
          lastSyncIso: '2024-06-01" OR 1=1 OR updated >= "2024-06-01',
          cloudId: "cloud-1",
          failedRetries: [],
        }),
        "utf8",
      );

      // /rest/api/3/search response — single issue.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [
            {
              id: "10001",
              key: "PROJ-1",
              fields: {
                summary: "Hello",
                description: null,
                status: { name: "To Do" },
                project: { key: "PROJ", name: "Project" },
                updated: "2024-06-02T00:00:00.000+0000",
              },
            },
          ],
          startAt: 0,
          maxResults: 100,
          total: 1,
        }),
      });

      await syncJira({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
        cloudId: "cloud-1",
      });

      // The first fetch call must NOT contain the injected JQL fragment.
      const calls = fetchMock.mock.calls;
      const searchCall = calls.find((c) =>
        String(c[0]).includes("/rest/api/3/search"),
      );
      expect(searchCall).toBeDefined();
      const url = String(searchCall![0]);
      expect(url).not.toContain("OR 1=1");
      // The malformed watermark must have been dropped — JQL should be
      // a bare ORDER BY (no `updated >= "..."` clause).
      const jqlParam = new URL(url).searchParams.get("jql");
      expect(jqlParam).toBe("ORDER BY updated DESC");
    },
  );

  it(
    "accepts a well-formed ISO-8601 watermark verbatim and includes it " +
      "in the updated-since JQL clause",
    async () => {
      const syncDir = path.join(dir, "jira-sync");
      await fsp.mkdir(syncDir, { recursive: true });
      await fsp.writeFile(
        path.join(syncDir, "state.json"),
        JSON.stringify({
          lastSyncIso: "2024-06-01T10:00:00.000+0000",
          cloudId: "cloud-1",
          failedRetries: [],
        }),
        "utf8",
      );
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          issues: [],
          startAt: 0,
          maxResults: 100,
          total: 0,
        }),
      });

      await syncJira({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
        cloudId: "cloud-1",
      });

      const url = String(fetchMock.mock.calls[0][0]);
      const jql = new URL(url).searchParams.get("jql");
      expect(jql).toBe(
        'updated >= "2024-06-01T10:00:00.000+0000" ORDER BY updated DESC',
      );
    },
  );
});

describe("Jira sync — retry-queue load-time validation", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("jira-retry");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it(
    "drops a corrupted failedRetries entry whose remoteId is not a " +
      "JQL-safe identifier (regression: wave 9 ANALYSIS_0001 — escaped " +
      "vs raw key asymmetry)",
    async () => {
      // Pre-seed state.json with one legit retry key plus one corrupted
      // entry whose remoteId would be MUTATED by jqlEscapeKey (a quote
      // injection attempt). The fix: filter at load time so the
      // corrupted entry never makes it into the JQL OR the cleanup
      // loop's comparison set, AND the next save doesn't propagate it.
      const syncDir = path.join(dir, "jira-sync");
      await fsp.mkdir(syncDir, { recursive: true });
      await fsp.writeFile(
        path.join(syncDir, "state.json"),
        JSON.stringify({
          cloudId: "cloud-1",
          lastSyncIso: null,
          failedRetries: [
            // Legit — should survive and appear in the JQL.
            { remoteId: "ABC-1", remoteModifiedAt: null, failureCount: 1 },
            // Corrupted — must be dropped at load time. Without the fix
            // the cleanup loop iterates over the *escaped* form
            // (`ABC2DROP`), which would never match the raw API
            // issue.key (`ABC-2`), permanently stranding the entry.
            {
              remoteId: 'ABC-2"; DROP',
              remoteModifiedAt: null,
              failureCount: 1,
            },
            // Empty after escape — also dropped.
            { remoteId: '"""', remoteModifiedAt: null, failureCount: 1 },
            // Non-string — dropped.
            { remoteId: 42, remoteModifiedAt: null, failureCount: 1 },
          ],
        }),
        "utf8",
      );

      // The single search call returns the legit issue so it transitions
      // from failedRetries → succeededIds and is dropped from the queue.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          startAt: 0,
          maxResults: 50,
          total: 1,
          issues: [
            {
              id: "10001",
              key: "ABC-1",
              fields: {
                summary: "x",
                project: { key: "ABC", name: "P" },
                updated: "2024-06-01T10:00:00.000+0000",
              },
            },
          ],
        }),
      });

      await syncJira({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
        cloudId: "cloud-1",
      });

      // 1. The JQL must reference only ABC-1 — not the corrupted ids
      //    in any form (raw, escaped, or partial).
      const searchCall = fetchMock.mock.calls.find((c) =>
        String(c[0]).includes("/rest/api/3/search"),
      );
      expect(searchCall).toBeDefined();
      const jql = new URL(String(searchCall![0])).searchParams.get("jql") ?? "";
      expect(jql).toContain("ABC-1");
      // Corrupted ids must not appear in any escape variant.
      expect(jql).not.toContain("DROP");
      expect(jql).not.toContain('"');
      expect(jql).not.toContain("42");

      // 2. The persisted state must drop all corrupted entries — only
      //    a self-healed (empty or single-entry) queue should remain.
      //    ABC-1 was just succeeded so it leaves the queue. The two
      //    corrupted entries must NOT be carried forward.
      const finalState = JSON.parse(
        await fsp.readFile(
          path.join(dir, "jira-sync", "state.json"),
          "utf8",
        ),
      ) as { failedRetries: Array<{ remoteId: string }> };
      expect(finalState.failedRetries).toEqual([]);
    },
  );
});

describe(
  "Confluence sync — carry-forward when a space's listing fails",
  () => {
    const original = globalThis.fetch;
    let fetchMock: ReturnType<typeof makeFetchMock>;
    let dir: string;
    let bridge: FakeBridge;

    beforeEach(async () => {
      fetchMock = makeFetchMock();
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      dir = await tmpDir("conf-carry");
      bridge = new FakeBridge();
    });
    afterEach(async () => {
      globalThis.fetch = original;
      await fsp.rm(dir, { recursive: true, force: true });
    });

    it(
      "preserves per-page versions for pages in a space whose listing " +
        "threw, so the next sync does not re-process every page from " +
        "scratch (regression: wave 9 ANALYSIS_0004)",
      async () => {
        // ---- First sync: two spaces, four pages, all listed successfully ----
        fetchMock
          // /oauth/token/accessible-resources
          .mockResolvedValueOnce({
            ok: true,
            json: async () => [
              {
                id: "cloud-1",
                url: "https://x",
                name: "site",
                scopes: ["read:confluence-content.summary"],
              },
            ],
          })
          // /wiki/api/v2/spaces
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [
                { id: "s1", key: "ONE", name: "Space One" },
                { id: "s2", key: "TWO", name: "Space Two" },
              ],
            }),
          })
          // /wiki/api/v2/pages?space-id=s1
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [
                {
                  id: "p1a",
                  title: "P1A",
                  spaceId: "s1",
                  version: { number: 1 },
                  body: { storage: { value: "<p>v1</p>" } },
                },
                {
                  id: "p1b",
                  title: "P1B",
                  spaceId: "s1",
                  version: { number: 1 },
                  body: { storage: { value: "<p>v1</p>" } },
                },
              ],
            }),
          })
          // /wiki/api/v2/pages?space-id=s2
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [
                {
                  id: "p2a",
                  title: "P2A",
                  spaceId: "s2",
                  version: { number: 1 },
                  body: { storage: { value: "<p>v1</p>" } },
                },
                {
                  id: "p2b",
                  title: "P2B",
                  spaceId: "s2",
                  version: { number: 1 },
                  body: { storage: { value: "<p>v1</p>" } },
                },
              ],
            }),
          });

        const r1 = await syncConfluence({
          accessToken: "AT",
          userDataDir: dir,
          bridge,
        });
        expect(r1.added).toBe(4);
        expect(r1.modified).toBe(0);

        // After first sync, state must record both pageVersions AND
        // pageSpaces — the wave-9 schema enrichment.
        const state1 = JSON.parse(
          await fsp.readFile(
            path.join(dir, "confluence-sync", "state.json"),
            "utf8",
          ),
        ) as {
          pageVersions: Record<string, number>;
          pageSpaces: Record<string, string>;
        };
        expect(state1.pageVersions).toEqual({
          p1a: 1,
          p1b: 1,
          p2a: 1,
          p2b: 1,
        });
        expect(state1.pageSpaces).toEqual({
          p1a: "s1",
          p1b: "s1",
          p2a: "s2",
          p2b: "s2",
        });

        // ---- Second sync: s1 lists fine, s2 throws on listing ----
        // The expected behaviour: s1's pages remain in state (their
        // listings confirm they still exist at version 1). s2's pages
        // also remain in state (carry-forward because we know nothing
        // new about them). The previous behaviour dropped p2a/p2b from
        // state, which would have caused a full re-fetch + re-render
        // on the *third* sync once s2's listing recovers — wasting an
        // API call + disk write per page even though the content
        // didn't change.
        fetchMock
          // spaces — same payload (note: cloudId is persisted from
          // first sync, so accessible-resources is NOT called again).
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [
                { id: "s1", key: "ONE", name: "Space One" },
                { id: "s2", key: "TWO", name: "Space Two" },
              ],
            }),
          })
          // /wiki/api/v2/pages?space-id=s1 — same versions, unchanged.
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [
                {
                  id: "p1a",
                  title: "P1A",
                  spaceId: "s1",
                  version: { number: 1 },
                  body: { storage: { value: "<p>v1</p>" } },
                },
                {
                  id: "p1b",
                  title: "P1B",
                  spaceId: "s1",
                  version: { number: 1 },
                  body: { storage: { value: "<p>v1</p>" } },
                },
              ],
            }),
          })
          // /wiki/api/v2/pages?space-id=s2 — throws.
          .mockRejectedValueOnce(
            new Error("ECONNRESET — Atlassian API blip"),
          );

        const r2 = await syncConfluence({
          accessToken: "AT",
          userDataDir: dir,
          bridge,
        });
        // s1 pages skip the body-render path because they're unchanged
        // (version === previousVersion). s2 pages are not observed at
        // all. Nothing should be added or modified this pass.
        expect(r2.added).toBe(0);
        expect(r2.modified).toBe(0);

        const state2 = JSON.parse(
          await fsp.readFile(
            path.join(dir, "confluence-sync", "state.json"),
            "utf8",
          ),
        ) as {
          pageVersions: Record<string, number>;
          pageSpaces: Record<string, string>;
        };
        // All four pages remain in state with their previous versions —
        // s1's by direct observation, s2's by carry-forward.
        expect(state2.pageVersions).toEqual({
          p1a: 1,
          p1b: 1,
          p2a: 1,
          p2b: 1,
        });
        expect(state2.pageSpaces).toEqual({
          p1a: "s1",
          p1b: "s1",
          p2a: "s2",
          p2b: "s2",
        });
      },
    );

    it(
      "drops pages whose space listed successfully but no longer " +
        "contains them (page actually deleted upstream)",
      async () => {
        // Pre-seed state as if a previous sync recorded two pages in s1.
        const syncDir = path.join(dir, "confluence-sync");
        await fsp.mkdir(syncDir, { recursive: true });
        await fsp.writeFile(
          path.join(syncDir, "state.json"),
          JSON.stringify({
            cloudId: "cloud-1",
            pageVersions: { p1a: 1, p1b: 1 },
            pageSpaces: { p1a: "s1", p1b: "s1" },
          }),
          "utf8",
        );

        fetchMock
          // spaces
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [{ id: "s1", key: "ONE", name: "Space One" }],
            }),
          })
          // pages — only p1a remains; p1b is gone (deleted upstream).
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [
                {
                  id: "p1a",
                  title: "P1A",
                  spaceId: "s1",
                  version: { number: 1 },
                  body: { storage: { value: "<p>v1</p>" } },
                },
              ],
            }),
          });

        await syncConfluence({
          accessToken: "AT",
          userDataDir: dir,
          bridge,
        });

        const state = JSON.parse(
          await fsp.readFile(
            path.join(dir, "confluence-sync", "state.json"),
            "utf8",
          ),
        ) as {
          pageVersions: Record<string, number>;
          pageSpaces: Record<string, string>;
        };
        // p1b's space listed cleanly but p1b wasn't returned → drop.
        expect(state.pageVersions).toEqual({ p1a: 1 });
        expect(state.pageSpaces).toEqual({ p1a: "s1" });
      },
    );

    // ---------------------------------------------------------------
    // Wave 11 ANALYSIS_0005 (🚩): when a Confluence page is confirmed
    // deleted upstream, the connector must propagate the deletion all
    // the way through the local workspace:
    //   - increment the `removed` counter so the IPC return reflects it
    //   - remove the bridge source-index entry so search stops returning it
    //   - unlink the local on-disk file so it doesn't linger
    //   - prune the manifest entry so the next sync's seed doesn't reintroduce it
    // ---------------------------------------------------------------
    it(
      "cascades upstream deletion into bridge / disk / manifest / counter",
      async () => {
        const syncDir = path.join(dir, "confluence-sync");
        await fsp.mkdir(syncDir, { recursive: true });

        // Pre-seed the manifest with a previously-synced page p1b.
        const p1bPath = path.join(syncDir, "p1b.md");
        await fsp.writeFile(p1bPath, "# stale\n", "utf8");
        await fsp.writeFile(
          path.join(syncDir, "manifest.json"),
          JSON.stringify({
            version: 1,
            provider: "confluence",
            entries: [
              { localPath: p1bPath, remoteId: "p1b", remoteModifiedAt: "1" },
              // p1a manifest entry is intentionally seeded too so the
              // assertion that *only* p1b is pruned is meaningful.
              {
                localPath: path.join(syncDir, "p1a.md"),
                remoteId: "p1a",
                remoteModifiedAt: "1",
              },
            ],
          }),
          "utf8",
        );

        // Pre-seed the bridge with the matching source so we can
        // observe the `removeSource` call.
        const p1bSource = bridge.addLocalFile(p1bPath);
        bridge.added.length = 0; // ignore the seed in the assertion below

        // Pre-seed the version-state.
        await fsp.writeFile(
          path.join(syncDir, "state.json"),
          JSON.stringify({
            cloudId: "cloud-1",
            pageVersions: { p1a: 1, p1b: 1 },
            pageSpaces: { p1a: "s1", p1b: "s1" },
          }),
          "utf8",
        );

        fetchMock
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [{ id: "s1", key: "ONE", name: "Space One" }],
            }),
          })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({
              results: [
                {
                  id: "p1a",
                  title: "P1A",
                  spaceId: "s1",
                  version: { number: 1 },
                  body: { storage: { value: "<p>still here</p>" } },
                },
              ],
            }),
          });

        const result = await syncConfluence({
          accessToken: "AT",
          userDataDir: dir,
          bridge,
        });

        // 1. Counter surfaced to the renderer.
        expect(result.removed).toBe(1);
        // 2. Bridge source entry removed.
        expect(bridge.removed).toContain(p1bSource.id);
        // 3. Local file unlinked.
        await expect(fsp.access(p1bPath)).rejects.toThrow();
        // 4. Manifest entry pruned (and p1a survives).
        const manifest = JSON.parse(
          await fsp.readFile(
            path.join(syncDir, "manifest.json"),
            "utf8",
          ),
        ) as { entries: Array<{ remoteId: string }> };
        const ids = manifest.entries.map((e) => e.remoteId).sort();
        expect(ids).toEqual(["p1a"]);
      },
    );

    it(
      "carries forward legacy state entries that lack a recorded " +
        "space id (pre-wave-9 state.json migration)",
      async () => {
        // Legacy state: pageVersions populated, pageSpaces missing.
        // The carry-forward must default to "unknown" → keep the entry
        // alive while the state self-heals on the next successful
        // listing.
        const syncDir = path.join(dir, "confluence-sync");
        await fsp.mkdir(syncDir, { recursive: true });
        await fsp.writeFile(
          path.join(syncDir, "state.json"),
          JSON.stringify({
            cloudId: "cloud-1",
            pageVersions: { p_legacy: 7 },
            // pageSpaces deliberately omitted (legacy schema).
          }),
          "utf8",
        );

        // No spaces, no pages this sync (e.g. user lost access
        // temporarily). The legacy entry must NOT be dropped.
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: async () => ({ results: [] }),
        });

        await syncConfluence({
          accessToken: "AT",
          userDataDir: dir,
          bridge,
        });

        const state = JSON.parse(
          await fsp.readFile(
            path.join(dir, "confluence-sync", "state.json"),
            "utf8",
          ),
        ) as {
          pageVersions: Record<string, number>;
          pageSpaces: Record<string, string>;
        };
        expect(state.pageVersions).toEqual({ p_legacy: 7 });
        // pageSpaces remains empty for the legacy entry — it will
        // populate on the next sync if/when the page is observed.
        expect(state.pageSpaces).toEqual({});
      },
    );
  },
);

describe("Google Drive sync — manifest cleanup", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("gdrive");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it(
    "deletes the manifest file when every tracked id is confirmed " +
      "remotely deleted (regression: stale-manifest 404 loop)",
    async () => {
      // Pre-seed a manifest containing two file ids whose files
      // already exist on disk. The Drive API will return 404 for
      // both, marking them as remotely deleted. After this sync the
      // manifest must be removed entirely — leaving an empty `[]`
      // file would still cause `readGdriveManifest` to short-circuit
      // future syncs that should be exercising the empty path.
      const syncDir = path.join(dir, "gdrive-sync");
      await fsp.mkdir(syncDir, { recursive: true });
      const f1 = path.join(syncDir, "file-1.txt");
      const f2 = path.join(syncDir, "file-2.txt");
      await fsp.writeFile(f1, "stale 1");
      await fsp.writeFile(f2, "stale 2");
      const manifestPath = path.join(syncDir, "manifest.json");
      await fsp.writeFile(manifestPath, JSON.stringify([f1, f2]), "utf8");
      // Pretend the bridge already has source records for the two
      // files so the disconnect cleanup path runs.
      bridge.addLocalFile(f1);
      bridge.addLocalFile(f2);

      // Both metadata fetches 404 → both ids land in failedFileIds.
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({ ok: false, status: 404 });

      const r = await syncGoogleDrive({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
      });
      expect(r.removed).toBe(2);
      // Manifest must no longer exist (NOT an empty JSON array).
      await expect(fsp.access(manifestPath)).rejects.toThrow();
    },
  );

  // ---------------------------------------------------------------
  // Wave 12 ANALYSIS_0001 — gdrive lacked the try/finally manifest
  // persistence pattern that all five other connectors have. A
  // transport-level `fetch` rejection mid-loop (DNS failure, socket
  // reset, undici AbortError) skipped the manifest write entirely,
  // so the next sync re-pulled every file that had already landed
  // on disk. This test exercises that exact scenario: first selected
  // file syncs successfully and lands a real bridge source; second
  // selected file's metadata fetch *throws* (not just non-ok response,
  // a real rejection). The function must still persist the manifest
  // with the first file's path before propagating the throw.
  // ---------------------------------------------------------------
  it(
    "persists manifest progress even when fetch rejects mid-loop " +
      "(regression: wave 12 ANALYSIS_0001 try/finally parity)",
    async () => {
      // First file: meta then media — both successful.
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "good-1",
            name: "good.txt",
            mimeType: "text/plain",
            size: "5",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
        })
        // Second file's metadata fetch throws (transport-level
        // rejection — what fetch() does on DNS failure or socket reset).
        .mockRejectedValueOnce(
          Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
        );

      await expect(
        syncGoogleDrive({
          accessToken: "AT",
          userDataDir: dir,
          bridge,
          selectedFileIds: ["good-1", "bad-1"],
        }),
      ).rejects.toThrow(/ENOTFOUND/);

      // The manifest must contain the successfully-synced file even
      // though the loop threw on the second id. Without the
      // try/finally fix, the manifest write would have been skipped
      // and the next sync would re-pull `good-1` from scratch.
      const manifestPath = path.join(dir, "gdrive-sync", "manifest.json");
      const raw = await fsp.readFile(manifestPath, "utf8");
      const persisted = JSON.parse(raw) as string[];
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatch(/good-1\.txt$/);
    },
  );

  // ---------------------------------------------------------------
  // Wave 12 ANALYSIS_0004 — the finally block's manifest write is
  // wrapped in a nested try/catch so a state-write error does NOT
  // shadow the original upstream error. This test simulates the
  // pathological case: the sync loop throws, AND the manifest
  // persistence also fails (sync dir replaced with a file mid-flight
  // so mkdir fails). The user must see the *original* network error,
  // not a derived EEXIST/EACCES from the recovery step.
  // ---------------------------------------------------------------
  it(
    "preserves the original throw when manifest persistence in " +
      "finally also fails (regression: wave 12 ANALYSIS_0004 " +
      "finally-mask)",
    async () => {
      fetchMock.mockRejectedValueOnce(
        Object.assign(new Error("upstream specific failure"), {
          code: "ECONNRESET",
        }),
      );

      // Replace the gdrive-sync dir with a regular file so the
      // finally-block's mkdir(recursive) fails with ENOTDIR. (Note:
      // we have to do this AFTER the initial mkdir at the top of
      // syncGoogleDrive, so we shim writeFile to fail instead.)
      const syncDir = path.join(dir, "gdrive-sync");
      await fsp.mkdir(syncDir, { recursive: true });
      // Lock the file by making the directory read-only — writeFile
      // for the manifest will fail.
      const fs = await import("fs");
      const originalWriteFile = fs.promises.writeFile;
      const writeSpy = vi
        .spyOn(fs.promises, "writeFile")
        .mockImplementation(async (...args) => {
          const [p] = args;
          if (typeof p === "string" && p.endsWith("manifest.json")) {
            throw Object.assign(new Error("derived ENOSPC"), { code: "ENOSPC" });
          }
          return originalWriteFile(...(args as Parameters<typeof originalWriteFile>));
        });

      try {
        await expect(
          syncGoogleDrive({
            accessToken: "AT",
            userDataDir: dir,
            bridge,
            selectedFileIds: ["bad-1"],
          }),
        ).rejects.toThrow(/upstream specific failure/);
      } finally {
        writeSpy.mockRestore();
      }
    },
  );
});

// =================================================================
// Wave 13 — token refresh + cascading-deletion regression tests
// =================================================================
//
// These cover the four real bugs flagged by Devin Review on
// commit 707f9f7:
//
//   BUG_0001 + ANALYSIS_0007 — the connector's hot loop used a
//   single pre-resolved access token, so any sync that ran longer
//   than the OAuth token's remaining lifetime (Google issues 1h
//   tokens with a 60s buffer) failed every fetch after the
//   60-minute mark with HTTP 401. Fix: `getAccessToken: () =>
//   Promise<string>` callback threaded through every connector;
//   each iteration calls `resolveAccessToken(ctx)` to pull a fresh
//   token. Tests below mock the callback to return a different
//   value on each call and assert all expected calls happened.
//
//   ANALYSIS_0001 — `removed` was declared `const removed = 0`
//   and never incremented in notion.ts, jira.ts, figma.ts. Unlike
//   OneDrive/Confluence which cascade upstream deletions, these
//   three connectors silently left local files + bridge sources
//   intact when the upstream item was deleted (Notion 404, Figma
//   404/410, Jira: retry key not returned by the JQL search).
//   Fix: cascade the deletion to `bridge.removeSource`, unlink
//   the local file, decrement the manifest entry, increment
//   `removed`. Tests below verify all three.
//

describe("Wave 13 — token refresh + cascading deletions", () => {
  const original = globalThis.fetch;
  let fetchMock: ReturnType<typeof makeFetchMock>;
  let dir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = makeFetchMock();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    dir = await tmpDir("wave13");
    bridge = new FakeBridge();
  });
  afterEach(async () => {
    globalThis.fetch = original;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // BUG_0001 — gdrive must call `getAccessToken` BEFORE every file
  // iteration so a token expiring mid-sync transparently refreshes.
  // Test: supply a getAccessToken that returns a fresh token on each
  // call, verify it was called at least once per file id, and verify
  // every Drive Authorization header used the fresh token.
  // ---------------------------------------------------------------
  it(
    "gdrive calls getAccessToken per-iteration so mid-sync token " +
      "refresh transparently kicks in (regression: wave 13 BUG_0001)",
    async () => {
      const tokens = ["T1", "T2", "T3", "T4"];
      let callCount = 0;
      const getAccessToken = vi.fn(async () => {
        const t = tokens[Math.min(callCount, tokens.length - 1)];
        callCount += 1;
        return t;
      });

      // Two files; each consumes one meta + one media fetch.
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "a",
            name: "a.txt",
            mimeType: "text/plain",
            size: "1",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("a").buffer,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            id: "b",
            name: "b.txt",
            mimeType: "text/plain",
            size: "1",
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new TextEncoder().encode("b").buffer,
        });

      await syncGoogleDrive({
        accessToken: "static-initial",
        getAccessToken,
        userDataDir: dir,
        bridge,
        selectedFileIds: ["a", "b"],
      });

      // One refresh per file iteration. The static `accessToken`
      // must NEVER appear in any request header — the callback
      // takes precedence whenever present.
      expect(getAccessToken).toHaveBeenCalledTimes(2);
      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(4);
      for (const call of calls) {
        const headers = call[1]?.headers as Record<string, string>;
        const auth = headers?.Authorization ?? "";
        expect(auth).not.toContain("static-initial");
        // First two calls should use T1, second two T2.
      }
      // Specific assertion: file `a` saw token T1 in both meta + media;
      // file `b` saw T2.
      expect(
        (calls[0][1]?.headers as Record<string, string>).Authorization,
      ).toBe("Bearer T1");
      expect(
        (calls[1][1]?.headers as Record<string, string>).Authorization,
      ).toBe("Bearer T1");
      expect(
        (calls[2][1]?.headers as Record<string, string>).Authorization,
      ).toBe("Bearer T2");
      expect(
        (calls[3][1]?.headers as Record<string, string>).Authorization,
      ).toBe("Bearer T2");
    },
  );

  // ---------------------------------------------------------------
  // BUG_0001 (cross-cutting ANALYSIS_0007) — onedrive's pagination
  // loop must also refresh per page. Single delta page + finalLink.
  // ---------------------------------------------------------------
  it(
    "onedrive calls getAccessToken per delta page (regression: wave 13 " +
      "BUG_0001 cross-cutting variant)",
    async () => {
      const { syncOneDrive } = await import("../ipc/connectors/onedrive");
      const getAccessToken = vi.fn(async () => "REFRESHED");

      fetchMock
        // Page 1
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            value: [],
            "@odata.deltaLink": "https://graph.example/delta-final",
          }),
        });

      await syncOneDrive({
        accessToken: "static-initial",
        getAccessToken,
        userDataDir: dir,
        bridge,
      });

      expect(getAccessToken).toHaveBeenCalled();
      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      // The first request (delta pull) must use the refreshed token,
      // not the initial static one.
      expect(
        (calls[0][1]?.headers as Record<string, string>).Authorization,
      ).toBe("Bearer REFRESHED");
    },
  );

  // ---------------------------------------------------------------
  // ANALYSIS_0001 (Figma) — when the upstream file returns 404 and
  // the file was previously tracked in the manifest, the connector
  // must cascade: removeSource on the bridge, unlink the local
  // markdown file, decrement entriesById, and increment `removed`.
  // Previously this branch silently kept the local file + source.
  // ---------------------------------------------------------------
  it(
    "figma cascades upstream-deletion 404 to local file + bridge " +
      "source (regression: wave 13 ANALYSIS_0001)",
    async () => {
      // Pre-seed manifest + bridge so we have something to delete.
      const figmaDir = path.join(dir, "figma-sync");
      await fsp.mkdir(figmaDir, { recursive: true });
      const localFile = path.join(figmaDir, "abc.md");
      await fsp.writeFile(localFile, "stale figma export", "utf8");
      const manifest = {
        version: 1,
        provider: "figma",
        entries: [
          {
            localPath: localFile,
            remoteId: "abc",
            remoteModifiedAt: "2024-01-01T00:00:00Z",
          },
        ],
      };
      await fsp.writeFile(
        path.join(figmaDir, "manifest.json"),
        JSON.stringify(manifest),
        "utf8",
      );
      // Pre-seed the bridge so `removeSource` has something to remove.
      const seeded = bridge.addLocalFile(localFile);
      bridge.added = []; // reset assertion counter
      // Seed state.json so the retry queue picks up `abc`.
      await fsp.writeFile(
        path.join(figmaDir, "state.json"),
        JSON.stringify({
          lastSyncIso: null,
          teamIds: ["team-1"],
          failedRetries: [
            {
              remoteId: "abc",
              remoteModifiedAt: "2024-01-01T00:00:00Z",
              failureCount: 1,
            },
          ],
        }),
        "utf8",
      );

      // Phase 1: getFile("abc") → 404. Then Phase 2 lists projects
      // and finds nothing new.
      fetchMock
        // getFile abc → 404
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          text: async () => "not found",
        })
        // listProjects(team-1) → empty
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ name: "team-1", projects: [] }),
        });

      const r = await syncFigma({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
      });

      expect(r.removed).toBe(1);
      // Bridge must have removed the seeded source.
      expect(bridge.removed).toContain(seeded.id);
      // Local file must be gone from disk.
      await expect(fsp.access(localFile)).rejects.toThrow();
    },
  );

  // ---------------------------------------------------------------
  // ANALYSIS_0001 (Notion) — when fetchPageById returns null
  // (HTTP 404/410) for an entry that exists in the prior manifest,
  // the connector must cascade: removeSource, unlink, entriesById
  // delete, increment removed.
  // ---------------------------------------------------------------
  it(
    "notion cascades upstream-deletion 404 to local file + bridge " +
      "source (regression: wave 13 ANALYSIS_0001)",
    async () => {
      const notionDir = path.join(dir, "notion-sync");
      await fsp.mkdir(notionDir, { recursive: true });
      const localFile = path.join(notionDir, "page-dead.md");
      await fsp.writeFile(localFile, "stale notion export", "utf8");
      await fsp.writeFile(
        path.join(notionDir, "manifest.json"),
        JSON.stringify({
          version: 1,
          provider: "notion",
          entries: [
            {
              localPath: localFile,
              remoteId: "page-dead",
              remoteModifiedAt: "2024-01-01T00:00:00Z",
            },
          ],
        }),
        "utf8",
      );
      const seeded = bridge.addLocalFile(localFile);
      bridge.added = [];
      await fsp.writeFile(
        path.join(notionDir, "watermark.json"),
        JSON.stringify({
          lastSyncIso: null,
          failedRetries: [
            {
              remoteId: "page-dead",
              remoteModifiedAt: "2024-01-01T00:00:00Z",
              failureCount: 1,
            },
          ],
        }),
        "utf8",
      );

      // Phase 1 fetchPageById → 404. Phase 2 /search → empty.
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 404 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          }),
        });

      const r = await syncNotion({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
      });

      expect(r.removed).toBe(1);
      expect(bridge.removed).toContain(seeded.id);
      await expect(fsp.access(localFile)).rejects.toThrow();
    },
  );

  // ---------------------------------------------------------------
  // ANALYSIS_0001 (Jira) — when a retry key is asked for via the JQL
  // `key in (...)` clause but the search response never returns it
  // (issue was deleted in Jira), and the key existed in the prior
  // manifest, the connector must cascade.
  // ---------------------------------------------------------------
  it(
    "jira cascades absent-retry-key to local file + bridge source " +
      "(regression: wave 13 ANALYSIS_0001)",
    async () => {
      const jiraDir = path.join(dir, "jira-sync");
      await fsp.mkdir(jiraDir, { recursive: true });
      const localFile = path.join(jiraDir, "PROJ-1.md");
      await fsp.writeFile(localFile, "stale jira export", "utf8");
      await fsp.writeFile(
        path.join(jiraDir, "manifest.json"),
        JSON.stringify({
          version: 1,
          provider: "jira",
          entries: [
            {
              localPath: localFile,
              remoteId: "PROJ-1",
              remoteModifiedAt: "2024-01-01T00:00:00Z",
            },
          ],
        }),
        "utf8",
      );
      const seeded = bridge.addLocalFile(localFile);
      bridge.added = [];
      // state.json: cloudId pre-resolved, PROJ-1 in retry queue.
      await fsp.writeFile(
        path.join(jiraDir, "state.json"),
        JSON.stringify({
          cloudId: "cloud-1",
          lastSyncIso: null,
          failedRetries: [
            {
              remoteId: "PROJ-1",
              remoteModifiedAt: "2024-01-01T00:00:00Z",
              failureCount: 1,
            },
          ],
        }),
        "utf8",
      );

      // Search response: empty (PROJ-1 not returned → deleted).
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: [], startAt: 0, total: 0, maxResults: 50 }),
      });

      const r = await syncJira({
        accessToken: "AT",
        userDataDir: dir,
        bridge,
      });

      expect(r.removed).toBe(1);
      expect(bridge.removed).toContain(seeded.id);
      await expect(fsp.access(localFile)).rejects.toThrow();
    },
  );
});
