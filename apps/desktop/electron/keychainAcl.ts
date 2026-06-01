/**
 * Per-app keychain ACL.
 *
 * Threat model
 * ------------
 * Tessera's safeStorage-wrapped DEK and the app-lock blob both
 * delegate their at-rest encryption to Electron's `safeStorage` API,
 * which in turn delegates to a per-platform secret store:
 *
 *   - macOS:   Keychain Services (per-bundle-ID access group via the
 *              app's signed entitlements + Code Signing identity).
 *   - Windows: DPAPI (per-user, NOT per-app — any process running as
 *              the same user can decrypt).
 *   - Linux:   gnome-libsecret / kwallet / kwallet5 / kwallet6 (each
 *              user-scoped, NOT per-app; any process running as the
 *              same user can query the keyring). When no secret-store
 *              daemon is running, Electron falls back to `basic_text`,
 *              which is XOR-with-a-hardcoded-key — i.e. NO at-rest
 *              encryption at all.
 *
 * Per-app keychain ACL is meaningful on macOS (where the Code Signing
 * cert + bundle ID + `keychain-access-groups` entitlement enforces that
 * only signed Tessera builds can read Tessera-written items) and
 * partially meaningful on Windows/Linux (where the OS scopes secrets
 * to the current user account but not to a specific app). The
 * `basic_text` Linux fallback is the only configuration where there is
 * effectively NO at-rest protection — a sibling process running as
 * the same user can decrypt the blob with publicly-known logic.
 *
 * What this module does
 * ---------------------
 * 1. Captures the active `safeStorage` backend at app boot
 *    (`captureBackendAtBoot`) and exposes it via `getBootBackend()`.
 * 2. Emits a `keychain.backend.<name>` telemetry counter so an
 *    operator can audit fleet-wide which backend each install lands
 *    on. The local-only telemetry sink is the only consumer — no
 *    values leave the device.
 * 3. Logs the backend at INFO and any future backend transitions at
 *    WARN. A backend transition mid-session (e.g. kwallet was up at
 *    boot, then the daemon died and the next call reports basic_text)
 *    is a security event because writes between the failure and the
 *    next boot would land in basic_text storage.
 * 4. Exports `assertSafeEncrypt({ enforce })` which the
 *    `vaultCrypto.encryptForVault` path consults before each write.
 *    When `enforce === true` AND the active backend is `basic_text`,
 *    `assertSafeEncrypt` throws a `KeychainAclError` with a precise
 *    description of what's wrong + what to do about it. Reads
 *    (`decryptFromVault`) deliberately are NOT gated — refusing to
 *    decrypt an already-stored blob would brick a user mid-session.
 * 5. Exposes `keychainBackendDescriptor()` which returns a structured
 *    `{ name, trustTier, encryptionEnforced, perAppAcl }` blob for
 *    Settings → Security UI to surface to the user.
 *
 * What this module does NOT do (and why)
 * --------------------------------------
 * Electron's public `safeStorage` API does not expose the underlying
 * `kSecAttrAccessGroup` parameter, so we cannot tighten the macOS
 * Keychain ACL beyond the default the framework sets (which is "this
 * app's signed bundle ID"). The macOS per-app ACL is enforced
 * structurally by Code Signing + entitlements, not by a runtime call
 * we control. The `packaging/macos/entitlements.mac.plist` file is
 * the canonical source of truth for the access-group declaration; this
 * module's job is the boot-time guard rail + telemetry, not direct
 * Keychain API calls (which would require a native module we
 * explicitly want to avoid for the cross-platform surface).
 *
 * The default for `enforceKeychainAcl` is `true` on every platform so
 * a fresh install enforces the strict policy by default. On macOS and
 * Windows the native backend is always available and basic_text never
 * fires, so the flag is effectively a no-op there. On Linux without a
 * secret-store daemon (basic_text fallback), this default surfaces as
 * a `KeychainAclError` on the next secret write — the user then either
 * starts a daemon (gnome-keyring, kwallet5, kwallet6) and retries, or
 * flips the toggle off in Settings → Security to accept the reduced
 * protection. The Settings UI surfaces a clear warning either way so
 * the trade-off is explicit.
 */

import { safeStorage } from "electron";
import { getLogger } from "./logger";
import { recordCounter } from "./telemetrySink";

