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

// Both DEFAULT_* constants are deep-frozen at module load so a
// future contributor doing `DEFAULT_CONFIG.ignorePatterns.push(...)`
// fails loudly at the mutation site rather than silently corrupting
// every subsequent `loadConfig()` (which spreads DEFAULT_CONFIG as
// its baseline). This also makes the side-effect of `freezeConfig`
// running over a cache that shares DEFAULT_CONFIG's array references
// a no-op rather than a sneaky cross-call mutation of a "constant".
//
// Consumers that need a mutable copy spread them: e.g. `{
// ...DEFAULT_EXTERNAL_PROVIDER }` produces a fresh unfrozen object.
// Every existing consumer in this module (and elsewhere) already
// uses spreads, so no callsite changes.
export const DEFAULT_EXTERNAL_PROVIDER: Readonly<ExternalProviderConfig> =
  Object.freeze({
    enabled: false,
    providerType: "openai_compatible" as ExternalProviderType,
    apiUrl: "",
    apiKeyRef: "tessera.external_provider.primary",
    modelName: "",
    maxTokens: 1024,
    temperature: 0.7,
    timeoutSecs: 60,
    maxRetries: 2,
  });

const DEFAULT_CONFIG: Readonly<AppConfig> = Object.freeze({
  windowWidth: 1280,
  windowHeight: 800,
  theme: "light",
  defaultExportFormat: "markdown",
  ignorePatterns: Object.freeze([
    ".git",
    "node_modules",
    ".DS_Store",
    "*.exe",
    "*.dll",
    "*.so",
    "*.dylib",
  ]) as readonly string[] as string[],
  watchPatterns: Object.freeze([
    "**/*.md",
    "**/*.txt",
    "**/*.csv",
    "**/*.json",
  ]) as readonly string[] as string[],
  lastOpenedArtifacts: Object.freeze([]) as readonly string[] as string[],
  sourcePaths: Object.freeze([]) as readonly string[] as string[],
  externalProvider: DEFAULT_EXTERNAL_PROVIDER,
  autoUpdate: true,
});

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
// needing to call `_clearConfigCacheForTests()` explicitly. In
// production the path is fixed at first launch so this never triggers.
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
 * accidentally mutating it. `Object.freeze` is shallow, so we walk
 * one level into nested objects (`externalProvider`) and arrays
 * (`ignorePatterns`, `watchPatterns`, `lastOpenedArtifacts`,
 * `sourcePaths`) and freeze each.
 *
 * There is intentionally NO top-level `Object.isFrozen(config)`
 * short-circuit: a partially-frozen config (top frozen, children
 * unfrozen) is a state no production path produces today, but if a
 * future refactor ever does, skipping children based on the
 * top-level state would silently leak unfrozen mutable references
 * through the cache. Per-property `Object.isFrozen` checks below
 * already make the work idempotent for the common case (everything
 * already frozen) — `Object.freeze` on an already-frozen object is
 * a no-op, so the only real cost of always iterating is one
 * `Object.keys` call per `freezeConfig` invocation.
 */
function freezeConfig(config: AppConfig): AppConfig {
  Object.freeze(config); // no-op if already frozen
  for (const key of Object.keys(config) as (keyof AppConfig)[]) {
    const value = config[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Object.isFrozen(value)
    ) {
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
 *
 * Prefixed with an underscore and suffixed `…ForTests` to match the
 * codebase convention for non-production seams (see
 * `electron/autoUpdater.ts`'s `_resetForTests` for the precedent),
 * so a `grep` for `_*ForTests` finds every test-only export across
 * the project.
 */
export function _clearConfigCacheForTests(): void {
  cachedConfig = null;
  cachedPath = null;
}

function readConfigFromDisk(configPath: string): AppConfig {
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
 *
 * **Ownership transfer.** Any nested array or object reference in
 * `partial` (e.g. `partial.ignorePatterns`, `partial.externalProvider`)
 * that ends up in the new cached config is deep-frozen by
 * `saveConfig`. Callers that need to keep mutating the original
 * arrays/objects after the call should spread them at the call site:
 *
 *   updateConfig({ ignorePatterns: [...myList] })
 *
 * Today the only production callsite is `ipc/settings.ts`'s
 * `settings:update` handler, where `partial` is already a fresh
 * structured-clone copy of the renderer's payload — so the freeze
 * side-effect is invisible to any retainable reference. This
 * contract is here so a future main-process caller doing
 * `updateConfig({ ignorePatterns: this.myArray })` knows that
 * `this.myArray` will become frozen after the call.
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
