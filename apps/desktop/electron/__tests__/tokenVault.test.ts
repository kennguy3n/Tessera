import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// Stub electron before importing the module under test, since tokenVault imports `electron`.
//
// The import chain reaches `passwordVault.ts`, which imports `{ app,
// BrowserWindow, ipcMain }` from "electron". This file's existing tests only
// exercise `encryptionUnavailableReason()` (which touches `process.platform`
// and string concatenation, NOT BrowserWindow/ipcMain), so the missing fields
// would resolve to `undefined` and sit inert in module scope. That's fine
// today, but a future test that calls e.g. `promptForVaultPassword` would
// fail at runtime with "Cannot read properties of undefined (reading 'on')"
// — a confusing error that would have to be traced back to here.
//
// Stub BrowserWindow / ipcMain explicitly so a future test failure points at
// the missing setup rather than the symptom. The stubs are intentionally
// inert: any test that actually exercises them must override the relevant
// method via `(electron.ipcMain.on as Mock).mockImplementation(...)` etc.
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/devin-tessera-test-userdata"),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  // Inert stubs — tests that touch BrowserWindow / ipcMain must override.
  // See module-level comment above for rationale.
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn(),
    once: vi.fn(),
    handle: vi.fn(),
    removeListener: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

import { encryptionUnavailableReason } from "../tokenVault";

// File-scope defense-in-depth: assert that no test in this file mutates
// `process.platform`. The prior incarnation of this suite used
// `Object.defineProperty(process, "platform", ...)` + an `afterEach`
// restore — a sequential-only pattern that becomes a parallel-safety
// footgun under `vitest --pool=threads` with shared worker pools (a
// concurrent test in another describe block could observe the mutated
// global). The current suite injects `platform` as a function argument
// instead. These hooks snapshot the live globals at file load and assert
// they're unchanged at teardown so any future test that reintroduces
// global mutation fails loudly here rather than silently corrupting a
// neighbour. Mirrors the architectural pattern landed in PR #57 (the
// originating test file was removed in PR #58 along with the
// socket-bridge surface, but the pattern survives in this suite,
// `sidecar.test.ts`, and `diffusionSidecar.test.ts`).
const ORIGINAL_PLATFORM = process.platform;
beforeAll(() => {
  expect(process.platform).toBe(ORIGINAL_PLATFORM);
});
afterAll(() => {
  expect(process.platform).toBe(ORIGINAL_PLATFORM);
});

describe("encryptionUnavailableReason", () => {
  it("mentions gnome-keyring / kwallet / libsecret on Linux", () => {
    const msg = encryptionUnavailableReason("linux");
    expect(msg).toMatch(/gnome-keyring/);
    expect(msg).toMatch(/kwallet/);
    expect(msg).toMatch(/libsecret/);
  });

  it("mentions Keychain on macOS", () => {
    expect(encryptionUnavailableReason("darwin")).toMatch(/Keychain/);
  });

  it("mentions DPAPI on Windows", () => {
    expect(encryptionUnavailableReason("win32")).toMatch(/DPAPI/);
  });

  // Regression: the password-vault recovery path is reachable
  // from this exact error message — a user on headless Linux who saw
  // only "install gnome-keyring" would not realise that restarting +
  // entering a password is the alternative. The hint must appear on
  // every platform: macOS/Windows users whose native keystore is
  // somehow inaccessible (corporate policy, sandbox containment) get
  // the same recovery route, and `default:` is for theoretical future
  // platforms where neither keyring nor the platform-detection paths
  // apply.
  it("mentions the password-vault recovery path on every platform", () => {
    for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
      const msg = encryptionUnavailableReason(platform);
      expect(msg, `platform=${platform}`).toMatch(/vault password/i);
      expect(msg, `platform=${platform}`).toMatch(/restart Tessera/i);
    }
  });

  // Regression: the no-arg path must equal calling the function with
  // the live `process.platform` value. Production code throughout the
  // electron app calls `encryptionUnavailableReason()` with no args
  // (re-exported from `tokenVault.ts`, plus direct calls from
  // `dbKey.ts`); this assertion locks the contract that the default
  // parameter is `process.platform`, not some baked-in literal. If a
  // future refactor accidentally hard-coded `"linux"` as the default
  // this test would catch it on every non-Linux runner.
  it("no-arg call matches the explicit-platform call for the live platform", () => {
    expect(encryptionUnavailableReason()).toBe(
      encryptionUnavailableReason(process.platform),
    );
  });

  // Parallel-safety meta-test: prove that calling the function with
  // various injected platforms does NOT mutate `process.platform`.
  // The prior implementation of this suite mutated the global via
  // `Object.defineProperty` and restored it in `afterEach` — a
  // sequential-only pattern. This test pins the architectural
  // guarantee that the current implementation is purely a pure
  // function of its argument. Mirrors the meta-test pattern landed
  // in PR #57 (the originating test file was removed in PR #58 along
  // with the socket-bridge surface, but this snapshot+verify pattern
  // survives across the platform-aware test suites).
  it("does not mutate process.platform when called with various platforms", () => {
    const before = process.platform;
    for (const platform of ["linux", "darwin", "win32", "freebsd"] as const) {
      encryptionUnavailableReason(platform);
    }
    expect(process.platform).toBe(before);
  });
});
