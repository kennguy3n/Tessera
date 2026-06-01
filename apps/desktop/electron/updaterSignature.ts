/**
 * Ed25519 signature verification for `electron-updater` artifacts.
 *
 * # What this defends against
 *
 * `electron-updater` fetches an installer binary from a configured
 * publish endpoint (GitHub releases, S3, generic HTTPS, etc.) and runs
 * it with elevated privileges via `quitAndInstall()`. If an attacker
 * can:
 *
 *   - Compromise the publish endpoint (stolen GitHub release-write
 *     token, S3 bucket misconfiguration, hijacked HTTPS DNS)
 *   - MITM the download (rogue CA, captive-portal injection, malicious
 *     egress proxy on a corporate network)
 *   - Compromise the update server's metadata file (`latest.yml`,
 *     `latest-mac.yml`, etc.) and substitute their own installer URL
 *
 * …they can ship arbitrary code to every Tessera install with
 * auto-update enabled. The transport-layer TLS check that
 * `electron-updater` runs is *necessary but not sufficient* — it only
 * verifies that the HTTPS connection is intact, not that the bytes on
 * the other end were produced by the Tessera signing key.
 *
 * The on-vendor signature check that `electron-updater` runs on macOS
 * / Windows packaged builds (codesign / SignTool) verifies the OS
 * code-signing chain, not a Tessera-controlled key. A leaked Apple
 * Developer ID or stolen Windows EV cert would bypass that check
 * silently.
 *
 * Ed25519 detached signatures over the downloaded artifact, verified
 * against a hardcoded set of trust anchors compiled into the app
 * binary, give us an additional integrity check that:
 *
 *   - Cannot be bypassed by compromising the update server
 *   - Cannot be bypassed by stealing the OS code-signing identity
 *   - Cannot be bypassed by MITMing TLS
 *   - CAN only be bypassed by stealing the Ed25519 signing key, which
 *     lives off-line on the release manager's hardware and never
 *     touches CI
 *
 * # Why hardcoded anchors (not TUF / root.json / installer-baked)
 *
 * Ken's design decision on PR 10b: trust anchors live in this source
 * file as a `UPDATER_TRUST_ANCHORS` array of base64-encoded Ed25519
 * public keys. Verified against the downloaded artifact; verification
 * passes if ANY anchor accepts the signature.
 *
 * Rationale vs. the alternatives:
 *
 *   - **TUF / root.json**: would require shipping a TUF client + a
 *     persistent role-key state machine. The complexity isn't
 *     justified for a single-app updater where the publisher (us) and
 *     the consumer (us) are the same entity.
 *   - **Installer-baked**: the installer that initially places the
 *     anchor on disk is itself an update artifact — the chicken-and-egg
 *     means the first install has to trust *something* hardcoded, so
 *     we may as well keep the anchor hardcoded throughout.
 *   - **Hardcoded array**: every release of Tessera ships with the
 *     current anchor + the previous N anchors. Key rotation = release
 *     a new version that adds the new anchor; remove the old anchor
 *     in version N+5 or thereabouts. Old clients can still verify
 *     because the old anchor is still in the new release's list.
 *
 * # Signature format
 *
 * Detached Ed25519 signature: a 64-byte raw signature stored as a
 * sibling file with the suffix `.sig`. For an installer named
 * `Tessera-Setup-1.2.3.exe`, the signature lives at
 * `Tessera-Setup-1.2.3.exe.sig`. The signature is computed over the
 * raw bytes of the installer (no preimage hashing — Ed25519's
 * underlying SHA-512 handles that internally).
 *
 * `apps/desktop/scripts/sign-update.ts` (see that file) is the
 * release-time signing tool; this module is the runtime verifier.
 *
 * # What this module does NOT do
 *
 * - Does not download the signature file. The caller (autoUpdater.ts)
 *   is responsible for placing the `.sig` file next to the artifact
 *   that `electron-updater` already downloaded. Today this is achieved
 *   by configuring the `publish` block in `electron-builder.yml` to
 *   upload both the installer and its `.sig` to the same release.
 * - Does not handle key rotation policy (when to add / remove
 *   anchors). That is a release-management process, not a runtime
 *   concern.
 * - Does not verify the `latest.yml` metadata file `electron-updater`
 *   parses to decide which artifact to download. A future PR may add
 *   that — for now we rely on the artifact-level signature to catch
 *   any substitution.
 */

import * as crypto from "crypto";
import * as fs from "fs";

