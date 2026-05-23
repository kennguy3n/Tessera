/**
 * SQLCipher database-key derivation and persistence.
 *
 * The Rust bridge ({@link tessera_core::db::open_shared_with_key})
 * expects a 64-character hex string (= 256-bit raw key) at every
 * `init_bridge` call. This module is the Electron side of that
 * contract: it generates a key on first launch, wraps it via the
 * OS-backed `safeStorage` API, and persists the encrypted blob next
 * to the database file. Subsequent launches read and decrypt the
 * blob; the cleartext key never touches disk.
 *
 * # Key-derivation chain
 *
 * 1. **First launch.** `crypto.randomBytes(32)` generates 32 bytes of
 *    OS-RNG-quality entropy. We hex-encode them (64 chars) and use
 *    that as the raw SQLCipher key — no KDF, no passphrase. The
 *    cipher key IS the random material.
 * 2. **Wrap.** `safeStorage.encryptString(hex)` runs the hex through
 *    Electron's OS-backed crypto layer:
 *      - macOS: Keychain Services (item is per-app, locked by user
 *        password / Touch ID).
 *      - Windows: DPAPI (per-user, tied to the Windows account).
 *      - Linux: Secret Service (gnome-keyring / kwallet5) via libsecret.
 *    The resulting encrypted blob is opaque ciphertext — even
 *    file-system-level access by another process cannot recover the
 *    cipher key without an unlocked keyring.
 * 3. **Persist.** The wrapped blob is written to
 *    `<userData>/db.key`. The file inherits the default Node
 *    `fs.writeFileSync` mode (0o666 pre-umask, typically 0o644
 *    after the standard 0o022 umask — i.e. world-readable). We
 *    don't rely on POSIX permissions for security: the blob is
 *    `safeStorage`-encrypted ciphertext that only the user's
 *    unlocked keyring can decrypt, so file-system-level read
 *    access by another process or user gains nothing.
 * 4. **Subsequent launches.** Read `<userData>/db.key`, decrypt with
 *    `safeStorage.decryptString` to recover the hex key, pass it to
 *    `initBridge(dbPath, templateDir, hexKey)`.
 *
 * # Failure modes
 *
 * - **`safeStorage` unavailable** (Linux headless / no keyring
 *   daemon): {@link getOrCreateDbKey} throws with a
 *   user-actionable message from {@link keyringUnavailableSentence}.
 *   We deliberately use `keyringUnavailableSentence()` here rather
 *   than `encryptionUnavailableReason()` because the password vault
 *   does NOT wrap the SQLCipher database key (see the KNOWN
 *   LIMITATION block in `main.ts` next to `maybeInitPasswordVault`):
 *   showing the user a "restart and enter a vault password" hint
 *   on this path would send them down an unrecoverable route. The
 *   current launch path in `appState.ts` catches and falls through
 *   to an unencrypted bridge so the app remains usable.
 * - **`db.key` exists but won't decrypt** (e.g. the user copied
 *   their `userData` directory to a different machine): we surface
 *   the underlying `safeStorage.decryptString` error verbatim. The
 *   app cannot recover the database without the original keyring;
 *   the only path forward is restoring from backup or deleting both
 *   `tessera.db` and `db.key` (accepting data loss).
 * - **`db.key` exists but is corrupted / zero-length**: same path
 *   as decrypt failure — surface and fail loudly rather than silently
 *   regenerating, which would render `tessera.db` permanently
 *   inaccessible.
 *
 * # Why not store the key in the keyring directly
 *
 * Electron's `safeStorage` is a one-shot wrap/unwrap primitive, not
 * a keyring-item API. Storing the wrapped blob on disk and unwrapping
 * at startup keeps the integration cross-platform (one path for
 * macOS / Windows / Linux) and avoids managing a separate Keychain
 * item that could go out of sync with the on-disk database file.
 */
import { app, safeStorage } from "electron";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

