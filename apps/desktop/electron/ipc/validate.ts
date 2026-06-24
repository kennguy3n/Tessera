/**
 * Shared input validators for IPC handlers.
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
  // Substrate-only providers (served exclusively by the v2
  // `connector_framework` bridge; no legacy `tessera_connectors`
  // fallback exists for these).
  "hubspot",
  "slack",
  "email",
  "github",
  // Whole-account, read-only OAuth2 providers exposed from the
  // upstream `connectors` crate via the v2 bridge. Each syncs the
  // entire account the granted token can see (no per-target config),
  // so they wire end-to-end through the standard add-a-connector path
  // (see docs/CONNECTORS.md).
  "dropbox",
  "box",
  "linear",
  "miro",
  // Per-target / non-OAuth2 providers (see docs/CONNECTORS.md and
  // shared/connectorConfig.ts). These need extra connect-time inputs —
  // a target id (Asana project, Teams team/channel, GitLab project)
  // and/or a non-OAuth2 credential (Trello API key+token, GitLab
  // personal access token) — collected via the `buildAuthConfig` seam.
  "asana",
  "gitlab",
  "teams",
  "trello",
  // Tranche 3: read-only, account-wide OAuth2 providers from the
  // upstream `connectors` crate. Each reads the whole account the
  // granted (read-only) token can see using the connector's own
  // account-wide defaults (Zoom user "me", Google Calendar "primary",
  // Google Docs/Sheets the Drive change feed, Google Meet conference
  // records, SharePoint the root site document library) — no per-target
  // config is collected, so they connect via the standard OAuth2 path.
  "zoom",
  "google_calendar",
  "google_docs",
  "google_sheets",
  "google_meet",
  "sharepoint",
  // Tranche 4: per-target / per-resource providers (see
  // docs/CONNECTORS.md and shared/connectorConfig.ts). Each needs a
  // specific target id (Discord channel, Bitbucket workspace+repo,
  // Airtable base+table, Monday board) and most use a non-OAuth2
  // credential — a Discord bot token (sent with the `Bot` auth
  // scheme), a Bitbucket repository access token, or an Airtable
  // personal access token. Monday keeps the read-only OAuth2 browser
  // grant (`boards:read`).
  "discord",
  "bitbucket",
  "airtable",
  "monday",
  // Tranche 5: read-only support / CRM providers from the upstream
  // `connectors` crate (see docs/CONNECTORS.md and
  // shared/connectorConfig.ts). All three use the read-only OAuth2
  // browser grant. ClickUp is per-workspace (collects a Workspace/Team
  // ID); Intercom syncs the whole workspace's conversations (optional
  // regional API host); Salesforce reads Cases from a single org and
  // requires the My Domain instance URL.
  "clickup",
  "intercom",
  "salesforce",
  // Tranche 6: per-instance (per-subdomain) OAuth providers wired on the
  // `instanceUrls` seam (see shared/connectorConfig.ts and
  // electron/ipc/connectors/providerOAuth.ts). Their authorize/token
  // endpoints live on the tenant's own subdomain and are derived per
  // connection from a validated subdomain collected in the connect
  // modal (host-pinned for SSRF safety). Zendesk reads tickets via the
  // global read-only `read` scope; ServiceNow reads incidents from the
  // Table API with a role-scoped (scope-less) OAuth token.
  "zendesk",
  "servicenow",
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
    throw new Error(`${name} has too many entries (${val.length} > ${maxLen})`);
  }
  return val.map((v, i) =>
    assertString(v, `${name}[${i}]`, {
      maxLen: options.itemMaxLen,
      allowEmpty: true,
    }),
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
    throw new Error(
      `${name} is not writable: ${dir} (${(e as Error).message})`,
    );
  }
}
