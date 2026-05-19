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
  diskSizeMb: number;
  sha256: string | null;
  downloadedAt: string;
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
      return arch === "arm64" || arch === "aarch64" ? "linux-arm64" : "linux-x64";
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

export function hasNvidiaGpu(): boolean {
  const cmd = process.platform === "win32" ? "nvidia-smi.exe" : "nvidia-smi";
  return commandExists(cmd);
}

export function hasVulkan(): boolean {
  if (commandExists("vulkaninfo", ["--summary"])) return true;
  const candidates =
    process.platform === "linux"
      ? [
          "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
          "/usr/lib64/libvulkan.so.1",
          "/usr/lib/libvulkan.so.1",
        ]
      : process.platform === "win32"
        ? ["C:\\Windows\\System32\\vulkan-1.dll"]
        : process.platform === "darwin"
          ? ["/usr/local/lib/libvulkan.dylib", "/opt/homebrew/lib/libvulkan.dylib"]
          : [];
  return candidates.some((p) => fs.existsSync(p));
}

export function hasRocm(): boolean {
  if (process.platform !== "linux") return false;
  return fs.existsSync("/opt/rocm") || fs.existsSync("/opt/rocm-dkms");
}

export function detectComputeBackends(): ComputeBackend[] {
  const backends: ComputeBackend[] = ["cpu"];
  const p = detectPlatform();
  if (p === "macos-apple-silicon") backends.push("metal");
  if (hasNvidiaGpu()) backends.push("cuda");
  if (hasVulkan()) backends.push("vulkan");
  if (hasRocm()) backends.push("rocm");
  return backends;
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

export function loadManifest(forceReload = false): ModelManifest {
  const p = manifestPath();
  if (!forceReload && cachedManifest && cachedManifest.path === p) {
    return cachedManifest.manifest;
  }
  const raw = fs.readFileSync(p, "utf8");
  const manifest = JSON.parse(raw) as ModelManifest;
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

export async function getCurrentModel(
  userDataDir: string,
): Promise<InstalledModelRecord | null> {
  try {
    const raw = await fsp.readFile(activeModelPath(userDataDir), "utf8");
    return JSON.parse(raw) as InstalledModelRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
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
  await fsp.writeFile(p, JSON.stringify(record, null, 2));
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
  const netDelta = requested.downloadSizeMb - current.downloadSizeMb;
  return {
    kind: "swap",
    evictModelId: current.modelId,
    evictFilename: current.filename,
    evictSizeMb: current.downloadSizeMb,
    installModelId: requested.id,
    installFilename: requested.filename,
    installSizeMb: requested.downloadSizeMb,
    netDiskDeltaMb: netDelta,
    message: `Current: ${current.modelId} (${current.downloadSizeMb} MB). New: ${requested.name} (${requested.downloadSizeMb} MB). This will remove ${current.filename} to save ${current.downloadSizeMb} MB and download ${requested.downloadSizeMb} MB.`,
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
}

const defaultFetcher: NonNullable<DownloadDeps["fetcher"]> = async (
  url,
  onProgress,
  destPath,
) => {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Download failed: HTTP ${resp.status}`);
  }
  const totalHeader = resp.headers.get("content-length");
  const total = totalHeader ? parseInt(totalHeader, 10) : 0;
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("Empty response body");
  const tmpHandle = await fsp.open(destPath, "w");
  let downloaded = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        await tmpHandle.write(value);
        downloaded += value.byteLength;
        onProgress(downloaded, total);
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
 * Delete the currently installed model file (if any) and clear the active
 * model record.
 */
export async function deleteCurrentModel(userDataDir: string): Promise<void> {
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
  await writeCurrentModel(userDataDir, null);
}

/**
 * Download the requested model, enforcing single-model storage. If a
 * different model is currently installed it is deleted FIRST. After
 * download we verify SHA256 (when the manifest provides one).
 */
export async function downloadModel(
  userDataDir: string,
  requested: ResolvedModel,
  onProgress: (p: DownloadProgress) => void,
  deps: DownloadDeps = {},
): Promise<InstalledModelRecord> {
  const fetcher = deps.fetcher ?? defaultFetcher;
  const hasher = deps.hasher ?? defaultHasher;
  const nowFn = deps.now ?? (() => new Date());

  const current = await getCurrentModel(userDataDir);
  if (current && current.modelId === requested.id) {
    // Already installed — return existing record without re-downloading.
    return current;
  }
  if (current) {
    await deleteCurrentModel(userDataDir);
  }

  const dir = modelsDir(userDataDir);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, requested.filename);

  await fetcher(
    requested.url,
    (downloaded, total) => {
      const totalMb = total > 0 ? total / (1024 * 1024) : requested.downloadSizeMb;
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
    dest,
  );

  if (requested.sha256) {
    const got = await hasher(dest);
    if (got.toLowerCase() !== requested.sha256.toLowerCase()) {
      await fsp.unlink(dest).catch(() => {});
      throw new Error(
        `Checksum mismatch for ${requested.filename}: expected ${requested.sha256}, got ${got}`,
      );
    }
  }

  const record: InstalledModelRecord = {
    modelId: requested.id,
    format: requested.format,
    filename: requested.filename,
    path: dest,
    downloadSizeMb: requested.downloadSizeMb,
    diskSizeMb: requested.diskSizeMb,
    sha256: requested.sha256,
    downloadedAt: nowFn().toISOString(),
  };
  await writeCurrentModel(userDataDir, record);
  return record;
}

/**
 * Swap to a different model. Equivalent to `downloadModel` but explicitly
 * named — the underlying enforcement is identical.
 */
export async function swapModel(
  userDataDir: string,
  requested: ResolvedModel,
  onProgress: (p: DownloadProgress) => void,
  deps: DownloadDeps = {},
): Promise<InstalledModelRecord> {
  return downloadModel(userDataDir, requested, onProgress, deps);
}

// --- Testing hooks ------------------------------------------------------

/**
 * Reset cached manifest. Tests call this between fixtures.
 */
export function resetManifestCache(): void {
  cachedManifest = null;
}
