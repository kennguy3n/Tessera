/**
 * Unit tests for the `kchatChannelSyncer` module's pure
 * filesystem helpers. The full `withChannelSyncLock` +
 * `downloadKchatFileToCache` coverage lives in
 * `kchatEventForwarder.test.ts` (which exercises them through
 * the forwarder's WS-event dispatch); this file focuses on the
 * helpers that are useful in isolation:
 *
 *   - `manifestPathFor` (Task 2: pure path helper)
 *   - `writeManifest` / `readManifest` (Task 2: atomic JSON I/O)
 *   - `secureDeleteChannelArtifacts` (Task 4: idempotent scrub)
 *
 * The forwarder-level tests pin the WIRING (revoke outcome →
 * helper call); these tests pin the BEHAVIOUR of the helper
 * itself so a future refactor of the wiring cannot regress the
 * scrub semantics undetected.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  manifestPathFor,
  readManifest,
  secureDeleteChannelArtifacts,
  writeManifest,
} from "../kchat/kchatChannelSyncer";

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "tessera-kchat-syncer-test-"),
  );
});

afterEach(async () => {
  try {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("manifestPathFor", () => {
  it("returns a sibling JSON path next to the cache directory", () => {
    const cacheDir = path.join(tmpRoot, "chan-abc");
    const manifest = manifestPathFor(cacheDir);
    // Sidecar is OUTSIDE `cacheDir` (next to it) so the corpus
    // indexer's directory walk doesn't pick up the manifest as
    // a document. Pin this layout invariant explicitly: parent
    // matches `cacheDir`'s parent, basename ends in `.manifest.json`.
    expect(path.dirname(manifest)).toBe(tmpRoot);
    expect(path.basename(manifest)).toBe("chan-abc.manifest.json");
  });
});

describe("writeManifest + readManifest", () => {
  it("round-trips a manifest payload", async () => {
    const cacheDir = path.join(tmpRoot, "chan-roundtrip");
    await fs.mkdir(cacheDir, { recursive: true });
    await writeManifest(cacheDir, {
      version: 1,
      channelId: "chan-roundtrip",
      files: {
        "file-1": "alpha.txt",
        "file-2": "bravo.txt",
      },
    });
    const read = await readManifest(cacheDir, "chan-roundtrip");
    expect(read.version).toBe(1);
    expect(read.channelId).toBe("chan-roundtrip");
    expect(read.files["file-1"]).toBe("alpha.txt");
    expect(read.files["file-2"]).toBe("bravo.txt");
  });

  it("returns an empty manifest when the sidecar does not exist", async () => {
    const cacheDir = path.join(tmpRoot, "chan-fresh");
    const read = await readManifest(cacheDir, "chan-fresh");
    expect(read.files).toEqual({});
  });
});

describe("secureDeleteChannelArtifacts", () => {
  it("removes the cache directory and its sidecar manifest", async () => {
    const cacheDir = path.join(tmpRoot, "chan-shred");
    const sidecarPath = manifestPathFor(cacheDir);
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "a.txt"), "content-a");
    await fs.writeFile(path.join(cacheDir, "b.txt"), "content-b");
    await writeManifest(cacheDir, {
      version: 1,
      channelId: "chan-shred",
      files: {
        "f-a": "a.txt",
        "f-b": "b.txt",
      },
    });

    // Sanity: both artifacts exist before the scrub.
    await expect(fs.access(cacheDir)).resolves.toBeUndefined();
    await expect(fs.access(sidecarPath)).resolves.toBeUndefined();

    await secureDeleteChannelArtifacts(cacheDir);

    // Cache directory and every file inside are gone.
    await expect(fs.access(cacheDir)).rejects.toThrow();
    // Manifest sidecar (sibling, not inside cacheDir) is also gone.
    await expect(fs.access(sidecarPath)).rejects.toThrow();
  });

  it("is idempotent on missing paths (no-throw second call)", async () => {
    const cacheDir = path.join(tmpRoot, "chan-missing");
    // The directory and manifest never existed; the call must
    // still return cleanly. This is the substrate-revoke
    // contract: a re-revoke on an already-scrubbed channel
    // re-invokes the helper, which must not fail.
    await expect(
      secureDeleteChannelArtifacts(cacheDir),
    ).resolves.toEqual({
      cacheDirRemoved: true,
      manifestRemoved: true,
    });

    // Second call (after a first scrub on a path that was
    // already missing) still resolves with the success shape
    // (idempotent on missing paths via `force: true`).
    await expect(
      secureDeleteChannelArtifacts(cacheDir),
    ).resolves.toEqual({
      cacheDirRemoved: true,
      manifestRemoved: true,
    });
  });

  it("removes nested files and subdirectories recursively", async () => {
    const cacheDir = path.join(tmpRoot, "chan-nested");
    const nested = path.join(cacheDir, "subdir", "deeper");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "top.txt"), "top");
    await fs.writeFile(path.join(nested, "deep.txt"), "deep");

    await secureDeleteChannelArtifacts(cacheDir);

    await expect(fs.access(cacheDir)).rejects.toThrow();
  });

  it("does not throw when only the cache directory exists (no sidecar)", async () => {
    const cacheDir = path.join(tmpRoot, "chan-no-sidecar");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "lone.txt"), "lone");

    await expect(
      secureDeleteChannelArtifacts(cacheDir),
    ).resolves.toEqual({
      cacheDirRemoved: true,
      manifestRemoved: true,
    });
    await expect(fs.access(cacheDir)).rejects.toThrow();
  });

  it("does not throw when only the sidecar exists (no cache dir)", async () => {
    const cacheDir = path.join(tmpRoot, "chan-only-sidecar");
    // Don't create cacheDir, but DO write a stray manifest at
    // the sidecar path. This mirrors a partial-state crash
    // scenario: the manifest was rewritten by a previous
    // process that died before re-creating the cache dir.
    const sidecar = manifestPathFor(cacheDir);
    await fs.writeFile(
      sidecar,
      JSON.stringify({ version: 1, channelId: "chan-only-sidecar", files: {} }),
    );

    await expect(
      secureDeleteChannelArtifacts(cacheDir),
    ).resolves.toEqual({
      cacheDirRemoved: true,
      manifestRemoved: true,
    });
    await expect(fs.access(sidecar)).rejects.toThrow();
  });

  /**
   * Block B Task 4 third-pass Devin Review fix
   * (filesystem-scrub observability): when `fs.rm` fails on the
   * cache dir (e.g. parent directory is read-only on POSIX or a
   * file is locked on Windows), the helper records the failure
   * in the result so the caller can surface it on the audit
   * row. The manifest scrub still runs — the two `fs.rm` calls
   * are independent. The helper itself never throws.
   */
  it("records cacheDirRemoved=false + error on fs.rm failure (parent read-only)", async () => {
    if (process.platform === "win32") {
      // Windows permission semantics differ; the Linux/macOS
      // chmod-based test pins the contract for POSIX. The
      // Rust-side audit logger test pins the row shape.
      return;
    }
    const cacheDir = path.join(tmpRoot, "chan-rm-failure");
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(path.join(cacheDir, "evidence.txt"), "locked");

    // Make the parent read+execute only — Linux rejects unlink
    // on a child of a non-writable parent (EACCES).
    const originalMode = (await fs.stat(tmpRoot)).mode;
    await fs.chmod(tmpRoot, 0o500);
    try {
      const result = await secureDeleteChannelArtifacts(cacheDir);
      expect(result.cacheDirRemoved).toBe(false);
      // Manifest doesn't exist (we didn't create one), but the
      // helper's `force: true` makes the missing-path case
      // succeed. However, because the manifest lives under
      // `tmpRoot` (which is now read-only) the unlink of the
      // *non-existent* manifest still succeeds via `force: true`
      // — `force` short-circuits ENOENT but doesn't help against
      // EACCES on a writable-by-creation child. Pin only the
      // cache-dir failure, since the manifest path's behavior
      // is platform-dependent here.
      expect(result.error).toBeDefined();
      expect(result.error).toContain("cacheDir");
    } finally {
      await fs.chmod(tmpRoot, originalMode);
      // Final cleanup: rm the cache dir we created for the test.
      await fs.rm(cacheDir, { recursive: true, force: true });
    }
  });
});
