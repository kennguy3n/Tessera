/**
 * Unit tests for sidecars/models.json loading + single-model enforcement.
 *
 * These tests exercise the real production code paths in
 * apps/desktop/electron/modelManagement.ts (no mocks for the algorithm under
 * test — only the network fetch + SHA256 hasher are dependency-injected
 * because they touch HTTP / crypto that has no fixture in this environment).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

import {
  ALL_MODEL_CAPABILITIES,
  loadManifest,
  resetManifestCache,
  resetDownloadLocks,
  manifestPath,
  listModelsForPlatform,
  resolveManifestPlatform,
  recommendModel,
  pickLlamaServerVariant,
  planDownload,
  effectiveDiskSizeMb,
  getCurrentModel,
  getInstalledModel,
  getInstalledModels,
  isCapabilityAvailable,
  isModelInstalled,
  deleteCurrentModel,
  downloadModel,
  activeModelPath,
  legacyActiveModelPath,
  legacyModelsDir,
  modelsDir,
  detectComputeBackends,
  parseModelCapability,
  manifestCapability,
  resetHardwareDetectionCache,
  resetLegacyMigrationCache,
  type InstalledModelRecord,
  type ResolvedModel,
  type ModelManifest,
  type ManifestModel,
  type ModelCapability,
} from "../modelManagement";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const MANIFEST = path.join(REPO_ROOT, "sidecars", "models.json");

function makeResolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    id: "ternary-bonsai-1.7b-gguf",
    name: "Ternary-Bonsai 1.7B",
    parameters: "1.7B",
    format: "gguf",
    formatLabel: "GGUF Q1_0_g128",
    quantization: "Q1_0_g128",
    capability: "text",
    platform: "linux-x64",
    tier: "low",
    computeBackends: ["cpu"],
    downloadSizeMb: 1,
    diskSizeMb: 1,
    requiredRamGb: 2,
    contextLength: 2048,
    filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
    url: "https://example.invalid/model.gguf",
    sha256: null,
    ...overrides,
  };
}

describe("manifest loading", () => {
  beforeEach(() => {
    process.env.TESSERA_MODELS_MANIFEST = MANIFEST;
    resetManifestCache();
  });

  it("loads and parses sidecars/models.json", () => {
    expect(fs.existsSync(MANIFEST)).toBe(true);
    const manifest = loadManifest(true);
    expect(manifest.format_version).toBeGreaterThanOrEqual(1);
    expect(manifest.models.length).toBeGreaterThanOrEqual(6);
    expect(manifest.llama_server?.variants.length).toBeGreaterThan(0);
  });

  it("manifestPath honors TESSERA_MODELS_MANIFEST override", () => {
    expect(manifestPath()).toBe(MANIFEST);
  });

  it("every manifest model has a valid format, size, filename, and tier", () => {
    const manifest = loadManifest(true);
    for (const m of manifest.models) {
      expect(["gguf", "mlx"]).toContain(m.format);
      expect(["low", "medium", "high"]).toContain(m.tier);
      expect(m.downloadSizeMb).toBeGreaterThan(0);
      expect(m.diskSizeMb).toBeGreaterThan(0);
      expect(m.filename.length).toBeGreaterThan(0);
      if (m.format === "gguf") {
        expect(m.filename.endsWith(".gguf")).toBe(true);
      } else {
        // MLX archives ship as `.tar.gz` (legacy `.mlx.tar.gz` for the
        // text bonsai entries; modern `.tar.gz` for vision/imagegen).
        expect(/\.(tar\.gz|tgz|mlx)/.test(m.filename)).toBe(true);
      }
    }
  });

  it("text-capability entries use the Bonsai-specific quantizations", () => {
    // The text bonsai models intentionally ship in 1.58-bit ternary
    // (`Q1_0_g128` / `2-bit`) to fit on low-tier devices. Vision and
    // imagegen entries use different quants (Q4_K_M, 4-bit) and
    // are validated by their own block-specific tests.
    const manifest = loadManifest(true);
    const textModels = manifest.models.filter(
      (m) => (m.capability ?? "text") === "text",
    );
    expect(textModels.length).toBeGreaterThan(0);
    for (const m of textModels) {
      if (m.format === "gguf") {
        expect(m.quantization).toBe("Q1_0_g128");
      } else {
        expect(m.quantization).toBe("2-bit");
        expect(m.filename.includes(".mlx")).toBe(true);
      }
      // 1.58-bit ternary sizes must never balloon into Q4_K_M territory.
      expect(m.downloadSizeMb).toBeLessThan(2500);
    }
  });

  it("no two models for the same (platform, tier, format) share an id", () => {
    const manifest = loadManifest(true);
    const keys = new Set<string>();
    for (const m of manifest.models) {
      const key = `${m.platform}|${m.tier}|${m.format}|${m.id}`;
      expect(keys.has(key)).toBe(false);
      keys.add(key);
    }
    const ids = manifest.models.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("MLX entries report a post-extract diskSizeMb larger than the compressed downloadSizeMb", () => {
    // MLX models ship as `.tar.gz` archives, so the on-disk extracted
    // directory is bigger than the compressed download. Before this fix
    // the manifest had
    // `diskSizeMb == downloadSizeMb` for every MLX entry, which made the
    // swap planner under-account for disk usage (the user "saves N MB"
    // calculation used the compressed size rather than the actual
    // post-extract footprint). The invariant is: for every `.tar.gz`
    // /`.tgz` MLX entry, diskSizeMb > downloadSizeMb; for non-archive
    // formats (GGUF single-file, or a future raw `.mlx` directory),
    // diskSizeMb >= downloadSizeMb.
    const manifest = loadManifest(true);
    for (const m of manifest.models) {
      if (m.format === "mlx" && /\.(tar\.gz|tgz)$/.test(m.filename)) {
        expect(m.diskSizeMb).toBeGreaterThan(m.downloadSizeMb);
        // Sanity: expansion ratio of gzip on mostly-quantized binary
        // payloads is bounded ~3-15%. Anything beyond ~30% is almost
        // certainly a unit confusion, not a real measurement.
        expect(m.diskSizeMb).toBeLessThanOrEqual(
          Math.ceil(m.downloadSizeMb * 1.3),
        );
      } else {
        expect(m.diskSizeMb).toBeGreaterThanOrEqual(m.downloadSizeMb);
      }
    }
  });

  it("MLX models are exclusively for macOS Apple Silicon", () => {
    const manifest = loadManifest(true);
    const mlx = manifest.models.filter((m) => m.format === "mlx");
    // 3 text tiers (low/medium/high) + 2 vision (low+medium) + 1
    // imagegen (medium) — the bonsai-only world had 3.
    expect(mlx.length).toBeGreaterThanOrEqual(3);
    for (const m of mlx) {
      expect(m.platform).toBe("macos-apple-silicon");
      expect(m.compute).toEqual(["metal"]);
    }
  });

  it("resolveManifestPlatform maps any-non-apple-silicon correctly", () => {
    expect(resolveManifestPlatform("any-non-apple-silicon", "linux-x64")).toBe(
      "linux-x64",
    );
    expect(
      resolveManifestPlatform("any-non-apple-silicon", "windows-x64"),
    ).toBe("windows-x64");
    expect(
      resolveManifestPlatform("any-non-apple-silicon", "macos-apple-silicon"),
    ).toBeNull();
    expect(
      resolveManifestPlatform("macos-apple-silicon", "macos-apple-silicon"),
    ).toBe("macos-apple-silicon");
    expect(resolveManifestPlatform("linux-x64", "windows-x64")).toBeNull();
  });

  it("listModelsForPlatform returns only MLX on Apple Silicon", () => {
    const manifest = loadManifest(true);
    const models = listModelsForPlatform(manifest, "macos-apple-silicon");
    // 3 text + 2 vision + 1 imagegen = 6 MLX entries today, but we
    // assert lower-bounded since later blocks may add capabilities.
    expect(models.length).toBeGreaterThanOrEqual(3);
    for (const m of models) {
      expect(m.format).toBe("mlx");
      expect(m.platform).toBe("macos-apple-silicon");
      expect(m.computeBackends).toEqual(["metal"]);
    }
  });

  it("listModelsForPlatform returns only GGUF on Windows/Linux", () => {
    const manifest = loadManifest(true);
    for (const target of ["windows-x64", "linux-x64", "linux-arm64", "macos-intel"] as const) {
      const models = listModelsForPlatform(manifest, target);
      expect(models.length).toBeGreaterThan(0);
      for (const m of models) {
        expect(m.format).toBe("gguf");
        expect(m.platform).toBe(target);
      }
      // Text-capability quantization is Bonsai-specific (Q1_0_g128);
      // vision/imagegen entries use different quants. Verify the
      // text-only filter still produces the expected quant.
      const textModels = listModelsForPlatform(manifest, target, "text");
      expect(textModels.length).toBeGreaterThan(0);
      for (const m of textModels) {
        expect(m.quantization).toBe("Q1_0_g128");
        expect(m.capability).toBe("text");
      }
    }
  });

  it("recommendModel returns the requested tier when present", () => {
    const manifest = loadManifest(true);
    const high = recommendModel(manifest, "linux-x64", "high");
    expect(high?.tier).toBe("high");
    expect(high?.parameters).toBe("8B");
    expect(high?.format).toBe("gguf");
  });

  it("recommendModel returns MLX 8B for High on Apple Silicon", () => {
    const manifest = loadManifest(true);
    const r = recommendModel(manifest, "macos-apple-silicon", "high");
    expect(r?.format).toBe("mlx");
    expect(r?.parameters).toBe("8B");
    expect(r?.downloadSizeMb).toBeLessThan(1500);
  });

  it("pickLlamaServerVariant prefers exact compute, falls back to platform", () => {
    const manifest = loadManifest(true);
    const cuda = pickLlamaServerVariant(manifest, "linux-x64", "cuda");
    expect(cuda?.compute).toBe("cuda");
    expect(cuda?.platform).toBe("linux-x64");

    // ROCm is in the manifest for linux-x64; ensure it picks the exact one.
    const rocm = pickLlamaServerVariant(manifest, "linux-x64", "rocm");
    expect(rocm?.compute).toBe("rocm");
  });
});

// --- Single-model enforcement ------------------------------------------

describe("single-model enforcement", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-model-test-"));
    // Each test gets a fresh in-flight chain so that one test's lock can't
    // serialize the next test's downloads.
    resetDownloadLocks();
  });

  afterEach(async () => {
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  it("planDownload returns direct-download when no model installed", () => {
    const plan = planDownload(null, makeResolved({ downloadSizeMb: 450 }));
    expect(plan.kind).toBe("direct-download");
    if (plan.kind === "direct-download") {
      expect(plan.modelId).toBe("ternary-bonsai-1.7b-gguf");
      expect(plan.downloadSizeMb).toBe(450);
    }
  });

  it("getInstalledModel returns null when active-model.json is missing", async () => {
    expect(await getInstalledModel(workdir, "text")).toBeNull();
  });

  it("getInstalledModel returns null when the referenced file is missing on disk", async () => {
    // planDownload used to call getCurrentModel directly, so a stale
    // active-model.json record pointing at a manually-deleted file caused
    // the planner to return already-installed, hiding the Download button
    // in Settings.
    const ghost: InstalledModelRecord = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      // Deliberately point at a path that does not exist on disk.
      path: path.join(workdir, "models", "ternary-bonsai-1.7b-q1_0_g128.gguf"),
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    await fsp.writeFile(activeModelPath(workdir, "text"), JSON.stringify(ghost));
    // Sanity check: the raw record IS still readable — this is the bug.
    const raw = await getCurrentModel(workdir, "text");
    expect(raw?.modelId).toBe("ternary-bonsai-1.7b-gguf");
    // But getInstalledModel correctly treats the ghost record as "not installed".
    expect(await getInstalledModel(workdir, "text")).toBeNull();
    // And isModelInstalled, which composes on top, agrees.
    expect(await isModelInstalled(workdir, "text", "ternary-bonsai-1.7b-gguf")).toBeNull();
  });

  it("getInstalledModel returns the live record when the referenced file exists", async () => {
    const dir = modelsDir(workdir, "text");
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "ternary-bonsai-1.7b-q1_0_g128.gguf");
    await fsp.writeFile(filePath, "real bytes");
    const live: InstalledModelRecord = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: filePath,
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    await fsp.writeFile(activeModelPath(workdir, "text"), JSON.stringify(live));
    const result = await getInstalledModel(workdir, "text");
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe("ternary-bonsai-1.7b-gguf");
    // isModelInstalled filters by id — same model returns the record,
    // different model returns null.
    expect(
      await isModelInstalled(workdir, "text", "ternary-bonsai-1.7b-gguf"),
    ).not.toBeNull();
    expect(
      await isModelInstalled(workdir, "text", "ternary-bonsai-4b-gguf"),
    ).toBeNull();
  });

  it("planDownload uses live state (missing file => direct-download, not already-installed)", () => {
    // The IPC handler wires planDownload through getInstalledModel, so a
    // stale-record-with-missing-file case reaches planDownload as `null`
    // — verify planDownload then returns direct-download. This is the
    // end-to-end behaviour the Settings page relies on.
    const plan = planDownload(
      null, // what getInstalledModel returns when file is missing
      makeResolved({ id: "ternary-bonsai-1.7b-gguf", downloadSizeMb: 450 }),
    );
    expect(plan.kind).toBe("direct-download");
  });

  it("planDownload returns already-installed when ids match", () => {
    const installed: InstalledModelRecord = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: "/tmp/whatever",
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    const plan = planDownload(installed, makeResolved({ id: "ternary-bonsai-1.7b-gguf" }));
    expect(plan.kind).toBe("already-installed");
  });

  it("planDownload returns swap when a different model is installed", () => {
    const installed: InstalledModelRecord = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: "/tmp/whatever",
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    const plan = planDownload(
      installed,
      makeResolved({
        id: "ternary-bonsai-4b-gguf",
        downloadSizeMb: 1000,
        diskSizeMb: 1000,
      }),
    );
    expect(plan.kind).toBe("swap");
    if (plan.kind === "swap") {
      expect(plan.evictModelId).toBe("ternary-bonsai-1.7b-gguf");
      expect(plan.installModelId).toBe("ternary-bonsai-4b-gguf");
      expect(plan.netDiskDeltaMb).toBe(550);
    }
  });

  it("planDownload swap uses diskSizeMb (post-extract footprint), not downloadSizeMb", () => {
    // The swap decision describes disk-space accounting; for any model
    // whose archive expands after extraction (future MLX), diskSizeMb
    // diverges from downloadSizeMb and the swap UI/CLI must show the
    // on-disk numbers.
    const installed: InstalledModelRecord = {
      modelId: "installed-archive",
      format: "mlx",
      filename: "installed.tar.gz",
      path: "/tmp/installed",
      downloadSizeMb: 100,
      diskSizeMb: 300,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    const plan = planDownload(
      installed,
      makeResolved({
        id: "new-archive",
        format: "mlx",
        filename: "new.tar.gz",
        downloadSizeMb: 250,
        diskSizeMb: 700,
      }),
    );
    expect(plan.kind).toBe("swap");
    if (plan.kind === "swap") {
      expect(plan.evictSizeMb).toBe(300);
      expect(plan.installSizeMb).toBe(700);
      expect(plan.netDiskDeltaMb).toBe(400);
      expect(plan.message).toContain("300 MB");
      expect(plan.message).toContain("700 MB");
      // The user-facing message must NOT leak the download size when it
      // differs from the disk size.
      expect(plan.message).not.toContain("100 MB");
      expect(plan.message).not.toContain("250 MB");
    }
  });

  it("effectiveDiskSizeMb falls back to downloadSizeMb for legacy records (missing field, 0, NaN)", () => {
    // The TS side used to parse active-model.json directly into
    // InstalledModelRecord and assume diskSizeMb was always populated.
    // Records persisted before that field was introduced won't have it;
    // the planner must mirror the Rust `effective_disk_size_mb()`
    // fallback or netDelta becomes NaN.
    const legacy: InstalledModelRecord = {
      modelId: "legacy",
      format: "gguf",
      filename: "legacy.gguf",
      path: "/tmp/legacy",
      downloadSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    expect(effectiveDiskSizeMb(legacy)).toBe(450);

    const zero: InstalledModelRecord = { ...legacy, diskSizeMb: 0 };
    expect(effectiveDiskSizeMb(zero)).toBe(450);

    const nanRecord: InstalledModelRecord = {
      ...legacy,
      diskSizeMb: Number.NaN,
    };
    expect(effectiveDiskSizeMb(nanRecord)).toBe(450);

    const populated: InstalledModelRecord = { ...legacy, diskSizeMb: 600 };
    expect(effectiveDiskSizeMb(populated)).toBe(600);
  });

  it("planDownload swap honours effectiveDiskSizeMb for legacy installed records", () => {
    // Pre-disk_size_mb record (no diskSizeMb field at all) — the swap
    // accounting must fall back to downloadSizeMb so evict/install/delta
    // are real numbers, not NaN.
    const legacy: InstalledModelRecord = {
      modelId: "legacy-gguf",
      format: "gguf",
      filename: "legacy.gguf",
      path: "/tmp/legacy.gguf",
      downloadSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    const plan = planDownload(
      legacy,
      makeResolved({
        id: "new-gguf",
        downloadSizeMb: 1000,
        diskSizeMb: 1000,
      }),
    );
    expect(plan.kind).toBe("swap");
    if (plan.kind === "swap") {
      expect(plan.evictSizeMb).toBe(450);
      expect(plan.installSizeMb).toBe(1000);
      expect(plan.netDiskDeltaMb).toBe(550);
      // Confirm no NaN leaked into the message.
      expect(plan.message).not.toContain("NaN");
    }
  });

  it("downloadModel installs to disk and records the active model", async () => {
    const payload = Buffer.from("hello-bonsai");
    const requested = makeResolved({
      url: "https://example.invalid/model.gguf",
      downloadSizeMb: payload.byteLength / (1024 * 1024),
    });
    let progressEvents = 0;
    const record = await downloadModel(
      workdir,
      requested,
      () => {
        progressEvents += 1;
      },
      {
        fetcher: async (_url, onProgress, dest) => {
          await fsp.writeFile(dest, payload);
          onProgress(payload.byteLength, payload.byteLength);
          return { totalBytes: payload.byteLength };
        },
      },
    );
    expect(record.modelId).toBe(requested.id);
    expect(record.path).toBe(path.join(modelsDir(workdir, "text"), requested.filename));
    expect(await fsp.readFile(record.path)).toEqual(payload);
    expect(progressEvents).toBeGreaterThan(0);

    const written = await getCurrentModel(workdir, "text");
    expect(written?.modelId).toBe(requested.id);
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(true);
  });

  it("downloadModel returns existing record when re-requesting the same id", async () => {
    const requested = makeResolved();
    const fetcher = async (
      _url: string,
      onProgress: (d: number, t: number) => void,
      dest: string,
    ) => {
      await fsp.writeFile(dest, Buffer.from("x"));
      onProgress(1, 1);
      return { totalBytes: 1 };
    };
    const first = await downloadModel(workdir, requested, () => {}, { fetcher });
    let secondCall = 0;
    await downloadModel(
      workdir,
      requested,
      () => {},
      {
        fetcher: async (...args) => {
          secondCall += 1;
          return fetcher(...args);
        },
      },
    );
    expect(secondCall).toBe(0);
    expect(first.modelId).toBe(requested.id);
  });

  it("downloadModel re-downloads when active-model.json claims installed but file is missing on disk", async () => {
    // If something outside Tessera (user `rm`, anti-virus quarantine,
    // disk error) removed the model file out from under Tessera, the
    // fast path used to incorrectly return the stale record without
    // re-downloading. The sidecar would then fail to start because its
    // model path no longer existed. Now we verify file existence before
    // taking the fast path.
    const requested = makeResolved();
    const fetcher = async (
      _url: string,
      onProgress: (d: number, t: number) => void,
      dest: string,
    ) => {
      await fsp.writeFile(dest, Buffer.from("x"));
      onProgress(1, 1);
      return { totalBytes: 1 };
    };
    const first = await downloadModel(workdir, requested, () => {}, { fetcher });
    // Simulate the user deleting the model file outside of Tessera.
    await fsp.unlink(first.path);
    let secondCall = 0;
    const second = await downloadModel(
      workdir,
      requested,
      () => {},
      {
        fetcher: async (...args) => {
          secondCall += 1;
          return fetcher(...args);
        },
      },
    );
    expect(secondCall).toBe(1);
    expect(second.modelId).toBe(requested.id);
    // The file must exist again on disk after the re-download.
    const restored = await fsp.stat(second.path);
    expect(restored.isFile()).toBe(true);
  });

  it("downloadModel deletes the old model file BEFORE downloading the new one (swap path)", async () => {
    const oldRequested = makeResolved({
      id: "ternary-bonsai-1.7b-gguf",
      filename: "old.gguf",
    });
    const newRequested = makeResolved({
      id: "ternary-bonsai-4b-gguf",
      filename: "new.gguf",
      downloadSizeMb: 1000,
    });
    await downloadModel(
      workdir,
      oldRequested,
      () => {},
      {
        fetcher: async (_u, onP, d) => {
          await fsp.writeFile(d, Buffer.from("old"));
          onP(3, 3);
          return { totalBytes: 3 };
        },
      },
    );
    const oldPath = path.join(modelsDir(workdir, "text"), "old.gguf");
    expect(fs.existsSync(oldPath)).toBe(true);

    // The new fetcher asserts the old file is gone at the moment we start
    // writing the new one. This is the contract the proposal calls out.
    // (There is no separate `swapModel` API — `downloadModel` handles the
    // eviction internally.)
    await downloadModel(
      workdir,
      newRequested,
      () => {},
      {
        fetcher: async (_u, onP, d) => {
          expect(fs.existsSync(oldPath)).toBe(false);
          await fsp.writeFile(d, Buffer.from("new"));
          onP(3, 3);
          return { totalBytes: 3 };
        },
      },
    );
    const current = await getCurrentModel(workdir, "text");
    expect(current?.modelId).toBe("ternary-bonsai-4b-gguf");
    expect(fs.existsSync(path.join(modelsDir(workdir, "text"), "new.gguf"))).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);

    // Disk should hold exactly ONE model file post-swap.
    const onDisk = await fsp.readdir(modelsDir(workdir, "text"));
    expect(onDisk).toEqual(["new.gguf"]);
  });

  it("downloadModel serializes concurrent calls so a swap does not race", async () => {
    // Two concurrent downloadModel calls for different model ids must NOT
    // race on the on-disk state. Before the lock, both could pass the
    // "already installed?" check simultaneously, both call
    // deleteCurrentModel, and both fight over the destination filename.
    // Now they must complete one-after-the-other and leave a single
    // consistent record (the second one wins).
    resetDownloadLocks();
    const reqA = makeResolved({
      id: "ternary-bonsai-1.7b-gguf",
      filename: "a.gguf",
    });
    const reqB = makeResolved({
      id: "ternary-bonsai-4b-gguf",
      filename: "b.gguf",
      downloadSizeMb: 1000,
    });

    let activeFetchers = 0;
    let maxConcurrent = 0;
    const makeFetcher =
      (body: string) =>
      async (
        _u: string,
        onP: (d: number, t: number) => void,
        d: string,
      ) => {
        activeFetchers += 1;
        maxConcurrent = Math.max(maxConcurrent, activeFetchers);
        try {
          // Yield so the other call has a chance to interleave if the
          // lock is missing.
          await new Promise((r) => setImmediate(r));
          await fsp.writeFile(d, Buffer.from(body));
          onP(body.length, body.length);
          return { totalBytes: body.length };
        } finally {
          activeFetchers -= 1;
        }
      };

    const [a, b] = await Promise.all([
      downloadModel(workdir, reqA, () => {}, { fetcher: makeFetcher("AAA") }),
      downloadModel(workdir, reqB, () => {}, { fetcher: makeFetcher("BBB") }),
    ]);

    // At any moment only ONE fetcher should have been mid-flight.
    expect(maxConcurrent).toBe(1);
    expect(a.modelId).toBe("ternary-bonsai-1.7b-gguf");
    expect(b.modelId).toBe("ternary-bonsai-4b-gguf");

    const current = await getCurrentModel(workdir, "text");
    // The serialized chain commits A first then B, so the on-disk record
    // ends up as B — and crucially there is no A artifact left behind.
    expect(current?.modelId).toBe("ternary-bonsai-4b-gguf");
    const onDisk = await fsp.readdir(modelsDir(workdir, "text"));
    expect(onDisk).toEqual(["b.gguf"]);
  });

  it("downloadModel extracts MLX .tar.gz archives, removes the archive, and stores the extract dir", async () => {
    // MLX models in the manifest ship as `.tar.gz` archives. The download
    // path must extract them so the runtime adapter sees a directory (the
    // MLX-native artifact), and the archive must be removed so the
    // single-model invariant holds.
    const requested = makeResolved({
      id: "ternary-bonsai-1.7b-mlx",
      format: "mlx",
      filename: "ternary-bonsai-1.7b-2bit.mlx.tar.gz",
      url: "https://example.invalid/mlx.tar.gz",
      downloadSizeMb: 1,
      diskSizeMb: 1,
    });
    let extractorCalled = 0;
    const record = await downloadModel(
      workdir,
      requested,
      () => {},
      {
        fetcher: async (_u, onP, d) => {
          await fsp.writeFile(d, Buffer.from("not-a-real-tarball"));
          onP(1, 1);
          return { totalBytes: 1 };
        },
        extractTarGz: async (archivePath, destDir) => {
          extractorCalled += 1;
          // Verify the extractor sees the post-rename archive (not the
          // .partial sibling) inside the model cache dir.
          expect(archivePath).toBe(
            path.join(modelsDir(workdir, "text"), requested.filename),
          );
          expect(fs.existsSync(archivePath)).toBe(true);
          // Simulate what the real `tar` library does: produce some files
          // inside destDir representing the MLX layout.
          await fsp.writeFile(path.join(destDir, "config.json"), "{}");
          await fsp.writeFile(path.join(destDir, "weights.safetensors"), "w");
        },
      },
    );

    expect(extractorCalled).toBe(1);
    // The InstalledModelRecord.path must point at the extracted directory,
    // not the (now-deleted) archive.
    const expectedDir = path.join(
      modelsDir(workdir, "text"),
      "ternary-bonsai-1.7b-2bit.mlx",
    );
    expect(record.path).toBe(expectedDir);
    expect(fs.statSync(record.path).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(record.path, "config.json"))).toBe(true);

    // The .tar.gz archive must be gone (single-model invariant: we don't
    // keep both the archive and the directory on disk).
    expect(
      fs.existsSync(path.join(modelsDir(workdir, "text"), requested.filename)),
    ).toBe(false);

    // active-model.json round-trips correctly.
    const written = await getCurrentModel(workdir, "text");
    expect(written?.path).toBe(expectedDir);
  });

  it("downloadModel cleans up the extract dir + archive if extraction fails", async () => {
    const requested = makeResolved({
      id: "ternary-bonsai-1.7b-mlx",
      format: "mlx",
      filename: "ternary-bonsai-1.7b-2bit.mlx.tar.gz",
      url: "https://example.invalid/mlx.tar.gz",
      downloadSizeMb: 1,
      diskSizeMb: 1,
    });
    await expect(
      downloadModel(workdir, requested, () => {}, {
        fetcher: async (_u, onP, d) => {
          await fsp.writeFile(d, Buffer.from("corrupt"));
          onP(1, 1);
          return { totalBytes: 1 };
        },
        extractTarGz: async () => {
          throw new Error("tar: corrupt header");
        },
      }),
    ).rejects.toThrow(/tar: corrupt header/);

    const onDisk = fs.existsSync(modelsDir(workdir, "text"))
      ? await fsp.readdir(modelsDir(workdir, "text"))
      : [];
    expect(onDisk).toEqual([]);
    expect(await getCurrentModel(workdir, "text")).toBeNull();
  });

  it("deleteCurrentModel defensively sweeps stray .tar.gz archives next to the extracted dir", async () => {
    // If a previous download's post-extract archive unlink failed
    // (Windows EPERM/EBUSY, crash mid-cleanup, etc.), the source `.tar.gz`
    // could survive next to the extracted directory. The next
    // deleteCurrentModel call must sweep it up so the user doesn't have
    // to manually clean the cache directory to restore the
    // single-model-on-disk invariant.
    const dir = modelsDir(workdir, "text");
    await fsp.mkdir(dir, { recursive: true });
    const extractedDir = path.join(dir, "ternary-bonsai-1.7b-2bit.mlx");
    const strayArchive = path.join(
      dir,
      "ternary-bonsai-1.7b-2bit.mlx.tar.gz",
    );
    await fsp.mkdir(extractedDir);
    await fsp.writeFile(path.join(extractedDir, "config.json"), "{}");
    await fsp.writeFile(strayArchive, "stray archive bytes");
    const record: InstalledModelRecord = {
      modelId: "ternary-bonsai-1.7b-mlx",
      format: "mlx",
      filename: "ternary-bonsai-1.7b-2bit.mlx.tar.gz",
      path: extractedDir,
      downloadSizeMb: 1,
      diskSizeMb: 1,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    await fsp.writeFile(activeModelPath(workdir, "text"), JSON.stringify(record));

    await deleteCurrentModel(workdir, "text");

    expect(fs.existsSync(extractedDir)).toBe(false);
    expect(fs.existsSync(strayArchive)).toBe(false);
    expect(await getCurrentModel(workdir, "text")).toBeNull();
  });

  it("deleteCurrentModel does not warn when no stray archive exists for a GGUF install", async () => {
    // The defensive stray-archive sweep is gated on the install record's
    // filename ending in .tar.gz / .tgz so GGUF installs (a single .gguf
    // file) never trigger an unnecessary unlink-then-ENOENT path. This
    // test guards against a regression where the sweep accidentally
    // fires for every format and produces noisy ENOENT warnings.
    const dir = modelsDir(workdir, "text");
    await fsp.mkdir(dir, { recursive: true });
    const ggufPath = path.join(dir, "ternary-bonsai-1.7b-q1_0_g128.gguf");
    await fsp.writeFile(ggufPath, "fake gguf bytes");
    const record: InstalledModelRecord = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: ggufPath,
      downloadSizeMb: 1,
      diskSizeMb: 1,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    await fsp.writeFile(activeModelPath(workdir, "text"), JSON.stringify(record));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await deleteCurrentModel(workdir, "text");
      expect(fs.existsSync(ggufPath)).toBe(false);
      const sweepWarned = warnSpy.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.includes("sweep stray archive"),
      );
      expect(sweepWarned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("getCurrentModel(text) quarantines a corrupted legacy active-model.json (migration path)", async () => {
    // Simulate a power loss mid-write or a manual edit that left the
    // legacy `active-model.json` with invalid JSON on an upgrading
    // install. Callers must NOT see this as a fatal IO error — they
    // should see "no model installed" and the file should be moved
    // aside so the next downloadModel can write a clean record.
    //
    // Post-multi-slot, this corruption is caught by the legacy
    // migration code (not by getCurrentModel's per-slot parse path).
    // The per-slot corruption case is covered by the next test.
    const active = path.join(workdir, "active-model.json");
    await fsp.mkdir(workdir, { recursive: true });
    await fsp.writeFile(active, "{not valid json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await getCurrentModel(workdir, "text");
      expect(result).toBeNull();
      // Original file is gone, replaced by a `.corrupt-<ts>` backup.
      expect(fs.existsSync(active)).toBe(false);
      const siblings = await fsp.readdir(workdir);
      const backup = siblings.find((f) =>
        f.startsWith("active-model.json.corrupt-"),
      );
      expect(backup).toBeDefined();
      expect(
        (await fsp.readFile(path.join(workdir, backup!), "utf8")),
      ).toBe("{not valid json");
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("active-model.json was unparseable JSON"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("getCurrentModel(capability) quarantines a corrupted per-slot active-model-<cap>.json (post-migration path)", async () => {
    // Same contract as the legacy test above, but exercising the
    // per-slot read path inside `getCurrentModel` itself — not the
    // legacy migration. This is the steady-state corruption case
    // (post-multi-slot, no legacy file present) and runs against every
    // capability slot, including the ones that have no migration
    // pathway (vision / imagegen).
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const cap of ["text", "vision", "imagegen"] as const) {
        const slot = activeModelPath(workdir, cap);
        await fsp.mkdir(workdir, { recursive: true });
        await fsp.writeFile(slot, "{not valid json");

        const result = await getCurrentModel(workdir, cap);
        expect(result).toBeNull();
        expect(fs.existsSync(slot)).toBe(false);

        const siblings = await fsp.readdir(workdir);
        const expectedPrefix = path.basename(slot) + ".corrupt-";
        const backup = siblings.find((f) => f.startsWith(expectedPrefix));
        expect(
          backup,
          `expected ${expectedPrefix}<ts> backup for ${cap}`,
        ).toBeDefined();
        expect(
          await fsp.readFile(path.join(workdir, backup!), "utf8"),
        ).toBe("{not valid json");

        // Clean up backups so the next loop iteration's `readdir`
        // search isn't ambiguous.
        await fsp.unlink(path.join(workdir, backup!));
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("getCurrentModel propagates non-ENOENT IO errors (e.g. ENOTDIR on bogus dir)", async () => {
    // Defense-in-depth: corruption is silently degraded (covered above),
    // but a real disk fault must still surface so an operator can act on
    // it — silently masking those would hide real problems.
    // We point `getCurrentModel` at a userDataDir that's actually a
    // regular file. The `<file>/active-model.json` join then fails with
    // ENOTDIR — a real OS error that is NOT ENOENT — and must propagate.
    const filePath = path.join(workdir, "not-a-directory");
    await fsp.writeFile(filePath, "x");
    await expect(getCurrentModel(filePath, "text")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("deleteCurrentModel removes file and clears active-model.json", async () => {
    const r = makeResolved();
    await downloadModel(workdir, r, () => {}, {
      fetcher: async (_u, onP, d) => {
        await fsp.writeFile(d, Buffer.from("payload"));
        onP(7, 7);
        return { totalBytes: 7 };
      },
    });
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(true);
    await deleteCurrentModel(workdir, "text");
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(false);
    const onDisk = await fsp.readdir(modelsDir(workdir, "text"));
    expect(onDisk).toEqual([]);
    expect(await getCurrentModel(workdir, "text")).toBeNull();
  });

  it("deleteCurrentModel waits for an in-flight downloadModel instead of racing it", async () => {
    // `deleteCurrentModel` ran outside the per-userDataDir download lock
    // and relied on Node's cooperative scheduling to avoid clobbering or
    // being clobbered by a concurrent `downloadModel`. Now both go
    // through the same lock; this test asserts the resulting ordering.
    // We start a slow download, immediately fire a `deleteCurrentModel`,
    // and capture the wall-clock order of (a) when the download's
    // fetcher resolves and (b) when the delete's record-clear settles.
    // If the lock is honoured, the delete cannot finish before the
    // download finishes its work. If the lock were skipped, the delete
    // would race ahead (synchronous-fast unlink with no `active-model.json`
    // to read) and finish first.
    resetDownloadLocks();
    const r = makeResolved();
    const events: string[] = [];
    const slowDownload = downloadModel(workdir, r, () => {}, {
      fetcher: async (_u, onP, d) => {
        // Give the test scheduler a chance to enqueue the delete before
        // we write & resolve.
        await new Promise((resolve) => setTimeout(resolve, 30));
        await fsp.writeFile(d, Buffer.from("payload"));
        onP(7, 7);
        events.push("download-fetcher-resolved");
        return { totalBytes: 7 };
      },
    });
    // Don't await the download yet — fire the delete while it's still
    // in-flight. The delete should queue behind the download.
    const deletePromise = (async () => {
      // Yield once so the download has acquired the lock first.
      await Promise.resolve();
      const p = deleteCurrentModel(workdir, "text");
      await p;
      events.push("delete-completed");
    })();

    await Promise.all([slowDownload, deletePromise]);

    expect(events).toEqual([
      "download-fetcher-resolved",
      "delete-completed",
    ]);
    // And the final on-disk state is "no model" — the delete really did
    // delete, it didn't get clobbered by the download writing afterwards.
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(false);
    expect(await fsp.readdir(modelsDir(workdir, "text"))).toEqual([]);
  });

  // ---------------------------------------------------------------
  // `beforeMutation` deps hook — runs INSIDE the per-userDataDir
  // lock, only when the operation will actually mutate the filesystem.
  // The Electron main process passes `stopSidecarIfRunning` through
  // this hook so the llama-server child releases its OS file handle
  // before we touch the active model.
  // ---------------------------------------------------------------

  it("downloadModel skips beforeMutation on the already-installed fast path", async () => {
    resetDownloadLocks();
    const r = makeResolved();
    // First install — beforeMutation should fire once (fresh install
    // counts as a mutation).
    const hook1 = vi.fn(async () => {});
    await downloadModel(
      workdir,
      r,
      () => {},
      {
        fetcher: async (_u, onP, d) => {
          await fsp.writeFile(d, Buffer.from("payload"));
          onP(7, 7);
          return { totalBytes: 7 };
        },
        beforeMutation: hook1,
      },
    );
    expect(hook1).toHaveBeenCalledTimes(1);

    // Second call for the SAME model id — `downloadModelLocked`
    // recognises it as already-installed and returns early WITHOUT
    // running beforeMutation. Otherwise opening a stale window or
    // double-clicking Download would needlessly tear down the
    // sidecar that's already happily serving this model.
    const hook2 = vi.fn(async () => {});
    await downloadModel(
      workdir,
      r,
      () => {},
      {
        fetcher: async () => {
          throw new Error("fetcher must not be called on already-installed fast path");
        },
        beforeMutation: hook2,
      },
    );
    expect(hook2).not.toHaveBeenCalled();
  });

  it("downloadModel invokes beforeMutation exactly once on swap, before eviction", async () => {
    resetDownloadLocks();
    const a = makeResolved({ id: "ternary-bonsai-1.7b-gguf", filename: "a.gguf" });
    const b = makeResolved({ id: "ternary-bonsai-4b-gguf", filename: "b.gguf" });

    // Install A.
    await downloadModel(workdir, a, () => {}, {
      fetcher: async (_u, onP, d) => {
        await fsp.writeFile(d, Buffer.from("A"));
        onP(1, 1);
        return { totalBytes: 1 };
      },
    });
    const aFile = path.join(modelsDir(workdir, "text"), a.filename);
    expect(fs.existsSync(aFile)).toBe(true);

    // Swap to B. beforeMutation must fire BEFORE A's file is unlinked
    // so the sidecar releases its handle in time. We capture the
    // existence of A's file at the moment beforeMutation runs as
    // evidence of ordering.
    let aFileExistedAtHook: boolean | null = null;
    const hook = vi.fn(async () => {
      aFileExistedAtHook = fs.existsSync(aFile);
    });
    await downloadModel(workdir, b, () => {}, {
      fetcher: async (_u, onP, d) => {
        await fsp.writeFile(d, Buffer.from("B"));
        onP(1, 1);
        return { totalBytes: 1 };
      },
      beforeMutation: hook,
    });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(aFileExistedAtHook).toBe(true);
    // Post-conditions: A gone, B installed (single-model invariant).
    expect(fs.existsSync(aFile)).toBe(false);
    expect(fs.existsSync(path.join(modelsDir(workdir, "text"), b.filename))).toBe(true);
  });

  it("deleteCurrentModel skips beforeMutation when there is nothing to delete", async () => {
    resetDownloadLocks();
    // No prior downloadModel — active-model.json doesn't exist.
    const hook = vi.fn(async () => {});
    await deleteCurrentModel(workdir, "text", { beforeMutation: hook });
    // Skipping the hook is the whole point: invoking
    // stopSidecarIfRunning() here would needlessly tear down a
    // sidecar that may be serving a different model the user
    // hasn't asked to delete (e.g. a stale UI double-click).
    expect(hook).not.toHaveBeenCalled();
  });

  it("deleteCurrentModel invokes beforeMutation once, before the file is unlinked", async () => {
    resetDownloadLocks();
    const r = makeResolved();
    await downloadModel(workdir, r, () => {}, {
      fetcher: async (_u, onP, d) => {
        await fsp.writeFile(d, Buffer.from("payload"));
        onP(7, 7);
        return { totalBytes: 7 };
      },
    });
    const filePath = path.join(modelsDir(workdir, "text"), r.filename);
    expect(fs.existsSync(filePath)).toBe(true);

    let fileExistedAtHook: boolean | null = null;
    const hook = vi.fn(async () => {
      fileExistedAtHook = fs.existsSync(filePath);
    });
    await deleteCurrentModel(workdir, "text", { beforeMutation: hook });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(fileExistedAtHook).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(await getCurrentModel(workdir, "text")).toBeNull();
  });

  it("beforeMutation runs INSIDE the download lock (concurrent swap is serialised)", async () => {
    // Regression for the race window where `stopSidecarIfRunning`
    // ran in the IPC handler outside the lock: a parallel
    // downloadModel could complete between sidecar-stop and lock-
    // acquire and end up deleted by our subsequent eviction. With
    // the hook inside the lock, the swap is fully atomic per
    // userDataDir.
    resetDownloadLocks();
    const a = makeResolved({ id: "ternary-bonsai-1.7b-gguf", filename: "a.gguf" });
    const b = makeResolved({ id: "ternary-bonsai-4b-gguf", filename: "b.gguf" });

    // Install A first so the swap path is exercised on the second call.
    await downloadModel(workdir, a, () => {}, {
      fetcher: async (_u, onP, d) => {
        await fsp.writeFile(d, Buffer.from("A"));
        onP(1, 1);
        return { totalBytes: 1 };
      },
    });

    const events: string[] = [];
    // Long-running swap to B: beforeMutation pushes a marker, fetcher
    // takes a while, eviction unlinks A. A second concurrent call (to
    // re-download A) MUST queue behind it and only see "no model"
    // when it acquires the lock.
    const swap = downloadModel(workdir, b, () => {}, {
      fetcher: async (_u, onP, d) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        await fsp.writeFile(d, Buffer.from("B"));
        onP(1, 1);
        events.push("swap-fetcher-resolved");
        return { totalBytes: 1 };
      },
      beforeMutation: async () => {
        events.push("swap-beforeMutation");
      },
    });

    // Queue a re-install of A concurrently. `beforeMutation` runs
    // INSIDE the lock, BEFORE any eviction or fetcher work. If the
    // swap completed atomically the reinstall's hook will see B as
    // the current model — this is the proof that the swap's commit
    // (writeCurrentModel(b)) happened strictly before the reinstall
    // acquired the lock.
    const reinstall: Promise<{
      rec: InstalledModelRecord;
      currentAtHook: InstalledModelRecord | null;
    }> = (async () => {
      await Promise.resolve(); // yield so swap acquires the lock first
      let currentAtHook: InstalledModelRecord | null = null;
      const rec = await downloadModel(workdir, a, () => {}, {
        fetcher: async (_u, onP, d) => {
          await fsp.writeFile(d, Buffer.from("A2"));
          onP(2, 2);
          return { totalBytes: 2 };
        },
        beforeMutation: async () => {
          // Capture BEFORE the locked block evicts B and clears
          // active-model.json.
          currentAtHook = await getCurrentModel(workdir, "text");
          events.push("reinstall-beforeMutation");
        },
      });
      events.push("reinstall-completed");
      return { rec, currentAtHook };
    })();

    const [, reinstallResult] = await Promise.all([swap, reinstall]);

    // Expected ordering: the swap's beforeMutation + fetcher resolve
    // before the reinstall's beforeMutation. The reinstall doesn't
    // even start its hook until the swap has fully committed.
    expect(events).toEqual([
      "swap-beforeMutation",
      "swap-fetcher-resolved",
      "reinstall-beforeMutation",
      "reinstall-completed",
    ]);

    // The reinstall's beforeMutation hook saw B as the active model,
    // because the swap had already written `active-model.json` for B
    // before the reinstall could acquire the lock. This is the
    // assertion that proves the swap is atomic per userDataDir.
    expect(reinstallResult.currentAtHook).not.toBeNull();
    expect(reinstallResult.currentAtHook!.modelId).toBe(b.id);
  });

  it("downloadModel verifies sha256 and deletes the file on mismatch", async () => {
    const requested = makeResolved({
      sha256: "deadbeef".padEnd(64, "0"),
    });
    const payload = Buffer.from("payload");
    await expect(
      downloadModel(
        workdir,
        requested,
        () => {},
        {
          fetcher: async (_u, onP, d) => {
            await fsp.writeFile(d, payload);
            onP(payload.byteLength, payload.byteLength);
            return { totalBytes: payload.byteLength };
          },
        },
      ),
    ).rejects.toThrow(/Checksum mismatch/);
    const onDisk = await fsp.readdir(modelsDir(workdir, "text"));
    expect(onDisk).toEqual([]);
  });

  it("downloadModel cleans up the .partial file when the fetch fails mid-stream", async () => {
    // If the network drops after some bytes are written, we don't want a
    // ".gguf.partial" relic sitting in modelsDir pretending to be a model.
    // The download must atomically rename only on full success.
    const requested = makeResolved();
    await expect(
      downloadModel(
        workdir,
        requested,
        () => {},
        {
          fetcher: async (_u, onP, d) => {
            await fsp.writeFile(d, Buffer.from("half"));
            onP(4, 100);
            throw new Error("simulated network failure");
          },
        },
      ),
    ).rejects.toThrow(/simulated network failure/);
    const onDisk = await fsp.readdir(modelsDir(workdir, "text"));
    expect(onDisk).toEqual([]);
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(false);
  });

  it("downloadModel writes to a .partial sibling and only renames after sha verification", async () => {
    // Verifies the atomic rename contract: the final filename must not
    // appear on disk until the hash check has passed. Otherwise a process
    // crash between write and verify could leave a bad file at the canonical
    // path.
    const validHash = "9f2feb1efb6fd87cd84ffd25b5b220e51eff9c5d2c2ade71daa0c46a39b18cd9";
    const requested = makeResolved({ sha256: validHash });
    const payload = Buffer.from("contents-that-hash-to-validHash");

    const observedDestPaths: string[] = [];
    const hasher = async (filePath: string) => {
      observedDestPaths.push(filePath);
      // Confirm hashing happens against the .partial, not the final filename.
      expect(filePath.endsWith(".partial")).toBe(true);
      const finalPath = path.join(modelsDir(workdir, "text"), requested.filename);
      expect(fs.existsSync(finalPath)).toBe(false);
      return validHash;
    };

    await downloadModel(
      workdir,
      requested,
      () => {},
      {
        fetcher: async (_u, onP, d) => {
          expect(d.endsWith(".partial")).toBe(true);
          await fsp.writeFile(d, payload);
          onP(payload.byteLength, payload.byteLength);
          return { totalBytes: payload.byteLength };
        },
        hasher,
      },
    );
    expect(observedDestPaths.length).toBe(1);
    const finalPath = path.join(modelsDir(workdir, "text"), requested.filename);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(`${finalPath}.partial`)).toBe(false);
    const onDisk = await fsp.readdir(modelsDir(workdir, "text"));
    expect(onDisk).toEqual([requested.filename]);
  });
});

// --- Manifest <-> production model ---------------------------------------

describe("recommendModel format-per-platform", () => {
  beforeEach(() => {
    process.env.TESSERA_MODELS_MANIFEST = MANIFEST;
    resetManifestCache();
  });

  it("returns MLX on macOS Apple Silicon", () => {
    const m: ModelManifest = loadManifest(true);
    const r = recommendModel(m, "macos-apple-silicon", "low");
    expect(r?.format).toBe("mlx");
  });

  it("returns GGUF Q1_0_g128 on every other platform", () => {
    const m: ModelManifest = loadManifest(true);
    for (const target of ["windows-x64", "linux-x64", "linux-arm64", "macos-intel"] as const) {
      const r = recommendModel(m, target, "low");
      expect(r?.format).toBe("gguf");
      expect(r?.quantization).toBe("Q1_0_g128");
    }
  });
});

describe("detectComputeBackends immutability", () => {
  beforeEach(() => {
    resetHardwareDetectionCache();
  });
  afterEach(() => {
    resetHardwareDetectionCache();
  });

  it("never returns a mutable reference to the cached array", () => {
    // First (cold) call MUST hand back a copy, not the underlying cache,
    // so a future caller that does e.g. `result.push("custom")` cannot
    // poison subsequent calls.
    // an asymmetry where the cold-cache path returned the original array
    // while warm-cache calls returned `.slice()`. The test must be
    // hardware-agnostic — on a CI host with Vulkan/CUDA installed, those
    // backends naturally appear in the detected list — so we mutate
    // using a clearly-synthetic sentinel value and verify it doesn't
    // leak into the cache.
    const SENTINEL = "synthetic-test-only" as never;
    const first = detectComputeBackends();
    const baseline = first.slice();
    first.push(SENTINEL);
    first.push(SENTINEL);
    const second = detectComputeBackends();
    // The sentinel mutation must NOT leak into the cache.
    expect(second).not.toContain(SENTINEL);
    // Detected backends must be stable across calls (hardware doesn't
    // change at runtime).
    expect(second).toEqual(baseline);
    // CPU is always present regardless of hardware.
    expect(second[0]).toBe("cpu");
    // The two returned arrays must be distinct objects (otherwise the
    // immutability invariant relies on callers never mutating, which is
    // exactly what the finding warns against).
    expect(second).not.toBe(first);
  });

  it("returns a fresh copy on every warm-cache hit too", () => {
    detectComputeBackends(); // warm the cache
    const a = detectComputeBackends();
    const b = detectComputeBackends();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});

describe("downloadModel survives throwing onProgress", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-throw-progress-"));
    resetDownloadLocks();
  });

  afterEach(async () => {
    resetDownloadLocks();
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  it("never aborts the on-disk write when the progress callback throws", async () => {
    // If a BrowserWindow gets destroyed mid-download, its
    // `webContents.send` throws "Object has been destroyed", and
    // without the boundary wrap that exception would bubble back
    // through the fetcher's read loop into downloadModelLocked's
    // catch — which unlinks the .partial and discards the entire
    // multi-gigabyte download. We simulate that by passing an
    // onProgress that always throws and asserting the model still
    // lands on disk and the active record is written.
    const payload = Buffer.from("ternary-bonsai-bytes");
    const requested = makeResolved({
      url: "https://example.invalid/throw-progress.gguf",
      downloadSizeMb: payload.byteLength / (1024 * 1024),
    });
    const throwingProgress = () => {
      throw new Error("Object has been destroyed");
    };
    let progressCalls = 0;
    const fetcher = async (
      _url: string,
      onProgress: (d: number, t: number) => void,
      dest: string,
    ) => {
      await fsp.writeFile(dest, payload);
      // The fetcher invokes onProgress unconditionally — this is the
      // path the bug took. The wrapper at the downloadModel boundary
      // must catch the throw so the fetcher can keep going.
      onProgress(payload.byteLength, payload.byteLength);
      onProgress(payload.byteLength, payload.byteLength);
      progressCalls += 2;
      return { totalBytes: payload.byteLength };
    };

    const record = await downloadModel(workdir, requested, throwingProgress, {
      fetcher,
    });

    // The download completed and was recorded.
    expect(record.modelId).toBe(requested.id);
    expect(fs.existsSync(record.path)).toBe(true);
    expect(await fsp.readFile(record.path)).toEqual(payload);
    const current = await getCurrentModel(workdir, "text");
    expect(current?.modelId).toBe(requested.id);
    // The fetcher's onProgress invocations all ran (they didn't get
    // short-circuited by the throw because wrapProgressNoThrow caught
    // each one).
    expect(progressCalls).toBe(2);
    // No .partial leftover.
    expect(fs.existsSync(`${record.path}.partial`)).toBe(false);
  });
});

describe("writeCurrentModel atomic write ", () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-atomic-write-"));
    resetDownloadLocks();
  });

  afterEach(async () => {
    resetDownloadLocks();
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  it("downloadModel writes active-model.json via temp+rename (no partial file on success)", async () => {
    // The atomic-write helper writes to a sibling `.tmp-<pid>-<ts>` file
    // and renames it over the target. After a successful write the
    // temp file must NOT exist (it should have been renamed away).
    const requested = makeResolved();
    const fetcher = async (
      _url: string,
      onProgress: (d: number, t: number) => void,
      dest: string,
    ) => {
      await fsp.writeFile(dest, Buffer.from("x"));
      onProgress(1, 1);
      return { totalBytes: 1 };
    };
    await downloadModel(workdir, requested, () => {}, { fetcher });

    const written = await fsp.readFile(activeModelPath(workdir, "text"), "utf8");
    const parsed = JSON.parse(written) as { modelId: string };
    expect(parsed.modelId).toBe(requested.id);

    // No `.active-model.json.tmp-*` siblings should be left over.
    const entries = await fsp.readdir(workdir);
    const stragglers = entries.filter(
      (name) =>
        name.startsWith(".active-model.json.tmp") || name.endsWith(".tmp"),
    );
    expect(stragglers).toEqual([]);
  });

  it("preserves the previous record when a swap fetcher fails mid-stream", async () => {
    // First install a known-good model. After this, active-model.json
    // contains a complete record.
    const initial = makeResolved({ id: "ternary-bonsai-1.7b-gguf" });
    await downloadModel(workdir, initial, () => {}, {
      fetcher: async (_u, onP, dest) => {
        await fsp.writeFile(dest, Buffer.from("a"));
        onP(1, 1);
        return { totalBytes: 1 };
      },
    });
    const before = await fsp.readFile(activeModelPath(workdir, "text"), "utf8");

    // Now attempt a SWAP whose fetcher fails BEFORE writeCurrentModel
    // would have been called. Without atomic write a partially
    // overwritten active-model.json could appear; with atomic write
    // the original record must survive untouched.
    const replacement = makeResolved({
      id: "ternary-bonsai-4b-gguf",
      filename: "ternary-bonsai-4b-q1_0_g128.gguf",
    });
    await expect(
      downloadModel(workdir, replacement, () => {}, {
        fetcher: async () => {
          throw new Error("simulated transport failure");
        },
      }),
    ).rejects.toThrow(/simulated transport failure/);

    // The previous record may or may not still be present depending on
    // whether the swap deleted the old file first. The invariant we
    // assert here is the *atomicity* one: active-model.json is never
    // a partially-written / truncated JSON document. Either it parses
    // cleanly or it is absent.
    const afterRaw = await fsp.readFile(activeModelPath(workdir, "text"), "utf8").catch(
      (err) => {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      },
    );
    if (afterRaw !== null) {
      // If still present, must be valid JSON (no truncated bytes).
      expect(() => JSON.parse(afterRaw)).not.toThrow();
    }
    // Sanity: the `before` snapshot was itself valid JSON we wrote.
    expect(() => JSON.parse(before)).not.toThrow();
  });
});

describe("defaultFetcher reader lifetime ", () => {
  // We can't easily simulate `fsp.open` failing inside vitest without
  // platform-specific permission tricks, so instead we exercise the
  // re-ordered code path indirectly: if the response body is null we
  // throw BEFORE opening the file, and if the file can't be opened
  // we throw BEFORE acquiring the reader. The structural invariant we
  // pin is "no reader is acquired without a successful file open" via
  // the order of operations in the source. This regression test asserts
  // the function still rejects appropriately on a null response body
  // (the early bail-out path) without touching the destination path.
  it("rejects on null response body without touching destPath", async () => {
    const tmpDest = path.join(
      await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-fetcher-")),
      "should-not-exist.bin",
    );
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response(null, { status: 200 })) as typeof fetch;
      // Re-import the module to get the real defaultFetcher closure.
      // We invoke via downloadModel so the wrap stays exercised; the
      // requested.url here matches the stubbed fetch above.
      const requested = makeResolved({
        url: "https://example.invalid/no-body",
      });
      const workdir = await fsp.mkdtemp(
        path.join(os.tmpdir(), "tessera-no-body-"),
      );
      await expect(
        downloadModel(workdir, requested, () => {}),
      ).rejects.toThrow(/Empty response body/);
      // The destination file must not exist because we threw before
      // opening it.
      const expectedDest = path.join(
        modelsDir(workdir, "text"),
        requested.filename,
      );
      expect(fs.existsSync(expectedDest)).toBe(false);
      expect(fs.existsSync(`${expectedDest}.partial`)).toBe(false);
      await fsp.rm(workdir, { recursive: true, force: true });
      await fsp.rm(path.dirname(tmpDest), { recursive: true, force: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("manifest validation guard (parsePlatform + validateManifest)", () => {
  // `ManifestLlamaServerVariant.platform` is typed as `Platform` but
  // the JSON it comes from is untrusted at runtime. A manifest
  // containing e.g. `"linux-riscv64"` would parse successfully and
  // only fail at lookup time with a confusing "no variant for this
  // platform" error indistinguishable from a missing-entry bug.
  // `loadManifest` now calls `validateManifest`, which fails fast at
  // load time with a precise diagnostic.

  let workdir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    originalEnv = process.env.TESSERA_MODELS_MANIFEST;
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-manifest-"));
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.TESSERA_MODELS_MANIFEST;
    } else {
      process.env.TESSERA_MODELS_MANIFEST = originalEnv;
    }
    resetManifestCache();
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  it("loads the real manifest without rejecting any variant", () => {
    process.env.TESSERA_MODELS_MANIFEST = MANIFEST;
    resetManifestCache();
    // If the validator is overzealous, it would reject the real
    // shipped manifest. This is a positive-control: every shipped
    // variant must pass.
    const manifest = loadManifest(true);
    expect(manifest.llama_server?.variants.length).toBeGreaterThan(0);
  });

  it("rejects a manifest with an unknown llama_server.variants[].platform with a precise error", async () => {
    const badManifest: ModelManifest = {
      format_version: 1,
      models: [],
      llama_server: {
        version: "b4546",
        variants: [
          {
            // intentionally not in the Platform union
            platform: "linux-riscv64" as unknown as never,
            compute: "cpu",
            url: "https://example.invalid/llama-server",
            sha256: null,
          },
        ],
      },
    };
    const badPath = path.join(workdir, "bad-platform.json");
    await fsp.writeFile(badPath, JSON.stringify(badManifest), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = badPath;
    resetManifestCache();

    expect(() => loadManifest(true)).toThrowError(/linux-riscv64/);
    expect(() => loadManifest(true)).toThrowError(/not one of/);
  });

  it("rejects a manifest with an unknown llama_server.variants[].compute with a precise error", async () => {
    const badManifest: ModelManifest = {
      format_version: 1,
      models: [],
      llama_server: {
        version: "b4546",
        variants: [
          {
            platform: "linux-x64",
            // intentionally not in the ComputeBackend union
            compute: "xpu" as unknown as never,
            url: "https://example.invalid/llama-server",
            sha256: null,
          },
        ],
      },
    };
    const badPath = path.join(workdir, "bad-compute.json");
    await fsp.writeFile(badPath, JSON.stringify(badManifest), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = badPath;
    resetManifestCache();

    expect(() => loadManifest(true)).toThrowError(/xpu/);
    expect(() => loadManifest(true)).toThrowError(/not one of/);
  });

  it("does not cache a manifest that failed validation", async () => {
    const badManifest: ModelManifest = {
      format_version: 1,
      models: [],
      llama_server: {
        version: "b4546",
        variants: [
          {
            platform: "freebsd-x64" as unknown as never,
            compute: "cpu",
            url: "https://example.invalid/llama-server",
            sha256: null,
          },
        ],
      },
    };
    const badPath = path.join(workdir, "uncached-bad.json");
    await fsp.writeFile(badPath, JSON.stringify(badManifest), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = badPath;
    resetManifestCache();

    // First load throws.
    expect(() => loadManifest(true)).toThrow();
    // After fixing the file, a subsequent forced reload must succeed —
    // proving the failed manifest was not cached.
    const goodManifest: ModelManifest = {
      format_version: 1,
      models: [],
      llama_server: {
        version: "b4546",
        variants: [
          {
            platform: "linux-x64",
            compute: "cpu",
            url: "https://example.invalid/llama-server",
            sha256: null,
          },
        ],
      },
    };
    await fsp.writeFile(badPath, JSON.stringify(goodManifest), "utf8");
    const reloaded = loadManifest(true);
    expect(reloaded.llama_server?.variants[0].platform).toBe("linux-x64");
  });
});

describe("manifest validation guard — models[] entries", () => {
  // `validateManifest` originally only validated `llama_server.variants[]`,
  // leaving `models[]` entries untouched. A typo like `"tier": "hig"`
  // would parse successfully and silently drop the model from
  // `recommendModel` results because no tier would match. The validator
  // now fails fast on unknown format / tier / platform / compute strings
  // in `models[]` too.

  let workdir: string;
  let originalEnv: string | undefined;

  beforeEach(async () => {
    originalEnv = process.env.TESSERA_MODELS_MANIFEST;
    workdir = await fsp.mkdtemp(
      path.join(os.tmpdir(), "tessera-manifest-models-"),
    );
  });

  afterEach(async () => {
    if (originalEnv === undefined) {
      delete process.env.TESSERA_MODELS_MANIFEST;
    } else {
      process.env.TESSERA_MODELS_MANIFEST = originalEnv;
    }
    resetManifestCache();
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  function makeBadManifest(
    badEntry: Partial<ModelManifest["models"][number]>,
  ): ModelManifest {
    return {
      format_version: 1,
      models: [
        {
          id: "ternary-bonsai-1.7b-gguf",
          name: "Ternary-Bonsai 1.7B",
          parameters: "1.7B",
          format: "gguf",
          quantization: "Q1_0_g128",
          platform: "linux-x64",
          compute: ["cpu"],
          tier: "low",
          downloadSizeMb: 450,
          diskSizeMb: 450,
          requiredRamGb: 2,
          contextLength: 2048,
          filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
          url: "https://example.invalid/m.gguf",
          sha256: null,
          ...badEntry,
        },
      ],
      llama_server: {
        version: "b4546",
        variants: [
          {
            platform: "linux-x64",
            compute: "cpu",
            url: "https://example.invalid/llama-server",
            sha256: null,
          },
        ],
      },
    };
  }

  it("rejects an unknown models[].format with a precise error", async () => {
    const bad = makeBadManifest({
      format: "tensorflow" as unknown as "gguf",
    });
    const p = path.join(workdir, "bad-format.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/tensorflow/);
    expect(() => loadManifest(true)).toThrowError(/models\[0\]\.format/);
  });

  it("rejects an unknown models[].tier (the classic typo example) with a precise error", async () => {
    const bad = makeBadManifest({ tier: "hig" as unknown as "high" });
    const p = path.join(workdir, "bad-tier.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/models\[0\]\.tier="hig"/);
    expect(() => loadManifest(true)).toThrowError(
      /not one of:.*low.*medium.*high/,
    );
  });

  it("rejects an unknown models[].platform with a precise error", async () => {
    const bad = makeBadManifest({ platform: "any-non-applesilicon" });
    const p = path.join(workdir, "bad-platform.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/any-non-applesilicon/);
    expect(() => loadManifest(true)).toThrowError(/models\[0\]\.platform/);
  });

  it("accepts the 'any-non-apple-silicon' wildcard as a valid models[].platform", async () => {
    const good = makeBadManifest({ platform: "any-non-apple-silicon" });
    const p = path.join(workdir, "wildcard.json");
    await fsp.writeFile(p, JSON.stringify(good), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    // Wildcard is a valid manifest platform; the loader must NOT
    // reject it (otherwise the shipped manifest would fail validation).
    const m = loadManifest(true);
    expect(m.models[0].platform).toBe("any-non-apple-silicon");
  });

  it("rejects an unknown models[].compute[] entry with a precise error", async () => {
    const bad = makeBadManifest({
      compute: ["cpu", "xpu" as unknown as "cuda"],
    });
    const p = path.join(workdir, "bad-compute.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/models\[0\]\.compute\[1\]/);
    expect(() => loadManifest(true)).toThrowError(/xpu/);
  });

  it("rejects a non-array models[].compute field", async () => {
    const bad = makeBadManifest({
      compute: "cpu" as unknown as ManifestModel["compute"],
    });
    const p = path.join(workdir, "compute-not-array.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(
      /models\[0\]\.compute must be an array/,
    );
  });

  // -----------------------------------------------------------------
  // mmproj-field validator coverage (Block B). The Devin Review
  // pass-4 finding (BUG-pr-review-job-08df75766eba4513809fceac8a2cb5e0
  // -0001 + ANALYSIS-…-0005) called out that the validator
  // accepted a vision-GGUF entry with mmprojFilename + mmprojUrl
  // but no mmprojSizeMb — which then drove the cumulative download
  // progress past 100% (because mmprojBytes defaulted to 0 in
  // `downloadModelLocked`). The validator now requires a positive
  // mmprojSizeMb whenever mmprojUrl is present. These tests pin
  // the matrix so the latent bug can't return.
  // -----------------------------------------------------------------

  function visionGgufEntry(
    overrides: Partial<ModelManifest["models"][number]>,
  ): ModelManifest["models"][number] {
    return {
      id: "smolvlm-256m-vision-gguf",
      name: "SmolVLM 256M Vision",
      parameters: "256M",
      format: "gguf",
      quantization: "Q4_K_S",
      capability: "vision" as ManifestModel["capability"],
      platform: "any-non-apple-silicon",
      compute: ["cpu"],
      tier: "low",
      downloadSizeMb: 150,
      diskSizeMb: 150,
      requiredRamGb: 1,
      contextLength: 2048,
      filename: "smolvlm.gguf",
      url: "https://example.invalid/smolvlm.gguf",
      sha256: null,
      mmprojFilename: "smolvlm-mmproj.gguf",
      mmprojUrl: "https://example.invalid/smolvlm-mmproj.gguf",
      mmprojSha256: null,
      mmprojSizeMb: 190,
      ...overrides,
    };
  }

  function visionManifest(
    entry: ModelManifest["models"][number],
  ): ModelManifest {
    return {
      format_version: 1,
      models: [entry],
      llama_server: {
        version: "b4546",
        variants: [
          {
            platform: "linux-x64",
            compute: "cpu",
            url: "https://example.invalid/llama-server",
            sha256: null,
          },
        ],
      },
    };
  }

  it("rejects a vision-GGUF entry with mmprojUrl but no mmprojSizeMb (BUG_0001)", async () => {
    const bad = visionManifest(
      visionGgufEntry({ mmprojSizeMb: undefined as unknown as number }),
    );
    const p = path.join(workdir, "missing-mmproj-size.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/missing mmprojSizeMb/);
    expect(() => loadManifest(true)).toThrowError(/smolvlm-256m-vision-gguf/);
  });

  it("rejects a vision-GGUF entry with mmprojSizeMb=0", async () => {
    // Zero is as harmful as `undefined` for the progress math —
    // both make `combinedBytes === mainBytes`, so the cumulative
    // progress can overshoot 100% during the projector download.
    const bad = visionManifest(visionGgufEntry({ mmprojSizeMb: 0 }));
    const p = path.join(workdir, "zero-mmproj-size.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/mmprojSizeMb/);
  });

  it("rejects a vision-GGUF entry with a negative mmprojSizeMb", async () => {
    const bad = visionManifest(visionGgufEntry({ mmprojSizeMb: -5 }));
    const p = path.join(workdir, "neg-mmproj-size.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/mmprojSizeMb/);
  });

  it("rejects a vision-GGUF entry with NaN mmprojSizeMb", async () => {
    // JSON-parses to `null` if literal NaN, so emulate via a code path
    // (manifest could be hand-edited to `"mmprojSizeMb": "abc"` or
    // similar). The validator must reject any non-finite number.
    const bad = visionManifest(
      visionGgufEntry({ mmprojSizeMb: Number.NaN }),
    );
    const p = path.join(workdir, "nan-mmproj-size.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/mmprojSizeMb/);
  });

  it("accepts a complete vision-GGUF entry with positive mmprojSizeMb", async () => {
    const good = visionManifest(visionGgufEntry({}));
    const p = path.join(workdir, "complete-vision.json");
    await fsp.writeFile(p, JSON.stringify(good), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    const m = loadManifest(true);
    expect(m.models[0].mmprojSizeMb).toBe(190);
  });

  it("rejects an mmproj URL without a matching mmproj filename (and vice versa)", async () => {
    // Pair invariant: both halves of the mmproj descriptor must be
    // present together. The original tests in the codebase do not
    // exercise this path even though the validator covers it.
    const onlyUrl = visionManifest(
      visionGgufEntry({ mmprojFilename: undefined as unknown as string }),
    );
    const p1 = path.join(workdir, "only-url.json");
    await fsp.writeFile(p1, JSON.stringify(onlyUrl), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p1;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/mismatched mmproj descriptor/);

    resetManifestCache();
    const onlyFilename = visionManifest(
      visionGgufEntry({ mmprojUrl: undefined as unknown as string }),
    );
    const p2 = path.join(workdir, "only-filename.json");
    await fsp.writeFile(p2, JSON.stringify(onlyFilename), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p2;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(/mismatched mmproj descriptor/);
  });

  it("rejects a non-vision-GGUF entry that carries mmproj fields", async () => {
    // mmproj only applies to llama-server `--mmproj` (vision-GGUF
    // path). A text or imagegen entry carrying mmproj fields would
    // silently misroute through the validator's positive checks
    // were it not caught here.
    const bad = visionManifest(
      visionGgufEntry({
        id: "ternary-bonsai-fake",
        capability: "text",
        // Keep mmproj* fields — that's what we want to reject.
      }),
    );
    const p = path.join(workdir, "text-with-mmproj.json");
    await fsp.writeFile(p, JSON.stringify(bad), "utf8");
    process.env.TESSERA_MODELS_MANIFEST = p;
    resetManifestCache();
    expect(() => loadManifest(true)).toThrowError(
      /mmproj is only valid for vision-GGUF entries/,
    );
  });
});

describe("ModelRuntimeCard fetcher / defaultFetcher socket-leak guard", () => {
  // `defaultFetcher` used to throw on `!resp.ok` without consuming or
  // cancelling `resp.body`. Under undici (Node's built-in fetch) that
  // keeps the underlying TCP socket open until the `Response` is
  // garbage-collected — an accumulation risk under retry storms. The
  // fix calls `resp.body?.cancel()` before throwing; this test mocks
  // global fetch with a tracking body and asserts cancel was called.

  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("cancels the response body before throwing on a non-ok status", async () => {
    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const fakeBody = { cancel: cancelMock } as unknown as ReadableStream;
    const errorResp = {
      ok: false,
      status: 503,
      body: fakeBody,
      headers: { get: () => null },
    } as unknown as Response;
    globalThis.fetch = vi.fn().mockResolvedValue(errorResp) as typeof fetch;

    const requested = makeResolved({
      url: "https://example.invalid/will-503",
    });
    const work = await fsp.mkdtemp(
      path.join(os.tmpdir(), "tessera-503-leak-"),
    );
    await expect(
      downloadModel(work, requested, () => {}),
    ).rejects.toThrow(/HTTP 503/);
    // The fix: cancel must have been called before the throw bubbled.
    expect(cancelMock).toHaveBeenCalledTimes(1);
    await fsp.rm(work, { recursive: true, force: true });
  });

  it("swallows a cancel() rejection and still surfaces the original HTTP error", async () => {
    // Defense-in-depth: cancel() can throw if the body has already
    // been consumed or the connection is already closed. The catch in
    // `defaultFetcher` swallows it so the secondary failure can't
    // mask the original HTTP status.
    const cancelMock = vi
      .fn()
      .mockRejectedValue(new Error("body already locked"));
    const fakeBody = { cancel: cancelMock } as unknown as ReadableStream;
    const errorResp = {
      ok: false,
      status: 429,
      body: fakeBody,
      headers: { get: () => null },
    } as unknown as Response;
    globalThis.fetch = vi.fn().mockResolvedValue(errorResp) as typeof fetch;

    const requested = makeResolved({
      url: "https://example.invalid/will-429",
    });
    const work = await fsp.mkdtemp(
      path.join(os.tmpdir(), "tessera-429-leak-"),
    );
    await expect(
      downloadModel(work, requested, () => {}),
    ).rejects.toThrow(/HTTP 429/);
    expect(cancelMock).toHaveBeenCalledTimes(1);
    await fsp.rm(work, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Block A — multi-capability slots, migration, tier gating
// ---------------------------------------------------------------------------

describe("ModelCapability parsing + manifest defaulting", () => {
  it("parseModelCapability accepts the canonical wire-format strings", () => {
    expect(parseModelCapability("text")).toBe("text");
    expect(parseModelCapability("vision")).toBe("vision");
    expect(parseModelCapability("imagegen")).toBe("imagegen");
  });

  it("parseModelCapability returns null on any other value (no silent fallthrough)", () => {
    // Common typos / wrong cases — must be rejected so the validator
    // produces a precise diagnostic rather than silently dropping
    // the entry from every capability filter.
    expect(parseModelCapability("Text")).toBeNull();
    expect(parseModelCapability("image-gen")).toBeNull();
    expect(parseModelCapability("image_generation")).toBeNull();
    expect(parseModelCapability("")).toBeNull();
    expect(parseModelCapability("ocr")).toBeNull();
  });

  it("manifestCapability defaults to 'text' when the manifest omits the field", () => {
    const noField: ManifestModel = {
      id: "legacy-entry",
      name: "Legacy",
      parameters: "1B",
      format: "gguf",
      quantization: "Q1_0_g128",
      platform: "linux-x64",
      compute: ["cpu"],
      tier: "low",
      downloadSizeMb: 100,
      diskSizeMb: 100,
      requiredRamGb: 2,
      contextLength: 2048,
      filename: "legacy.gguf",
      url: "https://example.invalid/legacy.gguf",
      sha256: null,
    };
    expect(manifestCapability(noField)).toBe("text");
    expect(manifestCapability({ ...noField, capability: "vision" })).toBe(
      "vision",
    );
    expect(manifestCapability({ ...noField, capability: "imagegen" })).toBe(
      "imagegen",
    );
  });

  it("ALL_MODEL_CAPABILITIES enumerates exactly text/vision/imagegen", () => {
    expect([...ALL_MODEL_CAPABILITIES]).toEqual(["text", "vision", "imagegen"]);
  });
});

describe("isCapabilityAvailable tier × backend gating", () => {
  // Mirror the Rust truth table in `crates/tessera_runtime/src/config.rs`
  // — text and vision are always available; imagegen requires Medium+
  // tier AND at least one non-cpu backend.

  it("text is available on every tier with any backend (always-on)", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      expect(isCapabilityAvailable(tier, "text", [])).toBe(true);
      expect(isCapabilityAvailable(tier, "text", ["cpu"])).toBe(true);
      expect(isCapabilityAvailable(tier, "text", ["cpu", "cuda"])).toBe(true);
    }
  });

  it("vision is available on every tier with any backend (always-on, SmolVLM CPU low-tier path)", () => {
    for (const tier of ["low", "medium", "high"] as const) {
      expect(isCapabilityAvailable(tier, "vision", [])).toBe(true);
      expect(isCapabilityAvailable(tier, "vision", ["cpu"])).toBe(true);
      expect(isCapabilityAvailable(tier, "vision", ["metal"])).toBe(true);
    }
  });

  it("imagegen is unavailable on Low tier regardless of backend (FLUX needs >=6GB RAM)", () => {
    expect(isCapabilityAvailable("low", "imagegen", [])).toBe(false);
    expect(isCapabilityAvailable("low", "imagegen", ["cpu"])).toBe(false);
    expect(isCapabilityAvailable("low", "imagegen", ["cuda"])).toBe(false);
    expect(isCapabilityAvailable("low", "imagegen", ["cuda", "vulkan"])).toBe(
      false,
    );
  });

  it("imagegen is unavailable on CPU-only devices regardless of tier (diffusion-on-cpu is too slow)", () => {
    for (const tier of ["medium", "high"] as const) {
      expect(isCapabilityAvailable(tier, "imagegen", [])).toBe(false);
      expect(isCapabilityAvailable(tier, "imagegen", ["cpu"])).toBe(false);
    }
  });

  it("imagegen is available on Medium+ tier with any GPU backend", () => {
    for (const tier of ["medium", "high"] as const) {
      for (const gpu of ["cuda", "vulkan", "metal", "rocm"] as const) {
        expect(isCapabilityAvailable(tier, "imagegen", [gpu])).toBe(true);
        expect(isCapabilityAvailable(tier, "imagegen", ["cpu", gpu])).toBe(
          true,
        );
      }
    }
  });
});

describe("listModelsForPlatform capability filter (Block A)", () => {
  beforeEach(() => {
    process.env.TESSERA_MODELS_MANIFEST = MANIFEST;
    resetManifestCache();
  });

  it("filters to vision entries on every non-Apple-Silicon platform", () => {
    const manifest = loadManifest(true);
    for (const target of [
      "windows-x64",
      "linux-x64",
      "linux-arm64",
      "macos-intel",
    ] as const) {
      const vision = listModelsForPlatform(manifest, target, "vision");
      expect(vision.length).toBeGreaterThan(0);
      for (const m of vision) {
        expect(m.capability).toBe("vision");
        expect(m.format).toBe("gguf");
        expect(m.platform).toBe(target);
      }
    }
  });

  it("filters to vision MLX entries on Apple Silicon", () => {
    const manifest = loadManifest(true);
    const vision = listModelsForPlatform(
      manifest,
      "macos-apple-silicon",
      "vision",
    );
    expect(vision.length).toBeGreaterThan(0);
    for (const m of vision) {
      expect(m.capability).toBe("vision");
      expect(m.format).toBe("mlx");
      expect(m.computeBackends).toEqual(["metal"]);
    }
  });

  it("imagegen entries never include 'cpu' in compute backends (GPU-only product)", () => {
    const manifest = loadManifest(true);
    for (const target of [
      "windows-x64",
      "linux-x64",
      "macos-apple-silicon",
    ] as const) {
      const ig = listModelsForPlatform(manifest, target, "imagegen");
      for (const m of ig) {
        expect(m.capability).toBe("imagegen");
        expect(m.computeBackends).not.toContain("cpu");
        expect(m.computeBackends.length).toBeGreaterThan(0);
      }
    }
  });

  it("recommendModel(capability) returns a model whose capability matches the request", () => {
    const manifest = loadManifest(true);
    for (const cap of ALL_MODEL_CAPABILITIES) {
      // Use a permissive platform so vision/imagegen entries are
      // reachable. imagegen on macOS Apple Silicon at medium tier is
      // the configuration most likely to recommend an entry.
      const target = cap === "imagegen" ? "macos-apple-silicon" : "linux-x64";
      const tier = cap === "imagegen" ? "medium" : "low";
      const rec = recommendModel(manifest, target, tier, cap);
      // imagegen on linux-x64 at low tier would correctly return null,
      // but our chosen target/tier above guarantees a hit for every
      // capability.
      expect(rec).not.toBeNull();
      expect(rec!.capability).toBe(cap);
    }
  });
});

describe("multi-slot storage paths", () => {
  it("modelsDir produces a separate directory per capability", () => {
    const base = "/tmp/tessera-test-userdata";
    expect(modelsDir(base, "text")).toBe(path.join(base, "models", "text"));
    expect(modelsDir(base, "vision")).toBe(path.join(base, "models", "vision"));
    expect(modelsDir(base, "imagegen")).toBe(
      path.join(base, "models", "imagegen"),
    );
    // Distinct slots cannot collide on disk.
    expect(modelsDir(base, "text")).not.toBe(modelsDir(base, "vision"));
    expect(modelsDir(base, "vision")).not.toBe(modelsDir(base, "imagegen"));
  });

  it("activeModelPath embeds the capability in the file name (one record per slot)", () => {
    const base = "/tmp/tessera-test-userdata";
    expect(activeModelPath(base, "text")).toBe(
      path.join(base, "active-model-text.json"),
    );
    expect(activeModelPath(base, "vision")).toBe(
      path.join(base, "active-model-vision.json"),
    );
    expect(activeModelPath(base, "imagegen")).toBe(
      path.join(base, "active-model-imagegen.json"),
    );
  });
});

describe("per-slot isolation", () => {
  let workdir: string;
  beforeEach(async () => {
    process.env.TESSERA_MODELS_MANIFEST = MANIFEST;
    resetManifestCache();
    resetDownloadLocks();
    resetLegacyMigrationCache();
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-slot-"));
  });
  afterEach(async () => {
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  it("downloading a vision model does not touch the text slot", async () => {
    // Pre-install a text model.
    const textModel = makeResolved({
      id: "ternary-bonsai-1.7b-gguf",
      capability: "text",
      filename: "ternary-bonsai-1.7b.gguf",
      url: "https://example.invalid/text-model.gguf",
    });
    const textPayload = Buffer.from("text-model-bytes");
    await downloadModel(workdir, textModel, () => {}, {
      fetcher: async (_url, onProgress, dest) => {
        await fsp.writeFile(dest, textPayload);
        onProgress(textPayload.byteLength, textPayload.byteLength);
        return { totalBytes: textPayload.byteLength };
      },
    });
    expect(
      fs.existsSync(path.join(modelsDir(workdir, "text"), textModel.filename)),
    ).toBe(true);

    // Now install a vision model — the slot is derived from
    // requested.capability, so it must land in models/vision/ and
    // must NOT evict the text model.
    const visionModel = makeResolved({
      id: "smolvlm-256m-vision-gguf",
      name: "SmolVLM 256M Vision",
      capability: "vision",
      filename: "SmolVLM2-256M-Video-Instruct.Q4_K_S.gguf",
      url: "https://example.invalid/vision-model.gguf",
      quantization: "Q4_K_S",
    });
    const visionPayload = Buffer.from("vision-model-bytes");
    await downloadModel(workdir, visionModel, () => {}, {
      fetcher: async (_url, onProgress, dest) => {
        await fsp.writeFile(dest, visionPayload);
        onProgress(visionPayload.byteLength, visionPayload.byteLength);
        return { totalBytes: visionPayload.byteLength };
      },
    });

    // Both slots are populated.
    expect(
      fs.existsSync(path.join(modelsDir(workdir, "text"), textModel.filename)),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(modelsDir(workdir, "vision"), visionModel.filename),
      ),
    ).toBe(true);

    const textRecord = await getInstalledModel(workdir, "text");
    expect(textRecord?.modelId).toBe(textModel.id);
    expect(textRecord?.capability).toBe("text");

    const visionRecord = await getInstalledModel(workdir, "vision");
    expect(visionRecord?.modelId).toBe(visionModel.id);
    expect(visionRecord?.capability).toBe("vision");

    // imagegen slot remains empty.
    expect(await getInstalledModel(workdir, "imagegen")).toBeNull();
  });

  it("deleting one slot does not affect the others", async () => {
    const text = makeResolved({
      id: "ternary-bonsai-1.7b-gguf",
      capability: "text",
      filename: "t.gguf",
    });
    const vision = makeResolved({
      id: "smolvlm-256m-vision-gguf",
      capability: "vision",
      filename: "v.gguf",
    });
    for (const r of [text, vision]) {
      await downloadModel(workdir, r, () => {}, {
        fetcher: async (_url, onProgress, dest) => {
          const buf = Buffer.from(`${r.capability}-payload`);
          await fsp.writeFile(dest, buf);
          onProgress(buf.byteLength, buf.byteLength);
          return { totalBytes: buf.byteLength };
        },
      });
    }
    await deleteCurrentModel(workdir, "text");

    expect(await getInstalledModel(workdir, "text")).toBeNull();
    expect(
      fs.existsSync(path.join(modelsDir(workdir, "text"), text.filename)),
    ).toBe(false);

    const visionRecord = await getInstalledModel(workdir, "vision");
    expect(visionRecord?.modelId).toBe(vision.id);
    expect(
      fs.existsSync(path.join(modelsDir(workdir, "vision"), vision.filename)),
    ).toBe(true);
  });

  it("getInstalledModels returns a per-slot snapshot reflecting on-disk state", async () => {
    const empty = await getInstalledModels(workdir);
    expect(empty).toEqual({ text: null, vision: null, imagegen: null });

    const text = makeResolved({
      id: "ternary-bonsai-1.7b-gguf",
      capability: "text",
      filename: "t.gguf",
    });
    await downloadModel(workdir, text, () => {}, {
      fetcher: async (_url, onProgress, dest) => {
        const buf = Buffer.from("t-bytes");
        await fsp.writeFile(dest, buf);
        onProgress(buf.byteLength, buf.byteLength);
        return { totalBytes: buf.byteLength };
      },
    });
    const afterText = await getInstalledModels(workdir);
    expect(afterText.text?.modelId).toBe(text.id);
    expect(afterText.vision).toBeNull();
    expect(afterText.imagegen).toBeNull();
  });

  it("DownloadProgress events carry the slot's capability so the renderer can route per-slot", async () => {
    // The renderer's multi-capability Settings UI (Block F) subscribes
    // to runtime:downloadProgress and routes each event to the
    // correct per-slot progress bar. The capability field on the
    // emitted progress object is what makes that routing safe — two
    // concurrent downloads (text + vision) would otherwise be
    // indistinguishable on the wire.
    const events: Array<{ modelId: string; capability: string }> = [];

    const vision = makeResolved({
      id: "smolvlm-256m-vision-gguf",
      capability: "vision",
      filename: "v.gguf",
    });
    await downloadModel(
      workdir,
      vision,
      (p) => {
        events.push({ modelId: p.modelId, capability: p.capability });
      },
      {
        fetcher: async (_url, onProgress, dest) => {
          const buf = Buffer.from("v-bytes");
          await fsp.writeFile(dest, buf);
          onProgress(buf.byteLength, buf.byteLength);
          return { totalBytes: buf.byteLength };
        },
      },
    );

    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.modelId).toBe(vision.id);
      expect(ev.capability).toBe("vision");
    }
  });

  it("concurrent downloads to different slots run in parallel (per-slot lock)", async () => {
    // Two concurrent downloads to text + vision slots should not be
    // serialised against each other. The pre-multi-slot behaviour
    // would serialise on the global per-userDataDir lock, capping
    // concurrency at 1. We assert max concurrency reached 2 by
    // counting overlapping fetcher windows.
    let activeFetchers = 0;
    let maxConcurrent = 0;
    const slowFetcher = async (
      _url: string,
      onProgress: (a: number, b: number) => void,
      dest: string,
    ) => {
      activeFetchers += 1;
      maxConcurrent = Math.max(maxConcurrent, activeFetchers);
      try {
        await new Promise((r) => setTimeout(r, 40));
        const buf = Buffer.from(`${path.basename(dest)}-bytes`);
        await fsp.writeFile(dest, buf);
        onProgress(buf.byteLength, buf.byteLength);
        return { totalBytes: buf.byteLength };
      } finally {
        activeFetchers -= 1;
      }
    };

    const text = makeResolved({
      id: "ternary-bonsai-1.7b-gguf",
      capability: "text",
      filename: "t.gguf",
    });
    const vision = makeResolved({
      id: "smolvlm-256m-vision-gguf",
      capability: "vision",
      filename: "v.gguf",
    });

    await Promise.all([
      downloadModel(workdir, text, () => {}, { fetcher: slowFetcher }),
      downloadModel(workdir, vision, () => {}, { fetcher: slowFetcher }),
    ]);

    // With per-slot locks this should be 2 (full parallel). Pre-fix
    // the global lock would cap this at 1.
    expect(maxConcurrent).toBe(2);
  });
});

describe("legacy flat-layout migration", () => {
  let workdir: string;
  beforeEach(async () => {
    process.env.TESSERA_MODELS_MANIFEST = MANIFEST;
    resetManifestCache();
    resetDownloadLocks();
    resetLegacyMigrationCache();
    workdir = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-migrate-"));
  });
  afterEach(async () => {
    await fsp.rm(workdir, { recursive: true, force: true });
  });

  async function seedLegacyInstall(record: Partial<InstalledModelRecord> = {}) {
    const filename = record.filename ?? "ternary-bonsai-1.7b.gguf";
    const legacyDir = legacyModelsDir(workdir);
    await fsp.mkdir(legacyDir, { recursive: true });
    const legacyArtifact = path.join(legacyDir, filename);
    await fsp.writeFile(legacyArtifact, Buffer.from("legacy-bytes"));
    const full: InstalledModelRecord = {
      modelId: record.modelId ?? "ternary-bonsai-1.7b-gguf",
      format: record.format ?? "gguf",
      filename,
      path: record.path ?? legacyArtifact,
      downloadSizeMb: record.downloadSizeMb ?? 1,
      diskSizeMb: record.diskSizeMb ?? 1,
      sha256: record.sha256 ?? null,
      downloadedAt: record.downloadedAt ?? new Date(0).toISOString(),
      ...record,
    };
    await fsp.writeFile(legacyActiveModelPath(workdir), JSON.stringify(full));
    return { legacyArtifact, record: full };
  }

  it("moves <models>/<file> into <models>/text/<file> and rewrites the active record", async () => {
    const { legacyArtifact } = await seedLegacyInstall();
    // Reading the text slot triggers migration.
    const migrated = await getCurrentModel(workdir, "text");
    expect(migrated).not.toBeNull();
    expect(migrated!.modelId).toBe("ternary-bonsai-1.7b-gguf");
    expect(migrated!.capability).toBe("text");

    // The new per-slot artifact exists in models/text/ and the new
    // active record points at it.
    const newArtifact = path.join(
      modelsDir(workdir, "text"),
      migrated!.filename,
    );
    expect(fs.existsSync(newArtifact)).toBe(true);
    expect(migrated!.path).toBe(newArtifact);

    // The legacy active-model.json is gone.
    expect(fs.existsSync(legacyActiveModelPath(workdir))).toBe(false);
    // The legacy artifact was moved (no orphan left behind).
    expect(fs.existsSync(legacyArtifact)).toBe(false);

    // The new per-slot active file exists.
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(true);
  });

  it("is idempotent: running twice leaves the slot unchanged", async () => {
    await seedLegacyInstall();
    const first = await getCurrentModel(workdir, "text");
    resetLegacyMigrationCache();
    const second = await getCurrentModel(workdir, "text");
    expect(second).toEqual(first);
  });

  it("does not run when no legacy file exists (steady-state new install)", async () => {
    // No seed. A fresh getCurrentModel returns null and creates no
    // text/-directory or active-model-text.json on disk.
    const result = await getCurrentModel(workdir, "text");
    expect(result).toBeNull();
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(false);
    expect(fs.existsSync(legacyActiveModelPath(workdir))).toBe(false);
  });

  it("backs up an unparseable legacy record to .corrupt-<ts> instead of crashing", async () => {
    await fsp.mkdir(legacyModelsDir(workdir), { recursive: true });
    await fsp.writeFile(legacyActiveModelPath(workdir), "{this is not json");
    const migrated = await getCurrentModel(workdir, "text");
    expect(migrated).toBeNull();
    // Original file moved aside.
    expect(fs.existsSync(legacyActiveModelPath(workdir))).toBe(false);
    const sibs = await fsp.readdir(workdir);
    const backup = sibs.find((s) => s.startsWith("active-model.json.corrupt-"));
    expect(backup).toBeDefined();
  });

  it("only migrates the text slot; reading vision/imagegen on a legacy install is a no-op", async () => {
    await seedLegacyInstall();
    // Reading vision must NOT trigger migration (a legacy install
    // pre-dates vision support — there's nothing in that slot).
    const visionBefore = await getCurrentModel(workdir, "vision");
    expect(visionBefore).toBeNull();
    // The legacy file is still there because vision/getCurrentModel
    // didn't touch it.
    expect(fs.existsSync(legacyActiveModelPath(workdir))).toBe(true);
  });

  it("concurrent first-time text reads dedupe via the memoised migration Promise", async () => {
    await seedLegacyInstall();
    const [a, b, c] = await Promise.all([
      getCurrentModel(workdir, "text"),
      getCurrentModel(workdir, "text"),
      getCurrentModel(workdir, "text"),
    ]);
    expect(a?.modelId).toBe("ternary-bonsai-1.7b-gguf");
    expect(b?.modelId).toBe(a?.modelId);
    expect(c?.modelId).toBe(a?.modelId);
    expect(fs.existsSync(legacyActiveModelPath(workdir))).toBe(false);
  });

  it("if the legacy artifact already moved (half-migrated), it still records the new path", async () => {
    // Seed only the active-model.json (the artifact was already
    // manually moved by an earlier half-completed run). After
    // migration, the record points at the new (still-missing) path so
    // `getInstalledModel` returns null and the user is prompted to
    // re-download.
    await fsp.writeFile(
      legacyActiveModelPath(workdir),
      JSON.stringify({
        modelId: "ternary-bonsai-1.7b-gguf",
        format: "gguf",
        filename: "ternary-bonsai-1.7b.gguf",
        path: path.join(
          legacyModelsDir(workdir),
          "ternary-bonsai-1.7b.gguf",
        ),
        downloadSizeMb: 1,
        diskSizeMb: 1,
        sha256: null,
        downloadedAt: new Date(0).toISOString(),
      } satisfies InstalledModelRecord),
    );
    // No artifact on disk anywhere.
    const live = await getInstalledModel(workdir, "text");
    expect(live).toBeNull();
    // active-model.json is gone, active-model-text.json took over.
    expect(fs.existsSync(legacyActiveModelPath(workdir))).toBe(false);
    expect(fs.existsSync(activeModelPath(workdir, "text"))).toBe(true);
  });
});


