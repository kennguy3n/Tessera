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
  resetDownloadLocks,
  manifestPath,
  listModelsForPlatform,
  resolveManifestPlatform,
  recommendModel,
  pickLlamaServerVariant,
  planDownload,
  getCurrentModel,
  deleteCurrentModel,
  downloadModel,
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
    // Regression for Devin Review finding 3270628327: the swap decision
    // describes disk-space accounting; for any model whose archive expands
    // after extraction (future MLX), diskSizeMb diverges from
    // downloadSizeMb and the swap UI/CLI must show the on-disk numbers.
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

  it("downloadModel re-downloads when active-model.json claims installed but file is missing on disk", async () => {
    // Regression for Devin Review finding 3270586440: if the user (or a
    // disk error) removed the model file out from under Tessera, the fast
    // path used to incorrectly return the stale record without
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
    const oldPath = path.join(modelsDir(workdir), "old.gguf");
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
    const current = await getCurrentModel(workdir);
    expect(current?.modelId).toBe("ternary-bonsai-4b-gguf");
    expect(fs.existsSync(path.join(modelsDir(workdir), "new.gguf"))).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);

    // Disk should hold exactly ONE model file post-swap.
    const onDisk = await fsp.readdir(modelsDir(workdir));
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

    const current = await getCurrentModel(workdir);
    // The serialized chain commits A first then B, so the on-disk record
    // ends up as B — and crucially there is no A artifact left behind.
    expect(current?.modelId).toBe("ternary-bonsai-4b-gguf");
    const onDisk = await fsp.readdir(modelsDir(workdir));
    expect(onDisk).toEqual(["b.gguf"]);
  });

  it("downloadModel extracts MLX .tar.gz archives, removes the archive, and stores the extract dir", async () => {
    // Regression for Devin Review finding 3270628690: MLX models ship as
    // tar.gz archives. The download path must extract them so the runtime
    // adapter sees a directory (the MLX-native artifact), and the archive
    // must be removed so the single-model invariant holds.
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
            path.join(modelsDir(workdir), requested.filename),
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
      modelsDir(workdir),
      "ternary-bonsai-1.7b-2bit.mlx",
    );
    expect(record.path).toBe(expectedDir);
    expect(fs.statSync(record.path).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(record.path, "config.json"))).toBe(true);

    // The .tar.gz archive must be gone (single-model invariant: we don't
    // keep both the archive and the directory on disk).
    expect(
      fs.existsSync(path.join(modelsDir(workdir), requested.filename)),
    ).toBe(false);

    // active-model.json round-trips correctly.
    const written = await getCurrentModel(workdir);
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

    const onDisk = fs.existsSync(modelsDir(workdir))
      ? await fsp.readdir(modelsDir(workdir))
      : [];
    expect(onDisk).toEqual([]);
    expect(await getCurrentModel(workdir)).toBeNull();
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
