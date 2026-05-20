/**
 * Unit tests for sidecars/models.json loading + single-model enforcement.
 *
 * These tests exercise the real production code paths in
 * apps/desktop/electron/modelManagement.ts (no mocks for the algorithm under
 * test — only the network fetch + SHA256 hasher are dependency-injected
 * because they touch HTTP / crypto that has no fixture in this environment).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import * as os from "os";

import {
  loadManifest,
  resetManifestCache,
  manifestPath,
  listModelsForPlatform,
  resolveManifestPlatform,
  recommendModel,
  pickLlamaServerVariant,
  planDownload,
  getCurrentModel,
  deleteCurrentModel,
  downloadModel,
  swapModel,
  activeModelPath,
  modelsDir,
  type InstalledModelRecord,
  type ResolvedModel,
  type ModelManifest,
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

  it("MLX models are exclusively for macOS Apple Silicon", () => {
    const manifest = loadManifest(true);
    const mlx = manifest.models.filter((m) => m.format === "mlx");
    expect(mlx.length).toBe(3);
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
    expect(models.length).toBe(3);
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
        expect(m.quantization).toBe("Q1_0_g128");
        expect(m.platform).toBe(target);
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
    expect(record.path).toBe(path.join(modelsDir(workdir), requested.filename));
    expect(await fsp.readFile(record.path)).toEqual(payload);
    expect(progressEvents).toBeGreaterThan(0);

    const written = await getCurrentModel(workdir);
    expect(written?.modelId).toBe(requested.id);
    expect(fs.existsSync(activeModelPath(workdir))).toBe(true);
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

  it("swapModel deletes the old model file BEFORE downloading the new one", async () => {
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
    const oldPath = path.join(modelsDir(workdir), "old.gguf");
    expect(fs.existsSync(oldPath)).toBe(true);

    // The new fetcher asserts the old file is gone at the moment we start
    // writing the new one. This is the contract the proposal calls out.
    await swapModel(
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
    const current = await getCurrentModel(workdir);
    expect(current?.modelId).toBe("ternary-bonsai-4b-gguf");
    expect(fs.existsSync(path.join(modelsDir(workdir), "new.gguf"))).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);

    // Disk should hold exactly ONE model file post-swap.
    const onDisk = await fsp.readdir(modelsDir(workdir));
    expect(onDisk).toEqual(["new.gguf"]);
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
    expect(fs.existsSync(activeModelPath(workdir))).toBe(true);
    await deleteCurrentModel(workdir);
    expect(fs.existsSync(activeModelPath(workdir))).toBe(false);
    const onDisk = await fsp.readdir(modelsDir(workdir));
    expect(onDisk).toEqual([]);
    expect(await getCurrentModel(workdir)).toBeNull();
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
    const onDisk = await fsp.readdir(modelsDir(workdir));
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
    const onDisk = await fsp.readdir(modelsDir(workdir));
    expect(onDisk).toEqual([]);
    expect(fs.existsSync(activeModelPath(workdir))).toBe(false);
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
      const finalPath = path.join(modelsDir(workdir), requested.filename);
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
    const finalPath = path.join(modelsDir(workdir), requested.filename);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(fs.existsSync(`${finalPath}.partial`)).toBe(false);
    const onDisk = await fsp.readdir(modelsDir(workdir));
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