/**
 * Test-only seam: lets the anchor-loop regression tests substitute a
 * stub verifier without monkey-patching the live `crypto` module
 * (which Node refuses to allow under ESM-bridge mode used by vitest).
 *
 * Production code paths never set this — the default delegates
 * straight through to `crypto.verify`. The seam is exported via
 * `_setVerifyImplForTests` (test-only) so that the test file can
 * inject a custom function for the duration of a single test and
 * restore the default in `afterEach`.
 */
type VerifyFn = (
  algorithm: null,
  data: Buffer,
  key: crypto.KeyObject,
  signature: Buffer,
) => boolean;

let _verifyImpl: VerifyFn = (algorithm, data, key, signature) =>
  crypto.verify(algorithm, data, key, signature);

export function _setVerifyImplForTests(
  override: VerifyFn | null,
): void {
  _verifyImpl =
    override ?? ((algorithm, data, key, signature) =>
      crypto.verify(algorithm, data, key, signature));
}

/**
 * Trust anchors compiled into the Tessera binary. Each entry is a
 * base64-encoded raw 32-byte Ed25519 public key (RFC 8032 § 5.1.5).
 *
 * # Rotation procedure
 *
 *   1. Generate a new Ed25519 keypair off-line on the release
 *      manager's hardware (`apps/desktop/scripts/gen-updater-key.ts`).
 *   2. Add the new public key to the END of this array (preserving
 *      existing entries so older signatures still verify during the
 *      overlap window).
 *   3. Ship a release with both anchors. Updates signed with EITHER
 *      key will verify.
 *   4. After 5+ releases (or whatever overlap period your release
 *      cadence calls for), remove the old anchor from this array.
 *      Sign all future releases with the new key only.
 *
 * # Multiple anchors at once
 *
 * Verification passes if ANY anchor accepts the signature. This is
 * the "overlap window" — it lets us keep an old key valid while we
 * roll out a new one, then remove the old key once we're confident
 * every client has the new release.
 *
 * # Why no anchor today
 *
 * The release pipeline that uploads `.sig` files is configured per-
 * release; until that pipeline is wired up, this array is empty and
 * verification is a no-op (gated by `enforceUpdateSignature: false`
 * default in the config schema for the first release that ships this
 * code). Setting `enforceUpdateSignature: true` with an empty anchor
 * array is a configuration error that this module surfaces as
 * `reason: "no trust anchors configured"`.
 */
export const UPDATER_TRUST_ANCHORS: readonly string[] = Object.freeze([
  // Add base64-encoded raw 32-byte Ed25519 public keys here. Example:
  //   "Mu7nKQF6oTAQ4lN1WPHL7Q+vJrEMG+QnZ6mZ8w4xJio=",
  // The release manager populates this array as part of the first
  // signed release.
]);

/**
 * Outcome of a signature verification call. `ok: true` means at least
 * one trust anchor accepted the signature. `ok: false` carries a
 * machine-readable `reason` enum so the auto-updater can route on the
 * specific failure mode (no anchors configured vs. signature mismatch
 * vs. malformed file).
 */
export interface SignatureVerificationResult {
  ok: boolean;
  /**
   * Index into `UPDATER_TRUST_ANCHORS` of the anchor that accepted the
   * signature. Only present when `ok === true`. Lets the caller log
   * which key was used and detect when an old anchor (i.e. one we
   * intend to retire soon) is still being used to sign current
   * releases.
   */
  anchorIndex?: number;
  /**
   * Machine-readable reason. Only present when `ok === false`. One of:
   *
   *   - `"no-trust-anchors"`: `UPDATER_TRUST_ANCHORS` is empty.
   *     Configuration error.
   *   - `"signature-missing"`: the `.sig` file does not exist next to
   *     the artifact.
   *   - `"signature-malformed"`: the `.sig` file exists but its bytes
   *     are not a valid Ed25519 signature (wrong length, or rejected
   *     by every anchor's verifier).
   *   - `"verification-failed"`: every anchor rejected the signature.
   *     Either the artifact was modified after signing, the signature
   *     is from an unknown / retired key, or the artifact-signature
   *     pair was substituted.
   *   - `"verifier-error"`: `crypto.verify` threw. Should not happen
   *     in normal operation; surfaced for debuggability.
   */
  reason?:
    | "no-trust-anchors"
    | "signature-missing"
    | "signature-malformed"
    | "verification-failed"
    | "verifier-error";
  /** Free-form message for log surfaces. Always present. */
  message: string;
}

/**
 * Path suffix appended to the artifact path to locate its detached
 * signature. `apps/desktop/scripts/sign-update.ts` writes the
 * signature using this same suffix.
 */
export const SIGNATURE_SUFFIX = ".sig";

