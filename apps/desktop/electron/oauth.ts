/**
 * Cryptographically-strong random state value for OAuth 2.0 CSRF
 * protection. 32 random bytes encoded as 64 hex characters (256 bits
 * of entropy — well above the RFC 6749 §10.12 recommendation of "at
 * least 128 bits").
 *
 * This is the only export this file still owns. The rest of the
 * historical OAuth surface — `OAuthConfig`, `OAuthToken`,
 * `OAuthProvider`, `buildAuthorizationUrl`, `isTokenExpired` — used
 * to live here and was consumed exclusively by the legacy
 * `oauthServer.ts` Google-Drive-only loopback server. That file was
 * superseded by the provider-agnostic dispatcher in
 * `ipc/connectors/providerOAuth.ts` during the connector wiring.
 * That module owns the loopback redirect server, the
 * authorization-URL construction, the token exchange, and the
 * refresh flow — replacing every export the deleted file used to
 * consume. With the legacy file deleted, the other exports here
 * became unreachable — every grep across the repo confirmed they
 * were not imported anywhere — so they were pruned in the same
 * cleanup. Keeping this file as a one-function module rather than
 * inlining `generateState()` into its single caller preserves a
 * grep-able home for the named helper.
 */
export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}