import { keyringUnavailableSentence } from "./vaultCrypto";
import {
  decryptWithPasswordKey,
  encryptWithPasswordKey,
  isPasswordVaultBlob,
  passwordVaultActive,
  WrongVaultPasswordError,
} from "./passwordVault";

/** Length of the SQLCipher raw key in bytes (256-bit cipher key). */
const KEY_BYTES = 32;
/**
 * Length of the same key once hex-encoded — matches
 * `tessera_core::db::DB_KEY_HEX_LEN`. Pinned here so a mistaken edit
 * on either side produces an obvious test failure.
 */
export const DB_KEY_HEX_LEN = 64;

const KEY_FILE_NAME = "db.key";

function keyPath(): string {
  return path.join(app.getPath("userData"), KEY_FILE_NAME);
}

/**
 * Signals that the current platform / environment cannot back the
 * database key chain because **both** `safeStorage.isEncryptionAvailable()`
 * is false AND `passwordVaultActive()` is false (i.e. neither the
 * OS keyring nor the password-derived fallback vault is reachable).
 *
 * Callers in `appState.ts` use this distinct type to decide whether
 * to fall through to an unencrypted bridge: ONLY this error means
 * the platform itself lacks any encryption-wrapping primitive. Any
 * other error thrown by {@link getOrCreateDbKey} /
 * {@link getOrCreateDbKeyAsync} (zero-byte key file, wrong decrypted
 * length, underlying decrypt failure, wrong vault password)
 * indicates the user previously had encryption working and the key
 * is now lost or corrupted — in those cases the on-disk database is
 * almost certainly encrypted, and proceeding with `dbKey = null`
 * would either fail noisily at the next `CREATE TABLE` or, worse,
 * write fresh unencrypted bytes alongside an encrypted file. Both
 * outcomes are wrong; let those errors bubble up and refuse to
 * bring up the bridge instead.
 */
export class EncryptionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionUnavailableError";
    // Pin the prototype so `instanceof EncryptionUnavailableError`
    // works even when this module is transpiled to ES5-style
    // constructor inheritance.
    Object.setPrototypeOf(this, EncryptionUnavailableError.prototype);
  }
}

/**
 * Generate a fresh 256-bit key and return its hex encoding.
 *
 * Exposed for tests; production code should always go through
 * {@link getOrCreateDbKey} so the key gets persisted and reused
 * across launches.
 */
