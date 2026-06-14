/**
 * Provider-agnostic OAuth 2.0 helper.
 *
 * Single Authorization Code Grant flow shared by every Tessera
 * connector. The provider-specific bits (auth URL, token URL,
 * scopes, header style, refresh-token semantics) are isolated as a
 * `ProviderOAuthConfig` so each new connector is one config entry
 * plus the actual sync logic, not a new copy of the whole flow.
 *
 * Design notes:
 *   - Each provider gets its own loopback port to keep concurrent
 *     auth attempts isolated and to avoid the `EADDRINUSE` confusion
 *     of a stuck flow blocking a new one. The redirect URIs are
 *     `http://127.0.0.1:<port>/callback`.
 *   - We standardise on the loopback / localhost-redirect pattern
 *     (RFC 8252 — OAuth for Native Apps). Every provider here
 *     supports it for desktop applications.
 *   - PKCE (S256) is enabled for every provider whose OAuth surface
 *     supports it (Google Drive, OneDrive, Jira, Confluence). For
 *     those, the verifier is attached to the request and the
 *     challenge is sent on the authorize URL. Two providers opt out:
 *     **Notion** (integration tokens follow a non-expiring
 *     `client_secret + authorization_code` flow that does not accept
 *     `code_challenge`) and **Figma** (whose OAuth implementation
 *     predates PKCE and rejects the parameter outright). Both fall
 *     back to plain authorization-code with state validation; their
 *     `usePkce` flag is false. Re-enable PKCE for either the moment
 *     the upstream provider starts honouring `code_challenge_method=S256`.
 *   - Token exchange uses `application/x-www-form-urlencoded` and
 *     either `Authorization: Basic <id:secret>` or
 *     `client_secret=<secret>` in the body, per provider config.
 *   - Refresh handling is per-provider. We expose a
 *     `supportsRefresh` flag so callers can surface a "reconnect
 *     needed" UX for providers whose OAuth flow does not issue a
 *     refresh token (currently only Notion's integration tokens are
 *     non-expiring and refresh-less).
 *
 * Security notes:
 *   - We always validate the OAuth `state` returned in the callback
 *     matches what we generated. A mismatch is a hard error.
 *   - `client_id` / `client_secret` are passed by the renderer (user
 *     entered) and stored only in the OS keychain via `tokenVault`.
 *   - The redirect server is bound to `127.0.0.1` only — never on
 *     `0.0.0.0` — and shuts down immediately after the redirect.
 *
 * Test surface:
 *   - The flow logic is split between `buildAuthorizeUrl`,
 *     `runRedirectServer`, and `exchangeAuthorizationCode` so tests
 *     can exercise each piece without a live browser.
 */

import { shell } from "electron";
import * as crypto from "crypto";
import * as http from "http";

import { generateState } from "../../oauth";
import { getRequestedScopes } from "../../oauthScope";
import type { KnownProvider } from "../validate";

/**
 * Canonical connector identifier — a single source of truth.
 *
 * Both this OAuth layer (`PROVIDER_OAUTH_CONFIGS`, every connector's
 * sync impl, the redirect-server flow) and the IPC validator
 * (`assertProvider`, the `KNOWN_PROVIDERS` allowlist in
 * `../validate.ts`) need to enumerate the exact same set of providers.
 * Previously each side defined its own union — `ProviderId` here as an
 * explicit `"google_drive" | "onedrive" | ...` and `KnownProvider` in
 * `validate.ts` derived from the runtime allowlist — and adding a new
 * connector required updating both. TypeScript would catch the
 * mismatch lazily (at the `runSync` switch's exhaustiveness check or
 * at the `provider as ProviderId` cast in `ipc.ts`), not eagerly, and
 * a maintainer wiring up a 7th connector could plausibly miss one of
 * the two files until runtime.
 *
 * The fix derives `ProviderId` from `KNOWN_PROVIDERS` so the runtime
 * allowlist used by the IPC validator IS the type the OAuth layer
 * indexes by. Adding a connector is now a single edit (the
 * `KNOWN_PROVIDERS` tuple in `validate.ts`); every consumer —
 * `PROVIDER_OAUTH_CONFIGS`, `runSync`, `assertProvider`, the bridge
 * cast — fails to compile in the right places at the right time until
 * the new provider is wired all the way through.
 */
export type ProviderId = KnownProvider;

/**
 * Per-instance (per-subdomain) OAuth URL derivation seam.
 *
 * Most providers expose a single, fixed OAuth surface (`authUrl` /
 * `tokenUrl` are compile-time constants). A handful are **per-instance**:
 * the authorize/token endpoints live on the tenant's own subdomain
 * (Zendesk: `https://<subdomain>.zendesk.com/oauth/...`; ServiceNow:
 * `https://<instance>.service-now.com/oauth_*.do`). For those, the URL is
 * not knowable at compile time — it is derived per connection from a
 * user-supplied instance value collected in the connect modal.
 *
 * A provider declares `instanceUrls` INSTEAD of `authUrl`/`tokenUrl`
 * (the two are mutually exclusive — see the module-load invariant in
 * `assertOAuthConfigInvariant`). `resolveProviderOAuthConfig` then turns
 * the stored instance value into concrete `authUrl`/`tokenUrl` (and an
 * optional `revokeUrl`) by interpolating it into a host that is **pinned
 * to `baseDomain`** — so a hostile instance value can never point the
 * OAuth flow (or the connector's API base URL) at an arbitrary host
 * (SSRF / open-redirect). Fixed-URL providers leave this `undefined` and
 * behave exactly as before.
 */
export interface InstanceUrlTemplate {
  /**
   * The connect-spec `ConnectorConfigField` key whose validated value
   * supplies the instance subdomain label (e.g. Zendesk's `subdomain`).
   * MUST be a required field on the provider's `ConnectorConnectSpec`.
   * The value is consumed into the derived URLs (and `apiBaseUrlField`)
   * and is therefore NOT injected verbatim into `auth_config_json`.
   */
  instanceField: string;
  /**
   * Parent domain the instance is a subdomain of (e.g. `zendesk.com`,
   * `service-now.com`). The derived origin is
   * `https://<instanceValue>.<baseDomain>` and the host is pinned to
   * exactly this domain — the SSRF/open-redirect allowlist boundary.
   */
  baseDomain: string;
  /** Absolute path (begins with `/`) of the authorize endpoint. */
  authorizePath: string;
  /** Absolute path (begins with `/`) of the token endpoint. */
  tokenPath: string;
  /** Optional absolute path of the token-revocation endpoint. */
  revokePath?: string;
  /**
   * Optional `auth_config_json` field to populate with the derived
   * origin (`https://<instance>.<baseDomain>`), so the connector's
   * per-instance API base URL is single-sourced from the SAME validated
   * value the OAuth URLs were derived from (Zendesk/ServiceNow read
   * `api_base_url`). Injected by `buildAuthConfig`.
   */
  apiBaseUrlField?: string;
}

