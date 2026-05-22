import { describe, it, expect, afterEach, vi } from "vitest";

// Stub electron before importing the module under test, since tokenVault imports `electron`.
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/devin-tessera-test-userdata"),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

import { encryptionUnavailableReason } from "../tokenVault";

describe("encryptionUnavailableReason", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, "platform", { value: p });
  }

  it("mentions gnome-keyring / kwallet / libsecret on Linux", () => {
    setPlatform("linux");
    const msg = encryptionUnavailableReason();
    expect(msg).toMatch(/gnome-keyring/);
    expect(msg).toMatch(/kwallet/);
    expect(msg).toMatch(/libsecret/);
  });

  it("mentions Keychain on macOS", () => {
    setPlatform("darwin");
    expect(encryptionUnavailableReason()).toMatch(/Keychain/);
  });

  it("mentions DPAPI on Windows", () => {
    setPlatform("win32");
    expect(encryptionUnavailableReason()).toMatch(/DPAPI/);
  });

  // Regression: the password-vault recovery path (WS10) is reachable
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
      setPlatform(platform);
      const msg = encryptionUnavailableReason();
      expect(msg, `platform=${platform}`).toMatch(/vault password/i);
      expect(msg, `platform=${platform}`).toMatch(/restart Tessera/i);
    }
  });
});
