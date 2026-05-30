/**
 * Password-derived fallback vault used when Electron's `safeStorage`
 * is unavailable (typically headless Linux without `gnome-keyring` /
 * `kwallet`).
 *
 * Architecture:
 *
 *   1. At app startup, `main.ts`'s `maybeInitPasswordVault` wrapper
 *      awaits `initPasswordVaultIfNeeded` before `createWindow()`
 *      runs. If `safeStorage.isEncryptionAvailable()` is true, this is
 *      a no-op — the existing `safeStorage`-based path stays in
 *      effect and the password prompt is never shown.
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
import { promisify } from "util";

import {
  PASSWORD_PROMPT_CANCEL_CHANNEL,
  PASSWORD_PROMPT_SUBMIT_CHANNEL,
} from "./passwordPromptChannels";
import { zeroBuffers } from "./secureBuffer";

const pbkdf2Async = promisify(crypto.pbkdf2);

/**
 * Re-export the channel constants from this module too, so existing
 * callers / tests (e.g. `passwordVault.test.ts`) can import them
 * from `./passwordVault` without knowing about the underlying split.
 * The single source of truth lives in `passwordPromptChannels.ts` —
 * both this file and the preload script import from there to prevent
 * drift.
 */
export {
  PASSWORD_PROMPT_CANCEL_CHANNEL,
  PASSWORD_PROMPT_SUBMIT_CHANNEL,
} from "./passwordPromptChannels";

const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_DIGEST = "sha256";
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
/**
 * Magic bytes prefixed to every password-vault blob.
 *
 * `Buffer` is mutable — any code with a reference could `.fill(0)`
 * this constant and silently break all future encrypt/decrypt
 * dispatch (decrypted blobs would no longer match, and freshly
 * encrypted blobs would carry the zeroed prefix). `Object.freeze`
 * cannot prevent `TypedArray.prototype.fill` from clobbering the
 * underlying bytes (freeze only locks property descriptors, not the
 * backing storage of typed-array views), so there's no idiomatic
 * "make this Buffer immutable" path in Node.
 *
 * The defence is structural: `MAGIC` is NOT exported, and within
 * this module it is only ever consumed by read-only operations
 * (`subarray`, `equals`, `toString`, `Buffer.concat` — which copies
 * the bytes into a new buffer rather than mutating its sources).
 * No reachable code path mutates `MAGIC`, so the theoretical mutability
 * is gated entirely by "do not export, do not pass to APIs that
 * mutate their arguments". Both invariants are enforced at the
 * module boundary.
 */
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
  // Write to a temp path and rename so an interrupted write (machine
  // crash, power loss) cannot leave a partial salt file alongside a
  // populated vault directory. The length check above would catch a
  // truncated salt and throw "unexpected length", but the user-visible
  // recovery from that is "delete the salt file and re-enter every
  // secret" — which is worse than what they'd see if the rename was
  // atomic and the salt-file simply didn't appear at all on next
  // launch (the prompt would offer a fresh-install flow). After
  // rename the file is either fully written or absent.
  //
  // Matches the same pattern used by `dbKey.ts:getOrCreateDbKey` for
  // the SQLCipher master key, keeping the on-disk-write semantics
  // consistent across both at-rest-encryption material on disk.
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, fresh, { mode: 0o600 });
  fs.renameSync(tmp, fp);
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
 * and return an independent copy of it.
 *
 * Async because PBKDF2 with 600k iterations takes ~1–2 seconds and
 * `crypto.pbkdf2Sync` blocks the main process event loop for the
 * full duration — which delays the post-prompt window open and any
 * concurrent app.whenReady setup. The async variant runs PBKDF2 on
 * libuv's thread pool, keeping the main thread responsive.
 *
 * Call sites in the vault sync APIs (`tokenVault` / `secretsVault`)
 * do NOT call this function directly — they consult
 * `passwordVaultActive()` after `initPasswordVaultIfNeeded` has
 * awaited the derivation. So the sync vault APIs still see a
 * synchronously-readable cached key.
 *
 * The returned `Buffer` is a COPY of the cached key, not a reference
 * to the module-level `cachedKey` buffer. This matters because
 * `clearPasswordVaultKey()` zero-fills the cached buffer in place —
 * a caller that held a reference to the underlying buffer would
 * find its data wiped from under them. Most production callers
 * discard the return value (only tests inspect it), but the copy
 * preserves the invariant that "external buffers are mine, internal
 * buffer is the vault's" so a future caller can't accidentally
 * step on the cache or have their own buffer zeroed.
 */
