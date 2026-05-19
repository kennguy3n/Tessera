import { shell } from "electron";
import * as http from "http";
import { generateState, buildAuthorizationUrl } from "./oauth";
import type { OAuthConfig } from "./oauth";

const REDIRECT_PORT = 9876;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const GOOGLE_OAUTH_CONFIG: OAuthConfig = {
  clientId: "",
  redirectUri: REDIRECT_URI,
  scope: "https://www.googleapis.com/auth/drive.readonly",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
};

export interface OAuthResult {
  code: string;
  state: string;
}

export function getRedirectUri(): string {
  return REDIRECT_URI;
}

export async function startOAuthFlow(
  clientId: string,
  _clientSecret: string,
): Promise<OAuthResult> {
  const config: OAuthConfig = {
    ...GOOGLE_OAUTH_CONFIG,
    clientId,
  };
  const state = generateState();

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Authorization Failed</h2><p>You can close this window.</p></body></html>",
        );
        server.close();
        cleanup();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code || returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(
          "<html><body><h2>Invalid Response</h2><p>State mismatch or missing code.</p></body></html>",
        );
        server.close();
        cleanup();
        reject(new Error("Invalid OAuth callback: state mismatch or missing code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body><h2>Connected to Google Drive</h2><p>You can close this window and return to Tessera.</p></body></html>",
      );
      server.close();
      cleanup();
      resolve({ code, state });
    });

    server.listen(REDIRECT_PORT, "127.0.0.1", () => {
      const authUrl = buildAuthorizationUrl(config, state);
      const fullUrl = `${authUrl}&access_type=offline&prompt=consent`;
      shell.openExternal(fullUrl).catch((err) => {
        server.close();
        cleanup();
        reject(err);
      });
    });

    server.on("error", (err) => {
      cleanup();
      reject(new Error(`Failed to start OAuth redirect server: ${err.message}`));
    });

    timeoutId = setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 300_000);
  });
}

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<{
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
}> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: HTTP ${resp.status} — ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? null,
    expires_in: data.expires_in,
  };
}

export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<{
  access_token: string;
  expires_in: number;
  refresh_token: string | null;
}> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed: HTTP ${resp.status} — ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    expires_in: number;
    refresh_token?: string;
  };

  return {
    access_token: data.access_token,
    expires_in: data.expires_in,
    refresh_token: data.refresh_token ?? null,
  };
}

export async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}
