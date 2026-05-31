/**
 * Real-key Ed25519 signature verification tests. We generate live
 * keypairs in each test (cheap — Ed25519 keygen is <1 ms) so the
 * verifier is exercised end-to-end against actual cryptographic
 * material rather than mocked-out `crypto.verify` calls.
 *
 * The test surface deliberately avoids stubbing `crypto`: doing so
 * would let a regression in our signature-format handling or our
 * SPKI prefix slip through, which is the exact class of bug this
 * verifier exists to catch.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SIGNATURE_SUFFIX,
  loadSignature,
  verifyUpdateSignature,
  verifyUpdateSignatureFromBuffers,
} from "../updaterSignature";

/**
 * Generate a real Ed25519 keypair and return both the base64-encoded
 * raw 32-byte public key (the format `UPDATER_TRUST_ANCHORS` accepts)
 * and the private key object suitable for `crypto.sign`. Cheap enough
 * to call in `beforeEach`.
 */
function generateTestKeypair(): {
  publicKeyBase64: string;
  privateKey: crypto.KeyObject;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  // Export raw 32-byte public key. Node's KeyObject.export() returns
  // SPKI DER by default; we strip the 12-byte SPKI prefix to get the
  // raw key, then base64-encode it.
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(12); // SPKI Ed25519 prefix is 12 bytes
  return {
    publicKeyBase64: raw.toString("base64"),
    privateKey,
  };
}

/**
 * Sign `payload` with `privateKey` using detached Ed25519 (no
 * pre-hash; the algorithm's internal SHA-512 handles that).
 */
function signPayload(
  payload: Buffer,
  privateKey: crypto.KeyObject,
): Buffer {
  return crypto.sign(null, payload, privateKey);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-updater-sig-"));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("verifyUpdateSignatureFromBuffers — happy path", () => {
  it("accepts a valid signature from the only configured anchor", () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    const payload = Buffer.from("Tessera-Setup-1.2.3.exe — pretend payload");
    const sig = signPayload(payload, privateKey);

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(true);
    expect(result.anchorIndex).toBe(0);
    expect(result.reason).toBeUndefined();
  });

  it("accepts a signature from anchor #2 when both #1 and #2 are trusted (rotation overlap)", () => {
    const oldKey = generateTestKeypair();
    const newKey = generateTestKeypair();
    const payload = Buffer.from("future signed-with-new-key release");
    const sig = signPayload(payload, newKey.privateKey);

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: [oldKey.publicKeyBase64, newKey.publicKeyBase64],
    });

    expect(result.ok).toBe(true);
    expect(result.anchorIndex).toBe(1);
  });

  it("accepts a signature from anchor #1 when both #1 and #2 are trusted (backward compat during rollout)", () => {
    const oldKey = generateTestKeypair();
    const newKey = generateTestKeypair();
    const payload = Buffer.from("older client receiving update signed with retired key");
    const sig = signPayload(payload, oldKey.privateKey);

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: [oldKey.publicKeyBase64, newKey.publicKeyBase64],
    });

    expect(result.ok).toBe(true);
    expect(result.anchorIndex).toBe(0);
  });

  it("verifies a multi-megabyte payload without truncation", () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    // 2 MB of pseudo-random data — exercises Ed25519's internal
    // SHA-512 streaming behaviour.
    const payload = crypto.randomBytes(2 * 1024 * 1024);
    const sig = signPayload(payload, privateKey);

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(true);
  });
});

