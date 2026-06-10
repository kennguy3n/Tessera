/**
 * Tessera model management.
 *
 * Responsibilities:
 *   - Platform / RAM / GPU detection (mirrors crates/tessera_runtime/src/config.rs).
 *   - Reading the shipped sidecars/models.json manifest.
 *   - Recommending exactly one model per device.
 *   - Enforcing single-model storage on disk: at most one model file lives in
 *     the model cache directory at any time. Swap = delete-then-download.
 *
 * Detection is best-effort; results are passed to the renderer so the user
 * sees what acceleration paths are available and so the correct llama-server
 * binary variant can be downloaded. The PrismML llama.cpp fork's dispatcher
 * picks the actual CPU kernel at runtime — the renderer doesn't need to know
 * which AVX flavor won.
 */

import { execFileSync } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as tar from "tar";

export type Platform =
  | "macos-apple-silicon"
  | "macos-intel"
  | "windows-x64"
  | "linux-x64"
  | "linux-arm64";

export type ModelFormat = "gguf" | "mlx";
export type ComputeBackend = "cpu" | "cuda" | "vulkan" | "metal" | "rocm";
export type DeviceTier = "low" | "medium" | "high";

/**
 * Per-capability model slot. Tessera installs one model on disk per
 * capability per device.
 *
 * Mirrors `ModelCapability` in `crates/tessera_runtime/src/config.rs`
 * — both encodings use the same lowercase string form on the wire
 * (manifest JSON, per-slot active-record filename, IPC payloads).
 */
export type ModelCapability = "text" | "vision" | "imagegen";

/**
 * Enumeration of every capability slot, in the order the multi-slot
 * Settings UI renders sections. Iterated by `getInstalledModels` and
 * by the legacy-flat-layout migration so a new slot variant only
 * has to be added in one place.
 */
export const ALL_MODEL_CAPABILITIES: readonly ModelCapability[] = [
  "text",
  "vision",
  "imagegen",
] as const;

export interface ManifestModel {
  id: string;
  name: string;
  parameters: string;
  /**
   * Slot this model occupies. Manifest entries written before the
   * multi-capability era have no `capability` field; the loader
   * defaults them to `"text"` (the only slot that existed at the
   * time) so older builds keep parsing.
   */
  capability?: ModelCapability;
  format: ModelFormat;
  quantization: string;
  platform: string; // raw manifest string, includes wildcards
  compute: ComputeBackend[];
  tier: DeviceTier;
  downloadSizeMb: number;
  diskSizeMb: number;
  requiredRamGb: number;
  contextLength: number;
  filename: string;
  url: string;
  sha256: string | null;
  /**
   * Multimodal projector (mmproj) descriptor for vision-GGUF entries.
   *
   * llama-server needs both the language-model weights AND a separate
   * mmproj file (the vision tower projection) to load a VLM. The two
   * files are downloaded together and stored side-by-side in
   * `models/vision/`; `--mmproj <path>` is passed to the vision
   * sidecar at startup.
   *
   * Absent on text entries (no projector) and on imagegen entries
   * (diffusion has no mmproj concept). Also absent on MLX vision
   * entries — the MLX archive bundles its projector internally, so
   * no second download is required.
   *
   * `mmprojFilename` + `mmprojUrl` are required together; setting
   * only one is a manifest-load error. `mmprojSha256` follows the
   * same null-means-skip-verification convention as the main `sha256`
   * field. `mmprojSizeMb` is what the Settings UI shows for projector
   * footprint and what `plan_download` uses for disk-space planning.
   */
  mmprojFilename?: string;
  mmprojUrl?: string;
  mmprojSha256?: string | null;
  mmprojSizeMb?: number;
}

export interface ManifestLlamaServerVariant {
  platform: Platform;
  compute: ComputeBackend;
  url: string;
  sha256: string | null;
}

export interface ManifestLlamaServer {
  version: string;
  note?: string;
  variants: ManifestLlamaServerVariant[];
}

/**
 * Diffusion-server (sd-server, leejet/stable-diffusion.cpp) binary
 * descriptor. Parallel shape to `ManifestLlamaServer` — same
 * variant-by-(platform, compute) selection, same nullable `sha256`
 * for skip-verify-when-null semantics, separate `version` tag so
 * llama-server and sd-server can be bumped independently.
 *
 * The variants list deliberately omits any `"cpu"` entries: sd-server
 * builds for CPU exist upstream, but minutes-per-step throughput
 * makes them unfit for an interactive product. The
 * `is_capability_available` gating in `crates/tessera_runtime/src/config.rs`
 * refuses to surface imagegen on CPU-only devices anyway, so omitting
 * the CPU sd-server variant keeps the failure mode "no binary to
 * download" rather than "binary downloads, GPU absent, hangs".
 */
export interface ManifestDiffusionServerVariant {
  platform: Platform;
  compute: ComputeBackend;
  url: string;
  sha256: string | null;
}

export interface ManifestDiffusionServer {
  version: string;
  note?: string;
  variants: ManifestDiffusionServerVariant[];
}

export interface ModelManifest {
  format_version: number;
  note?: string;
  models: ManifestModel[];
  llama_server?: ManifestLlamaServer;
  diffusion_server?: ManifestDiffusionServer;
}

export interface PlatformInfo {
  platform: Platform;
  platformLabel: string;
  totalRamGb: number;
  tier: DeviceTier;
  tierLabel: string;
  computeBackends: ComputeBackend[];
  preferredFormat: ModelFormat;
}

export interface ResolvedModel {
  id: string;
  name: string;
  parameters: string;
  /**
   * Slot this model occupies. Always populated for `ResolvedModel`
   * — the manifest loader fills in `"text"` for legacy entries
   * before they reach this shape.
   */
  capability: ModelCapability;
  format: ModelFormat;
  formatLabel: string;
  quantization: string;
  platform: Platform;
  tier: DeviceTier;
  computeBackends: ComputeBackend[];
  downloadSizeMb: number;
  diskSizeMb: number;
  requiredRamGb: number;
  contextLength: number;
  filename: string;
  url: string;
  sha256: string | null;
  /**
   * Mirror of `ManifestModel.mmprojFilename` / `mmprojUrl` /
   * `mmprojSha256` / `mmprojSizeMb`. Populated for vision-GGUF
   * entries; absent elsewhere.
   */
  mmprojFilename?: string;
  mmprojUrl?: string;
  mmprojSha256?: string | null;
  mmprojSizeMb?: number;
}

export interface InstalledModelRecord {
  modelId: string;
  /**
   * Slot the installed model occupies. Records persisted before
   * multi-slot model storage was introduced have no `capability`
   * field and are interpreted as `"text"` by readers (see
   * `recordCapability` below). Kept optional here so the type
   * matches legacy on-disk records.
   */
  capability?: ModelCapability;
  format: ModelFormat;
  filename: string;
  path: string;
  downloadSizeMb: number;
  // Records written before `diskSizeMb` was introduced won't have this
  // field. Read via `effectiveDiskSizeMb(record)` so the swap accounting
  // stays correct for legacy installs.
  diskSizeMb?: number;
  sha256: string | null;
  /**
   * Absolute on-disk path of the multimodal projector for vision
   * GGUF installs. Set at download time when the manifest entry
   * carried `mmprojFilename` + `mmprojUrl`; consumed by the vision
   * sidecar at startup (`--mmproj <mmprojPath>`).
   *
   * Always absent on text / imagegen / MLX-vision records.
   */
  mmprojPath?: string;
  mmprojSha256?: string | null;
  /**
   * On-disk footprint of the projector file alone. Surfaced in the
   * Settings UI per-slot disk-usage display so users see the true
   * cost of the vision slot (weights + projector).
   */
  mmprojSizeMb?: number;
  downloadedAt: string;
}

/**
 * Aggregate snapshot of every per-capability slot's installed record.
 * Slots with no model installed map to `null`.
 */
export type InstalledModelsByCapability = Record<
  ModelCapability,
  InstalledModelRecord | null
>;

/**
 * Resolve the capability slot of an installed record, defaulting to
 * `"text"` when the field is absent (legacy single-slot install).
 * Centralised so every consumer agrees on the same fallback.
 */
export function recordCapability(
  record: InstalledModelRecord,
): ModelCapability {
  return record.capability ?? "text";
}

/**
 * Disk-size accessor that tolerates legacy records.
 *
 * Records persisted before the `diskSizeMb` field was added (or where
 * the field was serialised as 0) fall back to `downloadSizeMb`. This
 * mirrors Rust's `InstalledModel::effective_disk_size_mb` so the swap
 * planner returns consistent values on both sides of the bridge.
 */
export function effectiveDiskSizeMb(record: InstalledModelRecord): number {
  const ds = record.diskSizeMb;
  if (typeof ds !== "number" || !Number.isFinite(ds) || ds <= 0) {
    return record.downloadSizeMb;
  }
  return ds;
}

export interface SwapDecision {
  kind: "swap";
  evictModelId: string;
  evictFilename: string;
  evictSizeMb: number;
  installModelId: string;
  installFilename: string;
  installSizeMb: number;
  netDiskDeltaMb: number;
  message: string;
}

export type DownloadPlan =
  | { kind: "already-installed"; modelId: string }
  | {
      kind: "direct-download";
      modelId: string;
      filename: string;
      downloadSizeMb: number;
      message: string;
    }
  | SwapDecision;

// --- Platform detection -------------------------------------------------

export function detectPlatform(): Platform {
  const arch = os.arch();
  switch (process.platform) {
    case "darwin":
      return arch === "arm64" ? "macos-apple-silicon" : "macos-intel";
    case "win32":
      return "windows-x64";
    case "linux":
      // Node's `os.arch()` returns `"arm64"` (not the kernel string
      // `"aarch64"`) on aarch64 systems, so only the `"arm64"` branch is
      // reachable here. See https://nodejs.org/api/os.html#osarch.
      return arch === "arm64" ? "linux-arm64" : "linux-x64";
    default:
      return "linux-x64";
  }
}

export function platformLabel(p: Platform): string {
  switch (p) {
    case "macos-apple-silicon":
      return "macOS Apple Silicon";
    case "macos-intel":
      return "macOS Intel";
    case "windows-x64":
      return "Windows x64";
    case "linux-x64":
      return "Linux x64";
    case "linux-arm64":
      return "Linux arm64";
  }
}

export function preferredFormatFor(p: Platform): ModelFormat {
  return p === "macos-apple-silicon" ? "mlx" : "gguf";
}

export function totalRamGb(): number {
  // Node's os.totalmem is consistent across platforms; the Rust side uses
  // platform-native APIs because it can't depend on Node.
  return os.totalmem() / (1024 * 1024 * 1024);
}

export function tierForRamGb(ramGb: number): DeviceTier {
  if (ramGb >= 8.0) return "high";
  if (ramGb >= 4.0) return "medium";
  return "low";
}

export function tierLabel(t: DeviceTier): string {
  switch (t) {
    case "low":
      return "Low (2-3 GB RAM)";
    case "medium":
      return "Medium (4-6 GB RAM)";
    case "high":
      return "High (8+ GB RAM)";
  }
}

