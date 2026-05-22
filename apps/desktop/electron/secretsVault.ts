import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { encryptionUnavailableReason } from "./tokenVault";
import {
  decryptWithPasswordKey,
  encryptWithPasswordKey,
  isPasswordVaultBlob,
  passwordVaultActive,
} from "./passwordVault";

// Vault for arbitrary named secrets (e.g. external LLM provider
// API keys). Stored alongside the OAuth `token-vault` but in a
// distinct directory so a provider OAuth blob can never collide
// with a free-form secret key. Both directories use the same
// encryption fallback chain:
//   1. `safeStorage` (OS keyring) when available
//      - macOS Keychain (`darwin`)
//      - Windows DPAPI (`win32`)
//      - Secret Service / libsecret on Linux
//   2. Password-derived AES-256-GCM when safeStorage is unavailable
//      (see `passwordVault.ts` — a one-time PBKDF2 prompt at app
//      startup unlocks the vault for the whole session).
//
// Secrets are referenced by `key`, a stable string the renderer
// stores in plain config (e.g. `"tessera.external_provider.openai"`).
// The actual API key never leaves this module unencrypted.

const SECRET_DIR = (): string => path.join(app.getPath("userData"), "secret-vault");

const VALID_KEY_RE = /^[A-Za-z0-9._-]+$/;

function validateKey(key: string): void {
  if (!VALID_KEY_RE.test(key)) {
    throw new Error(
      `Invalid secret key: ${key}. Allowed: alphanumerics, dot, dash, underscore.`,
    );
  }
}

function secretPath(key: string): string {
  validateKey(key);
  return path.join(SECRET_DIR(), `${key}.enc`);
}

function ensureSecretDir(): void {
  const dir = SECRET_DIR();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Encrypt with safeStorage if available, else with the password-derived
 * vault (set up by `initPasswordVaultIfNeeded` at app startup). Refuses
 * to write secrets when no encryption mode is available — refusing the
 * write is preferable to dropping plaintext API keys on disk.
 */
function encryptSecret(plaintext: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext);
  }
  if (passwordVaultActive()) {
    return encryptWithPasswordKey(plaintext);
  }
  throw new Error(encryptionUnavailableReason());
}

/**
 * Decrypt by sniffing the blob format. See `tokenVault.decryptFromVault`
 * for the full reasoning — the same dispatch rules apply here.
 */
function decryptSecret(blob: Buffer): string {
  if (isPasswordVaultBlob(blob)) {
    if (!passwordVaultActive()) {
      throw new Error(
        `Secret blob is password-encrypted but no password is cached. ${encryptionUnavailableReason()}`,
      );
    }
    return decryptWithPasswordKey(blob);
  }
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(blob);
  }
  throw new Error(
    `Secret file is encrypted with the OS keyring but the keyring is no longer available. Restore keyring access (${encryptionUnavailableReason()}) or delete the secret-vault directory to re-enter API keys.`,
  );
}

export function storeSecret(key: string, value: string): void {
  ensureSecretDir();
  const encrypted = encryptSecret(value);
  fs.writeFileSync(secretPath(key), encrypted);
}

export function getSecret(key: string): string | null {
  const fp = secretPath(key);
  if (!fs.existsSync(fp)) return null;
  const encrypted = fs.readFileSync(fp);
  return decryptSecret(encrypted);
}

export function deleteSecret(key: string): void {
  const fp = secretPath(key);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
  }
}

export function hasSecret(key: string): boolean {
  return fs.existsSync(secretPath(key));
}
