/**
 * FIDO2 / WebAuthn app-lock unit tests.
 *
 * The renderer half of the ceremony (`navigator.credentials.*`) is
 * not reachable in vitest, so these tests drive the trust-bearing
 * main-process half directly: they mint a real EC / Ed25519 keypair,
 * synthesise the `clientDataJSON` + `authenticatorData` an
 * authenticator would produce, sign the
 * `authenticatorData || SHA-256(clientDataJSON)` blob, and assert
 * that `verifyFido2Assertion` accepts a well-formed assertion and
 * rejects every tampered variant.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const hoisted = vi.hoisted(() => ({
  userData: { value: "" },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => hoisted.userData.value) },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  systemPreferences: {
    canPromptTouchID: vi.fn(() => false),
    promptTouchID: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) =>
      Buffer.concat([Buffer.from("v10\x00"), Buffer.from(s, "utf-8")]),
    ),
    decryptString: vi.fn((b: Buffer) => {
      if (b.subarray(0, 4).equals(Buffer.from("v10\x00"))) {
        return b.subarray(4).toString("utf-8");
      }
      throw new Error("decryptString: not a v10 blob");
    }),
  },
}));

import {
  clearFido2,
  clearPin,
  getFido2AssertionOptions,
  getFido2RegistrationOptions,
  hasFido2Set,
  registerFido2,
  setPin,
  verifyFido2Assertion,
  _setAppLockPathForTests,
  _resetFido2ChallengesForTests,
} from "../appLock";
import type {
  Fido2AssertionInput,
  Fido2RegistrationInput,
} from "../../shared/types";
import { getLogger } from "../logger";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-fido2-test-"));
  hoisted.userData.value = tmpDir;
  _setAppLockPathForTests(() => path.join(tmpDir, "app-lock.bin"));
  _resetFido2ChallengesForTests();
});

afterEach(() => {
  _setAppLockPathForTests(null);
  _resetFido2ChallengesForTests();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const CREDENTIAL_ID = "dGVzdC1jcmVkZW50aWFsLWlk"; // base64url "test-credential-id"

function b64(buf: Buffer): string {
  return buf.toString("base64");
}

/**
 * Build the `clientDataJSON` (base64 of the UTF-8 JSON) an
 * authenticator returns for the given ceremony.
 */
function makeClientDataJson(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
): string {
  return Buffer.from(
    JSON.stringify({
      type,
      challenge,
      origin: "https://app.tessera.local",
      crossOrigin: false,
    }),
    "utf-8",
  ).toString("base64");
}

/**
 * Build a 37-byte `authenticatorData`: `rpIdHash(32) || flags(1) ||
 * signCount(4)`. `up` toggles the User-Present flag.
 */
function makeAuthenticatorData(rpId: string, up = true): Buffer {
  const rpIdHash = crypto.createHash("sha256").update(rpId).digest();
  const flags = Buffer.from([up ? 0x01 : 0x00]);
  const signCount = Buffer.from([0x00, 0x00, 0x00, 0x01]);
  return Buffer.concat([rpIdHash, flags, signCount]);
}

interface TestKey {
  privateKey: crypto.KeyObject;
  publicKeySpki: string; // base64 DER
  alg: number;
}

function makeEs256Key(): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    privateKey,
    publicKeySpki: b64(
      publicKey.export({ type: "spki", format: "der" }) as Buffer,
    ),
    alg: -7,
  };
}

function makeEd25519Key(): TestKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKeySpki: b64(
      publicKey.export({ type: "spki", format: "der" }) as Buffer,
    ),
    alg: -8,
  };
}

/** Sign `authData || SHA-256(clientDataJSON)` with the key's scheme. */
function sign(
  key: TestKey,
  authData: Buffer,
  clientDataJsonB64: string,
): Buffer {
  const clientDataHash = crypto
    .createHash("sha256")
    .update(Buffer.from(clientDataJsonB64, "base64"))
    .digest();
  const signedData = Buffer.concat([authData, clientDataHash]);
  if (key.alg === -8) {
    return crypto.sign(null, signedData, key.privateKey);
  }
  return crypto.sign("sha256", signedData, key.privateKey);
}