function commandExists(cmd: string, args: string[] = ["-L"]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

// Cached hardware-detection results. Hardware doesn't change at runtime, so we
// pay the (up to ~3s) cost of `execFileSync(nvidia-smi)` / `vulkaninfo` /
// `/opt/rocm` lookups exactly once per Electron main process — subsequent
// `detectPlatformInfo()` calls (triggered by every model IPC) return instantly
// instead of blocking the event loop for several seconds.
let cachedHasNvidiaGpu: boolean | null = null;
let cachedHasVulkan: boolean | null = null;
let cachedHasRocm: boolean | null = null;
let cachedComputeBackends: ComputeBackend[] | null = null;

export function hasNvidiaGpu(): boolean {
  if (cachedHasNvidiaGpu !== null) return cachedHasNvidiaGpu;
  const cmd = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
  cachedHasNvidiaGpu = commandExists(cmd);
  return cachedHasNvidiaGpu;
}

export function hasVulkan(): boolean {
  if (cachedHasVulkan !== null) return cachedHasVulkan;
  if (commandExists("vulkaninfo", ["--summary"])) {
    cachedHasVulkan = true;
    return cachedHasVulkan;
  }
  // Keep this candidate set in lock-step with `has_vulkan` in
  // `crates/tessera_runtime/src/config.rs`. The TS detection (used by the
  // Electron renderer's PlatformInfo card) and the Rust detection (used by
  // the inference router) must reach the same verdict on the same host —
  // otherwise the UI shows "Vulkan available" while the runtime refuses
  // to dispatch to it (or vice-versa). On Linux the canonical set is
  // every multiarch path that ships the loader from a packaged distro:
  // both `/usr/lib/...` (Debian/Ubuntu standard) AND `/lib/...` (some
  // older / minimal distros and merged-/usr systems where /lib is the
  // primary).
  const candidates =
    process.platform === "linux"
      ? [
          "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
          // Linux arm64 (Debian/Ubuntu multiarch path). Without this entry
          // Vulkan is undetectable on headless aarch64 hosts where the
          // loader is installed but `vulkaninfo` is not — and aarch64 is
          // a first-class Tessera target.
          "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
          "/usr/lib64/libvulkan.so.1",
          "/usr/lib/libvulkan.so.1",
          // Merged-/usr / minimal-distro multiarch paths. Mirror the Rust
          // side's `/lib/x86_64-linux-gnu` and `/lib/aarch64-linux-gnu`
          // candidates so the TS and Rust detectors can't disagree.
          "/lib/x86_64-linux-gnu/libvulkan.so.1",
          "/lib/aarch64-linux-gnu/libvulkan.so.1",
        ]
      : process.platform === "win32"
        ? ["C:\\Windows\\System32\\vulkan-1.dll"]
        : process.platform === "darwin"
          ? ["/usr/local/lib/libvulkan.dylib", "/opt/homebrew/lib/libvulkan.dylib"]
          : [];
  cachedHasVulkan = candidates.some((p) => fs.existsSync(p));
  return cachedHasVulkan;
}

export function hasRocm(): boolean {
  if (cachedHasRocm !== null) return cachedHasRocm;
  if (process.platform !== "linux") {
    cachedHasRocm = false;
    return cachedHasRocm;
  }
  cachedHasRocm = fs.existsSync("/opt/rocm") || fs.existsSync("/opt/rocm-dkms");
  return cachedHasRocm;
}

export function detectComputeBackends(): ComputeBackend[] {
  if (cachedComputeBackends !== null) return cachedComputeBackends.slice();
  const backends: ComputeBackend[] = ["cpu"];
  const p = detectPlatform();
  if (p === "macos-apple-silicon") backends.push("metal");
  if (hasNvidiaGpu()) backends.push("cuda");
  if (hasVulkan()) backends.push("vulkan");
  if (hasRocm()) backends.push("rocm");
  cachedComputeBackends = backends;
  // ALWAYS return a copy — both on the cold first call and on every cached
  // hit. Returning `backends` directly here would have leaked a mutable
  // reference to the cached array, while subsequent calls returned
  // independent copies via `cachedComputeBackends.slice()`. No caller
  // mutates the result today (it flows into `PlatformInfo` which is
  // structured-cloned to the renderer over IPC), but the asymmetry was
  // an invariant violation waiting to bite a future maintainer who
  // adds a `.push("…")` to the returned value.
  return cachedComputeBackends.slice();
}

/**
 * Reset cached hardware-detection results. Intended for tests so each test
 * starts from a clean slate; production callers should never need this since
 * hardware doesn't change between calls.
 */
export function resetHardwareDetectionCache(): void {
  cachedHasNvidiaGpu = null;
  cachedHasVulkan = null;
  cachedHasRocm = null;
  cachedComputeBackends = null;
}

export function detectPlatformInfo(): PlatformInfo {
  const platform = detectPlatform();
  const ram = totalRamGb();
  const tier = tierForRamGb(ram);
  return {
    platform,
    platformLabel: platformLabel(platform),
    totalRamGb: ram,
    tier,
    tierLabel: tierLabel(tier),
    computeBackends: detectComputeBackends(),
    preferredFormat: preferredFormatFor(platform),
  };
}

// --- Manifest loading & filtering ---------------------------------------

let cachedManifest: { path: string; manifest: ModelManifest } | null = null;

/**
 * Optional injection point for {@link manifestPath} and
 * {@link loadManifest}. Production code calls these with no `opts`
 * and gets the documented env-driven precedence (which is preserved
 * by the default `readEnv` closure that reads `process.env`
 * directly). Tests pass an explicit `manifestPath` or `readEnv` so
 * they don't have to mutate `process.env.TESSERA_MODELS_MANIFEST` —
 * mutating a process-level global is sequential-only under shared
 * vitest worker pools (race-prone under `--pool=threads`), and a
 * crash between the mutate-and-restore window leaks the override
 * into every subsequent test in the worker. Same architectural
 * pattern as PR #57 (`ExtensionSocketDiscovery`), PR #59
 * (`vaultCrypto` / `sidecar` platform injection), and PR #61
 * (`ssrfGuard` `allowInternal` / `readEnv`).
 */
export interface ManifestPathOptions {
  /**
   * Optional explicit manifest path. When supplied, completely
   * bypasses the env-var / resourcesPath / cwd fallback chain and
   * returns this value verbatim. Tests set this to a fixture path
   * (real `MANIFEST` constant or a tempdir-allocated path with a
   * bad fixture) without mutating `process.env`. When `undefined`,
   * the env-and-fallback chain runs as before.
   */
  manifestPath?: string;
  /**
   * Optional env-var reader. Defaults to `(name) => process.env[name]`
   * so production callers stay unchanged. Tests pass an explicit
   * reader to verify the env-var precedence branch without
   * mutating `process.env` globally (parallel-safe under shared
   * vitest worker pools). The reader is only invoked on the
   * `manifestPath=undefined` branch — an explicit string
   * short-circuits it.
   */
  readEnv?: (name: string) => string | undefined;
}

/**
 * `loadManifest` has the same dependency-injection surface as
 * `resolveManifestPath` — no additional fields today. Declared as a
 * type alias (not an empty extending interface) so the @typescript-eslint
 * v8 `no-empty-object-type` rule isn't violated; if a future revision
 * adds fields specific to the load step (e.g. a checksum-validation
 * toggle), convert this back to an interface that extends
 * `ManifestPathOptions` and adds them.
 */
export type LoadManifestOptions = ManifestPathOptions;

/**
 * Locate the manifest. Order:
 *   1. `opts.manifestPath` (tests pass explicit paths here).
 *   2. `TESSERA_MODELS_MANIFEST` via `opts.readEnv` (defaults to
 *      reading `process.env` — tests, dev override).
 *   3. <resources>/sidecars/models.json (packaged app).
 *   4. <cwd>/sidecars/models.json (npm run dev).
 *
 * Production callers (no `opts`) get the documented env-driven
 * precedence unchanged because `readEnv` defaults to a closure
 * over `process.env`.
 */
export function manifestPath(opts?: ManifestPathOptions): string {
  // Nullish coalescing semantics: an explicit `manifestPath` string
  // short-circuits ahead of the env check, so a test fixture path
  // is honoured even when the env var happens to be set in the
  // ambient shell.
  if (opts?.manifestPath !== undefined) {
    return opts.manifestPath;
  }
  const readEnv = opts?.readEnv ?? ((name: string) => process.env[name]);
  const envPath = readEnv("TESSERA_MODELS_MANIFEST");
  if (envPath) {
    return envPath;
  }
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (resourcesPath) {
    const candidate = path.join(resourcesPath, "sidecars", "models.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(process.cwd(), "sidecars", "models.json");
}

const KNOWN_PLATFORMS: ReadonlySet<Platform> = new Set([
  "macos-apple-silicon",
  "macos-intel",
  "windows-x64",
  "linux-x64",
  "linux-arm64",
]);

const KNOWN_COMPUTE_BACKENDS: ReadonlySet<ComputeBackend> = new Set([
  "cpu",
  "cuda",
  "vulkan",
  "metal",
  "rocm",
]);

/**
 * Type guard: returns the input typed as `Platform` iff it is one of
 * the five known platform literals, otherwise `null`. Used by
 * `loadManifest` to fail fast on unrecognised platform strings instead
 * of silently letting them flow through to `pickLlamaServerVariant`'s
 * `===` check where they would always miss with a confusing
 * "no variant for this platform" error that's indistinguishable from a
 * missing-entry bug.
 */
export function parsePlatform(s: string): Platform | null {
  return (KNOWN_PLATFORMS as ReadonlySet<string>).has(s)
    ? (s as Platform)
    : null;
}

export function parseComputeBackend(s: string): ComputeBackend | null {
  return (KNOWN_COMPUTE_BACKENDS as ReadonlySet<string>).has(s)
    ? (s as ComputeBackend)
    : null;
}

const KNOWN_MODEL_CAPABILITIES: ReadonlySet<ModelCapability> = new Set([
  "text",
  "vision",
  "imagegen",
]);

/**
 * Type-guard parser for capability strings. Returns `null` on
 * unknown values so the manifest validator can produce a precise
 * diagnostic (rather than letting a typo like `"image-gen"` flow
 * through to filtering, where it would silently match nothing).
 */
export function parseModelCapability(s: string): ModelCapability | null {
  return (KNOWN_MODEL_CAPABILITIES as ReadonlySet<string>).has(s)
    ? (s as ModelCapability)
    : null;
}

/**
 * Resolve a manifest entry's declared capability, defaulting to
 * `"text"` when the field is absent. Centralised so the Rust serde
 * `default = "text"` decision and the TS loader stay in lock-step.
 */
export function manifestCapability(entry: ManifestModel): ModelCapability {
  return entry.capability ?? "text";
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

/**
 * Validate the runtime shape of a parsed manifest. We focus on the
 * enum-typed fields on the `llama_server` variants — those go through
 * a `===` lookup against `Platform` / `ComputeBackend` literals and
 * would silently return `null` on an unknown value, which is the
 * type-safety gap this validator closes. Returns the manifest
 * unchanged on success; throws `ManifestValidationError` on failure so
 * the caller's `loadManifest` propagates a clear error instead of
 * caching a half-valid object.
 */
const KNOWN_MODEL_FORMATS: ReadonlySet<ModelFormat> = new Set([
  "gguf",
  "mlx",
]);

const KNOWN_DEVICE_TIERS: ReadonlySet<DeviceTier> = new Set([
  "low",
  "medium",
  "high",
]);

// Manifest `models[].platform` accepts either a concrete Platform literal
// OR the special wildcard `"any-non-apple-silicon"` which `resolveManifestPlatform`
// expands to every non-MLX platform. The wildcard is checked in addition to
// the KNOWN_PLATFORMS set so a typo like `"any-non-applesilicon"` still trips
// validation.
const MANIFEST_PLATFORM_WILDCARDS: ReadonlySet<string> = new Set([
  "any-non-apple-silicon",
]);

function isValidManifestPlatform(s: string): boolean {
  return (
    parsePlatform(s) !== null || MANIFEST_PLATFORM_WILDCARDS.has(s)
  );
}

function validateManifest(manifest: ModelManifest): ModelManifest {
  const errors: string[] = [];
  // Track per-(format, platform, tier, capability) keys so a stray
  // duplicate entry is rejected at load time rather than silently
  // shadowing the first match in `recommendModel`/`listModelsForPlatform`.
  // Capability is part of the key because the same platform/tier may
  // legitimately host a text *and* a vision *and* an imagegen entry.
  const dupKeys = new Map<string, number>();
  const server = manifest.llama_server;
  if (server) {
    for (let i = 0; i < server.variants.length; i += 1) {
      const v = server.variants[i];
      if (!parsePlatform(v.platform as unknown as string)) {
        errors.push(
          `llama_server.variants[${i}].platform="${String(
            v.platform,
          )}" is not one of: ${Array.from(KNOWN_PLATFORMS).join(", ")}`,
        );
      }
      if (!parseComputeBackend(v.compute as unknown as string)) {
        errors.push(
          `llama_server.variants[${i}].compute="${String(
            v.compute,
          )}" is not one of: ${Array.from(KNOWN_COMPUTE_BACKENDS).join(", ")}`,
        );
      }
    }
  }
  const diffusion = manifest.diffusion_server;
  if (diffusion) {
    for (let i = 0; i < diffusion.variants.length; i += 1) {
      const v = diffusion.variants[i];
      if (!parsePlatform(v.platform as unknown as string)) {
        errors.push(
          `diffusion_server.variants[${i}].platform="${String(
            v.platform,
          )}" is not one of: ${Array.from(KNOWN_PLATFORMS).join(", ")}`,
        );
      }
      const compute = parseComputeBackend(v.compute as unknown as string);
      if (!compute) {
        errors.push(
          `diffusion_server.variants[${i}].compute="${String(
            v.compute,
          )}" is not one of: ${Array.from(KNOWN_COMPUTE_BACKENDS).join(", ")}`,
        );
      } else if (compute === "cpu") {
        // sd-server on CPU is a real upstream target, but minutes-per-step
        // throughput makes it unfit for an interactive product. The
        // `is_capability_available` gating refuses to surface imagegen
        // on CPU-only hosts anyway, so a CPU sd-server variant in the
        // manifest is almost always a misconfiguration; reject at load
        // time rather than letting `pickDiffusionServerVariant` happily
        // hand it out.
        errors.push(
          `diffusion_server.variants[${i}].compute="cpu" is not allowed — diffusion is GPU-only by design.`,
        );
      }
    }
  }
  // Validate `models[]` entries :
  // an unknown `format` is mitigated downstream by `listModelsForPlatform`'s
  // `m.format !== preferred` filter, but an unknown `tier` would silently
  // drop the model from `recommendModel` results and an unknown `platform`
  // would silently produce zero matches in `resolveManifestPlatform`.
  // Fail fast at load time so typos like `"tier": "hig"` surface as a
  // precise diagnostic at app startup instead of as a confusing
  // "no recommended model" later.
  for (let i = 0; i < manifest.models.length; i += 1) {
    const m = manifest.models[i];
    if (!(KNOWN_MODEL_FORMATS as ReadonlySet<string>).has(m.format)) {
      errors.push(
        `models[${i}].format="${String(m.format)}" is not one of: ${Array.from(
          KNOWN_MODEL_FORMATS,
        ).join(", ")}`,
      );
    }
    if (!(KNOWN_DEVICE_TIERS as ReadonlySet<string>).has(m.tier)) {
      errors.push(
        `models[${i}].tier="${String(m.tier)}" is not one of: ${Array.from(
          KNOWN_DEVICE_TIERS,
        ).join(", ")}`,
      );
    }
    if (typeof m.platform !== "string" || !isValidManifestPlatform(m.platform)) {
      errors.push(
        `models[${i}].platform="${String(
          m.platform,
        )}" is not one of: ${Array.from(KNOWN_PLATFORMS).join(", ")}, ${Array.from(
          MANIFEST_PLATFORM_WILDCARDS,
        ).join(", ")}`,
      );
    }
    if (!Array.isArray(m.compute)) {
      errors.push(
        `models[${i}].compute must be an array of compute backends, got ${typeof m.compute}`,
      );
    } else {
      for (let j = 0; j < m.compute.length; j += 1) {
        if (!parseComputeBackend(m.compute[j] as unknown as string)) {
          errors.push(
            `models[${i}].compute[${j}]="${String(
              m.compute[j],
            )}" is not one of: ${Array.from(KNOWN_COMPUTE_BACKENDS).join(", ")}`,
          );
        }
      }
    }
    // Capability defaults to "text" when absent (legacy entries); if
    // present it MUST be a known capability or the loader rejects
    // it. The validator runs before `manifestCapability` is consulted
    // anywhere else, so a typo ("image-gen") fails fast with a clear
    // message instead of silently dropping the entry from
    // `available_models_for_capability` results downstream.
    if (
      m.capability !== undefined &&
      !parseModelCapability(m.capability as unknown as string)
    ) {
      errors.push(
        `models[${i}].capability="${String(
          m.capability,
        )}" is not one of: ${Array.from(KNOWN_MODEL_CAPABILITIES).join(", ")}`,
      );
    }
    // Imagegen entries must NOT advertise a CPU backend — diffusion
    // on CPU is too slow to be a real product path and the runtime
    // refuses to dispatch to it. Catching this in manifest validation
    // means a manifest update that accidentally widens compute to
    // include "cpu" for an imagegen entry surfaces immediately at app
    // startup rather than after a user tries to generate an image.
    if (
      m.capability === "imagegen" &&
      Array.isArray(m.compute) &&
      m.compute.includes("cpu")
    ) {
      errors.push(
        `models[${i}].compute must not include "cpu" for imagegen entries (id=${String(
          m.id,
        )}) — diffusion is GPU-only by registry design.`,
      );
    }
    // mmproj fields: must be present together on vision-GGUF entries,
    // and absent on every other (capability, format) combination. The
    // vision sidecar needs `--mmproj <path>` to load the projection
    // tower; without it the model loads as text-only and a vision
    // request hangs forever waiting for an image embedding the
    // sidecar can't produce. Failing fast here keeps misconfiguration
    // visible at app startup rather than producing a runtime
    // mystery.
    const hasMmprojFilename =
      typeof m.mmprojFilename === "string" && m.mmprojFilename.length > 0;
    const hasMmprojUrl = typeof m.mmprojUrl === "string" && m.mmprojUrl.length > 0;
    if (hasMmprojFilename !== hasMmprojUrl) {
      errors.push(
        `models[${i}] has mismatched mmproj descriptor: mmprojFilename=${hasMmprojFilename}, mmprojUrl=${hasMmprojUrl}. Both must be present together.`,
      );
    }
    const cap = (m.capability as ModelCapability | undefined) ?? "text";
    const isVisionGguf = cap === "vision" && m.format === "gguf";
    if (isVisionGguf && !hasMmprojFilename) {
      errors.push(
        `models[${i}] is a vision-GGUF entry (id=${String(m.id)}) but is missing mmprojFilename/mmprojUrl. llama-server requires --mmproj to load a VLM.`,
      );
    }
    if (!isVisionGguf && hasMmprojFilename) {
      errors.push(
        `models[${i}] (id=${String(m.id)}, capability=${cap}, format=${m.format}) carries mmproj fields, but mmproj is only valid for vision-GGUF entries. Drop mmprojFilename/mmprojUrl/mmprojSha256/mmprojSizeMb.`,
      );
    }
    // mmprojSizeMb is REQUIRED when an mmproj URL is present.
    //
    // The download-progress math in `downloadModelLocked` builds a
    // combined byte total from `mainBytes + (mmprojSizeMb ?? 0) *
    // MiB` and reports per-fetcher progress as a single monotonic
    // 0..100% sweep across both files. When `mmprojSizeMb` is
    // omitted, the `?? 0` fallback makes the combined total equal
    // to `mainBytes` while the mmproj fetcher still writes real
    // bytes on top — so the cumulative progress sails past 100%
    // during the projector download (e.g. 107% for SmolVLM's
    // 190 MB projector on a 150 MB main weights file).
    //
    // Requiring a positive `mmprojSizeMb` alongside the URL closes
    // both the progress bug AND the Settings-UI disk-usage report
    // (which sums per-slot bytes — without the field the vision
    // slot underreports by the projector's footprint).
    //
    // Allowing 0 here would let a future shipper declare a
    // zero-byte projector, which would also break the progress
    // math (denominator would still be `mainBytes`, identical to
    // the omitted-field case). Reject that too.
    if (hasMmprojFilename) {
      if (m.mmprojSizeMb === undefined) {
        errors.push(
          `models[${i}] (id=${String(m.id)}) is a vision-GGUF entry with mmprojFilename/mmprojUrl but is missing mmprojSizeMb. Download progress reporting requires the projector size in MB.`,
        );
      } else if (
        typeof m.mmprojSizeMb !== "number" ||
        !Number.isFinite(m.mmprojSizeMb) ||
        m.mmprojSizeMb <= 0
      ) {
        errors.push(
          `models[${i}].mmprojSizeMb="${String(m.mmprojSizeMb)}" must be a positive finite number (id=${String(m.id)}).`,
        );
      }
    }
    // Detect duplicate (format, platform, tier, capability) tuples —
    // these would otherwise silently shadow each other in
    // `listModelsForPlatform`/`recommendModel`. Capability is part of
    // the key so the multi-slot manifest legitimately has the same
    // (format, platform, tier) reused once per capability slot.
    if (
      typeof m.format === "string" &&
      typeof m.platform === "string" &&
      typeof m.tier === "string"
    ) {
      // Reuse the `cap` resolved above for the mmproj checks; same
      // legacy-default ("text" when absent) semantics apply here.
      const key = `${m.format}|${m.platform}|${m.tier}|${cap}`;
      const prevIndex = dupKeys.get(key);
      if (prevIndex !== undefined) {
        errors.push(
          `models[${i}] duplicates the (format, platform, tier, capability) tuple of models[${prevIndex}]: ${key}`,
        );
      } else {
        dupKeys.set(key, i);
      }
    }
  }
  if (errors.length > 0) {
    throw new ManifestValidationError(
      `models.json failed validation:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return manifest;
}

/**
 * Load and validate the manifest. See {@link ManifestPathOptions}
 * for the parallel-safe test-injection contract; production callers
 * pass no `opts` and get the env-driven default unchanged. The
 * path-keyed cache works correctly across calls with different
 * `opts.manifestPath` values (cache miss on path change, hit on
 * repeat), so injection does not silently retain stale parses
 * between fixtures — tests that *replace* a fixture file in place
 * at the same path should still call {@link resetManifestCache}
 * before re-loading.
 */
export function loadManifest(
  forceReload = false,
  opts?: LoadManifestOptions,
): ModelManifest {
  const p = manifestPath(opts);
  if (!forceReload && cachedManifest && cachedManifest.path === p) {
    return cachedManifest.manifest;
  }
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as ModelManifest;
  const manifest = validateManifest(parsed);
  cachedManifest = { path: p, manifest };
  return manifest;
}

export function resolveManifestPlatform(
  manifestPlatform: string,
  target: Platform,
): Platform | null {
  if (manifestPlatform === target) return target;
  if (manifestPlatform === "any-non-apple-silicon") {
    return target === "macos-apple-silicon" ? null : target;
  }
  return null;
}

/**
 * Human-readable "{Format} {Quantization}" label for the renderer's
 * model card. Derived from the manifest entry rather than hardcoded
 * because each capability ships its own quantization scheme:
 *
 *   Bonsai text:    GGUF Q1_0_g128 / MLX 2-bit
 *   Qwen3.5 vision: GGUF Q4_K_M   / MLX 4-bit
 *   SmolVLM vision: GGUF Q4_K_S   / MLX 4-bit
 *   FLUX imagegen:  GGUF Q4_0     / MLX 4-bit
 *
 * Hardcoding the text labels (the pre-Block-A behaviour) would have
 * mislabelled every non-text entry in the Settings UI.
 */
function formatLabel(entry: ManifestModel): string {
  const fmt = entry.format === "mlx" ? "MLX" : "GGUF";
  return `${fmt} ${entry.quantization}`;
}

function toResolvedModel(entry: ManifestModel, target: Platform): ResolvedModel {
  const resolved: ResolvedModel = {
    id: entry.id,
    name: entry.name,
    parameters: entry.parameters,
    capability: manifestCapability(entry),
    format: entry.format,
    formatLabel: formatLabel(entry),
    quantization: entry.quantization,
    platform: target,
    tier: entry.tier,
    computeBackends: entry.compute,
    downloadSizeMb: entry.downloadSizeMb,
    diskSizeMb: entry.diskSizeMb,
    requiredRamGb: entry.requiredRamGb,
    contextLength: entry.contextLength,
    filename: entry.filename,
    url: entry.url,
    sha256: entry.sha256,
  };
  // Propagate mmproj descriptor to the resolved shape only when the
  // manifest carried it (vision-GGUF entries). Leaving these fields
  // undefined on text/imagegen/MLX-vision keeps the wire shape and
  // every downstream `if (resolved.mmprojUrl)` check truthy-clean.
  if (entry.mmprojFilename !== undefined) {
    resolved.mmprojFilename = entry.mmprojFilename;
  }
  if (entry.mmprojUrl !== undefined) {
    resolved.mmprojUrl = entry.mmprojUrl;
  }
  if (entry.mmprojSha256 !== undefined) {
    resolved.mmprojSha256 = entry.mmprojSha256;
  }
  if (entry.mmprojSizeMb !== undefined) {
    resolved.mmprojSizeMb = entry.mmprojSizeMb;
  }
  return resolved;
}

/**
 * Resolve every manifest entry compatible with `target`, optionally
 * filtered to a single capability slot. The `capability` parameter
 * is optional so single-slot callers (e.g. legacy IPC handlers that
 * default to text) and multi-slot callers (Settings UI iterating all
 * slots) share one implementation.
 */
export function listModelsForPlatform(
  manifest: ModelManifest,
  target: Platform,
  capability?: ModelCapability,
): ResolvedModel[] {
  const preferred = preferredFormatFor(target);
  const out: ResolvedModel[] = [];
  for (const m of manifest.models) {
    if (m.format !== preferred) continue;
    if (capability !== undefined && manifestCapability(m) !== capability) {
      continue;
    }
    const resolved = resolveManifestPlatform(m.platform, target);
    if (!resolved) continue;
    out.push(toResolvedModel(m, resolved));
  }
  return out;
}

/**
 * Recommend a model for `target` at `tier`. Optional `capability`
 * restricts the search to one slot; when omitted, the text slot is
 * used so existing single-slot callers (RuntimeStatus, the legacy
 * ModelRuntimeCard top-of-page recommendation) keep their behaviour.
 */
export function recommendModel(
  manifest: ModelManifest,
  target: Platform,
  tier: DeviceTier,
  capability: ModelCapability = "text",
): ResolvedModel | null {
  const models = listModelsForPlatform(manifest, target, capability);
  return models.find((m) => m.tier === tier) ?? models[0] ?? null;
}

/**
 * Tier + GPU gating for a capability slot. Mirrors
 * `is_capability_available` in `crates/tessera_runtime/src/config.rs`:
 *
 *   - `"text"` and `"vision"` are always available (SmolVLM 256M
 *     fits comfortably in low-tier RAM on CPU).
 *   - `"imagegen"` requires Medium+ tier AND at least one GPU
 *     compute backend (cuda/vulkan/metal/rocm). The CPU-only path is
 *     intentionally not a product: diffusion on CPU is too slow to
 *     ship a button for.
 *
 * The renderer uses this to hide the Image Generation section of the
 * Settings card on devices where the capability is structurally
 * unreachable, instead of presenting a download button that would
 * lead to a model the runtime refuses to dispatch to.
 */
export function isCapabilityAvailable(
  tier: DeviceTier,
  capability: ModelCapability,
  computeBackends: readonly ComputeBackend[],
): boolean {
  switch (capability) {
    case "text":
    case "vision":
      return true;
    case "imagegen": {
      if (tier === "low") return false;
      // Match `ComputeBackend::is_gpu` on the Rust side: every
      // non-cpu backend counts as GPU. Keeping the predicate inline
      // here (rather than calling a helper) avoids a one-line
      // wrapper that would drift if the enum gains a non-GPU
      // variant.
      return computeBackends.some((b) => b !== "cpu");
    }
  }
}

export function pickLlamaServerVariant(
  manifest: ModelManifest,
  target: Platform,
  preferred: ComputeBackend,
): ManifestLlamaServerVariant | null {
  const server = manifest.llama_server;
  if (!server) return null;
  return (
    server.variants.find(
      (v) => v.platform === target && v.compute === preferred,
    ) ??
    server.variants.find((v) => v.platform === target) ??
    null
  );
}

/**
 * Mirror of `pickLlamaServerVariant` for the diffusion sidecar
 * binary. Same precedence: exact (platform, compute) match wins,
 * falling back to "any compute for this platform" (e.g. a host with
 * both CUDA and Vulkan available will prefer the CUDA build if
 * `preferred === "cuda"`, but accept the Vulkan one as a fallback if
 * CUDA isn't shipped for this platform yet). Returns `null` when
 * the manifest carries no `diffusion_server` block at all OR when no
 * variant matches `target` — the imagegen UI uses the latter to grey
 * out the slot rather than start an install that has nothing to
 * download.
 */
export function pickDiffusionServerVariant(
  manifest: ModelManifest,
  target: Platform,
  preferred: ComputeBackend,
): ManifestDiffusionServerVariant | null {
  const diffusion = manifest.diffusion_server;
  if (!diffusion) return null;
  return (
    diffusion.variants.find(
      (v) => v.platform === target && v.compute === preferred,
    ) ??
    diffusion.variants.find((v) => v.platform === target) ??
    null
  );
}

// --- Per-capability slot storage ----------------------------------------

/**
 * On-disk layout, anchored at the host-provided `userDataDir`. One slot
 * per capability (text, vision, imagegen), each independently
 * single-model:
 *
 *   <userDataDir>/active-model-<capability>.json
 *       ← currently-installed record for that slot (or absent)
 *   <userDataDir>/models/<capability>/<filename>
 *       ← the single model file/dir on disk for that slot
 *
 * The legacy single-slot layout
 *
 *   <userDataDir>/active-model.json
 *   <userDataDir>/models/<filename>
 *
 * is auto-migrated to the text slot on first access — see
 * `migrateLegacyFlatLayoutIfNeeded` below.
 */
export function modelsDir(
  userDataDir: string,
  capability: ModelCapability,
): string {
  return path.join(userDataDir, "models", capability);
}

export function activeModelPath(
  userDataDir: string,
  capability: ModelCapability,
): string {
  return path.join(userDataDir, `active-model-${capability}.json`);
}

/**
 * Legacy (pre-multi-slot) on-disk file names. Kept exported so the
 * migration can locate them and so tests can assert post-migration
 * cleanup without hard-coding the strings in multiple places.
 *
 * Production code MUST NOT reach for these directly outside of
 * `migrateLegacyFlatLayoutIfNeeded` — every read/write goes through
 * `activeModelPath(userDataDir, capability)` /
 * `modelsDir(userDataDir, capability)` instead.
 */
export function legacyActiveModelPath(userDataDir: string): string {
  return path.join(userDataDir, "active-model.json");
}

export function legacyModelsDir(userDataDir: string): string {
  return path.join(userDataDir, "models");
}

// --- Legacy-layout migration --------------------------------------------

/**
 * Per-`userDataDir` cache of migration outcomes. Migration only ever
 * needs to run once per process per user-data directory; subsequent
 * reads short-circuit through this cache instead of doing a stat()
 * on the legacy file. Cleared by `resetLegacyMigrationCache()` for
 * test isolation.
 *
 * Holds a Promise so concurrent first-time readers from two windows
 * all await the same migration, rather than each racing to move the
 * legacy file.
 */
const legacyMigrationCache = new Map<string, Promise<void>>();

/**
 * Detect the legacy single-slot layout
 *
 *   <userDataDir>/active-model.json
 *   <userDataDir>/models/<filename>
 *
 * and move it into the text slot
 *
 *   <userDataDir>/active-model-text.json
 *   <userDataDir>/models/text/<filename>
 *
 * so existing users transparently upgrade to the multi-slot layout
 * without losing their installed model on first launch after the
 * upgrade.
 *
 * Idempotent: safe to call on every read entry-point. The Promise
 * is memoised per `userDataDir` so concurrent first-time callers all
 * await the same migration. Failures are swallowed AFTER being
 * logged — a partially-migrated state still leaves the legacy file
 * in place and the next attempt will retry; we never want a
 * migration error to make the app unusable.
 *
 * Concurrency: serialised purely through the in-process memoised
 * Promise above. We deliberately do NOT take `withDownloadLock`
 * here, because migration is called by `getCurrentModel` which is
 * itself called from INSIDE the per-slot lock by
 * `downloadModelLocked` / `deleteCurrentModelUnlocked`. Acquiring
 * the lock here would deadlock. Cross-process concurrency is not
 * a concern: Electron main is single-process, and `userDataDir`
 * is exclusive to one running Tessera instance by design.
 */
export function migrateLegacyFlatLayoutIfNeeded(
  userDataDir: string,
): Promise<void> {
  const cached = legacyMigrationCache.get(userDataDir);
  if (cached) return cached;
  const work = runLegacyMigration(userDataDir);
  // Cache the resolved Promise (errors are swallowed inside
  // `runLegacyMigration` so this Promise only ever resolves).
  legacyMigrationCache.set(userDataDir, work);
  return work;
}

async function runLegacyMigration(userDataDir: string): Promise<void> {
  const legacyActive = legacyActiveModelPath(userDataDir);
  // Fast existence check before doing any further work — migrations
  // are a one-shot startup concern and the steady-state hot path is
  // "no legacy file, nothing to do".
  try {
    await fsp.access(legacyActive, fs.constants.F_OK);
  } catch {
    // No legacy file — nothing to migrate. The cache entry stays in
    // place so we don't re-stat on every subsequent read.
    return;
  }
  // Serialisation is provided by the memoised Promise in
  // `legacyMigrationCache` (the caller awaits the same Promise the
  // first migrator created). We must not acquire the text-slot
  // download lock here: this function is itself called from
  // `getCurrentModel`, which runs inside the lock during
  // download/delete, and re-entering would deadlock.
  let raw: string;
  try {
    raw = await fsp.readFile(legacyActive, "utf8");
  } catch (err) {
    console.warn(
      `[tessera] legacy active-model.json could not be read during migration; leaving it in place: ${(err as Error).message}`,
    );
    return;
  }
  let parsed: InstalledModelRecord;
  try {
    parsed = JSON.parse(raw) as InstalledModelRecord;
  } catch (parseErr) {
    // Corrupt legacy record — back it up out of the way so a
    // subsequent retry of migration doesn't see a parse error
    // forever. The text slot stays empty so the user is prompted to
    // re-download, matching the corruption-recovery behaviour of
    // `getCurrentModel`.
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${legacyActive}.corrupt-${ts}`;
    try {
      await fsp.rename(legacyActive, backup);
      console.warn(
        `[tessera] legacy active-model.json was unparseable JSON; moved to ${backup}. ` +
          `Parse error: ${(parseErr as Error).message}`,
      );
    } catch (renameErr) {
      console.warn(
        `[tessera] legacy active-model.json was unparseable JSON and could not be backed up ` +
          `(${(renameErr as Error).message}); leaving the file in place. ` +
          `Parse error: ${(parseErr as Error).message}`,
      );
    }
    return;
  }
  // Move the actual model artifact from <userDataDir>/models/<filename>
  // into <userDataDir>/models/text/<filename>. The legacy `path`
  // field on the record may point at the old flat location (built by
  // an older version of writeCurrentModel) — if it does, rewrite it
  // to the new per-slot location.
  const legacyDir = legacyModelsDir(userDataDir);
  const newDir = modelsDir(userDataDir, "text");
  await fsp.mkdir(newDir, { recursive: true });
  const oldArtifactPath = parsed.path
    ? parsed.path
    : path.join(legacyDir, parsed.filename);
  const newArtifactPath = path.join(newDir, parsed.filename);
  let artifactMoved = false;
  try {
    // Only attempt the move if the legacy artifact still lives at
    // the legacy location AND the new location is free. Both
    // conditions allow the migration to be idempotent if a previous
    // attempt half-completed.
    const inLegacy = oldArtifactPath.startsWith(legacyDir + path.sep) ||
      oldArtifactPath === legacyDir;
    if (inLegacy) {
      try {
        await fsp.access(oldArtifactPath, fs.constants.F_OK);
      } catch {
        // Artifact is already gone (user manually deleted, or a
        // previous migration attempt moved it). Record the new path
        // anyway so the next `getInstalledModel` call sees "file
        // missing" and prompts a re-download.
        parsed.path = newArtifactPath;
        parsed.capability = "text";
        await atomicWriteJson(activeModelPath(userDataDir, "text"), parsed);
        await fsp.unlink(legacyActive).catch(() => undefined);
        return;
      }
      await fsp.rename(oldArtifactPath, newArtifactPath);
      artifactMoved = true;
    }
  } catch (err) {
    console.warn(
      `[tessera] failed to move legacy model artifact ${oldArtifactPath} -> ${newArtifactPath} during migration: ${(err as Error).message}. ` +
        "Leaving the legacy layout in place; the next call will retry.",
    );
    // Abort the migration but don't poison the cache — the next call
    // should retry. Drop the cache entry so the retry actually
    // happens.
    legacyMigrationCache.delete(userDataDir);
    return;
  }
  parsed.path = newArtifactPath;
  parsed.capability = "text";
  try {
    await atomicWriteJson(activeModelPath(userDataDir, "text"), parsed);
  } catch (err) {
    console.warn(
      `[tessera] failed to write active-model-text.json during migration: ${(err as Error).message}. ` +
        "Attempting to roll back the artifact move.",
    );
    // Roll back the artifact move so retrying the migration on the
    // next call still finds a coherent legacy layout.
    if (artifactMoved) {
      await fsp
        .rename(newArtifactPath, oldArtifactPath)
        .catch(() => undefined);
    }
    legacyMigrationCache.delete(userDataDir);
    return;
  }
  // Finally drop the legacy active-model.json — the text slot now
  // owns the record. Failure to unlink is non-fatal: the next
  // migration attempt is a no-op because the migrated file already
  // exists and the legacy file is harmless (we ignore it on
  // subsequent reads because we read the per-slot file first), so
  // we surface it as a warning rather than rolling back.
  try {
    await fsp.unlink(legacyActive);
  } catch (err) {
    console.warn(
      `[tessera] failed to remove legacy active-model.json after migration: ${(err as Error).message}. ` +
        "The new per-slot file is authoritative; this stale file is harmless and can be deleted manually.",
    );
  }
}

/**
 * Drop the migration-cache entries so a follow-up
 * `getCurrentModel`/`getInstalledModels` call re-checks the legacy
 * layout from scratch. Production callers must not touch this; tests
 * call it in `beforeEach` to ensure migration runs fresh for each
 * fixture.
 */
export function resetLegacyMigrationCache(): void {
  legacyMigrationCache.clear();
}

// --- Single-model enforcement (per slot) --------------------------------

/**
 * Single source of truth for "what model is actually installed and
 * usable right now in `capability`'s slot?" — model-id-agnostic.
 * Returns the live record only if the on-disk file referenced by
 * `active-model-<capability>.json` still exists; otherwise returns
 * `null`.
 *
 * Used by:
 *   - `runtime:planDownload` IPC, so a stale per-slot active record
 *     pointing at a manually-deleted file no longer makes the planner
 *     return `already-installed`.
 *   - `isModelInstalled(capability, modelId)` below, which is a thin
 *     model-id filter over this.
 *   - `getInstalledModels()`, which fans out across every slot.
 *
 * The active-model record can drift from reality if a user manually
 * deleted the file or a disk error removed it, so an existence check
 * is part of the "installed" definition — concentrating it here means
 * every caller picks up new criteria (e.g. checksum-on-disk, or "file
 * is a directory but its expected contents are missing" for MLX)
 * uniformly.
 */
export async function getInstalledModel(
  userDataDir: string,
  capability: ModelCapability,
): Promise<InstalledModelRecord | null> {
  const current = await getCurrentModel(userDataDir, capability);
  if (!current) return null;
  if (!fs.existsSync(current.path)) return null;
  return current;
}

/**
 * Snapshot every capability slot's installed record in a single pass.
 * Slots with no model installed map to `null`. Used by
 * `runtime:getInstalledModels` so the Settings UI can render
 * aggregate disk usage and per-slot install state without one IPC
 * round-trip per slot.
 */
export async function getInstalledModels(
  userDataDir: string,
): Promise<InstalledModelsByCapability> {
  const entries = await Promise.all(
    ALL_MODEL_CAPABILITIES.map(
      async (c) => [c, await getInstalledModel(userDataDir, c)] as const,
    ),
  );
  // Build the record explicitly so the type system enforces that every
  // capability has an entry — `Object.fromEntries` widens the key type
  // to `string` and would mask a missing slot if `ALL_MODEL_CAPABILITIES`
  // ever drifted from `ModelCapability`.
  const out: InstalledModelsByCapability = {
    text: null,
    vision: null,
    imagegen: null,
  };
  for (const [cap, rec] of entries) {
    out[cap] = rec;
  }
  return out;
}

/**
 * Single source of truth for "is `modelId` specifically the model that's
 * actually installed and usable right now in `capability`'s slot?".
 * Composes on top of `getInstalledModel` so the file-exists definition
 * can only live in one place.
 *
 * Used by both the IPC fast-path (`runtime:downloadModel` — skip
 * sidecar restart when no download is needed) and by
 * `downloadModelLocked` itself (skip download when the requested model
 * is already on disk in its declared slot).
 */
export async function isModelInstalled(
  userDataDir: string,
  capability: ModelCapability,
  modelId: string,
): Promise<InstalledModelRecord | null> {
  const live = await getInstalledModel(userDataDir, capability);
  if (!live) return null;
  if (live.modelId !== modelId) return null;
  return live;
}

/**
 * Read the per-slot active-model record from disk.
 *
 * Returns `null` if the file does not exist (no model installed in
 * this slot yet) OR if the file exists but is unparseable JSON.
 * Corruption is treated as "no record" and the offending file is
 * moved aside to a timestamped `.corrupt-<ts>` sibling so the user
 * can re-download without manual filesystem surgery, the next
 * `downloadModel` call clears the slot, and an operator can still
 * recover the original bytes from disk for forensic purposes.
 *
 * IO errors other than ENOENT (permission denied, etc.) are
 * propagated because they need explicit operator attention and
 * silently masking them would hide real disk faults.
 */
export async function getCurrentModel(
  userDataDir: string,
  capability: ModelCapability,
): Promise<InstalledModelRecord | null> {
  // Migrate any legacy flat-layout artifacts the FIRST time we touch
  // the text slot in this process. Other slots are post-multi-slot so
  // there is nothing to migrate for them. Migration is idempotent and
  // memoised per-userDataDir, so concurrent readers from two windows
  // all await the same migration.
  if (capability === "text") {
    await migrateLegacyFlatLayoutIfNeeded(userDataDir);
  }
  const p = activeModelPath(userDataDir, capability);
  let raw: string;
  try {
    raw = await fsp.readFile(p, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // POSIX returns ENOTDIR directly when a path component is a regular
      // file ("/path/to/file/active-model.json"). Windows collapses both
      // "the file truly doesn't exist" and "the parent is not a directory"
      // into ENOENT, which would silently mask an operator error. Stat the
      // parent explicitly so we surface a real disk-shape fault on every
      // platform.
      try {
        const stat = await fsp.stat(userDataDir);
        if (!stat.isDirectory()) {
          const cross: NodeJS.ErrnoException = new Error(
            `ENOTDIR: not a directory, open '${p}'`,
          );
          cross.code = "ENOTDIR";
          cross.path = p;
          throw cross;
        }
      } catch (statErr) {
        const statCode = (statErr as NodeJS.ErrnoException).code;
        if (statCode === "ENOTDIR") throw statErr;
        // Parent doesn't exist either — the caller hasn't initialized the
        // user-data dir yet. Match the historical contract and report "no
        // active model" rather than failing.
        if (statCode === "ENOENT") return null;
        throw statErr;
      }
      return null;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as InstalledModelRecord;
  } catch (parseErr) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${p}.corrupt-${ts}`;
    // Best-effort move-aside. If even this fails we still want to log
    // and degrade to `null` rather than rethrowing; a corrupt record
    // shouldn't block all model operations.
    // Use the actual on-disk path (`p`) rather than the legacy
    // `active-model.json` filename. Per-slot files are named
    // `active-model-text.json` / `active-model-vision.json` /
    // `active-model-imagegen.json`; the vision and imagegen variants
    // have no legacy history at all, so saying "active-model.json was
    // unparseable" in those log lines would actively mislead an
    // operator. The pre-multi-slot phrasing is kept inside the legacy
    // migration code, which is the only place an actual
    // `active-model.json` ever shows up.
    try {
      await fsp.rename(p, backupPath);
      console.warn(
        `[tessera] ${p} was unparseable JSON; moved to ${backupPath}. ` +
          `Returning null so the next model operation starts clean. Parse error: ${(parseErr as Error).message}`,
      );
    } catch (renameErr) {
      console.warn(
        `[tessera] ${p} was unparseable JSON and could not be backed up ` +
          `(${(renameErr as Error).message}); leaving the file in place and returning null. ` +
          `Parse error: ${(parseErr as Error).message}`,
      );
    }
    return null;
  }
}

async function writeCurrentModel(
  userDataDir: string,
  capability: ModelCapability,
  record: InstalledModelRecord | null,
): Promise<void> {
  const p = activeModelPath(userDataDir, capability);
  if (record === null) {
    try {
      await fsp.unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  // Ensure the record carries its slot tag so a later reader (which
  // may be reading via getInstalledModels across all slots) can
  // recover the capability without re-parsing the filename.
  const stamped: InstalledModelRecord = { ...record, capability };
  await atomicWriteJson(p, stamped);
}

/**
 * Crash-safe JSON write: serialise, write to a sibling `.tmp-<pid>-<ts>`,
 * fsync the temp file, then atomically `rename()` it over the target.
 *
 * `fs.rename` is atomic on every supported platform when the source and
 * destination live on the same volume:
 *   - POSIX: `rename(2)` is specified atomic.
 *   - Windows: Node's `fs.rename` uses `MoveFileExW(MOVEFILE_REPLACE_EXISTING
 *     | MOVEFILE_WRITE_THROUGH)` on Windows 10+, which is atomic for files
 *     on the same volume.
 *
 * Because we always write the temp file in the same directory as the
 * target, the same-volume invariant holds (you can't have two volumes
 * sharing a single directory). The `getCurrentModel` corruption-recovery
 * path remains as a belt-and-braces second line of defence for the
 * (now-much-narrower) windows where corruption could still occur — for
 * instance, a power loss between `fsync` and `rename`, which can leave
 * the temp file behind but never produces a partially-written target.
 *
 *
 */
async function atomicWriteJson(
  targetPath: string,
  record: InstalledModelRecord,
): Promise<void> {
  const dir = path.dirname(targetPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`,
  );
  const json = JSON.stringify(record, null, 2);
  const handle = await fsp.open(tempPath, "w");
  try {
    await handle.writeFile(json);
    // fsync forces the bytes through the OS page cache to the
    // underlying device before we rename — without it, an OS crash
    // (not a process crash) between writeFile and rename could resurrect
    // an empty `active-model.json` on next boot.
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tempPath, targetPath);
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed.
    // The caller's primary failure is the rename error, which we
    // re-throw, but secondary unlink failures are surfaced as warnings
    // (rather than silently swallowed) so they show up in the main-
    // process log if the temp file accumulates.
    // Silently swallowing filesystem-mutation errors hides invariant
    // violations that bite later — surface them as warnings instead.
    await fsp.unlink(tempPath).catch((unlinkErr: unknown) => {
      console.warn(
        `[atomicWriteJson] failed to remove temp file ${tempPath} after rename error:`,
        unlinkErr,
      );
    });
    throw err;
  }
}

export function planDownload(
  current: InstalledModelRecord | null,
  requested: ResolvedModel,
): DownloadPlan {
  if (current === null) {
    return {
      kind: "direct-download",
      modelId: requested.id,
      filename: requested.filename,
      downloadSizeMb: requested.downloadSizeMb,
      message: `Download ${requested.name} (${requested.downloadSizeMb} MB).`,
    };
  }
  if (current.modelId === requested.id) {
    return { kind: "already-installed", modelId: current.modelId };
  }
  // SwapDecision describes disk-space accounting ("save X MB", "net disk
  // delta"), so we use diskSizeMb consistently for the install / evict /
  // delta fields. For GGUF models these match downloadSizeMb, but MLX
  // archives expand after extraction so the post-extract footprint is the
  // correct unit for swap planning. The download progress UI separately
  // consumes downloadSizeMb. `effectiveDiskSizeMb` falls back to
  // `downloadSizeMb` for legacy records that pre-date `diskSizeMb`.
  const evictDiskSize = effectiveDiskSizeMb(current);
  const installDiskSize = requested.diskSizeMb;
  const netDelta = installDiskSize - evictDiskSize;
  return {
    kind: "swap",
    evictModelId: current.modelId,
    evictFilename: current.filename,
    evictSizeMb: evictDiskSize,
    installModelId: requested.id,
    installFilename: requested.filename,
    installSizeMb: installDiskSize,
    netDiskDeltaMb: netDelta,
    message: `Current: ${current.modelId} (${evictDiskSize} MB). New: ${requested.name} (${installDiskSize} MB). This will remove ${current.filename} to save ${evictDiskSize} MB and install ${installDiskSize} MB.`,
  };
}

/**
 * Error raised when a download is cancelled via its `AbortSignal`
 * (e.g. the user clicks "Skip — work without AI" in the
 * ModelDownloadBanner, which fires `runtime:cancelDownload`).
 *
 * Distinguished from a genuine network/checksum failure so callers can
 * treat a deliberate cancellation as benign — the first-launch
 * auto-download maps it to a silent `"cancelled"` outcome instead of
 * broadcasting `runtime:downloadError` (which would flash a misleading
 * "Setup failed" banner). The download lock's `.partial` cleanup runs
 * regardless, so a cancelled transfer leaves no half-written file
 * behind.
 */
export class DownloadAbortedError extends Error {
  constructor(message = "Download aborted") {
    super(message);
    this.name = "DownloadAbortedError";
  }
}

/**
 * True when `err` represents a download cancellation: either our own
 * {@link DownloadAbortedError} (the abort reason we pass to
 * `AbortController.abort`) or a stock `AbortError`/`DOMException` that
 * `fetch` raises when a signal aborts without an explicit reason. Both
 * are treated as "the caller asked to stop", not a transient fault to
 * retry or a failure to surface.
 */
export function isDownloadAbortedError(err: unknown): boolean {
  if (err instanceof DownloadAbortedError) return true;
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

export interface DownloadProgress {
  modelId: string;
  /**
   * Capability slot this progress event belongs to. Required so the
   * renderer can route the event to the correct per-capability
   * progress bar in the multi-slot Settings UI — without it, two
   * concurrent downloads (e.g. text + vision) would be
   * indistinguishable in the renderer.
   *
   * Mirrors `ModelDownloadProgress.capability` in
   * `apps/desktop/shared/types.ts`.
   */
  capability: ModelCapability;
  format: ModelFormat;
  filename: string;
  downloadedMb: number;
  totalMb: number;
  percent: number;
}

export interface DownloadDeps {
  fetcher?: (
    url: string,
    onProgress: (downloadedBytes: number, totalBytes: number) => void,
    destPath: string,
    signal?: AbortSignal,
  ) => Promise<{ totalBytes: number }>;
  hasher?: (filePath: string) => Promise<string>;
  now?: () => Date;
  /**
   * When supplied, the download is cancellable: the signal is passed to
   * `fetch` and checked at each retry/streaming checkpoint, and an
   * abort short-circuits BEFORE any filesystem mutation (eviction /
   * `.partial` write) when it fires while the call is still queued
   * behind the per-slot download lock. On abort the call rejects with a
   * {@link DownloadAbortedError} and the standard `.partial` cleanup
   * runs, so no half-written file survives. Cancellation is wired by
   * the `runtime:cancelDownload` IPC via the per-capability
   * `downloadCancellations` registry.
   */
  signal?: AbortSignal;
  /**
   * Tar+gzip archive extractor. Overridable for unit tests so we can
   * exercise the archive-aware download path without producing real
   * compressed fixtures.
   */
  extractTarGz?: (archivePath: string, destDir: string) => Promise<void>;
  /**
   * Hook invoked exactly once, INSIDE the per-`userDataDir` download
   * lock, just before the first filesystem mutation (eviction of an
   * existing model file, or writing the `.partial` for a fresh
   * install). Skipped on the already-installed fast path because no
   * mutation occurs there.
   *
   * The Electron main process wires `stopSidecarIfRunning()` through
   * here so the `llama-server` child releases its OS-level file handle
   * on the active model before we touch it. Doing this work INSIDE the
   * lock closes the race window that existed when the sidecar-stop
   * ran in the IPC handler outside the lock: a concurrent
   * `runtime:downloadModel` from another window could have completed
   * a download in the gap between sidecar-stop and lock-acquire,
   * leading to a user-confusing "my just-downloaded model got
   * deleted" sequence. With the hook inside the lock the entire
   * (stop → mutate → commit) sequence is atomic per `userDataDir`.
   *
   */
  beforeMutation?: () => Promise<void>;
}

/**
 * Knobs for `deleteCurrentModel`. Currently only the `beforeMutation`
 * hook — same semantics as in `DownloadDeps` (run once, INSIDE the
 * lock, only when a mutation will actually occur).
 */
export interface DeleteDeps {
  beforeMutation?: () => Promise<void>;
}

/**
 * Maximum number of HTTP attempts the default fetcher makes for a
 * single file before surfacing the error. The first attempt is the
 * initial request; every retry resumes from the bytes written so far
 * *in this session* via an HTTP `Range` request rather than restarting
 * from zero. Four attempts (one initial + three resumes) covers the
 * common transient blip (CDN hiccup, Wi-Fi roam, laptop sleep) without
 * spinning forever on a genuinely dead endpoint.
 */
const DEFAULT_FETCH_MAX_ATTEMPTS = 4;

/**
 * Exponential backoff between download retries: `BASE * 2^(n-1)` before
 * the n-th retry, capped at `MAX`. A dropped connection is often a
 * server/CDN under load or a network mid-roam; retrying instantly in a
 * tight loop only adds to the pressure, so we wait a beat that grows
 * with each successive failure.
 */
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4000;

/** Real wall-clock sleep; injected as a no-op in unit tests. */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Parse the absolute resource length out of a `Content-Range` response
 * header (`bytes <start>-<end>/<total>`). Returns `null` when the
 * header is absent or uses the `*` unknown-total form, in which case
 * the caller falls back to `start + Content-Length`.
 */
function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /\/(\d+)\s*$/.exec(header.trim());
  if (!match) return null;
  const total = parseInt(match[1], 10);
  return Number.isFinite(total) ? total : null;
}

/**
 * Build the production HTTP fetcher. Split into a factory (rather than
 * a bare const) so unit tests can inject a fake `fetch` (and a no-op
 * `sleep`) and exercise the resume / retry logic against a real temp
 * file without hitting the network.
 *
 * Resume semantics: large model weights (multiple GB) routinely outlive
 * a flaky connection. Rather than throw the whole transfer away on the
 * first dropped socket, the fetcher retries *within the call*, each
 * time continuing from the bytes it has already written:
 *
 *   1. The first attempt is a plain GET; it truncates `destPath` and
 *      records the response validator (ETag / Last-Modified).
 *   2. After a mid-stream drop it re-requests `Range: bytes=<n>-`
 *      (with `If-Range: <validator>`) and APPENDS when the server
 *      honours it (HTTP 206).
 *   3. If the server replies 200 (range / If-Range not honoured, or the
 *      resource changed) it truncates and restarts so a new suffix is
 *      never spliced onto a stale prefix.
 *   4. A 416 (our offset is past a now-shorter resource) discards the
 *      bytes and restarts clean.
 *   5. Connection / mid-stream failures retry up to `maxAttempts` with
 *      exponential backoff.
 *
 * Resume is intentionally scoped to a SINGLE call. A `.partial` only
 * outlives the call that created it via a hard crash, and the
 * single-file-per-slot layout reuses one filename across model
 * versions, so a leftover partial cannot be proven to match `url`.
 * Trusting it could splice mismatched content (silently, for the
 * supported no-checksum case). The first attempt therefore always
 * truncates any pre-existing partial. The caller (`downloadModelLocked`)
 * deletes the `.partial` on a terminal failure.
 */
export function createDefaultFetcher(
  fetchImpl?: typeof fetch,
  maxAttempts: number = DEFAULT_FETCH_MAX_ATTEMPTS,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): NonNullable<DownloadDeps["fetcher"]> {
  return async (url, onProgress, destPath, signal) => {
    // Resolve `fetch` lazily at call time (not at factory-creation
    // time) so the production fetcher honours a `globalThis.fetch`
    // swapped in after module load — e.g. test mocks, or a runtime
    // proxy install.
    const doFetch = fetchImpl ?? globalThis.fetch;
    // Cancellation checkpoint. Called at the top of every attempt and
    // after each backoff sleep so an abort that fires while we are
    // between retries (or sleeping) bails promptly instead of issuing
    // another doomed request. The in-flight `fetch`/stream read is
    // aborted directly by passing `signal` into the request, so the
    // common case (abort mid-transfer) is instantaneous; this guard
    // covers the gaps the request can't see. We surface the signal's
    // abort `reason` when it is an Error (we always abort with a
    // `DownloadAbortedError`) so callers can classify it.
    const throwIfAborted = (): void => {
      if (signal?.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new DownloadAbortedError();
      }
    };
    // Bytes written *during this call*. We deliberately do NOT seed this
    // from an existing on-disk `.partial`: a leftover partial can only
    // outlive the call that wrote it via a hard crash/kill, and we
    // cannot prove it holds the SAME content as `url` (the single
    // file-per-slot layout reuses the filename across model versions).
    // Trusting it would let a `Range` resume splice a new suffix onto a
    // stale prefix and, for the supported no-checksum case, silently
    // install a corrupt file. So the first attempt always issues a plain
    // GET that truncates any stale partial; resume only ever continues
    // bytes we ourselves wrote in this session.
    let downloaded = 0;
    // HTTP validator (ETag / Last-Modified) of the body we are writing,
    // captured from the first 200. Echoed as `If-Range` on a resume so
    // the server returns a full 200 (→ truncate + restart) instead of a
    // 206 if the resource changed between attempts.
    let validator: string | null = null;

    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      throwIfAborted();
      if (attempt > 0) {
        // Every attempt past the first follows a failure, so back off
        // before re-requesting. Grows exponentially, capped at the max.
        const delay = Math.min(
          RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
          RETRY_MAX_DELAY_MS,
        );
        await sleep(delay);
        throwIfAborted();
      }
      const resuming = downloaded > 0;
      // Pass the caller's `AbortSignal` straight into the request so an
      // abort tears down the in-flight connection and the streaming
      // body read immediately (undici rejects the `fetch` promise and
      // the reader with the signal's reason). `init.signal` is left
      // `undefined` when no signal was supplied, preserving the prior
      // uncancellable behaviour for callers that don't opt in.
      const init: RequestInit = { signal };
      if (resuming) {
        const headers: Record<string, string> = {
          Range: `bytes=${downloaded}-`,
        };
        if (validator) headers["If-Range"] = validator;
        init.headers = headers;
      }

      let resp: Response;
      try {
        resp = await doFetch(url, init);
      } catch (err) {
        // A user-initiated cancellation is terminal: do NOT retry it
        // like a transient connection blip. Rethrow so the caller's
        // `.partial` cleanup runs and the abort propagates unchanged.
        if (isDownloadAbortedError(err)) throw err;
        // Connection failed before any response (DNS, TCP reset,
        // refused). Retry — `downloaded` is unchanged so the next
        // attempt resumes from the same offset.
        lastErr = err;
        continue;
      }

      // 416: our partial is at/past the resource length (the remote
      // file shrank or we somehow already have it all). Drop the
      // prefix and restart from scratch on the next attempt. Clear the
      // validator too: the next attempt sends no Range (downloaded is
      // 0), so the stale validator would never be used, but resetting
      // it keeps "no bytes written" and "no captured validator" in
      // lockstep rather than relying on that downstream invariant.
      if (resp.status === 416) {
        await resp.body?.cancel().catch(() => undefined);
        downloaded = 0;
        validator = null;
        await fsp.truncate(destPath, 0).catch(() => undefined);
        lastErr = new Error(`Download failed: HTTP ${resp.status}`);
        continue;
      }

      if (!resp.ok) {
        // Cancel the response body so undici releases the underlying
        // TCP socket immediately instead of waiting for GC. `.catch`
        // because cancel() throws if the body was already consumed,
        // and we don't want that to mask the HTTP-status error.
        await resp.body?.cancel().catch(() => undefined);
        throw new Error(`Download failed: HTTP ${resp.status}`);
      }

      const isPartial = resp.status === 206;
      if (!isPartial) {
        // Full body (200): either the initial fetch, or a resume the
        // server declined (Range/If-Range not honoured, or the resource
        // changed). (Re)capture the validator for this content and
        // discard any prefix so we never append a second full copy.
        validator =
          resp.headers.get("etag") ?? resp.headers.get("last-modified");
        downloaded = 0;
      }

      const clenHeader = resp.headers.get("content-length");
      const clen = clenHeader ? parseInt(clenHeader, 10) : 0;
      const clenValid = Number.isFinite(clen) && clen > 0;
      // Full resource size for progress math. For a 206 the
      // Content-Length is only the *remaining* bytes, so prefer the
      // absolute total from Content-Range and fall back to
      // prefix + remaining.
      const total =
        isPartial && downloaded > 0
          ? (parseContentRangeTotal(resp.headers.get("content-range")) ??
            (clenValid ? downloaded + clen : 0))
          : clenValid
            ? clen
            : 0;

      if (!resp.body) throw new Error("Empty response body");
      const body = resp.body;

      // Append when resuming a server-honoured range; otherwise
      // truncate-and-write. Open AFTER the status checks so a failed
      // open doesn't strand a locked response-body reader.
      const appendMode = isPartial && downloaded > 0;
      let handle: fsp.FileHandle;
      try {
        handle = await fsp.open(destPath, appendMode ? "a" : "w");
      } catch (openErr) {
        // A failed open (EACCES, ENOSPC, ...) is terminal. Cancel the
        // body so undici frees the socket immediately instead of
        // stranding it until GC, then surface the open error.
        await body.cancel().catch(() => undefined);
        throw openErr;
      }
      let pumpError: unknown = null;
      try {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              await handle.write(value);
              downloaded += value.byteLength;
              // `onProgress` is wrapped at the `downloadModel`
              // boundary (see `wrapProgressNoThrow`) so a buggy
              // callback or destroyed BrowserWindow cannot abort the
              // byte pump.
              onProgress(downloaded, total);
            }
          }
        } finally {
          // Release the body reader so the HTTP connection returns to
          // the pool, even on a mid-stream read error.
          try {
            await reader.cancel();
          } catch {
            // ignore — reader may already be in a terminal state
          }
        }
      } catch (err) {
        // Mid-stream failure. Keep the bytes written so far and retry
        // with a Range request continuing from `downloaded`.
        pumpError = err;
      } finally {
        await handle.close().catch(() => undefined);
      }

      if (pumpError) {
        // A mid-stream abort (signal fired while reading the body)
        // is terminal — rethrow so cleanup runs instead of retrying a
        // transfer the caller explicitly cancelled.
        if (isDownloadAbortedError(pumpError)) throw pumpError;
        lastErr = pumpError;
        continue;
      }
      return { totalBytes: downloaded };
    }

    throw lastErr instanceof Error
      ? lastErr
      : new Error("Download failed after exhausting retries");
  };
}

