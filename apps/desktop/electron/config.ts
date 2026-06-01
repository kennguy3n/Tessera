import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { z } from "zod";
import {
  APP_LOCK_MODES,
  DEFAULT_MODEL_IDLE_TIMEOUT_SECS,
  EXPORT_FORMATS,
  EXTERNAL_PROVIDER_TYPES,
  MAX_MODEL_IDLE_TIMEOUT_SECS,
  MAX_PINNED_ARTIFACTS,
  MAX_RECENT_ARTIFACTS,
  THEMES,
  type AppLockMode,
  type ExportFormat,
  type ExternalProviderType,
  type ExternalProviderTokenUsage,
  type Theme,
} from "../shared/types";

// Re-export so call sites that already pull these types from
// `./config` keep working without churn. The canonical
// declarations live in `apps/desktop/shared/types.ts` so the IPC
// wire shape (`ExternalProviderConfigInput`) and the on-disk
// config shape (`ExternalProviderConfig`) cannot drift apart.
export type { ExternalProviderType, ExternalProviderTokenUsage };

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

/**
 * On-disk persistence shape for the hybrid retrieval config.
 *
 * The renderer's Settings page edits these values and they get
 * pushed to the Rust core via `settings:updateHybridSearchConfig`
 * → `bridge_update_hybrid_search_config`. On launch, the bridge
 * `state-init` path reads the persisted values and replays them
 * through `SourceManager::update_hybrid_config` so a restart does
 * not silently revert the user's choices.
 *
 * The Rust core uses `f64::INFINITY` to signal "no recency decay";
 * we surface that here as the explicit `recencyDecayEnabled` flag
 * (with `recencyHalflifeSecs` becoming meaningless when disabled)
 * so the JSON on disk can round-trip cleanly — `Infinity` is not
 * representable in JSON.
 */
export interface HybridSearchConfigPersisted {
  bm25Weight: number;
  vectorWeight: number;
  rrfK: number;
  recencyDecayEnabled: boolean;
  /** Half-life in seconds. Ignored when `recencyDecayEnabled` is false. */
  recencyHalflifeSecs: number;
  candidatePoolSize: number;
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
  /**
   * persisted first-run onboarding flag. See
   * `SettingsData.onboardingCompleted` in `shared/types.ts` for the
   * full semantics. Defaults to `false` so fresh installs see the
   * wizard on first launch.
   */
  onboardingCompleted: boolean;
  /**
   * persisted favorites set. See
   * `SettingsData.pinnedArtifactIds` in `shared/types.ts` for the
   * full semantics. Cap of 256 entries is enforced by
   * `AppConfigSchema` so a corrupt on-disk array can't blow up the
   * config payload — the IPC `SettingsUpdateSchema` repeats the
   * cap for writes.
   */
  pinnedArtifactIds: string[];
  /**
   * view-recency list, capped at
   * {@link SettingsData.MAX_RECENT_ARTIFACTS}. Trimmed on every
   * renderer-side push via `useTrackArtifactView`; the IPC layer
   * re-enforces the cap so a malformed renderer can't grow the
   * list past the documented bound.
   */
  recentArtifactIds: string[];
  /**
   * opt-in flag for the local telemetry sink.
   * Defaults to `false` so a fresh install records nothing until the
   * user explicitly enables it from Settings. See
   * `SettingsData.telemetryEnabled` in `shared/types.ts` for the
   * privacy contract — local-only, no PII, no network egress.
   */
  telemetryEnabled: boolean;
  /**
   * app-lock mode. See
   * `SettingsData.appLockMode` in `shared/types.ts` for the
   * semantics. Defaults to `"off"` so a fresh install does not
   * surprise the user with a lock prompt. Switching to `"pin"` /
   * `"biometric"` requires the user to have set up a PIN via
   * `appLock:setPin` first; the IPC schema rejects mode changes
   * that would lock the user out.
   */
  appLockMode: AppLockMode;
  /**
   * auto-updater Ed25519 signature
   * enforcement. Defaults to `true` so a fresh install enforces
   * verification by default; the embedded public key lives in
   * `electron/updateSignature.ts`.
   */
  enforceUpdateSignature: boolean;
  /**
   * Per-app keychain ACL enforcement. See
   * `SettingsData.enforceKeychainAcl` in `shared/types.ts` for the
   * full contract. Defaults to `true` so a fresh install refuses to
   * persist secrets under Electron's Linux `basic_text` fallback;
   * macOS / Windows are unaffected because the OS backend is always
   * available. A Linux user without a running secret-store daemon
   * (gnome-keyring / kwallet) can either install one OR flip this
   * off in Settings → Security to accept the reduced protection.
   * Reads are never gated.
   */
  enforceKeychainAcl: boolean;
  /**
   * Persisted hybrid retrieval config. The defaults here mirror
   * `tessera_sources::hybrid::HybridSearchConfig::default()` so a
   * fresh install behaves identically with or without this field
   * on disk.
   */
  hybridSearchConfig: HybridSearchConfigPersisted;
  /**
   * idle window in seconds after which the
   * local sidecars unload model weights. See
   * `SettingsData.modelIdleTimeoutSecs` in `shared/types.ts` for
   * the full semantics. Defaults to `DEFAULT_MODEL_IDLE_TIMEOUT_SECS`
   * (60 s) so the persisted-config behaviour matches the historical
   * hardcoded `idleUnloadMs: 60_000` literal that lived in
   * `electron/sidecar.ts` before this field was added.
   */
  modelIdleTimeoutSecs: number;
}

