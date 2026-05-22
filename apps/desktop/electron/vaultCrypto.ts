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
 * The five cases:
 *
 *   1. `TSPV` blob + active password vault → decrypt with cached key.
 *   2. `TSPV` blob + no active password vault, safeStorage AVAILABLE
 *      → throw the "TSPV-stranded" error. This is the "user installed
 *      a keyring AFTER creating TSPV blobs" path: `maybeInitPasswordVault`
 *      short-circuits on startup because safeStorage is now available,
 *      so the cached password key is never derived. The stranded blobs
 *      cannot be decrypted without prompting for the old password —
 *      which we don't do today. The error tells the user exactly what
 *      to do: delete the old vault directory (and re-authenticate), or
 *      restore by transiently removing the keyring so the prompt fires.
 *      Telling them "encryption unavailable" here would be a lie — it
 *      IS available, but it can't decrypt blobs that weren't encrypted
 *      with it.
 *   3. `TSPV` blob + no active password vault, safeStorage UNAVAILABLE
 *      → throw the "no password cached" error. This is the normal
 *      "user closed the prompt without typing a password" path; the
 *      `encryptionUnavailableReason` suffix is accurate here.
 *   4. non-`TSPV` blob + safeStorage available → decrypt via safeStorage.
 *   5. non-`TSPV` blob + no safeStorage → throw the "keyring-lost"
 *      error (different per `VaultLabel`).
 *
 * Cases 2 and 3 must be distinguishable because they have different
 * recovery paths: case 2 = "delete or restore the keyring temporarily",
 * case 3 = "set up a keyring or restart the app to retry the prompt".
 */
export function decryptFromVault(blob: Buffer, label: VaultLabel): string {
  if (isPasswordVaultBlob(blob)) {
    if (!passwordVaultActive()) {
      if (safeStorage.isEncryptionAvailable()) {
        // Case 2: TSPV-stranded. User had no keyring when these were
        // written, gained one since, and the startup flow now skips the
        // password prompt. The keyring IS available — but it can't
        // decrypt blobs encrypted by the password vault.
        throw new Error(
          `${label.noun} blob is password-vault encrypted (TSPV format) but the password vault is not active in this session. ` +
            `The OS keyring is available, so the startup prompt was skipped — but these blobs were written when the keyring ` +
            `was unavailable and they need the original vault password to decrypt. ${label.recoveryDirectoryHint}`,
        );
      }
      // Case 3: user dismissed the prompt (or it never fired).
      throw new Error(
        `${label.noun} blob is password-encrypted but no password is cached. ${encryptionUnavailableReason()}`,
      );
    }
    return decryptWithPasswordKey(blob);
  }
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(blob);
  }
  // Case 5: safeStorage blob + keyring lost. We CANNOT migrate it to
  // password format on the fly because we can't decrypt it without the
  // keyring. Surface the actionable recovery instructions rather than
  // failing silently.
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