/**
 * The string set of every backend `safeStorage.getSelectedStorageBackend`
 * can report. `os_managed` is a synthetic value we substitute when the
 * platform is macOS or Windows — `getSelectedStorageBackend` is a
 * Linux-only API, but the rest of the module treats the active backend
 * uniformly. `unavailable` is a synthetic value we substitute when
 * `safeStorage.isEncryptionAvailable()` returns false (no keyring on
 * Linux + no password vault either).
 */
export type KeychainBackend =
  | "os_managed"
  | "gnome_libsecret"
  | "kwallet"
  | "kwallet5"
  | "kwallet6"
  | "basic_text"
  | "unknown"
  | "unavailable";

/**
 * Trust-tier classification used by the Settings UI badge:
 *
 * - `enforced-by-os`: macOS Keychain Services with per-bundle-ID
 *   access group (enforced by Code Signing + entitlements). The
 *   strongest tier — sibling processes signed with a different
 *   identity cannot read Tessera's items.
 * - `user-scoped`: Windows DPAPI or Linux gnome/kwallet. Encryption
 *   protects against another user account on the same machine but NOT
 *   against another process running as the same user.
 * - `none`: Linux basic_text fallback. No real protection — XOR with
 *   a hardcoded key. Surfaced in the UI with a strongly-worded
 *   warning.
 * - `none-unavailable`: `safeStorage.isEncryptionAvailable()` is false.
 *   The password-vault fallback (PBKDF2-derived AES-256-GCM, see
 *   `vaultCrypto.ts`) handles writes in this state; nothing flows into
 *   safeStorage at all. The UI surfaces this as "password-vault mode"
 *   rather than "keychain mode" so the user is not confused about
 *   which credential protects their data.
 */
export type TrustTier =
  | "enforced-by-os"
  | "user-scoped"
  | "none"
  | "none-unavailable";

export interface KeychainBackendDescriptor {
  /** Active backend at boot (and on every refresh). */
  name: KeychainBackend;
  /** Strength tier surfaced to the Settings UI. */
  trustTier: TrustTier;
  /** Whether at-rest encryption is actually happening. False for `basic_text` / `unavailable`. */
  encryptionEnforced: boolean;
  /** Whether the active backend isolates secrets to THIS app (vs. just this user). */
  perAppAcl: boolean;
  /** Human-readable platform string for logs / telemetry. */
  platform: NodeJS.Platform;
}

/**
 * Thrown by `assertSafeEncrypt` when the policy refuses to write a
 * fresh secret because the active backend cannot enforce the
 * minimum bar (e.g. Linux basic_text fallback with
 * `enforceKeychainAcl: true`). The renderer surfaces this in the
 * Settings → Security panel and offers two recovery paths: (1) start
 * the secret-store daemon and retry, or (2) flip the
 * `enforceKeychainAcl` flag off (which weakens the security posture).
 */
export class KeychainAclError extends Error {
  readonly code = "keychain_acl_violation" as const;
  readonly backend: KeychainBackend;
  readonly trustTier: TrustTier;
  constructor(
    message: string,
    opts: { backend: KeychainBackend; trustTier: TrustTier },
  ) {
    super(message);
    this.name = "KeychainAclError";
    this.backend = opts.backend;
    this.trustTier = opts.trustTier;
  }
}

/**
 * Compute the active backend by querying `safeStorage`. On macOS /
 * Windows we synthesize `os_managed` because `getSelectedStorageBackend`
 * is Linux-only. On Linux we forward whatever Electron reports.
 *
 * The `process.platform` check is done first so a test running on
 * Linux can stub `safeStorage` to simulate macOS by patching this
 * module's `platformOverrideForTests` hook — without that, calls to
 * the real `safeStorage.getSelectedStorageBackend` would still fire
 * and return Linux-specific values.
 */
let platformOverrideForTests: NodeJS.Platform | null = null;

/**
 * Test-only hook: swap the platform name reported by this module.
 * Production code MUST NOT call this; the test suite uses it to
 * exercise macOS / Windows branches from a Linux test runner.
 */
export function _setPlatformForTests(p: NodeJS.Platform | null): void {
  platformOverrideForTests = p;
}

function activePlatform(): NodeJS.Platform {
  return platformOverrideForTests ?? process.platform;
}