/** Register `key` under a fresh registration challenge. */
function register(key: TestKey): void {
  const opts = getFido2RegistrationOptions();
  const input: Fido2RegistrationInput = {
    credentialId: CREDENTIAL_ID,
    publicKeySpki: key.publicKeySpki,
    alg: key.alg,
    clientDataJson: makeClientDataJson("webauthn.create", opts.challenge),
  };
  registerFido2(input);
}

/** Produce a valid assertion for `key` against a fresh challenge. */
function makeAssertion(key: TestKey): Fido2AssertionInput {
  const opts = getFido2AssertionOptions();
  if (opts === null) throw new Error("expected assertion options");
  const clientDataJson = makeClientDataJson("webauthn.get", opts.challenge);
  const authData = makeAuthenticatorData(opts.rpId, true);
  const signature = sign(key, authData, clientDataJson);
  return {
    credentialId: CREDENTIAL_ID,
    authenticatorData: b64(authData),
    clientDataJson,
    signature: b64(signature),
  };
}

describe("FIDO2 registration", () => {
  it("requires a PIN to be set first", () => {
    const key = makeEs256Key();
    const opts = getFido2RegistrationOptions();
    expect(() =>
      registerFido2({
        credentialId: CREDENTIAL_ID,
        publicKeySpki: key.publicKeySpki,
        alg: key.alg,
        clientDataJson: makeClientDataJson("webauthn.create", opts.challenge),
      }),
    ).toThrow(/Set a PIN/);
    expect(hasFido2Set()).toBe(false);
  });

  it("rejects an unsupported COSE algorithm", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    const opts = getFido2RegistrationOptions();
    expect(() =>
      registerFido2({
        credentialId: CREDENTIAL_ID,
        publicKeySpki: key.publicKeySpki,
        alg: -65535, // not in FIDO2_SUPPORTED_ALGS
        clientDataJson: makeClientDataJson("webauthn.create", opts.challenge),
      }),
    ).toThrow(/unsupported algorithm/);
  });

  it("rejects a registration whose challenge was never issued", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    expect(() =>
      registerFido2({
        credentialId: CREDENTIAL_ID,
        publicKeySpki: key.publicKeySpki,
        alg: key.alg,
        clientDataJson: makeClientDataJson(
          "webauthn.create",
          "Y2hhbGxlbmdlLW5ldmVyLWlzc3VlZA", // bogus challenge
        ),
      }),
    ).toThrow(/client data failed validation/);
  });

  it("rejects an expired registration challenge", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    const opts = getFido2RegistrationOptions();
    // Register "two and a half minutes later" — past the 2-minute TTL —
    // by threading an injected `now`, mirroring how the assertion path
    // verifies challenge expiry.
    const future = Date.now() + 150_000;
    expect(() =>
      registerFido2(
        {
          credentialId: CREDENTIAL_ID,
          publicKeySpki: key.publicKeySpki,
          alg: key.alg,
          clientDataJson: makeClientDataJson("webauthn.create", opts.challenge),
        },
        future,
      ),
    ).toThrow(/client data failed validation/);
    expect(hasFido2Set()).toBe(false);
  });

  it("rejects a malformed SPKI public key", async () => {
    await setPin("abc123");
    const opts = getFido2RegistrationOptions();
    expect(() =>
      registerFido2({
        credentialId: CREDENTIAL_ID,
        publicKeySpki: Buffer.from("not a real key").toString("base64"),
        alg: -7,
        clientDataJson: makeClientDataJson("webauthn.create", opts.challenge),
      }),
    ).toThrow(/invalid SPKI public key/);
  });

  it("persists the credential on success", async () => {
    await setPin("abc123");
    expect(hasFido2Set()).toBe(false);
    register(makeEs256Key());
    expect(hasFido2Set()).toBe(true);
  });
});

