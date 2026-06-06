/**
 * PIN + biometric app lock.
 *
 * Threat model
 * ------------
 * Tessera holds arbitrarily-sensitive personal notes, source-of-
 * truth document drafts, and vendor API keys. A user who steps
 * away from an unlocked laptop should be able to relock Tessera
 * without quitting it, and the relock should resist trivial
 * shoulder-surfing / brute-force attacks.
 *
 * App lock is NOT a substitute for full-disk encryption or for
 * the OS account lock — both of those are out of scope. App lock
 * raises the bar for short-window casual access: you sit down at
 * the unlocked laptop, Tessera is locked, you can't read it
 * without the PIN (or a successful TouchID / Windows Hello
 * prompt).
 *
 * PIN cryptography
 * ----------------
 * PINs are short. To resist offline brute-force on someone who
 * exfiltrates `<userData>/app-lock.bin` (e.g. via a synced
 * backup, a forensic image), we:
 *
 *   - Stretch the PIN with scrypt (N=2^14, r=8, p=1). scrypt's
 *     memory-hardness makes a GPU farm unviable for short PINs.
 *   - Persist `{salt, params, hash}` not the PIN. The blob is
 *     wrapped with `vaultCrypto.encryptForVault` so the OS
 *     keychain (or the password-vault fallback) protects it at
 *     rest in addition to scrypt.
 *   - Apply exponential backoff after `APP_LOCK_LOCKOUT_THRESHOLD`
 *     consecutive failures: 30s -> 1m -> 2m -> 4m -> ... capped at
 *     1h. The counter persists across restarts so a "force-quit
 *     and retry" doesn't reset it.
 *
 * Biometric path
 * --------------
 * When `appLockMode === "biometric"` the unlock UI calls
 * `attemptBiometricUnlock()`, which delegates to:
 *   - macOS: `systemPreferences.promptTouchID` (TouchID).
 *   - Windows: Windows Hello via the `UserConsentVerifier` API
 *     (`Windows.Security.Credentials.UI` WinRT namespace) accessed
 *     through PowerShell (no native module dependency).
 *     `UserConsentVerifier.RequestVerificationAsync` is the
 *     correct API for a one-shot "prove user presence" prompt;
 *     `KeyCredentialManager` is a different WinRT surface for
 *     long-lived asymmetric credentials (FIDO-style), which is
 *     not what we want for an unlock challenge.
 *   - Linux: not supported; falls through to PIN.
 *
 * The biometric path NEVER replaces the PIN — the PIN is the root
 * credential, biometric is convenience. Switching mode from
 * `pin` -> `biometric` does NOT delete the PIN; switching to
 * `off` does delete the PIN (the user has explicitly opted out
 * of lock).
 *
 * FIDO2 / WebAuthn path
 * ---------------------
 * `appLockMode === "fido2"` lets the user unlock with a registered
 * FIDO2 authenticator (a platform authenticator like TouchID /
 * Windows Hello surfaced through WebAuthn, or a roaming security
 * key). Like biometric, it is a CONVENIENCE unlock layered on top
 * of the PIN root credential — registering a key does not delete
 * the PIN, and the renderer falls back to the PIN whenever the
 * authenticator is unavailable.
 *
 * The actual `navigator.credentials.{create,get}` calls happen in
 * the renderer (only Chromium exposes the WebAuthn API). This
 * module owns the trust-bearing half:
 *   - It mints single-use, expiring challenges (anti-replay).
 *   - On registration it records the credential ID + the SPKI
 *     public key the renderer extracted via
 *     `response.getPublicKey()` (so we never CBOR-decode the
 *     attestation object) + the COSE alg, and pins
 *     `rpIdHash = SHA-256(rpId)` itself rather than trusting the
 *     renderer.
 *   - On unlock it verifies the assertion signature over
 *     `authenticatorData || SHA-256(clientDataJSON)` against the
 *     stored public key, checks the rpIdHash + User-Present flag,
 *     and consumes the challenge.
 *
 * A FIDO2 verification failure never increments the PIN
 * brute-force counter (there is no low-entropy secret to guess —
 * forging an assertion means breaking the authenticator's
 * signature), but an *existing* PIN lockout is still honoured so
 * the FIDO2 channel cannot be used to side-step a backoff.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app, systemPreferences } from "electron";
import { spawnSync } from "child_process";

import {
  encryptForVault,
  decryptFromVault,
  type VaultLabel,
} from "./vaultCrypto";
import { getLogger } from "./logger";
import {
  APP_LOCK_BACKOFF_BASE_MS,
  APP_LOCK_BACKOFF_MAX_MS,
  APP_LOCK_LOCKOUT_THRESHOLD,
  APP_LOCK_PIN_MAX_LENGTH,
  APP_LOCK_PIN_MIN_LENGTH,
  FIDO2_SUPPORTED_ALGS,
  type Fido2AssertionInput,
  type Fido2AssertionOptions,
  type Fido2RegistrationInput,
  type Fido2RegistrationOptions,
} from "../shared/types";

/**
 * Vault label used when wrapping the on-disk app-lock blob. The
 * "noun" is rendered into the error messages produced by
 * `decryptFromVault` so the user sees "App lock" rather than the
 * generic "Vault" if their keyring becomes unavailable.
 */
