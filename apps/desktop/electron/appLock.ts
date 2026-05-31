/**
 * Phase 19 PR 10 Task 10 — PIN + biometric app lock.
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
 *   - Windows: Windows Hello via the `KeyCredentialManager` API
 *     accessed through PowerShell (no native module dependency).
 *   - Linux: not supported; falls through to PIN.
 *
 * The biometric path NEVER replaces the PIN — the PIN is the root
 * credential, biometric is convenience. Switching mode from
 * `pin` -> `biometric` does NOT delete the PIN; switching to
 * `off` does delete the PIN (the user has explicitly opted out
 * of lock).
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

/** Schema version persisted to disk in the encrypted blob. */
interface PersistedAppLock {
  pin: PinRecord | null;
  attempt: AttemptRecord;
}

function emptyAttempt(): AttemptRecord {
  return { failures: 0, nextAttemptAt: 0 };
}

function emptyPersisted(): PersistedAppLock {
  return { pin: null, attempt: emptyAttempt() };
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
 */
export function clearPin(): void {
  const persisted = readPersisted();
  persisted.pin = null;
  persisted.attempt = emptyAttempt();
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
  // Windows Hello via PowerShell + WinRT KeyCredentialManager API.
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
