import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// `vi.mock` is hoisted above all `import` and `const` statements,
// so the factory cannot capture local variables. Use `vi.hoisted`
// to declare the mock state in the same hoisted phase as the mock
// factory itself.
const hoisted = vi.hoisted(() => {
  return {
    userData: { value: "" },
    safeStorageMock: {
      isEncryptionAvailable: vi.fn(),
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => hoisted.userData.value),
    getAppPath: vi.fn(() => "/fake/app"),
  },
  safeStorage: hoisted.safeStorageMock,
}));

// Alias for ergonomic test bodies.
const safeStorageMock = hoisted.safeStorageMock;

// Imported after the mock so the module under test picks up the
// mocked electron surface. dynamic import via require would also
// work — top-level imports are fine because vi.mock is hoisted.
import {
  getOrCreateDbKey,
  generateDbKey,
  DB_KEY_HEX_LEN,
  EncryptionUnavailableError,
  _deleteDbKeyForTests,
} from "../dbKey";

describe("dbKey", () => {
  beforeEach(() => {
    hoisted.userData.value = fs.mkdtempSync(
      path.join(os.tmpdir(), "tessera-dbkey-test-"),
    );
    // Default: keyring is available. Individual tests override.
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    // safeStorage.encryptString wraps a string and returns a Buffer.
    // For these tests we use a trivial reversible encoding so we
    // can pin both the writer and the reader paths without depending
    // on the platform keyring.
    safeStorageMock.encryptString.mockImplementation((plain: string) =>
      Buffer.from(`enc:${plain}`),
    );
    safeStorageMock.decryptString.mockImplementation((blob: Buffer) => {
      const s = blob.toString("utf8");
      if (!s.startsWith("enc:")) {
        throw new Error("Decryption failed: bad ciphertext");
      }
      return s.slice("enc:".length);
    });
  });

  afterEach(() => {
    if (hoisted.userData.value && fs.existsSync(hoisted.userData.value)) {
      fs.rmSync(hoisted.userData.value, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  it("generateDbKey returns 64 hex characters", () => {
    const k = generateDbKey();
    expect(k).toHaveLength(DB_KEY_HEX_LEN);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateDbKey returns a fresh value each call", () => {
    const a = generateDbKey();
    const b = generateDbKey();
    // 256 bits of entropy — collision probability is negligible.
    expect(a).not.toBe(b);
  });

  it("getOrCreateDbKey generates and persists on first call", () => {
    const key = getOrCreateDbKey();
    expect(key).toHaveLength(DB_KEY_HEX_LEN);
    const fp = path.join(hoisted.userData.value, "db.key");
    expect(fs.existsSync(fp)).toBe(true);
    // Wrapped, not plaintext.
    expect(fs.readFileSync(fp, "utf8")).toBe(`enc:${key}`);
    // And `safeStorage.encryptString` was actually invoked.
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(key);
  });

  it("getOrCreateDbKey returns the same key across calls", () => {
    const a = getOrCreateDbKey();
    const b = getOrCreateDbKey();
    expect(a).toBe(b);
    // Persistence path was hit once, decrypt path the other time.
    expect(safeStorageMock.encryptString).toHaveBeenCalledTimes(1);
    expect(safeStorageMock.decryptString).toHaveBeenCalledTimes(1);
  });

  it("getOrCreateDbKey throws EncryptionUnavailableError when safeStorage is unavailable", () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    // Pin both the class identity (so appState.ts can distinguish
    // it from data-corruption errors via `instanceof`) and the
    // human-readable message.
    expect(() => getOrCreateDbKey()).toThrow(EncryptionUnavailableError);
    expect(() => getOrCreateDbKey()).toThrow(/Encryption not available/);
    // And we did not write a key file on the failure path.
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(
      false,
    );
  });

  it("getOrCreateDbKey error message does NOT mention the password-vault recovery path", () => {
    // The DB key chain deliberately does NOT support the password
    // vault as a fallback: the SQLCipher cipher key is wrapped by
    // safeStorage directly, not by the password-derived vault key
    // (see KNOWN LIMITATION block next to `maybeInitPasswordVault`
    // in `main.ts`). Telling the user to "restart and enter a vault
    // password" on this path would send them down an unrecoverable
    // route, because the password vault cannot decrypt the on-disk
    // `db.key` blob. Pin the absence of that hint here so a future
    // refactor that re-wires `dbKey.ts` to `encryptionUnavailableReason()`
    // (which DOES include the hint) cannot regress this contract
    // silently.
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    try {
      getOrCreateDbKey();
      expect.fail("expected getOrCreateDbKey to throw");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toMatch(/vault password/i);
      expect(msg).not.toMatch(/enter a .*password/i);
      // And it DOES include the diagnosis + a real recovery hint
      // for whichever platform the test is running on, so the
      // message remains user-actionable.
      expect(msg).toMatch(/Encryption not available/);
    }
  });

  it("EncryptionUnavailableError is distinct from plain Error", () => {
    // Critical for appState.ts's two-tier catch: the
    // `instanceof EncryptionUnavailableError` check decides
    // whether to silently fall through to an unencrypted bridge
    // or to refuse to bring it up.
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    try {
      getOrCreateDbKey();
      expect.fail("expected getOrCreateDbKey to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EncryptionUnavailableError);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("EncryptionUnavailableError");
    }
  });

  it("getOrCreateDbKey throws plain Error (not EncryptionUnavailableError) on zero-byte key file", () => {
    // Half-written first launch — the temp-and-rename path makes
    // this unlikely in practice, but a corrupted FS could still
    // produce one. We must NOT silently regenerate because that
    // would render the matching tessera.db permanently unreadable.
    fs.writeFileSync(
      path.join(hoisted.userData.value, "db.key"),
      Buffer.alloc(0),
    );
    expect(() => getOrCreateDbKey()).toThrow(/empty/);
    expect(() => getOrCreateDbKey()).not.toThrow(EncryptionUnavailableError);
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it("getOrCreateDbKey throws plain Error (not EncryptionUnavailableError) on wrong-length decrypted key", () => {
    // safeStorage decrypts to a non-64-char string — could happen
    // if the user's userData dir was copied from a different version
    // that used a different key format. Better to fail loud than
    // hand the bridge a malformed key.
    safeStorageMock.decryptString.mockReturnValue("too-short");
    fs.writeFileSync(
      path.join(hoisted.userData.value, "db.key"),
      Buffer.from("anything"),
    );
    expect(() => getOrCreateDbKey()).toThrow(/unexpected length/);
    expect(() => getOrCreateDbKey()).not.toThrow(EncryptionUnavailableError);
  });

  it("getOrCreateDbKey throws plain Error (not EncryptionUnavailableError) when db.key exists AND safeStorage is unavailable", () => {
    // Real-world scenario: user installed Tessera with gnome-keyring
    // running, db.key got persisted; later the user uninstalled
    // gnome-keyring or moved to a TTY without a session bus. The
    // on-disk tessera.db is encrypted with the key in db.key, so
    // we MUST NOT pretend "encryption unavailable" — that would
    // tell appState.ts it's safe to fall through to unencrypted
    // mode and silently create a fresh plaintext DB alongside
    // the encrypted one (or, if tessera.db was deleted, regress
    // to plaintext storage entirely). Refuse to bring up the
    // bridge with an actionable error.
    fs.writeFileSync(
      path.join(hoisted.userData.value, "db.key"),
      Buffer.from("enc:" + "a".repeat(64)),
    );
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(() => getOrCreateDbKey()).toThrow(/keyring is unavailable/);
    expect(() => getOrCreateDbKey()).not.toThrow(EncryptionUnavailableError);
    // And we never attempted to decrypt — the keyring guard ran first.
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it("getOrCreateDbKey throws plain Error on decrypted-key with non-hex content", () => {
    // Defense-in-depth: even if decryptString returns a 64-char
    // string somehow, it must be ASCII hex to be a valid
    // SQLCipher raw key. Catch it at the JS layer with an
    // actionable message rather than letting the Rust bridge
    // reject with the opaque "db key must be ASCII hex digits
    // only" error.
    safeStorageMock.decryptString.mockReturnValue(
      "Z".repeat(64), // 64 chars, but 'Z' is not a hex digit
    );
    fs.writeFileSync(
      path.join(hoisted.userData.value, "db.key"),
      Buffer.from("anything-the-mock-decrypts"),
    );
    expect(() => getOrCreateDbKey()).toThrow(/non-hex characters/);
    expect(() => getOrCreateDbKey()).not.toThrow(EncryptionUnavailableError);
  });

  it("getOrCreateDbKey surfaces underlying decrypt errors (not as EncryptionUnavailableError)", () => {
    // E.g. user copied userData to a different machine — DPAPI /
    // Keychain on the new machine can't decrypt the blob. This is
    // semantically a corrupted-key scenario, NOT an
    // encryption-unavailable scenario, so it must bubble up as a
    // plain Error and appState.ts must refuse the unencrypted
    // fallback.
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error("Decryption failed: invalid key");
    });
    fs.writeFileSync(
      path.join(hoisted.userData.value, "db.key"),
      Buffer.from("wrapped-but-wrong-machine"),
    );
    expect(() => getOrCreateDbKey()).toThrow(/Decryption failed/);
    expect(() => getOrCreateDbKey()).not.toThrow(EncryptionUnavailableError);
  });

  it("write is atomic: no .tmp file is left behind on the success path", () => {
    getOrCreateDbKey();
    const dirEntries = fs.readdirSync(hoisted.userData.value);
    expect(dirEntries).toContain("db.key");
    expect(dirEntries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("_deleteDbKeyForTests removes the on-disk key file", () => {
    getOrCreateDbKey();
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(
      true,
    );
    _deleteDbKeyForTests();
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(
      false,
    );
    // And the next getOrCreateDbKey call generates a fresh key.
    const k2 = getOrCreateDbKey();
    expect(k2).toHaveLength(DB_KEY_HEX_LEN);
  });

  it("creates the userData directory if it does not exist", () => {
    // Reassign to a path that does not yet exist on disk to pin
    // the mkdir branch.
    fs.rmSync(hoisted.userData.value, { recursive: true });
    expect(fs.existsSync(hoisted.userData.value)).toBe(false);
    getOrCreateDbKey();
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(
      true,
    );
  });

  it("DB_KEY_HEX_LEN matches the Rust side constant", () => {
    // Pin the cross-language invariant. If the Rust side changes
    // DB_KEY_HEX_LEN (e.g. moves to 384-bit keys), this assertion
    // also needs to update.
    expect(DB_KEY_HEX_LEN).toBe(64);
  });
});

// =====================================================================
// Vault-aware async path
// =====================================================================
//
// The async `getOrCreateDbKeyAsync` integrates the password vault as a
// fallback when `safeStorage` is unavailable. These tests pin the new
// dispatch matrix; the sync `getOrCreateDbKey` tests above remain the
// regression suite for the safeStorage-only path.
describe("getOrCreateDbKeyAsync (vault-aware path)", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tessera-dbkey-async-test-"),
    );
    hoisted.userData.value = userDataDir;
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true);
    safeStorageMock.encryptString.mockImplementation((plain: string) =>
      Buffer.from(`enc:${plain}`),
    );
    safeStorageMock.decryptString.mockImplementation((blob: Buffer) => {
      const s = blob.toString("utf8");
      if (!s.startsWith("enc:")) {
        throw new Error("Decryption failed: bad ciphertext");
      }
      return s.slice("enc:".length);
    });
    // Re-import passwordVault freshly so test isolation around the
    // cached vault key is robust. We always start with the vault
    // locked.
    const pv = await import("../passwordVault");
    pv._setCachedKeyForTests(null);
  });

  afterEach(async () => {
    const pv = await import("../passwordVault");
    pv._setCachedKeyForTests(null);
    pv._setSaltPathForTests(null);
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
    vi.clearAllMocks();
  });

  /**
   * Helper: pre-seed a valid vault salt + cached AES-256-GCM key so
   * `encryptWithPasswordKey` / `decryptWithPasswordKey` work
   * without going through the BrowserWindow prompt. The cached key
   * here is a fixed test value, not derived from a password — we
   * only need crypto consistency, not the PBKDF2 work factor.
   */
  async function activateVault(): Promise<void> {
    const pv = await import("../passwordVault");
    // Pin the salt path to a known location so the password vault
    // operates against our temp dir (`getOrCreateSalt` runs inside
    // `encryptWithPasswordKey`).
    pv._setSaltPathForTests(path.join(userDataDir, "vault-salt.bin"));
    pv._setCachedKeyForTests(Buffer.alloc(32, 0xab));
  }

  it("uses safeStorage when it is available, ignoring vault state", async () => {
    const { getOrCreateDbKeyAsync } = await import("../dbKey");
    await activateVault();
    const hex = await getOrCreateDbKeyAsync();
    expect(hex).toHaveLength(DB_KEY_HEX_LEN);
    // Persisted via safeStorage (mock prepends "enc:") — NOT via
    // password vault (which would start with the 'TSPV' magic).
    const blob = fs.readFileSync(path.join(userDataDir, "db.key"));
    expect(blob.toString("utf8")).toBe(`enc:${hex}`);
    expect(blob.subarray(0, 4).toString("ascii")).not.toBe("TSPV");
  });

  it("falls back to the password vault when safeStorage is unavailable AND vault is active", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await activateVault();
    const { getOrCreateDbKeyAsync } = await import("../dbKey");
    const hex = await getOrCreateDbKeyAsync();
    expect(hex).toHaveLength(DB_KEY_HEX_LEN);
    // Persisted with the TSPV magic, i.e. via the password-vault
    // path, not safeStorage.
    const blob = fs.readFileSync(path.join(userDataDir, "db.key"));
    expect(blob.subarray(0, 4).toString("ascii")).toBe("TSPV");
    // And safeStorage was never asked to encrypt — the dispatch
    // went straight to the vault path because safeStorage is
    // unavailable.
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
  });

  it("reads back a vault-wrapped key on subsequent calls", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await activateVault();
    const { getOrCreateDbKeyAsync } = await import("../dbKey");
    const a = await getOrCreateDbKeyAsync();
    const b = await getOrCreateDbKeyAsync();
    expect(a).toBe(b);
    // Second call did NOT regenerate or hit safeStorage.
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled();
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it("throws EncryptionUnavailableError when neither safeStorage nor vault is available AND db.key is absent", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    // Vault deliberately NOT activated.
    const { getOrCreateDbKeyAsync, EncryptionUnavailableError } =
      await import("../dbKey");
    await expect(getOrCreateDbKeyAsync()).rejects.toBeInstanceOf(
      EncryptionUnavailableError,
    );
    // No key file written on the failure path.
    expect(fs.existsSync(path.join(userDataDir, "db.key"))).toBe(false);
  });

  it("refuses to read a TSPV-wrapped key when the vault is locked (encrypted DB unrecoverable)", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await activateVault();
    const { getOrCreateDbKeyAsync } = await import("../dbKey");
    // Seed a vault-wrapped key on disk.
    await getOrCreateDbKeyAsync();
    expect(
      fs
        .readFileSync(path.join(userDataDir, "db.key"))
        .subarray(0, 4)
        .toString("ascii"),
    ).toBe("TSPV");
    // Now lock the vault and re-read.
    const pv = await import("../passwordVault");
    pv._setCachedKeyForTests(null);
    // Must throw a plain Error (NOT EncryptionUnavailableError) so
    // appState.ts refuses to bring up the bridge. Silent fallback
    // to "regenerate a fresh key" would render the existing
    // encrypted tessera.db permanently unreadable.
    const { EncryptionUnavailableError } = await import("../dbKey");
    await expect(getOrCreateDbKeyAsync()).rejects.toThrow(
      /vault.*not unlocked/i,
    );
    await expect(getOrCreateDbKeyAsync()).rejects.not.toBeInstanceOf(
      EncryptionUnavailableError,
    );
  });

  it("re-throws WrongVaultPasswordError as a plain Error so appState refuses the unencrypted fallback", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await activateVault();
    const { getOrCreateDbKeyAsync, EncryptionUnavailableError } =
      await import("../dbKey");
    // Seed a vault-wrapped key using the test vault key.
    await getOrCreateDbKeyAsync();
    // Now swap the cached vault key for a different one — the
    // existing TSPV blob now fails GCM auth.
    const pv = await import("../passwordVault");
    pv._setCachedKeyForTests(Buffer.alloc(32, 0xcd));
    await expect(getOrCreateDbKeyAsync()).rejects.toThrow(
      /Failed to decrypt database key with the supplied vault password/i,
    );
    await expect(getOrCreateDbKeyAsync()).rejects.not.toBeInstanceOf(
      EncryptionUnavailableError,
    );
  });

  it("dispatches a safeStorage blob to safeStorage even when the vault is active (mixed-history install)", async () => {
    // Real-world scenario: user originally had safeStorage (so
    // db.key was wrapped via safeStorage), then on this launch
    // both safeStorage AND the vault are available. We must read
    // the existing blob via safeStorage (its TSPV magic is absent)
    // and not try to dispatch it to the vault decryption path.
    const { getOrCreateDbKeyAsync } = await import("../dbKey");
    // Initial bootstrap with safeStorage (vault inactive).
    const hexInitial = await getOrCreateDbKeyAsync();
    // Now activate the vault too, then re-read.
    await activateVault();
    const hexRead = await getOrCreateDbKeyAsync();
    expect(hexRead).toBe(hexInitial);
    // The blob is still safeStorage-shaped (no TSPV magic).
    const blob = fs.readFileSync(path.join(userDataDir, "db.key"));
    expect(blob.subarray(0, 4).toString("ascii")).not.toBe("TSPV");
  });

  it("writes vault-wrapped key atomically (no .tmp leak on success)", async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await activateVault();
    const { getOrCreateDbKeyAsync } = await import("../dbKey");
    await getOrCreateDbKeyAsync();
    const dirEntries = fs.readdirSync(userDataDir);
    expect(dirEntries).toContain("db.key");
    expect(dirEntries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("plaintext-to-encrypted migration: generates a key when tessera.db exists but db.key does not", async () => {
    // The Rust bridge handles the actual rekey via sqlcipher_export
    // on the next initBridge call; the JS side just needs to
    // generate and persist a wrapping key. This test pins that
    // the JS contract for the migration scenario is "behave the
    // same as a fresh install" — i.e. generate, wrap with whichever
    // path is active, persist atomically.
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    await activateVault();
    // Simulate an existing plaintext tessera.db file.
    fs.writeFileSync(
      path.join(userDataDir, "tessera.db"),
      Buffer.from("fake-sqlite-header"),
    );
    const { getOrCreateDbKeyAsync } = await import("../dbKey");
    const hex = await getOrCreateDbKeyAsync();
    expect(hex).toHaveLength(DB_KEY_HEX_LEN);
    // db.key now exists, wrapped via vault (TSPV magic).
    const blob = fs.readFileSync(path.join(userDataDir, "db.key"));
    expect(blob.subarray(0, 4).toString("ascii")).toBe("TSPV");
    // tessera.db is left untouched on this side — the Rust bridge
    // will rekey it on the next initBridge call.
    expect(fs.existsSync(path.join(userDataDir, "tessera.db"))).toBe(true);
  });
});
