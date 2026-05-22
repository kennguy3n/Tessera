/**
 * End-to-end integration tests for `tokenVault.ts`'s fallback
 * dispatch between `safeStorage` (OS keyring) and the password vault.
 *
 * Each test exercises a complete read/write cycle with one or both
 * encryption modes simulated:
 *
 * - safeStorage available, no password vault → existing path
 * - safeStorage unavailable, password vault active → new path (WS10)
 * - Mixed: existing safeStorage blob, no keyring at read time → loud
 *   error with recovery instructions (not silent failure)
 * - Mixed: existing TSPV blob, no password cached → loud error
 *
 * `safeStorage.isEncryptionAvailable()` is the dispatch input; we
 * flip the mock between tests to simulate the keyring being
 * present / absent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const hoisted = vi.hoisted(() => ({
  userData: { value: "" },
  encryptionAvailable: { value: true },
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => hoisted.userData.value),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => hoisted.encryptionAvailable.value),
    encryptString: vi.fn((s: string) =>
      // Simulate platform-specific safeStorage output: a "v10\x00" prefix
      // (matching libsecret backed safeStorage on Linux) followed by
      // base64-encoded plaintext. Reversible enough for tests.
      Buffer.concat([Buffer.from("v10\x00"), Buffer.from(s, "utf-8")]),
    ),
    decryptString: vi.fn((b: Buffer) => {
      if (b.subarray(0, 4).equals(Buffer.from("v10\x00"))) {
        return b.subarray(4).toString("utf-8");
      }
      throw new Error("decryptString: not a v10 blob");
    }),
  },
}));

import {
  _setCachedKeyForTests,
  _setSaltPathForTests,
  clearPasswordVaultKey,
} from "../passwordVault";
import {
  deleteTokens,
  getTokens,
  hasTokens,
  storeTokens,
  type StoredTokens,
} from "../tokenVault";

let tmpDir: string;
const SAMPLE: StoredTokens = {
  accessToken: "at-123",
  refreshToken: "rt-456",
  expiresAt: 1_700_000_000,
  scopes: ["read", "write"],
};

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-tv-fallback-"));
  hoisted.userData.value = tmpDir;
  hoisted.encryptionAvailable.value = true;
  _setSaltPathForTests(path.join(tmpDir, "vault-salt.bin"));
  clearPasswordVaultKey();
});

afterEach(() => {
  clearPasswordVaultKey();
  _setSaltPathForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("tokenVault fallback — safeStorage path (baseline)", () => {
  it("writes via safeStorage when keyring is available", () => {
    hoisted.encryptionAvailable.value = true;
    storeTokens("google", SAMPLE);
    const fp = path.join(tmpDir, "token-vault", "google.enc");
    expect(fs.existsSync(fp)).toBe(true);
    const raw = fs.readFileSync(fp);
    // safeStorage mock produces a "v10\x00..." prefix — NOT the TSPV magic.
    expect(raw.subarray(0, 4).toString("ascii")).toBe("v10\x00");
  });

  it("reads back via safeStorage when keyring is available", () => {
    hoisted.encryptionAvailable.value = true;
    storeTokens("google", SAMPLE);
    expect(getTokens("google")).toEqual(SAMPLE);
  });
});

// All tests in this file simulate "password vault unlocked" by
// injecting a fixed 32-byte key directly via `_setCachedKeyForTests`,
// bypassing the real (async) PBKDF2 derivation. End-to-end PBKDF2
// behavior is exercised by `passwordVault.test.ts`; this file only
// cares about dispatch behavior between safeStorage and the password
// vault, so a synthetic key is sufficient and 1–2 seconds faster
// per test.
const FIXED_TEST_KEY = Buffer.alloc(32, 0xCD);

describe("tokenVault fallback — password-vault path", () => {
  beforeEach(() => {
    hoisted.encryptionAvailable.value = false;
    _setCachedKeyForTests(Buffer.from(FIXED_TEST_KEY));
  });

  it("writes via password vault when safeStorage is unavailable", () => {
    storeTokens("notion", SAMPLE);
    const fp = path.join(tmpDir, "token-vault", "notion.enc");
    expect(fs.existsSync(fp)).toBe(true);
    const raw = fs.readFileSync(fp);
    // Password vault produces TSPV-prefixed blobs.
    expect(raw.subarray(0, 4).toString("ascii")).toBe("TSPV");
  });

  it("reads back via password vault when safeStorage is unavailable", () => {
    storeTokens("notion", SAMPLE);
    expect(getTokens("notion")).toEqual(SAMPLE);
  });

  it("survives derivation cache cycle (clear + re-inject same key)", () => {
    storeTokens("notion", SAMPLE);
    clearPasswordVaultKey();
    _setCachedKeyForTests(Buffer.from(FIXED_TEST_KEY));
    expect(getTokens("notion")).toEqual(SAMPLE);
  });
});

describe("tokenVault fallback — refusal cases", () => {
  it("refuses to write when neither safeStorage nor password vault is active", () => {
    hoisted.encryptionAvailable.value = false;
    clearPasswordVaultKey();
    expect(() => storeTokens("notion", SAMPLE)).toThrow(
      /Encryption not available/,
    );
    // Nothing was written.
    const fp = path.join(tmpDir, "token-vault", "notion.enc");
    expect(fs.existsSync(fp)).toBe(false);
  });

  it("refuses to read a TSPV blob when password vault is locked (no keyring)", () => {
    // Write with password vault, then lose the cache.
    hoisted.encryptionAvailable.value = false;
    _setCachedKeyForTests(Buffer.from(FIXED_TEST_KEY));
    storeTokens("notion", SAMPLE);
    clearPasswordVaultKey();
    expect(() => getTokens("notion")).toThrow(
      /password-encrypted but no password is cached/,
    );
  });

  it("refuses to read a TSPV blob when keyring was restored (TSPV-stranded)", () => {
    // Session 1: no keyring → write via password vault.
    hoisted.encryptionAvailable.value = false;
    _setCachedKeyForTests(Buffer.from(FIXED_TEST_KEY));
    storeTokens("notion", SAMPLE);
    // Session 2: user installed gnome-keyring → safeStorage now
    // available. maybeInitPasswordVault short-circuits, password
    // vault never initialized → cached key is gone.
    clearPasswordVaultKey();
    hoisted.encryptionAvailable.value = true;
    // Reading the old TSPV blob must NOT say "Encryption not available
    // — install gnome-keyring" (the keyring IS available). It must say
    // the blob needs the original vault password.
    expect(() => getTokens("notion")).toThrow(
      /password-vault encrypted.*TSPV format.*password vault is not active/,
    );
    // Negative check: the old misleading message must NOT appear.
    expect(() => getTokens("notion")).not.toThrow(
      /Encryption not available/,
    );
  });

  it("refuses to read a safeStorage blob after the keyring goes away", () => {
    // Write with safeStorage, then simulate keyring loss between sessions.
    hoisted.encryptionAvailable.value = true;
    storeTokens("google", SAMPLE);
    hoisted.encryptionAvailable.value = false;
    expect(() => getTokens("google")).toThrow(
      /OS keyring but the keyring is no longer available/,
    );
  });
});

describe("tokenVault fallback — utility methods", () => {
  it("hasTokens and deleteTokens work in either mode", () => {
    hoisted.encryptionAvailable.value = false;
    _setCachedKeyForTests(Buffer.from(FIXED_TEST_KEY));
    expect(hasTokens("notion")).toBe(false);
    storeTokens("notion", SAMPLE);
    expect(hasTokens("notion")).toBe(true);
    deleteTokens("notion");
    expect(hasTokens("notion")).toBe(false);
  });
});

describe("tokenVault fallback — mixed-format directory", () => {
  it("dispatches per-blob by magic when both modes have left files behind", () => {
    // First session: keyring available, write Google tokens.
    hoisted.encryptionAvailable.value = true;
    storeTokens("google", SAMPLE);
    // Second session: keyring lost, user enters password, writes
    // Notion tokens. Both files now live in the same directory.
    hoisted.encryptionAvailable.value = false;
    _setCachedKeyForTests(Buffer.from(FIXED_TEST_KEY));
    storeTokens("notion", { ...SAMPLE, accessToken: "different" });

    // Notion (TSPV) decrypts via password vault.
    const notion = getTokens("notion");
    expect(notion?.accessToken).toBe("different");

    // Google (v10) cannot decrypt because keyring is gone — must
    // surface actionable error rather than corrupting state.
    expect(() => getTokens("google")).toThrow(/keyring is no longer available/);
  });
});

describe("tokenVault fallback — direct key override for test ergonomics", () => {
  it("works with _setCachedKeyForTests as the derivation primitive", () => {
    hoisted.encryptionAvailable.value = false;
    _setCachedKeyForTests(Buffer.alloc(32, 0x42));
    storeTokens("notion", SAMPLE);
    expect(getTokens("notion")).toEqual(SAMPLE);
  });
});
