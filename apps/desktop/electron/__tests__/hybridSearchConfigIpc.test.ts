/**
 * Integration test for the hybrid retrieval IPC wiring:
 *
 *   - `settings:getHybridSearchConfig`
 *   - `settings:updateHybridSearchConfig`
 *   - `sources:backfillEmbeddings`
 *   - `sources:getEmbeddingProgress`
 *
 * The Rust bridge is mocked because the `.node` addon is built per
 * platform and unavailable in the vitest sandbox. The test still
 * exercises the real:
 *   1. zod validators (`HybridSearchConfigUpdateSchema` strict mode,
 *      `assertNumber` bounds on backfill batch size).
 *   2. Bridge-call wiring (every handler returns exactly what the
 *      bridge returns, with no field renaming or default-injection).
 *   3. Persistence-after-update contract (a successful
 *      `settings:updateHybridSearchConfig` call writes the effective
 *      bridge response back into `loadConfig().hybridSearchConfig`).
 *   4. Replay-on-startup contract (the persisted config is replayed
 *      into the bridge on app boot via
 *      `replayPersistedHybridSearchConfigToBridge`).
 *   5. Rate-limiter wiring (consecutive updates throttle once the
 *      bucket is exhausted).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  // `app` is consumed by `config.ts` to find the userData directory.
  // We point it at a per-test tmpdir below by mutating the path
  // returned from `getPath('userData')`.
  app: {
    getPath: (which: string) => {
      if (which === "userData") {
        return userDataDir;
      }
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

// Stub appState so handlers see whatever bridge the test wires up via
// `setBridge` below. We deliberately re-import the handler modules
// AFTER `vi.mock` so the mock is in place when they run.
let stubBridge: unknown = null;
vi.mock("../appState", () => ({
  getBridge: () => stubBridge,
  isBridgeAvailable: () => stubBridge !== null,
}));

let userDataDir = "";

// Imports must come AFTER `vi.mock` calls above.
import {
  loadConfig,
  updateConfig,
  DEFAULT_HYBRID_SEARCH_CONFIG,
  _clearConfigCacheForTests,
} from "../config";
import {
  registerSettingsHandlers,
  replayPersistedHybridSearchConfigToBridge,
} from "../ipc/settings";
import { registerSourcesHandlers } from "../ipc/sources";
import { defaultRateLimiter } from "../ipc/rateLimiter";
import type {
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  EmbeddingProgressInfo,
  BackfillEmbeddingsResult,
} from "../../shared/types";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

function makeBridge(initial: HybridSearchConfigInfo): {
  bridge: {
    bridgeGetHybridSearchConfig: ReturnType<typeof vi.fn>;
    bridgeUpdateHybridSearchConfig: ReturnType<typeof vi.fn>;
    bridgeBackfillEmbeddings: ReturnType<typeof vi.fn>;
    bridgeGetEmbeddingProgress: ReturnType<typeof vi.fn>;
    bridgeLogSettingsChanged: ReturnType<typeof vi.fn>;
  };
  current: { value: HybridSearchConfigInfo };
} {
  const current = { value: { ...initial } };
  const bridge = {
    // Audit pass-through. The `settings:updateHybridSearchConfig`
    // handler routes an audit row per effective field through
    // `bridgeLogSettingsChanged`; the mock just records calls so
    // tests can assert the rows.
    bridgeLogSettingsChanged: vi.fn(),
    bridgeGetHybridSearchConfig: vi.fn(() => ({ ...current.value })),
    bridgeUpdateHybridSearchConfig: vi.fn((patch: HybridSearchConfigUpdate) => {
      // Mimic the Rust side's "patch returns effective config" contract.
      current.value = {
        ...current.value,
        ...(patch.bm25Weight !== undefined && { bm25Weight: patch.bm25Weight }),
        ...(patch.vectorWeight !== undefined && {
          vectorWeight: patch.vectorWeight,
        }),
        ...(patch.rrfK !== undefined && { rrfK: patch.rrfK }),
        ...(patch.recencyDecayEnabled !== undefined && {
          recencyDecayEnabled: patch.recencyDecayEnabled,
        }),
        ...(patch.recencyHalflifeSecs !== undefined && {
          recencyHalflifeSecs: patch.recencyHalflifeSecs,
        }),
        ...(patch.candidatePoolSize !== undefined && {
          candidatePoolSize: patch.candidatePoolSize,
        }),
        ...(patch.retentionWeight !== undefined && {
          retentionWeight: patch.retentionWeight,
        }),
      };
      // When decay is disabled, the bridge surfaces halflife as null
      // (mimic the real wire shape).
      if (current.value.recencyDecayEnabled === false) {
        current.value = { ...current.value, recencyHalflifeSecs: null };
      }
      return { ...current.value };
    }),
    bridgeBackfillEmbeddings: vi.fn(
      // The bridge's real `BackfillEmbeddingsResult` exposes
      // exactly two fields: `embedded` (count of newly-embedded
      // chunks) and `progress` (the wrapped tracker snapshot).
      // The chosen batch size is intentionally not surfaced — the
      // renderer doesn't have a use for that detail. The mock
      // matches that shape exactly so tests can't accidentally
      // assert on properties the production bridge will never
      // populate. We still take `batchSize` as an argument so the
      // call-args assertions (`toHaveBeenCalledWith(32)`) work.
      //
      // **Returns a Promise** — the production napi function is
      // declared `AsyncTask<BackfillEmbeddingsTask>`, which
      // translates to `Promise<BackfillEmbeddingsResult>` on the
      // JS side. The mock matches that shape so any future caller
      // that forgets to `await` (and silently reads a field off
      // the Promise) will fail in tests the same way it would in
      // production.
      async (
        _batchSize?: number | null,
      ): Promise<BackfillEmbeddingsResult> => ({
        embedded: 7,
        progress: {
          status: "done",
          totalChunks: 7,
          embedded: 7,
          failed: 0,
          modelId: "hash-trick-v1",
          lastError: null,
        },
      }),
    ),
    bridgeGetEmbeddingProgress: vi.fn(
      (): EmbeddingProgressInfo => ({
        status: "running",
        totalChunks: 100,
        embedded: 25,
        failed: 1,
        modelId: "hash-trick-v1",
        lastError: null,
      }),
    ),
  };
  return { bridge, current };
}

describe("hybrid search config IPC", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-cfg-test-"));
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    stubBridge = null;
    _clearConfigCacheForTests();
    // The token-bucket limiter is process-global, so each test
    // must start with a fresh bucket — otherwise consume-once tests
    // hit `RateLimitError` from a sibling test's overspend.
    defaultRateLimiter.reset();
  });

  afterEach(() => {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Best-effort tmpdir cleanup; no-op if Windows still holds handles.
    }
    vi.restoreAllMocks();
  });

  it("settings:getHybridSearchConfig returns the bridge's live config", async () => {
    const { bridge } = makeBridge({
      bm25Weight: 1.0,
      vectorWeight: 0.7,
      rrfK: 60.0,
      recencyDecayEnabled: true,
      recencyHalflifeSecs: 7 * 24 * 60 * 60,
      candidatePoolSize: 0,
    });
    stubBridge = bridge;
    registerSettingsHandlers();
    const handler = getHandler("settings:getHybridSearchConfig");
    const result = (await handler({})) as HybridSearchConfigInfo;
    expect(result).toEqual({
      bm25Weight: 1.0,
      vectorWeight: 0.7,
      rrfK: 60.0,
      recencyDecayEnabled: true,
      recencyHalflifeSecs: 7 * 24 * 60 * 60,
      candidatePoolSize: 0,
    });
    expect(bridge.bridgeGetHybridSearchConfig).toHaveBeenCalledTimes(1);
  });

  it("settings:getHybridSearchConfig falls back to disk when the bridge is unavailable", async () => {
    stubBridge = null;
    updateConfig({
      hybridSearchConfig: {
        ...DEFAULT_HYBRID_SEARCH_CONFIG,
        vectorWeight: 0.5,
        recencyDecayEnabled: false,
      },
    });
    registerSettingsHandlers();
    const handler = getHandler("settings:getHybridSearchConfig");
    const result = (await handler({})) as HybridSearchConfigInfo;
    expect(result.vectorWeight).toBe(0.5);
    expect(result.recencyDecayEnabled).toBe(false);
    // Decay disabled → halflife should surface as null in the
    // bridge-shaped response even though disk holds a number.
    expect(result.recencyHalflifeSecs).toBeNull();
  });

  it("settings:updateHybridSearchConfig validates, calls the bridge, and persists the effective config", async () => {
    const { bridge, current } = makeBridge({
      ...DEFAULT_HYBRID_SEARCH_CONFIG,
      recencyHalflifeSecs: DEFAULT_HYBRID_SEARCH_CONFIG.recencyHalflifeSecs,
    });
    stubBridge = bridge;
    registerSettingsHandlers();
    const handler = getHandler("settings:updateHybridSearchConfig");
    const result = (await handler(
      {},
      {
        vectorWeight: 0.6,
        recencyHalflifeSecs: 3 * 24 * 60 * 60,
      },
    )) as HybridSearchConfigInfo;
    expect(result.vectorWeight).toBe(0.6);
    expect(result.recencyHalflifeSecs).toBe(3 * 24 * 60 * 60);
    expect(bridge.bridgeUpdateHybridSearchConfig).toHaveBeenCalledTimes(1);
    // Persistence: reload should see the new values.
    _clearConfigCacheForTests();
    const persisted = loadConfig().hybridSearchConfig;
    expect(persisted.vectorWeight).toBe(0.6);
    expect(persisted.recencyHalflifeSecs).toBe(3 * 24 * 60 * 60);
    expect(current.value.vectorWeight).toBe(0.6);
  });

  it("settings:updateHybridSearchConfig preserves the prior halflife on disk when decay is disabled (bridge returns null halflife)", async () => {
    const { bridge } = makeBridge({
      ...DEFAULT_HYBRID_SEARCH_CONFIG,
      recencyHalflifeSecs: DEFAULT_HYBRID_SEARCH_CONFIG.recencyHalflifeSecs,
    });
    stubBridge = bridge;
    // Seed the disk with a non-default halflife the user set
    // earlier — toggling decay off and then back on should keep this.
    updateConfig({
      hybridSearchConfig: {
        ...DEFAULT_HYBRID_SEARCH_CONFIG,
        recencyHalflifeSecs: 5 * 24 * 60 * 60,
      },
    });
    registerSettingsHandlers();
    const handler = getHandler("settings:updateHybridSearchConfig");
    await handler({}, { recencyDecayEnabled: false });
    _clearConfigCacheForTests();
    const persisted = loadConfig().hybridSearchConfig;
    expect(persisted.recencyDecayEnabled).toBe(false);
    // Halflife on disk MUST stay a finite number even though the
    // bridge response had `recencyHalflifeSecs: null`. The persisted
    // value is the user's previously-chosen value (5 days), not the
    // 30-day default.
    expect(persisted.recencyHalflifeSecs).toBe(5 * 24 * 60 * 60);
  });

  it("settings:updateHybridSearchConfig rejects an invalid patch before touching the bridge", async () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSettingsHandlers();
    const handler = getHandler("settings:updateHybridSearchConfig");
    await expect(
      handler({}, { vectorWeight: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow();
    await expect(handler({}, { rrfK: 0 })).rejects.toThrow();
    await expect(handler({}, { bogus: 1 })).rejects.toThrow();
    expect(bridge.bridgeUpdateHybridSearchConfig).not.toHaveBeenCalled();
  });

  it("settings:updateHybridSearchConfig emits per-field audit rows for the effective post-clamp config", async () => {
    // The hybrid config update IPC previously bypassed
    // `bridgeLogSettingsChanged`. The hybrid weights and recency
    // tuning are part of the user's
    // search-tuning surface, so a mutation here is security-
    // relevant in the same way `theme` or `ignorePatterns` are.
    // This test pins the audit contract: one row per effective
    // field, values stringified, `null` halflife normalised to
    // `"disabled"` (decay-off) instead of the literal `"null"`.
    const { bridge } = makeBridge({
      ...DEFAULT_HYBRID_SEARCH_CONFIG,
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      rrfK: 60.0,
      recencyDecayEnabled: true,
      recencyHalflifeSecs: 30 * 24 * 60 * 60,
    });
    stubBridge = bridge;
    registerSettingsHandlers();
    const handler = getHandler("settings:updateHybridSearchConfig");
    await handler({}, {
      bm25Weight: 0.8,
      vectorWeight: 0.6,
      rrfK: 75.0,
      recencyHalflifeSecs: 14 * 24 * 60 * 60,
    } satisfies HybridSearchConfigUpdate);
    const calls = bridge.bridgeLogSettingsChanged.mock.calls;
    // Audit a row for each of the six tracked fields in
    // `HybridSearchConfigInfo`. The order matches the handler's
    // emission order so future maintainers can grep-trace the audit
    // feed back to the field rather than chasing a synthetic Set.
    // An earlier version of this test pinned only 5 of the 6
    // fields, masking the missing `candidatePoolSize` audit row
    // in the handler.
    expect(calls).toEqual([
      ["hybridSearch.bm25Weight", "0.8"],
      ["hybridSearch.vectorWeight", "0.6"],
      ["hybridSearch.rrfK", "75"],
      ["hybridSearch.recencyDecayEnabled", "true"],
      ["hybridSearch.recencyHalflifeSecs", String(14 * 24 * 60 * 60)],
      // `candidatePoolSize` is preserved from the prior config because
      // the update payload did not pass a new value; the bridge mock
      // surfaces whatever is currently stored. Default seed is `0`.
      ["hybridSearch.candidatePoolSize", "0"],
      // `retentionWeight` (the fourth RRF signal) is likewise preserved
      // from the prior config — the default seed is `1.0`.
      ["hybridSearch.retentionWeight", "1"],
    ]);
  });

  it("settings:updateHybridSearchConfig emits candidatePoolSize audit row when the user changes the pool size", async () => {
    // Pin the contract that `candidatePoolSize` IS audited; an
    // earlier implementation missed it. This test deliberately
    // passes a non-zero pool size so a regression that drops the
    // audit row would fail even if the test seed defaulted to a
    // zero pool.
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSettingsHandlers();
    const handler = getHandler("settings:updateHybridSearchConfig");
    await handler({}, {
      candidatePoolSize: 250,
    } satisfies HybridSearchConfigUpdate);
    const calls = bridge.bridgeLogSettingsChanged.mock.calls;
    const poolRow = calls.find(
      (c: [string, string]) => c[0] === "hybridSearch.candidatePoolSize",
    );
    expect(poolRow).toEqual(["hybridSearch.candidatePoolSize", "250"]);
  });

  it("settings:updateHybridSearchConfig audit row for decay-off uses the literal 'disabled', not 'null'", async () => {
    // Companion to the audit test above. When the user toggles
    // decay off, the bridge surfaces `recencyHalflifeSecs: null`
    // and the audit row would otherwise read `"null"` which is
    // ambiguous (a number-shaped audit value vs. a sentinel).
    // The handler normalises null → `"disabled"` for clarity.
    const { bridge } = makeBridge({
      ...DEFAULT_HYBRID_SEARCH_CONFIG,
      recencyDecayEnabled: true,
      recencyHalflifeSecs: 30 * 24 * 60 * 60,
    });
    stubBridge = bridge;
    registerSettingsHandlers();
    const handler = getHandler("settings:updateHybridSearchConfig");
    await handler({}, { recencyDecayEnabled: false });
    const calls = bridge.bridgeLogSettingsChanged.mock.calls;
    const halflifeRow = calls.find(
      (c: [string, string]) => c[0] === "hybridSearch.recencyHalflifeSecs",
    );
    expect(halflifeRow).toEqual([
      "hybridSearch.recencyHalflifeSecs",
      "disabled",
    ]);
    const decayRow = calls.find(
      (c: [string, string]) => c[0] === "hybridSearch.recencyDecayEnabled",
    );
    expect(decayRow).toEqual(["hybridSearch.recencyDecayEnabled", "false"]);
  });

  it("settings:updateHybridSearchConfig rate-limits aggressive updates beyond burst", async () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSettingsHandlers();
    const handler = getHandler("settings:updateHybridSearchConfig");
    // Profile is 5 per second with burst=10. Ten sequential calls
    // within ~1s are allowed (the slider can spend a burst quickly);
    // the eleventh must throw.
    for (let i = 0; i < 10; i++) {
      await handler({}, { vectorWeight: 1.0 });
    }
    await expect(handler({}, { vectorWeight: 1.0 })).rejects.toThrow();
  });

  it("sources:backfillEmbeddings forwards a validated batch size and returns the bridge result", async () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSourcesHandlers();
    const handler = getHandler("sources:backfillEmbeddings");
    const result = (await handler({}, 32)) as BackfillEmbeddingsResult;
    // The meaningful assertion is the bridge call args, not the
    // returned counts (the mock returns a fixed `embedded: 7`).
    expect(result.embedded).toBe(7);
    expect(result.progress.status).toBe("done");
    expect(bridge.bridgeBackfillEmbeddings).toHaveBeenCalledWith(32);
  });

  it("sources:backfillEmbeddings passes `null` when no batch size is supplied", async () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSourcesHandlers();
    const handler = getHandler("sources:backfillEmbeddings");
    await handler({}, null);
    expect(bridge.bridgeBackfillEmbeddings).toHaveBeenCalledWith(null);
  });

  it("sources:backfillEmbeddings rejects a non-integer / negative batch size before invoking the bridge", async () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSourcesHandlers();
    const handler = getHandler("sources:backfillEmbeddings");
    await expect(handler({}, 0)).rejects.toThrow();
    await expect(handler({}, -1)).rejects.toThrow();
    await expect(handler({}, 1.5)).rejects.toThrow();
    await expect(handler({}, 5_000)).rejects.toThrow();
    expect(bridge.bridgeBackfillEmbeddings).not.toHaveBeenCalled();
  });

  it("sources:backfillEmbeddings rate-limits aggressive Re-embed clicks", async () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSourcesHandlers();
    const handler = getHandler("sources:backfillEmbeddings");
    // Profile is 1 per 10s. Second call within the window must throw.
    await handler({}, 64);
    await expect(handler({}, 64)).rejects.toThrow();
  });

  it("sources:getEmbeddingProgress returns a snapshot from the bridge", async () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    registerSourcesHandlers();
    const handler = getHandler("sources:getEmbeddingProgress");
    const snapshot = (await handler({})) as EmbeddingProgressInfo;
    expect(snapshot.status).toBe("running");
    expect(snapshot.embedded).toBe(25);
    expect(snapshot.totalChunks).toBe(100);
  });

  it("sources:getEmbeddingProgress returns an idle snapshot when the bridge is unavailable", async () => {
    stubBridge = null;
    registerSourcesHandlers();
    const handler = getHandler("sources:getEmbeddingProgress");
    const snapshot = (await handler({})) as EmbeddingProgressInfo;
    expect(snapshot).toEqual({
      status: "idle",
      totalChunks: 0,
      embedded: 0,
      failed: 0,
      modelId: null,
      lastError: null,
    });
  });

  it("replayPersistedHybridSearchConfigToBridge is a no-op when disk matches Rust defaults", () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    // Disk == default, so replay should NOT call the bridge.
    replayPersistedHybridSearchConfigToBridge();
    expect(bridge.bridgeUpdateHybridSearchConfig).not.toHaveBeenCalled();
  });

  it("replayPersistedHybridSearchConfigToBridge pushes non-default disk config into the bridge on startup", () => {
    const { bridge, current } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    stubBridge = bridge;
    updateConfig({
      hybridSearchConfig: {
        ...DEFAULT_HYBRID_SEARCH_CONFIG,
        vectorWeight: 0.3,
        recencyHalflifeSecs: 14 * 24 * 60 * 60,
      },
    });
    replayPersistedHybridSearchConfigToBridge();
    expect(bridge.bridgeUpdateHybridSearchConfig).toHaveBeenCalledTimes(1);
    expect(current.value.vectorWeight).toBe(0.3);
    expect(current.value.recencyHalflifeSecs).toBe(14 * 24 * 60 * 60);
  });

  it("replayPersistedHybridSearchConfigToBridge resets disk to defaults if the bridge rejects the persisted patch", () => {
    const { bridge } = makeBridge(DEFAULT_HYBRID_SEARCH_CONFIG);
    bridge.bridgeUpdateHybridSearchConfig.mockImplementationOnce(() => {
      throw new Error("validation failed");
    });
    stubBridge = bridge;
    updateConfig({
      hybridSearchConfig: {
        ...DEFAULT_HYBRID_SEARCH_CONFIG,
        vectorWeight: 0.3,
      },
    });
    expect(() => replayPersistedHybridSearchConfigToBridge()).toThrow();
    // Disk reset to documented defaults so the next launch isn't
    // stuck in a perpetual replay-failure loop.
    _clearConfigCacheForTests();
    expect(loadConfig().hybridSearchConfig).toEqual(
      DEFAULT_HYBRID_SEARCH_CONFIG,
    );
  });
});