export async function deriveAndCacheKey(password: string): Promise<Buffer> {
  if (password.length === 0) {
    throw new Error("Vault password cannot be empty.");
  }
  const salt = getOrCreateSalt();
  const key = await pbkdf2Async(
    password,
    salt,
    PBKDF2_ITERATIONS,
    PBKDF2_KEY_LEN,
    PBKDF2_DIGEST,
  );
  clearPasswordVaultKey();
  cachedKey = key;
  return Buffer.from(key);
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
  // Phase 15 Task 27 — sensitive-buffer cleanup.
  //
  // `decipher.update(ciphertext)` and `decipher.final()` allocate
  // intermediate Buffers holding plaintext fragments of the secret.
  // `Buffer.concat` copies those fragments into a fresh contiguous
  // Buffer (`plaintext`) which we then convert to a JS string. ALL
  // THREE buffers must be overwritten before they hit GC so the
  // pooled slab does not hand the bytes to the next allocation.
  //
  // The JS string produced by `toString("utf-8")` is itself a
  // sensitive value that cannot be zeroed (strings are immutable in
  // JS). That heap leak is fundamental to the language; we minimise
  // it by NOT keeping the buffer around once the string is built.
  let part1: Buffer | null = null;
  let part2: Buffer | null = null;
  let plaintext: Buffer | null = null;
  try {
    part1 = decipher.update(ciphertext);
    part2 = decipher.final();
    plaintext = Buffer.concat([part1, part2]);
    return plaintext.toString("utf-8");
  } catch (e) {
    // AES-GCM auth-tag failure throws a generic OpenSSL "Unsupported
    // state" / "unable to authenticate data" error. Re-wrap as our
    // typed sentinel so callers can distinguish wrong-password from
    // structural corruption.
    throw new WrongVaultPasswordError(
      `Password-vault decryption failed (likely wrong password): ${(e as Error).message}`,
    );
  } finally {
    zeroBuffers(part1, part2, plaintext);
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
      // Loads the bridge that exposes
      // `window.tesseraPasswordPrompt.{submit,cancel}` to the page.
      // Without this preload, the renderer cannot reach `ipcRenderer`
      // (sandboxed + nodeIntegration disabled), and `require()` is
      // undefined — the submit button would be inert.
      preload: path.join(__dirname, "passwordPromptPreload.js"),
    },
  });
  // Guard `loadURL` with a try/destroy so a navigation failure cannot
  // leave the prompt BrowserWindow open after this function rejects.
  //
  // Today the URL is `data:text/html;charset=utf-8,...` which is
  // parsed in-process and cannot fail for well-formed input (and
  // `encodeURIComponent` guarantees well-formedness), so the catch
  // branch is unreachable. But this is defense-in-depth for the day
  // someone migrates the prompt away from `data:` — e.g. to
  // `file://passwordPrompt.html` so the inline `<script>` actually
  // gets CSP coverage (a real CSP-related ask the bot flagged
  // separately). At that point `loadURL` becomes capable of throwing
  // ENOENT / file-not-found / Chromium-init failures, and a thrown
  // `loadURL` here would orphan the BrowserWindow because the
  // `closed`-event registration further down is wired up INSIDE the
  // `new Promise` body and never runs if we reject before reaching
  // it. Destroying the window here closes the resource leak before
  // it can become reachable.
  try {
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(promptHtml)}`,
    );
  } catch (err) {
    if (!win.isDestroyed()) {
      win.destroy();
    }
    throw err;
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      ipcMain.removeListener(PASSWORD_PROMPT_SUBMIT_CHANNEL, onSubmit);
      ipcMain.removeListener(PASSWORD_PROMPT_CANCEL_CHANNEL, onCancel);
    };

    /**
     * Defence-in-depth: only accept messages whose `sender` is the
     * prompt window we just created. The fixed channel names mean a
     * second renderer (e.g. the main app window, if it had somehow
     * been opened before this listener was unregistered) could also
     * post to `password-vault:submit` / `password-vault:cancel`.
     * Today the prompt is the ONLY window when this listener is
     * active (it runs before `createWindow()`), but if the prompt is
     * ever re-shown later in the lifecycle (e.g. wrong-password
     * retry), other renderers will exist and this check stops them
     * from injecting a password or forging a cancel.
     */
    const isFromPromptWindow = (e: Electron.IpcMainEvent): boolean => {
      if (win.isDestroyed()) return false;
      return e.sender === win.webContents;
    };

    const onSubmit = (
      e: Electron.IpcMainEvent,
      payload: unknown,
    ): void => {
      if (settled) return;
      if (!isFromPromptWindow(e)) return;
      // Runtime validation: the TS annotation is compile-time only;
      // ipcMain.on receives arbitrary deserialized data from the
      // renderer. A compromised sandboxed prompt could send
      // `{ password: 123 }` or `undefined`.
      if (
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as Record<string, unknown>).password !== "string"
      ) {
        return;
      }
      const password = (payload as { password: string }).password;
      // Empty-string rejection at the IPC boundary. The renderer's
      // inline submit handler already gates on `if (!p) return;`
      // (see `renderPromptHtml`), and `deriveAndCacheKey` itself
      // throws "Vault password cannot be empty." which propagates
      // back through `initPasswordVaultIfNeeded` to
      // `maybeInitPasswordVault`'s `catch` block. So an empty string
      // sent from a compromised prompt would not break correctness.
      //
      // Rejecting here is defense-in-depth: it (a) avoids a 600k-
      // iteration PBKDF2 round-trip that's destined to throw, (b)
      // keeps the renderer-side validation as a UX nicety rather
      // than the actual enforcement boundary, and (c) means a
      // future caller that sends a stray `""` (e.g. a unit test
      // mocking the prompt) gets a clean no-op instead of a
      // confusing post-PBKDF2 reject.
      //
      // Same `return` as the type-check branch above so the listener
      // stays unsettled; the renderer can resubmit with a real
      // password, or close via Cancel/X.
      if (password === "") {
        return;
      }
      settled = true;
      cleanup();
      // Defer close so the renderer's `ipcRenderer.send` flush has a
      // tick to complete before its host process is torn down. The
      // submit IPC has already arrived (we're in its handler), but the
      // renderer-side script may have additional teardown to do
      // before the WebContents is destroyed.
      //
      // Note: this `setImmediate` does NOT defend against the
      // `window-all-closed` → `app.quit()` race that affects the
      // X-button close path before `createWindow()` has run. That
      // race is fixed structurally in `main.ts` via the
      // `appInitComplete` flag; deferring close here is purely about
      // IPC-flush hygiene. The OS title-bar X button closes the
      // window synchronously and would still race without the
      // `appInitComplete` guard.
      setImmediate(() => {
        if (!win.isDestroyed()) win.close();
      });
      resolve(password);
    };

    const onCancel = (e: Electron.IpcMainEvent): void => {
      if (settled) return;
      if (!isFromPromptWindow(e)) return;
      settled = true;
      cleanup();
      // See onSubmit comment above — same IPC-flush rationale, same
      // note about not relying on this to defer
      // `window-all-closed`.
      setImmediate(() => {
        if (!win.isDestroyed()) win.close();
      });
      reject(
        new Error(
          "Vault password prompt was cancelled by the user.",
        ),
      );
    };

    ipcMain.on(PASSWORD_PROMPT_SUBMIT_CHANNEL, onSubmit);
    ipcMain.on(PASSWORD_PROMPT_CANCEL_CHANNEL, onCancel);

    win.on("closed", () => {
      cleanup();
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "Vault password prompt was closed without a password being entered.",
          ),
        );
      }
    });
  });
}

/**
 * Minimal HTML escape for the prompt message. The message is
 * currently always a hardcoded literal, but interpolating it
 * un-escaped is a future-XSS footgun the moment a caller wants to
 * include something dynamic (e.g. a provider name) in the prompt.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Render the prompt HTML. Exported (with an underscore prefix to
 * signal test-only) so the test suite can assert structural
 * properties without spinning up Electron — see
 * `__tests__/passwordVault.test.ts` for the renderer-side regression
 * coverage that complements the unit tests below.
 *
 * The submit/cancel calls go through `window.tesseraPasswordPrompt`,
 * which is populated by `passwordPromptPreload.ts`. The page itself
 * has no Node access — `require` and `process` are both undefined.
 */
export function _renderPromptHtmlForTests(opts: {
  message: string;
  confirmRequired: boolean;
}): string {
  return renderPromptHtml(opts);
}

function renderPromptHtml(opts: {
  message: string;
  confirmRequired: boolean;
}): string {
  const safeMessage = escapeHtml(opts.message);
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
  .actions { margin-top: 16px; display: flex; gap: 8px; }
  button { padding: 8px 16px; border: 0; border-radius: 4px; font-size: 14px; cursor: pointer; }
  button#ok { background: #2563eb; color: white; }
  button#ok:hover { background: #1d4ed8; }
  button#cancel { background: transparent; color: #4b5563; border: 1px solid #d1d5db; }
  button#cancel:hover { background: #f3f4f6; }
  #err { color: #b91c1c; font-size: 12px; margin-top: 8px; min-height: 16px; }
</style></head>
<body>
  <p>${safeMessage}</p>
  <label for="pw">Password</label>
  <input id="pw" type="password" autocomplete="${opts.confirmRequired ? "new" : "current"}-password" autofocus />
  ${confirmField}
  <div id="err"></div>
  <div class="actions">
    <button id="ok">Unlock vault</button>
    <button id="cancel" type="button">Cancel</button>
  </div>
  <script>
    // \`window.tesseraPasswordPrompt\` is exposed by
    // \`passwordPromptPreload.ts\`. \`require\` and \`ipcRenderer\`
    // are NOT available here — the page runs sandboxed.
    const bridge = window.tesseraPasswordPrompt;
    // Failure mode: \`passwordPromptPreload.js\` failed to load (build
    // artefact missing, preload threw on startup, Electron-version
    // bug). Without this guard the Unlock button would call
    // \`bridge.submit\` on \`undefined\`, throw a TypeError silently in
    // the renderer console, and the user would have no idea why the
    // button does nothing. Surface the failure inline so the user can
    // at least close the window via Cancel and the maintainer has a
    // clear reproduction signal.
    //
    // Disable BOTH buttons rather than silently no-op-ing on click —
    // a disabled \`Unlock vault\` button + visible error message is a
    // much louder signal than "click does nothing".
    if (!bridge || typeof bridge.submit !== 'function' || typeof bridge.cancel !== 'function') {
      document.getElementById('err').textContent =
        'Password prompt failed to initialize (preload bridge unavailable). ' +
        'Close this window and check the main-process log for [Tessera] errors.';
      const okBtn = document.getElementById('ok');
      const cancelBtn = document.getElementById('cancel');
      okBtn.disabled = true;
      cancelBtn.disabled = true;
      // Do NOT return here — the outer promise still needs the OS
      // close-button to reject. The "closed without a password" path
      // in promptForVaultPassword fires on win.on('closed'), which is
      // independent of this script's ability to send IPC.
    } else {
    function submit() {
      const p = document.getElementById('pw').value;
      if (!p) {
        document.getElementById('err').textContent = 'Password cannot be empty.';
        return;
      }
      ${submitJs}
      bridge.submit(p);
    }
    function cancel() {
      // Defer to the main process's cancel handler. The handler
      // closes the window and rejects the outer promise with a
      // "cancelled by user" error — distinguishable from the
      // "closed without entering a password" error that fires when
      // the user dismisses the window via its title-bar close button.
      bridge.cancel();
    }
    document.getElementById('ok').addEventListener('click', submit);
    document.getElementById('cancel').addEventListener('click', cancel);
    document.getElementById('pw').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') cancel();
    });
    const c = document.getElementById('confirm');
    if (c) c.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') cancel();
    });
    }
  </script>
</body></html>`;
}

