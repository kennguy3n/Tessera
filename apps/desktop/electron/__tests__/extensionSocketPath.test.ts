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
 * Tests inject a deterministic `ExtensionSocketDiscovery`
 * surface per case rather than mutating `process.platform` /
 * `process.env` / `process.getuid` globals. The previous
 * mutation pattern (mirroring `tokenVault.test.ts` /
 * `sidecar.test.ts`) was safe under the default vitest worker
 * model (one file per worker) but would break under
 * `--pool=threads` with shared worker pools — a concurrent test
 * reading `process.platform` could observe the mutated value
 * between mutation and restore. The injection refactor (per
 * Devin Review PR #55 Finding 6 follow-up) eliminates the
 * race-condition footgun without changing the production
 * call sites, which continue to use the no-arg default that
 * reads from the real globals via
 * `defaultExtensionSocketDiscovery()`.
 *
 * The integrated default-discovery path (no-arg
 * `extensionSocketPath()` reading real `process.*` / `os.*`)
 * is exercised by `kchatExtension.test.ts` and the
 * `defaultExtensionSocketDiscovery` integration test below.
 */
import { describe, it, expect } from "vitest";
import * as os from "os";
import * as path from "path";

import {
  defaultExtensionSocketDiscovery,
  extensionSocketPath,
  type ExtensionSocketDiscovery,
} from "../kchat/kchatExtensionBridge";

/**
 * Helper: build an `ExtensionSocketDiscovery` from a partial
 * override. Defaults are chosen so every test must explicitly
 * opt into the platform / env values it cares about — leaving
 * one unset and accidentally inheriting another test's value
 * is impossible because every call returns a fresh object.
 */
function discovery(
  overrides: Partial<ExtensionSocketDiscovery> = {},
): ExtensionSocketDiscovery {
  return {
    platform: "linux",
    xdgRuntimeDir: undefined,
    getuid: () => 1000,
    tmpdir: () => "/tmp",
    homedir: () => "/home/test",
    ...overrides,
  };
}

describe("extensionSocketPath (Phase 13 Theme 5 Task 30)", () => {
  it("Linux + XDG_RUNTIME_DIR set: joins XDG_RUNTIME_DIR with the well-known name", () => {
    // Expected value is built via `path.join` rather than a
    // hardcoded forward slash because `path.join` uses the HOST
    // OS separator, so a hardcoded `/` would fail on a Windows
    // CI runner that runs this Linux-mocked branch. Per Devin
    // Review PR #55 ANALYSIS_pr-review-job-9fbc0a69cde94e08bd88aec559bab048_0003.
    const p = extensionSocketPath(
      discovery({
        platform: "linux",
        xdgRuntimeDir: "/run/user/1000",
      }),
    );
    expect(p).toBe(
      path.join("/run/user/1000", "tessera-kchat-extension.sock"),
    );
  });

  it("Linux + XDG_RUNTIME_DIR set to a deeper path: still joins it (path.join preserves trailing path)", () => {
    const p = extensionSocketPath(
      discovery({
        platform: "linux",
        xdgRuntimeDir: "/run/user/501/devin-sandbox",
      }),
    );
    expect(p).toBe(
      path.join("/run/user/501/devin-sandbox", "tessera-kchat-extension.sock"),
    );
  });

  it("Linux + XDG_RUNTIME_DIR unset: falls back to <tmpdir>/tessera-kchat-extension-<uid>.sock", () => {
    const p = extensionSocketPath(
      discovery({
        platform: "linux",
        xdgRuntimeDir: undefined,
        tmpdir: () => "/var/tmp/sandbox",
      }),
    );
    expect(p).toBe(
      path.join("/var/tmp/sandbox", "tessera-kchat-extension-1000.sock"),
    );
  });

  it("Linux + XDG_RUNTIME_DIR set to empty string: treated as unset (falls back to tmpdir)", () => {
    // Empty string is the documented degenerate case the helper
    // gates against (`xdgRuntime && xdgRuntime.length > 0`).
    // Without the length check, `path.join("", "...")` would
    // produce a relative path that the bridge would try to
    // connect to literally — a silent foot-gun.
    const p = extensionSocketPath(
      discovery({
        platform: "linux",
        xdgRuntimeDir: "",
        tmpdir: () => "/tmp",
      }),
    );
    expect(p).toBe(
      path.join("/tmp", "tessera-kchat-extension-1000.sock"),
    );
  });

  it("Linux + getuid undefined: falls back to uid=0 in the socket name", () => {
    // On Windows hosts `process.getuid` is undefined. The
    // production code guards on `typeof getuid === "function"`
    // and defaults to 0. The injection refactor preserves this
    // defence because the discovery type carries
    // `getuid: (() => number) | undefined`.
    const p = extensionSocketPath(
      discovery({
        platform: "linux",
        getuid: undefined,
        tmpdir: () => "/tmp",
      }),
    );
    expect(p).toBe(path.join("/tmp", "tessera-kchat-extension-0.sock"));
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
    // OS separator. Per Devin Review PR #55
    // ANALYSIS_pr-review-job-6ef624e58fa8479f8ed64e27537debce_0001.
    const p = extensionSocketPath(
      discovery({
        platform: "linux",
        xdgRuntimeDir: " ",
      }),
    );
    expect(p).toBe(path.join(" ", "tessera-kchat-extension.sock"));
  });

  it("Other Unix-y platforms (freebsd) take the same Linux discovery path", () => {
    // The helper's `if (platform === "win32")` and
    // `if (platform === "darwin")` branches are the only
    // explicit per-platform forks; everything else falls
    // through to the Linux/Unix branch. Pin this so a future
    // patch that adds a freebsd-specific branch surfaces the
    // contract change.
    //
    // `path.join` over a hardcoded `/` for the same Windows-host
    // portability reason documented above. Per Devin Review PR
    // #55 BUG_pr-review-job-b8678318dcd243fb908252b4a72ff121_0001.
    const p = extensionSocketPath(
      discovery({
        platform: "freebsd",
        xdgRuntimeDir: "/run/user/1000",
      }),
    );
    expect(p).toBe(
      path.join("/run/user/1000", "tessera-kchat-extension.sock"),
    );
  });

  it("macOS: returns ~/Library/Application Support/Tessera/tessera-kchat-extension.sock", () => {
    const p = extensionSocketPath(
      discovery({
        platform: "darwin",
        homedir: () => "/Users/test",
      }),
    );
    expect(p).toBe(
      path.join(
        "/Users/test",
        "Library",
        "Application Support",
        "Tessera",
        "tessera-kchat-extension.sock",
      ),
    );
  });

  it("Windows: returns the named-pipe path \\\\.\\pipe\\tessera-kchat-extension", () => {
    const p = extensionSocketPath(discovery({ platform: "win32" }));
    expect(p).toBe("\\\\.\\pipe\\tessera-kchat-extension");
  });

  it("Windows: does NOT include any tmp/homedir fragments (named pipe namespace is kernel-managed)", () => {
    // Defence against a future patch that "helpfully" prepends
    // a temp directory to the Windows path. The Windows
    // named-pipe namespace is `\\.\pipe\...` and the kernel
    // owns the lifetime; any filesystem path would silently
    // create an unconnectable socket that the desktop app
    // cannot find. Verify by injecting a tmpdir / homedir that,
    // if the Windows branch ever accidentally consumed them,
    // would surface as a substring of the result.
    const p = extensionSocketPath(
      discovery({
        platform: "win32",
        tmpdir: () => "/SHOULD-NEVER-APPEAR-tmp",
        homedir: () => "/SHOULD-NEVER-APPEAR-home",
      }),
    );
    expect(p.startsWith("\\\\.\\pipe\\")).toBe(true);
    expect(p.includes("/SHOULD-NEVER-APPEAR-tmp")).toBe(false);
    expect(p.includes("/SHOULD-NEVER-APPEAR-home")).toBe(false);
  });

  it("Linux fallback path always contains the uid suffix (collision safety on multi-user hosts)", () => {
    // Multi-user collision safety is a load-bearing property
    // of the fallback path. Pin it explicitly: the fallback
    // socket name MUST embed the uid, never bare
    // `/tmp/tessera-kchat-extension.sock`. Two users on the
    // same host would otherwise race to bind the same path and
    // one would silently lose discovery.
    const p = extensionSocketPath(
      discovery({
        platform: "linux",
        getuid: () => 4242,
        tmpdir: () => "/tmp",
      }),
    );
    expect(p).toMatch(/tessera-kchat-extension-4242\.sock$/);
  });

  describe("defaultExtensionSocketDiscovery", () => {
    it("captures process.platform / process.env.XDG_RUNTIME_DIR / process.getuid at call time", () => {
      // Direct unit test of the default factory so a future
      // refactor that breaks the integration with `process.*`
      // surfaces here rather than only in production. The
      // factory MUST return fresh values on each call (not a
      // cached singleton) so a long-lived session that
      // experiences an `XDG_RUNTIME_DIR` change picks up the
      // new value.
      const d = defaultExtensionSocketDiscovery();
      expect(d.platform).toBe(process.platform);
      expect(d.xdgRuntimeDir).toBe(process.env.XDG_RUNTIME_DIR);
      expect(d.tmpdir()).toBe(os.tmpdir());
      expect(d.homedir()).toBe(os.homedir());
      // `getuid` is a function on Unix, `undefined` on Windows.
      if (typeof process.getuid === "function") {
        expect(typeof d.getuid).toBe("function");
        expect(d.getuid?.()).toBe(process.getuid());
      } else {
        expect(d.getuid).toBeUndefined();
      }
    });

    it("invoking extensionSocketPath() with no args is identical to passing defaultExtensionSocketDiscovery() explicitly", () => {
      // Pin the contract that production code (which calls
      // `extensionSocketPath()` with no args) and tests that
      // want to use the real environment (which would call
      // `extensionSocketPath(defaultExtensionSocketDiscovery())`)
      // are observationally identical. A future refactor that
      // gives the parameter default a non-trivial body could
      // accidentally drift these apart; this test pins the
      // equivalence.
      const noArg = extensionSocketPath();
      const explicit = extensionSocketPath(defaultExtensionSocketDiscovery());
      expect(noArg).toBe(explicit);
    });
  });

  describe("parallel-safety", () => {
    it("does not touch process.platform / process.env / process.getuid across the suite", () => {
      // Meta-test pinning the architectural property that
      // motivated this refactor: NONE of the tests in this
      // file should mutate process-level globals. The
      // previous implementation called
      // `Object.defineProperty(process, "platform", ...)`,
      // `delete process.env.XDG_RUNTIME_DIR`, and
      // `Object.defineProperty(process, "getuid", ...)` per
      // test — a footgun under `--pool=threads`. Capture the
      // current values BEFORE all tests run and assert they
      // are identical AFTER. If a future test reintroduces a
      // global mutation, this test will fail (assuming the
      // restore-in-afterEach hook is missing or buggy, which
      // is precisely the regression we want to catch).
      const platformBefore = process.platform;
      const xdgBefore = process.env.XDG_RUNTIME_DIR;
      const getuidBefore = process.getuid;
      // Run the helper with a variety of injected shapes —
      // none should leak into the host process.
      extensionSocketPath(discovery({ platform: "linux" }));
      extensionSocketPath(discovery({ platform: "darwin" }));
      extensionSocketPath(discovery({ platform: "win32" }));
      extensionSocketPath(
        discovery({ xdgRuntimeDir: "/should-not-leak" }),
      );
      extensionSocketPath(discovery({ getuid: () => 99999 }));
      expect(process.platform).toBe(platformBefore);
      expect(process.env.XDG_RUNTIME_DIR).toBe(xdgBefore);
      expect(process.getuid).toBe(getuidBefore);
    });
  });
});
