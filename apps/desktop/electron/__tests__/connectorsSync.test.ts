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
});
