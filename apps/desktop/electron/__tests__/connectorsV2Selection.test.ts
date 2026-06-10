/**
 * Regression test for the Google Drive selective-sync routing bug.
 *
 * Google Drive is the one provider whose renderer exposes a file
 * picker: the `connectors:gdrive:sync` channel passes an explicit
 * `selectedFileIds` allowlist so the user can pull only the files they
 * chose. The knowledge `connector_framework` v2 path is changefeed-
 * based and has no faithful way to express an arbitrary file-id
 * allowlist, so `runSync` must route a SELECTION-bearing call to the
 * legacy `syncGoogleDrive` (which fetches each id directly) even though
 * `useV2Connectors` defaults to `true`. A call with NO selection still
 * uses the v2 bridge.
 *
 * The original code dispatched to the v2 path before consulting the
 * `options` parameter, so `selectedFileIds` was silently dropped and a
 * full sync ran instead of the user's chosen subset.
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

// Force the default-on v2 backend so the test proves selection routing
// overrides it (rather than passing only because v2 was off).
vi.mock("../../config", async (importActual) => {
  const actual = await importActual<typeof import("../config")>();
  return { ...actual, loadConfig: () => ({ useV2Connectors: true }) };
});

// Replace the legacy Google Drive connector with spies so we can assert
// whether (and with what selection) the legacy path was taken.
const syncGoogleDriveSpy = vi.fn(async () => ({
  added: 1,
  modified: 0,
  removed: 0,
  status: "synced" as const,
}));
vi.mock("../ipc/connectors/gdrive", () => ({
  syncGoogleDrive: (args: unknown) => syncGoogleDriveSpy(args),
  disconnectGoogleDrive: vi.fn(async () => ({ filesRemoved: 0 })),
}));

import { runConnectorSync } from "../ipc/connectors/handlers";
import type { IpcContext } from "../ipc/context";
import {
  getProviderOAuthConfig,
} from "../ipc/connectors/providerOAuth";
import { getRequestedScopes } from "../oauthScope";
import type { StoredTokens } from "../tokenVault";
import type { SyncOutcome } from "../ipc/connectors/connectorsV2";

// Granted scopes must cover the provider's requested scopes so the
// sync-time scope assertion passes and we reach the routing branch.
const GRANTED_GDRIVE_SCOPES = getRequestedScopes(
  getProviderOAuthConfig("google_drive"),
);

const TOKENS: StoredTokens = {
  accessToken: "access-123",
  refreshToken: "refresh-456",
  // Far-future expiry so `getValidAccessToken` returns the cached
  // token without attempting a network refresh.
  expiresAt: Date.UTC(2035, 0, 1),
  scopes: GRANTED_GDRIVE_SCOPES,
  clientId: "client-abc",
  clientSecret: "secret-xyz",
};

/** A v2 SyncOutcome the fake native bridge returns for a full sync. */
const V2_OUTCOME: SyncOutcome = {
  created: 1,
  updated: 0,
  deleted: 0,
  permission_changed: 0,
  next_cursor: "cursor-1",
  documents: [
    {
      document_id: "gd-doc-1",
      event_kind: "created",
      mime_type: "text/markdown",
      body_base64: Buffer.from("# from v2", "utf8").toString("base64"),
    },
  ],
};

describe("runSync — Google Drive selective-sync routing", () => {
  let dir: string;
  let v2SyncSpy: ReturnType<typeof vi.fn>;
  let ctx: IpcContext;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-gd-sel-"));
    syncGoogleDriveSpy.mockClear();
    v2SyncSpy = vi.fn(() => JSON.stringify(V2_OUTCOME));

    const nativeBridge = {
      // v2 probe + sync
      bridgeConnectorsV2Supported: () => true,
      bridgeConnectorsV2Sync: (...args: unknown[]) => v2SyncSpy(...args),
      // local-index hooks used by the v2 ingest path
      bridgeAddLocalFile: (p: string) => ({ id: `src-${p}`, path: p }),
      bridgeReindexSource: () => {},
      bridgeRemoveSource: () => {},
      bridgeListSources: () => [] as Array<{
        id: string;
        path: string;
        sourceType?: string;
      }>,
      // audit pass-through (no-throw on the Rust side)
      bridgeLogConnectorSynced: () => {},
    };

    ctx = {
      log: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
      rateLimiter: { consume: () => {} },
      requireBridge: () => nativeBridge,
      userDataDir: () => dir,
      tokenVault: {
        getTokens: () => TOKENS,
        storeTokens: () => {},
        deleteTokens: () => {},
      },
    } as unknown as IpcContext;
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("routes a selection-bearing sync to the legacy connector (honouring selectedFileIds)", async () => {
    const result = await runConnectorSync(ctx, "google_drive", {
      selectedFileIds: ["file-A", "file-B"],
    });

    // Legacy path taken with the explicit selection threaded through.
    expect(syncGoogleDriveSpy).toHaveBeenCalledTimes(1);
    const arg = syncGoogleDriveSpy.mock.calls[0][0] as {
      selectedFileIds?: string[];
    };
    expect(arg.selectedFileIds).toEqual(["file-A", "file-B"]);
    // v2 bridge sync was NOT invoked — the selection was not dropped.
    expect(v2SyncSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("synced");
  });

  it("uses the v2 bridge for a no-selection sync", async () => {
    const result = await runConnectorSync(ctx, "google_drive");

    // v2 path taken; legacy connector untouched.
    expect(v2SyncSpy).toHaveBeenCalledTimes(1);
    expect(syncGoogleDriveSpy).not.toHaveBeenCalled();
    expect(result.status).toBe("synced");
  });

  it("uses the v2 bridge for an empty selection array (treated as no selection)", async () => {
    await runConnectorSync(ctx, "google_drive", { selectedFileIds: [] });

    expect(v2SyncSpy).toHaveBeenCalledTimes(1);
    expect(syncGoogleDriveSpy).not.toHaveBeenCalled();
  });
});
