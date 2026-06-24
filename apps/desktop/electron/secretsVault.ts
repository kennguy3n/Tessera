import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  SECRETS_VAULT_LABEL,
  decryptFromVault as sharedDecryptFromVault,
  encryptForVault as sharedEncryptForVault,
} from "./vaultCrypto";

// Vault for arbitrary named secrets (e.g. external LLM provider
// API keys). Stored alongside the OAuth `token-vault` but in a
// distinct directory so a provider OAuth blob can never collide
// with a free-form secret key. Both directories use the same
// encryption fallback chain — implemented once in `vaultCrypto.ts`:
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

const SECRET_DIR = (): string =>
  path.join(app.getPath("userData"), "secret-vault");

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
 * Encrypt `plaintext` for the secrets vault. Thin wrapper around the
 * shared dispatch in `vaultCrypto.ts`.
 */
function encryptSecret(plaintext: string): Buffer {
  return sharedEncryptForVault(plaintext);
}

/**
 * Decrypt a secrets-vault blob. Thin wrapper around the shared
 * dispatch in `vaultCrypto.ts` — passes the `SECRETS_VAULT_LABEL` so
 * recovery-error wording references "Secret" and the right directory
 * to delete on a keyring-lost recovery path.
 */
function decryptSecret(blob: Buffer): string {
  return sharedDecryptFromVault(blob, SECRETS_VAULT_LABEL);
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
