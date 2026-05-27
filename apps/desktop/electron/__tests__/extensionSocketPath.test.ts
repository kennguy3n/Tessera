/**
 * Phase 13 Theme 5 Task 30 — regression-test pin for the
 * `extensionSocketPath()` per-platform discovery helper in
 * `kchatExtensionBridge.ts`.
 *
 * PROGRESS.md marks Task 30 ("Linux-specific extension discovery
 * at $XDG_RUNTIME_DIR/tessera-kchat-extension.sock") as DONE,
 * but the existing test suite never exercises the helper
 * directly — `kchatExtension.test.ts` always passes an explicit
 * `socketPath: server.socketPath` so the production discovery
 * branch is bypassed. This file fills that gap by pinning all
 * four discovery cases:
 *
 *   - Linux + `XDG_RUNTIME_DIR` set → joins XDG_RUNTIME_DIR with
 *     the well-known socket name. This is the freedesktop.org
 *     base-dir spec compliant location: a per-user tmpfs that is
 *     guaranteed to be cleaned up on logout, which is the
 *     correct lifetime for an ephemeral IPC socket. Without this
 *     branch the desktop app and Tessera would not agree on the
 *     socket location and the bridge would silently fail to
 *     discover the extension on session start.
 *   - Linux + `XDG_RUNTIME_DIR` unset → falls back to
 *     `<os.tmpdir>/tessera-kchat-extension-<uid>.sock`. The
 *     uid suffix is critical on multi-user systems where two
 *     users running Tessera under the same `/tmp` would
 *     otherwise collide on the same path. Minimal containers and
 *     some CI runners don't set XDG_RUNTIME_DIR, so this branch
 *     is the production-traversed path in those environments.
 *   - macOS → `~/Library/Application Support/Tessera/...`. Same
 *     directory shape `dbKey.ts` uses for the SQLCipher key
 *     blob; users expect Tessera state to be co-located.
 *   - Windows → `\\.\pipe\tessera-kchat-extension`. Windows
 *     `net.Server` can only bind to named pipes (no Unix-domain
 *     socket support); the pipe lifetime is owned by the kernel
 *     so no filesystem unlink is needed.
 *
 * The test mutates `process.platform`, `process.env.XDG_RUNTIME_DIR`,
 * and `process.getuid` per case, restoring originals in
 * `afterEach`. The pattern mirrors the existing
 * `tokenVault.test.ts` / `sidecar.test.ts` setups.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as os from "os";
import * as path from "path";

import { extensionSocketPath } from "../kchat/kchatExtensionBridge";

describe("extensionSocketPath (Phase 13 Theme 5 Task 30)", () => {
  const originalPlatform = process.platform;
  const originalXdg = process.env.XDG_RUNTIME_DIR;
  const originalGetuid = process.getuid;

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", {
      value: p,
      configurable: true,
    });
  }

  beforeEach(() => {
    // Default: clear XDG so each test must opt into setting it.
    delete process.env.XDG_RUNTIME_DIR;
    // Default: stub `getuid` to a known value so the fallback
    // path is deterministic across host environments (some CI
    // runners might not even expose `process.getuid`).
    Object.defineProperty(process, "getuid", {
      value: () => 1000,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    if (originalXdg === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdg;
    }
    // Restore the original getuid (may be a function or
    // undefined on Windows hosts).
    Object.defineProperty(process, "getuid", {
      value: originalGetuid,
      configurable: true,
      writable: true,
    });
  });

  it("Linux + XDG_RUNTIME_DIR set: joins XDG_RUNTIME_DIR with the well-known name", () => {
    // Expected value is built via `path.join` rather than a
    // hardcoded forward slash because `path.join` uses the HOST
    // OS separator (not the mocked `process.platform`), so a
    // hardcoded `/` would fail on a Windows CI runner that runs
    // this Linux-mocked branch. Per Devin Review PR #55
    // ANALYSIS_pr-review-job-9fbc0a69cde94e08bd88aec559bab048_0003.
    setPlatform("linux");
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    const p = extensionSocketPath();
    expect(p).toBe(
      path.join("/run/user/1000", "tessera-kchat-extension.sock"),
    );
  });

  it("Linux + XDG_RUNTIME_DIR set to a deeper path: still joins it (path.join preserves trailing path)", () => {
    setPlatform("linux");
    process.env.XDG_RUNTIME_DIR = "/run/user/501/devin-sandbox";
    const p = extensionSocketPath();
    expect(p).toBe(
      path.join("/run/user/501/devin-sandbox", "tessera-kchat-extension.sock"),
    );
  });

  it("Linux + XDG_RUNTIME_DIR unset: falls back to <tmpdir>/tessera-kchat-extension-<uid>.sock", () => {
    setPlatform("linux");
    // Use the platform-correct tmpdir so the expected path
    // matches regardless of host OS quirks (test runners on
    // macOS report `/var/folders/...`; Linux reports `/tmp`).
    const expectedTmp = os.tmpdir();
    const p = extensionSocketPath();
    expect(p).toBe(path.join(expectedTmp, "tessera-kchat-extension-1000.sock"));
  });

  it("Linux + XDG_RUNTIME_DIR set to empty string: treated as unset (falls back to tmpdir)", () => {
    // Empty string is the documented degenerate case the helper
    // gates against (`xdgRuntime && xdgRuntime.length > 0`).
    // Without the length check, `path.join("", "...")` would
    // produce a relative path that the bridge would try to
    // connect to literally — a silent foot-gun.
    setPlatform("linux");
    process.env.XDG_RUNTIME_DIR = "";
    const p = extensionSocketPath();
    expect(p).toBe(
      path.join(os.tmpdir(), "tessera-kchat-extension-1000.sock"),
    );
  });

  it("Linux + getuid undefined: falls back to uid=0 in the socket name", () => {
    // On Windows hosts `process.getuid` is undefined. The
    // production code guards on `typeof process.getuid ===
    // "function"` and defaults to 0. We exercise that defence
    // by deleting the property, then asserting the suffix.
    setPlatform("linux");
    Object.defineProperty(process, "getuid", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const p = extensionSocketPath();
    expect(p).toBe(
      path.join(os.tmpdir(), "tessera-kchat-extension-0.sock"),
    );
  });

  it("Linux + XDG_RUNTIME_DIR set to whitespace-only: treated as set (path.join is the literal user request)", () => {
    // Documenting the actual behaviour: the production guard is
    // `xdgRuntime.length > 0`, not `xdgRuntime.trim().length > 0`.
    // A whitespace-only value is a malformed env var the caller
    // is responsible for; we don't silently second-guess. If a
    // future commit decides to .trim() the value, this test
    // will fail loudly and the commit message should document
    // the intentional behaviour change.
    //
    // The expected value is built via `path.join` rather than a
    // hardcoded forward slash because `path.join` uses the HOST
    // OS separator (not the mocked `process.platform`), so a
    // hardcoded `/` would fail on a Windows CI runner that still
    // exercises this Linux-mocked branch. Per Devin Review PR
    // #55 ANALYSIS_pr-review-job-6ef624e58fa8479f8ed64e27537debce_0001.
    setPlatform("linux");
    process.env.XDG_RUNTIME_DIR = " ";
    const p = extensionSocketPath();
    expect(p).toBe(path.join(" ", "tessera-kchat-extension.sock"));
  });

  it("Other Unix-y platforms (freebsd) take the same Linux discovery path", () => {
    // The helper's `if (platform === "win32")` and
    // `if (platform === "darwin")` branches are the only
    // explicit per-platform forks; everything else falls
    // through to the Linux/Unix branch. Pin this so a future
    // patch that adds a freebsd-specific branch surfaces the
    // contract change.
    setPlatform("freebsd");
    process.env.XDG_RUNTIME_DIR = "/run/user/1000";
    const p = extensionSocketPath();
    expect(p).toBe("/run/user/1000/tessera-kchat-extension.sock");
  });

  it("macOS: returns ~/Library/Application Support/Tessera/tessera-kchat-extension.sock", () => {
    setPlatform("darwin");
    const expected = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Tessera",
      "tessera-kchat-extension.sock",
    );
    const p = extensionSocketPath();
    expect(p).toBe(expected);
  });

  it("Windows: returns the named-pipe path \\\\.\\pipe\\tessera-kchat-extension", () => {
    setPlatform("win32");
    const p = extensionSocketPath();
    expect(p).toBe("\\\\.\\pipe\\tessera-kchat-extension");
  });

  it("Windows: does NOT include any tmp/homedir fragments (named pipe namespace is kernel-managed)", () => {
    // Defence against a future patch that "helpfully" prepends
    // a temp directory to the Windows path. The Windows
    // named-pipe namespace is `\\.\pipe\...` and the kernel
    // owns the lifetime; any filesystem path would silently
    // create an unconnectable socket that the desktop app
    // cannot find.
    setPlatform("win32");
    const p = extensionSocketPath();
    expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
    expect(p.includes(os.tmpdir())).toBe(false);
  });

  it("Linux fallback path always contains the uid suffix (collision safety on multi-user hosts)", () => {
    // Multi-user collision safety is a load-bearing property
    // of the fallback path. Pin it explicitly: the fallback
    // socket name MUST embed the uid, never bare
    // `/tmp/tessera-kchat-extension.sock`. Two users on the
    // same host would otherwise race to bind the same path and
    // one would silently lose discovery.
    setPlatform("linux");
    Object.defineProperty(process, "getuid", {
      value: () => 4242,
      configurable: true,
      writable: true,
    });
    const p = extensionSocketPath();
    expect(p).toMatch(/tessera-kchat-extension-4242\.sock$/);
  });
});