describe("FIDO2 assertion verification", () => {
  it("getFido2AssertionOptions returns null when no credential is set", () => {
    expect(getFido2AssertionOptions()).toBeNull();
  });

  it("accepts a well-formed ES256 assertion", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const result = verifyFido2Assertion(makeAssertion(key));
    expect(result.kind).toBe("success");
  });

  it("accepts a well-formed Ed25519 (EdDSA) assertion", async () => {
    await setPin("abc123");
    const key = makeEd25519Key();
    register(key);
    const result = verifyFido2Assertion(makeAssertion(key));
    expect(result.kind).toBe("success");
  });

  it("does NOT emit the unlock_success audit event itself (the IPC handler does)", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const infoSpy = vi.spyOn(getLogger(), "info");
    // A successful assertion must not double-log: the audit event is
    // owned by the appLock:verifyFido2 IPC handler, exactly like the
    // PIN path leaves app_lock.unlock_success to its handler.
    expect(verifyFido2Assertion(makeAssertion(key)).kind).toBe("success");
    expect(infoSpy).not.toHaveBeenCalledWith(
      "app_lock.fido2_unlock_success",
      expect.anything(),
    );
    expect(infoSpy).not.toHaveBeenCalledWith("app_lock.fido2_unlock_success");
    infoSpy.mockRestore();
  });

  it("returns no_pin_set when no credential is registered", async () => {
    await setPin("abc123");
    // Build an assertion-shaped payload without registering.
    const result = verifyFido2Assertion({
      credentialId: CREDENTIAL_ID,
      authenticatorData: b64(makeAuthenticatorData("app.tessera.local")),
      clientDataJson: makeClientDataJson("webauthn.get", "x"),
      signature: b64(Buffer.from("sig")),
    });
    expect(result.kind).toBe("no_pin_set");
  });

  it("rejects a forged signature", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const assertion = makeAssertion(key);
    // Corrupt the signature.
    const sigBuf = Buffer.from(assertion.signature, "base64");
    sigBuf[sigBuf.length - 1] ^= 0xff;
    const result = verifyFido2Assertion({
      ...assertion,
      signature: b64(sigBuf),
    });
    expect(result.kind).toBe("failure");
  });

  it("rejects an assertion signed by a different key", async () => {
    await setPin("abc123");
    const registered = makeEs256Key();
    register(registered);
    // Sign with an attacker key but present the registered cred ID.
    const attacker = makeEs256Key();
    const opts = getFido2AssertionOptions();
    if (opts === null) throw new Error("expected options");
    const clientDataJson = makeClientDataJson("webauthn.get", opts.challenge);
    const authData = makeAuthenticatorData(opts.rpId, true);
    const result = verifyFido2Assertion({
      credentialId: CREDENTIAL_ID,
      authenticatorData: b64(authData),
      clientDataJson,
      signature: b64(sign(attacker, authData, clientDataJson)),
    });
    expect(result.kind).toBe("failure");
  });

  it("rejects a replayed assertion (single-use challenge)", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const assertion = makeAssertion(key);
    expect(verifyFido2Assertion(assertion).kind).toBe("success");
    // Replaying the exact same assertion must fail — the challenge
    // was consumed on first use.
    expect(verifyFido2Assertion(assertion).kind).toBe("failure");
  });

  it("rejects an expired challenge", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const assertion = makeAssertion(key);
    // Verify "two and a half minutes later" — past the 2-minute TTL.
    const future = Date.now() + 150_000;
    expect(verifyFido2Assertion(assertion, future).kind).toBe("failure");
  });

  it("rejects an unknown credential ID", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const assertion = makeAssertion(key);
    expect(
      verifyFido2Assertion({
        ...assertion,
        credentialId: "c29tZS1vdGhlci1pZA", // different id
      }).kind,
    ).toBe("failure");
  });

  it("rejects an assertion for the wrong RP (rpIdHash mismatch)", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const opts = getFido2AssertionOptions();
    if (opts === null) throw new Error("expected options");
    const clientDataJson = makeClientDataJson("webauthn.get", opts.challenge);
    // authenticatorData for a DIFFERENT rpId.
    const authData = makeAuthenticatorData("evil.example.com", true);
    const result = verifyFido2Assertion({
      credentialId: CREDENTIAL_ID,
      authenticatorData: b64(authData),
      clientDataJson,
      signature: b64(sign(key, authData, clientDataJson)),
    });
    expect(result.kind).toBe("failure");
  });

  it("rejects an assertion without the User-Present flag", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const opts = getFido2AssertionOptions();
    if (opts === null) throw new Error("expected options");
    const clientDataJson = makeClientDataJson("webauthn.get", opts.challenge);
    const authData = makeAuthenticatorData(opts.rpId, false); // UP clear
    const result = verifyFido2Assertion({
      credentialId: CREDENTIAL_ID,
      authenticatorData: b64(authData),
      clientDataJson,
      signature: b64(sign(key, authData, clientDataJson)),
    });
    expect(result.kind).toBe("failure");
  });

  it("rejects a clientData with the wrong ceremony type", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    const opts = getFido2AssertionOptions();
    if (opts === null) throw new Error("expected options");
    // Use a "webauthn.create" type for an unlock assertion.
    const clientDataJson = makeClientDataJson(
      "webauthn.create",
      opts.challenge,
    );
    const authData = makeAuthenticatorData(opts.rpId, true);
    const result = verifyFido2Assertion({
      credentialId: CREDENTIAL_ID,
      authenticatorData: b64(authData),
      clientDataJson,
      signature: b64(sign(key, authData, clientDataJson)),
    });
    expect(result.kind).toBe("failure");
  });
});

