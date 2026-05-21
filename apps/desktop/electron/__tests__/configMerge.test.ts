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
    updateConfig({ defaultExportFormat: "pdf" });
    const cfg = loadConfig();
    expect(cfg.theme).toBe("dark");
    expect(cfg.autoUpdate).toBe(false);
    expect(cfg.defaultExportFormat).toBe("pdf");
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