export function generateDbKey(): string {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

/** Matches `tessera_core::db::validate_hex_key`. */
const HEX_KEY_REGEX = /^[0-9a-fA-F]{64}$/;

/**
 * Return the SQLCipher key for this install, creating and persisting
 * one on first launch.
 *
 * The check ordering is significant. We probe the on-disk `db.key`
 * file *before* asking `safeStorage` whether encryption is
 * available, because the presence of `db.key` is itself the signal
 * that the user previously had encryption working. If the file is
 * there but the keyring isn't reachable any more (gnome-keyring
 * uninstalled, user moved to a TTY without a session bus, etc.) the
 * data on disk is encrypted ciphertext that we cannot recover — the
 * correct response is to fail loudly so the caller refuses to bring
 * up the bridge, NOT to fall back to an unencrypted open that would
 * either crash at the first `CREATE TABLE` or, in the corner case
 * where `tessera.db` was deleted but `db.key` survived, silently
 * regress to plaintext storage. Only when both `db.key` is absent
 * AND the keyring is unavailable do we throw the recoverable
 * {@link EncryptionUnavailableError} that authorises
 * `appState.ts` to fall through to an unencrypted bridge.
 *
 * Distinct failure modes:
 * - Throws {@link EncryptionUnavailableError} only when `db.key`
 *   does NOT exist on disk AND `safeStorage.isEncryptionAvailable()`
 *   is false. This is the fresh-install-on-keyringless-platform
 *   case where falling back to unencrypted is safe because no
 *   prior encrypted state exists.
 * - Throws a plain `Error` for every other failure: zero-byte key
 *   file, decrypt failure (including keyring suddenly unavailable
 *   with an existing key on disk), wrong decrypted length, or
 *   wrong decrypted content (non-hex). These indicate the user
 *   previously had encryption working and the key is now lost or
 *   corrupted, so the on-disk DB is almost certainly encrypted —
 *   the caller must NOT fall back to unencrypted mode.
 */
export function getOrCreateDbKey(): string {
  const fp = keyPath();
  if (fs.existsSync(fp)) {
    // Existing-key path. We must NEVER fall through to the
    // "generate a new key" branch from here — even if the keyring
    // is unavailable, the on-disk DB is wrapped with the key in
    // this file and we either decrypt it or fail loudly.
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        `Database key file at ${fp} exists but the OS keyring is unavailable, so the key cannot be decrypted. The encrypted database cannot be opened on this platform. Restore keyring access (e.g. install gnome-keyring / kwallet5 on Linux), restore from backup, or delete both ${fp} and the database file to start fresh (data loss).`,
      );
    }
    const blob = fs.readFileSync(fp);
    if (blob.length === 0) {
      // A zero-byte key file is almost certainly a half-written
      // first-launch attempt that the user interrupted. Surface
      // loudly rather than regenerating: silently overwriting
      // would mean the corresponding `tessera.db` is unrecoverable.
      throw new Error(
        `Database key file at ${fp} is empty. Restore from backup or delete both this file and the database to start fresh (data loss).`,
      );
    }
    const hex = safeStorage.decryptString(blob);
    if (hex.length !== DB_KEY_HEX_LEN) {
      throw new Error(
        `Decrypted database key has unexpected length ${hex.length} (expected ${DB_KEY_HEX_LEN}). The key file may be corrupted.`,
      );
    }
    if (!HEX_KEY_REGEX.test(hex)) {
      // Length matches but content isn't hex. Catch it here with
      // an actionable message rather than letting the Rust bridge
      // reject with the opaque "db key must be ASCII hex digits
      // only" error — same outcome, much better diagnostic at the
      // source layer where the user can correlate it with `db.key`.
      throw new Error(
        `Decrypted database key has length ${DB_KEY_HEX_LEN} but contains non-hex characters. The key file is corrupted.`,
      );
    }
    return hex;
  }
  // No `db.key` on disk — fresh install (or the user deleted it
  // intentionally). Only here is it safe to surface an
  // `EncryptionUnavailableError` so the caller can degrade to an
  // unencrypted bridge, because there is no encrypted state to lose.
  if (!safeStorage.isEncryptionAvailable()) {
    // Use `keyringUnavailableSentence()` here, NOT
    // `encryptionUnavailableReason()`. The latter appends a
    // password-vault recovery hint, but the password vault does NOT
    // wrap the SQLCipher database key (see `maybeInitPasswordVault`
    // KNOWN LIMITATION in `main.ts`). Showing the vault-recovery
    // hint here would send the user down an unrecoverable path.
    throw new EncryptionUnavailableError(keyringUnavailableSentence());
  }
  // First launch — generate, wrap, persist.
  const hex = generateDbKey();
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const blob = safeStorage.encryptString(hex);
  // Write to a temp path and rename so an interrupted write
  // (machine crash, power loss) cannot leave a half-written key
  // file alongside a populated database. After rename the file is
  // either fully written or absent.
  const tmp = `${fp}.tmp`;
  fs.writeFileSync(tmp, blob);
  fs.renameSync(tmp, fp);
  return hex;
}

/**
 * Test-only seam: erase the persisted key file. Production callers
 * should never need this — the only legitimate reason to discard the
 * key is when the user explicitly accepts data loss, which the UI
 * handles by deleting `tessera.db` and `db.key` together.
 *
 * Prefixed with an underscore and suffixed `…ForTests` to match the
 * codebase convention for non-production seams (see
 * `electron/autoUpdater.ts`'s `_resetForTests` and
 * `electron/config.ts`'s `_clearConfigCacheForTests`).
 */
