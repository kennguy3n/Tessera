/**
 * Tests for the diffusion sidecar's binary-resolution helper.
 *
 * The lifecycle methods of `DiffusionSidecar` itself are exercised
 * indirectly through `imagegenIpc.test.ts` (which mocks the sidecar
 * end-to-end via the `getDiffusionSidecar` accessor). This file
 * focuses on `resolveDiffusionBinary` because it is the only piece
 * of `diffusionSidecar.ts` that needs to talk to the real filesystem
 * — and the bug-fix Devin Review flagged (returning `candidates[0]`
 * unconditionally instead of checking existence) is exactly the
 * kind of regression that warrants a direct test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import { resolveDiffusionBinary } from "../diffusionSidecar";

describe("resolveDiffusionBinary", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tessera-diffusion-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  });

  function binaryName(): string {
    return process.platform === "win32" ? "sd-server.exe" : "sd-server";
  }

  async function makeBinaryAt(relSegments: string[]): Promise<string> {
    const dir = path.join(tmpRoot, ...relSegments);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, binaryName());
    await fsp.writeFile(target, "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") {
      await fsp.chmod(target, 0o755);
    }
    return target;
  }

  it("returns the resourcesPath candidate when the binary exists there", async () => {
    const resources = path.join(tmpRoot, "resources");
    const expected = await makeBinaryAt(["resources", "sidecars", "sd-server"]);

    const resolved = resolveDiffusionBinary(
      path.join(tmpRoot, "app"),
      path.join(tmpRoot, "scripts"),
      resources,
    );

    expect(resolved).toBe(expected);
  });

  it("falls through to the appPath candidate when the resourcesPath binary is absent", async () => {
    // resourcesPath is supplied but no binary lives under it; the
    // helper must iterate to the next candidate (appPath) before
    // returning. Without the existence-check fix, this test fails
    // because `candidates[0]` (the resourcesPath candidate) is
    // returned even though no file exists there.
    const resources = path.join(tmpRoot, "resources-empty");
    const appPath = path.join(tmpRoot, "app");
    const expected = await makeBinaryAt(["app", "sidecars", "sd-server"]);

    const resolved = resolveDiffusionBinary(
      appPath,
      path.join(tmpRoot, "scripts"),
      resources,
    );

    expect(resolved).toBe(expected);
    // Existence sanity: the iterator must have skipped the
    // resourcesPath candidate because no file exists there.
    expect(
      fs.existsSync(
        path.join(resources, "sidecars", "sd-server", binaryName()),
      ),
    ).toBe(false);
  });

  it("falls through to the parent-of-appPath candidate when the appPath binary is absent", async () => {
    // The dev layout often has sidecars at <repo>/sidecars/ and
    // appPath at <repo>/apps/desktop, so the second candidate
    // (appPath/.. + sidecars/sd-server) is the canonical hit on
    // development machines.
    const appPath = path.join(tmpRoot, "repo", "apps", "desktop");
    const expected = await makeBinaryAt([
      "repo",
      "apps",
      "sidecars",
      "sd-server",
    ]);

    const resolved = resolveDiffusionBinary(
      appPath,
      path.join(tmpRoot, "scripts"),
      undefined,
    );

    expect(resolved).toBe(expected);
  });

  it("falls back to the bare binary name when no candidate exists", () => {
    // No binary anywhere on the candidate list — the helper must
    // return the bare binary name so PATH-resolution can take over
    // (or `spawn()` can surface a clean ENOENT). Returning the
    // first candidate path in this case would have looked
    // identical to a successful resolution to callers, which would
    // mask "binary not installed" errors as opaque spawn failures.
    const appPath = path.join(tmpRoot, "no-app");
    const scriptsPath = path.join(tmpRoot, "no-scripts");

    const resolved = resolveDiffusionBinary(appPath, scriptsPath, undefined);

    expect(resolved).toBe(binaryName());
  });

  it("ignores a missing resourcesPath entirely", async () => {
    // When `resourcesPath` is undefined, the helper must skip the
    // resourcesPath candidate cleanly rather than emitting a
    // `path.join(undefined, ...)` (which would throw).
    const appPath = path.join(tmpRoot, "app2");
    const expected = await makeBinaryAt(["app2", "sidecars", "sd-server"]);

    const resolved = resolveDiffusionBinary(
      appPath,
      path.join(tmpRoot, "scripts2"),
      undefined,
    );

    expect(resolved).toBe(expected);
  });

  // Cross-platform `.exe`-suffix tests. These pin the per-platform
  // branch of the resolver via the injected `platform` argument —
  // the same parallel-safe pattern landed for `ModelSidecar` /
  // `DiffusionSidecar` / `buildSpawnEnv()` in this PR. Without these
  // tests, the new `platform: NodeJS.Platform = process.platform`
  // parameter is declared but only exercised through the live-
  // platform default — a future regression that swapped the ternary
  // (e.g., `platform === "linux" ? ".exe" : ""`) would only surface
  // on Windows CI, defeating the point of the injection surface.
  // Per Devin Review PR #59 pass 3.
  it("appends .exe to the binary name when platform is injected as win32", () => {
    // No binaries exist on disk, so the resolver falls through to
    // the bare-binary-name fallback. That bare name MUST reflect the
    // injected platform's extension policy, not the host's.
    const appPath = path.join(tmpRoot, "no-app");
    const scriptsPath = path.join(tmpRoot, "no-scripts");

    const resolved = resolveDiffusionBinary(
      appPath,
      scriptsPath,
      undefined,
      "win32",
    );

    expect(resolved).toBe("sd-server.exe");
  });

  it("omits .exe on POSIX platforms when platform is injected as linux", () => {
    const appPath = path.join(tmpRoot, "no-app");
    const scriptsPath = path.join(tmpRoot, "no-scripts");

    const resolved = resolveDiffusionBinary(
      appPath,
      scriptsPath,
      undefined,
      "linux",
    );

    expect(resolved).toBe("sd-server");
  });

  it("omits .exe on POSIX platforms when platform is injected as darwin", () => {
    const appPath = path.join(tmpRoot, "no-app");
    const scriptsPath = path.join(tmpRoot, "no-scripts");

    const resolved = resolveDiffusionBinary(
      appPath,
      scriptsPath,
      undefined,
      "darwin",
    );

    expect(resolved).toBe("sd-server");
  });

  // Regression: the no-platform-arg call must produce the same
  // result as the explicit-platform call for the host's live
  // `process.platform`. Without this lock the no-arg-default path
  // could drift silently from the explicit path.
  it("no-platform call matches the explicit-platform call for the live platform", () => {
    const appPath = path.join(tmpRoot, "no-app");
    const scriptsPath = path.join(tmpRoot, "no-scripts");

    const noArg = resolveDiffusionBinary(appPath, scriptsPath, undefined);
    const explicit = resolveDiffusionBinary(
      appPath,
      scriptsPath,
      undefined,
      process.platform,
    );

    expect(noArg).toBe(explicit);
  });

  // Parallel-safety meta-test: exercising the resolver with various
  // injected platforms must not mutate `process.platform`. This
  // mirrors the meta-tests in `sidecar.test.ts` and `tokenVault.test.ts`
  // (originating pattern landed in PR #57; the originating test file
  // was removed in PR #58 along with the socket-bridge surface).
  it("does not mutate process.platform when called with various platforms", () => {
    const before = process.platform;
    const appPath = path.join(tmpRoot, "no-app");
    const scriptsPath = path.join(tmpRoot, "no-scripts");

    for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
      resolveDiffusionBinary(appPath, scriptsPath, undefined, platform);
    }

    expect(process.platform).toBe(before);
  });
});
