/**
 * Unit/integration tests for the v2 connector adapter
 * (`electron/ipc/connectors/connectorsV2.ts`).
 *
 * These exercise the TS half of the knowledge-substrate connector
 * migration WITHOUT the native addon: a fake `bridge` returns the
 * `SyncOutcome` JSON the Rust side would produce, and the test asserts
 * that the adapter materialises the fetched documents into the local
 * index (write file → addLocalFile/reindex), maintains the manifest,
 * cascades deletions, round-trips tokens through the `TokenWire`
 * contract, and persists the cursor for the next incremental run.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import {
  runV2Sync,
  disconnectV2Provider,
  storedToWire,
  wireToStored,
  buildAuthConfig,
  v2BridgeAvailable,
  readV2State,
  writeV2State,
  type SyncOutcome,
  type V2NativeBridge,
  type V2BridgeHooks,
} from "../ipc/connectors/connectorsV2";
import { NetworkError, isNetworkError } from "../ipc/connectors/networkErrors";
import type { StoredTokens } from "../tokenVault";

interface FakeSource {
  id: string;
  path: string;
}

class FakeBridge implements V2BridgeHooks {
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

/**
 * Build a `V2NativeBridge` whose `bridgeConnectorsV2Sync` returns the
 * given outcome (and records the JSON args it was called with for
 * assertions).
 */
function fakeNativeBridge(
  outcome: SyncOutcome,
  calls: { args: unknown[][] } = { args: [] },
): V2NativeBridge {
  return {
    bridgeConnectorsV2Supported: () => true,
    bridgeConnectorsV2Sync: (...args: unknown[]) => {
      calls.args.push(args);
      return JSON.stringify(outcome);
    },
  } as unknown as V2NativeBridge;
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}

async function tmpDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "tessera-v2-"));
}

const TOKENS: StoredTokens = {
  accessToken: "access-123",
  refreshToken: "refresh-456",
  expiresAt: Date.UTC(2030, 0, 1),
  scopes: ["repo", "read:org"],
  clientId: "client-abc",
  clientSecret: "secret-xyz",
};

describe("connectorsV2 token wire round-trip", () => {
  it("maps StoredTokens → TokenWire with RFC3339 expiry and space-joined scope", () => {
    const wire = storedToWire(TOKENS);
    expect(wire.access_token).toBe("access-123");
    expect(wire.refresh_token).toBe("refresh-456");
    expect(wire.scope).toBe("repo read:org");
    expect(wire.token_type).toBe("Bearer");
    expect(wire.expires_at).toBe(new Date(Date.UTC(2030, 0, 1)).toISOString());
  });

  it("round-trips TokenWire → StoredTokens, preserving client creds and healing missing refresh token", () => {
    const wire = storedToWire(TOKENS);
    const back = wireToStored(wire, TOKENS);
    expect(back.accessToken).toBe(TOKENS.accessToken);
    expect(back.refreshToken).toBe(TOKENS.refreshToken);
    expect(back.expiresAt).toBe(TOKENS.expiresAt);
    expect(back.scopes).toEqual(TOKENS.scopes);
    expect(back.clientId).toBe("client-abc");
    expect(back.clientSecret).toBe("secret-xyz");

    // A refreshed wire that omits the refresh token must inherit the
    // previous one (providers that don't rotate it).
    const healed = wireToStored(
      { ...wire, refresh_token: null },
      TOKENS,
    );
    expect(healed.refreshToken).toBe("refresh-456");
  });
});

describe("connectorsV2 buildAuthConfig", () => {
  it("assembles the OAuth config from PROVIDER_OAUTH_CONFIGS + keychain client creds", () => {
    const cfg = buildAuthConfig("github", TOKENS);
    expect(cfg.provider).toBe("github");
    expect(cfg.token_url).toBe("https://github.com/login/oauth/access_token");
    expect(cfg.client_id).toBe("client-abc");
    expect(cfg.client_secret).toBe("secret-xyz");
    expect(String(cfg.redirect_uri)).toContain(":9885/callback");
  });

  it("tolerates a token record with no client credentials (resolver path)", () => {
    const cfg = buildAuthConfig("slack", null);
    expect(cfg.client_id).toBe("");
    expect(cfg.client_secret).toBe("");
    expect(cfg.token_url).toBe("https://slack.com/api/oauth.v2.access");
  });
});

