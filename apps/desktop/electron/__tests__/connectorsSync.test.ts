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
});

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
});
