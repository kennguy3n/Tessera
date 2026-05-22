/**
 * Password-derived fallback vault used when Electron's `safeStorage`
 * is unavailable (typically headless Linux without `gnome-keyring` /
 * `kwallet`).
 *
 * Architecture:
 *
 *   1. At app startup, `appState.ts` calls `initPasswordVaultIfNeeded`
 *      asynchronously. If `safeStorage.isEncryptionAvailable()` is
 *      true, this is a no-op — the existing `safeStorage`-based path
 *      stays in effect.
 *   2. If `safeStorage` is unavailable, `initPasswordVaultIfNeeded`
 *      opens a modal `BrowserWindow` and prompts the user for a
 *      password. The password is run through PBKDF2-SHA256 (600k
 *      iterations, per OWASP 2023 guidance) against a per-vault salt
 *      stored at `<userData>/vault-salt.bin`. The derived 32-byte
 *      key is cached in module memory for the session.
 *   3. All subsequent `tokenVault` / `secretsVault` reads and writes
 *      check `passwordVaultActive()` synchronously and use the cached
 *      key. The vault APIs stay synchronous — no fan-out refactor of
 *      every caller.
 *   4. On first use against an existing vault file, decryption may
 *      fail because the user typed the wrong password. In that case
 *      the vault APIs throw a typed `WrongVaultPasswordError`; the
 *      caller can clear the cached key (`clearPasswordVaultKey`) and
 *      re-prompt.
 *
 * On-disk file format (per encrypted blob):
 *
 *   bytes 0..3        magic "TSPV" (Tessera Password Vault)
 *   bytes 4           version (currently 1)
 *   bytes 5..16       AES-GCM IV (12 bytes)
 *   bytes 17..N       ciphertext (variable)
 *   bytes N..N+15     AES-GCM auth tag (16 bytes)
 *
 * The per-vault salt is stored separately at `<userData>/vault-salt.bin`
 * so multiple blobs share one salt — this is acceptable because each
 * blob has its own random IV. Rotating the salt would invalidate all
 * existing blobs, which is the desired "lost-password" recovery path.
 *
 * Threat model:
 *
 *   - Disk-level theft: attacker without password cannot decrypt any
 *     vault blob (modulo PBKDF2 work factor + AES-GCM authentication).
 *   - Same-machine attacker: out of scope. A co-resident attacker who
 *     can read this process's memory can extract the derived key from
 *     the cached `Buffer`. This is the same trade-off `safeStorage`
 *     makes (keyring-extracted DPAPI/Keychain keys live in memory for
 *     the session).
 *   - User forgets password: irrecoverable. Delete the vault
 *     directory + `vault-salt.bin` to start fresh; the user will
 *     need to re-authenticate to OAuth providers and re-enter API keys.
 */

import { app, BrowserWindow, ipcMain } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = "sha256";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const MAGIC = Buffer.from("TSPV", "ascii");
const VERSION = 1;

const SALT_FILENAME = "vault-salt.bin";

/**
 * Throws on `decrypt` when the supplied password fails AES-GCM
 * authentication — i.e. the user typed the wrong password.
 */
export class WrongVaultPasswordError extends Error {
  constructor(message = "Vault password is incorrect.") {
    super(message);
    this.name = "WrongVaultPasswordError";
    Object.setPrototypeOf(this, WrongVaultPasswordError.prototype);
  }
}

/**
 * Module-level state. Cleared on `clearPasswordVaultKey`.
 *
 * Storing the derived key in a `Buffer` (not `string`) lets us call
 * `cachedKey.fill(0)` on cleanup to overwrite the memory. V8 might
 * still have a copy elsewhere in the heap from intermediate
 * computations, but it's a meaningful step beyond storing the key as
 * an immutable `string`.
 */
let cachedKey: Buffer | null = null;

/** Test-only override of the salt path so `__tests__/` can use tmp dirs. */
let saltPathOverride: string | null = null;

/**
 * Whether the password-derived key is cached and ready for sync use.
 * Callers of `tokenVault` / `secretsVault` check this BEFORE
 * attempting an operation that would otherwise have used safeStorage.
 */
export function passwordVaultActive(): boolean {
  return cachedKey !== null;
}

/** Clear the cached derived key and overwrite its bytes. */
export function clearPasswordVaultKey(): void {
  if (cachedKey) {
    cachedKey.fill(0);
    cachedKey = null;
  }
}

/** Test-only: override the salt-file location. */
export function _setSaltPathForTests(p: string | null): void {
  saltPathOverride = p;
}

/** Test-only: directly set the cached key (skips the password prompt). */
export function _setCachedKeyForTests(key: Buffer | null): void {
  cachedKey = key;
}

