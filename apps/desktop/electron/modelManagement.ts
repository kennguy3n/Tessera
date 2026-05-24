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

export interface ManifestModel {
  id: string;
  name: string;
  parameters: string;
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

export interface ModelManifest {
  format_version: number;
  note?: string;
  models: ManifestModel[];
  llama_server?: ManifestLlamaServer;
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
}

export interface InstalledModelRecord {
  modelId: string;
  format: ModelFormat;
  filename: string;
  path: string;
  downloadSizeMb: number;
  // Records written before `diskSizeMb` was introduced won't have this
  // field. Read via `effectiveDiskSizeMb(record)` so the swap accounting
  // stays correct for legacy installs.
  diskSizeMb?: number;
  sha256: string | null;
  downloadedAt: string;
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
 * Locate the manifest. Order:
 *   1. TESSERA_MODELS_MANIFEST env var (tests, dev override).
 *   2. <resources>/sidecars/models.json (packaged app).
 *   3. <cwd>/sidecars/models.json (npm run dev).
 */
export function manifestPath(): string {
  if (process.env.TESSERA_MODELS_MANIFEST) {
    return process.env.TESSERA_MODELS_MANIFEST;
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
  }
  if (errors.length > 0) {
    throw new ManifestValidationError(
      `models.json failed validation:\n  - ${errors.join("\n  - ")}`,
    );
  }
  return manifest;
}

export function loadManifest(forceReload = false): ModelManifest {
  const p = manifestPath();
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

function formatLabel(f: ModelFormat): string {
  return f === "mlx" ? "MLX 2-bit" : "GGUF Q1_0_g128";
}

function toResolvedModel(entry: ManifestModel, target: Platform): ResolvedModel {
  return {
    id: entry.id,
    name: entry.name,
    parameters: entry.parameters,
    format: entry.format,
    formatLabel: formatLabel(entry.format),
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
}

export function listModelsForPlatform(
  manifest: ModelManifest,
  target: Platform,
): ResolvedModel[] {
  const preferred = preferredFormatFor(target);
  const out: ResolvedModel[] = [];
  for (const m of manifest.models) {
    if (m.format !== preferred) continue;
    const resolved = resolveManifestPlatform(m.platform, target);
    if (!resolved) continue;
    out.push(toResolvedModel(m, resolved));
  }
  return out;
}

export function recommendModel(
  manifest: ModelManifest,
  target: Platform,
  tier: DeviceTier,
): ResolvedModel | null {
  const models = listModelsForPlatform(manifest, target);
  return models.find((m) => m.tier === tier) ?? models[0] ?? null;
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

// --- Single-model enforcement -------------------------------------------

/**
 * On-disk layout, anchored at the host-provided `userDataDir`.
 *
 *   <userDataDir>/active-model.json   ← currently-installed record (or absent)
 *   <userDataDir>/models/<filename>   ← the single model file/dir on disk
 */
export function modelsDir(userDataDir: string): string {
  return path.join(userDataDir, "models");
}

export function activeModelPath(userDataDir: string): string {
  return path.join(userDataDir, "active-model.json");
}

/**
 * Read the active-model.json record from disk.
 *
 * Returns `null` if the file does not exist (no model installed yet) OR
 * if the file exists but is unparseable JSON. Corruption is treated as
 * "no record" and the offending file is moved aside to a timestamped
 * `.corrupt-<ts>` sibling so the user can re-download without manual
 * filesystem surgery, the next `downloadModel` call clears the slot,
 * and an operator can still recover the original bytes from disk for
 * forensic purposes.
 *
 * IO errors other than ENOENT (permission denied, etc.) are propagated
 * because they need explicit operator attention and silently masking
 * them would hide real disk faults.
 */
/**
 * Single source of truth for "what model is actually installed and
 * usable right now?" — model-id-agnostic. Returns the live record only
 * if the on-disk file referenced by `active-model.json` still exists;
 * otherwise returns `null`.
 *
 * Used by:
 *   - `runtime:planDownload` IPC, so a stale `active-model.json`
 *     pointing at a manually-deleted file no longer makes the planner
 *     return `already-installed` .
 *   - `isModelInstalled(modelId)` below, which is a thin model-id
 *     filter over this.
 *
 * The active-model record can drift from reality if a user manually
 * deleted the file or a disk error removed it, so an existence check is
 * part of the "installed" definition — concentrating it here means
 * every caller picks up new criteria (e.g. checksum-on-disk, or "file
 * is a directory but its expected contents are missing" for MLX)
 * uniformly.
 */
export async function getInstalledModel(
  userDataDir: string,
): Promise<InstalledModelRecord | null> {
  const current = await getCurrentModel(userDataDir);
  if (!current) return null;
  if (!fs.existsSync(current.path)) return null;
  return current;
}

/**
 * Single source of truth for "is `modelId` specifically the model that's
 * actually installed and usable right now?". Composes on top of
 * `getInstalledModel` so the file-exists definition can only live in
 * one place.
 *
 * Used by both the IPC fast-path (`runtime:downloadModel` — skip
 * sidecar restart when no download is needed) and by
 * `downloadModelLocked` itself (skip download when the requested model
 * is already on disk).
 */
export async function isModelInstalled(
  userDataDir: string,
  modelId: string,
): Promise<InstalledModelRecord | null> {
  const live = await getInstalledModel(userDataDir);
  if (!live) return null;
  if (live.modelId !== modelId) return null;
  return live;
}

export async function getCurrentModel(
  userDataDir: string,
): Promise<InstalledModelRecord | null> {
  const p = activeModelPath(userDataDir);
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
    try {
      await fsp.rename(p, backupPath);
      console.warn(
        `[tessera] active-model.json was unparseable JSON; moved to ${backupPath}. ` +
          `Returning null so the next model operation starts clean. Parse error: ${(parseErr as Error).message}`,
      );
    } catch (renameErr) {
      console.warn(
        `[tessera] active-model.json was unparseable JSON and could not be backed up ` +
          `(${(renameErr as Error).message}); leaving the file in place and returning null. ` +
          `Parse error: ${(parseErr as Error).message}`,
      );
    }
    return null;
  }
}

async function writeCurrentModel(
  userDataDir: string,
  record: InstalledModelRecord | null,
): Promise<void> {
  const p = activeModelPath(userDataDir);
  if (record === null) {
    try {
      await fsp.unlink(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await atomicWriteJson(p, record);
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

export interface DownloadProgress {
  modelId: string;
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
  ) => Promise<{ totalBytes: number }>;
  hasher?: (filePath: string) => Promise<string>;
  now?: () => Date;
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

const defaultFetcher: NonNullable<DownloadDeps["fetcher"]> = async (
  url,
  onProgress,
  destPath,
) => {
  const resp = await fetch(url);
  if (!resp.ok) {
    // Cancel the response body so undici releases the underlying TCP
    // socket immediately instead of waiting for the `Response` to be
    // garbage-collected. Without this, a CDN returning repeated
    // 4xx/5xx errors during a retry loop would accumulate unclosed
    // sockets until the next GC cycle. We `.catch(() => {})` because
    // cancel() can throw if the body has already been consumed or the
    // connection is already closed, and we don't want a secondary
    // failure to mask the original HTTP-status error.
    await resp.body?.cancel().catch(() => undefined);
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }
  const totalHeader = resp.headers.get("content-length");
  const total = totalHeader ? parseInt(totalHeader, 10) : 0;
  if (!resp.body) throw new Error("Empty response body");

  // Open the destination file BEFORE acquiring the reader. Previously
  // we called `resp.body.getReader()` first and then `fsp.open(...)`,
  // which created a leak window: if `fsp.open` threw (permission
  // denied, disk full, EACCES, ENOSPC, ...), the reader had already
  // taken an exclusive lock on the response body and was never
  // released, leaving the HTTP socket open until GC. Doing IO in this
  // order means a failed file-open simply aborts before any reader
  // exists, and the response body is consumed (and the connection
  // released back to the pool) on the next event-loop turn via the
  // usual GC path.
  const tmpHandle = await fsp.open(destPath, "w");
  let downloaded = 0;
  // Nested try/finally so the file handle is closed even if the very
  // next operation (`resp.body.getReader()`) throws. Per the WHATWG
  // Streams spec `getReader()` only throws synchronously when the
  // stream is already locked — unreachable for a just-received fetch
  // response in practice — but the outer try/finally costs us nothing
  // and eliminates the theoretical leak window entirely. Combined with
  // the inner reader.cancel() in `finally`, the function now has no
  // resource paths that can leak on either expected or surprise
  // failures.
  try {
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await tmpHandle.write(value);
          downloaded += value.byteLength;
          // `onProgress` is wrapped at the `downloadModel` boundary
          // (see `wrapProgressNoThrow`) so even a destroyed-BrowserWindow
          // throw or a buggy custom callback cannot abort the byte
          // pump. We just call it normally here.
          onProgress(downloaded, total);
        }
      }
    } finally {
      // Always release the body reader so the underlying HTTP
      // connection can be returned to the pool, even on read errors
      // mid-stream. `reader.cancel()` both releases the lock AND
      // aborts the response body, which is what we want — we don't
      // need any further bytes.
      try {
        await reader.cancel();
      } catch {
        // ignore — reader may already be in a terminal state
      }
    }
  } finally {
    await tmpHandle.close();
  }
  return { totalBytes: downloaded };
};

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
 * Internal: delete the currently installed model file (if any) and clear
 * the active model record. Must only be called from within
 * `withDownloadLock` because it mutates the same shared on-disk state
 * (`active-model.json` + the model file) that `downloadModelLocked`
 * mutates. Recursive locking would deadlock the per-userDataDir promise
 * chain, so the lock is acquired at the public-API boundary only.
 */
async function deleteCurrentModelUnlocked(userDataDir: string): Promise<void> {
  const current = await getCurrentModel(userDataDir);
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
  await writeCurrentModel(userDataDir, null);
}

/**
 * Delete the currently installed model file (if any) and clear the active
 * model record.
 *
 * Serialized through the same per-`userDataDir` download lock as
 * `downloadModel` so the on-disk contract is "all model-file mutations
 * are mutually exclusive". Without the lock, the previous version
 * relied on Node's cooperative scheduling to keep a concurrent
 * `downloadModel` from clobbering or being clobbered by an in-flight
 * `delete` — that's correct today but fragile and breaks the moment
 * model management moves to a worker thread, an Electron utility
 * process, or any other parallel-execution context. The lock makes the
 * invariant explicit instead of implicit.
 */
export async function deleteCurrentModel(
  userDataDir: string,
  deps: DeleteDeps = {},
): Promise<void> {
  return withDownloadLock(userDataDir, async () => {
    // No-op fast path INSIDE the lock: if there is no installed model
    // we must not invoke `beforeMutation` at all (calling
    // `stopSidecarIfRunning()` for a no-op delete would needlessly
    // tear down a sidecar that's currently serving a *different*
    // model the user hasn't asked to delete — which would be the
    // case if `active-model.json` was already cleared but the user
    // double-clicked Delete from a stale UI). Reading
    // `getCurrentModel` here is cheap (one JSON file read) compared
    // to the sidecar-stop it gates.
    const current = await getCurrentModel(userDataDir);
    if (!current) return;
    if (deps.beforeMutation) {
      await deps.beforeMutation();
    }
    return deleteCurrentModelUnlocked(userDataDir);
  });
}

// --- Concurrency guard ---------------------------------------------------
// `downloadModel` mutates shared on-disk state: it reads `active-model.json`,
// optionally deletes the existing model file, downloads to a `.partial`
// sibling, verifies the checksum, and atomically renames it into place.
// Without serialization, two concurrent calls (rapid double-click, two
// renderer windows, two IPC channels racing) could BOTH pass the
// `current.modelId === requested.id` check, both call `deleteCurrentModel`,
// and both fight over the same destination filename — leaving the on-disk
// state inconsistent with `active-model.json`.
// We serialize per Electron main process. Hardware downloads are slow
// (hundreds of MB), so a single in-flight Promise chain is the simplest
// correct primitive — every new caller awaits the tail of the chain and
// then runs. The lock is keyed by `userDataDir` so unit tests using
// different temp dirs don't accidentally block each other.
const downloadLocks = new Map<string, Promise<unknown>>();

function withDownloadLock<T>(
  userDataDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = downloadLocks.get(userDataDir) ?? Promise.resolve();
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
  downloadLocks.set(userDataDir, swallowed);
  // Clean up the slot once this call settles AND it's still the tail of
  // the chain. We can't unconditionally delete because another caller may
  // have already chained onto `swallowed`.
  swallowed.finally(() => {
    if (downloadLocks.get(userDataDir) === swallowed) {
      downloadLocks.delete(userDataDir);
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
  return withDownloadLock(userDataDir, () =>
    downloadModelLocked(userDataDir, requested, safeProgress, deps),
  );
}

async function downloadModelLocked(
  userDataDir: string,
  requested: ResolvedModel,
  onProgress: (p: DownloadProgress) => void,
  deps: DownloadDeps,
): Promise<InstalledModelRecord> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const hasher = deps.hasher ?? defaultHasher;
  const nowFn = deps.now ?? (() => new Date());

  // Fast path: requested model is already installed AND its file is
  // still on disk. `isModelInstalled` is the single source of truth for
  // that definition — the IPC fast-path in apps/desktop/electron/ipc.ts
  // calls the same helper, so the two checks can no longer drift.
  const alreadyInstalled = await isModelInstalled(userDataDir, requested.id);
  if (alreadyInstalled) {
    return alreadyInstalled;
  }
  // Not the fast path — we will mutate the filesystem. Run the
  // pre-mutation hook (e.g. sidecar-stop) exactly once now, INSIDE
  // the lock, so the entire `(stop → evict → download → commit)`
  // sequence is serialised against any other download/delete on this
  // `userDataDir`. Skipped on the already-installed fast path above,
  // and called BEFORE the eviction branch so callers can rely on
  // "no filesystem mutation has happened yet" when the hook fires.
  if (deps.beforeMutation) {
    await deps.beforeMutation();
  }

  // If a *stale* record exists (right model id but file missing, OR
  // a different model entirely), clean it up first so the
  // post-download `writeCurrentModel` writes a clean state instead
  // of merging with the stale one.
  const current = await getCurrentModel(userDataDir);
  if (current) {
    if (current.modelId === requested.id) {
      // File missing under us — clear only the record; there is no
      // file to delete.
      await writeCurrentModel(userDataDir, null);
    } else {
      // Different model installed — evict it. We're already inside
      // `withDownloadLock` for this `userDataDir`, so call the
      // unlocked variant — going through the public locked
      // `deleteCurrentModel` would deadlock the per-userDataDir
      // promise chain (it would queue behind the very call that's
      // awaiting it). Do NOT pass `deps.beforeMutation` through
      // either: we already called it above, and calling it again
      // here would double-invoke the sidecar-stop for the swap
      // path.
      await deleteCurrentModelUnlocked(userDataDir);
    }
  }

  const dir = modelsDir(userDataDir);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, requested.filename);
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
        const totalMb =
          total > 0 ? total / (1024 * 1024) : requested.downloadSizeMb;
        const downloadedMb = downloaded / (1024 * 1024);
        const percent = total > 0 ? (downloaded / total) * 100 : 0;
        onProgress({
          modelId: requested.id,
          format: requested.format,
          filename: requested.filename,
          downloadedMb,
          totalMb,
          percent,
        });
      },
      partial,
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
    format: requested.format,
    filename: requested.filename,
    path: installedPath,
    downloadSizeMb: requested.downloadSizeMb,
    diskSizeMb: requested.diskSizeMb,
    sha256: requested.sha256,
    downloadedAt: nowFn().toISOString(),
  };
  await writeCurrentModel(userDataDir, record);
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
