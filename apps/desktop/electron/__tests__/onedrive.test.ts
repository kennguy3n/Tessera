import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fsp from "fs/promises";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
}));

import { syncOneDrive, disconnectOneDrive } from "../ipc/connectors/onedrive";

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

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-onedrive-"));
  return dir;
}

describe("OneDrive sync", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let userDataDir: string;
  let bridge: FakeBridge;

  beforeEach(async () => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    userDataDir = await makeTempDir();
    bridge = new FakeBridge();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await fsp.rm(userDataDir, { recursive: true, force: true });
  });

  it("pulls indexable items, downloads them, and registers them as sources", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "1",
              name: "notes.md",
              size: 12,
              file: { mimeType: "text/markdown" },
              lastModifiedDateTime: "2024-06-01T10:00:00Z",
              "@microsoft.graph.downloadUrl": "https://example.com/1",
            },
            {
              id: "F",
              name: "Folder",
              folder: {},
            },
          ],
          "@odata.deltaLink": "https://example.com/delta-2",
        }),
      })
      // download of item 1
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("hello").buffer,
      });

    const result = await syncOneDrive({
      accessToken: "AT",
      userDataDir,
      bridge,
    });
    expect(result.added).toBe(1);
    expect(result.modified).toBe(0);
    expect(result.removed).toBe(0);
    expect(bridge.added).toHaveLength(1);
    expect(bridge.added[0].path).toMatch(/onedrive-sync/);
    const onDisk = await fsp.readFile(bridge.added[0].path, "utf8");
    expect(onDisk).toBe("hello");
  });

  it("reindexes existing sources on a delta-modified item", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "1",
              name: "x.txt",
              size: 3,
              file: { mimeType: "text/plain" },
              "@microsoft.graph.downloadUrl": "https://example.com/1",
            },
          ],
          "@odata.deltaLink": "https://example.com/delta-2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("v1").buffer,
      });
    await syncOneDrive({ accessToken: "AT", userDataDir, bridge });
    const firstAdded = bridge.added[0];

    // Now simulate a second sync where the same item is updated.
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "1",
              name: "x.txt",
              size: 4,
              file: { mimeType: "text/plain" },
              "@microsoft.graph.downloadUrl": "https://example.com/1",
            },
          ],
          "@odata.deltaLink": "https://example.com/delta-3",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("v2!").buffer,
      });
    const result = await syncOneDrive({ accessToken: "AT", userDataDir, bridge });
    expect(result.modified).toBe(1);
    expect(bridge.reindexed).toContain(firstAdded.id);
  });

  it("removes local files and source entries on deletion", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "1",
              name: "x.txt",
              size: 3,
              file: { mimeType: "text/plain" },
              "@microsoft.graph.downloadUrl": "https://example.com/1",
            },
          ],
          "@odata.deltaLink": "https://example.com/delta-2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("v1").buffer,
      });
    await syncOneDrive({ accessToken: "AT", userDataDir, bridge });
    const addedSource = bridge.added[0];

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        value: [{ id: "1", deleted: { state: "deleted" } }],
        "@odata.deltaLink": "https://example.com/delta-3",
      }),
    });
    const result = await syncOneDrive({ accessToken: "AT", userDataDir, bridge });
    expect(result.removed).toBe(1);
    expect(bridge.removed).toContain(addedSource.id);
  });

  it("paginates via @odata.nextLink until @odata.deltaLink appears", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
          "@odata.nextLink": "https://example.com/delta-page-2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [],
          "@odata.deltaLink": "https://example.com/delta-2",
        }),
      });
    const result = await syncOneDrive({ accessToken: "AT", userDataDir, bridge });
    expect(result.added).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a graph error", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"error":{"code":"InvalidAuthenticationToken"}}',
    });
    await expect(
      syncOneDrive({ accessToken: "AT", userDataDir, bridge }),
    ).rejects.toThrow(/delta request failed/);
  });

  it("disconnect removes the sync directory and matching sources", async () => {
    // Stage a manifest by running a sync first
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "1",
              name: "x.txt",
              size: 3,
              file: { mimeType: "text/plain" },
              "@microsoft.graph.downloadUrl": "https://example.com/1",
            },
          ],
          "@odata.deltaLink": "https://example.com/delta-2",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("v1").buffer,
      });
    await syncOneDrive({ accessToken: "AT", userDataDir, bridge });
    const added = bridge.added[0];

    await disconnectOneDrive(userDataDir, bridge);
    expect(bridge.removed).toContain(added.id);
    await expect(
      fsp.access(path.join(userDataDir, "onedrive-sync")),
    ).rejects.toThrow();
  });
});