export function computeBackend(): KeychainBackend {
  if (!safeStorage.isEncryptionAvailable()) {
    return "unavailable";
  }
  const p = activePlatform();
  if (p === "darwin" || p === "win32") {
    return "os_managed";
  }
  if (p === "linux") {
    // `getSelectedStorageBackend` returns one of: 'basic_text',
    // 'gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6', 'unknown'.
    // Cast through `unknown` so future Electron upgrades that add a
    // new variant fall through to `unknown` rather than a TS compile
    // error here.
    const raw = (
      safeStorage as unknown as {
        getSelectedStorageBackend?: () => string;
      }
    ).getSelectedStorageBackend?.();
    switch (raw) {
      case "basic_text":
      case "gnome_libsecret":
      case "kwallet":
      case "kwallet5":
      case "kwallet6":
      case "unknown":
        return raw;
      default:
        return "unknown";
    }
  }
  return "unknown";
}

function trustTierForBackend(backend: KeychainBackend): TrustTier {
  switch (backend) {
    case "os_managed":
      // macOS = Code Signing enforced per-app ACL. Windows = DPAPI
      // is user-scoped, NOT per-app — we surface both under the same
      // `os_managed` umbrella for the backend name but tier them
      // differently below based on platform. We cannot distinguish
      // here without knowing the platform, so callers should use
      // `keychainBackendDescriptor()` which threads platform in.
      return "enforced-by-os";
    case "gnome_libsecret":
    case "kwallet":
    case "kwallet5":
    case "kwallet6":
      return "user-scoped";
    case "basic_text":
      return "none";
    case "unavailable":
      return "none-unavailable";
    case "unknown":
    default:
      // An unrecognised backend is treated as `none` for safety: we
      // don't know its properties so we refuse to grant it the
      // `user-scoped` badge. The user will see "unknown backend" in
      // the Settings UI and can investigate before relying on it.
      return "none";
  }
}

/**
 * Build a structured descriptor for the active backend. The Settings
 * UI calls this on every render to surface a green/yellow/red badge.
 */
export function keychainBackendDescriptor(): KeychainBackendDescriptor {
  const backend = computeBackend();
  const platform = activePlatform();
  let trustTier = trustTierForBackend(backend);
  // Re-tier `os_managed` based on platform: macOS Keychain Services is
  // per-bundle-ID (enforced-by-os, perAppAcl=true), Windows DPAPI is
  // user-scoped (user-scoped, perAppAcl=false). The two share the
  // same `safeStorage` backend reporter, so we have to discriminate
  // here.
  let perAppAcl = false;
  if (backend === "os_managed") {
    if (platform === "darwin") {
      trustTier = "enforced-by-os";
      perAppAcl = true;
    } else if (platform === "win32") {
      trustTier = "user-scoped";
      perAppAcl = false;
    }
  }
  return {
    name: backend,
    trustTier,
    encryptionEnforced: backend !== "basic_text" && backend !== "unavailable",
    perAppAcl,
    platform,
  };
}

let bootBackend: KeychainBackendDescriptor | null = null;

/**
 * Call once at app boot, AFTER `app.whenReady()` resolves (so
 * `safeStorage.isEncryptionAvailable()` returns truthful values on
 * Linux, where it depends on the keyring daemon being reachable).
 * Idempotent — subsequent calls are a no-op (the boot backend is the
 * source of truth; mid-session transitions are caught by
 * `assertSafeEncrypt` against the freshly-computed backend, not this
 * cached snapshot).
 */
export function captureBackendAtBoot(): KeychainBackendDescriptor {
  if (bootBackend !== null) {
    return bootBackend;
  }
  bootBackend = keychainBackendDescriptor();
  getLogger().info("keychain.backend.boot", {
    backend: bootBackend.name,
    trust_tier: bootBackend.trustTier,
    encryption_enforced: bootBackend.encryptionEnforced,
    per_app_acl: bootBackend.perAppAcl,
    platform: bootBackend.platform,
  });
  // Telemetry: one counter per backend variant. The local-only sink
  // records this when telemetry is opted in; otherwise it is a no-op.
  // Useful for fleet-wide audit ("how many installs are running on
  // basic_text?") without leaking user data.
  recordCounter(`keychain.backend.${bootBackend.name}`);
  return bootBackend;
}

