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
 * Platform-specific imperative for restoring keyring access. Returns ONLY
 * the "how to fix" instruction — does NOT include the "Encryption not
 * available — ..." diagnosis preamble.
 *
 * Use this when the caller has already established the keyring is
 * unavailable (e.g. by saying "the keyring is no longer available" in
 * the surrounding message) and wants to avoid the redundant
 * "Encryption not available" repetition.
 *
 * On Linux this commonly means the user is on a minimal or headless desktop
 * with no Secret Service-compatible daemon running (e.g. `gnome-keyring` /
 * `kwallet5-daemon`) — Electron's safeStorage falls back to `basic_text` only
 * when one of those is detected, and refuses to fall back to plaintext.
 *
 * On macOS this would mean Keychain is locked or sandboxed away (very rare);
 * on Windows it would mean DPAPI is unavailable (also very rare).
 */
export function keyringRecoveryInstructions(): string {
  switch (process.platform) {
    case "linux":
      return (
        "Install and start one of: gnome-keyring-daemon (GNOME / Ubuntu), " +
        "kwallet5-daemon (KDE), or pass an X session manager that exposes the " +
        "Secret Service D-Bus API. The Debian/Ubuntu packages are " +
        "`gnome-keyring` and `libsecret-1-0`."
      );
    case "darwin":
      return "Unlock the Keychain via Keychain Access.app and re-launch Tessera.";
    case "win32":
      return "Verify DPAPI is enabled for this user account and re-launch Tessera.";
    default:
      return "Run Tessera on Linux (with Secret Service), macOS, or Windows.";
  }
}

/**
 * The diagnosis half — "Encryption not available — <reason>." — without
 * the recovery imperative. Used internally by
 * `keyringUnavailableSentence()`; exported in case a caller wants to
 * render diagnosis + custom recovery hint separately.
 */
export function keyringDiagnosis(): string {
  switch (process.platform) {
    case "linux":
      return "Encryption not available — no OS keyring daemon detected.";
    case "darwin":
      return "Encryption not available — Keychain is locked or inaccessible.";
    case "win32":
      return "Encryption not available — Windows DPAPI is unavailable.";
    default:
      return "Encryption not available — unsupported platform.";
  }
}

/**
 * Platform-specific full sentence explaining WHY the OS keyring is
 * unavailable AND how to re-enable it. Composes
 * `keyringDiagnosis()` + ` ` + `keyringRecoveryInstructions()`.
 *
 * Does NOT mention the password-vault fallback — callers that want
 * to surface that recovery route should append
 * `PASSWORD_VAULT_RECOVERY_HINT` themselves (or use
 * `encryptionUnavailableReason()` which composes both).
 *
 * Use this for self-contained error messages that need to surface
 * both the diagnosis and the actionable next step (e.g. `loadDbKey`,
 * `encryptForVault`, `decryptFromVault` Case 3). For messages that
 * already establish the keyring is unavailable (e.g. Case 5) use
 * `keyringRecoveryInstructions()` directly to avoid restating the
 * diagnosis.
 */
export function keyringUnavailableSentence(): string {
  return `${keyringDiagnosis()} ${keyringRecoveryInstructions()}`;
}

/**
 * The "restart and enter a vault password" recovery hint. Appended to
 * the no-keyring-available message when the password vault IS a valid
 * recovery route — i.e. for fresh writes (`encryptForVault`) or when
 * decrypting an existing TSPV blob (`decryptFromVault` cases 2 / 3).
 *
 * Importantly: do NOT append this when surfacing a Case-5 error
 * (existing safeStorage blob + lost keyring). The password vault
 * cannot decrypt safeStorage-encrypted blobs because the derivation
 * keys are different — telling the user to "restart and enter a vault
 * password" sends them on a recovery path that won't work.
 *
 * Phrasing rationale: the prior version of this sentence opened with
 * "If you cannot install a keyring daemon" — Linux-specific wording
 * that did not apply on macOS (Keychain) or Windows (DPAPI), where
 * "keyring" is not the user-facing term and "install a daemon" maps
 * to no real action. The current phrasing is platform-neutral —
 * "OS-level secure storage" covers Keychain / DPAPI / Secret Service
 * uniformly, and the recovery action ("restart Tessera and enter a
 * vault password") IS the same on every platform. The
 * `keyringDiagnosis()` paragraph that runs immediately before this
 * hint already names the specific OS-level service when one is known
 * (e.g. "gnome-keyring / kwallet5 on Linux"), so the hint itself
 * doesn't need to repeat the diagnosis — it focuses on the recovery
 * action a user can take regardless of platform.
 */
