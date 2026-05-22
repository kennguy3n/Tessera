/**
 * Tests for the in-memory `loadConfig`/`saveConfig`/`updateConfig`
 * cache introduced in WS7.
 *
 * The cache is keyed by the resolved config path so each test (which
 * swaps `app.getPath('userData')` to a fresh tempdir) starts with an
 * effectively empty cache without needing to call
 * `clearConfigCache()` explicitly. The explicit reset is still
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
  clearConfigCache,
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
    // `clearConfigCache` so a future refactor that changes the keying
    // strategy doesn't silently start sharing state across tests.
    clearConfigCache();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    clearConfigCache();
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
    clearConfigCache();
    const fromDisk = loadConfig();
    expect(fromDisk.theme).toBe("dark");
    expect(fromDisk.autoUpdate).toBe(false);
  });

  it("clearConfigCache forces a re-read from disk", () => {
    const initial = loadConfig();
    expect(initial.theme).toBe("light"); // default

    // Manually write a new config on disk, then bust the cache.
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ ...initial, theme: "dark" }),
    );
    clearConfigCache();

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
    updateConfig({ defaultExportFormat: "pdf" });
    updateConfig({ autoUpdate: false });

    const cached = loadConfig();
    expect(cached.theme).toBe("dark");
    expect(cached.defaultExportFormat).toBe("pdf");
    expect(cached.autoUpdate).toBe(false);

    // Disk side-by-side check: the file should reflect the same shape.
    clearConfigCache();
    const onDisk = loadConfig();
    expect(onDisk.theme).toBe("dark");
    expect(onDisk.defaultExportFormat).toBe("pdf");
    expect(onDisk.autoUpdate).toBe(false);
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
