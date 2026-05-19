import { safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
}

const VAULT_DIR = (): string => path.join(app.getPath("userData"), "token-vault");

function ensureVaultDir(): void {
  const dir = VAULT_DIR();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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
    throw new Error("Encryption not available — cannot store tokens securely");
  }
  const json = JSON.stringify(tokens);
  const encrypted = safeStorage.encryptString(json);
  fs.writeFileSync(vaultPath(provider), encrypted);
}

export function getTokens(provider: string): StoredTokens | null {
  const fp = vaultPath(provider);
  if (!fs.existsSync(fp)) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Encryption not available — cannot read tokens");
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
