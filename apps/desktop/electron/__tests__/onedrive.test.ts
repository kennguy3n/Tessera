import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fsp from "fs/promises";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
}));

import { syncOneDrive, disconnectOneDrive, __test as oneDriveTest } from "../ipc/connectors/onedrive";
import { readManifest } from "../ipc/connectors/syncDir";

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

  // ---------------------------------------------------------------
  // Wave 10 BUG_0001: state must persist even if pagination throws
  // mid-iteration. Without the try/finally wrapping the loop, every
  // item already downloaded from earlier pages would be silently
  // discarded from the manifest and the next sync would re-walk the
  // entire drive.
  // ---------------------------------------------------------------
  it("persists manifest entries from completed pages when a later page throws", async () => {
    fetchMock
      // page 1: yields one indexable item + nextLink (still more pages)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "p1-item",
              name: "page1.md",
              size: 5,
              file: { mimeType: "text/markdown" },
              "@microsoft.graph.downloadUrl": "https://example.com/p1",
              lastModifiedDateTime: "2024-06-01T10:00:00Z",
            },
          ],
          "@odata.nextLink": "https://example.com/page-2",
        }),
      })
      // download of the page-1 item
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new TextEncoder().encode("aaaaa").buffer,
      })
      // page 2: blows up with a 500
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => '{"error":{"code":"InternalServerError"}}',
      });

    await expect(
      syncOneDrive({ accessToken: "AT", userDataDir, bridge }),
    ).rejects.toThrow(/delta request failed/);

    // The page-1 item must still be in the manifest after the throw.
    const manifest = await readManifest(userDataDir, "onedrive");
    const entry = manifest.entries.find((e) => e.remoteId === "p1-item");
    expect(entry).toBeDefined();
    expect(entry?.localPath).toMatch(/onedrive-sync/);
    expect(bridge.added).toHaveLength(1);
    expect(bridge.added[0].path).toBe(entry?.localPath);

    // And the delta marker must NOT have advanced past page 1 — we
    // never reached a deltaLink, so the next sync re-walks (which is
    // idempotent because the manifest already has the item).
    const deltaRaw = await fsp.readFile(oneDriveTest.deltaStatePath(userDataDir), "utf8");
    expect(JSON.parse(deltaRaw)).toEqual({ deltaLink: null });
  });

  // ---------------------------------------------------------------
  // Wave 10 ANALYSIS_0005: the module-level doc comment promises that
  // EPUB / RTF / OneNote files are indexed, but the original regex
  // only matched the Office/Markdown/PDF set. Verify the extension
  // matcher now matches the documented types and that the MIME-type
  // matcher works for OneNote / EPUB / RTF too.
  // ---------------------------------------------------------------
  it("indexes EPUB, RTF, and OneNote files matching the documented allowlist", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          value: [
            {
              id: "epub-1",
              name: "book.epub",
              size: 10,
              // Graph sometimes returns octet-stream for EPUBs; the
              // extension matcher must still pick them up.
              file: { mimeType: "application/octet-stream" },
              "@microsoft.graph.downloadUrl": "https://example.com/epub",
            },
            {
              id: "rtf-1",
              name: "memo.rtf",
              size: 5,
              file: { mimeType: "application/rtf" },
              "@microsoft.graph.downloadUrl": "https://example.com/rtf",
            },
            {
              id: "one-1",
              name: "notebook.one",
              size: 7,
              // No MIME at all — extension allowlist must handle it.
              file: {},
              "@microsoft.graph.downloadUrl": "https://example.com/one",
            },
            {
              id: "onenote-mime",
              name: "section",
              size: 4,
              file: { mimeType: "application/onenote" },
              "@microsoft.graph.downloadUrl": "https://example.com/onenote-mime",
            },
            {
              id: "skip-1",
              name: "image.heic",
              size: 999,
              file: { mimeType: "image/heic" },
              "@microsoft.graph.downloadUrl": "https://example.com/skip",
            },
          ],
          "@odata.deltaLink": "https://example.com/delta-2",
        }),
      })
      // 4 downloads expected — one per indexable item, none for HEIC
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) });

    const result = await syncOneDrive({ accessToken: "AT", userDataDir, bridge });
    expect(result.added).toBe(4);
    const paths = bridge.added.map((s) => s.path).sort();
    expect(paths.some((p) => p.endsWith(".epub"))).toBe(true);
    expect(paths.some((p) => p.endsWith(".rtf"))).toBe(true);
    // The `.one` extension and the MIME-only OneNote section both
    // landed; one as `.one` and one as a synthesized fallback (the
    // section name had no extension so the file is `.bin`).
    expect(paths.some((p) => p.endsWith(".one"))).toBe(true);
    // The HEIC image must NOT have been pulled.
    expect(paths.some((p) => /image\.heic$/.test(p))).toBe(false);
  });
});