export interface ProviderOAuthConfig {
  /** Stable provider id used by tokenVault and the connector registry. */
  provider: ProviderId;
  /**
   * Authorization endpoint. Fixed-URL providers set this; per-instance
   * providers omit it and declare {@link ProviderOAuthConfig.instanceUrls}
   * instead (the two are mutually exclusive).
   */
  authUrl?: string;
  /**
   * Token exchange endpoint. Fixed-URL providers set this; per-instance
   * providers derive it from {@link ProviderOAuthConfig.instanceUrls}.
   */
  tokenUrl?: string;
  /** Optional token revocation endpoint (fixed-URL providers). */
  revokeUrl?: string;
  /**
   * Per-instance authorize/token URL derivation. When set, `authUrl`/
   * `tokenUrl` MUST be omitted; call `resolveProviderOAuthConfig` with
   * the connection's stored config to obtain the concrete URLs before
   * running any OAuth flow. See {@link InstanceUrlTemplate}.
   */
  instanceUrls?: InstanceUrlTemplate;
  /** Space-delimited scope string. */
  scope: string;
  /** Loopback port the redirect URI will listen on. Must be unique per provider. */
  redirectPort: number;
  /**
   * Loopback host for the redirect URI. RFC 8252 prefers `127.0.0.1`
   * but Google's published examples and the legacy Tessera OAuth
   * client both used `localhost`. Existing user OAuth
   * client configurations in Google Cloud Console therefore have
   * `http://localhost:9876/callback` registered — switching to
   * `127.0.0.1` would break every existing installation with a
   * `redirect_uri_mismatch` error. We default new providers to
   * `127.0.0.1` (the spec-compliant choice) but keep Google Drive
   * on `localhost` for backward compatibility.
   */
  redirectHost?: "127.0.0.1" | "localhost";
  /** Optional extra params to add to the authorize URL (e.g. `prompt=consent`). */
  extraAuthorizeParams?: Record<string, string>;
  /** Whether to send `client_id:client_secret` as HTTP Basic Auth on token exchange. */
  basicAuth?: boolean;
  /**
   * Whether the `offline_access` meta-scope should be requested so the
   * provider issues a refresh token. This is the single declarative
   * source for offline access — `getRequestedScopes` appends
   * `offline_access` when this is set, so it must NOT also be listed in
   * `scope` (which carries API/resource scopes only). Consumed by
   * `buildAuthorizeUrl` (authorize request), `buildAuthConfig` (the Rust
   * `auth_config`), and scope governance, all via `getRequestedScopes`.
   */
  requestOfflineAccess?: boolean;
  /**
   * Whether the provider's OAuth flow issues a refresh token. Notion
   * integration tokens are non-expiring and refresh-less; every other
   * connector (Drive, OneDrive, Jira, Confluence, Figma) supports
   * refresh.
   */
  supportsRefresh: boolean;
  /** Whether to send PKCE code_challenge / code_verifier on the flow. */
  usePkce: boolean;
  /**
   * Name of the JSON field carrying the access token in the token
   * exchange / refresh response. Defaults to the RFC 6749 standard
   * `access_token`. Intercom is the sole exception: its
   * `/auth/eagle/token` endpoint returns the token in a non-standard
   * `token` field. When set, the exchange reads that field first and
   * falls back to `access_token`, so the override is safe even if the
   * provider later returns the standard field.
   */
  accessTokenField?: string;
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  tokenType: string;
  /**
   * the scopes the provider ACTUALLY
   * granted, parsed from the token response's `scope` field. May
   * be a strict subset of the requested scopes if the user
   * narrowed consent on the provider's screen. `null` means the
   * provider did not include a `scope` field at all (e.g. Notion's
   * integration-token flow); callers should fall back to the
   * requested scopes in that case.
   */
  grantedScopes: string[] | null;
  /** Provider-specific extra payload (e.g. Notion's `workspace_id`, Figma's `user`). */
  extra?: Record<string, unknown>;
}

export interface AuthorizationCodeResult {
  code: string;
  state: string;
}

/**
 * Per-provider OAuth config. Every value is a constant of the
 * provider's documented OAuth surface; no values come from runtime
 * configuration. Adding a new connector means adding an entry here.
 */