/**
 * Sentinel `reason` returned from `initPasswordVaultIfNeeded` when the
 * outer `safeStorage.isEncryptionAvailable()` returned false but the
 * inner re-check inside `initPasswordVaultIfNeeded` returned true —
 * i.e. the OS keyring daemon became available in the (vanishingly small)
 * window between the two checks.
 *
 * This is a TOCTOU race, NOT a vault failure: the keyring is now
 * available, so the safeStorage path will be used and the password
 * vault is not needed. Callers should treat this as success, NOT log
 * a "vault writes will fail" warning.
 *
 * Exported as a constant rather than a magic string so the comparison
 * in `main.ts::maybeInitPasswordVault` is a typed contract between
 * the two files. If we ever add other `active=false` reasons (e.g.
 * "prompt suppressed by policy") they will have distinct sentinels
 * and the main.ts side can decide per-reason whether to warn.
 */
export const VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE =
  "safeStorage is available";

/**
 * Top-level initialiser called from `main.ts`'s `maybeInitPasswordVault`
 * wrapper (which `app.whenReady` awaits before `createWindow()` runs).
 * If safeStorage is available, this is a no-op and returns
 * `{ active: false, reason: VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE }`
 * — caller treats that as success. If safeStorage is unavailable,
 * prompts the user for a password and caches the derived key, then
 * returns `{ active: true }`.
 *
 * `existingVault` distinguishes:
 *   - first launch on a keyringless platform → ask for new password
 *     + confirmation, generate salt
 *   - subsequent launch where vault files already exist → ask for
 *     existing password, verify by decrypting a witness blob if any
 *
 * Returns the discriminated shape `{ active: boolean, reason?: string }`
 * rather than throwing on the "not active" branch because
 * `safeStorage.isEncryptionAvailable() === true` is not an error — it's
 * the common production path where the vault is genuinely not needed.
 * The sentinel reason lets `maybeInitPasswordVault` distinguish
 * "deliberately skipped" from "prompt failed" without resorting to
 * string matching.
 */
export async function initPasswordVaultIfNeeded(opts: {
  isEncryptionAvailable: () => boolean;
  existingVault: boolean;
  parent?: BrowserWindow;
}): Promise<{ active: boolean; reason?: string }> {
  if (opts.isEncryptionAvailable()) {
    return {
      active: false,
      reason: VAULT_INACTIVE_SAFE_STORAGE_AVAILABLE,
    };
  }
  const password = await promptForVaultPassword({
    parent: opts.parent,
    confirmRequired: !opts.existingVault,
  });
  await deriveAndCacheKey(password);
  return { active: true };
}
