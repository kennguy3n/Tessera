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
});
