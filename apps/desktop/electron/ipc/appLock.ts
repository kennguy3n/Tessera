/**
 * IPC handlers for the PIN / biometric
 * app-lock surface. See `electron/appLock.ts` for the underlying
 * cryptography and policy.
 *
 * Channels:
 *   - `appLock:getStatus`       -> { hasPinSet, mode }
 *   - `appLock:setPin`          (pin: string)
 *   - `appLock:changePin`       (oldPin: string, newPin: string)
 *   - `appLock:removePin`       (pin: string)
 *   - `appLock:attemptUnlock`   (pin: string) -> UnlockResult
 *   - `appLock:attemptBiometric` (reason: string) -> { success: boolean }
 *
 * Rate-limit: ALL six channels are throttled to 1 / 250ms per
 * process. The exponential-backoff lockout in `appLock.ts` is the
 * load-bearing defence against brute force, but every channel that
 * calls into the scrypt KDF (setPin / changePin / removePin /
 * attemptUnlock) or the platform biometric prompt
 * (attemptBiometric) also enforces a hard requests-per-second cap
 * so a renderer compromised into a tight loop cannot:
 *   - chew CPU on scrypt derivations between failed attempts,
 *   - spam TouchID / Windows Hello prompts at IPC throughput,
 *   - bypass the lockout backoff by picking the cheaper code path
 *     (e.g. `setPin` short-circuits before scrypt if a PIN exists,
 *     but the rate limit still applies so the channel itself
 *     cannot be used as an oracle).
 * `appLock:getStatus` is a cheap read with no crypto on the hot
 * path, so it is intentionally NOT rate-limited — it's polled by
 * the renderer on app boot and on every settings-page mount.
 */
import { idempotentHandle } from "./register";
import { loadConfig, updateConfig } from "../config";
import {
  attemptBiometricUnlock,
  attemptUnlock,
  clearFido2,
  clearPin,
  getFido2AssertionOptions,
  getFido2RegistrationOptions,
  hasFido2Set,
  hasPinSet,
  registerFido2,
  setPin,
  validatePinPolicy,
  verifyFido2Assertion,
  type UnlockResult,
} from "../appLock";
import { defaultRateLimiter } from "./rateLimiter";
import { RateLimitError } from "./rateLimiter";
import { getLogger } from "../logger";
import type {
  AppLockMode,
  Fido2AssertionInput,
  Fido2AssertionOptions,
  Fido2RegistrationInput,
  Fido2RegistrationOptions,
} from "../../shared/types";

interface AppLockStatusInfo {
  hasPinSet: boolean;
  hasFido2Set: boolean;
  mode: AppLockMode;
}

/**
 * Shape-check a renderer-supplied FIDO2 registration payload. The
 * renderer is the only caller, but it crosses the IPC boundary as
 * `unknown`, so we validate field types before handing it to the
 * crypto layer (which does the semantic validation).
 */
function parseFido2RegistrationInput(raw: unknown): Fido2RegistrationInput {
  if (raw === null || typeof raw !== "object") {
    throw new Error("FIDO2 registration payload must be an object");
  }
  const r = raw as Record<string, unknown>;
  if (
    typeof r.credentialId !== "string" ||
    typeof r.publicKeySpki !== "string" ||
    typeof r.alg !== "number" ||
    typeof r.clientDataJson !== "string"
  ) {
    throw new Error("FIDO2 registration payload has invalid fields");
  }
  return {
    credentialId: r.credentialId,
    publicKeySpki: r.publicKeySpki,
    alg: r.alg,
    clientDataJson: r.clientDataJson,
  };
}

/** Shape-check a renderer-supplied FIDO2 assertion payload. */
function parseFido2AssertionInput(raw: unknown): Fido2AssertionInput | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.credentialId !== "string" ||
    typeof r.authenticatorData !== "string" ||
    typeof r.clientDataJson !== "string" ||
    typeof r.signature !== "string"
  ) {
    return null;
  }
  return {
    credentialId: r.credentialId,
    authenticatorData: r.authenticatorData,
    clientDataJson: r.clientDataJson,
    signature: r.signature,
  };
}

