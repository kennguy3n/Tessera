import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { ExternalProviderType } from "../shared/types";

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

// In-memory cache of the on-disk config.
//
// Before this layer, every `loadConfig()` call did a synchronous
// `fs.existsSync` + `fs.readFileSync` + `JSON.parse` on the Electron
// main thread. The renderer hits `loadConfig` from a half-dozen IPC
// handlers (`settings:get`, `updates:getAutoUpdateEnabled`,
// `externalProvider:get`, …), some on a hot path — e.g. the auto-update
// poll at `electron/autoUpdater.ts:277` reads `loadConfig().autoUpdate`
// on every renderer ping. Reading from memory on the second hit makes
// those calls effectively free.
//
// `cachedPath` is stored alongside `cachedConfig` so a `getConfigPath()`
// change (the test suite swaps `app.getPath('userData')` between
// tempdirs per-test) auto-invalidates the cache without the test
// needing to call `clearConfigCache()` explicitly. In production the
// path is fixed at first launch so this never triggers.
//
// The cached value is deep-frozen before being stored (see
// `freezeConfig` below). The pre-cache code returned a fresh
// `{ ...DEFAULT_CONFIG, ...parsed }` on every call, so callers could
// freely mutate the result without side effects. The cache now
// returns the SAME reference across calls, so a caller doing
// `cfg.theme = 'x'` or `cfg.ignorePatterns.push(...)` would corrupt
// every other reader's view of the config without the disk ever
// being touched. Deep-freezing turns that silent corruption into a
// loud TypeError at the mutation site, which is the right place to
// surface the bug. Callers that legitimately want a mutable copy
// should spread: `const next = { ...loadConfig() }`.
let cachedConfig: AppConfig | null = null;
let cachedPath: string | null = null;

/**
 * Deep-freeze an AppConfig (and every nested object/array) so the
 * cached value can be returned by reference without risk of a caller
 * accidentally mutating it. `Object.freeze` is shallow, so we recurse
 * into nested objects (`externalProvider`) and arrays
 * (`ignorePatterns`, `watchPatterns`, `lastOpenedArtifacts`,
 * `sourcePaths`). The freeze is idempotent — calling it on an already
 * frozen subtree is a no-op (and a future contributor relying on this
 * idempotency in `saveConfig`'s fast path will not be surprised).
 */
function freezeConfig(config: AppConfig): AppConfig {
  if (Object.isFrozen(config)) return config;
  Object.freeze(config);
  for (const key of Object.keys(config) as (keyof AppConfig)[]) {
    const value = config[key];
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
      // Nested objects (`externalProvider`) and arrays
      // (`ignorePatterns`, etc.) are one level deep — none of them
      // contain further nested objects today. If a future field adds
      // deeper structure (e.g. `connectors: { gdrive: { ... } }`)
      // this needs to recurse fully; promoted to a proper recursive
      // helper at that point.
      Object.freeze(value);
    }
  }
  return config;
}

/**
 * Test-only seam: drop the in-memory cache so the next `loadConfig()`
 * re-reads from disk. Production callers should never need this — the
 * cache is kept consistent via `saveConfig` / `updateConfig`'s
 * write-through paths.
 */
export function clearConfigCache(): void {
  cachedConfig = null;
  cachedPath = null;
}

function readConfigFromDisk(configPath: string): AppConfig {
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

/**
 * Return the persisted application config. The returned object is
 * deep-frozen — attempting to mutate it (or any nested field) will
 * throw a TypeError in strict mode. Callers that need a mutable copy
 * should spread it: `const draft = { ...loadConfig() }`.
 */
export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  if (cachedConfig !== null && cachedPath === configPath) {
    return cachedConfig;
  }
  const fresh = readConfigFromDisk(configPath);
  cachedConfig = freezeConfig(fresh);
  cachedPath = configPath;
  return cachedConfig;
}

/**
 * Persist a full {@link AppConfig} to disk and update the cache.
 *
 * The caller's object is deep-frozen after the disk write succeeds —
 * the cache returns this exact reference from subsequent
 * `loadConfig` calls, so the caller MUST treat the object as opaque
 * after handing it to `saveConfig`. (The only production caller is
 * `updateConfig` below, which builds a fresh `updated` object and
 * does not retain a mutable handle.) If the disk write throws, the
 * cache remains in its prior consistent state.
 */
export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
  // Write-through: keep the cache in sync so the next `loadConfig` does
  // not re-read from disk and rebuild the AppConfig from raw JSON.
  // Freezing happens AFTER the disk write so a freeze failure (which
  // shouldn't happen, but just in case) cannot leave the on-disk
  // state ahead of the in-memory state.
  cachedConfig = freezeConfig(config);
  cachedPath = configPath;
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
