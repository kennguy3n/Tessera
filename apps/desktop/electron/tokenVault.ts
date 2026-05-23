import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  TOKEN_VAULT_LABEL,
  decryptFromVault as sharedDecryptFromVault,
  encryptForVault as sharedEncryptForVault,
} from "./vaultCrypto";
// Re-exported from `vaultCrypto.ts` so existing callers (and the
// secretsVault module before this PR) can keep importing
// `encryptionUnavailableReason` from `./tokenVault`. The single
// source of truth lives in `vaultCrypto.ts`.
export { encryptionUnavailableReason } from "./vaultCrypto";

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
 * Encrypt `plaintext` for the OAuth-token vault. Thin wrapper around
 * the shared dispatch in `vaultCrypto.ts`.
 */
function encryptForVault(plaintext: string): Buffer {
  return sharedEncryptForVault(plaintext);
}

/**
 * Decrypt an OAuth-token vault blob. Thin wrapper around the shared
 * dispatch in `vaultCrypto.ts` — passes the `TOKEN_VAULT_LABEL` so
 * recovery-error wording references "Vault" and the right directory
 * to delete on a keyring-lost recovery path.
 */
function decryptFromVault(blob: Buffer): string {
  return sharedDecryptFromVault(blob, TOKEN_VAULT_LABEL);
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
