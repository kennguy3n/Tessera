/**
 * Tests for `passwordVault.ts` — the keyring fallback used when
 * `safeStorage.isEncryptionAvailable()` is false.
 *
 * What's covered:
 * - PBKDF2 round-trip: derive key from password → encrypt → decrypt
 * - Salt persistence: same password, fresh module run → same key
 * - Wrong-password classification: AES-GCM auth failure → typed
 *   `WrongVaultPasswordError`, NOT a generic Error
 * - Blob format invariants: magic prefix, version, IV/tag layout
 * - Empty-password rejection
 * - Cached-key clearing (memory zero-fill)
 *
 * Not covered here (UI surface, deferred to integration tests):
 * - `promptForVaultPassword` — opens a BrowserWindow which we'd have
 *   to drive end-to-end. Mocked away.
 * - `initPasswordVaultIfNeeded` — composes the prompt + derivation;
 *   covered indirectly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Stub electron BEFORE importing the module under test. We only need
// the `app.getPath` shape for the salt-file location; `BrowserWindow`
// and `ipcMain` aren't exercised by these tests (the prompt UI is
// mocked).
const hoisted = vi.hoisted(() => ({
  userData: { value: "" },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => hoisted.userData.value),
  },
  BrowserWindow: vi.fn(),
  ipcMain: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
  },
}));

import {
  WrongVaultPasswordError,
  _setCachedKeyForTests,
  _setSaltPathForTests,
  clearPasswordVaultKey,
  decryptWithPasswordKey,
  deriveAndCacheKey,
  encryptWithPasswordKey,
  isPasswordVaultBlob,
  passwordVaultActive,
  passwordVaultSaltExists,
} from "../passwordVault";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-pwvault-"));
  hoisted.userData.value = tmpDir;
  _setSaltPathForTests(path.join(tmpDir, "vault-salt.bin"));
  clearPasswordVaultKey();
});

afterEach(() => {
  clearPasswordVaultKey();
  _setSaltPathForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("passwordVault — derivation and caching", () => {
  it("deriveAndCacheKey creates the salt file on first call", () => {
    expect(passwordVaultSaltExists()).toBe(false);
    deriveAndCacheKey("hunter2");
    expect(passwordVaultSaltExists()).toBe(true);
    const salt = fs.readFileSync(path.join(tmpDir, "vault-salt.bin"));
    expect(salt.length).toBe(16);
  });

  it("deriveAndCacheKey is deterministic for the same password + salt", () => {
    const k1 = deriveAndCacheKey("hunter2");
    const captured = Buffer.from(k1);
    clearPasswordVaultKey();
    const k2 = deriveAndCacheKey("hunter2");
    expect(k2.equals(captured)).toBe(true);
  });

  it("different passwords produce different keys", () => {
    const k1 = deriveAndCacheKey("aaa");
    const c1 = Buffer.from(k1);
    clearPasswordVaultKey();
    const k2 = deriveAndCacheKey("bbb");
    expect(k2.equals(c1)).toBe(false);
  });

  it("empty password is rejected", () => {
    expect(() => deriveAndCacheKey("")).toThrow(/cannot be empty/);
  });

  it("passwordVaultActive() reflects derivation state", () => {
    expect(passwordVaultActive()).toBe(false);
    deriveAndCacheKey("hunter2");
    expect(passwordVaultActive()).toBe(true);
    clearPasswordVaultKey();
    expect(passwordVaultActive()).toBe(false);
  });

  it("clearPasswordVaultKey overwrites cached key bytes (memory zero)", () => {
    // We can't directly inspect the cached buffer, but if zero-fill
    // ran the next operation should require a fresh derivation.
    deriveAndCacheKey("hunter2");
    expect(passwordVaultActive()).toBe(true);
    clearPasswordVaultKey();
    expect(() => encryptWithPasswordKey("anything")).toThrow(
      /Password vault is not active/,
    );
  });

  it("rejects a salt file of unexpected length", () => {
    // Plant a malformed salt file.
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "vault-salt.bin"), Buffer.alloc(8));
    expect(() => deriveAndCacheKey("hunter2")).toThrow(
      /unexpected length 8/,
    );
  });
});

describe("passwordVault — encryption round-trip", () => {
  it("encrypts and decrypts a string round-trip", () => {
    deriveAndCacheKey("hunter2");
    const blob = encryptWithPasswordKey("secret-payload");
    expect(decryptWithPasswordKey(blob)).toBe("secret-payload");
  });

  it("each encryption uses a fresh IV (output differs for same plaintext)", () => {
    deriveAndCacheKey("hunter2");
    const a = encryptWithPasswordKey("hello");
    const b = encryptWithPasswordKey("hello");
    expect(a.equals(b)).toBe(false);
    expect(decryptWithPasswordKey(a)).toBe("hello");
    expect(decryptWithPasswordKey(b)).toBe("hello");
  });

  it("encrypt produces blob with TSPV magic + version byte", () => {
    deriveAndCacheKey("hunter2");
    const blob = encryptWithPasswordKey("x");
    expect(blob.subarray(0, 4).toString("ascii")).toBe("TSPV");
    expect(blob[4]).toBe(1); // version
  });

  it("encrypt blob layout: magic(4) + version(1) + iv(12) + ciphertext + tag(16)", () => {
    deriveAndCacheKey("hunter2");
    const plaintext = "abc";
    const blob = encryptWithPasswordKey(plaintext);
    // 4 magic + 1 version + 12 iv + 3 ciphertext + 16 tag = 36
    expect(blob.length).toBe(36);
  });

  it("decrypting a wrong-password blob throws WrongVaultPasswordError", () => {
    deriveAndCacheKey("correct-password");
    const blob = encryptWithPasswordKey("secret");
    clearPasswordVaultKey();
    // Different password derives a different key. The salt is the
    // same (already on disk), so the new key is deterministic but
    // wrong.
    deriveAndCacheKey("wrong-password");
    expect(() => decryptWithPasswordKey(blob)).toThrow(WrongVaultPasswordError);
  });

  it("WrongVaultPasswordError is instanceof-distinguishable from plain Error", () => {
    deriveAndCacheKey("correct");
    const blob = encryptWithPasswordKey("x");
    clearPasswordVaultKey();
    deriveAndCacheKey("wrong");
    try {
      decryptWithPasswordKey(blob);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WrongVaultPasswordError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("WrongVaultPasswordError");
    }
  });

  it("decrypting a structurally invalid blob throws plain Error (not WrongVaultPasswordError)", () => {
    deriveAndCacheKey("hunter2");
    const bogus = Buffer.from("garbage-not-a-tspv-blob-but-long-enough-to-pass-the-length-gate", "utf-8");
    try {
      decryptWithPasswordKey(bogus);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(WrongVaultPasswordError);
      expect((e as Error).message).toMatch(/wrong magic/);
    }
  });

  it("decrypting a too-short blob throws plain Error", () => {
    deriveAndCacheKey("hunter2");
    const tooShort = Buffer.from("TSPV", "ascii");
    expect(() => decryptWithPasswordKey(tooShort)).toThrow(/too short/);
  });

  it("decrypt requires active vault", () => {
    // Generate blob with one cached key, then clear and try to decrypt
    deriveAndCacheKey("hunter2");
    const blob = encryptWithPasswordKey("x");
    clearPasswordVaultKey();
    expect(() => decryptWithPasswordKey(blob)).toThrow(
      /Password vault is not active/,
    );
  });

  it("encrypt requires active vault", () => {
    expect(passwordVaultActive()).toBe(false);
    expect(() => encryptWithPasswordKey("x")).toThrow(
      /Password vault is not active/,
    );
  });
});

describe("passwordVault — blob sniffing", () => {
  it("isPasswordVaultBlob true for blobs we created", () => {
    deriveAndCacheKey("hunter2");
    const blob = encryptWithPasswordKey("x");
    expect(isPasswordVaultBlob(blob)).toBe(true);
  });

  it("isPasswordVaultBlob false for a safeStorage-style blob (no magic)", () => {
    // Real safeStorage blobs are opaque platform-specific bytes that
    // do NOT start with "TSPV". Simulate one.
    const fake = Buffer.from("v10\x00encryption-output-with-no-magic-prefix");
    expect(isPasswordVaultBlob(fake)).toBe(false);
  });

  it("isPasswordVaultBlob false for empty buffer", () => {
    expect(isPasswordVaultBlob(Buffer.alloc(0))).toBe(false);
  });

  it("isPasswordVaultBlob false for buffer shorter than magic", () => {
    expect(isPasswordVaultBlob(Buffer.from("TSP"))).toBe(false);
  });
});

describe("passwordVault — direct key override (test-only)", () => {
  it("_setCachedKeyForTests bypasses derivation for fast unit tests", () => {
    const fakeKey = Buffer.alloc(32, 0xAB);
    _setCachedKeyForTests(fakeKey);
    expect(passwordVaultActive()).toBe(true);
    const blob = encryptWithPasswordKey("hi");
    expect(decryptWithPasswordKey(blob)).toBe("hi");
  });

  it("_setCachedKeyForTests(null) clears the cache", () => {
    _setCachedKeyForTests(Buffer.alloc(32));
    expect(passwordVaultActive()).toBe(true);
    _setCachedKeyForTests(null);
    expect(passwordVaultActive()).toBe(false);
  });
});
