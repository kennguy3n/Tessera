/**
 * Tests for the in-memory `loadConfig`/`saveConfig`/`updateConfig`
 * cache.
 *
 * The cache is keyed by the resolved config path so each test (which
 * swaps `app.getPath('userData')` to a fresh tempdir) starts with an
 * effectively empty cache without needing to call
 * `_clearConfigCacheForTests()` explicitly. The explicit reset is still
 * exercised in one test so a future refactor that drops it fails
 * loudly here.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let userDataDir: string;
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
  },
}));

import {
  type AppConfig,
  DEFAULT_EXTERNAL_PROVIDER,
  _clearConfigCacheForTests,
  _deepFreezeForTests,
  loadConfig,
  saveConfig,
  updateConfig,
} from "../config";

function configPath(): string {
  return path.join(userDataDir, "tessera-config.json");
}

describe("config cache", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-cfg-cache-"));
    // `userDataDir` is fresh per test so the cache (keyed by the
    // resolved config path) auto-invalidates. We still call
    // `_clearConfigCacheForTests` so a future refactor that changes the keying
    // strategy doesn't silently start sharing state across tests.
    _clearConfigCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    _clearConfigCacheForTests();
  });

  it("first load reads from disk, subsequent loads return cached value", () => {
    // Seed an on-disk config the cache can pick up.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ theme: "dark", autoUpdate: false }),
    );

    const first = loadConfig();
    expect(first.theme).toBe("dark");
    expect(first.autoUpdate).toBe(false);

    // Mutate the on-disk file *out from under* the cache. A
    // non-caching `loadConfig` would observe the new value; the cache
    // is supposed to be authoritative until invalidated.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ theme: "light", autoUpdate: true }),
    );

    const second = loadConfig();
    expect(second.theme).toBe("dark");
    expect(second.autoUpdate).toBe(false);
  });

  it("returns the exact same object reference on repeated calls", () => {
    // The pre-cache code returned a fresh `{ ...DEFAULT_CONFIG, ...parsed }`
    // every call, so renderer code that compared identities via `===`
    // would have always seen a "new" config. The cache returns the
    // stored reference, which is a real behavioural change worth
    // pinning so consumers can rely on `Object.is(loadConfig(),
    // loadConfig())` short-circuits and so a future refactor that
    // accidentally rebuilds the AppConfig on every call (defeating the
    // O(1) read) fails this test.
    const a = loadConfig();
    const b = loadConfig();
    expect(b).toBe(a);
  });

  it("saveConfig updates the cache so the next loadConfig skips disk", () => {
    const seeded = loadConfig();
    saveConfig({ ...seeded, theme: "dark" });

    // Delete the on-disk file. A non-caching `loadConfig` would now
    // fall back to defaults (`theme: "light"`). The cache should still
    // return what we just saved.
    fs.unlinkSync(configPath());

    const after = loadConfig();
    expect(after.theme).toBe("dark");
  });

  it("updateConfig updates the cache and persists to disk", () => {
    updateConfig({ theme: "dark", autoUpdate: false });
    // Cached read first.
    const fromCache = loadConfig();
    expect(fromCache.theme).toBe("dark");
    expect(fromCache.autoUpdate).toBe(false);

    // Disk read to confirm the write-through landed.
    _clearConfigCacheForTests();
    const fromDisk = loadConfig();
    expect(fromDisk.theme).toBe("dark");
    expect(fromDisk.autoUpdate).toBe(false);
  });

  it("_clearConfigCacheForTests forces a re-read from disk", () => {
    const initial = loadConfig();
    expect(initial.theme).toBe("light"); // default

    // Manually write a new config on disk, then bust the cache.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ ...initial, theme: "dark" }),
    );
    _clearConfigCacheForTests();

    const reloaded = loadConfig();
    expect(reloaded.theme).toBe("dark");
  });

  it("auto-invalidates when the resolved config path changes", () => {
    // Establish a cache entry against the first userData dir.
    updateConfig({ theme: "dark" });
    expect(loadConfig().theme).toBe("dark");

    // Swap to a new userData dir. `getConfigPath()` now resolves
    // somewhere new; the cache's `cachedPath !== currentPath` check
    // should re-read.
    const oldDir = userDataDir;
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-cfg-cache-"));
    try {
      const cfg = loadConfig();
      expect(cfg.theme).toBe("light"); // fresh tempdir, default value
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = oldDir;
    }
  });

  it("a sequence of updateConfig calls converges on the union of all writes", () => {
    // Bulk-settings-change pattern: SettingsPage's `<select>` onChange
    // fires several updateConfig calls in quick succession. Each
    // should see the cached result of the previous call (rather than
    // racing against a slow disk re-read) and contribute to a final
    // on-disk shape that reflects all writes.
    updateConfig({ theme: "dark" });
    updateConfig({ defaultExportFormat: "csv" });
    updateConfig({ autoUpdate: false });

    const cached = loadConfig();
    expect(cached.theme).toBe("dark");
    expect(cached.defaultExportFormat).toBe("csv");
    expect(cached.autoUpdate).toBe(false);

    // Disk side-by-side check: the file should reflect the same shape.
    _clearConfigCacheForTests();
    const onDisk = loadConfig();
    expect(onDisk.theme).toBe("dark");
    expect(onDisk.defaultExportFormat).toBe("csv");
    expect(onDisk.autoUpdate).toBe(false);
  });

  it("DEFAULT_EXTERNAL_PROVIDER is frozen at module load", () => {
    // The module-level defaults are intentionally frozen so a future
    // contributor doing `DEFAULT_EXTERNAL_PROVIDER.apiUrl = '...'`
    // fails loudly rather than silently corrupting the baseline used
    // by every subsequent `loadConfig`. Previously the defaults
    // were unfrozen and would get frozen as a side effect by the
    // first cache population — a confusing "this constant became
    // frozen after some call somewhere" surprise.
    expect(Object.isFrozen(DEFAULT_EXTERNAL_PROVIDER)).toBe(true);
    expect(() => {
      (DEFAULT_EXTERNAL_PROVIDER as { apiUrl: string }).apiUrl =
        "https://api.evil.example";
    }).toThrow(TypeError);
  });

  it("DEFAULT_CONFIG's arrays are frozen at module load", () => {
    // Spreading DEFAULT_CONFIG into `loadConfig`'s return value
    // shares array references (`ignorePatterns`, `watchPatterns`,
    // etc.) — pre-freezing the constant's arrays means no consumer
    // can mutate the baseline through the shared reference, and
    // `freezeConfig` walking a cache that aliases those arrays is a
    // pure no-op rather than a sneaky retroactive freeze of a
    // module-level constant.
    //
    // We inspect the arrays via a fresh `loadConfig()` (which on a
    // cold cache returns a config whose arrays are the same
    // references as DEFAULT_CONFIG's, modulo any on-disk overrides).
    const cfg = loadConfig(); // cold cache, no on-disk overrides
    expect(Object.isFrozen(cfg.ignorePatterns)).toBe(true);
    expect(Object.isFrozen(cfg.watchPatterns)).toBe(true);
    expect(Object.isFrozen(cfg.lastOpenedArtifacts)).toBe(true);
    expect(Object.isFrozen(cfg.pinnedArtifactIds)).toBe(true);
    expect(Object.isFrozen(cfg.recentArtifactIds)).toBe(true);
    expect(Object.isFrozen(cfg.sourcePaths)).toBe(true);
    expect(() => {
      (cfg.ignorePatterns as string[]).push(".cache");
    }).toThrow(TypeError);
  });

  it("freezeConfig deep-freezes even if the top-level is already frozen", () => {
    // After dropping `freezeConfig`'s early-return guard, passing a
    // partially-frozen config (top frozen, children unfrozen) still
    // freezes the children. The only way for production code to
    // produce such a state would be a future refactor of
    // `updateConfig` / `saveConfig`, so this test pins the defensive
    // behaviour for that hypothetical future.
    //
    // We exercise this via the public surface: `saveConfig` on a
    // config that came back from `loadConfig` (which is fully
    // frozen) would early-out under the old guard but now must still
    // be safe to call. Note that `updateConfig`'s real flow goes
    // through `{ ...current, ...partial }` so this is purely a
    // belt-and-braces test.
    const cfg = loadConfig();
    expect(() => saveConfig(cfg)).not.toThrow();
    // The cache continues to return a fully-frozen result.
    const after = loadConfig();
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.externalProvider)).toBe(true);
    expect(Object.isFrozen(after.ignorePatterns)).toBe(true);
  });

  it("rejects direct mutation of a top-level cached field", () => {
    // Deep-freeze contract: a caller doing `cfg.theme = 'x'` on the
    // cached object would silently corrupt every other reader's view
    // of the config without the disk being touched. The cache freezes
    // the returned object so this surfaces as a TypeError at the
    // mutation site instead of as a much-harder-to-debug
    // "cache disagrees with disk" symptom downstream.
    const cfg = loadConfig();
    expect(() => {
      // The cast is the same cast a buggy caller would have to write
      // to bypass TypeScript's `Readonly` if we ever add that — we're
      // testing the runtime guard, not the type system.
      (cfg as { theme: string }).theme = "dark";
    }).toThrow(TypeError);
    // And the cache is unchanged after the failed mutation.
    expect(loadConfig().theme).toBe(cfg.theme);
  });

  it("rejects mutation of a nested array on the cached config", () => {
    // `Object.freeze` is shallow; the cache uses a deep-freeze helper
    // so nested arrays (`ignorePatterns`, `watchPatterns`,
    // `lastOpenedArtifacts`, `sourcePaths`) are also frozen. A buggy
    // caller doing `cfg.ignorePatterns.push('node_modules')` would
    // otherwise corrupt the shared array reference without going
    // through `updateConfig`.
    const cfg = loadConfig();
    expect(() => {
      (cfg.ignorePatterns as string[]).push(".cache");
    }).toThrow(TypeError);
    expect(() => {
      (cfg.watchPatterns as string[]).push("**/*.foo");
    }).toThrow(TypeError);
  });

  it("rejects mutation of the nested externalProvider object", () => {
    const cfg = loadConfig();
    expect(() => {
      (cfg.externalProvider as { enabled: boolean }).enabled = true;
    }).toThrow(TypeError);
    expect(() => {
      (cfg.externalProvider as { modelName: string }).modelName = "claude-3";
    }).toThrow(TypeError);
  });

  it("permits the spread-to-mutable-draft idiom that callers should use", () => {
    // The escape hatch for a caller that wants a mutable copy is to
    // spread the frozen result: `const draft = { ...loadConfig() }`.
    // That produces a fresh, unfrozen object whose nested fields are
    // still the frozen originals (shallow copy is enough for any
    // top-level field replacement; if a caller wants a mutable
    // `ignorePatterns` they spread that array too).
    const draft = { ...loadConfig() };
    expect(Object.isFrozen(draft)).toBe(false);
    draft.theme = "dark"; // would throw if `draft` were frozen
    expect(draft.theme).toBe("dark");

    // The original cache is untouched.
    expect(loadConfig().theme).toBe("light");
  });

  it("updateConfig still works after the previous cached value was frozen", () => {
    // Sanity check: `updateConfig` internally calls `loadConfig`
    // (returns frozen), spreads it into a new object literal, mutates
    // that, and passes to `saveConfig`. Spreading a frozen object
    // into a new literal produces an unfrozen new object, so the
    // sequence is legal — but a future refactor that does `const next
    // = loadConfig(); next.foo = x` instead would suddenly throw.
    // This test pins the working flow.
    updateConfig({ theme: "dark" });
    expect(loadConfig().theme).toBe("dark");

    updateConfig({ defaultExportFormat: "csv" });
    expect(loadConfig().theme).toBe("dark");
    expect(loadConfig().defaultExportFormat).toBe("csv");

    // Including the nested-provider merge path, which builds a new
    // `mergedProvider` from the previously-frozen one.
    updateConfig({ externalProvider: { enabled: true } });
    expect(loadConfig().externalProvider.enabled).toBe(true);
  });

  it("freezes children of a partially-frozen graph (no Object.isFrozen short-circuit)", () => {
    // Regression test for the architectural rule the earlier code
    // documented at length:
    //
    //   "a partially-frozen config (top frozen, children unfrozen) is
    //   a state no production path produces today, but if a future
    //   refactor ever does, skipping children based on the top-level
    //   state would silently leak unfrozen mutable references through
    //   the cache."
    //
    // The first iteration of the recursive walker accidentally
    // re-introduced an `Object.isFrozen(obj)` short-circuit, which
    // would have silently regressed that defensive posture. This test
    // pins the contract by constructing exactly the failure mode the
    // old comment warned about — top frozen, children unfrozen — and
    // asserting the walker descends and freezes the children anyway.
    //
    // The construction can't happen through the public load/save API
    // (every production path produces a fully-unfrozen top with
    // already-frozen DEFAULT_CONFIG-derived children, the inverse of
    // this case), so we use the `_deepFreezeForTests` seam to invoke
    // the walker directly on a hand-crafted graph.
    const child = { mutable: true, items: [1, 2, 3] };
    const grandchild = { deeper: { deepest: ["a", "b"] } };
    const partial = { child, grandchild };
    Object.freeze(partial); // only the top — children remain mutable

    expect(Object.isFrozen(partial)).toBe(true);
    expect(Object.isFrozen(child)).toBe(false);
    expect(Object.isFrozen(grandchild)).toBe(false);
    expect(Object.isFrozen(grandchild.deeper)).toBe(false);

    _deepFreezeForTests(partial);

    // Every node in the reachable graph is now frozen, even though
    // the walker entered through an already-frozen top.
    expect(Object.isFrozen(partial)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
    expect(Object.isFrozen(child.items)).toBe(true);
    expect(Object.isFrozen(grandchild)).toBe(true);
    expect(Object.isFrozen(grandchild.deeper)).toBe(true);
    expect(Object.isFrozen(grandchild.deeper.deepest)).toBe(true);

    // And mutations at every depth now throw.
    expect(() => {
      (child as { mutable: boolean }).mutable = false;
    }).toThrow(TypeError);
    expect(() => {
      child.items.push(4);
    }).toThrow(TypeError);
    expect(() => {
      grandchild.deeper.deepest.push("c");
    }).toThrow(TypeError);
  });

  it("deep-freeze walker handles self-referential cycles without stack overflow", () => {
    // The walker uses a WeakSet of in-flight references to terminate
    // cycles. This is a hard prerequisite for the "no isFrozen
    // short-circuit" stance: with the short-circuit removed, the
    // ONLY thing preventing infinite recursion on a cycle is the
    // WeakSet, so we need a regression test that exercises it.
    //
    // The production load path can't produce cycles (JSON.parse only
    // emits trees), but a future in-memory mutation path that does
    // `cfg.parent = cfg` before caching would otherwise stack-overflow
    // when the walker descended into `cfg.parent`'s `parent`'s
    // `parent`... etc.
    const cyclic = { name: "root" } as Record<string, unknown>;
    cyclic.self = cyclic;
    cyclic.nested = { back: cyclic };

    expect(() => _deepFreezeForTests(cyclic)).not.toThrow();
    expect(Object.isFrozen(cyclic)).toBe(true);
    expect(Object.isFrozen(cyclic.nested)).toBe(true);
  });

  it("deep-freezes nested objects preserved through .loose() passthrough", () => {
    // Regression test for the freeze-recursion contract. `AppConfigSchema`
    // uses `.loose()` to forward-preserve unknown top-level keys, so a
    // future Tessera version writing a nested config like
    // `{ experimentalFeatures: { caching: { ttl_seconds: 3600 } } }`
    // round-trips through this version intact. The pre-recursion freeze
    // helper only walked one level deep — it would have frozen
    // `experimentalFeatures` but left `caching` mutable, allowing a
    // caller doing
    //   `cfg.experimentalFeatures.caching.ttl_seconds = 0`
    // to silently corrupt every other reader's cached view of that
    // field. A fully recursive freeze closes that gap by ensuring every
    // node in the reachable graph is frozen before the cache hands it
    // out.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        // Top-level unknown key with nested structure, preserved by
        // `.loose()` on AppConfigSchema.
        experimentalFeatures: {
          caching: {
            ttl_seconds: 3600,
            tags: ["fast", "warm"],
          },
        },
      }),
    );

    const cfg = loadConfig() as AppConfig & {
      experimentalFeatures: {
        caching: { ttl_seconds: number; tags: string[] };
      };
    };

    // Top-level passthrough survived.
    expect(cfg.experimentalFeatures).toBeDefined();
    expect(cfg.experimentalFeatures.caching).toBeDefined();
    expect(cfg.experimentalFeatures.caching.ttl_seconds).toBe(3600);

    // Every node in the nested graph is frozen.
    expect(Object.isFrozen(cfg.experimentalFeatures)).toBe(true);
    expect(Object.isFrozen(cfg.experimentalFeatures.caching)).toBe(true);
    expect(Object.isFrozen(cfg.experimentalFeatures.caching.tags)).toBe(true);

    // Mutation at the deepest level throws — this is the property
    // shallow-freeze would have failed to enforce.
    expect(() => {
      cfg.experimentalFeatures.caching.ttl_seconds = 0;
    }).toThrow(TypeError);
    expect(() => {
      cfg.experimentalFeatures.caching.tags.push("hot");
    }).toThrow(TypeError);
  });

  it("survives 100 reads when the config file disappears mid-flight", () => {
    // The point of the cache: a renderer that polls
    // `updates:getAutoUpdateEnabled` repeatedly hits memory, not disk.
    // We can't easily spy on `fs.readFileSync` (non-configurable
    // module export in Node 20+) so we approximate by deleting the
    // on-disk file after the first read: a non-caching `loadConfig`
    // would observe its absence on the second call and fall back to
    // defaults; the cache keeps returning the original value.
    fs.writeFileSync(configPath(), JSON.stringify({ autoUpdate: false }));
    expect(loadConfig().autoUpdate).toBe(false);

    fs.unlinkSync(configPath());

    for (let i = 0; i < 100; i++) {
      expect(loadConfig().autoUpdate).toBe(false);
    }
  });
});