/** Default persisted hybrid config — mirrors Rust default. */
export const DEFAULT_HYBRID_SEARCH_CONFIG: Readonly<HybridSearchConfigPersisted> =
  Object.freeze({
    bm25Weight: 1.0,
    vectorWeight: 1.0,
    rrfK: 60.0,
    recencyDecayEnabled: true,
    // 30 days in seconds — matches DEFAULT_RECENCY_HALFLIFE_SECS in
    // `crates/tessera_sources/src/hybrid.rs`.
    recencyHalflifeSecs: 30 * 24 * 60 * 60,
    // 0 means "let the Rust side pick 4× the requested limit" — same
    // semantic as the Rust default. We surface 0 here rather than a
    // hardcoded number so a future Rust-side default change
    // automatically applies without a config migration.
    candidatePoolSize: 0,
  });

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
 * captures the epoch (`1970-01-01`) so the "used since &lt;date&gt;"
 * label in `SettingsPage` displays a sentinel date for fresh
 * installs that have never been reset; `loadConfig` heals the
 * value into the persisted record on first read, so the stored
 * timestamp is stable across launches once the config file exists.
 *
 * Frozen (matches the sibling `DEFAULT_EXTERNAL_PROVIDER` /
 * `DEFAULT_HYBRID_SEARCH_CONFIG` pattern) so an accidental
 * mutation at one consumer can't silently corrupt every subsequent
 * `loadConfig()` baseline. Every consumer in this module already
 * spreads this constant (`{ ...DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE }`)
 * which produces a fresh mutable object, so freezing at the
 * declaration site is a no-op for read paths and a useful
 * tripwire for write paths. See the sibling block above
 * (lines 105-114) for the broader rationale.
 */
