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
  loadConfig,
  updateConfig,
} from "../config";

describe("updateConfig", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-config-"));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
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
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
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
});
