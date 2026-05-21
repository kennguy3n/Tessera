import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { encryptionUnavailableReason } from "./tokenVault";

// Vault for arbitrary named secrets (e.g. external LLM provider
// API keys). Stored alongside the OAuth `token-vault` but in a
// distinct directory so a provider OAuth blob can never collide
// with a free-form secret key. Both directories use the same
// `safeStorage` encryption, which delegates to:
//   - macOS Keychain (`darwin`)
//   - Windows DPAPI (`win32`)
//   - Secret Service / libsecret on Linux.
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

export function storeSecret(key: string, value: string): void {
  ensureSecretDir();
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(encryptionUnavailableReason());
  }
  const encrypted = safeStorage.encryptString(value);
  fs.writeFileSync(secretPath(key), encrypted);
}

export function getSecret(key: string): string | null {
  const fp = secretPath(key);
  if (!fs.existsSync(fp)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(encryptionUnavailableReason());
  }
  const encrypted = fs.readFileSync(fp);
  return safeStorage.decryptString(encrypted);
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
