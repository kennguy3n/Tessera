import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { ExportFormat, ExternalProviderType, Theme } from "../shared/types";

// Re-export so call sites that already pull `ExternalProviderType` from
// `./config` keep working without churn. The canonical declaration lives
// in `apps/desktop/shared/types.ts` so the IPC wire shape
// (`ExternalProviderConfigInput`) and the on-disk config shape
// (`ExternalProviderConfig`) cannot drift apart.
export type { ExternalProviderType };

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
  theme: Theme;
  defaultExportFormat: ExportFormat;
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

/**
 * Partial update payload accepted by {@link updateConfig}.
 *
 * The nested `externalProvider` may be a partial object: any fields
 * the caller omits are taken from the currently persisted provider
 * (or its defaults if no config exists yet). This lets callers say
 * `updateConfig({ externalProvider: { enabled: true } })` without
 * accidentally clobbering `apiUrl`, `apiKeyRef`, etc.
 */
export type AppConfigPartial = Omit<Partial<AppConfig>, "externalProvider"> & {
  externalProvider?: Partial<ExternalProviderConfig>;
};

/**
 * Apply a partial update to the on-disk config.
 *
 * Top-level fields are shallow-merged. The nested
 * {@link ExternalProviderConfig} is merged field-by-field so
 * passing only a subset of provider fields is safe; anyone wanting
 * to fully replace the provider can pass the complete object.
 */
export function updateConfig(partial: AppConfigPartial): void {
  const current = loadConfig();
  const { externalProvider: providerPartial, ...topLevel } = partial;
  const mergedProvider: ExternalProviderConfig | undefined =
    providerPartial !== undefined
      ? {
          ...current.externalProvider,
          ...providerPartial,
        }
      : undefined;
  const updated: AppConfig = {
    ...current,
    ...topLevel,
    ...(mergedProvider ? { externalProvider: mergedProvider } : {}),
  };
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
