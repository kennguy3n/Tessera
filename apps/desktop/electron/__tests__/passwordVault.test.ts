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
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

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
  VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE,
  WrongVaultPasswordError,
  _renderPromptHtmlForTests,
  _setCachedKeyForTests,
  _setSaltPathForTests,
  clearPasswordVaultKey,
  decryptWithPasswordKey,
  deriveAndCacheKey,
  encryptWithPasswordKey,
  initPasswordVaultIfNeeded,
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

  it("deriveAndCacheKey returns a copy, not a reference to the cached buffer", async () => {
    // Contract: clearing the cached key MUST NOT zero a buffer the
    // caller is holding. If `deriveAndCacheKey` returned the same
    // `Buffer` reference it stores in `cachedKey`, then a caller
    // that retained the buffer would find its bytes wiped after
    // `clearPasswordVaultKey()`, silently corrupting any downstream
    // use of "their" key.
    const returned = await deriveAndCacheKey("hunter2");
    const snapshot = Buffer.from(returned);
    expect(returned.equals(snapshot)).toBe(true);
    clearPasswordVaultKey();
    // The returned buffer must still contain the original key bytes
    // — i.e. the in-place `cachedKey.fill(0)` did not touch it.
    expect(returned.equals(snapshot)).toBe(true);
    expect(returned.every((b) => b === 0)).toBe(false);
  });

  it("mutating the returned buffer does not corrupt the cached key", async () => {
    // Contract: a caller that mutates the returned buffer must NOT
    // affect subsequent encrypt/decrypt operations that use the
    // cached key. If the returned buffer aliased `cachedKey`,
    // `returned[0] = 0xFF` would silently corrupt the cache.
    const returned = await deriveAndCacheKey("hunter2");
    const blob = encryptWithPasswordKey("payload");
    // Tamper with the returned copy.
    returned.fill(0xff);
    // Cache must be untouched: round-trip still works.
    expect(decryptWithPasswordKey(blob)).toBe("payload");
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

  it("salt file is written via atomic rename (no `.tmp` left behind)", async () => {
    // Contract: `getOrCreateSalt` writes the freshly-generated salt
    // to `<saltPath>.tmp` and then renames into place, mirroring the
    // pattern used by `dbKey.ts:getOrCreateDbKey` for the SQLCipher
    // master key. After a successful first-launch derivation:
    //   - The final salt file must exist with exactly SALT_LEN bytes.
    //   - The temp file (`.tmp` sibling) must NOT exist — leaking it
    //     would leave a confusing artefact in the userData directory
    //     that future tooling (a "reset vault" UX, a backup script)
    //     might mishandle.
    // A future refactor that drops the rename in favour of a direct
    // `writeFileSync` would still leave the final file intact and
    // pass the happy-path tests above, but would leave a half-written
    // salt on disk if interrupted by a power-loss / SIGKILL. Pinning
    // the absence-of-tmp invariant here catches that regression at
    // unit-test time without needing a real crash-injection harness.
    expect(passwordVaultSaltExists()).toBe(false);
    await deriveAndCacheKey("hunter2");
    const saltFile = path.join(tmpDir, "vault-salt.bin");
    const tmpFile = `${saltFile}.tmp`;
    expect(
      fs.existsSync(saltFile),
      "salt file must exist after derivation",
    ).toBe(true);
    expect(
      fs.existsSync(tmpFile),
      "`.tmp` sidecar file must NOT exist after successful atomic rename",
    ).toBe(false);
    expect(fs.readFileSync(saltFile).length).toBe(16);
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
    const bogus = Buffer.from(
      "garbage-not-a-tspv-blob-but-long-enough-to-pass-the-length-gate",
      "utf-8",
    );
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
    const fakeKey = Buffer.alloc(32, 0xab);
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

  it("prompt HTML renders a Cancel button wired to bridge.cancel()", () => {
    // The cancel IPC channel exists end-to-end (preload exposes
    // `bridge.cancel()`, main registers a listener on
    // `PASSWORD_PROMPT_CANCEL_CHANNEL`), so the UI must expose a way
    // for the user to invoke it. Closing the window via its title-bar
    // X button works as a fallback path, but on Linux WMs without
    // title bars (kiosk mode, certain tiling WMs) the X button is
    // unavailable — the explicit Cancel button is the only reliable
    // user-initiated cancel.
    const html = _renderPromptHtmlForTests({
      message: "hello",
      confirmRequired: false,
    });
    expect(html).toContain('id="cancel"');
    expect(html).toMatch(/bridge\.cancel\(\)/);
    // And it must be a real button, not a div-styled-as-button.
    expect(html).toMatch(/<button id="cancel"/);
  });

  it("prompt HTML maps Escape key to cancel on both password fields", () => {
    // Symmetric to "Enter submits" — Escape is the universal
    // cancel/dismiss affordance. Bound to both `#pw` and `#confirm`
    // so the user doesn't have to click the field that holds focus.
    const html = _renderPromptHtmlForTests({
      message: "hello",
      confirmRequired: true,
    });
    expect(html).toMatch(/e\.key === 'Escape'\) cancel\(\)/);
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
    expect(withoutConfirm).not.toMatch(
      /p !== document\.getElementById\('confirm'\)/,
    );
  });

  it("exports the fixed channel names the preload binds to", () => {
    // Sanity: these MUST match the strings hardcoded in
    // `passwordPromptPreload.ts`. If you rename one without renaming
    // the other, the prompt window submit goes nowhere.
    expect(PASSWORD_PROMPT_SUBMIT_CHANNEL).toBe("password-vault:submit");
    expect(PASSWORD_PROMPT_CANCEL_CHANNEL).toBe("password-vault:cancel");
  });
});

describe("passwordVault — IPC-boundary defense in depth", () => {
  // Source-text regression test for the empty-string rejection in
  // `onSubmit`. Exercising the real IPC handler would require
  // booting a sandboxed BrowserWindow with a preload, which is too
  // heavy for unit tests (the prompt HTML / channel-name tests
  // above use `_renderPromptHtmlForTests` for the same reason).
  //
  // The fix is to reject `password === ""` at the IPC boundary
  // before the PBKDF2 round-trip, even though three other layers
  // already prevent the empty string from breaking correctness:
  //
  //   1. The renderer-side `if (!p) return;` in the inline submit
  //      handler (a UX nicety, easily bypassed by a compromised
  //      sandbox).
  //   2. `deriveAndCacheKey` itself throws "Vault password cannot
  //      be empty." — covered by the test at line 112.
  //   3. The thrown error propagates through
  //      `initPasswordVaultIfNeeded` to `maybeInitPasswordVault`'s
  //      catch block.
  //
  // The IPC-boundary check is defense-in-depth: avoids a 600k-
  // iteration async PBKDF2 destined to throw, and means future
  // callers that send a stray "" get a clean no-op instead of a
  // confusing post-PBKDF2 reject.
  it("onSubmit handler rejects empty-string passwords at the IPC boundary", () => {
    const source = fs
      .readFileSync(path.join(TEST_DIR, "..", "passwordVault.ts"), "utf-8")
      .replace(/\r\n/g, "\n");
    // Find the onSubmit handler body.
    const onSubmitMatch = source.match(
      /const onSubmit\s*=\s*\([\s\S]*?\n {4}\};/,
    );
    expect(
      onSubmitMatch,
      "could not locate onSubmit handler in passwordVault.ts",
    ).toBeTruthy();
    if (!onSubmitMatch) return;
    const body = onSubmitMatch[0];
    // The body must contain a strict empty-string check that
    // returns BEFORE the settled = true / cleanup() / deriveAndCacheKey
    // sequence. Match the literal check.
    expect(
      body,
      'onSubmit handler must reject empty-string passwords with `if (password === "")` (defense-in-depth against compromised renderer)',
    ).toMatch(/if\s*\(\s*password\s*===\s*""\s*\)\s*\{[\s\S]*?return\s*;/);
    // And the empty-string check must occur BEFORE settled = true
    // and before any reference to deriveAndCacheKey or pbkdf2.
    const emptyIdx = body.search(/if\s*\(\s*password\s*===\s*""\s*\)/);
    const settledIdx = body.search(/settled\s*=\s*true/);
    expect(emptyIdx).toBeGreaterThan(-1);
    expect(settledIdx).toBeGreaterThan(-1);
    expect(
      emptyIdx,
      "empty-password rejection must occur before settling the promise (otherwise it does not skip PBKDF2)",
    ).toBeLessThan(settledIdx);
  });
});

// Regression: TOCTOU between maybeInitPasswordVault's outer
// safeStorage.isEncryptionAvailable() guard and
// initPasswordVaultIfNeeded's inner re-check used to surface as a
// misleading warning ("token / secret writes will fail until the vault
// is unlocked or the OS keyring becomes available") even though the
// keyring WAS available. The fix is two-part: (a) export a typed
// sentinel constant from passwordVault.ts so main.ts can discriminate
// on the reason, (b) treat the TOCTOU race as success (informational
// log only), not a vault failure.
//
// Pin BOTH halves so a refactor of either file doesn't silently lose
// the fix.
describe("passwordVault — TOCTOU sentinel contract", () => {
  it("VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE is a stable exported string", () => {
    expect(VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE).toBe(
      "safeStorage is available",
    );
  });

  // The inner `if (opts.isEncryptionAvailable())` check returns
  // { active: false, reason: <sentinel> } — not { active: false,
  // reason: undefined } or { active: true }. The sentinel must be
  // the exported constant, not an inline literal, so future refactors
  // of either side stay in sync.
  it("initPasswordVaultIfNeeded returns the sentinel reason when keyring flips available between checks", async () => {
    const result = await initPasswordVaultIfNeeded({
      isEncryptionAvailable: () => true,
      existingVault: false,
    });
    expect(result.active).toBe(false);
    expect(result.reason).toBe(VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE);
  });

  // The main-process consumer of the sentinel (maybeInitPasswordVault
  // in main.ts) MUST import the constant rather than comparing to an
  // inline string literal. If the sentinel value drifts (a future
  // refactor adding new active=false reasons), the magic-string
  // approach would silently miss the discriminator and emit the
  // wrong warning.
  it("main.ts imports VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE and discriminates on it", () => {
    const mainSource = fs
      .readFileSync(path.join(TEST_DIR, "..", "main.ts"), "utf-8")
      .replace(/\r\n/g, "\n");
    // Import must reference the constant by name.
    expect(mainSource).toMatch(
      /import\s*\{[\s\S]*?VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE[\s\S]*?\}\s*from\s*"\.\/passwordVault"/,
    );
    // The discriminator branch must compare result.reason to the
    // constant, NOT to an inline string literal "safeStorage is
    // available".
    expect(mainSource).toMatch(
      /result\.reason\s*===\s*VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE/,
    );
    // And there must be NO inline literal comparison anywhere — the
    // anti-pattern this regression test guards against.
    expect(mainSource).not.toMatch(/===\s*"safeStorage is available"/);
  });
});

// Regression: passwordVault.ts module docstring used to say "At app
// startup, `appState.ts` calls `initPasswordVaultIfNeeded`
// asynchronously." but `appState.ts` does NOT reference
// `initPasswordVaultIfNeeded` — the actual caller is
// `maybeInitPasswordVault` in `main.ts`. Pin the correct attribution
// so a future refactor doesn't reintroduce the wrong file name.
describe("passwordVault — docstring caller attribution", () => {
  const PASSWORD_VAULT_SRC = fs
    .readFileSync(path.join(TEST_DIR, "..", "passwordVault.ts"), "utf-8")
    .replace(/\r\n/g, "\n");
  // The module docstring lives in the first JSDoc block; isolate it
  // to avoid catching the words "appState" or "main.ts" elsewhere
  // in the file (e.g. inside function-level docs).
  const moduleDocEnd = PASSWORD_VAULT_SRC.indexOf("*/");
  const moduleDoc = PASSWORD_VAULT_SRC.slice(0, moduleDocEnd);

  it("module docstring attributes the startup call to main.ts, not appState.ts", () => {
    // The correct caller name must appear in the architecture
    // bullet list.
    expect(moduleDoc).toMatch(/main\.ts/);
    // The wrong caller name (a leftover from an earlier draft) must
    // NOT appear in the module docstring.
    expect(moduleDoc).not.toMatch(/appState\.ts/);
  });

  // First-round fix only caught the module-level docstring. A second
  // stale block lived above `initPasswordVaultIfNeeded` and was
  // ALSO orphaned (sitting above the next const, not the function
  // it described). Pin the entire file so no docstring anywhere
  // references the wrong file — `appState.ts` / `appState.initAppState`
  // must not appear at all in passwordVault.ts, in ANY comment or
  // identifier.
  it("no docstring anywhere in passwordVault.ts references appState.ts or appState.initAppState", () => {
    expect(PASSWORD_VAULT_SRC).not.toMatch(/appState\.ts/);
    expect(PASSWORD_VAULT_SRC).not.toMatch(/appState\.initAppState/);
    // Specifically the canonical wrong phrase from the earlier draft.
    expect(PASSWORD_VAULT_SRC).not.toMatch(/called from\s+`appState/);
  });

  // JSDoc orphan detection: a `/** ... */` block must immediately
  // precede an `export ` / `function ` / `class ` / `const ` / `let ` /
  // `interface ` / `type ` declaration (optionally preceded by an
  // `async ` keyword). If a JSDoc block is followed by another JSDoc
  // block — i.e. two `/** ... */` comments stacked with only
  // whitespace between them — the first one is documenting nothing
  // (the second JSDoc takes precedence for any symbol below it).
  //
  // This is what regressed: the stale `initPasswordVaultIfNeeded`
  // docstring sat between the closing `}` of `renderPromptHtml` and
  // the JSDoc for the `VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE` constant,
  // documenting NOTHING. Pin the structural invariant so a future
  // refactor that copies+pastes a docstring (without deleting the
  // old copy) fails this test.
  it("no JSDoc block is immediately followed by another JSDoc block (orphan detection)", () => {
    // Match: `*/` followed by whitespace (incl. newlines) then `/**`.
    // The orphan pattern. Allowed: `*/` then anything other than `/**`.
    const orphanPattern = /\*\/\s*\n\s*\/\*\*/;
    const matches = PASSWORD_VAULT_SRC.match(orphanPattern);
    expect(
      matches,
      matches
        ? `Orphaned JSDoc detected: a /** ... */ block is immediately followed by another /** ... */, meaning the first one documents nothing. Found near:\n${PASSWORD_VAULT_SRC.slice(
            Math.max(0, (matches.index ?? 0) - 80),
            (matches.index ?? 0) + 120,
          ).trim()}`
        : undefined,
    ).toBeNull();
  });

  it("appState.ts does not import initPasswordVaultIfNeeded (justifies the docstring fix)", () => {
    const appStateSrc = fs
      .readFileSync(path.join(TEST_DIR, "..", "appState.ts"), "utf-8")
      .replace(/\r\n/g, "\n");
    // appState.ts must not import the function — if a future refactor
    // wires it through appState, both this test AND the docstring
    // need to be updated together. The test failure is the
    // forcing function.
    expect(appStateSrc).not.toMatch(/initPasswordVaultIfNeeded/);
  });

  it("main.ts is the actual caller of initPasswordVaultIfNeeded", () => {
    const mainSource = fs
      .readFileSync(path.join(TEST_DIR, "..", "main.ts"), "utf-8")
      .replace(/\r\n/g, "\n");
    expect(mainSource).toMatch(/initPasswordVaultIfNeeded/);
    expect(mainSource).toMatch(/maybeInitPasswordVault/);
  });
});
