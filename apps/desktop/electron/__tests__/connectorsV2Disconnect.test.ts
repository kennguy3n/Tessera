/**
 * Regression test for the Google Drive disconnect orphan-files bug.
 *
 * The active sync backend is chosen at runtime (legacy TS impl vs. the
 * v2 `connector_framework` bridge). Google Drive is the one provider
 * whose two backends use DIFFERENT on-disk directories — legacy keys
 * its sync dir/manifest on the short name `"gdrive"` (`gdrive-sync/`)
 * while the v2 path uses the canonical id `"google_drive"`
 * (`google_drive-sync/`). The original `runDisconnect` only ran the
 * legacy cleanup, so every file a v2 sync wrote was orphaned on disk
 * after disconnect (data loss on the default `useV2Connectors=true`).
 *
 * `runDisconnect` now cleans BOTH backends. This test drives a real v2
 * sync (which writes `google_drive-sync/`) plus a hand-built legacy
 * `gdrive-sync/`, then asserts a single disconnect removes every file,
 * directory, and bridge source from both.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { fromWebContents: () => null },
}));

import { runDisconnect } from "../ipc/connectors/handlers";
import { runV2Sync, type SyncOutcome } from "../ipc/connectors/connectorsV2";
import type { IpcContext } from "../ipc/context";
import type { StoredTokens } from "../tokenVault";

interface Source {
  id: string;
  path: string;
}

/**
 * One backing source registry shared by both facades below so the
 * sources a sync registers are the same ones disconnect sees.
 */
class SourceStore {
  sources: Source[] = [];
  private idc = 1;
  add(p: string): Source {
    const s: Source = { id: `src-${this.idc++}`, path: p };
    this.sources.push(s);
    return s;
  }
  remove(id: string): void {
    this.sources = this.sources.filter((s) => s.id !== id);
  }
  list(): Source[] {
    return this.sources.slice();
  }
}

const TOKENS: StoredTokens = {
  accessToken: "access-123",
  refreshToken: "refresh-456",
  expiresAt: Date.UTC(2030, 0, 1),
  scopes: ["drive.readonly"],
  clientId: "client-abc",
  clientSecret: "secret-xyz",
};

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

describe("runDisconnect — Google Drive cleans both sync backends", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-gd-disc-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("purges the v2 google_drive-sync dir AND the legacy gdrive-sync dir", async () => {
    const store = new SourceStore();

    // v2 hooks facade (addLocalFile/reindexSource/removeSource/listSources).
    const v2Hooks = {
      addLocalFile: (p: string) => store.add(p),
      reindexSource: () => {},
      removeSource: (id: string) => store.remove(id),
      listSources: () => store.list(),
    };

    // Native bridge facade (bridge*-prefixed) backed by the same store,
    // returned from the fake IpcContext that `runDisconnect` uses.
    const nativeBridge = {
      bridgeAddLocalFile: (p: string) => store.add(p),
      bridgeReindexSource: () => {},
      bridgeRemoveSource: (id: string) => store.remove(id),
      bridgeListSources: () => store.list(),
    };
    const ctx = {
      requireBridge: () => nativeBridge,
    } as unknown as IpcContext;

    // 1) Drive a real v2 sync for google_drive: writes a file into
    //    `google_drive-sync/`, registers a bridge source, and writes
    //    the v2 SyncManifest.
    const outcome: SyncOutcome = {
      created: 1,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c1",
      documents: [
        {
          document_id: "gd-doc-1",
          event_kind: "created",
          title: "V2 Doc",
          mime_type: "text/markdown",
          body_base64: b64("# from v2"),
        },
      ],
    };
    const fakeNative = {
      bridgeConnectorsV2Supported: () => true,
      bridgeConnectorsV2Sync: () => JSON.stringify(outcome),
    } as unknown as Parameters<typeof runV2Sync>[0]["bridge"];

    await runV2Sync({
      provider: "google_drive",
      bridge: fakeNative,
      hooks: v2Hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });

    const v2Dir = path.join(dir, "google_drive-sync");
    const v2Source = store.list().find((s) => s.path.startsWith(v2Dir));
    expect(v2Source).toBeDefined();
    expect(await fsp.stat(v2Source!.path)).toBeTruthy();

    // 2) Hand-build a legacy gdrive-sync/ state: a file + the legacy
    //    manifest (a JSON array of local paths) + a registered source.
    const legacyDir = path.join(dir, "gdrive-sync");
    await fsp.mkdir(legacyDir, { recursive: true });
    const legacyFile = path.join(legacyDir, "legacy-doc.txt");
    await fsp.writeFile(legacyFile, "from legacy", "utf8");
    await fsp.writeFile(
      path.join(legacyDir, "manifest.json"),
      JSON.stringify([legacyFile]),
      "utf8",
    );
    const legacySource = store.add(legacyFile);

    // Sanity: two sources, both dirs present.
    expect(store.list()).toHaveLength(2);

    // 3) Disconnect once.
    const { filesRemoved } = await runDisconnect(ctx, "google_drive", dir);

    // Both backends cleaned: 1 (v2) + 1 (legacy).
    expect(filesRemoved).toBe(2);

    // Both bridge sources removed.
    expect(store.list()).toHaveLength(0);

    // Both files + both directories gone from disk (no orphans).
    await expect(fsp.stat(v2Source!.path)).rejects.toBeTruthy();
    await expect(fsp.stat(legacySource.path)).rejects.toBeTruthy();
    await expect(fsp.stat(v2Dir)).rejects.toBeTruthy();
    await expect(fsp.stat(legacyDir)).rejects.toBeTruthy();
  });

  it("for a shared-dir provider (notion) the double cleanup is idempotent", async () => {
    // notion's legacy and v2 paths share `notion-sync/` + the same
    // SyncManifest format, so the second cleanup pass must simply find
    // nothing left rather than double-count or error.
    const store = new SourceStore();
    const v2Hooks = {
      addLocalFile: (p: string) => store.add(p),
      reindexSource: () => {},
      removeSource: (id: string) => store.remove(id),
      listSources: () => store.list(),
    };
    const nativeBridge = {
      bridgeAddLocalFile: (p: string) => store.add(p),
      bridgeReindexSource: () => {},
      bridgeRemoveSource: (id: string) => store.remove(id),
      bridgeListSources: () => store.list(),
    };
    const ctx = { requireBridge: () => nativeBridge } as unknown as IpcContext;

    const outcome: SyncOutcome = {
      created: 1,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c1",
      documents: [
        {
          document_id: "n-1",
          event_kind: "created",
          mime_type: "text/markdown",
          body_base64: b64("# notion"),
        },
      ],
    };
    const fakeNative = {
      bridgeConnectorsV2Supported: () => true,
      bridgeConnectorsV2Sync: () => JSON.stringify(outcome),
    } as unknown as Parameters<typeof runV2Sync>[0]["bridge"];

    await runV2Sync({
      provider: "notion",
      bridge: fakeNative,
      hooks: v2Hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });
    expect(store.list()).toHaveLength(1);

    const { filesRemoved } = await runDisconnect(ctx, "notion", dir);
    // Counted exactly once despite both passes running.
    expect(filesRemoved).toBe(1);
    expect(store.list()).toHaveLength(0);
    await expect(fsp.stat(path.join(dir, "notion-sync"))).rejects.toBeTruthy();
  });
});