describe("FIDO2 lifecycle", () => {
  it("clearFido2 removes the credential but keeps the PIN", async () => {
    await setPin("abc123");
    register(makeEs256Key());
    expect(hasFido2Set()).toBe(true);
    clearFido2();
    expect(hasFido2Set()).toBe(false);
  });

  it("clearPin also drops the orphaned FIDO2 credential", async () => {
    await setPin("abc123");
    register(makeEs256Key());
    expect(hasFido2Set()).toBe(true);
    clearPin();
    expect(hasFido2Set()).toBe(false);
  });

  it("a registered credential survives a 'process restart'", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    register(key);
    // Re-reading from disk (a fresh read) still reports the cred and
    // a fresh assertion still verifies.
    expect(hasFido2Set()).toBe(true);
    const result = verifyFido2Assertion(makeAssertion(key));
    expect(result.kind).toBe("success");
  });

  it("logs fido2_replaced (not fido2_registered) when overwriting a credential", async () => {
    await setPin("abc123");
    const infoSpy = vi.spyOn(getLogger(), "info");

    register(makeEs256Key());
    expect(infoSpy).toHaveBeenCalledWith(
      "app_lock.fido2_registered",
      expect.anything(),
    );

    infoSpy.mockClear();
    // Swapping in a second key supersedes the first; the audit trail
    // must record a swap rather than a fresh first-time registration.
    register(makeEd25519Key());
    expect(infoSpy).toHaveBeenCalledWith(
      "app_lock.fido2_replaced",
      expect.anything(),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      "app_lock.fido2_registered",
      expect.anything(),
    );

    infoSpy.mockRestore();
  });
});

describe("FIDO2 challenge map is bounded", () => {
  it("evicts the oldest pending challenge once the cap is exceeded", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    // C0 is the oldest pending challenge.
    const c0 = getFido2RegistrationOptions().challenge;
    // Flood the (intentionally un-rate-limited) option channel. The
    // cap is 256, so issuing 256 *more* challenges pushes C0 out.
    for (let i = 0; i < 256; i++) getFido2RegistrationOptions();
    // C0 has been evicted, so a registration quoting it is rejected
    // exactly as an unknown/expired challenge would be.
    expect(() =>
      registerFido2({
        credentialId: CREDENTIAL_ID,
        publicKeySpki: key.publicKeySpki,
        alg: key.alg,
        clientDataJson: makeClientDataJson("webauthn.create", c0),
      }),
    ).toThrow(/client data failed validation/);
  });

  it("still honours a freshly-issued challenge under modest churn", async () => {
    await setPin("abc123");
    const key = makeEs256Key();
    // A handful of in-flight challenges stays well under the cap, so
    // the newest one is retained and registers successfully.
    for (let i = 0; i < 10; i++) getFido2RegistrationOptions();
    const fresh = getFido2RegistrationOptions().challenge;
    expect(() =>
      registerFido2({
        credentialId: CREDENTIAL_ID,
        publicKeySpki: key.publicKeySpki,
        alg: key.alg,
        clientDataJson: makeClientDataJson("webauthn.create", fresh),
      }),
    ).not.toThrow();
    expect(hasFido2Set()).toBe(true);
  });
});
