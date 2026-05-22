/**
 * Shared encrypt/decrypt dispatch for `tokenVault.ts` and
 * `secretsVault.ts`.
 *
 * Both modules need the same two-tier fallback:
 *   1. Electron's `safeStorage` (OS keyring) when available
 *   2. Password-derived AES-256-GCM (`passwordVault.ts`) as fallback
 *   3. Otherwise, throw with an actionable recovery message
 *
 * Without this shared module the rules diverged across files: a
 * change to the dispatch order, a fix to the recovery wording, or a
 * future third backend (e.g. hardware-backed enclaves) would have to
 * be applied in lockstep to two places — which is exactly the kind
 * of duplication that causes one file to drift and silently produce
 * a different security posture.
 *
 * Callers pass a `VaultLabel` so the error messages reference the
 * caller's domain noun ("Vault" for OAuth-token blobs, "Secret" for
 * API-key blobs) and the right recovery directory name.
 */

import { safeStorage } from "electron";

import {
  decryptWithPasswordKey,
  encryptWithPasswordKey,
  isPasswordVaultBlob,
  passwordVaultActive,
} from "./passwordVault";

/**
 * Build a human-readable error explaining why the OS keyring is unavailable.
 *
 * On Linux this commonly means the user is on a minimal or headless desktop
 * with no Secret Service-compatible daemon running (e.g. `gnome-keyring` /
 * `kwallet5-daemon`) — Electron's safeStorage falls back to `basic_text` only
 * when one of those is detected, and refuses to fall back to plaintext.
 *
 * On macOS this would mean Keychain is locked or sandboxed away (very rare);
 * on Windows it would mean DPAPI is unavailable (also very rare).
 */
export function encryptionUnavailableReason(): string {
  switch (process.platform) {
    case "linux":
      return (
        "Encryption not available — no OS keyring daemon detected. " +
        "Install and start one of: gnome-keyring-daemon (GNOME / Ubuntu), " +
        "kwallet5-daemon (KDE), or pass an X session manager that exposes the " +
        "Secret Service D-Bus API. The Debian/Ubuntu packages are " +
        "`gnome-keyring` and `libsecret-1-0`."
      );
    case "darwin":
      return "Encryption not available — Keychain is locked or inaccessible.";
    case "win32":
      return "Encryption not available — Windows DPAPI is unavailable.";
    default:
      return "Encryption not available — unsupported platform.";
  }
}

/**
 * Per-vault wording used to make error messages name-appropriate for
 * the caller's domain. `noun` is shown verbatim in error messages,
 * `recoveryDirectoryHint` is appended to the keyring-lost recovery
 * message so the user knows exactly which directory to delete to
 * start fresh.
 */
export interface VaultLabel {
  /** "Vault" | "Secret" — the human-readable noun for blobs from this caller. */
  noun: string;
  /**
   * The actionable suffix to append to the keyring-lost error.
   * tokenVault: "or delete the vault directory to re-authenticate from
   *   scratch (you will need to re-enter API keys and re-authorize
   *   OAuth providers)."
   * secretsVault: "or delete the secret-vault directory to re-enter API keys."
   */
  recoveryDirectoryHint: string;
}

/**
 * Encrypt `plaintext` using whichever vault mode is active. Prefers
 * safeStorage when available; falls through to the password-derived
 * vault if `initPasswordVaultIfNeeded` cached a key at app startup.
 *
 * Throws if NEITHER mode is available — refusing to store secrets
 * unencrypted is the whole point.
 */
export function encryptForVault(plaintext: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext);
  }
  if (passwordVaultActive()) {
    return encryptWithPasswordKey(plaintext);
  }
  throw new Error(encryptionUnavailableReason());
}

/**
 * Decrypt `blob` by sniffing its format. Password-vault blobs start
 * with the `TSPV` magic; safeStorage blobs do not. This lets the
 * vault tolerate a mixed-format directory — e.g. a user who first
 * launched with a keyring and later lost it has both formats on disk.
 *
 * - `TSPV` blob + active password vault → decrypt with cached key.
 * - `TSPV` blob + no active password vault → throw (we cannot decrypt).
 * - non-`TSPV` blob + safeStorage available → decrypt via safeStorage.
 * - non-`TSPV` blob + no safeStorage → throw with the actionable
 *   recovery message (different for token vs secret callers; see
 *   `VaultLabel`).
 */
export function decryptFromVault(blob: Buffer, label: VaultLabel): string {
  if (isPasswordVaultBlob(blob)) {
    if (!passwordVaultActive()) {
      throw new Error(
        `${label.noun} blob is password-encrypted but no password is cached. ${encryptionUnavailableReason()}`,
      );
    }
    return decryptWithPasswordKey(blob);
  }
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(blob);
  }
  // Mixed-format hazard: the file is a safeStorage blob from a
  // previous session, but the user's keyring is no longer available.
  // We CANNOT migrate it to password format on the fly because we
  // can't decrypt it without the keyring. Surface the actionable
  // recovery instructions rather than failing silently.
  throw new Error(
    `${label.noun} file is encrypted with the OS keyring but the keyring is no longer available. Restore keyring access (${encryptionUnavailableReason()}) ${label.recoveryDirectoryHint}`,
  );
}

/**
 * Pre-built labels for the two existing callers. Exporting these so
 * each caller doesn't have to keep the literal wording in sync.
 */
export const TOKEN_VAULT_LABEL: VaultLabel = {
  noun: "Vault",
  recoveryDirectoryHint:
    "or delete the vault directory to re-authenticate from scratch (you will need to re-enter API keys and re-authorize OAuth providers).",
};

export const SECRETS_VAULT_LABEL: VaultLabel = {
  noun: "Secret",
  recoveryDirectoryHint:
    "or delete the secret-vault directory to re-enter API keys.",
};