export function _deleteDbKeyForTests(): void {
  const fp = keyPath();
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
  }
}

/**
 * Return the SQLCipher key for this install, creating and persisting
 * one on first launch — vault-aware variant.
 *
 * This is the same contract as {@link getOrCreateDbKey} with one
 * additional integration: when `safeStorage` is unavailable but the
 * password vault has been unlocked via
 * `initPasswordVaultIfNeeded` (so `passwordVaultActive()` is true),
 * the SQLCipher key is wrapped under the vault's password-derived
 * AES-256-GCM key instead of being unsupported.
 *
 * The on-disk format is the same for both wrapping paths — a
 * 64-character hex string wrapped in the wrapping-key's encryption.
 * We disambiguate at read time by inspecting the first four bytes:
 * password-vault blobs start with the `TSPV` magic
 * (see {@link isPasswordVaultBlob}); safeStorage blobs do not.
 *
 * # Dispatch matrix
 *
 * | `db.key` on disk? | safeStorage avail? | vault active? | Behaviour |
 * | ----------------- | ------------------ | ------------- | --------- |
 * | yes, safeStorage  | yes                | any           | Decrypt via safeStorage (existing path). |
 * | yes, safeStorage  | **no**             | any           | Throw plain Error — keyring is gone, DB is unrecoverable on this machine. |
 * | yes, vault (TSPV) | any                | **yes**       | Decrypt via vault key. |
 * | yes, vault (TSPV) | any                | **no**        | Throw plain Error — vault is locked. |
 * | no                | yes                | any           | Generate, wrap via safeStorage, persist. |
 * | no                | no                 | **yes**       | Generate, wrap via vault, persist with TSPV magic. |
 * | no                | no                 | no            | Throw `EncryptionUnavailableError`. |
 *
 * # Migration of pre-existing plaintext databases
 *
 * If `db.key` is absent but `tessera.db` exists, the database is
 * plaintext (a pre-encryption install). The Rust bridge's
 * `open_shared_with_key` handles the plaintext → SQLCipher
 * migration transparently via `sqlcipher_export` when called with
 * a key, so this function does NOT need to issue a separate
 * migration command. We just generate + persist a key normally; the
 * very next `initBridge` call will trigger the migration on the
 * Rust side.
 *
 * # Why async
 *
 * The vault decryption path runs `AES-256-GCM` via Node's
 * `crypto.createDecipheriv`. That call itself is synchronous (it
 * uses libcrypto on the calling thread), so this function COULD be
 * synchronous in principle. We mark it async anyway to leave
 * headroom for a future improvement where we want to debounce the
 * password prompt against the dock-click race in `main.ts` (the
 * existing `maybeInitPasswordVault` is already async), and so
 * callers cannot rely on synchronous completion as a contract.
 */
