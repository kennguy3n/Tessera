/**
 * Tests for the keychain ACL policy.
 *
 * These tests exercise the real `keychainAcl.ts` module against a
 * stubbed `safeStorage` (Electron's `safeStorage` cannot run in a
 * vitest context) and the test-only `_setPlatformForTests` /
 * `_resetBootBackendForTests` hooks. The algorithm under test (backend
 * classification, trust tiering, enforcement decision) runs end-to-end
 * with real logic — no crypto / no telemetry mocks beyond what's
 * needed to capture the recorded counter names.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

// ---- mock state via vi.hoisted -----------------------------------------
//
// `keychainAcl.ts` imports `safeStorage` from `electron`, `getLogger`
// from `../logger`, and `recordCounter` from `../telemetrySink`. The
// `vi.mock` factories below are hoisted to the top of the file by
// vitest's transformer, BEFORE any `const` declarations — so we use
// `vi.hoisted` to publish the shared mutable state to the same hoisted
// scope. The factories close over the hoisted state; the test bodies
// reset / read it via the same references.

const mockState = vi.hoisted(() => {
  interface FakeSafeStorage {
    isEncryptionAvailable: () => boolean;
    getSelectedStorageBackend?: () => string;
  }
  return {
    fakeSafeStorage: {
      isEncryptionAvailable: () => true,
    } as FakeSafeStorage,
    logCalls: [] as Array<{
      level: string;
      msg: string;
      meta: Record<string, unknown> | undefined;
    }>,
    counterCalls: [] as string[],
  };
});

vi.mock("electron", () => ({
  safeStorage: mockState.fakeSafeStorage,
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    info: (msg: string, meta?: Record<string, unknown>) =>
      mockState.logCalls.push({ level: "info", msg, meta }),
    warn: (msg: string, meta?: Record<string, unknown>) =>
      mockState.logCalls.push({ level: "warn", msg, meta }),
    error: (msg: string, meta?: Record<string, unknown>) =>
      mockState.logCalls.push({ level: "error", msg, meta }),
    debug: () => {},
  }),
}));

vi.mock("../telemetrySink", () => ({
  recordCounter: (name: string) => mockState.counterCalls.push(name),
}));

const { fakeSafeStorage, logCalls, counterCalls } = mockState;

// ---- imports under test ------------------------------------------------

import {
  KeychainAclError,
  _resetBootBackendForTests,
  _setPlatformForTests,
  assertSafeEncrypt,
  captureBackendAtBoot,
  computeBackend,
  getBootBackend,
  keychainBackendDescriptor,
} from "../keychainAcl";

beforeEach(() => {
  fakeSafeStorage.isEncryptionAvailable = () => true;
  fakeSafeStorage.getSelectedStorageBackend = undefined;
  logCalls.length = 0;
  counterCalls.length = 0;
  _setPlatformForTests(null);
  _resetBootBackendForTests();
});

afterEach(() => {
  _setPlatformForTests(null);
  _resetBootBackendForTests();
});

describe("computeBackend", () => {
  it("returns `unavailable` when safeStorage reports no encryption available", () => {
    fakeSafeStorage.isEncryptionAvailable = () => false;
    _setPlatformForTests("linux");
    expect(computeBackend()).toBe("unavailable");
  });

  it("returns `os_managed` on macOS", () => {
    _setPlatformForTests("darwin");
    expect(computeBackend()).toBe("os_managed");
  });

  it("returns `os_managed` on Windows", () => {
    _setPlatformForTests("win32");
    expect(computeBackend()).toBe("os_managed");
  });

  it("returns the Linux backend reported by safeStorage when present", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "kwallet6";
    expect(computeBackend()).toBe("kwallet6");
  });

  it("returns `basic_text` on Linux when safeStorage reports the fallback", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";
    expect(computeBackend()).toBe("basic_text");
  });

  it("normalises an unknown Linux backend string to `unknown`", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () =>
      "future_unreleased_backend";
    expect(computeBackend()).toBe("unknown");
  });

  it("returns `unknown` on an unsupported platform", () => {
    _setPlatformForTests("freebsd" as NodeJS.Platform);
    expect(computeBackend()).toBe("unknown");
  });
});

describe("keychainBackendDescriptor", () => {
  it("on macOS reports enforced-by-os + perAppAcl: true", () => {
    _setPlatformForTests("darwin");
    const d = keychainBackendDescriptor();
    expect(d).toEqual({
      name: "os_managed",
      trustTier: "enforced-by-os",
      encryptionEnforced: true,
      perAppAcl: true,
      platform: "darwin",
    });
  });

  it("on Windows reports user-scoped + perAppAcl: false (DPAPI is per-user)", () => {
    _setPlatformForTests("win32");
    const d = keychainBackendDescriptor();
    expect(d.trustTier).toBe("user-scoped");
    expect(d.perAppAcl).toBe(false);
    expect(d.encryptionEnforced).toBe(true);
  });

  it("on Linux/gnome_libsecret reports user-scoped", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
    const d = keychainBackendDescriptor();
    expect(d.name).toBe("gnome_libsecret");
    expect(d.trustTier).toBe("user-scoped");
    expect(d.encryptionEnforced).toBe(true);
    expect(d.perAppAcl).toBe(false);
  });

  it("on Linux/basic_text reports trust tier `none` and encryptionEnforced: false", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";
    const d = keychainBackendDescriptor();
    expect(d.trustTier).toBe("none");
    expect(d.encryptionEnforced).toBe(false);
    expect(d.perAppAcl).toBe(false);
  });

  it("when safeStorage is unavailable reports `none-unavailable`", () => {
    fakeSafeStorage.isEncryptionAvailable = () => false;
    _setPlatformForTests("linux");
    const d = keychainBackendDescriptor();
    expect(d.name).toBe("unavailable");
    expect(d.trustTier).toBe("none-unavailable");
    expect(d.encryptionEnforced).toBe(false);
  });
});

describe("captureBackendAtBoot", () => {
  it("emits one INFO log and one telemetry counter on first call", () => {
    _setPlatformForTests("darwin");
    const d = captureBackendAtBoot();
    expect(d.name).toBe("os_managed");
    expect(d.trustTier).toBe("enforced-by-os");
    expect(
      logCalls.filter((l) => l.msg === "keychain.backend.boot"),
    ).toHaveLength(1);
    expect(counterCalls).toEqual(["keychain.backend.os_managed"]);
  });

  it("is idempotent — second call returns the cached descriptor and does NOT re-emit telemetry", () => {
    _setPlatformForTests("darwin");
    captureBackendAtBoot();
    captureBackendAtBoot();
    captureBackendAtBoot();
    expect(counterCalls).toHaveLength(1);
    expect(
      logCalls.filter((l) => l.msg === "keychain.backend.boot"),
    ).toHaveLength(1);
  });

  it("records the Linux-specific backend name in the counter", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";
    captureBackendAtBoot();
    expect(counterCalls).toEqual(["keychain.backend.basic_text"]);
  });

  it("emits a dedicated WARN at boot when the basic_text fallback is detected", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";
    captureBackendAtBoot();
    const warns = logCalls.filter(
      (l) => l.msg === "keychain.backend.basic_text_fallback_detected",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].level).toBe("warn");
    expect(warns[0].meta).toMatchObject({ backend: "basic_text" });
  });

  it("does NOT emit the basic_text WARN at boot for a healthy backend", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "kwallet6";
    captureBackendAtBoot();
    expect(
      logCalls.filter(
        (l) => l.msg === "keychain.backend.basic_text_fallback_detected",
      ),
    ).toHaveLength(0);
  });

  it("getBootBackend returns null before capture, the descriptor after", () => {
    expect(getBootBackend()).toBe(null);
    _setPlatformForTests("darwin");
    captureBackendAtBoot();
    const d = getBootBackend();
    expect(d).not.toBe(null);
    expect(d!.name).toBe("os_managed");
  });
});

describe("assertSafeEncrypt enforcement policy", () => {
  it("throws KeychainAclError on basic_text when enforce=true", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";
    let caught: unknown = null;
    try {
      assertSafeEncrypt({ enforce: true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KeychainAclError);
    const err = caught as KeychainAclError;
    expect(err.code).toBe("keychain_acl_violation");
    expect(err.backend).toBe("basic_text");
    expect(err.trustTier).toBe("none");
    expect(err.message).toMatch(/basic_text/);
    expect(err.message).toMatch(/gnome-keyring|kwallet/);
  });

  it("logs WARN but does NOT throw on basic_text when enforce=false", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";
    assertSafeEncrypt({ enforce: false });
    const warns = logCalls.filter(
      (l) => l.msg === "keychain.acl.unenforced_basic_text",
    );
    expect(warns).toHaveLength(1);
  });

  it("emits the basic_text detection WARN in BOTH enforce modes", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";

    // enforce=false: warns and proceeds.
    assertSafeEncrypt({ enforce: false });
    let detect = logCalls.filter(
      (l) => l.msg === "keychain.acl.basic_text_fallback_detected",
    );
    expect(detect).toHaveLength(1);
    expect(detect[0].meta).toMatchObject({
      backend: "basic_text",
      enforce: false,
    });

    // enforce=true: warns THEN throws (the warning precedes the block
    // so the security event is recorded even when the write is
    // refused).
    logCalls.length = 0;
    expect(() => assertSafeEncrypt({ enforce: true })).toThrow(
      KeychainAclError,
    );
    detect = logCalls.filter(
      (l) => l.msg === "keychain.acl.basic_text_fallback_detected",
    );
    expect(detect).toHaveLength(1);
    expect(detect[0].meta).toMatchObject({
      backend: "basic_text",
      enforce: true,
    });
  });

  it("is a no-op for os_managed regardless of enforce flag", () => {
    _setPlatformForTests("darwin");
    assertSafeEncrypt({ enforce: true });
    assertSafeEncrypt({ enforce: false });
    expect(
      logCalls.filter((l) => l.msg.startsWith("keychain.acl.")),
    ).toHaveLength(0);
  });

  it("is a no-op for user-scoped Linux backends (gnome_libsecret)", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "gnome_libsecret";
    assertSafeEncrypt({ enforce: true });
    expect(
      logCalls.filter((l) => l.msg === "keychain.acl.unenforced_basic_text"),
    ).toHaveLength(0);
  });

  it("is a no-op when safeStorage is `unavailable` (password vault handles writes)", () => {
    fakeSafeStorage.isEncryptionAvailable = () => false;
    _setPlatformForTests("linux");
    // No throw, no warn — the password-vault fallback in
    // `encryptForVault` will handle this case with real PBKDF2 +
    // AES-256-GCM, which is cryptographically sound.
    assertSafeEncrypt({ enforce: true });
    expect(
      logCalls.filter((l) => l.msg.startsWith("keychain.acl.")),
    ).toHaveLength(0);
  });

  it("logs a WARN on mid-session backend drift (kwallet at boot, basic_text now)", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "kwallet6";
    captureBackendAtBoot();
    expect(getBootBackend()!.name).toBe("kwallet6");
    // Simulate kwallet daemon dying mid-session — safeStorage now
    // reports basic_text. enforce=false so we don't throw, but we
    // should log the drift warning.
    fakeSafeStorage.getSelectedStorageBackend = () => "basic_text";
    assertSafeEncrypt({ enforce: false });
    const drifts = logCalls.filter((l) => l.msg === "keychain.backend.drift");
    expect(drifts).toHaveLength(1);
    expect(drifts[0].meta).toMatchObject({
      boot_backend: "kwallet6",
      current_backend: "basic_text",
    });
  });

  it("does NOT log drift when backend hasn't changed since boot", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "kwallet5";
    captureBackendAtBoot();
    assertSafeEncrypt({ enforce: false });
    assertSafeEncrypt({ enforce: false });
    const drifts = logCalls.filter((l) => l.msg === "keychain.backend.drift");
    expect(drifts).toHaveLength(0);
  });
});

describe("KeychainAclError", () => {
  it("preserves backend + trustTier on the thrown error so callers can branch", () => {
    const err = new KeychainAclError("test", {
      backend: "basic_text",
      trustTier: "none",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("KeychainAclError");
    expect(err.code).toBe("keychain_acl_violation");
    expect(err.backend).toBe("basic_text");
    expect(err.trustTier).toBe("none");
  });
});

describe("test hooks", () => {
  it("_setPlatformForTests(null) restores process.platform", () => {
    _setPlatformForTests("linux");
    fakeSafeStorage.getSelectedStorageBackend = () => "kwallet6";
    expect(computeBackend()).toBe("kwallet6");
    _setPlatformForTests(null);
    // On the actual test runner (Linux without a real keyring),
    // computeBackend should still reflect what safeStorage reports —
    // since our stub returns true for isEncryptionAvailable and our
    // platform reverts to the actual process.platform (which is
    // Linux in CI), we should observe whatever the stub returns.
    const backend = computeBackend();
    if (process.platform === "linux") {
      expect(backend).toBe("kwallet6");
    } else if (process.platform === "darwin" || process.platform === "win32") {
      expect(backend).toBe("os_managed");
    }
  });

  it("_resetBootBackendForTests clears the cached snapshot", () => {
    _setPlatformForTests("darwin");
    captureBackendAtBoot();
    expect(getBootBackend()).not.toBe(null);
    _resetBootBackendForTests();
    expect(getBootBackend()).toBe(null);
  });
});

// Reference vi/MockInstance imports to satisfy noUnusedLocals — we use
// `vi.mock` above but TS doesn't see that as "used".
void vi;
type _Unused = MockInstance;