describe("verifyUpdateSignatureFromBuffers — rejection paths", () => {
  it("rejects when the payload was tampered with", () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    const original = Buffer.from("original payload");
    const sig = signPayload(original, privateKey);

    const tampered = Buffer.from("tampered payload");
    const result = verifyUpdateSignatureFromBuffers(tampered, sig, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verification-failed");
  });

  it("rejects when the signature was tampered with", () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    const payload = Buffer.from("payload");
    const sig = signPayload(payload, privateKey);
    // Flip a single bit in the signature
    sig[0] ^= 0x01;

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verification-failed");
  });

  it("rejects when the signature is from a different key than any anchor", () => {
    const trustedKey = generateTestKeypair();
    const attackerKey = generateTestKeypair();
    const payload = Buffer.from("malicious payload signed by attacker");
    const sig = signPayload(payload, attackerKey.privateKey);

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: [trustedKey.publicKeyBase64],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verification-failed");
  });

  it("rejects when no trust anchors are configured", () => {
    const { privateKey } = generateTestKeypair();
    const payload = Buffer.from("payload");
    const sig = signPayload(payload, privateKey);

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: [],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-trust-anchors");
    expect(result.message).toMatch(/empty/i);
  });

  it("rejects when the signature is the wrong length", () => {
    const { publicKeyBase64 } = generateTestKeypair();
    const payload = Buffer.from("payload");
    // 32-byte signature — wrong length for Ed25519 (which is 64).
    const malformedSig = Buffer.alloc(32);

    const result = verifyUpdateSignatureFromBuffers(payload, malformedSig, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature-malformed");
  });

  it("surfaces a verifier-error when an anchor is malformed base64", () => {
    const { privateKey } = generateTestKeypair();
    const payload = Buffer.from("payload");
    const sig = signPayload(payload, privateKey);

    const result = verifyUpdateSignatureFromBuffers(payload, sig, {
      anchors: ["AAAA"], // 3 bytes after b64 decode — not 32
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verifier-error");
    expect(result.message).toMatch(/anchor #0/i);
  });
});

describe("verifyUpdateSignature — disk-backed flow", () => {
  it("reads artifact + sibling .sig from disk and verifies", () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    const payload = Buffer.from("on-disk artifact content");
    const sig = signPayload(payload, privateKey);

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    fs.writeFileSync(artifactPath, payload);
    fs.writeFileSync(`${artifactPath}${SIGNATURE_SUFFIX}`, sig);

    const result = verifyUpdateSignature(artifactPath, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(true);
    expect(result.anchorIndex).toBe(0);
  });

  it("returns signature-missing when the .sig file does not exist", () => {
    const { publicKeyBase64 } = generateTestKeypair();
    const payload = Buffer.from("on-disk artifact content");

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    fs.writeFileSync(artifactPath, payload);
    // Deliberately do NOT write the .sig file.

    const result = verifyUpdateSignature(artifactPath, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("signature-missing");
    expect(result.message).toContain(SIGNATURE_SUFFIX);
  });

  it("respects an explicit signaturePath override", () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    const payload = Buffer.from("artifact content");
    const sig = signPayload(payload, privateKey);

    const artifactPath = path.join(tmpDir, "artifact.bin");
    const sigPath = path.join(tmpDir, "out-of-band-signature.sig");
    fs.writeFileSync(artifactPath, payload);
    fs.writeFileSync(sigPath, sig);

    const result = verifyUpdateSignature(artifactPath, {
      anchors: [publicKeyBase64],
      signaturePath: sigPath,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects a tampered artifact even when the sig file is unmodified", () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    const payload = Buffer.from("genuine artifact");
    const sig = signPayload(payload, privateKey);

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    fs.writeFileSync(artifactPath, Buffer.from("tampered artifact"));
    fs.writeFileSync(`${artifactPath}${SIGNATURE_SUFFIX}`, sig);

    const result = verifyUpdateSignature(artifactPath, {
      anchors: [publicKeyBase64],
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("verification-failed");
  });
});

describe("loadSignature helper", () => {
  it("reads <artifact>.sig from disk", () => {
    const artifactPath = path.join(tmpDir, "artifact.bin");
    const sigContent = Buffer.from("some signature bytes");
    fs.writeFileSync(`${artifactPath}${SIGNATURE_SUFFIX}`, sigContent);

    const loaded = loadSignature(artifactPath);
    expect(loaded.equals(sigContent)).toBe(true);
  });
});