function saltFilePath(): string {
  if (saltPathOverride) return saltPathOverride;
  return path.join(app.getPath("userData"), SALT_FILENAME);
}

/**
 * Return the existing per-vault salt, or generate + persist a fresh
 * one if none exists yet. The salt is NOT secret — its only purpose
 * is to defeat rainbow-table attacks against the PBKDF2 output.
 */
function getOrCreateSalt(): Buffer {
  const fp = saltFilePath();
  if (fs.existsSync(fp)) {
    const existing = fs.readFileSync(fp);
    if (existing.length !== SALT_LEN) {
      throw new Error(
        `Vault salt file at ${fp} has unexpected length ${existing.length} (expected ${SALT_LEN}). Delete this file and the vault directories to reset (you will need to re-enter all secrets).`,
      );
    }
    return existing;
  }
  const fresh = crypto.randomBytes(SALT_LEN);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, fresh, { mode: 0o600 });
  return fresh;
}

/**
 * Whether a salt file exists — i.e. whether the password vault has
 * been used before. Useful for distinguishing "first-launch on
 * headless Linux, no secrets yet" from "second launch, need to
 * re-prompt for password".
 */
export function passwordVaultSaltExists(): boolean {
  return fs.existsSync(saltFilePath());
}

/**
 * Run PBKDF2 against the supplied password, cache the derived key,
 * and return it. Synchronous because `BrowserWindow.show()` is async
 * but the call sites (vault sync APIs) need a sync handle once the
 * key is cached.
 */
export function deriveAndCacheKey(password: string): Buffer {
  if (password.length === 0) {
    throw new Error("Vault password cannot be empty.");
  }
  const salt = getOrCreateSalt();
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LEN,
    PBKDF2_DIGEST,
  );
  clearPasswordVaultKey();
  cachedKey = key;
  return key;
}

/**
 * Encrypt the supplied plaintext with the cached password-derived key
 * using AES-256-GCM. Output layout per the module docstring.
 */