describe("v2BridgeAvailable", () => {
  it("is false when the native addon lacks the v2 functions", () => {
    expect(v2BridgeAvailable({} as V2NativeBridge)).toBe(false);
  });
  it("is true when both probe functions are present", () => {
    expect(
      v2BridgeAvailable({
        bridgeConnectorsV2Supported: () => true,
        bridgeConnectorsV2Sync: () => "{}",
      } as unknown as V2NativeBridge),
    ).toBe(true);
  });
});

describe("runV2Sync ingest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("writes fetched docs to disk, registers sources, and counts created", async () => {
    const outcome: SyncOutcome = {
      created: 2,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "cursor-1",
      documents: [
        {
          document_id: "doc-1",
          event_kind: "created",
          title: "Doc One",
          mime_type: "text/markdown",
          body_base64: b64("# Hello"),
        },
        {
          document_id: "doc-2",
          event_kind: "created",
          mime_type: "text/plain",
          body_base64: b64("plain body"),
        },
      ],
    };
    const hooks = new FakeBridge();
    const calls = { args: [] as unknown[][] };
    const { result, nextCursor, warnings } = await runV2Sync({
      provider: "github",
      bridge: fakeNativeBridge(outcome, calls),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });

    expect(result.added).toBe(2);
    expect(result.modified).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.status).toBe("synced");
    expect(nextCursor).toBe("cursor-1");
    expect(warnings).toEqual([]);
    expect(hooks.added).toHaveLength(2);

    // Files actually written with the right contents + extension.
    const md = hooks.added.find((s) => s.path.endsWith(".md"));
    const txt = hooks.added.find((s) => s.path.endsWith(".txt"));
    expect(md).toBeDefined();
    expect(txt).toBeDefined();
    expect(await fsp.readFile(md!.path, "utf8")).toBe("# Hello");
    expect(await fsp.readFile(txt!.path, "utf8")).toBe("plain body");

    // The bridge received the token + auth-config JSON, not raw objects.
    expect(calls.args[0][0]).toBe("github");
    const wire = JSON.parse(calls.args[0][2] as string);
    expect(wire.access_token).toBe("access-123");
  });

  it("treats a re-synced doc as modified and re-indexes the existing source", async () => {
    const first: SyncOutcome = {
      created: 1,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c1",
      documents: [
        {
          document_id: "doc-1",
          event_kind: "created",
          mime_type: "text/markdown",
          body_base64: b64("v1"),
        },
      ],
    };
    const hooks = new FakeBridge();
    await runV2Sync({
      provider: "hubspot",
      bridge: fakeNativeBridge(first),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });
    expect(hooks.added).toHaveLength(1);

    const second: SyncOutcome = {
      created: 0,
      updated: 1,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c2",
      documents: [
        {
          document_id: "doc-1",
          event_kind: "updated",
          mime_type: "text/markdown",
          body_base64: b64("v2"),
        },
      ],
    };
    const res2 = await runV2Sync({
      provider: "hubspot",
      bridge: fakeNativeBridge(second),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: JSON.stringify({ cursor: "c1" }),
      scopeId: null,
    });
    expect(res2.result.modified).toBe(1);
    expect(res2.result.added).toBe(0);
    // No second source added; the existing one was re-indexed.
    expect(hooks.added).toHaveLength(1);
    expect(hooks.reindexed).toContain(hooks.added[0].id);
    // Body overwritten in place.
    expect(await fsp.readFile(hooks.added[0].path, "utf8")).toBe("v2");
  });

  it("cleans up the stale file + source when a doc's MIME type changes between syncs", async () => {
    // Initial sync: doc-1 arrives as Markdown → doc-1.md.
    const first: SyncOutcome = {
      created: 1,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c1",
      documents: [
        {
          document_id: "doc-1",
          event_kind: "created",
          mime_type: "text/markdown",
          body_base64: b64("# md body"),
        },
      ],
    };
    const hooks = new FakeBridge();
    await runV2Sync({
      provider: "notion",
      bridge: fakeNativeBridge(first),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });
    const mdSource = hooks.added[0];
    expect(mdSource.path.endsWith(".md")).toBe(true);
    expect(await fsp.stat(mdSource.path)).toBeTruthy();

    // Incremental sync: the SAME doc now reports text/plain, so the
    // body lands at doc-1.txt. The old doc-1.md file + its source must
    // be reclaimed rather than orphaned.
    const second: SyncOutcome = {
      created: 0,
      updated: 1,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c2",
      documents: [
        {
          document_id: "doc-1",
          event_kind: "updated",
          mime_type: "text/plain",
          body_base64: b64("plain body"),
        },
      ],
    };
    const res = await runV2Sync({
      provider: "notion",
      bridge: fakeNativeBridge(second),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: JSON.stringify({ cursor: "c1" }),
      scopeId: null,
    });

    expect(res.result.modified).toBe(1);
    // The new .txt source exists; the stale .md source was removed.
    const txtSource = hooks.added.find((s) => s.path.endsWith(".txt"));
    expect(txtSource).toBeDefined();
    expect(hooks.removed).toContain(mdSource.id);
    expect(hooks.listSources().map((s) => s.path)).toEqual([txtSource!.path]);
    // The stale file is gone; the new one has the new body.
    await expect(fsp.stat(mdSource.path)).rejects.toBeTruthy();
    expect(await fsp.readFile(txtSource!.path, "utf8")).toBe("plain body");

    // The manifest carries exactly one entry (the new path), so a
    // subsequent disconnect cannot re-orphan the old path.
    const manifestRaw = await fsp.readFile(
      path.join(path.dirname(txtSource!.path), "manifest.json"),
      "utf8",
    );
    const manifest = JSON.parse(manifestRaw) as {
      entries: Array<{ localPath: string; remoteId: string }>;
    };
    expect(manifest.entries).toHaveLength(1);
    expect(manifest.entries[0].localPath).toBe(txtSource!.path);
  });

  it("cascades a deletion: removes the bridge source and the local file", async () => {
    const create: SyncOutcome = {
      created: 1,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c1",
      documents: [
        {
          document_id: "doc-1",
          event_kind: "created",
          mime_type: "text/markdown",
          body_base64: b64("body"),
        },
      ],
    };
    const hooks = new FakeBridge();
    await runV2Sync({
      provider: "slack",
      bridge: fakeNativeBridge(create),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });
    const created = hooks.added[0];
    expect(await fsp.stat(created.path)).toBeTruthy();

    const del: SyncOutcome = {
      created: 0,
      updated: 0,
      deleted: 1,
      permission_changed: 0,
      next_cursor: "c2",
      documents: [{ document_id: "doc-1", event_kind: "deleted" }],
    };
    const res = await runV2Sync({
      provider: "slack",
      bridge: fakeNativeBridge(del),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: JSON.stringify({ cursor: "c1" }),
      scopeId: null,
    });
    expect(res.result.removed).toBe(1);
    expect(hooks.removed).toContain(created.id);
    await expect(fsp.stat(created.path)).rejects.toBeTruthy();
  });

  it("propagates non-fatal warnings from the outcome", async () => {
    const outcome: SyncOutcome = {
      created: 0,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: null,
      documents: [],
      warnings: ["fetch doc-9: 500"],
    };
    const { warnings } = await runV2Sync({
      provider: "email",
      bridge: fakeNativeBridge(outcome),
      hooks: new FakeBridge(),
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });
    expect(warnings).toEqual(["fetch doc-9: 500"]);
  });

  it("throws when the native bridge lacks the v2 sync function", async () => {
    await expect(
      runV2Sync({
        provider: "github",
        bridge: {} as V2NativeBridge,
        hooks: new FakeBridge(),
        tokens: TOKENS,
        userDataDir: dir,
        stateJson: null,
        scopeId: null,
      }),
    ).rejects.toThrow(/v2 connector bridge unavailable/);
  });
});

