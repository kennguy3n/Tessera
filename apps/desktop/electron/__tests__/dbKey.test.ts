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

  it("getOrCreateDbKey throws when safeStorage is unavailable", () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false);
    expect(() => getOrCreateDbKey()).toThrow(/Encryption not available/);
    // And we did not write a key file on the failure path.
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(false);
  });

  it("getOrCreateDbKey throws on zero-byte key file", () => {
    // Half-written first launch — the temp-and-rename path makes
    // this unlikely in practice, but a corrupted FS could still
    // produce one. We must NOT silently regenerate because that
    // would render the matching tessera.db permanently unreadable.
    fs.writeFileSync(path.join(hoisted.userData.value, "db.key"), Buffer.alloc(0));
    expect(() => getOrCreateDbKey()).toThrow(/empty/);
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled();
  });

  it("getOrCreateDbKey throws on key file that decrypts to wrong length", () => {
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
  });

  it("getOrCreateDbKey surfaces underlying decrypt errors", () => {
    // E.g. user copied userData to a different machine — DPAPI /
    // Keychain on the new machine can't decrypt the blob.
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error("Decryption failed: invalid key");
    });
    fs.writeFileSync(
      path.join(hoisted.userData.value, "db.key"),
      Buffer.from("wrapped-but-wrong-machine"),
    );
    expect(() => getOrCreateDbKey()).toThrow(/Decryption failed/);
  });

  it("write is atomic: no .tmp file is left behind on the success path", () => {
    getOrCreateDbKey();
    const dirEntries = fs.readdirSync(hoisted.userData.value);
    expect(dirEntries).toContain("db.key");
    expect(dirEntries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });

  it("_deleteDbKeyForTests removes the on-disk key file", () => {
    getOrCreateDbKey();
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(true);
    _deleteDbKeyForTests();
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(false);
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
    expect(fs.existsSync(path.join(hoisted.userData.value, "db.key"))).toBe(true);
  });

  it("DB_KEY_HEX_LEN matches the Rust side constant", () => {
    // Pin the cross-language invariant. If the Rust side changes
    // DB_KEY_HEX_LEN (e.g. moves to 384-bit keys), this assertion
    // also needs to update.
    expect(DB_KEY_HEX_LEN).toBe(64);
  });
});
