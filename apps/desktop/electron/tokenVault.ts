import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

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
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(encryptionUnavailableReason());
  }
  const json = JSON.stringify(tokens);
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(vaultPath(provider), encrypted);
}

export function getTokens(provider: string): StoredTokens | null {
  const fp = vaultPath(provider);
  if (!fs.existsSync(fp)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(encryptionUnavailableReason());
  }
  const encrypted = fs.readFileSync(fp);
  const json = safeStorage.decryptString(encrypted);
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