export function registerAppLockHandlers(): void {
  idempotentHandle(
    "appLock:getStatus",
    async (): Promise<AppLockStatusInfo> => {
      const config = loadConfig();
      return {
        hasPinSet: hasPinSet(),
        hasFido2Set: hasFido2Set(),
        mode: config.appLockMode,
      };
    },
  );

  idempotentHandle(
    "appLock:setPin",
    async (_event, pinRaw: unknown): Promise<void> => {
      // Rate-limit before any state inspection. The handler
      // short-circuits with "A PIN is already set" when one
      // exists, so without a throttle this channel would be a
      // cheap oracle for hammering scrypt-derivation work the
      // moment that branch flips (initial setup, post-removal).
      // Parity with attemptUnlock / attemptBiometric keeps a
      // compromised renderer from picking the cheapest reachable
      // crypto channel to side-step the throttle.
      defaultRateLimiter.consume("appLock:setPin", {
        tokensPerInterval: 1,
        intervalMs: 250,
      });
      if (typeof pinRaw !== "string") {
        throw new Error("PIN payload must be a string");
      }
      // Setting an initial PIN (when none exists) is allowed
      // without authentication — the user is opting INTO the lock.
      // Overwriting an existing PIN requires `appLock:changePin`,
      // which is a separate IPC that first verifies the old PIN.
      if (hasPinSet()) {
        throw new Error(
          "A PIN is already set. Use appLock:changePin to rotate it.",
        );
      }
      validatePinPolicy(pinRaw);
      await setPin(pinRaw);
    },
  );

  idempotentHandle(
    "appLock:changePin",
    async (
      _event,
      oldPinRaw: unknown,
      newPinRaw: unknown,
    ): Promise<void> => {
      // Rate-limit before any policy validation or scrypt work.
      // This channel invokes scrypt twice (once via
      // attemptUnlock(old) and once via setPin(new)) so it's the
      // most expensive surface — capping at the same 250ms budget
      // as attemptUnlock keeps a compromised renderer from
      // amplifying scrypt cost through the rotation channel.
      defaultRateLimiter.consume("appLock:changePin", {
        tokensPerInterval: 1,
        intervalMs: 250,
      });
      if (typeof oldPinRaw !== "string" || typeof newPinRaw !== "string") {
        throw new Error("PIN payload must be a string");
      }
      // Validate new-pin policy BEFORE accepting the old-pin
      // attempt — a policy violation is the user's fault, not a
      // brute-force signal, so we should not burn an attempt-counter
      // increment on it.
      validatePinPolicy(newPinRaw);
      const verify = await attemptUnlock(oldPinRaw);
      if (verify.kind !== "success") {
        // Bubble up the exact failure kind so the renderer can
        // render "wrong PIN" vs. "locked out" with the same UX
        // it uses for normal unlock.
        throw Object.assign(
          new Error("Current PIN verification failed"),
          { result: verify },
        );
      }
      await setPin(newPinRaw);
    },
  );

  idempotentHandle(
    "appLock:removePin",
    async (_event, pinRaw: unknown): Promise<void> => {
      // Rate-limit before attemptUnlock invokes scrypt. Without
      // this throttle the removal channel could be used as an
      // alternative brute-force surface against the same stored
      // hash that `appLock:attemptUnlock` protects (both verify
      // the PIN via `attemptUnlock`), bypassing the per-channel
      // 250ms budget on attemptUnlock by alternating channels.
      defaultRateLimiter.consume("appLock:removePin", {
        tokensPerInterval: 1,
        intervalMs: 250,
      });
      if (typeof pinRaw !== "string") {
        throw new Error("PIN payload must be a string");
      }
      const verify = await attemptUnlock(pinRaw);
      if (verify.kind !== "success") {
        throw Object.assign(
          new Error("PIN verification failed; cannot remove lock"),
          { result: verify },
        );
      }
      clearPin();
      // keep `appLockMode` and PIN
      // material lifecycle-coupled. Removing the PIN MUST drop the
      // mode back to `"off"`, otherwise the next launch would see
      // `appLockMode === "pin"` with no stored PIN and trip the
      // `no_pin_set` UnlockResult path, leaving the user staring
      // at a forced PIN-setup flow the IPC layer was supposed to
      // make impossible. The symmetric path lives in
      // `settings:update`: switching mode to `"off"` calls
      // `clearPin()` so neither lifecycle can drift from the other.
      try {
        const config = loadConfig();
        if (config.appLockMode !== "off") {
          updateConfig({ appLockMode: "off" });
        }
      } catch (err) {
        // best-effort — the PIN is already gone, so worst case the
        // next launch trips `no_pin_set`. Log so a support trail
        // exists.
        getLogger().warn("app_lock.mode_reset_on_remove_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  idempotentHandle(
    "appLock:attemptUnlock",
    async (_event, pinRaw: unknown): Promise<UnlockResult> => {
      // Rate-limit defense-in-depth — backoff in appLock.ts is the
      // load-bearing brake against brute force, this is a hard cap
      // on requests-per-second to prevent a hot loop from chewing
      // CPU on scrypt derivations even between failed attempts.
      try {
        defaultRateLimiter.consume("appLock:attemptUnlock", {
          tokensPerInterval: 1,
          intervalMs: 250,
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          // Surface as a locked_out kind so the renderer reuses the
          // existing wait-countdown UI rather than rendering a
          // separate rate-limit error.
          return {
            kind: "locked_out",
            nextAttemptAt: Date.now() + err.retryAfterMs,
          };
        }
        throw err;
      }
      if (typeof pinRaw !== "string") {
        return { kind: "failure", failures: 0 };
      }
      const result = await attemptUnlock(pinRaw);
      if (result.kind === "success") {
        getLogger().info("app_lock.unlock_success");
      } else if (result.kind === "failure") {
        getLogger().info("app_lock.unlock_failure", {
          failures: result.failures,
        });
      }
      return result;
    },
  );

  idempotentHandle(
    "appLock:attemptBiometric",
    async (
      _event,
      reasonRaw: unknown,
    ): Promise<{ success: boolean }> => {
      // Rate-limit parity with `appLock:attemptUnlock`. The biometric
      // path is the user's *other* unlock channel; a renderer
      // compromised into a tight loop could otherwise spam
      // TouchID / Windows Hello prompts (or the platform-fallback
      // PowerShell process, on Windows) at the IPC's raw async
      // throughput. The 250ms / token budget here matches the PIN
      // path, so a compromised renderer cannot pick the biometric
      // channel to side-step the throttle.
      //
      // Failing closed (returning `{ success: false }`) rather than
      // throwing keeps the renderer's existing biometric error
      // handling path responsible for the UX (no separate "rate
      // limited" code path needed). A user mashing the unlock
      // button would have to wait 250ms between presses — well
      // under one human click cadence.
      try {
        defaultRateLimiter.consume("appLock:attemptBiometric", {
          tokensPerInterval: 1,
          intervalMs: 250,
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          getLogger().warn("app_lock.biometric_rate_limited", {
            retryAfterMs: err.retryAfterMs,
          });
          return { success: false };
        }
        throw err;
      }
      const reason =
        typeof reasonRaw === "string" && reasonRaw.length > 0
          ? reasonRaw
          : "Unlock Tessera";
      const success = await attemptBiometricUnlock(reason);
      return { success };
    },
  );

  // --- FIDO2 / WebAuthn -------------------------------------------
  //
  // Registration/assertion *option* channels are cheap (a random
  // challenge + a memory-map insert) and feed an interactive
  // WebAuthn ceremony, so they are not rate-limited. The
  // verify/register/remove channels touch persisted state and the
  // crypto layer, so they share the same 250ms/token budget as the
  // PIN + biometric channels to keep a compromised renderer from
  // hammering them.

  idempotentHandle(
    "appLock:getFido2RegistrationOptions",
    async (): Promise<Fido2RegistrationOptions> => {
      return getFido2RegistrationOptions();
    },
  );

  idempotentHandle(
    "appLock:registerFido2",
    async (_event, inputRaw: unknown): Promise<{ success: boolean }> => {
      defaultRateLimiter.consume("appLock:registerFido2", {
        tokensPerInterval: 1,
        intervalMs: 250,
      });
      const input = parseFido2RegistrationInput(inputRaw);
      registerFido2(input);
      return { success: true };
    },
  );

  idempotentHandle(
    "appLock:getFido2AssertionOptions",
    async (): Promise<Fido2AssertionOptions | null> => {
      return getFido2AssertionOptions();
    },
  );

  idempotentHandle(
    "appLock:verifyFido2",
    async (_event, inputRaw: unknown): Promise<UnlockResult> => {
      // Mirror the attemptUnlock rate-limit: a hard requests/sec cap
      // on the crypto-bearing channel. On rate-limit we surface a
      // `locked_out` kind so the renderer reuses its wait-countdown
      // UI, identical to the PIN path.
      try {
        defaultRateLimiter.consume("appLock:verifyFido2", {
          tokensPerInterval: 1,
          intervalMs: 250,
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          return {
            kind: "locked_out",
            nextAttemptAt: Date.now() + err.retryAfterMs,
          };
        }
        throw err;
      }
      const input = parseFido2AssertionInput(inputRaw);
      if (input === null) {
        return { kind: "failure", failures: 0 };
      }
      const result = verifyFido2Assertion(input);
      if (result.kind === "success") {
        getLogger().info("app_lock.fido2_unlock_success");
      } else if (result.kind === "failure") {
        getLogger().info("app_lock.fido2_unlock_failure");
      }
      return result;
    },
  );

  idempotentHandle(
    "appLock:removeFido2",
    async (_event, pinRaw: unknown): Promise<void> => {
      // Removing the convenience authenticator requires proving
      // knowledge of the PIN root credential — otherwise someone at
      // an unlocked machine could strip the second factor. Rate-limit
      // because this verifies the PIN via attemptUnlock (scrypt).
      defaultRateLimiter.consume("appLock:removeFido2", {
        tokensPerInterval: 1,
        intervalMs: 250,
      });
      if (typeof pinRaw !== "string") {
        throw new Error("PIN payload must be a string");
      }
      const verify = await attemptUnlock(pinRaw);
      if (verify.kind !== "success") {
        throw Object.assign(
          new Error("PIN verification failed; cannot remove security key"),
          { result: verify },
        );
      }
      clearFido2();
      // Keep `appLockMode` coupled to the credential lifecycle, just
      // like `appLock:removePin` does for the PIN. The user still has
      // their PIN root, so dropping the convenience authenticator
      // demotes the mode `"fido2"` -> `"pin"` rather than `"off"`.
      // Without this, the next launch would see `appLockMode ===
      // "fido2"` while `getFido2AssertionOptions()` returns `null`
      // (no credential), an orphaned state that the `settings:update`
      // guard only prevents on the way *in*, not when the credential
      // is removed underneath the mode.
      try {
        const config = loadConfig();
        if (config.appLockMode === "fido2") {
          updateConfig({ appLockMode: "pin" });
        }
      } catch (err) {
        // best-effort — the credential is already gone. Log so a
        // support trail exists; worst case the renderer falls back to
        // the PIN prompt, which is the correct behaviour anyway.
        getLogger().warn("app_lock.fido2_mode_reset_on_remove_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
