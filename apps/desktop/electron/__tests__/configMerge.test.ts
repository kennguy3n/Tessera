import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Each test creates its own tempdir; we wire `app.getPath('userData')`
// to that dir so the config module reads/writes inside it.
let userDataDir: string;
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => userDataDir),
  },
}));

import {
  DEFAULT_EXTERNAL_PROVIDER,
  _clearConfigCacheForTests,
  loadConfig,
  updateConfig,
} from "../config";

describe("updateConfig", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-config-"));
    // WS7's in-memory cache is keyed by the resolved config path so a
    // fresh `userDataDir` already invalidates it, but we drop it
    // explicitly anyway so a future refactor of the keying strategy
    // doesn't silently start sharing state across tests in this file.
    _clearConfigCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    _clearConfigCacheForTests();
  });

  it("returns defaults when no config exists yet", () => {
    const cfg = loadConfig();
    expect(cfg.externalProvider).toEqual(DEFAULT_EXTERNAL_PROVIDER);
    expect(cfg.theme).toBe("light");
  });

  it("deep-merges externalProvider so unrelated fields survive partial updates", () => {
    // Seed a fully populated provider, then mutate only `enabled`.
    updateConfig({
      externalProvider: {
        enabled: false,
        providerType: "anthropic",
        apiUrl: "https://api.anthropic.com",
        apiKeyRef: "tessera.external_provider.primary",
        modelName: "claude-3-5-sonnet",
        maxTokens: 2048,
        temperature: 0.4,
        timeoutSecs: 30,
        maxRetries: 1,
      },
    });

    updateConfig({ externalProvider: { enabled: true } });

    const cfg = loadConfig();
    expect(cfg.externalProvider).toEqual({
      enabled: true,
      providerType: "anthropic",
      apiUrl: "https://api.anthropic.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "claude-3-5-sonnet",
      maxTokens: 2048,
      temperature: 0.4,
      timeoutSecs: 30,
      maxRetries: 1,
    });
  });

  it("preserves unrelated top-level fields when updating only one", () => {
    updateConfig({ theme: "dark", autoUpdate: false });
    // `"html"` is a valid `ExportFormat`; the previous fixture used
    // `"pdf"`, which the new on-disk schema (correctly) heals back to
    // the default since the codebase has never declared `"pdf"` as a
    // supported export target.
    updateConfig({ defaultExportFormat: "html" });
    const cfg = loadConfig();
    expect(cfg.theme).toBe("dark");
    expect(cfg.autoUpdate).toBe(false);
    expect(cfg.defaultExportFormat).toBe("html");
  });

  it("allows full replacement of externalProvider when caller supplies every field", () => {
    updateConfig({
      externalProvider: {
        enabled: true,
        providerType: "openai_compatible",
        apiUrl: "https://api.openai.com",
        apiKeyRef: "tessera.external_provider.primary",
        modelName: "gpt-4o-mini",
        maxTokens: 512,
        temperature: 0.2,
        timeoutSecs: 45,
        maxRetries: 3,
      },
    });
    const cfg = loadConfig();
    expect(cfg.externalProvider.modelName).toBe("gpt-4o-mini");
    expect(cfg.externalProvider.timeoutSecs).toBe(45);
  });
});