describe("v2 sync-state persistence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("round-trips the cursor and pins a placeholder connector id", async () => {
    expect(await readV2State(dir, "github")).toBeNull();
    await writeV2State(dir, "github", "cursor-42");
    const raw = await readV2State(dir, "github");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as {
      cursor: string;
      mode: string;
      connector: string;
    };
    expect(parsed.cursor).toBe("cursor-42");
    expect(parsed.mode).toBe("incremental");
    expect(parsed.connector).toBe("00000000-0000-0000-0000-000000000000");
  });
});

describe("disconnectV2Provider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it("unhooks only the provider's sources and purges the sync dir", async () => {
    const create: SyncOutcome = {
      created: 1,
      updated: 0,
      deleted: 0,
      permission_changed: 0,
      next_cursor: "c1",
      documents: [
        {
          document_id: "doc-1",
          event_kind: "created",
          mime_type: "text/markdown",
          body_base64: b64("body"),
        },
      ],
    };
    const hooks = new FakeBridge();
    // An unrelated source that must NOT be removed by disconnect.
    const unrelated = hooks.addLocalFile("/somewhere/else.md");

    await runV2Sync({
      provider: "github",
      bridge: fakeNativeBridge(create),
      hooks,
      tokens: TOKENS,
      userDataDir: dir,
      stateJson: null,
      scopeId: null,
    });
    const created = hooks.added.find((s) => s.id !== unrelated.id)!;

    const { filesRemoved } = await disconnectV2Provider("github", dir, hooks);
    expect(filesRemoved).toBe(1);
    expect(hooks.removed).toContain(created.id);
    expect(hooks.removed).not.toContain(unrelated.id);
    // Sync dir gone.
    await expect(
      fsp.stat(path.dirname(created.path)),
    ).rejects.toBeTruthy();
  });
});

