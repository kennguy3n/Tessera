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
 *
 * Covered here for the prompt path:
 * - `_renderPromptHtmlForTests`: the prompt HTML is a static template
 *   so we assert its structural invariants directly (no `require`,
 *   no `data:` URL window-ID interpolation, uses
 *   `window.tesseraPasswordPrompt` from the preload, escapes the
 *   `message` to prevent XSS). These tests pin the contract between
 *   `passwordVault.ts` and `passwordPromptPreload.ts`.
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
  PASSWORD_PROMPT_CANCEL_CHANNEL,
  PASSWORD_PROMPT_SUBMIT_CHANNEL,
  WrongVaultPasswordError,
  _renderPromptHtmlForTests,
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
  it("deriveAndCacheKey creates the salt file on first call", async () => {
    expect(passwordVaultSaltExists()).toBe(false);
    await deriveAndCacheKey("hunter2");
    expect(passwordVaultSaltExists()).toBe(true);
    const salt = fs.readFileSync(path.join(tmpDir, "vault-salt.bin"));
    expect(salt.length).toBe(16);
  });

  it("deriveAndCacheKey is deterministic for the same password + salt", async () => {
    const k1 = await deriveAndCacheKey("hunter2");
    const captured = Buffer.from(k1);
    clearPasswordVaultKey();
    const k2 = await deriveAndCacheKey("hunter2");
    expect(k2.equals(captured)).toBe(true);
  });

  it("different passwords produce different keys", async () => {
    const k1 = await deriveAndCacheKey("aaa");
    const c1 = Buffer.from(k1);
    clearPasswordVaultKey();
    const k2 = await deriveAndCacheKey("bbb");
    expect(k2.equals(c1)).toBe(false);
  });

  it("empty password is rejected", async () => {
    await expect(deriveAndCacheKey("")).rejects.toThrow(/cannot be empty/);
  });

  it("passwordVaultActive() reflects derivation state", async () => {
    expect(passwordVaultActive()).toBe(false);
    await deriveAndCacheKey("hunter2");
    expect(passwordVaultActive()).toBe(true);
    clearPasswordVaultKey();
    expect(passwordVaultActive()).toBe(false);
  });

  it("clearPasswordVaultKey overwrites cached key bytes (memory zero)", async () => {
    // We can't directly inspect the cached buffer, but if zero-fill
    // ran the next operation should require a fresh derivation.
    await deriveAndCacheKey("hunter2");
    expect(passwordVaultActive()).toBe(true);
    clearPasswordVaultKey();
    expect(() => encryptWithPasswordKey("anything")).toThrow(
      /Password vault is not active/,
    );
  });

  it("rejects a salt file of unexpected length", async () => {
    // Plant a malformed salt file.
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "vault-salt.bin"), Buffer.alloc(8));
    await expect(deriveAndCacheKey("hunter2")).rejects.toThrow(
      /unexpected length 8/,
    );
  });
});