const APP_LOCK_VAULT_LABEL: VaultLabel = {
  noun: "App lock",
  recoveryDirectoryImperative:
    "delete the app-lock blob (<userData>/app-lock.bin) to reset the lock — Tessera will boot unlocked and you can configure a new PIN from Settings.",
};

/**
 * scrypt parameters. N=2^14 (16384) is the OWASP-recommended
 * minimum that fits in the Node default 32 MiB cost ceiling. r=8
 * and p=1 are the Node defaults that maximise memory-hardness per
 * second of CPU. We store these alongside the hash so a future
 * parameter bump can verify against historical PINs without
 * breaking them.
 */
const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LEN = 64;
/**
 * scrypt requires `cost * 128 * blockSize * parallelization` <=
 * `maxmem`. Default Node maxmem is 32 MiB which is exactly at the
 * boundary for these parameters; bumping the param slot lets us
 * tune without touching the call site.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

interface PinRecord {
  /** Always 1 for the current schema. Bumped on future param changes. */
  version: 1;
  /** scrypt parameters at the time of writing (forward-compat). */
  scrypt: { N: number; r: number; p: number; keyLen: number };
  /** Per-PIN salt, base64. */
  salt: string;
  /** scrypt-derived hash, base64. */
  hash: string;
  /** Epoch milliseconds when the PIN was set. */
  createdAt: number;
}

interface AttemptRecord {
  /** Total consecutive failed unlock attempts since the last success. */
  failures: number;
  /** Epoch ms after which the next attempt is allowed. */
  nextAttemptAt: number;
}

/**
 * A registered FIDO2 / WebAuthn credential. We persist only the
 * public half — the private key never leaves the authenticator —
 * plus the metadata needed to verify a later assertion.
 */
interface Fido2Record {
  /** Always 1 for the current schema. */
  version: 1;
  /** base64url credential ID returned by the authenticator. */
  credentialId: string;
  /**
   * COSE algorithm identifier the credential signs with (e.g. `-7`
   * ES256). Constrained to {@link FIDO2_SUPPORTED_ALGS} at
   * registration so `verifyFido2Assertion` always knows the scheme.
   */
  alg: number;
  /**
   * DER-encoded SubjectPublicKeyInfo, base64. The renderer extracts
   * this from the `PublicKeyCredential` via `response.getPublicKey()`
   * so the main process never has to CBOR-decode the COSE key out of
   * the attestation object.
   */
  publicKeySpki: string;
  /**
   * `SHA-256(rpId)`, base64. Computed by the main process at
   * registration (NOT trusted from the renderer) and re-checked
   * against the first 32 bytes of `authenticatorData` on every
   * assertion.
   */
  rpIdHash: string;
  /** Epoch milliseconds when the credential was registered. */
  createdAt: number;
}

/** Schema version persisted to disk in the encrypted blob. */
interface PersistedAppLock {
  pin: PinRecord | null;
  attempt: AttemptRecord;
  /**
   * Registered FIDO2 credential, or `null` when none is set. Absent
   * in blobs written before the FIDO2 feature shipped; `readPersisted`
   * heals those to `null` so old installs keep loading.
   */
  fido2: Fido2Record | null;
}

function emptyAttempt(): AttemptRecord {
  return { failures: 0, nextAttemptAt: 0 };
}

function emptyPersisted(): PersistedAppLock {
  return { pin: null, attempt: emptyAttempt(), fido2: null };
}

/**
 * Resolve the on-disk blob path. Wrapped in a function so a test
 * can swap `app.getPath("userData")` via `_setAppLockPathForTests`
 * without monkey-patching the Electron module.
 */
let appLockPathOverride: (() => string) | null = null;

export function _setAppLockPathForTests(fn: (() => string) | null): void {
  appLockPathOverride = fn;
}

function blobPath(): string {
  if (appLockPathOverride) return appLockPathOverride();
  return path.join(app.getPath("userData"), "app-lock.bin");
}

