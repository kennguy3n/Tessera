/**
 * Shared input validators for IPC handlers ( Task 22).
 *
 * Every IPC channel that accepts caller-controlled input runs each
 * argument through one of these validators. The validators throw an
 * `Error` on invalid input rather than returning a result type so a
 * misbehaving renderer's IPC call rejects with a descriptive message
 * without the handler ever touching the bridge or filesystem.
 *
 * Rules of thumb:
 *   - String length caps prevent renderer bugs from streaming
 *     gigabytes through the IPC boundary (Electron's IPC is async
 *     but a 100 MB string in a single payload still consumes RAM
 *     while it serialises).
 *   - UUID validation rejects ID parameters with anything other than
 *     a well-formed v4 UUID. The Rust bridge already validates IDs,
 *     but defending in depth at the IPC boundary keeps malformed
 *     IDs from reaching the SQL driver at all.
 *   - Provider name validation rejects any provider that is not in
 *     `KNOWN_PROVIDERS`. New connectors must be added here AND in
 *     the connector registry.
 */

import * as path from "path";
import { constants as fsConstants } from "fs";
import * as fsp from "fs/promises";
import { isSafeExportPath } from "../exportPathSafety";

/** Hard upper bound for any string parameter on an IPC call. */
export const DEFAULT_MAX_STRING_LEN = 1_000_000;

/** Providers that may be passed to connector IPC handlers. */
export const KNOWN_PROVIDERS = [
  "google_drive",
  "onedrive",
  "notion",
  "jira",
  "confluence",
  "figma",
] as const;
export type KnownProvider = (typeof KNOWN_PROVIDERS)[number];

/** Assert a value is a non-empty string with a length cap. */
export function assertString(
  val: unknown,
  name: string,
  options: { maxLen?: number; minLen?: number; allowEmpty?: boolean } = {},
): string {
  const maxLen = options.maxLen ?? DEFAULT_MAX_STRING_LEN;
  const minLen = options.minLen ?? 0;
  if (typeof val !== "string") {
    throw new Error(`${name} must be a string (got ${typeof val})`);
  }
  if (!options.allowEmpty && val.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  if (val.length < minLen) {
    throw new Error(`${name} must be at least ${minLen} characters`);
  }
  if (val.length > maxLen) {
    throw new Error(
      `${name} exceeds maximum length (${val.length} > ${maxLen})`,
    );
  }
  return val;
}

/** Optional variant of {@link assertString}. */
export function assertOptionalString(
  val: unknown,
  name: string,
  options: { maxLen?: number; minLen?: number } = {},
): string | null {
  if (val === null || val === undefined) return null;
  return assertString(val, name, { ...options, allowEmpty: true });
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Assert a value is a valid v1-5 UUID string. */
export function assertUuid(val: unknown, name: string): string {
  const s = assertString(val, name, { maxLen: 64 });
  if (!UUID_PATTERN.test(s)) {
    throw new Error(`${name} must be a valid UUID (got ${s})`);
  }
  return s;
}

/**
 * Looser ID assertion — many Rust bridge identifiers are UUIDs but
 * some are slugs / opaque hashes. Caps length at 128 and rejects
 * obvious shell metacharacters.
 */
export function assertId(val: unknown, name: string): string {
  const s = assertString(val, name, { maxLen: 128 });
  if (!/^[A-Za-z0-9_\-:.]+$/.test(s)) {
    throw new Error(
      `${name} must contain only alphanumerics, '_', '-', ':' or '.'`,
    );
  }
  return s;
}

/** Assert a provider name is one of the registered connectors. */
export function assertProvider(
  val: unknown,
  name: string = "provider",
): KnownProvider {
  const s = assertString(val, name, { maxLen: 64 });
  if (!(KNOWN_PROVIDERS as readonly string[]).includes(s)) {
    throw new Error(
      `Unknown provider: ${s} (allowed: ${KNOWN_PROVIDERS.join(", ")})`,
    );
  }
  return s as KnownProvider;
}

/**
 * Assert a path is within the safe export allowlist (Downloads,
 * Documents, Desktop, home, userData, temp). Wraps the existing
 * `isSafeExportPath` so handler code can call a single function and
 * get a descriptive throw on rejection.
 */
export function assertSafePath(
  val: unknown,
  roots: string[],
  name = "path",
): string {
  const s = assertString(val, name, { maxLen: 4096 });
  if (!path.isAbsolute(s)) {
    throw new Error(`${name} must be an absolute path (got ${s})`);
  }
  if (!isSafeExportPath(s, roots)) {
    throw new Error(
      `${name} is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${s}`,
    );
  }
  return s;
}

/** Assert a value is a finite number within an optional range. */
export function assertNumber(
  val: unknown,
  name: string,
  options: { min?: number; max?: number; integer?: boolean } = {},
): number {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`${name} must be a finite number (got ${val})`);
  }
  if (options.integer && !Number.isInteger(val)) {
    throw new Error(`${name} must be an integer (got ${val})`);
  }
  if (options.min !== undefined && val < options.min) {
    throw new Error(`${name} must be >= ${options.min} (got ${val})`);
  }
  if (options.max !== undefined && val > options.max) {
    throw new Error(`${name} must be <= ${options.max} (got ${val})`);
  }
  return val;
}

/** Assert a value is a boolean. */
export function assertBoolean(val: unknown, name: string): boolean {
  if (typeof val !== "boolean") {
    throw new Error(`${name} must be a boolean (got ${typeof val})`);
  }
  return val;
}

/** Assert a value is an array of strings. */
export function assertStringArray(
  val: unknown,
  name: string,
  options: { maxLen?: number; itemMaxLen?: number } = {},
): string[] {
  if (!Array.isArray(val)) {
    throw new Error(`${name} must be an array of strings`);
  }
  const maxLen = options.maxLen ?? 10_000;
  if (val.length > maxLen) {
    throw new Error(
      `${name} has too many entries (${val.length} > ${maxLen})`,
    );
  }
  return val.map((v, i) =>
    assertString(v, `${name}[${i}]`, { maxLen: options.itemMaxLen, allowEmpty: true }),
  );
}

/** Assert a directory exists and is writable. */
export async function assertDirectoryWritable(
  dir: string,
  name = "directory",
): Promise<void> {
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.access(dir, fsConstants.W_OK);
  } catch (e) {
    throw new Error(`${name} is not writable: ${dir} (${(e as Error).message})`);
  }
}