const defaultFetcher: NonNullable<DownloadDeps["fetcher"]> =
  createDefaultFetcher();

const defaultHasher: NonNullable<DownloadDeps["hasher"]> = async (filePath) => {
  const hash = crypto.createHash("sha256");
  const handle = await fsp.open(filePath, "r");
  const buf = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
};

/**
 * Internal: delete the currently installed model file (if any) for one
 * capability slot and clear that slot's active-model record. Must only
 * be called from within `withDownloadLock(userDataDir, capability)`
 * because it mutates the same shared on-disk state
 * (`active-model-<capability>.json` + the model file) that
 * `downloadModelLocked` mutates. Recursive locking would deadlock the
 * per-(userDataDir, capability) promise chain, so the lock is acquired
 * at the public-API boundary only.
 */
async function deleteCurrentModelUnlocked(
  userDataDir: string,
  capability: ModelCapability,
): Promise<void> {
  const current = await getCurrentModel(userDataDir, capability);
  if (!current) return;
  try {
    const stat = await fsp.stat(current.path);
    if (stat.isDirectory()) {
      await fsp.rm(current.path, { recursive: true, force: true });
    } else {
      await fsp.unlink(current.path);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  // Vision-GGUF mmproj cleanup. The projector is a sibling file of
  // the weights so deleting the weights alone leaves the projector
  // orphaned on disk, breaking the single-model-on-disk invariant
  // for the vision slot and burning disk space (the FP16 projector
  // for Qwen3.5-4B is ~750 MB). Best-effort unlink (logged on
  // non-ENOENT failure) parallels the stray-archive sweep below.
  if (current.mmprojPath) {
    try {
      await fsp.unlink(current.mmprojPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[deleteCurrentModel] failed to remove mmproj ${current.mmprojPath}:`,
          err,
        );
      }
    }
  }
  // Defensive stray-archive sweep :
  // For MLX models, the install record's `filename` is the original
  // `.tar.gz`/`.tgz` archive while `path` points at the extracted
  // directory. The post-extract unlink in `downloadModelLocked` is
  // best-effort — if a previous install crashed at the wrong moment, or
  // hit a transient Windows EPERM/EBUSY on unlink, the source archive
  // could survive next to the extracted dir. The download path now
  // surfaces that as a console.warn, but we also reap any leftover
  // archive here so the next user-initiated delete restores the
  // single-model-on-disk invariant without manual cleanup.
  if (isTarGz(current.filename)) {
    const archivePath = path.join(path.dirname(current.path), current.filename);
    if (archivePath !== current.path) {
      try {
        await fsp.unlink(archivePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          console.warn(
            `[deleteCurrentModel] failed to sweep stray archive ${archivePath}:`,
            err,
          );
        }
      }
    }
  }
  await writeCurrentModel(userDataDir, capability, null);
}

/**
 * Delete the model currently installed in `capability`'s slot (if any)
 * and clear that slot's active-model record.
 *
 * Serialized through the same per-(userDataDir, capability) download
 * lock as `downloadModel` so the on-disk contract is "all model-file
 * mutations within a slot are mutually exclusive". Without the lock,
 * the previous version relied on Node's cooperative scheduling to keep
 * a concurrent `downloadModel` from clobbering or being clobbered by
 * an in-flight `delete` — that's correct today but fragile and breaks
 * the moment model management moves to a worker thread, an Electron
 * utility process, or any other parallel-execution context. The lock
 * makes the invariant explicit instead of implicit.
 *
 * Cross-slot operations (deleting vision while text is downloading)
 * are independent and run in parallel by design — each capability
 * has its own lock keyed on `(userDataDir, capability)`.
 */
export async function deleteCurrentModel(
  userDataDir: string,
  capability: ModelCapability,
  deps: DeleteDeps = {},
): Promise<void> {
  return withDownloadLock(userDataDir, capability, async () => {
    // No-op fast path INSIDE the lock: if there is no installed model
    // we must not invoke `beforeMutation` at all (calling
    // `stopSidecarIfRunning()` for a no-op delete would needlessly
    // tear down a sidecar that's currently serving a *different*
    // model the user hasn't asked to delete — which would be the
    // case if `active-model.json` was already cleared but the user
    // double-clicked Delete from a stale UI). Reading
    // `getCurrentModel` here is cheap (one JSON file read) compared
    // to the sidecar-stop it gates.
    const current = await getCurrentModel(userDataDir, capability);
    if (!current) return;
    if (deps.beforeMutation) {
      await deps.beforeMutation();
    }
    return deleteCurrentModelUnlocked(userDataDir, capability);
  });
}

// --- Concurrency guard ---------------------------------------------------
// `downloadModel` mutates shared on-disk state for one capability slot:
// it reads `active-model-<capability>.json`, optionally deletes the
// existing model file in `models/<capability>/`, downloads to a
// `.partial` sibling, verifies the checksum, and atomically renames it
// into place. Without serialization, two concurrent calls targeting
// the same slot (rapid double-click, two renderer windows, two IPC
// channels racing) could BOTH pass the `current.modelId === requested.id`
// check, both call `deleteCurrentModel`, and both fight over the same
// destination filename — leaving the slot's on-disk state inconsistent
// with `active-model-<capability>.json`.
//
// We serialize per `(userDataDir, capability)` so different capability
// slots run in parallel (vision download doesn't block text download)
// but operations within the same slot are mutually exclusive.
// Hardware downloads are slow (hundreds of MB), so a single in-flight
// Promise chain per slot is the simplest correct primitive — every new
// caller awaits the tail of the chain and then runs. The composite
// key is keyed by `(userDataDir, capability)` so unit tests using
// different temp dirs / different slots don't accidentally block each
// other.
const downloadLocks = new Map<string, Promise<unknown>>();

function lockKey(userDataDir: string, capability: ModelCapability): string {
  // `\u0000` is illegal in POSIX/NTFS file paths, so it cannot collide
  // with any legitimate userDataDir value. Capability is a fixed
  // lowercase enum literal so a structured separator suffices.
  return `${userDataDir}\u0000${capability}`;
}

function withDownloadLock<T>(
  userDataDir: string,
  capability: ModelCapability,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(userDataDir, capability);
  const prev = downloadLocks.get(key) ?? Promise.resolve();
  // Swallow upstream errors in the chained `then` so a single failed
  // download does not poison subsequent callers — they should still get to
  // run with a clean slate.
  const next = prev.catch(() => undefined).then(fn);
  // The *stored* lock-tail is a swallowed copy so Node doesn't report it
  // as an unhandled rejection (the original `next` is returned to the
  // caller, who is responsible for handling its rejection via await /
  // .catch). Subsequent callers chain off this swallowed tail and so
  // can't be poisoned by an earlier failure either.
  const swallowed = next.catch(() => undefined);
  downloadLocks.set(key, swallowed);
  // Clean up the slot once this call settles AND it's still the tail of
  // the chain. We can't unconditionally delete because another caller may
  // have already chained onto `swallowed`.
  swallowed.finally(() => {
    if (downloadLocks.get(key) === swallowed) {
      downloadLocks.delete(key);
    }
  });
  return next;
}

/**
 * Wrap a `DownloadProgress` callback so it can never throw. Progress
 * reporting is a UX nicety; the durable side effect is the file written
 * to disk. If the renderer-side callback throws (a destroyed
 * BrowserWindow's `webContents.send`, a queue overflow, a buggy test
 * mock, a crashed renderer), we must NOT let that exception propagate
 * back up the fetcher's read loop into `downloadModelLocked`'s catch
 * block — that catch unlinks the `.partial` file and would discard a
 * potentially multi-gigabyte in-flight download. The IPC-side
 * `progressEmitter` already swallows destroyed-window errors at the
 * source, but enforcing the invariant here too means every future
 * caller (other IPC handlers, CLI harness, integration tests) gets the
 * same protection without having to remember to wrap their own
 * callback.
 */
function wrapProgressNoThrow(
  onProgress: (p: DownloadProgress) => void,
): (p: DownloadProgress) => void {
  return (p) => {
    try {
      onProgress(p);
    } catch (err) {
      console.warn(
        `[tessera] download progress callback threw (download continues): ${(err as Error).message}`,
      );
    }
  };
}

/**
 * Download the requested model, enforcing single-model storage. If a
 * different model is currently installed it is deleted FIRST. After
 * download we verify SHA256 (when the manifest provides one).
 *
 * Concurrent calls (same or different `userDataDir`) are serialized by an
 * in-process lock, so rapid double-clicks and parallel IPC invocations no
 * longer race on the on-disk model file.
 */
export async function downloadModel(
  userDataDir: string,
  requested: ResolvedModel,
  onProgress: (p: DownloadProgress) => void,
  deps: DownloadDeps = {},
): Promise<InstalledModelRecord> {
  const safeProgress = wrapProgressNoThrow(onProgress);
  // Each model's slot is derived from its manifest entry's capability
  // field, so the slot is determined at download time (not at IPC
  // time). This means a model can never be installed in the "wrong"
  // slot — a vision GGUF resolves to the vision slot whether the call
  // came from the Settings UI or an automatic recommendation pass.
  const capability = requested.capability;
  return withDownloadLock(userDataDir, capability, () =>
    downloadModelLocked(userDataDir, capability, requested, safeProgress, deps),
  );
}

async function downloadModelLocked(
  userDataDir: string,
  capability: ModelCapability,
  requested: ResolvedModel,
  onProgress: (p: DownloadProgress) => void,
  deps: DownloadDeps,
): Promise<InstalledModelRecord> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const hasher = deps.hasher ?? defaultHasher;
  const nowFn = deps.now ?? (() => new Date());

  // Fast path: requested model is already installed in its declared
  // slot AND its file is still on disk. `isModelInstalled` is the
  // single source of truth for that definition — the IPC fast-path
  // in apps/desktop/electron/ipc.ts calls the same helper, so the
  // two checks can no longer drift.
  const alreadyInstalled = await isModelInstalled(
    userDataDir,
    capability,
    requested.id,
  );
  if (alreadyInstalled) {
    return alreadyInstalled;
  }
  // Cancellation can fire while this call is still QUEUED behind the
  // per-slot download lock (e.g. a Retry queued behind an in-flight
  // download whose initiator then clicks "Skip"). Bail here — before
  // the sidecar-stop, eviction, or any `.partial` write — so a
  // cancelled download never tears down a perfectly good installed
  // model or stops the running sidecar for nothing. Mid-transfer
  // aborts are handled by the fetcher (which propagates a
  // `DownloadAbortedError` that the catch below cleans up after).
  if (deps.signal?.aborted) {
    throw deps.signal.reason instanceof Error
      ? deps.signal.reason
      : new DownloadAbortedError();
  }
  // Not the fast path — we will mutate the filesystem. Run the
  // pre-mutation hook (e.g. sidecar-stop) exactly once now, INSIDE
  // the lock, so the entire `(stop → evict → download → commit)`
  // sequence is serialised against any other download/delete on this
  // `(userDataDir, capability)`. Skipped on the already-installed fast
  // path above, and called BEFORE the eviction branch so callers can
  // rely on "no filesystem mutation has happened yet" when the hook
  // fires.
  if (deps.beforeMutation) {
    await deps.beforeMutation();
  }

  // If a *stale* record exists in this slot (right model id but file
  // missing, OR a different model entirely), clean it up first so the
  // post-download `writeCurrentModel` writes a clean state instead
  // of merging with the stale one. Records in OTHER slots are
  // untouched — this is the per-slot single-model invariant: swapping
  // a vision model does not delete the text model.
  const current = await getCurrentModel(userDataDir, capability);
  if (current) {
    if (current.modelId === requested.id) {
      // File missing under us — clear only the record; there is no
      // file to delete.
      await writeCurrentModel(userDataDir, capability, null);
    } else {
      // Different model installed in this slot — evict it. We're
      // already inside `withDownloadLock` for this
      // `(userDataDir, capability)`, so call the unlocked variant —
      // going through the public locked `deleteCurrentModel` would
      // deadlock the per-slot promise chain (it would queue behind
      // the very call that's awaiting it). Do NOT pass
      // `deps.beforeMutation` through either: we already called it
      // above, and calling it again here would double-invoke the
      // sidecar-stop for the swap path.
      await deleteCurrentModelUnlocked(userDataDir, capability);
    }
  }

  const dir = modelsDir(userDataDir, capability);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, requested.filename);
  // Two-file vision GGUF installs report progress across BOTH files as
  // a single monotonic 0..100% sweep. Computing the combined total up
  // front lets us offset the projector's per-fetcher progress by the
  // main weights' MB count, so the renderer's progress bar never
  // jumps backwards. For single-file installs (text / MLX / imagegen)
  // `mmprojBytes` is 0 and the math collapses to the prior behaviour.
  const mainBytes = requested.downloadSizeMb * 1024 * 1024;
  // Defence-in-depth: validateManifest already rejects a vision-GGUF
  // entry that has `mmprojUrl` without a positive `mmprojSizeMb`, so
  // in practice the `??` branch below is unreachable from manifest
  // data. Keep the fallback to `mainBytes` (not 0) anyway: it
  // guarantees `combinedBytes >= mainBytes + 1` once we add any
  // non-zero projector byte, so the progress percentage CANNOT
  // exceed 100% even if a future code path constructs a
  // `ResolvedModel` directly without going through manifest
  // validation. Using `mainBytes` (instead of an arbitrary number)
  // means the worst-case progress curve still resembles "half
  // weights, half projector" — visually defensible for the rare
  // synthetic-test code path that hits this branch.
  const mmprojBytes = requested.mmprojUrl
    ? (typeof requested.mmprojSizeMb === "number" && requested.mmprojSizeMb > 0
        ? requested.mmprojSizeMb * 1024 * 1024
        : mainBytes)
    : 0;
  const combinedBytes = mainBytes + mmprojBytes;
  // Stream the download into a `.partial` sibling so the final filename
  // ONLY ever exists on disk for fully-downloaded, checksum-verified models.
  // If anything fails (network, checksum), we clean up the partial so a
  // failed swap doesn't leave a broken or partial file pretending to be a
  // model. The single-model contract (delete-before-download) is preserved —
  // a failed download still leaves the user with no model, but with no
  // orphaned partial either, which matches the on-disk invariant tests rely
  // on ("at most one file in modelsDir").
  const partial = `${dest}.partial`;
  try {
    await fetcher(
      requested.url,
      (downloaded, total) => {
        const mainPart = total > 0 ? Math.min(downloaded, total) : downloaded;
        // Use the combined target if we're downloading mmproj too,
        // otherwise fall back to whatever the fetcher reported.
        const totalForReport =
          combinedBytes > 0
            ? combinedBytes
            : total > 0
              ? total
              : mainBytes;
        const totalMb = totalForReport / (1024 * 1024);
        const downloadedMb = mainPart / (1024 * 1024);
        const percent =
          totalForReport > 0 ? (mainPart / totalForReport) * 100 : 0;
        onProgress({
          modelId: requested.id,
          capability: requested.capability,
          format: requested.format,
          filename: requested.filename,
          downloadedMb,
          totalMb,
          percent,
        });
      },
      partial,
      deps.signal,
    );

    if (requested.sha256) {
      const got = await hasher(partial);
      if (got.toLowerCase() !== requested.sha256.toLowerCase()) {
        throw new Error(
          `Checksum mismatch for ${requested.filename}: expected ${requested.sha256}, got ${got}`,
        );
      }
    }

    await fsp.rename(partial, dest);
  } catch (err) {
    // Make sure no `.partial` artifact survives a failed download/verify.
    // Surface secondary unlink failures (e.g. Windows EBUSY) as warnings
    // so an accumulating .partial pile shows up in operator logs. See
    await fsp.unlink(partial).catch((unlinkErr: unknown) => {
      console.warn(
        `[downloadModel] failed to remove .partial ${partial} after download error:`,
        unlinkErr,
      );
    });
    throw err;
  }

  // Vision-GGUF mmproj second-leg download. Conceptually one
  // logical install: if the projector fails to download (or fails
  // checksum), we DELETE the already-successful weights file too —
  // a vision sidecar started against weights-without-projector
  // loads as a text-only model and hangs forever on vision
  // requests. Better to leave the slot empty than leave it
  // half-installed. The cleanup of `dest` is best-effort (logged on
  // failure) because the primary error from the projector download
  // is what the user actually needs to see.
  let mmprojResult: { path: string; sha256: string | null; sizeMb: number | undefined } | null =
    null;
  if (requested.mmprojUrl && requested.mmprojFilename) {
    const mmprojDest = path.join(dir, requested.mmprojFilename);
    const mmprojPartial = `${mmprojDest}.partial`;
    try {
      await fetcher(
        requested.mmprojUrl,
        (downloaded, total) => {
          const mmprojPart =
            total > 0 ? Math.min(downloaded, total) : downloaded;
          // Offset by the (already complete) main weights so the
          // combined progress bar continues monotonically from the
          // main download's terminal value.
          const cumulative = mainBytes + mmprojPart;
          const totalForReport =
            combinedBytes > 0
              ? combinedBytes
              : total > 0
                ? mainBytes + total
                : mainBytes + mmprojBytes;
          const totalMb = totalForReport / (1024 * 1024);
          const downloadedMb = cumulative / (1024 * 1024);
          const percent =
            totalForReport > 0 ? (cumulative / totalForReport) * 100 : 0;
          onProgress({
            modelId: requested.id,
            capability: requested.capability,
            format: requested.format,
            // Report the projector's filename so renderer-side log
            // strings ("Downloading mmproj…") can tell which file
            // is in flight without a separate event type.
            filename: requested.mmprojFilename!,
            downloadedMb,
            totalMb,
            percent,
          });
        },
        mmprojPartial,
        deps.signal,
      );
      if (requested.mmprojSha256) {
        const got = await hasher(mmprojPartial);
        if (got.toLowerCase() !== requested.mmprojSha256.toLowerCase()) {
          throw new Error(
            `Checksum mismatch for mmproj ${requested.mmprojFilename}: expected ${requested.mmprojSha256}, got ${got}`,
          );
        }
      }
      await fsp.rename(mmprojPartial, mmprojDest);
      mmprojResult = {
        path: mmprojDest,
        sha256: requested.mmprojSha256 ?? null,
        sizeMb: requested.mmprojSizeMb,
      };
    } catch (err) {
      // Clean up both the mmproj partial AND the successful main
      // weights so the slot returns to an empty state. Either file
      // surviving would either (a) trick the next download into
      // the already-installed fast path or (b) leave a half-install
      // the vision sidecar can't use.
      await fsp.unlink(mmprojPartial).catch((unlinkErr: unknown) => {
        console.warn(
          `[downloadModel] failed to remove mmproj .partial ${mmprojPartial} after error:`,
          unlinkErr,
        );
      });
      await fsp.unlink(dest).catch((unlinkErr: unknown) => {
        console.warn(
          `[downloadModel] failed to remove main weights ${dest} after mmproj failure (slot may be half-installed; next deleteCurrentModel will sweep):`,
          unlinkErr,
        );
      });
      throw err;
    }
  }


  // MLX models ship as `.tar.gz` archives that expand into a directory
  // (config.json, weights/, tokenizer, etc.) consumed by the MLX adapter.
  // GGUF models are a single file already usable by llama-server.
  // Extracting at download time — instead of on every runtime start —
  // preserves the single-model-on-disk invariant (the archive is removed
  // after a successful extract, so we don't keep both the .tar.gz and the
  // expanded directory) and makes `InstalledModelRecord.path` point
  // directly at the artifact the runtime actually loads from.
  let installedPath = dest;
  if (isTarGz(requested.filename)) {
    const extractor = deps.extractTarGz ?? defaultExtractTarGz;
    const extractDirName = stripTarGzSuffix(requested.filename);
    const extractDir = path.join(dir, extractDirName);
    // Wipe any stale extract directory from a previous failed attempt so
    // we don't merge mismatched contents into the new install. (We are
    // inside the download lock here, so this is safe.)
    await fsp.rm(extractDir, { recursive: true, force: true });
    await fsp.mkdir(extractDir, { recursive: true });
    try {
      await extractor(dest, extractDir);
    } catch (err) {
      await fsp.rm(extractDir, { recursive: true, force: true });
      // Surface secondary unlink failures as warnings — the primary
      // error (extraction) is re-thrown below, but a silently leaked
      // archive would violate the single-model-on-disk invariant. See
      await fsp.unlink(dest).catch((unlinkErr: unknown) => {
        console.warn(
          `[downloadModel] failed to remove archive ${dest} after extraction error:`,
          unlinkErr,
        );
      });
      throw err;
    }
    // Delete the source archive: the extracted directory is the
    // canonical on-disk representation from this point forward, and the
    // manifest's `diskSizeMb` is the post-extract footprint.
    // If this unlink fails (transient Windows EPERM/EBUSY, a virus
    // scanner holding the file, etc.) we DON'T fail the install — the
    // model is already on disk and usable — but we DO log a warning
    // (instead of silently swallowing) so the failure is visible. The
    // next `deleteCurrentModel` call will sweep the stray archive via
    // the defensive cleanup in `deleteCurrentModelUnlocked`, so the
    // single-model invariant is eventually restored without user
    // action.
    await fsp.unlink(dest).catch((unlinkErr: unknown) => {
      console.warn(
        `[downloadModel] failed to remove source archive ${dest} after successful extraction; stray archive will be reaped on next deleteCurrentModel:`,
        unlinkErr,
      );
    });
    installedPath = extractDir;
  }

  const record: InstalledModelRecord = {
    modelId: requested.id,
    capability,
    format: requested.format,
    filename: requested.filename,
    path: installedPath,
    downloadSizeMb: requested.downloadSizeMb,
    diskSizeMb: requested.diskSizeMb,
    sha256: requested.sha256,
    downloadedAt: nowFn().toISOString(),
  };
  if (mmprojResult) {
    record.mmprojPath = mmprojResult.path;
    record.mmprojSha256 = mmprojResult.sha256;
    if (mmprojResult.sizeMb !== undefined) {
      record.mmprojSizeMb = mmprojResult.sizeMb;
    }
  }
  await writeCurrentModel(userDataDir, capability, record);
  return record;
}

function isTarGz(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith(".tar.gz") || lower.endsWith(".tgz");
}

function stripTarGzSuffix(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz")) return filename.slice(0, -".tar.gz".length);
  if (lower.endsWith(".tgz")) return filename.slice(0, -".tgz".length);
  return filename;
}

/**
 * Default tar+gzip extractor. Uses the pure-JS `tar` package so we don't
 * depend on a system `tar` / `bsdtar` binary (Windows ships bsdtar on
 * recent builds but it's not guaranteed in older fleets). The library
 * streams gunzip-then-untar so we don't materialise the decompressed
 * archive in memory.
 */
const defaultExtractTarGz: NonNullable<DownloadDeps["extractTarGz"]> = async (
  archivePath,
  destDir,
) => {
  await tar.x({ file: archivePath, cwd: destDir });
};

// --- Testing hooks ------------------------------------------------------

/**
 * Reset cached manifest. Tests call this between fixtures.
 */
export function resetManifestCache(): void {
  cachedManifest = null;
}

/**
 * Drop any in-flight download-lock chains. Production callers should never
 * touch this; tests call it in `beforeEach` to make sure no stale Promise
 * from a previous test serializes the next one.
 */
export function resetDownloadLocks(): void {
  downloadLocks.clear();
}
