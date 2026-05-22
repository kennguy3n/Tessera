import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { z } from "zod";
import {
  EXPORT_FORMATS,
  EXTERNAL_PROVIDER_TYPES,
  THEMES,
  type ExportFormat,
  type ExternalProviderType,
  type Theme,
} from "../shared/types";

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

// --- On-disk config validation ----------------------------------------
//
// `AppConfigSchema` runs every loaded config through zod with per-field
// `.catch()` fallbacks. Anything that fails validation (a stray
// `"theme": "neon"` from a manual edit, a `maxRetries: 15` written by a
// future version that widened the range, a number masquerading as a
// string after a corrupted upgrade) is silently replaced with the
// documented default — the same defence-in-depth strategy
// `ExternalProviderConfigSchema` provides for new writes, applied to
// reads as well so the in-memory `AppConfig` always satisfies its
// narrowed types.
//
// `.catch()` fallbacks for array fields restore the populated entries
// from `DEFAULT_CONFIG` (e.g. `[".git", "node_modules", ...]` for
// `ignorePatterns`) rather than `[]`, because `loadConfig()` does
// `{ ...DEFAULT_CONFIG, ...healed }` — spreading a healed `[]` would
// otherwise *override* the populated default and silently strip the
// built-in ignore list when a corrupted field is the only thing wrong.
//
// The IPC `SettingsUpdateSchema` and `ExternalProviderConfigSchema`
// stay strict (no `.catch()`) because *new* values coming from the
// renderer must be valid — silently rewriting them would mask renderer
// bugs. Recovery is only sensible for already-on-disk data we cannot
// regenerate.
const ExternalProviderConfigOnDiskSchema = z
  .object({
    enabled: z.boolean().catch(false),
    // `EXTERNAL_PROVIDER_TYPES` is the same const tuple `shared/types.ts`
    // uses for the compile-time `ExternalProviderType` union and the
    // IPC `ExternalProviderConfigSchema` uses for write validation.
    // Adding a provider in `shared/types.ts` automatically extends
    // this enum, the IPC enum, and the type union in lockstep.
    providerType: z.enum(EXTERNAL_PROVIDER_TYPES).catch("openai_compatible"),
    apiUrl: z.string().max(2048).catch(""),
    apiKeyRef: z
      .string()
      .min(1)
      .max(1_000_000)
      .catch("tessera.external_provider.primary"),
    modelName: z.string().max(512).catch(""),
    maxTokens: z.number().int().min(1).max(1_000_000).catch(1024),
    temperature: z.number().min(0).max(2).catch(0.7),
    timeoutSecs: z.number().int().min(1).max(600).catch(60),
    maxRetries: z.number().int().min(0).max(10).catch(2),
  })
  // `.loose()` (zod 4's rename of `.passthrough()`) preserves unknown
  // keys instead of stripping them. See the comment on `AppConfigSchema`
  // below for the rationale — same forward-compat policy for the
  // nested externalProvider block.
  .loose()
  .catch(() => ({ ...DEFAULT_EXTERNAL_PROVIDER }));

const AppConfigSchema = z
  .object({
    // `windowX` and `windowY` need their own `.catch(undefined)` (even
    // though they're optional) because `z.number().optional()` only
    // accepts `number | undefined` — a corrupted `"windowX": "bad"`
    // would otherwise bubble up to the top-level `.catch()` and wipe
    // every other field. Healing them to `undefined` means a new
    // window position is computed on launch and unrelated settings
    // (theme, externalProvider, ignorePatterns, …) survive intact.
    windowX: z.number().optional().catch(undefined),
    windowY: z.number().optional().catch(undefined),
    windowWidth: z.number().int().min(320).max(32_768).catch(1280),
    windowHeight: z.number().int().min(240).max(32_768).catch(800),
    theme: z.enum(THEMES).catch("light"),
    defaultExportFormat: z.enum(EXPORT_FORMATS).catch("markdown"),
    ignorePatterns: z
      .array(z.string().max(1024))
      .max(10_000)
      .catch(() => [...DEFAULT_CONFIG.ignorePatterns]),
    watchPatterns: z
      .array(z.string().max(1024))
      .max(10_000)
      .catch(() => [...DEFAULT_CONFIG.watchPatterns]),
    lastOpenedArtifacts: z.array(z.string().max(1024)).max(1024).catch([]),
    sourcePaths: z.array(z.string().max(4096)).max(10_000).catch([]),
    externalProvider: ExternalProviderConfigOnDiskSchema,
    autoUpdate: z.boolean().catch(true),
  })
  // `.loose()` (zod 4's rename of `.passthrough()`) preserves unknown
  // top-level keys instead of stripping them on a load → save round
  // trip. Without this, downgrading from a future Tessera version that
  // wrote a new field would silently drop the user's value on the
  // first `updateConfig()` call — because `loadConfig` does
  // `{ ...DEFAULT_CONFIG, ...healed }` and the stripped output of
  // `parse()` no longer contains the unknown key. Keeping the IPC
  // `SettingsUpdateSchema` strict (default `.strip()`) and the on-disk
  // schema loose is deliberate: renderer payloads must conform to the
  // documented shape, but the on-disk file is a user-controlled
  // artifact that should survive cross-version round-trips.
  .loose()
  .catch(() => ({
    ...DEFAULT_CONFIG,
    externalProvider: { ...DEFAULT_EXTERNAL_PROVIDER },
  }));

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
      const parsed = JSON.parse(raw) as unknown;
      // Validate (and silently heal, via `.catch()` on each field) the
      // on-disk shape so the in-memory `AppConfig` always satisfies its
      // narrowed types — e.g. `theme: Theme`, `maxRetries: 0..=10`.
      // The pre-validation code did `JSON.parse(raw) as Partial<AppConfig>`,
      // which left invalid disk values (manual edits, future-version
      // writes, partial-write corruption) typed as the narrow union
      // despite being out-of-range at runtime.
      const healed = AppConfigSchema.parse(parsed);
      const externalProvider: ExternalProviderConfig = {
        ...DEFAULT_EXTERNAL_PROVIDER,
        ...healed.externalProvider,
      };
      return {
        ...DEFAULT_CONFIG,
        ...healed,
        externalProvider,
      };
    }
  } catch {
    // `AppConfigSchema`'s top-level `.catch()` handles every shape we
    // can anticipate; getting here means something more fundamental
    // failed (file unreadable, JSON syntactically invalid). Fall back
    // to defaults.
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