// These tests bypass `updateConfig` (which goes through `AppConfigPartial`
// at compile time) and write a raw JSON blob to disk so we can exercise
// `loadConfig`'s defensive normalisation against the kinds of values
// only a manual edit or a corrupted partial write would produce.
describe("loadConfig defensive normalisation", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-config-heal-"));
    userDataDir = dir;
    // Match the sibling `describe` blocks' cache-reset discipline.
    // Today this is technically redundant because each test uses a
    // fresh `mkdtempSync` directory and `loadConfig`'s `cachedPath`
    // check auto-invalidates on a path change — but a future test that
    // re-uses a directory across runs, or that mutates the on-disk file
    // mid-test and re-calls `loadConfig`, would silently observe a
    // stale cache. The explicit reset closes that door without any
    // dependency on the path-keyed invalidation logic being preserved.
    _clearConfigCacheForTests();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    _clearConfigCacheForTests();
  });

  function writeConfig(raw: unknown): void {
    fs.writeFileSync(
      path.join(dir, "tessera-config.json"),
      JSON.stringify(raw),
    );
  }

  it("heals an unknown theme back to the default", () => {
    writeConfig({ theme: "neon" });
    const cfg = loadConfig();
    expect(cfg.theme).toBe("light");
  });

  it("heals an unknown export format back to the default", () => {
    writeConfig({ defaultExportFormat: "pdf" });
    const cfg = loadConfig();
    expect(cfg.defaultExportFormat).toBe("markdown");
  });

  it("clamps an out-of-range externalProvider.maxRetries", () => {
    writeConfig({
      externalProvider: { ...DEFAULT_EXTERNAL_PROVIDER, maxRetries: 99 },
    });
    const cfg = loadConfig();
    expect(cfg.externalProvider.maxRetries).toBe(
      DEFAULT_EXTERNAL_PROVIDER.maxRetries,
    );
  });

  it("clamps an out-of-range externalProvider.timeoutSecs", () => {
    writeConfig({
      externalProvider: { ...DEFAULT_EXTERNAL_PROVIDER, timeoutSecs: 999_999 },
    });
    const cfg = loadConfig();
    expect(cfg.externalProvider.timeoutSecs).toBe(
      DEFAULT_EXTERNAL_PROVIDER.timeoutSecs,
    );
  });

  it("clamps an out-of-range externalProvider.temperature", () => {
    writeConfig({
      externalProvider: { ...DEFAULT_EXTERNAL_PROVIDER, temperature: -1 },
    });
    const cfg = loadConfig();
    expect(cfg.externalProvider.temperature).toBe(
      DEFAULT_EXTERNAL_PROVIDER.temperature,
    );
  });

  it("recovers when externalProvider is the wrong type entirely", () => {
    writeConfig({ externalProvider: "not an object" });
    const cfg = loadConfig();
    expect(cfg.externalProvider).toEqual(DEFAULT_EXTERNAL_PROVIDER);
  });

  it("preserves valid coexisting fields while healing invalid ones", () => {
    writeConfig({
      theme: "definitely-not-a-theme",
      defaultExportFormat: "csv",
      autoUpdate: false,
    });
    const cfg = loadConfig();
    expect(cfg.theme).toBe("light");
    expect(cfg.defaultExportFormat).toBe("csv");
    expect(cfg.autoUpdate).toBe(false);
  });

  // A corrupted `windowX` (or `windowY`) used to bubble past the field
  // schema and hit the object-level `.catch()`, wiping every other
  // valid field. The per-field `.catch(undefined)` keeps the rest of
  // the config intact and just lets a fresh window position be
  // computed on launch.
  it("does not wipe unrelated fields when windowX is corrupted", () => {
    writeConfig({
      windowX: "not a number",
      theme: "dark",
      autoUpdate: false,
      externalProvider: {
        ...DEFAULT_EXTERNAL_PROVIDER,
        modelName: "user-set-model",
      },
    });
    const cfg = loadConfig();
    expect(cfg.windowX).toBeUndefined();
    expect(cfg.theme).toBe("dark");
    expect(cfg.autoUpdate).toBe(false);
    expect(cfg.externalProvider.modelName).toBe("user-set-model");
  });

  // A corrupted `ignorePatterns` (or `watchPatterns`) used to heal to
  // `[]`, which then overrode the populated `DEFAULT_CONFIG.ignorePatterns`
  // in the `{ ...DEFAULT_CONFIG, ...healed }` spread. The per-field
  // catch now restores the documented defaults so the built-in ignore
  // list survives a corrupted field.
  it("restores populated ignorePatterns defaults when the field is corrupted", () => {
    writeConfig({ ignorePatterns: "not an array" });
    const cfg = loadConfig();
    expect(cfg.ignorePatterns).toContain(".git");
    expect(cfg.ignorePatterns).toContain("node_modules");
    expect(cfg.ignorePatterns.length).toBeGreaterThan(0);
  });

  it("restores populated watchPatterns defaults when the field is corrupted", () => {
    writeConfig({ watchPatterns: 12345 });
    const cfg = loadConfig();
    expect(cfg.watchPatterns).toContain("**/*.md");
    expect(cfg.watchPatterns.length).toBeGreaterThan(0);
  });

  // Distinct from the corruption test: a user *deliberately* writing
  // an empty array (e.g. via `updateConfig({ ignorePatterns: [] })`)
  // must be respected. The catch only fires when validation fails.
  it("preserves an explicitly empty ignorePatterns array", () => {
    writeConfig({ ignorePatterns: [] });
    const cfg = loadConfig();
    expect(cfg.ignorePatterns).toEqual([]);
  });

  it("heals an unknown externalProvider.providerType to openai_compatible", () => {
    writeConfig({
      externalProvider: { ...DEFAULT_EXTERNAL_PROVIDER, providerType: "bogus" },
    });
    const cfg = loadConfig();
    expect(cfg.externalProvider.providerType).toBe("openai_compatible");
  });

  // Forward-compat: a future Tessera version may add new config fields.
  // The on-disk schema uses `.loose()` so a downgrade to the current
  // version doesn't silently strip those unknown keys on the next
  // `updateConfig()` write. The IPC `SettingsUpdateSchema` stays strict
  // (default `.strip()`) because renderer payloads must conform to the
  // documented shape.
  it("preserves unknown top-level fields through a load round-trip", () => {
    writeConfig({
      theme: "dark",
      // A field that doesn't exist in today's AppConfig schema. A future
      // version might add e.g. `experimentalFeatures: { ... }` and we
      // shouldn't lose the user's setting on downgrade.
      experimentalFeatures: { fooEnabled: true, bar: 42 },
      anotherFutureField: "preserve-me",
    });
    const cfg = loadConfig() as Record<string, unknown>;
    expect(cfg.theme).toBe("dark");
    expect(cfg.experimentalFeatures).toEqual({ fooEnabled: true, bar: 42 });
    expect(cfg.anotherFutureField).toBe("preserve-me");
  });

  it("preserves unknown nested fields in externalProvider", () => {
    writeConfig({
      externalProvider: {
        ...DEFAULT_EXTERNAL_PROVIDER,
        modelName: "kept-by-user",
        // hypothetical future field e.g. for a streaming-mode toggle
        streamingMode: "sse-v2",
      },
    });
    const cfg = loadConfig();
    const provider = cfg.externalProvider as Record<string, unknown>;
    expect(provider.modelName).toBe("kept-by-user");
    expect(provider.streamingMode).toBe("sse-v2");
  });
});