export const PROVIDER_OAUTH_CONFIGS: Record<ProviderId, ProviderOAuthConfig> = {
  google_drive: {
    provider: "google_drive",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scope: "https://www.googleapis.com/auth/drive.readonly",
    redirectPort: 9876,
    // Google Drive was the first connector wired into Tessera,
    // using `http://localhost:9876/callback`. Users have already
    // registered that exact URI in Google Cloud Console; we must
    // preserve it bit-for-bit or every existing installation breaks
    // with `redirect_uri_mismatch`.
    redirectHost: "localhost",
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  onedrive: {
    provider: "onedrive",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Microsoft v2.0 token endpoint accepts client_secret in the body for
    // confidential clients; PKCE is required for public/desktop clients.
    // API scopes only — `offline_access` is requested via
    // `requestOfflineAccess` below.
    scope: "Files.Read.All User.Read",
    redirectPort: 9877,
    extraAuthorizeParams: {
      response_mode: "query",
      prompt: "select_account",
    },
    requestOfflineAccess: true,
    supportsRefresh: true,
    usePkce: true,
  },
  notion: {
    provider: "notion",
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scope: "",
    redirectPort: 9878,
    extraAuthorizeParams: {
      owner: "user",
    },
    basicAuth: true,
    supportsRefresh: false,
    usePkce: false,
  },
  jira: {
    provider: "jira",
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    // API scopes only — `offline_access` is requested via
    // `requestOfflineAccess` below.
    scope: "read:jira-work read:jira-user",
    redirectPort: 9879,
    extraAuthorizeParams: {
      audience: "api.atlassian.com",
      prompt: "consent",
    },
    requestOfflineAccess: true,
    supportsRefresh: true,
    usePkce: true,
  },
  confluence: {
    provider: "confluence",
    authUrl: "https://auth.atlassian.com/authorize",
    tokenUrl: "https://auth.atlassian.com/oauth/token",
    // API scopes only — `offline_access` is requested via
    // `requestOfflineAccess` below.
    scope:
      "read:confluence-content.summary read:confluence-content.all read:confluence-space.summary",
    redirectPort: 9880,
    extraAuthorizeParams: {
      audience: "api.atlassian.com",
      prompt: "consent",
    },
    requestOfflineAccess: true,
    supportsRefresh: true,
    usePkce: true,
  },
  figma: {
    provider: "figma",
    authUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    scope: "files:read",
    redirectPort: 9881,
    extraAuthorizeParams: {},
    supportsRefresh: true,
    usePkce: false,
  },
  // ── Substrate-only providers (v2 `connector_framework`) ──────────
  // These four have no legacy `tessera_connectors` sync impl; their
  // OAuth flow is the same provider-agnostic authorization-code grant
  // as the six above, and their content traversal is served by the
  // knowledge substrate via the Rust bridge. Each gets a unique
  // loopback port (continuing the 9876+ sequence) so concurrent auth
  // attempts stay isolated.
  hubspot: {
    provider: "hubspot",
    authUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    // CRM read scopes + `oauth` (required by HubSpot for the token
    // exchange itself). HubSpot issues refresh tokens for all apps.
    scope:
      "oauth crm.objects.contacts.read crm.objects.companies.read crm.objects.deals.read",
    redirectPort: 9882,
    extraAuthorizeParams: {},
    // HubSpot's token endpoint requires client_id + client_secret in
    // the form body (not Basic auth) and does not support PKCE.
    supportsRefresh: true,
    usePkce: false,
  },
  slack: {
    provider: "slack",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    // Read-only history/read scopes for channels, groups and users.
    scope:
      "channels:history channels:read groups:history users:read team:read",
    redirectPort: 9883,
    extraAuthorizeParams: {},
    // Slack v2 tokens are non-expiring unless workspace token rotation
    // is enabled (off by default), so we treat them as refresh-less —
    // mirrors Notion's non-expiring-token handling.
    supportsRefresh: false,
    usePkce: false,
  },
  email: {
    provider: "email",
    // The substrate Email connector reads mail over the Gmail API; the
    // OAuth surface is therefore Google's, distinct from Drive only in
    // the requested scope (read-only Gmail) and loopback port.
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    redirectPort: 9884,
    redirectHost: "127.0.0.1",
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  github: {
    provider: "github",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo read:org read:user",
    redirectPort: 9885,
    extraAuthorizeParams: {},
    // GitHub OAuth Apps issue non-expiring tokens with no refresh
    // token (only GitHub Apps with expiring tokens do); treat as
    // refresh-less. No PKCE on the OAuth App flow.
    supportsRefresh: false,
    usePkce: false,
  },
  // ── Whole-account read-only OAuth2 providers (v2 bridge) ─────────
  // Same provider-agnostic authorization-code grant as above; content
  // traversal is served by the upstream `connectors` crate. Each syncs
  // every item the granted (read-only) token can see, so no per-target
  // sync config is required. Ports continue the 9886+ sequence.
  dropbox: {
    provider: "dropbox",
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    // Least-privilege read-only scopes: account identity + file
    // metadata + file content. No write/sharing scopes are requested.
    scope: "account_info.read files.metadata.read files.content.read",
    redirectPort: 9886,
    // Dropbox only issues a refresh token when the authorize request
    // asks for offline access via `token_access_type=offline`; without
    // it the short-lived access token cannot be refreshed.
    extraAuthorizeParams: {
      token_access_type: "offline",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  box: {
    provider: "box",
    authUrl: "https://account.box.com/api/oauth2/authorize",
    tokenUrl: "https://api.box.com/oauth2/token",
    // `root_readonly` downscopes the token to read-only access across
    // the account's files and folders — the least-privilege grant for
    // evidence ingestion. The Box app itself must also be configured
    // with read-only application scopes (see docs/CONNECTORS.md).
    scope: "root_readonly",
    redirectPort: 9887,
    extraAuthorizeParams: {},
    // Box issues a refresh token on every authorization-code exchange.
    // No PKCE on Box's standard web OAuth2 flow.
    supportsRefresh: true,
    usePkce: false,
  },
  linear: {
    provider: "linear",
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    // Linear's single `read` scope grants read-only access to issues,
    // projects and comments — exactly what the connector ingests.
    scope: "read",
    redirectPort: 9888,
    extraAuthorizeParams: {},
    // Linear access tokens are long-lived and the flow does not issue a
    // refresh token, so surface a "reconnect needed" UX on expiry
    // rather than attempting a refresh (mirrors GitHub / Slack).
    supportsRefresh: false,
    usePkce: false,
  },
  miro: {
    provider: "miro",
    authUrl: "https://miro.com/oauth/authorize",
    tokenUrl: "https://api.miro.com/v1/oauth/token",
    // `boards:read` is Miro's least-privilege read-only scope; it
    // covers listing boards and reading their metadata/content.
    scope: "boards:read",
    redirectPort: 9889,
    extraAuthorizeParams: {},
    // Miro issues refresh tokens when the app is configured for
    // expiring tokens; the refresh path is a no-op when the token is
    // still valid or when no refresh token was returned.
    supportsRefresh: true,
    usePkce: false,
  },
  // ── Per-target / non-OAuth2 tranche ──────────────────────────────
  // These providers need extra connect-time inputs beyond a bare OAuth
  // client id/secret; the inputs (and whether the connect flow is a
  // browser OAuth grant or a pasted credential) are declared in
  // `shared/connectorConfig.ts`. The OAuth surface below is still the
  // single source of truth for endpoints, scopes and the unique
  // loopback port every provider reserves.
  asana: {
    provider: "asana",
    authUrl: "https://app.asana.com/-/oauth_authorize",
    tokenUrl: "https://app.asana.com/-/oauth_token",
    // Least-privilege read-only scopes: the connector only lists and
    // reads tasks within the configured project. Asana's granular OAuth
    // scopes (`projects:read`, `tasks:read`) replace the legacy
    // full-access `default` scope.
    scope: "projects:read tasks:read",
    redirectPort: 9890,
    extraAuthorizeParams: {},
    // Asana issues refresh tokens for OAuth apps.
    supportsRefresh: true,
    // Asana's OAuth surface supports PKCE (S256).
    usePkce: true,
  },
  gitlab: {
    provider: "gitlab",
    // GitLab is wired via a personal access token (see
    // `shared/connectorConfig.ts` — connectMethod "token"), which works
    // uniformly across gitlab.com and self-managed instances without
    // per-instance OAuth app registration. The OAuth endpoints below
    // are retained for completeness and to satisfy the single-config
    // invariant (every provider declares an https authorize/token URL +
    // a unique loopback port); the connect flow does not open a browser.
    authUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    // `read_api` is GitLab's least-privilege read-only token scope; it
    // covers reading project issues and their notes, which is all the
    // connector ingests. The user grants it when creating the PAT.
    scope: "read_api",
    redirectPort: 9891,
    extraAuthorizeParams: {},
    // A PAT is long-lived and carries no refresh token; surface a
    // "reconnect" UX on expiry instead of attempting a refresh.
    supportsRefresh: false,
    usePkce: false,
  },
  teams: {
    provider: "teams",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Least-privilege: read messages in the channels the user can
    // already see (`ChannelMessage.Read.All`). No write/management
    // scopes. `offline_access` is requested via `requestOfflineAccess`.
    scope: "ChannelMessage.Read.All",
    redirectPort: 9892,
    extraAuthorizeParams: {
      response_mode: "query",
      prompt: "select_account",
    },
    requestOfflineAccess: true,
    supportsRefresh: true,
    // Microsoft v2.0 desktop/public clients use PKCE (S256).
    usePkce: true,
  },
  trello: {
    provider: "trello",
    // Trello authenticates with an API key + token pair (see
    // `shared/connectorConfig.ts` — connectMethod "token"), not an
    // OAuth2 browser grant. The endpoints below are Trello's OAuth1
    // surface, retained only to satisfy the single-config invariant;
    // the connect flow does not open a browser.
    authUrl: "https://trello.com/1/authorize",
    tokenUrl: "https://trello.com/1/OAuthGetAccessToken",
    // Trello tokens are scoped at creation time. The connector only
    // reads boards/cards, so the user authorises a read-only token.
    scope: "read",
    redirectPort: 9893,
    extraAuthorizeParams: {},
    supportsRefresh: false,
    usePkce: false,
  },
  // ── Tranche 3: read-only, account-wide OAuth2 providers ──────────
  // Whole-account reads served by the upstream `connectors` crate with
  // the connector's own account-wide defaults (no per-target config).
  // Each requests least-privilege read-only scopes and reserves a
  // unique loopback port, continuing the 9894+ sequence.
  zoom: {
    provider: "zoom",
    authUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    // Least-privilege: list + read the signed-in user's own cloud
    // recordings (the connector reads `/users/me/recordings`). No
    // account-admin or write/management scopes are requested.
    scope: "cloud_recording:read:list_user_recordings",
    redirectPort: 9894,
    extraAuthorizeParams: {},
    // Zoom's token endpoint authenticates the client with HTTP Basic
    // (`client_id:client_secret`) and issues a refresh token on the
    // authorization-code grant.
    basicAuth: true,
    supportsRefresh: true,
    // Zoom supports PKCE (S256) on the authorization-code flow.
    usePkce: true,
  },
  google_calendar: {
    provider: "google_calendar",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    // Read-only events on the user's primary calendar (the connector
    // defaults `calendar_id` to "primary"). `calendar.events.readonly`
    // is the least-privilege read scope — narrower than `calendar.readonly`.
    scope: "https://www.googleapis.com/auth/calendar.events.readonly",
    redirectPort: 9895,
    redirectHost: "127.0.0.1",
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  google_docs: {
    provider: "google_docs",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    // The connector walks the Drive change feed to discover Google Docs
    // (`drive.readonly`) and reads each document via the Docs API
    // (`documents.readonly`). Both are read-only.
    scope:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/documents.readonly",
    redirectPort: 9896,
    redirectHost: "127.0.0.1",
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  google_sheets: {
    provider: "google_sheets",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    // Drive change feed discovery (`drive.readonly`) + Sheets API reads
    // (`spreadsheets.readonly`). Both are read-only.
    scope:
      "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly",
    redirectPort: 9897,
    redirectHost: "127.0.0.1",
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  google_meet: {
    provider: "google_meet",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    // Read-only conference records / transcripts via the Meet REST API.
    // `meetings.space.readonly` is the least-privilege read scope for
    // the conferenceRecords surface the connector walks.
    scope: "https://www.googleapis.com/auth/meetings.space.readonly",
    redirectPort: 9898,
    redirectHost: "127.0.0.1",
    extraAuthorizeParams: {
      access_type: "offline",
      prompt: "consent",
    },
    supportsRefresh: true,
    usePkce: true,
  },
  sharepoint: {
    provider: "sharepoint",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    // Read-only SharePoint document libraries via Microsoft Graph drive
    // delta. The connector defaults to the tenant root site
    // (`/sites/root/drive`). `Sites.Read.All` is the least-privilege
    // read scope; `offline_access` is requested via
    // `requestOfflineAccess`. Distinct from OneDrive (`/me/drive`).
    scope: "Sites.Read.All",
    redirectPort: 9899,
    extraAuthorizeParams: {
      response_mode: "query",
      prompt: "select_account",
    },
    requestOfflineAccess: true,
    supportsRefresh: true,
    usePkce: true,
  },
  // ── Tranche 4: per-target / per-resource providers ───────────────
  // Each ingests a single target (Discord channel, Bitbucket
  // workspace+repo, Airtable base+table, Monday board). Discord,
  // Bitbucket and Airtable connect with a pasted credential
  // (`connectMethod: "token"` in shared/connectorConfig.ts), so their
  // OAuth endpoints below are retained only to satisfy the
  // single-config invariant (every provider declares an https
  // authorize/token URL + a unique loopback port) — the connect flow
  // does not open a browser. Monday is a real read-only OAuth2 browser
  // grant. Ports continue the unique sequence from 9900.
  discord: {
    provider: "discord",
    // Discord's OAuth2 surface. Tessera connects Discord with a bot
    // token (see shared/connectorConfig.ts — connectMethod "token"),
    // sent on the REST API with the `Bot` auth scheme; these endpoints
    // are retained only for the single-config invariant and are not
    // used to open a browser.
    authUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    // The bot token's reach is governed by the read-only guild
    // permissions the bot is invited with (View Channels + Read
    // Message History), not by an OAuth scope string. `messages.read`
    // documents the least-privilege read intent; it is not sent on any
    // request for the bot-token path.
    scope: "messages.read",
    redirectPort: 9900,
    extraAuthorizeParams: {},
    // A bot token is long-lived and carries no refresh token; surface
    // a "reconnect" UX on revocation instead of attempting a refresh.
    supportsRefresh: false,
    usePkce: false,
  },
  bitbucket: {
    provider: "bitbucket",
    // Bitbucket is wired with a repository/workspace access token (see
    // shared/connectorConfig.ts — connectMethod "token") created with
    // the read-only `repository` + `pullrequest` scopes, used as a
    // Bearer token. The OAuth endpoints below satisfy the single-config
    // invariant; the connect flow does not open a browser.
    authUrl: "https://bitbucket.org/site/oauth2/authorize",
    tokenUrl: "https://bitbucket.org/site/oauth2/access_token",
    // `repository` + `pullrequest` are Bitbucket's read scopes for the
    // repository content and pull requests the connector ingests. The
    // user grants them when creating the access token.
    scope: "repository pullrequest",
    redirectPort: 9901,
    extraAuthorizeParams: {},
    // Access tokens are long-lived and carry no refresh token.
    supportsRefresh: false,
    usePkce: false,
  },
  airtable: {
    provider: "airtable",
    // Airtable is wired with a personal access token (see
    // shared/connectorConfig.ts — connectMethod "token") created with
    // the read-only `data.records:read` + `schema.bases:read` scopes,
    // used as a Bearer token. The OAuth endpoints below satisfy the
    // single-config invariant; the connect flow does not open a browser.
    authUrl: "https://airtable.com/oauth2/v1/authorize",
    tokenUrl: "https://airtable.com/oauth2/v1/token",
    // Least-privilege read scopes: read records from the configured
    // base/table and read the base schema. The user grants them when
    // creating the personal access token.
    scope: "data.records:read schema.bases:read",
    redirectPort: 9902,
    extraAuthorizeParams: {},
    // Personal access tokens are long-lived and carry no refresh token.
    supportsRefresh: false,
    usePkce: false,
  },
  monday: {
    provider: "monday",
    authUrl: "https://auth.monday.com/oauth2/authorize",
    tokenUrl: "https://auth.monday.com/oauth2/token",
    // Least-privilege read-only scopes: read the configured board's
    // items (`boards:read`) and the signed-in user (`me:read`). No
    // write/manage scopes (`boards:write`, `…:write`) are requested.
    scope: "boards:read me:read",
    redirectPort: 9903,
    extraAuthorizeParams: {},
    // Monday's OAuth tokens are long-lived seat tokens; the
    // authorization-code grant issues no refresh token, so surface a
    // "reconnect" UX on expiry rather than attempting a refresh.
    supportsRefresh: false,
    // Monday's OAuth surface does not support PKCE.
    usePkce: false,
  },
  // Tranche 5: read-only support / CRM providers. Ports continue the
  // unique sequence from 9904.
  clickup: {
    provider: "clickup",
    // ClickUp's OAuth2 surface. The authorize endpoint lives on the
    // app host; the token exchange on the API host.
    authUrl: "https://app.clickup.com/api",
    tokenUrl: "https://api.clickup.com/api/v2/oauth/token",
    // ClickUp's OAuth flow takes no `scope` parameter — the personal
    // OAuth app's access is governed by the authorizing user's own
    // Workspace permissions, and the connector only ever issues
    // read-only GETs against `/api/v2/team/{team_id}/task`. Empty scope
    // is intentional (see SCOPELESS_PROVIDERS in handlers.ts).
    scope: "",
    redirectPort: 9904,
    extraAuthorizeParams: {},
    // ClickUp access tokens are long-lived and the authorization-code
    // grant issues no refresh token, so surface a "reconnect" UX on
    // revocation rather than attempting a refresh.
    supportsRefresh: false,
    // ClickUp's OAuth surface does not support PKCE.
    usePkce: false,
  },
  intercom: {
    provider: "intercom",
    authUrl: "https://app.intercom.com/oauth",
    tokenUrl: "https://api.intercom.io/auth/eagle/token",
    // Intercom does not take a `scope` parameter on the authorize URL —
    // an app's data access is configured on the app itself in the
    // Intercom developer hub, and Tessera only reads conversations.
    // Empty scope is intentional (see SCOPELESS_PROVIDERS).
    scope: "",
    redirectPort: 9905,
    extraAuthorizeParams: {},
    // Intercom's `/auth/eagle/token` endpoint returns the access token
    // in a non-standard `token` field rather than `access_token`.
    accessTokenField: "token",
    // Intercom access tokens are long-lived and carry no refresh token.
    supportsRefresh: false,
    usePkce: false,
  },
  salesforce: {
    provider: "salesforce",
    // The production login host issues authorization-code grants for
    // both production and My Domain orgs. (Sandboxes use
    // test.salesforce.com; that is out of scope for this read-only
    // support-record connector.)
    authUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    revokeUrl: "https://login.salesforce.com/services/oauth2/revoke",
    // Least-privilege: `api` grants REST access (the connector only
    // issues SOQL `SELECT`/`GET` reads against Cases) and `refresh_token`
    // is Salesforce's protocol scope that makes the grant issue a
    // refresh token. `refresh_token` is treated as a meta-scope (see
    // OAUTH_META_SCOPES) so it is requested but not validated as an API
    // permission. No write/manage scopes are requested.
    scope: "api refresh_token",
    redirectPort: 9906,
    extraAuthorizeParams: {},
    supportsRefresh: true,
    // Salesforce's OAuth2 web-server flow supports PKCE.
    usePkce: true,
  },
  // Tranche 6: per-instance (per-subdomain) OAuth providers. These are
  // the first connectors whose authorize/token endpoints are NOT fixed
  // constants — they live on the tenant's own subdomain and are derived
  // per connection via the `instanceUrls` seam from the validated
  // instance value collected in the connect modal (see
  // shared/connectorConfig.ts). Ports continue the unique sequence from
  // 9907.
  zendesk: {
    provider: "zendesk",
    // Per-subdomain OAuth surface: authorize at
    // `https://<subdomain>.zendesk.com/oauth/authorizations/new`, token
    // exchange at `https://<subdomain>.zendesk.com/oauth/tokens`. The
    // `<subdomain>` is the validated `subdomain` connect field; the host
    // is pinned to `zendesk.com` (SSRF/open-redirect allowlist).
    instanceUrls: {
      instanceField: "subdomain",
      baseDomain: "zendesk.com",
      authorizePath: "/oauth/authorizations/new",
      tokenPath: "/oauth/tokens",
      apiBaseUrlField: "api_base_url",
    },
    // Least-privilege: Zendesk's global `read` scope grants read-only
    // access across the Support API the connector reads (incremental
    // ticket export). No `write` scope is requested.
    scope: "read",
    redirectPort: 9907,
    extraAuthorizeParams: {},
    // Zendesk OAuth access tokens do not expire and the
    // authorization-code grant issues no refresh token, so surface a
    // "reconnect" UX on revocation rather than attempting a refresh.
    supportsRefresh: false,
    // Zendesk's confidential OAuth client authenticates with the
    // client secret on token exchange; its authorize surface does not
    // require PKCE.
    usePkce: false,
  },
  servicenow: {
    provider: "servicenow",
    // Per-instance OAuth surface: authorize at
    // `https://<instance>.service-now.com/oauth_auth.do`, token exchange
    // at `https://<instance>.service-now.com/oauth_token.do`, revoke at
    // `.../oauth_revoke_token.do`. The `<instance>` is the validated
    // `subdomain` connect field; the host is pinned to `service-now.com`.
    instanceUrls: {
      instanceField: "subdomain",
      baseDomain: "service-now.com",
      authorizePath: "/oauth_auth.do",
      tokenPath: "/oauth_token.do",
      revokePath: "/oauth_revoke_token.do",
      apiBaseUrlField: "api_base_url",
    },
    // ServiceNow's OAuth authorize request takes no `scope` parameter —
    // a token inherits the authorizing user's role-based ACLs, and the
    // connector only ever issues read-only GETs against the Table API.
    // Least-privilege is enforced by authenticating with a read-only
    // ServiceNow account. Empty scope is intentional (see
    // SCOPELESS_PROVIDERS in handlers.ts).
    scope: "",
    redirectPort: 9908,
    extraAuthorizeParams: {},
    // ServiceNow issues refresh tokens (access tokens are short-lived,
    // refresh tokens long-lived), so refresh after restart is supported
    // by re-deriving the token URL from the persisted instance value.
    supportsRefresh: true,
    // ServiceNow's default OAuth provider authenticates the confidential
    // client with its secret on token exchange; PKCE is not required.
    usePkce: false,
  },
};

/**
 * Invariant: every provider config declares EITHER a fixed
 * `authUrl` + `tokenUrl` pair OR a per-instance `instanceUrls`
 * template — never both, never neither. Enforced at module load so a
 * malformed config fails fast at startup (and in tests) rather than at
 * the first connect attempt. The corresponding strict-data test asserts
 * the same contract for the whole roster.
 */
function assertOAuthConfigInvariant(config: ProviderOAuthConfig): void {
  const hasFixed = config.authUrl !== undefined || config.tokenUrl !== undefined;
  const hasInstance = config.instanceUrls !== undefined;
  if (hasFixed && hasInstance) {
    throw new Error(
      `OAuth config for ${config.provider} declares both fixed URLs and a per-instance template; they are mutually exclusive.`,
    );
  }
  if (!hasInstance && (!config.authUrl || !config.tokenUrl)) {
    throw new Error(
      `OAuth config for ${config.provider} must declare both authUrl and tokenUrl, or a per-instance instanceUrls template.`,
    );
  }
  if (hasInstance) {
    const t = config.instanceUrls!;
    for (const p of [t.authorizePath, t.tokenPath, ...(t.revokePath ? [t.revokePath] : [])]) {
      if (!p.startsWith("/")) {
        throw new Error(
          `OAuth config for ${config.provider} has a non-absolute instance path "${p}" (must begin with "/").`,
        );
      }
    }
  }
}

for (const cfg of Object.values(PROVIDER_OAUTH_CONFIGS)) {
  assertOAuthConfigInvariant(cfg);
}

export function getProviderOAuthConfig(provider: ProviderId): ProviderOAuthConfig {
  const cfg = PROVIDER_OAUTH_CONFIGS[provider];
  if (!cfg) throw new Error(`Unknown OAuth provider: ${provider}`);
  return cfg;
}

/**
 * A {@link ProviderOAuthConfig} with its authorize/token URLs resolved
 * to concrete strings — fixed-URL providers carry their constants
 * verbatim; per-instance providers carry the URLs derived from the
 * connection's instance value. The OAuth flow functions
 * (`buildAuthorizeUrl`, `exchangeAuthorizationCode`,
 * `refreshProviderToken`, `revokeProviderToken`) and `buildAuthConfig`
 * consume this rather than the raw config so neither the authorize step,
 * the token exchange, nor the refresh can run against an unresolved URL.
 */
export interface ResolvedProviderOAuthConfig extends ProviderOAuthConfig {
  authUrl: string;
  tokenUrl: string;
  /**
   * For per-instance providers, the validated `https://<instance>.<baseDomain>`
   * origin the URLs were derived from (no path). `undefined` for
   * fixed-URL providers.
   */
  instanceOrigin?: string;
}

/**
 * Error thrown when a per-instance OAuth provider's instance value is
 * missing or fails the strict host-allowlist validation. Carries the
 * provider id so callers can surface a precise, non-secret message.
 */
export class InstanceUrlError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = "InstanceUrlError";
    this.provider = provider;
    // Restore the prototype chain so `instanceof` works across the
    // TS-down-target compile (same rationale as `MissingScopeError`).
    Object.setPrototypeOf(this, InstanceUrlError.prototype);
  }
}

/**
 * A single RFC-1035 DNS label: lowercase letters/digits/hyphen, no
 * leading or trailing hyphen, 2–63 chars. This is the ONLY shape a
 * per-instance value may take — it cannot contain a dot, slash, `@`,
 * port, or any other authority-smuggling character, so
 * `https://<label>.<baseDomain>` always resolves to a host under the
 * trusted `baseDomain`. The minimum of two characters (the trailing
 * group is mandatory, not optional) is a deliberate subset of RFC-1035:
 * no real Zendesk/ServiceNow instance is a single character, so we
 * reject one-char labels here AND at connect time (a `minLength: 2`
 * rule) rather than deriving a host like `https://a.zendesk.com`. The
 * connect-modal inline validator keeps its `pattern` byte-for-byte in
 * lockstep with this regex (case-insensitively — values are lowercased
 * here before matching) so the two layers can never diverge.
 */
const INSTANCE_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/;

/** Concrete URLs derived from an {@link InstanceUrlTemplate}. */
export interface DerivedInstanceUrls {
  /** `https://<label>.<baseDomain>` (no path). */
  origin: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
}

/**
 * Derive the concrete authorize/token (and optional revoke) URLs for a
 * per-instance provider from a user-supplied instance value, pinning the
 * host to the template's `baseDomain`.
 *
 * Security (the SSRF / open-redirect boundary):
 *   1. The instance value is trimmed, lowercased, and must match a
 *      single 2–63 char DNS label ({@link INSTANCE_LABEL_RE}) — no dots,
 *      slashes, `@`, ports, or whitespace, so it cannot encode a
 *      different authority.
 *   2. Each derived URL is re-parsed and its host re-checked to equal
 *      exactly `<label>.<baseDomain>` over `https:` (defence in depth).
 * Any deviation throws {@link InstanceUrlError}.
 */
export function deriveInstanceUrls(
  template: InstanceUrlTemplate,
  rawInstanceValue: string,
): DerivedInstanceUrls {
  const label = rawInstanceValue.trim().toLowerCase();
  if (!INSTANCE_LABEL_RE.test(label)) {
    throw new InstanceUrlError(
      "",
      `Invalid instance value "${rawInstanceValue}": expected a single ${template.baseDomain} subdomain label of at least two characters (letters, digits, hyphens; no dots).`,
    );
  }
  const host = `${label}.${template.baseDomain}`;
  const origin = `https://${host}`;
  const build = (path: string): string => {
    const url = new URL(path, `${origin}/`);
    if (url.protocol !== "https:" || url.host !== host) {
      throw new InstanceUrlError(
        "",
        `Refusing to derive a non-${template.baseDomain} OAuth URL for instance "${rawInstanceValue}".`,
      );
    }
    return url.toString();
  };
  return {
    origin,
    authUrl: build(template.authorizePath),
    tokenUrl: build(template.tokenPath),
    revokeUrl: template.revokePath ? build(template.revokePath) : undefined,
  };
}

/**
 * Resolve a provider's OAuth config into one whose authorize/token URLs
 * are concrete strings.
 *
 *   - Fixed-URL providers: returned unchanged (the constants are already
 *     concrete). `connectorConfig` is ignored.
 *   - Per-instance providers: the instance value is read from
 *     `connectorConfig[instanceField]`, validated, and interpolated into
 *     the authorize/token/revoke URLs (and the derived origin is exposed
 *     as `instanceOrigin`). A missing or malformed value throws
 *     {@link InstanceUrlError}.
 *
 * Callers MUST resolve before running any OAuth flow or building the
 * Rust `auth_config`, so the per-instance value persisted with the
 * connection drives the authorize step, the token exchange, AND the
 * token refresh (after restart) from a single validated source.
 */
export function resolveProviderOAuthConfig(
  provider: ProviderId,
  connectorConfig?: Record<string, string> | null,
): ResolvedProviderOAuthConfig {
  const base = getProviderOAuthConfig(provider);
  const template = base.instanceUrls;
  if (!template) {
    // Fixed-URL provider. The module-load invariant guarantees both
    // URLs are present; assert here so the narrowing is type-safe.
    if (!base.authUrl || !base.tokenUrl) {
      throw new Error(
        `OAuth config for ${provider} is missing authUrl/tokenUrl and declares no per-instance template.`,
      );
    }
    return { ...base, authUrl: base.authUrl, tokenUrl: base.tokenUrl };
  }
  const instanceValue = connectorConfig?.[template.instanceField];
  if (!instanceValue || instanceValue.trim().length === 0) {
    throw new InstanceUrlError(
      provider,
      `${provider} requires a "${template.instanceField}" value to derive its OAuth URLs.`,
    );
  }
  let derived: DerivedInstanceUrls;
  try {
    derived = deriveInstanceUrls(template, instanceValue);
  } catch (err) {
    // Re-stamp the provider id onto the (provider-less) derivation error.
    if (err instanceof InstanceUrlError) {
      throw new InstanceUrlError(provider, err.message);
    }
    throw err;
  }
  return {
    ...base,
    authUrl: derived.authUrl,
    tokenUrl: derived.tokenUrl,
    revokeUrl: derived.revokeUrl ?? base.revokeUrl,
    instanceOrigin: derived.origin,
  };
}

/**
 * Read a resolved authorize/token URL off a config, throwing a clear
 * error if it is still unresolved. The OAuth flow functions accept a
 * `ProviderOAuthConfig` (so fixed-URL providers can be passed directly),
 * but a per-instance config that was not run through
 * `resolveProviderOAuthConfig` has no URL — this guard converts that
 * programmer error into an explicit, non-silent failure instead of a
 * `fetch(undefined)` / `new URL(undefined)` crash.
 */
function requireResolvedUrl(
  config: ProviderOAuthConfig,
  field: "authUrl" | "tokenUrl",
): string {
  const url = config[field];
  if (!url) {
    throw new Error(
      `${config.provider}: ${field} is unresolved — call resolveProviderOAuthConfig() with the connection's instance value before running the OAuth flow.`,
    );
  }
  return url;
}

export function getRedirectUri(config: ProviderOAuthConfig): string {
  const host = config.redirectHost ?? "127.0.0.1";
  return `http://${host}:${config.redirectPort}/callback`;
}

/**
 * Return the full redirect-URI map for every known provider.
 *
 * The renderer's `ConnectorsList` used to hardcode a per-provider
 * fallback URI that had to match the `redirectPort` / `redirectHost`
 * declared here — a maintenance trap where updating a port in one
 * place but not the other silently broke OAuth for that provider.
 * Exposing the canonical map via a single IPC call at mount time
 * (`connectors:getAllRedirectUris`) lets the renderer derive the
 * value from this single source of truth and eliminate the duplicate
 * constants entirely.
 */
export function getRedirectUriMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [provider, config] of Object.entries(PROVIDER_OAUTH_CONFIGS)) {
    map[provider] = getRedirectUri(config);
  }
  return map;
}

/** Build the provider authorize URL. */
export function buildAuthorizeUrl(
  config: ProviderOAuthConfig,
  params: {
    clientId: string;
    state: string;
    codeChallenge?: string;
    redirectUri: string;
  },
): string {
  const url = new URL(requireResolvedUrl(config, "authUrl"));
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", params.state);
  // Build the scope param from the canonical requested-scope list so the
  // `offline_access` meta-scope (declared via `requestOfflineAccess`) is
  // applied in exactly one place and the authorize request, the Rust
  // `auth_config`, and scope governance never drift apart.
  const requestedScopes = getRequestedScopes(config);
  if (requestedScopes.length > 0) {
    url.searchParams.set("scope", requestedScopes.join(" "));
  }
  if (params.codeChallenge) {
    url.searchParams.set("code_challenge", params.codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
  }
  for (const [k, v] of Object.entries(config.extraAuthorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

/**
 * Generate a PKCE verifier/challenge pair.
 *
 * Verifier: 64 random URL-safe characters.
 * Challenge: BASE64URL(SHA256(verifier)).
 */
export function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(crypto.randomBytes(48));
  const challenge = base64UrlEncode(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * parse the OAuth `scope` response value
 * into a normalised list of granted scopes.
 *
 * RFC 6749 §3.3 says the value is space-delimited; some providers
 * (Figma in particular) return comma-delimited; we accept either.
 *
 * Returns `null` when the provider omitted the `scope` field
 * entirely (Notion's integration-token flow does this). Callers
 * MUST treat `null` as "unknown" (fall back to requested scopes)
 * rather than "no scopes granted" — those two states are
 * semantically different.
 */
function parseGrantedScopes(value: string | null | undefined): string[] | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/[\s,]+/).filter((s) => s.length > 0);
}

/**
 * Run the loopback redirect server and wait for the OAuth callback.
 * Opens the system browser to the authorize URL and resolves with
 * the returned `code` + `state` (after validating the state matches).
 *
 * Times out after 5 minutes so a stuck flow doesn't hold a port
 * forever.
 */
export async function runRedirectServer(
  config: ProviderOAuthConfig,
  params: { clientId: string; codeChallenge?: string },
): Promise<AuthorizationCodeResult> {
  const state = generateState();
  const redirectUri = getRedirectUri(config);
  const authUrl = buildAuthorizeUrl(config, {
    clientId: params.clientId,
    state,
    codeChallenge: params.codeChallenge,
    redirectUri,
  });

  return new Promise((resolve, reject) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    // Single-shot guard around all `server.close()` + Promise
    // settlement paths. Each event (callback hit, server-level
    // error, timeout) is internally safe — `server.close()` after a
    // prior close is a documented no-op (Node may emit an `'error'`
    // event but the listener is detached by the time we attach the
    // next one), and `resolve`/`reject` on an already-settled
    // Promise are spec no-ops. Even so, racing the timeout against a
    // late callback (or the server-error path against an external
    // close) would historically have invoked `server.close()` twice
    // and walked the cleanup branch twice. Making the guard
    // explicit removes the silent reliance on N layers of
    // idempotency and gives a single place to add future invariants
    // (e.g. event-bus emit, structured-log write).
    let settled = false;
    const settleOnce = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // Already closed or never bound — Node's HTTP server
        // tolerates either case and the surrounding code did so
        // implicitly before this guard existed. Swallowed so the
        // outer Promise settlement path can never reject from a
        // best-effort cleanup.
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      fn();
    };

    const server = http.createServer((req, res) => {
      if (!req.url?.startsWith("/callback")) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const url = new URL(req.url, redirectUri);
      const code = url.searchParams.get("code");
      const returnedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      const respond = (status: number, body: string) => {
        res.writeHead(status, { "Content-Type": "text/html" });
        res.end(body);
      };

      if (error) {
        const desc = url.searchParams.get("error_description") ?? "";
        respond(
          200,
          `<html><body><h2>Authorization failed</h2><p>${escapeHtml(
            error,
          )}${desc ? `: ${escapeHtml(desc)}` : ""}</p><p>You can close this window.</p></body></html>`,
        );
        settleOnce(() =>
          reject(
            new Error(
              `OAuth error from ${config.provider}: ${error}${desc ? ` (${desc})` : ""}`,
            ),
          ),
        );
        return;
      }
      if (!code || returnedState !== state) {
        respond(
          400,
          "<html><body><h2>Invalid response</h2><p>State mismatch or missing code.</p></body></html>",
        );
        settleOnce(() =>
          reject(new Error("Invalid OAuth callback: state mismatch or missing code")),
        );
        return;
      }

      respond(
        200,
        `<html><body><h2>Connected to ${escapeHtml(
          config.provider,
        )}</h2><p>You can close this window and return to Tessera.</p></body></html>`,
      );
      settleOnce(() => resolve({ code, state }));
    });

    // Bind the loopback server to the same host the redirect URI
    // advertises. Most systems map `localhost` to both `127.0.0.1`
    // and `::1`, but on IPv6-only hosts (or hosts where `localhost`
    // resolves only to `::1` per `/etc/hosts`) binding to a literal
    // `127.0.0.1` while telling the browser to fetch `localhost`
    // produces an unreachable callback. Binding to the same host
    // string the redirect URI uses lets Node pick the address family
    // the OS resolves `localhost` to, eliminating the mismatch.
    const bindHost = config.redirectHost ?? "127.0.0.1";
    server.listen(config.redirectPort, bindHost, () => {
      shell.openExternal(authUrl).catch((err) => {
        settleOnce(() => reject(err));
      });
    });

    server.on("error", (err) => {
      // Belt-and-braces: `server.close()` is a no-op when the
      // socket was never successfully bound (the EADDRINUSE /
      // EACCES `listen` failure case, which is by far the
      // dominant cause of 'error' events on Node HTTP servers).
      // But an 'error' event CAN also fire after a successful
      // `listen` for connection-level failures, in which case the
      // listener is still bound to the port — calling close() here
      // releases it deterministically rather than relying on GC.
      // Cheap insurance against the rare post-listen error path.
      settleOnce(() =>
        reject(
          new Error(
            `Failed to start OAuth redirect server for ${config.provider} on port ${config.redirectPort}: ${err.message}`,
          ),
        ),
      );
    });

    timeoutId = setTimeout(() => {
      settleOnce(() =>
        reject(new Error(`OAuth flow for ${config.provider} timed out after 5 minutes`)),
      );
    }, 300_000);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeAuthorizationCode(
  config: ProviderOAuthConfig,
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    codeVerifier?: string;
  },
): Promise<TokenResponse> {
  const redirectUri = getRedirectUri(config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: redirectUri,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };

  if (config.basicAuth) {
    const auth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString(
      "base64",
    );
    headers.Authorization = `Basic ${auth}`;
  } else {
    body.set("client_id", params.clientId);
    body.set("client_secret", params.clientSecret);
  }

  if (params.codeVerifier) {
    body.set("code_verifier", params.codeVerifier);
  }

  const resp = await fetch(requireResolvedUrl(config, "tokenUrl"), {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Token exchange failed for ${config.provider}: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }

  const raw = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    [k: string]: unknown;
  };

  // RFC 6749 returns the token in `access_token`; a provider may use a
  // non-standard field (Intercom → `token`). Read the configured field
  // first, then fall back to the standard one so the override is safe
  // even if the provider later returns the standard field.
  const accessTokenField = config.accessTokenField ?? "access_token";
  const fieldValue = raw[accessTokenField];
  const accessToken =
    (typeof fieldValue === "string" ? fieldValue : undefined) ?? raw.access_token;

  if (!accessToken) {
    throw new Error(
      `Token exchange for ${config.provider} returned no access token`,
    );
  }

  const { refresh_token, expires_in, token_type, scope, ...rest } = raw;
  // Keep the raw access-token secret out of the passthrough `extra`
  // payload — strip both the standard and the provider-specific field.
  delete rest.access_token;
  delete rest[accessTokenField];
  const extra = rest;
  return {
    accessToken,
    refreshToken: refresh_token ?? null,
    grantedScopes: parseGrantedScopes(scope),
    // Providers that document their access tokens as non-expiring (e.g.
    // Notion's integration tokens) typically omit `expires_in` entirely
    // from the token-exchange response. Defaulting to a normal 1-hour
    // lifetime there would make every stored token look "expired" after
    // an hour and trigger the auth-state cleanup path (see the
    // non-refreshable guard in `handlers.getValidAccessToken`). For
    // those providers we store an effectively-non-expiring value so
    // inspection / debugging surfaces a sensible `expiresAt`. The
    // expiry check still short-circuits for them, so this is
    // defense-in-depth, not the load-bearing fix.
    expiresIn:
      typeof expires_in === "number"
        ? expires_in
        : config.supportsRefresh
          ? 3600
          : 10 * 365 * 24 * 3600,
    tokenType: token_type ?? "Bearer",
    extra,
  };
}

/**
 * Exchange a refresh token for a new access token.
 *
 * Refresh-token behaviour per provider:
 *   - Atlassian (Jira + Confluence): returns a new refresh token on
 *     every refresh.
 *   - Microsoft Graph (OneDrive): returns a new refresh token on
 *     every refresh.
 *   - Google (Drive): sometimes returns a new refresh token; callers
 *     persist the new one when present, fall through to the previous
 *     one when absent.
 *   - Notion: does not support refresh tokens at all
 *     (`supportsRefresh: false` in the config) — when the access
 *     token expires the user must re-authenticate.
 *   - Figma: the modern OAuth v2 flow at
 *     `api.figma.com/v1/oauth/token` returns and accepts refresh
 *     tokens (`supportsRefresh: true`). The early-2024 "classic"
 *     endpoint that did not support refresh has been retired; this
 *     comment reflects the live config.
 *
 * Callers must check `config.supportsRefresh` before invoking this;
 * the early `if (!config.supportsRefresh) throw` below is a guard,
 * not an error path that callers should rely on.
 */
export async function refreshProviderToken(
  config: ProviderOAuthConfig,
  params: {
    refreshToken: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<TokenResponse> {
  if (!config.supportsRefresh) {
    throw new Error(
      `${config.provider} does not support refresh tokens — user must re-authenticate`,
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (config.basicAuth) {
    const auth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString(
      "base64",
    );
    headers.Authorization = `Basic ${auth}`;
  } else {
    body.set("client_id", params.clientId);
    body.set("client_secret", params.clientSecret);
  }

  const resp = await fetch(requireResolvedUrl(config, "tokenUrl"), {
    method: "POST",
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Token refresh failed for ${config.provider}: HTTP ${resp.status} — ${text.slice(0, 500)}`,
    );
  }

  const raw = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    [k: string]: unknown;
  };

  // Mirror `exchangeAuthorizationCode`: honour a provider-specific
  // access-token field (Intercom → `token`) with a fallback to the
  // standard `access_token`, so a future provider that both overrides
  // `accessTokenField` and supports refresh reads the right field here
  // instead of silently failing.
  const accessTokenField = config.accessTokenField ?? "access_token";
  const fieldValue = raw[accessTokenField];
  const accessToken =
    (typeof fieldValue === "string" ? fieldValue : undefined) ?? raw.access_token;

  if (!accessToken) {
    throw new Error(
      `Token refresh for ${config.provider} returned no access token`,
    );
  }

  const { refresh_token, expires_in, token_type, scope, ...rest } = raw;
  // Keep the raw access-token secret out of the passthrough `extra`
  // payload — strip both the standard and the provider-specific field.
  delete rest.access_token;
  delete rest[accessTokenField];
  const extra = rest;
  return {
    accessToken,
    refreshToken: refresh_token ?? params.refreshToken,
    grantedScopes: parseGrantedScopes(scope),
    // We bail out at the top of this function when `!supportsRefresh`,
    // so by the time control reaches here `config.supportsRefresh` is
    // always `true` and the non-refreshable-provider branch from
    // `exchangeAuthorizationCode` would be dead code. Keep the simple
    // 1-hour default and let the original token-exchange path own the
    // non-expiring-token defense-in-depth.
    expiresIn: typeof expires_in === "number" ? expires_in : 3600,
    tokenType: token_type ?? "Bearer",
    extra,
  };
}

/** Best-effort token revocation. */
export async function revokeProviderToken(
  config: ProviderOAuthConfig,
  token: string,
): Promise<void> {
  if (!config.revokeUrl) {
    // Microsoft, Notion, Atlassian, Figma don't expose a public revoke
    // endpoint for native apps. Tessera revokes by deleting the local
    // token store; the user can revoke server-side via the provider's
    // app settings.
    return;
  }
  try {
    await fetch(
      `${config.revokeUrl}?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      },
    );
  } catch {
    // best effort
  }
}
