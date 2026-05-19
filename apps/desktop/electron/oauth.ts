export interface OAuthConfig {
  clientId: string;
  redirectUri: string;
  scope: string;
  authUrl: string;
  tokenUrl: string;
}

export interface OAuthToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  tokenType: string;
}

export interface OAuthProvider {
  name: string;
  config: OAuthConfig;
  authorize(): Promise<OAuthToken>;
  refresh(token: OAuthToken): Promise<OAuthToken>;
  revoke(token: OAuthToken): Promise<void>;
}

export function buildAuthorizationUrl(config: OAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scope,
    response_type: "code",
    state,
  });
  return `${config.authUrl}?${params.toString()}`;
}

export function isTokenExpired(token: OAuthToken): boolean {
  return Date.now() >= token.expiresAt - 60_000;
}

export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}
