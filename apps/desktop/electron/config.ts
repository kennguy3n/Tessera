import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export type ExternalProviderType = "openai_compatible" | "anthropic" | "custom";

export interface ExternalProviderConfig {
  enabled: boolean;
  providerType: ExternalProviderType;
  apiUrl: string;
  /** Opaque handle for the secret vault entry holding the API key.
   *  The actual key never lives in this JSON config. */
  apiKeyRef: string;
  modelName: string;
  maxTokens: number;
  temperature: number;
  timeoutSecs: number;
  maxRetries: number;
}

export interface AppConfig {
  windowX?: number;
  windowY?: number;
  windowWidth: number;
  windowHeight: number;
  theme: string;
  defaultExportFormat: string;
  ignorePatterns: string[];
  watchPatterns: string[];
  lastOpenedArtifacts: string[];
  sourcePaths: string[];
  externalProvider: ExternalProviderConfig;
  /** When true the renderer should auto-check for updates on launch. */
  autoUpdate: boolean;
}

export const DEFAULT_EXTERNAL_PROVIDER: ExternalProviderConfig = {
  enabled: false,
  providerType: "openai_compatible",
  apiUrl: "",
  apiKeyRef: "tessera.external_provider.primary",
  modelName: "",
  maxTokens: 1024,
  temperature: 0.7,
  timeoutSecs: 60,
  maxRetries: 2,
};

const DEFAULT_CONFIG: AppConfig = {
  windowWidth: 1280,
  windowHeight: 800,
  theme: "light",
  defaultExportFormat: "markdown",
  ignorePatterns: [
    ".git",
    "node_modules",
    ".DS_Store",
    "*.exe",
    "*.dll",
    "*.so",
    "*.dylib",
  ],
  watchPatterns: ["**/*.md", "**/*.txt", "**/*.csv", "**/*.json"],
  lastOpenedArtifacts: [],
  sourcePaths: [],
  externalProvider: { ...DEFAULT_EXTERNAL_PROVIDER },
  autoUpdate: true,
};

function getConfigPath(): string {
  try {
    return path.join(app.getPath("userData"), "tessera-config.json");
  } catch {
    return path.join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".tessera",
      "config.json",
    );
  }
}

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      // Merge externalProvider field-by-field so adding a new field
      // in a later release does not produce an undefined slot when
      // an older config is loaded.
      const externalProvider: ExternalProviderConfig = {
        ...DEFAULT_EXTERNAL_PROVIDER,
        ...(parsed.externalProvider ?? {}),
      };
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
        externalProvider,
      };
    }
  } catch {
    // Fall through to default
  }
  return {
    ...DEFAULT_CONFIG,
    externalProvider: { ...DEFAULT_EXTERNAL_PROVIDER },
  };
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

export function updateConfig(partial: Partial<AppConfig>): void {
  const current = loadConfig();
  const updated = { ...current, ...partial };
  saveConfig(updated);
}

export function saveWindowState(state: {
  windowX: number;
  windowY: number;
  windowWidth: number;
  windowHeight: number;
}): void {
  updateConfig(state);
}