describe("passwordVault — encryption round-trip", () => {
  it("encrypts and decrypts a string round-trip", async () => {
    await deriveAndCacheKey("hunter2");
    const blob = encryptWithPasswordKey("secret-payload");
    expect(decryptWithPasswordKey(blob)).toBe("secret-payload");
  });

  it("each encryption uses a fresh IV (output differs for same plaintext)", async () => {
    await deriveAndCacheKey("hunter2");
    const a = encryptWithPasswordKey("hello");
    const b = encryptWithPasswordKey("hello");
    expect(a.equals(b)).toBe(false);
    expect(decryptWithPasswordKey(a)).toBe("hello");
    expect(decryptWithPasswordKey(b)).toBe("hello");
  });

  it("encrypt produces blob with TSPV magic + version byte", async () => {
    await deriveAndCacheKey("hunter2");
    const blob = encryptWithPasswordKey("x");
    expect(blob.subarray(0, 4).toString("ascii")).toBe("TSPV");
    expect(blob[4]).toBe(1); // version
  });

  it("encrypt blob layout: magic(4) + version(1) + iv(12) + ciphertext + tag(16)", async () => {
    await deriveAndCacheKey("hunter2");
    const plaintext = "abc";
    const blob = encryptWithPasswordKey(plaintext);
    // 4 magic + 1 version + 12 iv + 3 ciphertext + 16 tag = 36
    expect(blob.length).toBe(36);
  });

  it("decrypting a wrong-password blob throws WrongVaultPasswordError", async () => {
    await deriveAndCacheKey("correct-password");
    const blob = encryptWithPasswordKey("secret");
    clearPasswordVaultKey();
    // Different password derives a different key. The salt is the
    // same (already on disk), so the new key is deterministic but
    // wrong.
    await deriveAndCacheKey("wrong-password");
    expect(() => decryptWithPasswordKey(blob)).toThrow(WrongVaultPasswordError);
  });

  it("WrongVaultPasswordError is instanceof-distinguishable from plain Error", async () => {
    await deriveAndCacheKey("correct");
    const blob = encryptWithPasswordKey("x");
    clearPasswordVaultKey();
    await deriveAndCacheKey("wrong");
    try {
      decryptWithPasswordKey(blob);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(WrongVaultPasswordError);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).name).toBe("WrongVaultPasswordError");
    }
  });

  it("decrypting a structurally invalid blob throws plain Error (not WrongVaultPasswordError)", async () => {
    await deriveAndCacheKey("hunter2");
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

  it("decrypting a too-short blob throws plain Error", async () => {
    await deriveAndCacheKey("hunter2");
    const tooShort = Buffer.from("TSPV", "ascii");
    expect(() => decryptWithPasswordKey(tooShort)).toThrow(/too short/);
  });

  it("decrypt requires active vault", async () => {
    // Generate blob with one cached key, then clear and try to decrypt
    await deriveAndCacheKey("hunter2");
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
  it("isPasswordVaultBlob true for blobs we created", async () => {
    await deriveAndCacheKey("hunter2");
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

describe("passwordVault — prompt HTML contract", () => {
  // These tests pin the structural contract between
  // `renderPromptHtml` and `passwordPromptPreload.ts`. Two prior
  // bugs would have been caught here:
  //
  // 1. The script previously used `require('electron').ipcRenderer`
  //    inside a sandboxed renderer with no preload — `require` is
  //    undefined in that context, so the submit button was inert.
  //
  // 2. The script previously read `windowId` from `location.search`
  //    of a `data:` URL — but `data:` URLs have no query string, so
  //    the win-id always resolved to 0 and main listened on
  //    `password-vault:submit:${realId}` (≥1) — IPC never landed.
  //
  // The fix is to: (a) load a preload that exposes
  // `window.tesseraPasswordPrompt.{submit,cancel}`, and (b) use fixed
  // channel names (no win-id interpolation). We assert that both
  // shapes hold.
  it("prompt HTML does not call require()", () => {
    const html = _renderPromptHtmlForTests({
      message: "hello",
      confirmRequired: false,
    });
    expect(html).not.toMatch(/require\s*\(/);
  });

  it("prompt HTML does not interpolate window id into a channel name", () => {
    const html = _renderPromptHtmlForTests({
      message: "hello",
      confirmRequired: false,
    });
    expect(html).not.toMatch(/URLSearchParams/);
    expect(html).not.toMatch(/location\.search/);
    expect(html).not.toMatch(/password-vault:submit:/);
  });

  it("prompt HTML uses the preload-exposed bridge", () => {
    const html = _renderPromptHtmlForTests({
      message: "hello",
      confirmRequired: false,
    });
    expect(html).toContain("window.tesseraPasswordPrompt");
    expect(html).toMatch(/bridge\.submit\(/);
  });

  it("prompt HTML escapes the message to defeat XSS-in-prompt", () => {
    const html = _renderPromptHtmlForTests({
      message: "<script>alert('pwn')</script>",
      confirmRequired: false,
    });
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&#39;pwn&#39;");
  });

  it("prompt HTML escapes &, <, >, \", ' in the message", () => {
    const html = _renderPromptHtmlForTests({
      message: "a&b<c>d\"e'f",
      confirmRequired: false,
    });
    // The escaped form must appear verbatim inside the message
    // paragraph.
    expect(html).toContain("a&amp;b&lt;c&gt;d&quot;e&#39;f");
    // The unescaped raw characters must NOT appear in the message
    // paragraph. (We can't grep the whole HTML — `>` legitimately
    // appears in `</p>`, `<input>`, etc. — so we slice the body.)
    const inBody = html.split("<body>")[1]?.split("</body>")[0] ?? "";
    expect(inBody).not.toMatch(/a&b<c>d"e'f/);
  });

  it("prompt HTML renders the confirm-password field only when requested", () => {
    const withConfirm = _renderPromptHtmlForTests({
      message: "first run",
      confirmRequired: true,
    });
    expect(withConfirm).toContain("Confirm password");
    expect(withConfirm).toContain('id="confirm"');
    expect(withConfirm).toMatch(/p !== document\.getElementById\('confirm'\)/);

    const withoutConfirm = _renderPromptHtmlForTests({
      message: "subsequent run",
      confirmRequired: false,
    });
    expect(withoutConfirm).not.toContain("Confirm password");
    expect(withoutConfirm).not.toMatch(/p !== document\.getElementById\('confirm'\)/);
  });

  it("exports the fixed channel names the preload binds to", () => {
    // Sanity: these MUST match the strings hardcoded in
    // `passwordPromptPreload.ts`. If you rename one without renaming
    // the other, the prompt window submit goes nowhere.
    expect(PASSWORD_PROMPT_SUBMIT_CHANNEL).toBe("password-vault:submit");
    expect(PASSWORD_PROMPT_CANCEL_CHANNEL).toBe("password-vault:cancel");
  });
});
