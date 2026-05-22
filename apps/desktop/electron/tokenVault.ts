import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  decryptWithPasswordKey,
  encryptWithPasswordKey,
  isPasswordVaultBlob,
  passwordVaultActive,
} from "./passwordVault";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
}

const VAULT_DIR = (): string => path.join(app.getPath("userData"), "token-vault");

function ensureVaultDir(): void {
  const dir = VAULT_DIR();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Build a human-readable error explaining why the OS keyring is unavailable.
 *
 * On Linux this commonly means the user is on a minimal or headless desktop
 * with no Secret Service-compatible daemon running (e.g. `gnome-keyring` /
 * `kwallet5-daemon`) — Electron's safeStorage falls back to `basic_text` only
 * when one of those is detected, and refuses to fall back to plaintext.
 *
 * On macOS this would mean Keychain is locked or sandboxed away (very rare);
 * on Windows it would mean DPAPI is unavailable (also very rare).
 */
export function encryptionUnavailableReason(): string {
  switch (process.platform) {
    case "linux":
      return (
        "Encryption not available — no OS keyring daemon detected. " +
        "Install and start one of: gnome-keyring-daemon (GNOME / Ubuntu), " +
        "kwallet5-daemon (KDE), or pass an X session manager that exposes the " +
        "Secret Service D-Bus API. The Debian/Ubuntu packages are " +
        "`gnome-keyring` and `libsecret-1-0`."
      );
    case "darwin":
      return "Encryption not available — Keychain is locked or inaccessible.";
    case "win32":
      return "Encryption not available — Windows DPAPI is unavailable.";
    default:
      return "Encryption not available — unsupported platform.";
  }
}

/**
 * Encrypt `plaintext` using whichever vault mode is active. Prefers
 * safeStorage when available; falls through to the password-derived
 * vault if `initPasswordVaultIfNeeded` cached a key at app startup.
 *
 * Throws if NEITHER mode is available — refusing to store secrets
 * unencrypted is the whole point.
 */
function encryptForVault(plaintext: string): Buffer {
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
 * - `TSPV` blob + active password vault → decrypt with cached key.
 * - `TSPV` blob + no active password vault → throw (we cannot decrypt).
 * - non-`TSPV` blob + safeStorage available → decrypt via safeStorage.
 * - non-`TSPV` blob + no safeStorage → throw with the actionable
 *   recovery message.
 */
function decryptFromVault(blob: Buffer): string {
  if (isPasswordVaultBlob(blob)) {
    if (!passwordVaultActive()) {
      throw new Error(
        `Vault blob is password-encrypted but no password is cached. ${encryptionUnavailableReason()}`,
      );
    }
    return decryptWithPasswordKey(blob);
  }
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(blob);
  }
  // Mixed-format hazard: the file is a safeStorage blob from a
  // previous session, but the user's keyring is no longer available.
  // We CANNOT migrate it to password format on the fly because we
  // can't decrypt it without the keyring. Surface the actionable
  // recovery instructions rather than failing silently.
  throw new Error(
    `Vault file is encrypted with the OS keyring but the keyring is no longer available. Restore keyring access (${encryptionUnavailableReason()}) or delete the vault directory to re-authenticate from scratch (you will need to re-enter API keys and re-authorize OAuth providers).`,
  );
}

const VALID_PROVIDER_RE = /^[a-zA-Z0-9_-]+$/;

function validateProvider(provider: string): void {
  if (!VALID_PROVIDER_RE.test(provider)) {
    throw new Error(`Invalid provider name: ${provider}`);
  }
}

function vaultPath(provider: string): string {
  validateProvider(provider);
  return path.join(VAULT_DIR(), `${provider}.enc`);
}

export function storeTokens(provider: string, tokens: StoredTokens): void {
  ensureVaultDir();
  const json = JSON.stringify(tokens);
  const encrypted = encryptForVault(json);
  fs.writeFileSync(vaultPath(provider), encrypted);
}

export function getTokens(provider: string): StoredTokens | null {
  const fp = vaultPath(provider);
  if (!fs.existsSync(fp)) return null;
  const encrypted = fs.readFileSync(fp);
  const json = decryptFromVault(encrypted);
  return JSON.parse(json) as StoredTokens;
}

export function deleteTokens(provider: string): void {
  const fp = vaultPath(provider);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
  }
}

export function hasTokens(provider: string): boolean {
  return fs.existsSync(vaultPath(provider));
}

export function listProviders(): string[] {
  ensureVaultDir();
  const dir = VAULT_DIR();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".enc"))
    .map((f) => f.replace(".enc", ""));
}