/**
 * Standard Ed25519 raw-signature byte length per RFC 8032 § 5.1.6.
 * `crypto.verify` accepts signatures of this exact length; anything
 * else is rejected as malformed before we even attempt verification.
 */
const ED25519_SIGNATURE_LEN = 64;

/**
 * Standard Ed25519 raw-public-key byte length per RFC 8032 § 5.1.5.
 * Decoded anchors that are not exactly 32 bytes are rejected at
 * import time — see `decodeAnchor`.
 */
const ED25519_PUBKEY_LEN = 32;

/**
 * Decode a base64 anchor into the SPKI-encoded `KeyObject` that
 * `crypto.verify` requires. We import the raw 32-byte public key by
 * wrapping it in the Ed25519 SubjectPublicKeyInfo prefix, then
 * passing the resulting DER to `createPublicKey`.
 *
 * Why SPKI: Node's `crypto.createPublicKey` accepts several encodings
 * but raw 32-byte Ed25519 public keys aren't one of them on every
 * supported Node version. The SPKI prefix (`30 2a 30 05 06 03 2b 65
 * 70 03 21 00` — 12 bytes of ASN.1 wrapping the 32-byte key) is the
 * standardised X.509 way to represent a raw Ed25519 public key and
 * is universally accepted.
 */
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/**
 * Decode a base64 anchor string into a `crypto.KeyObject` suitable
 * for `crypto.verify`. Throws on malformed input — caller treats this
 * as a fatal configuration error and surfaces "anchor decode failed"
 * to the operator log.
 */
function decodeAnchor(b64: string): crypto.KeyObject {
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    throw new Error(
      `UPDATER_TRUST_ANCHORS entry is not valid base64: ${b64.slice(0, 16)}…`,
    );
  }
  if (raw.length !== ED25519_PUBKEY_LEN) {
    throw new Error(
      `UPDATER_TRUST_ANCHORS entry must decode to ${ED25519_PUBKEY_LEN} bytes, got ${raw.length}`,
    );
  }
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: spki, format: "der", type: "spki" });
}

/**
 * Verify a downloaded update artifact against a known set of trust
 * anchors. Returns a structured result the caller can route on; never
 * throws on verification failure.
 *
 * # Algorithm
 *
 *   1. Read the artifact bytes from `artifactPath`.
 *   2. Read the signature bytes from `<artifactPath>.sig`.
 *   3. For each anchor in `anchors` (defaulting to
 *      `UPDATER_TRUST_ANCHORS`), call `crypto.verify("ed25519",
 *      artifactBytes, anchorKey, signatureBytes)`. If ANY anchor
 *      returns `true`, the verification passes and we return the
 *      matching anchor index.
 *   4. If every anchor rejects, return `{ ok: false, reason:
 *      "verification-failed" }`.
 *
 * # Parameter injection for tests
 *
 * Tests pass a custom `anchors` array (instead of the hardcoded
 * `UPDATER_TRUST_ANCHORS`) so they can verify against a per-test
 * keypair. Production callers omit the parameter so the hardcoded
 * anchors are used.
 */
export function verifyUpdateSignature(
  artifactPath: string,
  options: {
    anchors?: readonly string[];
    signaturePath?: string;
  } = {},
): SignatureVerificationResult {
  const anchors = options.anchors ?? UPDATER_TRUST_ANCHORS;
  const sigPath = options.signaturePath ?? `${artifactPath}${SIGNATURE_SUFFIX}`;

  if (anchors.length === 0) {
    return {
      ok: false,
      reason: "no-trust-anchors",
      message:
        "Refusing to verify update: UPDATER_TRUST_ANCHORS is empty. " +
        "This is a release-pipeline configuration error — populate the " +
        "anchor array with the current signing key's public key before " +
        "enabling enforceUpdateSignature.",
    };
  }

  if (!fs.existsSync(sigPath)) {
    return {
      ok: false,
      reason: "signature-missing",
      message:
        `Update signature not found at ${sigPath}. The release pipeline ` +
        `is expected to upload <artifact>${SIGNATURE_SUFFIX} alongside every ` +
        "installer artifact.",
    };
  }

  let signatureBytes: Buffer;
  let artifactBytes: Buffer;
  try {
    signatureBytes = fs.readFileSync(sigPath);
    artifactBytes = fs.readFileSync(artifactPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "verifier-error",
      message: `Failed to read artifact or signature: ${message}`,
    };
  }

  return verifyUpdateSignatureFromBuffers(artifactBytes, signatureBytes, {
    anchors,
  });
}

/**
 * In-memory variant of `verifyUpdateSignature` for callers that
 * already have the artifact + signature bytes in hand (today: tests;
 * tomorrow: a future streaming verifier that doesn't want to
 * round-trip through disk).
 */