export const DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE: Readonly<ExternalProviderTokenUsage> =
  Object.freeze({
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    lastResetDate: new Date(0).toISOString(),
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
  pinnedArtifactIds: Object.freeze([]) as readonly string[] as string[],
  recentArtifactIds: Object.freeze([]) as readonly string[] as string[],
  sourcePaths: Object.freeze([]) as readonly string[] as string[],
  externalProvider: DEFAULT_EXTERNAL_PROVIDER,
  externalProviderTokenUsage: DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE,
  autoUpdate: true,
  onboardingCompleted: false,
  telemetryEnabled: false,
  appLockMode: "off",
  enforceUpdateSignature: true,
  enforceKeychainAcl: true,
  hybridSearchConfig: DEFAULT_HYBRID_SEARCH_CONFIG,
  modelIdleTimeoutSecs: DEFAULT_MODEL_IDLE_TIMEOUT_SECS,
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
    // per-install favorites. Same factory-style
    // `.catch(() => [])` as the sibling arrays above so a corrupted
    // value heals to an empty list instead of leaking a frozen
    // singleton across loads. Cap pulled from `MAX_PINNED_ARTIFACTS`
    // in `shared/types.ts` (single source of truth shared with the
    // IPC `SettingsUpdateSchema` and the renderer hook). PR #87: removed the previous "can't
    // import across project boundaries" caveat — this file already
    // imports `EXPORT_FORMATS`, `THEMES`, etc. from
    // `../shared/types`, so there is no actual obstacle.
    pinnedArtifactIds: z
      .array(z.string().max(1024))
      .max(MAX_PINNED_ARTIFACTS)
      .catch(() => []),
    // view-recency list. Cap pulled from
    // `MAX_RECENT_ARTIFACTS` in `shared/types.ts` (same source of
    // truth as the IPC `SettingsUpdateSchema` and the renderer
    // hook).
    recentArtifactIds: z
      .array(z.string().max(1024))
      .max(MAX_RECENT_ARTIFACTS)
      .catch(() => []),
    sourcePaths: z
      .array(z.string().max(4096))
      .max(10_000)
      .catch(() => []),
    externalProvider: ExternalProviderConfigOnDiskSchema,
    externalProviderTokenUsage: ExternalProviderTokenUsageOnDiskSchema,
    autoUpdate: z.boolean().catch(true),
    // telemetry toggle. Heals corrupted
    // values to `false` (opt-in default). The renderer toggle is
    // the only path to flip this to `true`, and `disableTelemetry`
    // in `telemetrySink.ts` truncates the on-disk JSONL when the
    // flag goes false so stale records do not survive a flip.
    telemetryEnabled: z.boolean().catch(false),
    // app-lock mode. Heals corrupted
    // values to `"off"` so a mangled config does NOT brick the
    // user out of the app on next launch. Real mode changes go
    // through the `appLock:setMode` IPC which validates the user
    // has set up a PIN before allowing `"pin"` / `"biometric"`.
    appLockMode: z.enum(APP_LOCK_MODES).catch("off"),
    // auto-updater Ed25519 enforcement.
    // Heals corrupted values to `true` (secure default). A user
    // running a self-hosted build channel with their own signing
    // key can disable via Settings; everyone else stays protected.
    enforceUpdateSignature: z.boolean().catch(true),
    // per-app keychain ACL enforcement.
    // Heals corrupted values to `true` (secure default). When on,
    // refuses to encrypt fresh secrets under Electron's Linux
    // `basic_text` fallback (XOR-with-hardcoded-key). macOS /
    // Windows are unaffected. See `electron/keychainAcl.ts` for the
    // policy implementation.
    enforceKeychainAcl: z.boolean().catch(true),
    // heal a corrupted on-disk value to `true` so a
    // mangled config does NOT replay the onboarding wizard against an
    // existing install. New installs always start at `false` via
    // `DEFAULT_CONFIG`, so the only path to this `.catch()` is a
    // corrupted persisted value — in which case the safe assumption
    // is "user has already been here".
    onboardingCompleted: z.boolean().catch(true),
    // persisted model idle-unload window. A
    // corrupted or out-of-range on-disk value heals to the documented
    // default (60 s) rather than dropping the user into a sidecar
    // that never unloads (which would silently strand a multi-GB
    // model in RAM after every call). The upper bound matches
    // `MAX_MODEL_IDLE_TIMEOUT_SECS` (24 h); anything past that is
    // effectively "never unload" already, but we cap to keep the
    // on-disk value bounded and to avoid `setInterval` overflow on
    // the sidecar side.
    modelIdleTimeoutSecs: z
      .number()
      .int()
      .min(0)
      .max(MAX_MODEL_IDLE_TIMEOUT_SECS)
      .catch(DEFAULT_MODEL_IDLE_TIMEOUT_SECS),
    // Hybrid search config — every field has a `.catch()` fallback
    // matching the documented Rust default so a partially-corrupted
    // entry still produces a usable config. Bounds match the
    // Rust-side validator in `HybridSearchConfig::apply_patch` so a
    // value that round-trips through disk → bridge can never trigger
    // a validation error on the bridge side.
    hybridSearchConfig: z
      .object({
        bm25Weight: z.number().finite().min(0).max(10).catch(1.0),
        vectorWeight: z.number().finite().min(0).max(10).catch(1.0),
        rrfK: z.number().finite().min(0.0001).max(1_000).catch(60.0),
        recencyDecayEnabled: z.boolean().catch(true),
        recencyHalflifeSecs: z
          .number()
          .finite()
          .min(1)
          .max(10 * 365 * 24 * 60 * 60) // 10 years
          .catch(30 * 24 * 60 * 60),
        candidatePoolSize: z.number().int().min(0).max(10_000).catch(0),
      })
      .loose()
      .catch(() => ({ ...DEFAULT_HYBRID_SEARCH_CONFIG })),
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
    // these three fields are also present in
    // `DEFAULT_CONFIG` (lines 236-238) and would resolve to the
    // same values via the spread, but we re-declare them
    // explicitly here as a security-critical floor. If a future
    // edit ever drifts `DEFAULT_CONFIG.telemetryEnabled` to `true`
    // or `DEFAULT_CONFIG.enforceUpdateSignature` to `false`, the
    // top-level `.catch()` (which fires when the on-disk JSON
    // fails the whole-schema parse) MUST still hand back a
    // privacy-safe, signature-enforcing config — anything less
    // would silently weaken the security posture on the recovery
    // path. Keep these three lines even though they look
    // redundant; they are the floor, not a duplicate.
    telemetryEnabled: false,
    appLockMode: "off" as const,
    enforceUpdateSignature: true,
    enforceKeychainAcl: true,
    hybridSearchConfig: { ...DEFAULT_HYBRID_SEARCH_CONFIG },
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
 * `electron/config.ts` (earlier) carried an explicit comment
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
      // Spread the persisted hybrid config over the defaults the same
      // way `externalProvider` does — if a user's on-disk file is
      // missing a newer subfield (forward compat with future versions
      // adding fields) the default fills the gap rather than leaving
      // `undefined` to crash downstream `bridge_update_hybrid_search_config`.
      const hybridSearchConfig: HybridSearchConfigPersisted = {
        ...DEFAULT_HYBRID_SEARCH_CONFIG,
        ...healed.hybridSearchConfig,
      };
      return {
        ...DEFAULT_CONFIG,
        ...healed,
        externalProvider,
        externalProviderTokenUsage,
        hybridSearchConfig,
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
    hybridSearchConfig: { ...DEFAULT_HYBRID_SEARCH_CONFIG },
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
 * **Merge semantics — read this before adding nested config types.**
 *
 * Top-level fields are shallow-merged via spread. Nested objects
 * are handled in two different ways depending on the field:
 *
 *  - `externalProvider` and `externalProviderTokenUsage` are
 *    *field-by-field* merged. Passing
 *    `updateConfig({ externalProvider: { enabled: true } })` only
 *    overwrites `enabled` (every other field — apiUrl, apiKeyRef,
 *    modelName, etc. — keeps its existing value), and similarly
 *    `updateConfig({ externalProviderTokenUsage: { totalPromptTokens
 *    : n } })` only touches that field. This is the behaviour the
 *    `model:generate`-finally-block accumulator and the
 *    `externalProvider:resetTokenUsage` handler rely on so they can
 *    write a single counter without re-reading the entire usage
 *    record. Each field-by-field-merged type needs its own dedicated
 *    branch in the implementation below (see the `mergedProvider` /
 *    `mergedUsage` destructure), so adding a new such type is an
 *    explicit change — there is no generic "merge if nested" path.
 *
 *  - **Every other nested object — including `hybridSearchConfig` —
 *    is REPLACED, not merged.** Passing
 *    `updateConfig({ hybridSearchConfig: { vectorWeight: 0.5 } })`
 *    would clobber `bm25Weight`, `rrfK`, `recencyDecayEnabled`,
 *    `recencyHalflifeSecs`, and `candidatePoolSize` to whatever the
 *    object literal omitted (which usually means `undefined` and
 *    then the schema-level defaults take over on reload). All
 *    production callers pass a **complete** `HybridSearchConfig`
 *    object so this is safe in practice, but a future caller
 *    writing `updateConfig({ hybridSearchConfig: { vectorWeight }})`
 *    would silently reset everything else. The IPC handler at
 *    `ipc/settings.ts:settings:updateHybridSearchConfig` always
 *    composes a complete object before calling `updateConfig`, so
 *    it is the canonical pattern.
 *
 *    If you ever add a callsite that needs a partial update for a
 *    nested object outside the explicit field-by-field set
 *    (`externalProvider`, `externalProviderTokenUsage`), either
 *    (a) extend the merge logic below to handle the new field with
 *    its own dedicated branch, or (b) compose the full object at
 *    the call site before calling `updateConfig`. **Do not** rely
 *    on spread-style partial updates working — they only work for
 *    the explicit field-by-field-merged types listed above.
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
