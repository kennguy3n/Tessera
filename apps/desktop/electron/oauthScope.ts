/**
 * OAuth scope governance.
 *
 * Goal: surface a real discrepancy between the scopes Tessera asks
 * for at authorization time and the scopes the provider actually
 * grants, and refuse to call connector-sync APIs that would silently
 * fail when a critical scope is missing.
 *
 * Why bother
 * ----------
 * Every OAuth-2.0 provider Tessera integrates with (Google Drive,
 * OneDrive, Atlassian Jira/Confluence, Notion, Figma) supports
 * *consent narrowing*: the user can untick scopes on the consent
 * screen, and the access token comes back with a strictly smaller
 * scope set than was requested. Without scope tracking the
 * connector sync proceeds, hits an API call that needs the
 * untick'd scope, and returns a 403 — which the user reads as
 * "Tessera is broken" rather than "I unticked the wrong box".
 *
 * Behaviour
 * ---------
 *   1. Every OAuth token exchange / refresh returns a parsed
 *      `scope` string. This module records the granted scopes
 *      alongside the token (see `StoredTokens.scopes` in
 *      `tokenVault.ts`).
 *   2. At sync time the connector calls
 *      `assertScopesGranted(provider, requiredScopes)`. If any
 *      required scope is missing from the granted set, we throw a
 *      structured `MissingScopeError` that surfaces a precise
 *      message to the renderer ("Drive connector needs
 *      drive.readonly; you only granted drive.metadata.readonly —
 *      re-authorize to fix").
 *   3. The renderer's connector card calls
 *      `compareRequestedVsGranted(provider)` on mount and shows a
 *      yellow warning if the user narrowed scopes; a button drives
 *      a re-auth flow.
 *
 * Parsing
 * -------
 * The OAuth spec (RFC 6749 §3.3) says the `scope` parameter is
 * "expressed as a list of space-delimited, case-sensitive strings".
 * Some providers return comma-separated values instead (looking at
 * you, Figma), so `parseScopeString` accepts both.
 *
 * Scope comparison is case-sensitive (spec) but order-insensitive
 * and duplicate-tolerant. We normalise to a `Set<string>` for
 * comparison.
 */

import type { ProviderOAuthConfig } from "./ipc/connectors/providerOAuth";

/**
 * Structured error thrown when a required scope is missing from
 * the granted set. Caught by the connector sync layer and surfaced
 * to the renderer with the missing-scope list intact.
 */
export class MissingScopeError extends Error {
  readonly provider: string;
  readonly missing: string[];
  readonly granted: string[];

  constructor(provider: string, missing: string[], granted: string[]) {
    super(
      `OAuth provider "${provider}" is missing required scope(s): ` +
        `${missing.join(", ")}. Granted scopes: ${granted.join(", ") || "(none)"}.`,
    );
    this.name = "MissingScopeError";
    this.provider = provider;
    this.missing = [...missing];
    this.granted = [...granted];
    // Restore prototype chain so `instanceof MissingScopeError` works
    // across the TS-down-target compile (`__extends` helper otherwise
    // breaks `instanceof` checks for native `Error` subclasses).
    Object.setPrototypeOf(this, MissingScopeError.prototype);
  }
}

/**
 * Parse an OAuth-2.0 `scope` response value into a normalised list.
 *
 * The spec says space-delimited; Figma returns comma-delimited;
 * some providers' tokens include both (e.g. a `scope=` query plus
 * a `scopes=` body field). We split on any of {space, comma,
 * newline, tab} and drop empties to be robust against all
 * variants.
 */
export function parseScopeString(value: string | null | undefined): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).filter((s) => s.length > 0);
}

/**
 * OAuth 2.0 / OIDC *meta-scopes* — scopes that control protocol
 * behaviour rather than granting access to a resource API:
 *
 *   - `offline_access` (RFC 6749 §3.3 / OIDC Core §11) controls
 *     whether a refresh token is issued. It is NOT an API
 *     permission, and several providers (notably Atlassian
 *     `auth.atlassian.com` and Microsoft Identity Platform v2.0)
 *     do NOT echo it back in the token response's `scope` field
 *     even when it was requested and a refresh token was actually
 *     issued. Treating it as a required scope here would cause
 *     `assertScopesGranted` to throw `MissingScopeError` after
 *     every Jira / Confluence / OneDrive sync and surface a
 *     bogus re-auth banner to the user even though the integration
 *     is fully working.
 *
 * We strip meta-scopes from the *required* set at the comparison
 * boundary (`assertScopesGranted`, `compareScopes`). They remain
 * in `getRequestedScopes(config)` because they ARE part of the
 * authorization request — we just don't validate the provider
 * echoed them back. If the refresh token is genuinely missing,
 * the refresh-token call will fail elsewhere and surface its own
 * error to the user — that is the right place to detect a real
 * `offline_access` problem, not at scope-assertion time.
 */