export async function getOrCreateDbKeyAsync(): Promise<string> {
  const fp = keyPath();
  if (fs.existsSync(fp)) {
    const blob = fs.readFileSync(fp);
    if (blob.length === 0) {
      // Same as the sync path: half-written first-launch attempt.
      // Surface loudly rather than regenerating — overwriting
      // would render the matching `tessera.db` permanently
      // unreadable regardless of which wrapping path produced it.
      throw new Error(
        `Database key file at ${fp} is empty. Restore from backup or delete both this file and the database to start fresh (data loss).`,
      );
    }
    if (isPasswordVaultBlob(blob)) {
      // Password-vault path: the user previously generated a key
      // on a keyringless platform and wrapped it under the vault
      // password. We need the vault to be active to read it.
      if (!passwordVaultActive()) {
        // The vault prompt either wasn't presented or the user
        // cancelled it. We MUST NOT fall back to safeStorage or
        // to "regenerate a fresh key" — both paths render the
        // existing encrypted `tessera.db` permanently unreadable.
        throw new Error(
          `Database key file at ${fp} is wrapped under the password vault, but the vault is not unlocked. Restart Tessera and enter the vault password, or restore from backup if the password is lost.`,
        );
      }
      let hex: string;
      try {
        hex = decryptWithPasswordKey(blob);
      } catch (e) {
        if (e instanceof WrongVaultPasswordError) {
          // Re-throw as plain Error so appState.ts's catch
          // path doesn't treat it as a recoverable
          // "encryption unavailable" situation. The DB is
          // encrypted and unrecoverable without the right
          // password — refusing to bring up the bridge is the
          // correct response (same as a corrupt safeStorage
          // blob).
          throw new Error(
            `Failed to decrypt database key with the supplied vault password. Restart Tessera with the correct password, or restore from backup if the password is lost. (${e.message})`,
          );
        }
        throw e;
      }
      if (hex.length !== DB_KEY_HEX_LEN) {
        throw new Error(
          `Decrypted database key has unexpected length ${hex.length} (expected ${DB_KEY_HEX_LEN}). The key file may be corrupted.`,
        );
      }
      if (!HEX_KEY_REGEX.test(hex)) {
        throw new Error(
          `Decrypted database key has length ${DB_KEY_HEX_LEN} but contains non-hex characters. The key file is corrupted.`,
        );
      }
      return hex;
    }
    // Not a vault blob — must be a safeStorage blob. Fall through
    // to the existing sync path, which encapsulates all the same
    // safeStorage validation invariants. This also includes the
    // "safeStorage unavailable with an existing key file" branch,
    // which is correctly a hard failure (not EncryptionUnavailableError).
    return getOrCreateDbKey();
  }
  // No `db.key` on disk — fresh install (or the user deleted it
  // intentionally). Prefer safeStorage when available; fall back
  // to the vault if the vault is active; only then surface the
  // recoverable EncryptionUnavailableError.
  if (safeStorage.isEncryptionAvailable()) {
    // Same as the sync path; delegate to keep the safeStorage
    // generate / wrap / atomic-rename logic in one place.
    return getOrCreateDbKey();
  }
  if (passwordVaultActive()) {
    // Vault-wrapped first-launch path. Generate, wrap under the
    // PBKDF2-derived vault key, persist with the `TSPV` magic so
    // future reads dispatch to the vault decryption path. This
    // also covers the migration scenario: if `tessera.db` exists
    // (plaintext) but `db.key` doesn't, generate a key now — the
    // Rust bridge's `open_shared_with_key` will then issue
    // `sqlcipher_export` and migrate the plaintext DB to a
    // SQLCipher-encrypted one transparently on the next
    // `initBridge` call. No separate migration step is needed.
    const hex = generateDbKey();
    const dir = path.dirname(fp);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const blob = encryptWithPasswordKey(hex);
    // Same atomic-rename pattern as the safeStorage path to
    // protect against partial writes during machine crashes /
    // power loss.
    const tmp = `${fp}.tmp`;
    fs.writeFileSync(tmp, blob, { mode: 0o600 });
    fs.renameSync(tmp, fp);
    return hex;
  }
  // Neither safeStorage nor the password vault is available.
  // This is the original "keyringless platform AND user declined
  // / cancelled the password prompt" path. Surface a recoverable
  // EncryptionUnavailableError so appState.ts can degrade to an
  // unencrypted bridge.
  //
  // Use `keyringUnavailableSentence()` here, NOT
  // `encryptionUnavailableReason()`. The latter would tell the
  // user to enter a vault password — but we just observed
  // `passwordVaultActive() === false`, meaning either the prompt
  // wasn't presented (no salt file → first launch) or the user
  // dismissed it. Showing them the vault hint in either case
  // sends them in a loop.
  throw new EncryptionUnavailableError(keyringUnavailableSentence());
}
