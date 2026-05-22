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
 *   user-actionable message from {@link encryptionUnavailableReason}.
 *   The current launch path in `appState.ts` catches and falls
 *   through to an unencrypted bridge so the app remains usable —
 *   WS10 will add an interactive password-prompt fallback.
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

import { encryptionUnavailableReason } from "./tokenVault";

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
 * database key chain because `safeStorage.isEncryptionAvailable()`
 * returned false (e.g. Linux without gnome-keyring / kwallet5).
 *
 * Callers in `appState.ts` use this distinct type to decide whether
 * to fall through to an unencrypted bridge: ONLY this error means
 * the platform itself lacks encryption support. Any other error
 * thrown by {@link getOrCreateDbKey} (zero-byte key file, wrong
 * decrypted length, underlying decrypt failure) indicates the user
 * previously had encryption working and the key is now lost or
 * corrupted — in those cases the on-disk database is almost
 * certainly encrypted, and proceeding with `dbKey = null` would
 * either fail noisily at the next `CREATE TABLE` or, worse, write
 * fresh unencrypted bytes alongside an encrypted file. Both
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

/**
 * Return the SQLCipher key for this install, creating and persisting
 * one on first launch.
 *
 * Distinct failure modes:
 * - Throws {@link EncryptionUnavailableError} when
 *   `safeStorage.isEncryptionAvailable()` is false (e.g. Linux
 *   without a keyring daemon). The caller in `appState.ts` catches
 *   THIS specific class and falls through to an unencrypted bridge.
 * - Throws a plain `Error` for any other failure (zero-byte key
 *   file, wrong decrypted length, underlying decrypt error). These
 *   indicate the user previously had encryption working and the key
 *   is now lost / corrupted, so the on-disk DB is almost certainly
 *   encrypted — the caller must NOT fall back to unencrypted mode.
 */
export function getOrCreateDbKey(): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new EncryptionUnavailableError(encryptionUnavailableReason());
  }
  const fp = keyPath();
  if (fs.existsSync(fp)) {
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
    return hex;
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