export const OAUTH_META_SCOPES: ReadonlySet<string> = new Set([
  "offline_access",
  // Salesforce's protocol scope controlling refresh-token issuance —
  // the same role `offline_access` plays for Microsoft/Atlassian, not a
  // resource-API permission. Salesforce normally echoes it back, but we
  // never treat it as a required API scope; a genuinely missing refresh
  // token surfaces at refresh time, not at scope-assertion time.
  "refresh_token",
]);

function withoutMetaScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !OAUTH_META_SCOPES.has(s));
}

/**
 * Compute the difference between requested and granted scopes.
 * Returns the set of scopes that were requested but NOT granted —
 * i.e. the user narrowed consent. Empty array means "full grant".
 *
 * Granted-but-not-requested scopes are ignored (a provider may
 * implicitly grant `openid` even if the caller didn't ask for it;
 * that is the provider's prerogative and not a security issue from
 * the caller's perspective).
 *
 * Pure set-diff primitive — does NOT strip meta-scopes. Callers
 * that compare requested vs granted to decide whether to throw or
 * warn the user (`assertScopesGranted`, `compareScopes`) strip
 * meta-scopes themselves before calling this helper.
 */
export function computeMissingScopes(
  requested: readonly string[],
  granted: readonly string[],
): string[] {
  if (requested.length === 0) return [];
  const grantedSet = new Set(granted);
  return requested.filter((s) => !grantedSet.has(s));
}

/**
 * Assert that every scope in `required` is present in `granted`.
 * Throws `MissingScopeError` otherwise.
 *
 * Use this at the connector-sync entry point so a sync call against
 * a narrowed token surfaces a precise error instead of producing
 * unexplained 403s deep in the API client.
 *
 * Meta-scopes (`offline_access` etc., see `OAUTH_META_SCOPES`) are
 * stripped from `required` before the comparison — they are
 * protocol-behaviour scopes, not API permissions, and providers
 * frequently omit them from the token response's `scope` field
 * even when granted, so requiring them here would surface false
 * `MissingScopeError`s on every working integration.
 */
export function assertScopesGranted(
  provider: string,
  required: readonly string[],
  granted: readonly string[],
): void {
  const apiRequired = withoutMetaScopes(required);
  const missing = computeMissingScopes(apiRequired, granted);
  if (missing.length > 0) {
    throw new MissingScopeError(provider, missing, [...granted]);
  }
}

/**
 * Return the canonical requested-scope list for an OAuth provider
 * config. Centralised so callers do not re-implement the
 * `config.scope.split(/\s+/)` parse at every call site, AND so the
 * `offline_access` meta-scope is expressed in exactly one place.
 *
 * `config.scope` lists only the API (resource) scopes. Providers that
 * need a refresh token declare it once via `requestOfflineAccess: true`
 * rather than hand-appending `offline_access` to the scope string — the
 * meta-scope is added here so every consumer (the authorize URL, the
 * Rust `auth_config`, and scope governance) sees the same full set
 * without the string and the flag drifting apart. Idempotent: a config
 * that still lists `offline_access` in `scope` is not duplicated.
 */
export function getRequestedScopes(config: ProviderOAuthConfig): string[] {
  const scopes = parseScopeString(config.scope);
  if (config.requestOfflineAccess && !scopes.includes("offline_access")) {
    scopes.push("offline_access");
  }
  return scopes;
}

/**
 * Compare requested vs granted for the renderer's "connector
 * status" UI. Returns a structured object so the renderer can show
 * a yellow "narrowed scopes" warning with the precise missing
 * entries.
 */
export interface ScopeComparison {
  /** Provider id (same as `ProviderId`). */
  provider: string;
  /** Scopes the OAuth config asked for. */
  requested: string[];
  /** Scopes the provider actually granted (parsed from token response). */
  granted: string[];
  /** Subset of `requested` that is NOT in `granted`. Empty when full grant. */
  missing: string[];
  /**
   * `true` when granted == requested (full grant). `false` when the
   * user narrowed consent. Distinct from "missing.length === 0"
   * only because the renderer wants a one-shot boolean for the
   * green-check rendering — semantically equivalent.
   */
  fullyGranted: boolean;
}

export function compareScopes(
  provider: string,
  requested: readonly string[],
  granted: readonly string[],
): ScopeComparison {
  // Strip meta-scopes (`offline_access` etc.) from the *required*
  // set before computing missing — see `OAUTH_META_SCOPES` JSDoc
  // for why. We DO keep the full `requested` array in the returned
  // record so the renderer can show the user the complete list of
  // scopes the integration asked for, but the `missing` /
  // `fullyGranted` fields reflect only the API permissions the
  // provider is expected to echo back.
  const apiRequired = withoutMetaScopes(requested);
  const missing = computeMissingScopes(apiRequired, granted);
  return {
    provider,
    requested: [...requested],
    granted: [...granted],
    missing,
    fullyGranted: missing.length === 0,
  };
}