export const PASSWORD_VAULT_RECOVERY_HINT =
  "If OS-level secure storage cannot be restored, restart Tessera " +
  "and enter a vault password when prompted — the app will derive " +
  "an encryption key from your password and use it in place of the " +
  "OS-managed key.";

/**
 * Build a human-readable error explaining why the OS keyring is unavailable
 * AND that the user can fall back to a password vault.
 *
 * Use this for NEW writes (`encryptForVault`) and for decryption of
 * existing TSPV (password-vault) blobs where the password fallback IS
 * a valid recovery route.
 *
 * For decryption of safeStorage blobs after the keyring is lost (Case
 * 5 in `decryptFromVault`), call `keyringUnavailableSentence()`
 * directly and OMIT this hint — see the function-level doc on
 * `keyringUnavailableSentence` for why.
 *
 * Recovery routes the message surfaces:
 *
 *   1. **Install a keyring daemon** — the "preferred" recovery, since
 *      the OS keyring is the most ergonomic UX. Mentioned first on
 *      Linux; not applicable on macOS/Windows (their native keystores
 *      are always present unless the OS itself is misconfigured).
 *   2. **Restart and enter a vault password** — every platform supports
 *      this fallback. After WS10 the app prompts for a password on
 *      startup when safeStorage is unavailable; the password-derived
 *      key unlocks the same encrypt/decrypt operations safeStorage
 *      would have done. If the user dismissed the prompt this session,
 *      restarting gives them another shot.
 */
export function encryptionUnavailableReason(): string {
  return `${keyringUnavailableSentence()} ${PASSWORD_VAULT_RECOVERY_HINT}`;
}

/**
 * Per-vault wording used to make error messages name-appropriate for
 * the caller's domain. `noun` is shown verbatim in error messages;
 * `recoveryDirectoryImperative` is appended after a connector word
 * like "Alternatively, " so the caller controls the sentence flow.
 */
export interface VaultLabel {
  /** "Vault" | "Secret" — the human-readable noun for blobs from this caller. */
  noun: string;
  /**
   * Verb-first, lowercase imperative for the "start over" recovery path.
   * Must begin with a lowercase verb so callers can prefix a sentence
   * connector ("Alternatively, " / "To start over, " / etc.) without
   * doubled words or capital-letter-mid-sentence artefacts.
   *
   * tokenVault: "delete the vault directory to re-authenticate from
   *   scratch (you will need to re-enter API keys and re-authorize
   *   OAuth providers)."
   * secretsVault: "delete the secret-vault directory to re-enter API keys."
   */
  recoveryDirectoryImperative: string;
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
            `was unavailable and they need the original vault password to decrypt. ` +
            `To start over, ${label.recoveryDirectoryImperative}`,
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
  //
  // CRITICAL: do NOT append `PASSWORD_VAULT_RECOVERY_HINT` here. The
  // existing blob is safeStorage-encrypted; the password vault uses a
  // PBKDF2-derived AES-256-GCM key, not safeStorage's OS-managed key.
  // Restarting + entering a vault password will NOT decrypt this blob.
  // The two valid recoveries are (a) restore keyring access
  // (`keyringRecoveryInstructions` tells the user how) or (b)
  // `label.recoveryDirectoryImperative` (the "start over" path).
  //
  // Use `keyringRecoveryInstructions()` (the imperative half), NOT the
  // full `keyringUnavailableSentence()` — the surrounding message
  // already establishes "the keyring is no longer available", so
  // appending the redundant "Encryption not available — no OS keyring
  // daemon detected." preamble in a parenthetical (which itself contains
  // nested parens like `(GNOME / Ubuntu)`) reads awkwardly.
  throw new Error(
    `${label.noun} file is encrypted with the OS keyring but the keyring is no longer available. ` +
      `To restore keyring access: ${keyringRecoveryInstructions()} ` +
      `Alternatively, ${label.recoveryDirectoryImperative}`,
  );
}

/**
 * Pre-built labels for the two existing callers. Exporting these so
 * each caller doesn't have to keep the literal wording in sync.
 */
export const TOKEN_VAULT_LABEL: VaultLabel = {
  noun: "Vault",
  recoveryDirectoryImperative:
    "delete the vault directory to re-authenticate from scratch (you will need to re-enter API keys and re-authorize OAuth providers).",
};

export const SECRETS_VAULT_LABEL: VaultLabel = {
  noun: "Secret",
  recoveryDirectoryImperative:
    "delete the secret-vault directory to re-enter API keys.",
};