function readPersisted(): PersistedAppLock {
  const fp = blobPath();
  let raw: Buffer;
  try {
    raw = fs.readFileSync(fp);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyPersisted();
    }
    getLogger().warn("app_lock.read_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return emptyPersisted();
  }
  let json: string;
  try {
    json = decryptFromVault(raw, APP_LOCK_VAULT_LABEL);
  } catch (err) {
    getLogger().warn("app_lock.decrypt_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return emptyPersisted();
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    // Heal blobs written before the FIDO2 field existed: a missing
    // `fido2` key is a valid old schema, normalised to `null` so the
    // rest of the module (and the validator) can treat `fido2` as
    // an always-present `Fido2Record | null`.
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !("fido2" in parsed)
    ) {
      (parsed as Record<string, unknown>).fido2 = null;
    }
    if (!isValidPersisted(parsed)) {
      return emptyPersisted();
    }
    return parsed;
  } catch (err) {
    getLogger().warn("app_lock.parse_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return emptyPersisted();
  }
}

function isValidPersisted(value: unknown): value is PersistedAppLock {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (!("pin" in v) || !("attempt" in v)) return false;
  const attempt = v.attempt as Record<string, unknown> | null;
  if (!attempt) return false;
  if (typeof attempt.failures !== "number") return false;
  if (typeof attempt.nextAttemptAt !== "number") return false;
  if (v.pin !== null) {
    const pin = v.pin as Record<string, unknown>;
    if (pin.version !== 1) return false;
    if (typeof pin.salt !== "string") return false;
    if (typeof pin.hash !== "string") return false;
    if (typeof pin.createdAt !== "number") return false;
    if (typeof pin.scrypt !== "object" || pin.scrypt === null) return false;
    // Validate the scrypt sub-fields too — `deriveHash` reads N/r/p/keyLen
    // back from this record during verification (forward-compat), so a
    // tampered blob with a missing or non-numeric `scrypt.N` must be
    // rejected before it reaches `crypto.scrypt` (which would throw a
    // hard-to-diagnose ERR_INVALID_ARG_TYPE).
    const sp = pin.scrypt as Record<string, unknown>;
    if (
      typeof sp.N !== "number" ||
      typeof sp.r !== "number" ||
      typeof sp.p !== "number" ||
      typeof sp.keyLen !== "number"
    ) {
      return false;
    }
  }
  if (!("fido2" in v)) return false;
  if (v.fido2 !== null) {
    const f = v.fido2 as Record<string, unknown>;
    if (f.version !== 1) return false;
    if (typeof f.credentialId !== "string") return false;
    if (typeof f.alg !== "number") return false;
    if (typeof f.publicKeySpki !== "string") return false;
    if (typeof f.rpIdHash !== "string") return false;
    if (typeof f.createdAt !== "number") return false;
  }
  return true;
}

function writePersisted(state: PersistedAppLock): void {
  const fp = blobPath();
  const json = JSON.stringify(state);
  const blob = encryptForVault(json);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // Write to a temp file and rename atomically so a crash mid-write
  // cannot leave a half-rewritten lock file (which would lock the
  // user out the next launch).
  const tmp = `${fp}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, blob, { mode: 0o600 });
  fs.renameSync(tmp, fp);
}

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
  keyLen: number;
}

/**
 * Current scrypt parameter set used when *setting* a fresh PIN.
 * Verification uses whatever set is recorded inside the stored
 * `PinRecord.scrypt` field, so historical PINs continue to verify
 * after a constants bump.
 */
const CURRENT_SCRYPT_PARAMS: ScryptParams = {
  N: SCRYPT_N,
  r: SCRYPT_R,
  p: SCRYPT_P,
  keyLen: SCRYPT_KEY_LEN,
};

/**
 * Compute the scrypt hash of `pin` with the given salt and scrypt
 * parameters. Async because scrypt is CPU-intensive (~50ms on a
 * typical laptop with N=2^14); blocking the event loop would
 * freeze the UI during the unlock prompt.
 *
 * The `params` argument is threaded explicitly (rather than read
 * from the module-level `SCRYPT_*` constants) so verification can
 * use the parameters recorded on the stored `PinRecord` and a
 * future constants bump (`SCRYPT_N = 1 << 16`, say) does not break
 * verification of PINs that were set under the old parameters.
 * `setPin` always derives with `CURRENT_SCRYPT_PARAMS`; verification
 * derives with `persisted.pin.scrypt`.
 */
function deriveHash(
  pin: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      pin,
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
      (err, derived) => {
        if (err) reject(err);
        else resolve(derived);
      },
    );
  });
}

/**
 * Public API: check whether a PIN is currently set.
 * Used by the renderer's Settings UI to decide whether to show
 * "Set up app lock" vs "Change PIN" / "Remove app lock".
 */
export function hasPinSet(): boolean {
  return readPersisted().pin !== null;
}

/**
 * Public API: store a fresh PIN. Validates length and character
 * class; rejects on policy violation. Synchronously replaces any
 * existing PIN (the user must already have unlocked with the old
 * one — the unlock IPC handler enforces that).
 */
export async function setPin(pin: string): Promise<void> {
  validatePinPolicy(pin);
  const salt = crypto.randomBytes(32);
  const hash = await deriveHash(pin, salt, CURRENT_SCRYPT_PARAMS);
  const persisted = readPersisted();
  persisted.pin = {
    version: 1,
    // Snapshot the current scrypt params alongside the hash.
    // `attemptUnlock` reads these back on verify so a future
    // constants bump (e.g. `SCRYPT_N = 1 << 16`) does not
    // invalidate the PINs of users on the prior parameter set —
    // they keep working until the user changes their PIN, at
    // which point this snapshot gets refreshed to the new
    // `CURRENT_SCRYPT_PARAMS`.
    scrypt: { ...CURRENT_SCRYPT_PARAMS },
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    createdAt: Date.now(),
  };
  // Setting a new PIN clears the attempt counter. The new PIN
  // hasn't been "used" yet so the previous failure history is
  // moot.
  persisted.attempt = emptyAttempt();
  writePersisted(persisted);
  getLogger().info("app_lock.pin_set");
}

/**
 * Public API: clear the PIN entirely. Called when the user
 * switches `appLockMode` to `"off"`. Caller is responsible for
 * having already authenticated (the IPC handler enforces that).
 *
 * Also drops any registered FIDO2 credential: the PIN is the root
 * credential and FIDO2 is a convenience layer on top of it, so
 * removing the root must not leave an orphaned authenticator that
 * could unlock an app the user believes is lock-free. "off" means
 * zero retained credentials.
 */
export function clearPin(): void {
  const persisted = readPersisted();
  persisted.pin = null;
  persisted.attempt = emptyAttempt();
  persisted.fido2 = null;
  writePersisted(persisted);
  getLogger().info("app_lock.pin_cleared");
}

/**
 * Result of `attemptUnlock`.
 *
 * - `success`: PIN matched. The renderer should dismiss the lock
 *   overlay and reset its in-memory locked state.
 * - `failure`: PIN did not match. The `failures` field is the
 *   updated cumulative failure count; the renderer should display
 *   "PIN incorrect (n/5 attempts before lockout)" until the
 *   threshold is reached, then show the backoff message.
 * - `locked_out`: too many failures; the user must wait until
 *   `nextAttemptAt`. The renderer disables the PIN input until
 *   then and shows a countdown.
 * - `no_pin_set`: edge case — `appLockMode === "pin"` but no PIN
 *   stored. The renderer should redirect the user to set one up.
 */
export type UnlockResult =
  | { kind: "success" }
  | { kind: "failure"; failures: number }
  | { kind: "locked_out"; nextAttemptAt: number }
  | { kind: "no_pin_set" };

/**
 * Public API: validate a PIN attempt against the stored hash.
 * Updates the attempt counter on failure and resets it on success.
 *
 * Constant-time compare guards against PIN-equality timing
 * attacks; scrypt's own variability makes the user-visible time
 * already noisy, but `timingSafeEqual` ensures the inner compare
 * cannot leak.
 */
export async function attemptUnlock(pin: string): Promise<UnlockResult> {
  const persisted = readPersisted();
  if (persisted.pin === null) {
    return { kind: "no_pin_set" };
  }
  const now = Date.now();
  if (persisted.attempt.nextAttemptAt > now) {
    return {
      kind: "locked_out",
      nextAttemptAt: persisted.attempt.nextAttemptAt,
    };
  }

  const salt = Buffer.from(persisted.pin.salt, "base64");
  const expected = Buffer.from(persisted.pin.hash, "base64");
  let derived: Buffer;
  try {
    // Derive against the params recorded on the *stored* PinRecord
    // (not the module-level `SCRYPT_*` constants). This is the
    // forward-compatibility hook the schema reserves: bumping
    // `SCRYPT_N` will not invalidate PINs that were written under
    // the previous N — they re-verify against the snapshot below
    // until the user resets their PIN.
    derived = await deriveHash(pin, salt, persisted.pin.scrypt);
  } catch (err) {
    getLogger().warn("app_lock.derive_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { kind: "failure", failures: persisted.attempt.failures };
  }

  let matches = false;
  if (derived.length === expected.length) {
    matches = crypto.timingSafeEqual(derived, expected);
  }

  if (matches) {
    persisted.attempt = emptyAttempt();
    writePersisted(persisted);
    return { kind: "success" };
  }

  persisted.attempt.failures += 1;
  if (persisted.attempt.failures >= APP_LOCK_LOCKOUT_THRESHOLD) {
    const extraFails =
      persisted.attempt.failures - APP_LOCK_LOCKOUT_THRESHOLD;
    const backoff = Math.min(
      APP_LOCK_BACKOFF_BASE_MS * Math.pow(2, extraFails),
      APP_LOCK_BACKOFF_MAX_MS,
    );
    persisted.attempt.nextAttemptAt = now + backoff;
  }
  writePersisted(persisted);
  if (persisted.attempt.nextAttemptAt > now) {
    return {
      kind: "locked_out",
      nextAttemptAt: persisted.attempt.nextAttemptAt,
    };
  }
  return { kind: "failure", failures: persisted.attempt.failures };
}

/**
 * Validate PIN policy before storing. Throws a user-friendly error
 * on violation so the renderer can surface it directly.
 *
 * Policy: between APP_LOCK_PIN_MIN_LENGTH and
 * APP_LOCK_PIN_MAX_LENGTH characters, must contain at least one
 * letter AND one digit (so "111111" is rejected; "abc123" is
 * accepted). This is intentionally permissive — we want users to
 * pick a memorable secret without burning out on policy theater.
 *
 * The minimum length is set in `shared/types.ts` so the renderer
 * and main process agree on the policy boundary.
 */
export function validatePinPolicy(pin: string): void {
  if (typeof pin !== "string") {
    throw new Error("PIN must be a string");
  }
  if (pin.length < APP_LOCK_PIN_MIN_LENGTH) {
    throw new Error(
      `PIN must be at least ${APP_LOCK_PIN_MIN_LENGTH} characters`,
    );
  }
  if (pin.length > APP_LOCK_PIN_MAX_LENGTH) {
    throw new Error(
      `PIN must be at most ${APP_LOCK_PIN_MAX_LENGTH} characters`,
    );
  }
  if (!/[A-Za-z]/.test(pin) || !/[0-9]/.test(pin)) {
    throw new Error("PIN must contain at least one letter and one digit");
  }
}

/**
 * Biometric-unlock dispatch. Returns `true` on a successful
 * biometric verification, `false` otherwise (user cancelled,
 * failed match, biometrics unavailable). The caller MUST fall
 * back to PIN on `false` — biometrics is convenience, not the
 * root credential.
 */
export async function attemptBiometricUnlock(
  reason: string = "Unlock Tessera",
): Promise<boolean> {
  if (process.platform === "darwin") {
    return attemptTouchIdUnlock(reason);
  }
  if (process.platform === "win32") {
    return attemptWindowsHelloUnlock(reason);
  }
  // Linux has no portable biometric API across distros (fprintd is
  // the closest but is not installed by default). Fall back to PIN
  // by returning false; the renderer's mode-resolver already does
  // this correctly.
  return false;
}

async function attemptTouchIdUnlock(reason: string): Promise<boolean> {
  try {
    if (!systemPreferences.canPromptTouchID()) {
      return false;
    }
    await systemPreferences.promptTouchID(reason);
    return true;
  } catch (err) {
    getLogger().info("app_lock.touchid_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Maximum length of the biometric prompt's reason string. PowerShell's
 * command-line tail is bounded by Windows' `CreateProcess` 32 KiB cap
 * minus the rest of the argv we pass; clamping the renderer-controlled
 * portion to 256 chars keeps a compromised renderer from forcing a
 * `ENAMETOOLONG`-class spawn failure with a multi-MB string. The
 * prompt itself only shows ~120 chars in the Windows Hello dialog, so
 * 256 is more than enough headroom for a localised one-liner.
 */
const WINDOWS_HELLO_REASON_MAX_LEN = 256;

async function attemptWindowsHelloUnlock(reason: string): Promise<boolean> {
  // Windows Hello via PowerShell + WinRT UserConsentVerifier API
  // (Windows.Security.Credentials.UI.UserConsentVerifier).
  // RequestVerificationAsync raises the Hello prompt, returns 0
  // on Verified, anything else (DeviceBusy / DeviceNotPresent /
  // DisabledByPolicy / NotConfiguredForUser / RetriesExhausted /
  // Canceled) is treated as a failed attempt and falls back to
  // the PIN path.
  // Synchronous spawn is acceptable here because biometric prompts
  // are inherently blocking (the user must respond), and we do not
  // want to ship a native module dependency just for this path.
  //
  // The script returns exit code 0 on success, 1 on user cancel /
  // mismatch / API unavailable. We never write the reason string
  // to disk; it goes via stdin as a single-line argument.
  //
  // Defense-in-depth: clamp the renderer-provided `reason` to a
  // sane max length. The argv-positional pattern (`$args[0]`) is
  // already safe from code injection because PowerShell does not
  // re-parse positional args as script — but a multi-MB string
  // could blow `CreateProcess`'s 32 KiB argv ceiling and crash the
  // spawn before the user ever sees the prompt. Clamp here so a
  // compromised renderer can't DoS the biometric path.
  const safeReason =
    reason.length > WINDOWS_HELLO_REASON_MAX_LEN
      ? reason.slice(0, WINDOWS_HELLO_REASON_MAX_LEN)
      : reason;
  const psCommand = [
    "[Windows.Security.Credentials.UI.UserConsentVerifier, ",
    "Windows.Security.Credentials.UI, ",
    "ContentType = WindowsRuntime] | Out-Null;",
    "$op = ",
    "[Windows.Security.Credentials.UI.UserConsentVerifier]::",
    "RequestVerificationAsync($args[0]);",
    "$result = $op.GetResults();",
    "if ($result -eq 0) { exit 0 } else { exit 1 }",
  ].join("");
  try {
    const child = spawnSync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      psCommand,
      safeReason,
    ]);
    return child.status === 0;
  } catch (err) {
    getLogger().info("app_lock.windows_hello_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// --- FIDO2 / WebAuthn ----------------------------------------------

/**
 * Relying-Party identity for the FIDO2 credential. `FIDO2_RP_ID`
 * must be a registrable domain the renderer's WebAuthn origin is a
 * suffix of; Tessera serves its renderer from the fixed
 * `app.tessera.local` virtual origin, so the authenticator scopes
 * the credential to that. The main process pins
 * `SHA-256(FIDO2_RP_ID)` into the stored record and re-checks it on
 * every assertion, so a credential minted for a different RP can
 * never be replayed to unlock Tessera.
 */
const FIDO2_RP_ID = "app.tessera.local";
const FIDO2_RP_NAME = "Tessera";

/**
 * Challenge lifetime. A WebAuthn ceremony is interactive (the user
 * taps a key / approves a prompt) so 2 minutes is comfortably long
 * for a human while still bounding the replay window of a leaked
 * challenge.
 */
const FIDO2_CHALLENGE_TTL_MS = 2 * 60 * 1000;
const FIDO2_TIMEOUT_MS = 60 * 1000;

/** WebAuthn User-Present flag (bit 0 of the authenticatorData flags byte). */
const FIDO2_FLAG_USER_PRESENT = 0x01;

/**
 * Pending, single-use challenges keyed by their base64url value,
 * mapped to their expiry epoch-ms. A challenge is consumed (removed)
 * the first time it is presented for verification, so a captured
 * `clientDataJSON` cannot be replayed. Kept in process memory only —
 * a challenge that does not survive a restart simply forces the
 * renderer to request a fresh one, which is the correct behaviour.
 */
const pendingFido2Challenges = new Map<string, number>();

/**
 * Hard cap on the number of concurrently-pending challenges. The
 * option endpoints that mint challenges are intentionally NOT
 * rate-limited (they feed an interactive ceremony), and TTL eviction
 * only fires when the *next* challenge is issued — so a compromised
 * renderer spinning the option channels could otherwise grow this map
 * without bound within a single TTL window. A single local user only
 * ever has one ceremony in flight, so a cap this large is orders of
 * magnitude above any legitimate use; on overflow we drop the oldest
 * (insertion-ordered) entries first, which at worst forces an
 * abandoned ceremony to request a fresh challenge.
 */
const FIDO2_MAX_PENDING_CHALLENGES = 256;

/** base64url-encode without padding (WebAuthn wire format). */
function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decode a base64url (or base64) string to a Buffer. */
function base64UrlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function rpIdHashB64(): string {
  return crypto.createHash("sha256").update(FIDO2_RP_ID).digest("base64");
}

/**
 * Mint a fresh single-use challenge, register it with its expiry,
 * and opportunistically evict any expired entries so the map cannot
 * grow without bound if a renderer requests challenges it never
 * completes.
 */
function issueChallenge(now: number = Date.now()): string {
  for (const [key, expiry] of pendingFido2Challenges) {
    if (expiry <= now) pendingFido2Challenges.delete(key);
  }
  // Bound the map even when nothing has expired yet: evict oldest
  // first (Map iterates in insertion order) until there is room for
  // the new entry. Guards against a renderer hammering the
  // un-rate-limited option channels inside a single TTL window.
  while (pendingFido2Challenges.size >= FIDO2_MAX_PENDING_CHALLENGES) {
    const oldest = pendingFido2Challenges.keys().next().value;
    if (oldest === undefined) break;
    pendingFido2Challenges.delete(oldest);
  }
  const challenge = base64UrlEncode(crypto.randomBytes(32));
  pendingFido2Challenges.set(challenge, now + FIDO2_CHALLENGE_TTL_MS);
  return challenge;
}

/**
 * Validate that `challenge` was issued by us, is unexpired, and has
 * not been used before — then consume it (single-use). Returns
 * `true` on success.
 */
function consumeChallenge(challenge: string, now: number = Date.now()): boolean {
  const expiry = pendingFido2Challenges.get(challenge);
  if (expiry === undefined) return false;
  pendingFido2Challenges.delete(challenge);
  return expiry > now;
}

/** Public API: whether a FIDO2 credential is currently registered. */
export function hasFido2Set(): boolean {
  return readPersisted().fido2 !== null;
}

/**
 * Public API: build the options the renderer passes to
 * `navigator.credentials.create()`. The returned `challenge` is
 * single-use and expires after {@link FIDO2_CHALLENGE_TTL_MS}.
 */
export function getFido2RegistrationOptions(): Fido2RegistrationOptions {
  return {
    challenge: issueChallenge(),
    rpId: FIDO2_RP_ID,
    rpName: FIDO2_RP_NAME,
    // Stable per-install user handle. The value is opaque to the
    // authenticator; we use a fixed label because Tessera has a
    // single local user per install.
    userId: base64UrlEncode(Buffer.from("tessera-local-user")),
    userName: "tessera",
    userDisplayName: "Tessera user",
    pubKeyCredParams: [...FIDO2_SUPPORTED_ALGS],
    timeoutMs: FIDO2_TIMEOUT_MS,
  };
}

/**
 * Decode `clientDataJSON` and assert it is a well-formed WebAuthn
 * client-data object of the expected ceremony `type` whose
 * `challenge` we issued (and have not seen before). Returns the
 * parsed object on success, or `null` on any validation failure.
 */
function verifyClientData(
  clientDataJsonB64: string,
  expectedType: "webauthn.create" | "webauthn.get",
  now: number = Date.now(),
): { type: string; challenge: string; origin?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(clientDataJsonB64).toString("utf-8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const cd = parsed as Record<string, unknown>;
  if (cd.type !== expectedType) return null;
  if (typeof cd.challenge !== "string") return null;
  // The challenge in clientDataJSON is base64url of the bytes we
  // issued; our issued value is already base64url, so compare
  // directly after consuming it (single-use, unexpired).
  if (!consumeChallenge(cd.challenge, now)) return null;
  return {
    type: expectedType,
    challenge: cd.challenge,
    origin: typeof cd.origin === "string" ? cd.origin : undefined,
  };
}

/**
 * Public API: persist a freshly-created FIDO2 credential. Throws on
 * any validation failure so the renderer surfaces the error to the
 * user. Requires a PIN to already be set — FIDO2 is a convenience
 * layer over the PIN root credential, never a replacement.
 */
export function registerFido2(
  input: Fido2RegistrationInput,
  now: number = Date.now(),
): void {
  const persisted = readPersisted();
  if (persisted.pin === null) {
    throw new Error(
      "Set a PIN before registering a security key — FIDO2 is a convenience unlock layered on the PIN.",
    );
  }
  if (
    typeof input.credentialId !== "string" ||
    input.credentialId.length === 0
  ) {
    throw new Error("FIDO2 registration: missing credential ID");
  }
  if (!(FIDO2_SUPPORTED_ALGS as readonly number[]).includes(input.alg)) {
    throw new Error(
      `FIDO2 registration: unsupported algorithm ${input.alg} (supported: ${FIDO2_SUPPORTED_ALGS.join(", ")})`,
    );
  }
  if (verifyClientData(input.clientDataJson, "webauthn.create", now) === null) {
    throw new Error(
      "FIDO2 registration: client data failed validation (bad/expired challenge or wrong ceremony type)",
    );
  }
  // Parse the SPKI key to reject a malformed public key at
  // registration rather than at first-unlock (when the user is
  // locked out). `createPublicKey` throws on garbage.
  const spki = base64UrlDecode(input.publicKeySpki);
  try {
    crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
  } catch (err) {
    throw new Error(
      `FIDO2 registration: invalid SPKI public key: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  // Registering over an existing credential silently supersedes it
  // (the user is intentionally swapping security keys). Emit a
  // distinct event in that case so the audit trail records a swap
  // rather than a first-time registration — useful when reconstructing
  // who/what changed the unlock factor.
  const replacing = persisted.fido2 !== null;
  persisted.fido2 = {
    version: 1,
    credentialId: input.credentialId,
    alg: input.alg,
    publicKeySpki: spki.toString("base64"),
    rpIdHash: rpIdHashB64(),
    createdAt: now,
  };
  writePersisted(persisted);
  getLogger().info(
    replacing ? "app_lock.fido2_replaced" : "app_lock.fido2_registered",
    { alg: input.alg },
  );
}

/**
 * Public API: build the options the renderer passes to
 * `navigator.credentials.get()`. Returns `null` when no credential
 * is registered (the renderer should fall back to the PIN prompt).
 */
export function getFido2AssertionOptions(): Fido2AssertionOptions | null {
  const persisted = readPersisted();
  if (persisted.fido2 === null) return null;
  return {
    challenge: issueChallenge(),
    rpId: FIDO2_RP_ID,
    allowCredentialIds: [persisted.fido2.credentialId],
    timeoutMs: FIDO2_TIMEOUT_MS,
  };
}

/**
 * Verify a WebAuthn assertion signature over
 * `authenticatorData || SHA-256(clientDataJSON)` using the stored
 * public key. Returns `true` only when the signature is valid for
 * the credential's COSE algorithm.
 */
function verifyAssertionSignature(
  record: Fido2Record,
  authenticatorData: Buffer,
  clientDataJsonB64: string,
  signature: Buffer,
): boolean {
  const clientDataHash = crypto
    .createHash("sha256")
    .update(base64UrlDecode(clientDataJsonB64))
    .digest();
  const signedData = Buffer.concat([authenticatorData, clientDataHash]);
  try {
    // `createPublicKey` is inside the try: the SPKI is validated at
    // registration, but a stored key corrupted afterwards (e.g. blob
    // damage) must surface as a clean verification `failure`, not an
    // uncaught throw that propagates out of `verifyFido2Assertion`.
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(record.publicKeySpki, "base64"),
      format: "der",
      type: "spki",
    });
    switch (record.alg) {
      case -7: // ES256: ECDSA P-256 + SHA-256 (DER-encoded signature).
      case -257: // RS256: RSA PKCS#1 v1.5 + SHA-256.
        return crypto.verify("sha256", signedData, publicKey, signature);
      case -8: // EdDSA (Ed25519): pre-hash-free, digest algorithm is null.
        return crypto.verify(null, signedData, publicKey, signature);
      default:
        return false;
    }
  } catch (err) {
    getLogger().warn("app_lock.fido2_verify_error", {
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Public API: verify a FIDO2 assertion and, on success, unlock the
 * app. Mirrors the `UnlockResult` contract of {@link attemptUnlock}:
 *
 *   - `no_pin_set` if no FIDO2 credential is registered (the
 *     renderer should fall back to the PIN prompt).
 *   - `locked_out` if a PIN backoff window is currently active —
 *     the FIDO2 channel does NOT let the user bypass a PIN lockout.
 *   - `failure` on any validation/signature failure. Unlike the PIN
 *     path this does NOT advance the brute-force counter: an
 *     assertion is a public-key signature, not a guessable secret,
 *     so repeated FIDO2 failures (a flaky key, a wrong device) must
 *     not escalate the PIN backoff and lock the user out of their
 *     fallback.
 *   - `success` resets the attempt counter, exactly like a correct
 *     PIN.
 */
export function verifyFido2Assertion(
  input: Fido2AssertionInput,
  now: number = Date.now(),
): UnlockResult {
  const persisted = readPersisted();
  if (persisted.fido2 === null) {
    return { kind: "no_pin_set" };
  }
  if (persisted.attempt.nextAttemptAt > now) {
    return { kind: "locked_out", nextAttemptAt: persisted.attempt.nextAttemptAt };
  }

  const record = persisted.fido2;
  const fail = (): UnlockResult => ({
    kind: "failure",
    failures: persisted.attempt.failures,
  });

  if (input.credentialId !== record.credentialId) return fail();

  // clientData must be a `webauthn.get` whose challenge we issued
  // and have not consumed. This is the anti-replay gate, so it runs
  // before the (more expensive) signature check.
  if (verifyClientData(input.clientDataJson, "webauthn.get", now) === null) {
    return fail();
  }

  let authData: Buffer;
  let signature: Buffer;
  try {
    authData = base64UrlDecode(input.authenticatorData);
    signature = base64UrlDecode(input.signature);
  } catch {
    return fail();
  }
  // authenticatorData layout: rpIdHash (32) || flags (1) || counter (4) || ...
  if (authData.length < 37) return fail();
  if (!authData.subarray(0, 32).equals(Buffer.from(record.rpIdHash, "base64"))) {
    return fail();
  }
  if ((authData[32] & FIDO2_FLAG_USER_PRESENT) === 0) {
    // The authenticator did not assert user presence — reject.
    return fail();
  }

  if (
    !verifyAssertionSignature(record, authData, input.clientDataJson, signature)
  ) {
    return fail();
  }

  persisted.attempt = emptyAttempt();
  writePersisted(persisted);
  // The `app_lock.fido2_unlock_success` audit event is emitted by the
  // `appLock:verifyFido2` IPC handler, mirroring how `attemptUnlock`
  // leaves `app_lock.unlock_success` to its handler. Logging it here
  // too would double-count every FIDO2 unlock in the audit trail.
  return { kind: "success" };
}

/**
 * Public API: remove the registered FIDO2 credential. Caller
 * (the IPC handler) is responsible for having verified the PIN
 * first. The PIN itself is untouched — the user is dropping the
 * convenience authenticator, not the lock.
 */
export function clearFido2(): void {
  const persisted = readPersisted();
  persisted.fido2 = null;
  writePersisted(persisted);
  getLogger().info("app_lock.fido2_cleared");
}

/** Test-only: drop all pending FIDO2 challenges from process memory. */
export function _resetFido2ChallengesForTests(): void {
  pendingFido2Challenges.clear();
}

/**
 * Test-only: set a PIN derived against an explicit scrypt parameter
 * set, then snapshot those parameters into the persisted record.
 * This lets the forward-compat regression test simulate a future
 * constants bump: write a PIN under "old" params, then verify
 * `attemptUnlock` re-derives with those old params (read from the
 * stored record) rather than the module-level current constants.
 *
 * Not exported through any IPC handler and not exposed to the
 * renderer — strictly for the unit-test harness in
 * `electron/__tests__/appLock.test.ts`.
 */
export async function _setPinWithCustomScryptForTests(
  pin: string,
  params: ScryptParams,
): Promise<void> {
  validatePinPolicy(pin);
  const salt = crypto.randomBytes(32);
  const hash = await deriveHash(pin, salt, params);
  const persisted = readPersisted();
  persisted.pin = {
    version: 1,
    scrypt: { ...params },
    salt: salt.toString("base64"),
    hash: hash.toString("base64"),
    createdAt: Date.now(),
  };
  persisted.attempt = emptyAttempt();
  writePersisted(persisted);
}

/**
 * Test-only: reset the in-memory attempt counter. Does NOT touch
 * on-disk state; tests must use a tempdir + `_setAppLockPathForTests`
 * for isolation.
 */
export function _resetAttemptCounterForTests(): void {
  const persisted = readPersisted();
  persisted.attempt = emptyAttempt();
  writePersisted(persisted);
}