export function verifyUpdateSignatureFromBuffers(
  artifactBytes: Buffer,
  signatureBytes: Buffer,
  options: { anchors?: readonly string[] } = {},
): SignatureVerificationResult {
  const anchors = options.anchors ?? UPDATER_TRUST_ANCHORS;

  if (anchors.length === 0) {
    return {
      ok: false,
      reason: "no-trust-anchors",
      message:
        "Refusing to verify update: UPDATER_TRUST_ANCHORS is empty. " +
        "Populate the anchor array before enabling enforceUpdateSignature.",
    };
  }

  if (signatureBytes.length !== ED25519_SIGNATURE_LEN) {
    return {
      ok: false,
      reason: "signature-malformed",
      message:
        `Signature length ${signatureBytes.length} is not the expected ` +
        `${ED25519_SIGNATURE_LEN} bytes for an Ed25519 signature.`,
    };
  }

  // Per-anchor verifier errors are accumulated rather than fatal. Key
  // rotation requires the array to hold N anchors at once during the
  // overlap window; if anchor #0 throws (truly malformed key material,
  // or a Node-version-specific edge case in `crypto.verify`), anchor
  // #1 must still get a chance to verify. We surface the accumulated
  // errors as `verifier-error` ONLY when every anchor failed — if any
  // anchor returns `false` cleanly, the canonical "no anchor accepted"
  // result wins because that is what the operator actually needs to
  // see ("the artifact does not match any of our signing keys"). The
  // verifier-error message is preserved as a fallback for the rare
  // case where every anchor threw and none returned cleanly.
  const verifierErrors: Array<{ index: number; message: string }> = [];

  for (let i = 0; i < anchors.length; i += 1) {
    let anchorKey: crypto.KeyObject;
    try {
      anchorKey = decodeAnchor(anchors[i]);
    } catch (err) {
      // Anchor decode failures are a hard configuration error
      // distinct from a verification mismatch: a malformed anchor is
      // the operator's bug (a typo in the base64), not a sign of
      // tampering. We return immediately rather than `continue` so
      // the operator sees the broken anchor on the FIRST failing
      // verification rather than discovering it only after every
      // other anchor also fails to verify.
      const message = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        reason: "verifier-error",
        message: `Failed to decode anchor #${i}: ${message}`,
      };
    }

    let accepted = false;
    try {
      accepted = _verifyImpl(
        null,
        artifactBytes,
        anchorKey,
        signatureBytes,
      );
    } catch (err) {
      // `crypto.verify` throws on truly malformed key material; the
      // anchor-length guard inside `decodeAnchor` should make that
      // unreachable, but we tolerate the throw to keep the loop
      // moving — another anchor might still verify. Without this
      // `continue`, a single broken anchor at index 0 would shadow a
      // healthy anchor at index 1 during a rotation overlap window,
      // and every install would fail.
      const message = err instanceof Error ? err.message : String(err);
      verifierErrors.push({ index: i, message });
      continue;
    }

    if (accepted) {
      return {
        ok: true,
        anchorIndex: i,
        message: `Signature verified against anchor #${i}.`,
      };
    }
  }

  // If every anchor threw a verifier-error and none returned a clean
  // `false`, the failure is structural (broken anchors / Node-version
  // issue) rather than a tampering signal. Surface that as
  // `verifier-error` with all per-anchor messages so the operator can
  // see which anchors are healthy and which need replacement.
  if (
    verifierErrors.length === anchors.length &&
    verifierErrors.length > 0
  ) {
    return {
      ok: false,
      reason: "verifier-error",
      message:
        `crypto.verify threw for every anchor (${verifierErrors.length}/${anchors.length}). ` +
        verifierErrors
          .map((e) => `anchor #${e.index}: ${e.message}`)
          .join("; "),
    };
  }

  return {
    ok: false,
    reason: "verification-failed",
    message:
      `No trust anchor accepted the signature (tried ${anchors.length}). ` +
      "Either the artifact was modified, the signature is from a retired " +
      "key, or the artifact-signature pair was substituted." +
      (verifierErrors.length > 0
        ? ` (Note: ${verifierErrors.length} anchor(s) threw during verification and were skipped: ` +
          verifierErrors
            .map((e) => `#${e.index} (${e.message})`)
            .join(", ") +
          ".)"
        : ""),
  };
}

/**
 * Read a `.sig` file from disk. Convenience for callers that want to
 * fetch a signature without invoking the full verifier.
 */
export function loadSignature(artifactPath: string): Buffer {
  return fs.readFileSync(`${artifactPath}${SIGNATURE_SUFFIX}`);
}
