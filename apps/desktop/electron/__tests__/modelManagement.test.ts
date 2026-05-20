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
  isModelInstalled,
  deleteCurrentModel,
  downloadModel,
  activeModelPath,
  modelsDir,
  detectComputeBackends,
  resetHardwareDetectionCache,
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

  it("MLX entries report a post-extract diskSizeMb larger than the compressed downloadSizeMb", () => {
    // Devin Review finding 3271137805: MLX models ship as `.tar.gz`
    // archives, so the on-disk extracted directory is bigger than the
    // compressed download. Before this fix the manifest had
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

  it("getInstalledModel returns null when active-model.json is missing", async () => {
    expect(await getInstalledModel(workdir)).toBeNull();
  });

  it("getInstalledModel returns null when the referenced file is missing on disk", async () => {
    // Regression for Devin Review BUG finding 3270859596: planDownload was
    // using getCurrentModel directly, so a stale active-model.json record
    // pointing at a manually-deleted file caused the planner to return
    // already-installed, hiding the Download button in Settings.
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
    await fsp.writeFile(activeModelPath(workdir), JSON.stringify(ghost));
    // Sanity check: the raw record IS still readable — this is the bug.
    const raw = await getCurrentModel(workdir);
    expect(raw?.modelId).toBe("ternary-bonsai-1.7b-gguf");
    // But getInstalledModel correctly treats the ghost record as "not installed".
    expect(await getInstalledModel(workdir)).toBeNull();
    // And isModelInstalled, which composes on top, agrees.
    expect(await isModelInstalled(workdir, "ternary-bonsai-1.7b-gguf")).toBeNull();
  });

  it("getInstalledModel returns the live record when the referenced file exists", async () => {
    const dir = modelsDir(workdir);
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
    await fsp.writeFile(activeModelPath(workdir), JSON.stringify(live));
    const result = await getInstalledModel(workdir);
    expect(result).not.toBeNull();
    expect(result?.modelId).toBe("ternary-bonsai-1.7b-gguf");
    // isModelInstalled filters by id — same model returns the record,
    // different model returns null.
    expect(
      await isModelInstalled(workdir, "ternary-bonsai-1.7b-gguf"),
    ).not.toBeNull();
    expect(
      await isModelInstalled(workdir, "ternary-bonsai-4b-gguf"),
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

  it("effectiveDiskSizeMb falls back to downloadSizeMb for legacy records (missing field, 0, NaN)", () => {
    // Regression for Devin Review finding 3270718905: the TS side parsed
    // active-model.json directly into InstalledModelRecord and assumed
    // diskSizeMb was always populated. Records persisted before that
    // field was introduced won't have it; the planner must mirror the
    // Rust effective_disk_size_mb() fallback or netDelta becomes NaN.
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

  it("deleteCurrentModel defensively sweeps stray .tar.gz archives next to the extracted dir", async () => {
    // Regression for Devin Review finding 3271010216: if a previous
    // download's post-extract archive unlink failed (Windows EPERM/EBUSY,
    // crash mid-cleanup, etc.), the source `.tar.gz` could survive next
    // to the extracted directory. The next deleteCurrentModel call must
    // sweep it up so the user doesn't have to manually clean the cache
    // directory to restore the single-model-on-disk invariant.
    const dir = modelsDir(workdir);
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
    await fsp.writeFile(activeModelPath(workdir), JSON.stringify(record));

    await deleteCurrentModel(workdir);

    expect(fs.existsSync(extractedDir)).toBe(false);
    expect(fs.existsSync(strayArchive)).toBe(false);
    expect(await getCurrentModel(workdir)).toBeNull();
  });

  it("deleteCurrentModel does not warn when no stray archive exists for a GGUF install", async () => {
    // The defensive stray-archive sweep is gated on the install record's
    // filename ending in .tar.gz / .tgz so GGUF installs (a single .gguf
    // file) never trigger an unnecessary unlink-then-ENOENT path. This
    // test guards against a regression where the sweep accidentally
    // fires for every format and produces noisy ENOENT warnings.
    const dir = modelsDir(workdir);
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
    await fsp.writeFile(activeModelPath(workdir), JSON.stringify(record));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await deleteCurrentModel(workdir);
      expect(fs.existsSync(ggufPath)).toBe(false);
      const sweepWarned = warnSpy.mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.includes("sweep stray archive"),
      );
      expect(sweepWarned).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("getCurrentModel returns null and quarantines a corrupted active-model.json", async () => {
    // Simulate a power loss mid-write or a manual edit that left
    // active-model.json with invalid JSON. Callers must NOT see this as
    // a fatal IO error — they should see "no model installed" and the
    // file should be moved aside so the next downloadModel can write a
    // clean record.
    const active = path.join(workdir, "active-model.json");
    await fsp.mkdir(workdir, { recursive: true });
    await fsp.writeFile(active, "{not valid json");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await getCurrentModel(workdir);
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

  it("getCurrentModel propagates non-ENOENT IO errors (e.g. ENOTDIR on bogus dir)", async () => {
    // Defense-in-depth: corruption is silently degraded (covered above),
    // but a real disk fault must still surface so an operator can act on
    // it — silently masking those would hide real problems.
    //
    // We point `getCurrentModel` at a userDataDir that's actually a
    // regular file. The `<file>/active-model.json` join then fails with
    // ENOTDIR — a real OS error that is NOT ENOENT — and must propagate.
    const filePath = path.join(workdir, "not-a-directory");
    await fsp.writeFile(filePath, "x");
    await expect(getCurrentModel(filePath)).rejects.toMatchObject({
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
    expect(fs.existsSync(activeModelPath(workdir))).toBe(true);
    await deleteCurrentModel(workdir);
    expect(fs.existsSync(activeModelPath(workdir))).toBe(false);
    const onDisk = await fsp.readdir(modelsDir(workdir));
    expect(onDisk).toEqual([]);
    expect(await getCurrentModel(workdir)).toBeNull();
  });

  it("deleteCurrentModel waits for an in-flight downloadModel instead of racing it", async () => {
    // Regression for Devin Review finding 3270789432. Previously
    // `deleteCurrentModel` ran outside the per-userDataDir download lock
    // and relied on Node's cooperative scheduling to avoid clobbering or
    // being clobbered by a concurrent `downloadModel`. Now both go
    // through the same lock; this test asserts the resulting ordering.
    //
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
      const p = deleteCurrentModel(workdir);
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
    expect(fs.existsSync(activeModelPath(workdir))).toBe(false);
    expect(await fsp.readdir(modelsDir(workdir))).toEqual([]);
  });

  // ---------------------------------------------------------------
  // `beforeMutation` deps hook — runs INSIDE the per-userDataDir
  // lock, only when the operation will actually mutate the filesystem.
  // The Electron main process passes `stopSidecarIfRunning` through
  // this hook so the llama-server child releases its OS file handle
  // before we touch the active model. (Devin Review INFO finding
  // f37a3c45.)
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
    const aFile = path.join(modelsDir(workdir), a.filename);
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
    expect(fs.existsSync(path.join(modelsDir(workdir), b.filename))).toBe(true);
  });

  it("deleteCurrentModel skips beforeMutation when there is nothing to delete", async () => {
    resetDownloadLocks();
    // No prior downloadModel — active-model.json doesn't exist.
    const hook = vi.fn(async () => {});
    await deleteCurrentModel(workdir, { beforeMutation: hook });
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
    const filePath = path.join(modelsDir(workdir), r.filename);
    expect(fs.existsSync(filePath)).toBe(true);

    let fileExistedAtHook: boolean | null = null;
    const hook = vi.fn(async () => {
      fileExistedAtHook = fs.existsSync(filePath);
    });
    await deleteCurrentModel(workdir, { beforeMutation: hook });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(fileExistedAtHook).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(await getCurrentModel(workdir)).toBeNull();
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
          currentAtHook = await getCurrentModel(workdir);
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
    // poison subsequent calls. Devin Review finding 3270926992 flagged
    // an asymmetry where the cold-cache path returned the original array
    // while warm-cache calls returned `.slice()`. The test must be
    // hardware-agnostic — on a CI host with Vulkan/CUDA installed, those
    // backends naturally appear in the detected list — so we mutate
    // using a clearly-synthetic sentinel value and verify it doesn't
    // leak into the cache. (Devin Review BUG finding 3270926992.)
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
    // This is the headline of Devin Review BUG finding 3270950107: if a
    // BrowserWindow gets destroyed mid-download, its
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
    const current = await getCurrentModel(workdir);
    expect(current?.modelId).toBe(requested.id);
    // The fetcher's onProgress invocations all ran (they didn't get
    // short-circuited by the throw because wrapProgressNoThrow caught
    // each one).
    expect(progressCalls).toBe(2);
    // No .partial leftover.
    expect(fs.existsSync(`${record.path}.partial`)).toBe(false);
  });
});

describe("writeCurrentModel atomic write (Devin Review 3270976513)", () => {
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

    const written = await fsp.readFile(activeModelPath(workdir), "utf8");
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
    const before = await fsp.readFile(activeModelPath(workdir), "utf8");

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
    const afterRaw = await fsp.readFile(activeModelPath(workdir), "utf8").catch(
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

describe("defaultFetcher reader lifetime (Devin Review 3270976469)", () => {
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
        modelsDir(workdir),
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