/**
 * Return the snapshot captured at boot. Returns `null` if
 * `captureBackendAtBoot` has not been called yet (e.g. during unit
 * tests that don't wire the boot path).
 */
export function getBootBackend(): KeychainBackendDescriptor | null {
  return bootBackend;
}

/**
 * Test-only: reset cached boot backend so the next
 * `captureBackendAtBoot` re-queries `safeStorage`. Production code
 * MUST NOT call this.
 */
export function _resetBootBackendForTests(): void {
  bootBackend = null;
}

/**
 * Gate writes through the policy. Called by `vaultCrypto.encryptForVault`
 * before delegating to `safeStorage.encryptString`. The caller passes
 * the current value of the `enforceKeychainAcl` config field (default
 * `true` on every platform — see the module-level doc above).
 *
 * Behaviour matrix:
 *
 *   - `enforce === true` + backend is `basic_text` (Linux fallback,
 *     XOR-with-hardcoded-key, NOT real encryption) → throw
 *     `KeychainAclError` so the caller never persists a secret under
 *     no-real-encryption storage.
 *   - `enforce === false` + backend is `basic_text` → log a WARN and
 *     proceed. The user has deliberately opted out of the strict
 *     policy in Settings → Security after seeing the trade-off badge;
 *     we honour that choice but record it for forensic visibility.
 *   - Any other backend → no-op (the backend is one we trust for
 *     write protection).
 *
 * Does NOT gate reads. A user mid-session who switched off their
 * keyring daemon should still be able to decrypt blobs that were
 * written when the keyring was healthy — refusing reads here would
 * brick the running app.
 */
export function assertSafeEncrypt(options: { enforce: boolean }): void {
  const current = keychainBackendDescriptor();
  // Detect mid-session backend drift FIRST so we record it even when
  // the new backend is the one we're about to refuse (e.g. boot
  // backend was `kwallet6` and the daemon died mid-session, so the
  // freshly-computed backend is now `basic_text`). Without this
  // ordering, the basic_text refusal below would return before we
  // logged the drift — and the drift signal is exactly what an
  // operator needs to debug "why did my keyring stop working?".
  if (bootBackend !== null && bootBackend.name !== current.name) {
    getLogger().warn("keychain.backend.drift", {
      boot_backend: bootBackend.name,
      current_backend: current.name,
      reason:
        "safeStorage backend changed since boot — the secret-store daemon may have crashed or been restarted. Future writes use the new backend.",
    });
  }
  // We gate `basic_text` (the only backend that is provably NOT real
  // encryption — it is XOR with a hardcoded key, documented as a
  // fallback in Electron's source) but deliberately do NOT also gate
  // `unknown`. The reasoning: an unrecognised backend is a future
  // Electron-introduced variant we do not yet have information about
  // — it could be MORE secure than what we know about today (e.g. a
  // new Linux keyring), and refusing writes would block legitimate
  // Electron upgrades. The Settings UI conservatively tiers `unknown`
  // as `none` so the user is informed of the asymmetry. If a future
  // Electron release adds a backend that we determine IS insecure,
  // the right fix is to add a case here, not to widen the gate to
  // every unknown variant.
  if (current.name === "basic_text") {
    if (options.enforce) {
      throw new KeychainAclError(
        "Keychain ACL policy: refusing to encrypt secrets under Electron's `basic_text` fallback (XOR with a hardcoded key, NOT real encryption). " +
          "Start your desktop secret-store daemon (gnome-keyring, kwallet5, kwallet6) and restart Tessera, or flip Settings → Security → 'Enforce keychain ACL' off to accept the reduced protection.",
        { backend: current.name, trustTier: current.trustTier },
      );
    }
    getLogger().warn("keychain.acl.unenforced_basic_text", {
      backend: current.name,
      reason:
        "Writing secrets via Electron safeStorage on basic_text backend — at-rest protection is XOR with a hardcoded key. Enable a secret-store daemon for real encryption.",
    });
    return;
  }
  if (current.name === "unavailable") {
    // safeStorage isn't available at all — `encryptForVault` will
    // route through the password-vault fallback (PBKDF2-derived
    // AES-256-GCM) which IS real encryption, just keyed by the user's
    // password instead of an OS-managed key. The policy does not need
    // to refuse here because the caller's fallback path is
    // cryptographically sound.
    return;
  }
}