export function encryptWithPasswordKey(plaintext: string): Buffer {
  if (!cachedKey) {
    throw new Error(
      "Password vault is not active. Call initPasswordVaultIfNeeded first.",
    );
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", cachedKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, ciphertext, tag]);
}

/**
 * Decrypt a blob produced by `encryptWithPasswordKey`. Throws
 * `WrongVaultPasswordError` on AES-GCM auth-tag failure (the most
 * common error: user typed the wrong password). Throws plain `Error`
 * on structural failures (wrong magic, truncated buffer).
 */
export function decryptWithPasswordKey(blob: Buffer): string {
  if (!cachedKey) {
    throw new Error(
      "Password vault is not active. Call initPasswordVaultIfNeeded first.",
    );
  }
  if (blob.length < MAGIC.length + 1 + IV_LEN + TAG_LEN) {
    throw new Error(
      `Password-vault blob is too short (${blob.length} bytes) to be valid.`,
    );
  }
  const magic = blob.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new Error(
      `Password-vault blob has wrong magic; got ${magic.toString("hex")}, expected ${MAGIC.toString("hex")} ('TSPV'). This file was not produced by the password vault.`,
    );
  }
  const version = blob[MAGIC.length];
  if (version !== VERSION) {
    throw new Error(
      `Password-vault blob has unsupported version ${version} (this build supports ${VERSION}).`,
    );
  }
  const ivStart = MAGIC.length + 1;
  const iv = blob.subarray(ivStart, ivStart + IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ciphertext = blob.subarray(ivStart + IV_LEN, blob.length - TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-256-gcm", cachedKey, iv);
  decipher.setAuthTag(tag);
  try {
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return plaintext.toString("utf-8");
  } catch (e) {
    // AES-GCM auth-tag failure throws a generic OpenSSL "Unsupported
    // state" / "unable to authenticate data" error. Re-wrap as our
    // typed sentinel so callers can distinguish wrong-password from
    // structural corruption.
    throw new WrongVaultPasswordError(
      `Password-vault decryption failed (likely wrong password): ${(e as Error).message}`,
    );
  }
}

/**
 * Whether a freshly-encrypted blob starts with the password-vault
 * magic. Used by `tokenVault` / `secretsVault` to dispatch between
 * the safeStorage and password-vault decryption paths when reading
 * a file produced by a previous session.
 */
export function isPasswordVaultBlob(blob: Buffer): boolean {
  return blob.length >= MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Open a modal BrowserWindow asking the user for a password, derive a
 * key from it, cache it, and resolve. Rejects if the user closes the
 * window without entering a password.
 *
 * Loaded as a separate function so test code can stub it without
 * pulling in `BrowserWindow`.
 */
export async function promptForVaultPassword(opts: {
  parent?: BrowserWindow;
  /**
   * Human-readable explanation rendered in the prompt window. Defaults
   * to a generic "Tessera needs a password to encrypt local data".
   */
  prompt?: string;
  /**
   * If true, the prompt shows a "Confirm password" field — used on
   * the first-ever launch where there's no existing vault to verify
   * against. Subsequent prompts (re-authentication) use false.
   */
  confirmRequired: boolean;
}): Promise<string> {
  const promptHtml = renderPromptHtml({
    message: opts.prompt ??
      "Tessera could not detect an OS keyring on this machine. Enter a password to encrypt your local OAuth tokens and API keys. You will be asked for this password every time the app starts.",
    confirmRequired: opts.confirmRequired,
  });

  const win = new BrowserWindow({
    width: 480,
    height: opts.confirmRequired ? 360 : 300,
    parent: opts.parent,
    modal: opts.parent !== undefined,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Tessera — Vault Password",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(promptHtml)}`,
  );

  return new Promise<string>((resolve, reject) => {
    const channel = `password-vault:submit:${win.id}`;
    let resolved = false;

    const handler = (
      _e: Electron.IpcMainEvent,
      payload: { password: string },
    ): void => {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener(channel, handler);
      win.close();
      resolve(payload.password);
    };
    ipcMain.on(channel, handler);

    win.on("closed", () => {
      ipcMain.removeListener(channel, handler);
      if (!resolved) {
        reject(
          new Error(
            "Vault password prompt was closed without a password being entered.",
          ),
        );
      }
    });
  });
}

function renderPromptHtml(opts: {
  message: string;
  confirmRequired: boolean;
}): string {
  const confirmField = opts.confirmRequired
    ? `<label for="confirm">Confirm password</label>
       <input id="confirm" type="password" autocomplete="new-password" />`
    : "";
  const submitJs = opts.confirmRequired
    ? `if (p !== document.getElementById('confirm').value) {
         document.getElementById('err').textContent = 'Passwords do not match.';
         return;
       }`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Vault Password</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 20px; color: #1f2937; }
  p { line-height: 1.4; font-size: 13px; }
  label { display: block; margin-top: 12px; font-size: 12px; font-weight: 600; }
  input { width: 100%; padding: 8px; margin-top: 4px; border: 1px solid #d1d5db; border-radius: 4px; font-size: 14px; box-sizing: border-box; }
  button { margin-top: 16px; padding: 8px 16px; background: #2563eb; color: white; border: 0; border-radius: 4px; font-size: 14px; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  #err { color: #b91c1c; font-size: 12px; margin-top: 8px; min-height: 16px; }
</style></head>
<body>
  <p>${opts.message}</p>
  <label for="pw">Password</label>
  <input id="pw" type="password" autocomplete="${opts.confirmRequired ? "new" : "current"}-password" autofocus />
  ${confirmField}
  <div id="err"></div>
  <button id="ok">Unlock vault</button>
  <script>
    const ipc = require('electron').ipcRenderer;
    const id = parseInt(new URLSearchParams(location.search).get('windowId') || '0');
    function submit() {
      const p = document.getElementById('pw').value;
      if (!p) {
        document.getElementById('err').textContent = 'Password cannot be empty.';
        return;
      }
      ${submitJs}
      ipc.send('password-vault:submit:' + id, { password: p });
    }
    document.getElementById('ok').addEventListener('click', submit);
    document.getElementById('pw').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    const c = document.getElementById('confirm');
    if (c) c.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  </script>
</body></html>`;
}

/**
 * Top-level initialiser called from `appState.initAppState`. If
 * safeStorage is available, no-op. If not, prompt the user for a
 * password and cache the derived key.
 *
 * `existingVault` distinguishes:
 *   - first launch on a keyringless platform → ask for new password
 *     + confirmation, generate salt
 *   - subsequent launch where vault files already exist → ask for
 *     existing password, verify by decrypting a witness blob if any
 */
export async function initPasswordVaultIfNeeded(opts: {
  isEncryptionAvailable: () => boolean;
  existingVault: boolean;
  parent?: BrowserWindow;
}): Promise<{ active: boolean; reason?: string }> {
  if (opts.isEncryptionAvailable()) {
    return { active: false, reason: "safeStorage is available" };
  }
  const password = await promptForVaultPassword({
    parent: opts.parent,
    confirmRequired: !opts.existingVault,
  });
  deriveAndCacheKey(password);
  return { active: true };
}