describe("runV2Sync bridge error branding", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tmpDir();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  /** Native bridge whose sync throws the given plain `Error`. */
  function throwingBridge(err: Error): V2NativeBridge {
    return {
      bridgeConnectorsV2Supported: () => true,
      bridgeConnectorsV2Sync: () => {
        throw err;
      },
    } as unknown as V2NativeBridge;
  }

  it("re-brands a `transport:` framework error as NetworkError so the offline badge fires", async () => {
    // reqwest DNS failures surface through the bridge as
    // `transport: error sending request … dns error …` — phrasing the
    // host's message-pattern heuristic does NOT match. The adapter must
    // still classify it as a network error via the stable category.
    const raw = new Error(
      "transport: error sending request for url (https://api.x): dns error: failed to lookup address",
    );
    let caught: unknown;
    try {
      await runV2Sync({
        provider: "github",
        bridge: throwingBridge(raw),
        hooks: new FakeBridge(),
        tokens: TOKENS,
        userDataDir: dir,
        stateJson: null,
        scopeId: null,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NetworkError);
    expect(isNetworkError(caught)).toBe(true);
    // The original framework error is preserved as the cause.
    expect((caught as NetworkError).cause).toBe(raw);
  });

  it("propagates a non-transport framework error unchanged (NOT a network error)", async () => {
    // An `auth:` category error is a hard failure the renderer must
    // surface as a re-auth prompt, never as the offline badge.
    const raw = new Error("auth: token expired or revoked");
    let caught: unknown;
    try {
      await runV2Sync({
        provider: "github",
        bridge: throwingBridge(raw),
        hooks: new FakeBridge(),
        tokens: TOKENS,
        userDataDir: dir,
        stateJson: null,
        scopeId: null,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(raw);
    expect(caught).not.toBeInstanceOf(NetworkError);
    expect(isNetworkError(caught)).toBe(false);
  });
});
