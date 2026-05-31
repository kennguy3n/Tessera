/**
 * Phase 19 PR 10 Task 8 — OAuth scope governance.
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
 * Compute the difference between requested and granted scopes.
 * Returns the set of scopes that were requested but NOT granted —
 * i.e. the user narrowed consent. Empty array means "full grant".
 *
 * Granted-but-not-requested scopes are ignored (a provider may
 * implicitly grant `openid` even if the caller didn't ask for it;
 * that is the provider's prerogative and not a security issue from
 * the caller's perspective).
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
 */
export function assertScopesGranted(
  provider: string,
  required: readonly string[],
  granted: readonly string[],
): void {
  const missing = computeMissingScopes(required, granted);
  if (missing.length > 0) {
    throw new MissingScopeError(provider, missing, [...granted]);
  }
}

/**
 * Return the canonical requested-scope list for an OAuth provider
 * config. Centralised so callers do not re-implement the
 * `config.scope.split(/\s+/)` parse at every call site.
 */
export function getRequestedScopes(config: ProviderOAuthConfig): string[] {
  return parseScopeString(config.scope);
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
  const missing = computeMissingScopes(requested, granted);
  return {
    provider,
    requested: [...requested],
    granted: [...granted],
    missing,
    fullyGranted: missing.length === 0,
  };
}
