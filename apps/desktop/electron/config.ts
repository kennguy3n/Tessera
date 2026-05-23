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
import type { ExternalProviderTokenUsage } from "../shared/types";
export type { ExternalProviderTokenUsage };

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
  /** Cumulative external-provider token usage. See
   *  `electron/tokenCounter.ts` for the heuristic and rationale. */
  externalProviderTokenUsage: ExternalProviderTokenUsage;
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

/**
 * Default external-provider token usage. The `lastResetDate`
 * captures the *first-launch* timestamp so the "used since
 * &lt;date&gt;" label in `SettingsPage` displays a meaningful date
 * for users who never explicitly reset. Re-evaluated at every
 * module load, but `loadConfig` heals stale defaults into the
 * persisted record on disk on first read, so the stored timestamp
 * is stable across launches once the config file exists.
 *
 * NOT frozen because consumers spread this into the persisted
 * `AppConfig.externalProviderTokenUsage` (mutability via the
 * `updateConfig` path expects a fresh mutable copy). Tests
 * verifying immutability should snapshot via spread, not by
 * reference.
 */
export const DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE: ExternalProviderTokenUsage = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  lastResetDate: new Date(0).toISOString(),
};

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
  externalProviderTokenUsage: Object.freeze(
    DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE,
  ) as ExternalProviderTokenUsage,
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

/**
 * On-disk schema for `AppConfig.externalProviderTokenUsage`. Each
 * field has a `.catch()` heal so a corrupted persisted value (e.g.
 * a future version wrote `totalPromptTokens: "lots"` or someone
 * hand-edited the JSON) doesn't blow up the entire config load.
 *
 * The reset-date factory `() => new Date(0).toISOString()` matches
 * `DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE` and is intentionally
 * `1970-01-01` rather than "now" — a corrupted timestamp shouldn't
 * silently roll the displayed reset date forward, which would
 * obscure the original first-launch date in the UI.
 */
const ExternalProviderTokenUsageOnDiskSchema = z
  .object({
    totalPromptTokens: z.number().int().min(0).catch(0),
    totalCompletionTokens: z.number().int().min(0).catch(0),
    lastResetDate: z
      .string()
      .min(1)
      .max(64)
      .catch(() => new Date(0).toISOString()),
  })
  .loose()
  .catch(() => ({ ...DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE }));

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
    // `.catch(() => [])` (factory) rather than `.catch([])` (literal):
    // zod returns the SAME array reference on every heal when given a
    // literal, while `freezeConfig` immediately freezes whichever array
    // it sees. A subsequent `.catch()` consumer would then receive an
    // already-frozen empty array — harmless today, but the moment a
    // future contributor changes the fallback to a populated default
    // (e.g. `.catch(["recent.md"])`) the shared reference becomes a
    // footgun: every load that heals this field gets the SAME array,
    // mutations leak across cache instances, and the first `Object.freeze`
    // poisons every subsequent load. Factory functions remove the
    // class of issue structurally and match the `ignorePatterns` /
    // `watchPatterns` pattern above.
    lastOpenedArtifacts: z
      .array(z.string().max(1024))
      .max(1024)
      .catch(() => []),
    sourcePaths: z
      .array(z.string().max(4096))
      .max(10_000)
      .catch(() => []),
    externalProvider: ExternalProviderConfigOnDiskSchema,
    externalProviderTokenUsage: ExternalProviderTokenUsageOnDiskSchema,
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
    externalProviderTokenUsage: { ...DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE },
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
 * Deep-freeze an arbitrary value, recursing into every nested object
 * and array so the entire reachable graph is immutable.
 *
 * Why fully recursive (not just one level):
 *
 *   `AppConfigSchema` uses `.loose()` (zod 4's `.passthrough()`) to
 *   preserve unknown top-level keys for cross-version forward-compat.
 *   A future Tessera version writing a richer config — e.g.
 *   `{ experimentalFeatures: { caching: { ttl_seconds: 3600 } } }` —
 *   would have that nested `caching` object preserved through the
 *   load. A one-level freeze would freeze `experimentalFeatures` but
 *   leave `caching` mutable, and a caller doing
 *   `cfg.experimentalFeatures.caching.ttl_seconds = 0` would silently
 *   corrupt every other reader's cached view without a TypeError.
 *
 *   Deep recursion ensures the freeze barrier matches the cache
 *   contract advertised by `loadConfig`: the returned config is
 *   IMMUTABLE in full, not just at the top level. Callers that need
 *   a mutable copy already spread (`{ ...loadConfig() }`) — the
 *   shallow-copy idiom only restores mutability at the top level,
 *   which matches the documented contract.
 *
 * Cycle handling: a `WeakSet` of in-flight references prevents the
 * walker from infinite-looping on a self-referential graph. JSON.parse
 * cannot produce cycles, but a future code path that mutates a healed
 * config in place (e.g. `cfg.parent = cfg`) before caching it would
 * otherwise stack-overflow. The cost is one `WeakSet` per freeze call.
 *
 * Idempotency without short-circuit: `Object.freeze` on an
 * already-frozen object is a no-op, so re-freezing during a descent
 * is free. We deliberately do NOT short-circuit on
 * `Object.isFrozen(obj)` at any level — the pre-split code at
 * `electron/config.ts` (before WS6) carried an explicit comment
 * rejecting that optimisation:
 *
 *   "a partially-frozen config (top frozen, children unfrozen) is a
 *   state no production path produces today, but if a future refactor
 *   ever does, skipping children based on the top-level state would
 *   silently leak unfrozen mutable references through the cache."
 *
 * That posture still applies here, and the walker preserves it: every
 * reachable node is visited and re-frozen even if its parent was
 * already frozen. The `WeakSet` is for cycle protection, not for
 * skipping already-frozen subtrees. The amortised cost is still
 * O(N) walks of cheap no-op freezes, identical to the cost of the
 * old one-level helper in the common all-frozen case.
 */
function deepFreeze<T>(value: T, seen: WeakSet<object>): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const obj = value as unknown as object;
  if (seen.has(obj)) {
    return value;
  }
  seen.add(obj);
  // Freeze the parent BEFORE recursing into children so a cycle that
  // walks back to this node sees it in `seen` and stops. Without this
  // ordering a `{ a: { b: parent } }` graph would re-enter the parent
  // before `seen.add` ran and recursion would only terminate by stack
  // overflow.
  //
  // No `Object.isFrozen` short-circuit here — see the function comment
  // above for the architectural reason. Calling `Object.freeze` on an
  // already-frozen object is a documented no-op, so re-freezing is
  // free.
  Object.freeze(obj);
  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item, seen);
    }
  } else {
    for (const key of Object.keys(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key], seen);
    }
  }
  return value;
}

function freezeConfig(config: AppConfig): AppConfig {
  return deepFreeze(config, new WeakSet<object>());
}

/**
 * Test-only seam: invoke the deep-freeze walker on an arbitrary value
 * so the pin on the "partially-frozen graph still gets children
 * frozen" contract can exercise the walker without going through
 * `loadConfig`'s on-disk + spread path (which would always produce a
 * fully-unfrozen top with already-frozen `DEFAULT_CONFIG` children —
 * the OPPOSITE of the case we want to pin).
 *
 * Production code never calls this — every cache write goes through
 * `freezeConfig(readConfigFromDisk(...))`.
 */
export function _deepFreezeForTests<T>(value: T): T {
  return deepFreeze(value, new WeakSet<object>());
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
      const externalProviderTokenUsage: ExternalProviderTokenUsage = {
        ...DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE,
        ...healed.externalProviderTokenUsage,
      };
      return {
        ...DEFAULT_CONFIG,
        ...healed,
        externalProvider,
        externalProviderTokenUsage,
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
    externalProviderTokenUsage: { ...DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE },
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
export type AppConfigPartial = Omit<
  Partial<AppConfig>,
  "externalProvider" | "externalProviderTokenUsage"
> & {
  externalProvider?: Partial<ExternalProviderConfig>;
  /** Same field-by-field merge semantics as `externalProvider`:
   *  passing `{ totalPromptTokens: 100 }` updates that field
   *  without clobbering the other two. */
  externalProviderTokenUsage?: Partial<ExternalProviderTokenUsage>;
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
  const {
    externalProvider: providerPartial,
    externalProviderTokenUsage: usagePartial,
    ...topLevel
  } = partial;
  const mergedProvider: ExternalProviderConfig | undefined =
    providerPartial !== undefined
      ? {
          ...current.externalProvider,
          ...providerPartial,
        }
      : undefined;
  const mergedUsage: ExternalProviderTokenUsage | undefined =
    usagePartial !== undefined
      ? {
          ...current.externalProviderTokenUsage,
          ...usagePartial,
        }
      : undefined;
  const updated: AppConfig = {
    ...current,
    ...topLevel,
    ...(mergedProvider ? { externalProvider: mergedProvider } : {}),
    ...(mergedUsage ? { externalProviderTokenUsage: mergedUsage } : {}),
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
