/**
 * Connector descriptors (provider metadata) consumed by the
 * `ConnectorsList` component and its unit tests.
 *
 * This module is intentionally a sibling of `ConnectorsList.tsx`
 * rather than a member of the component file. React Fast Refresh
 * preserves component state across HMR edits only when a file's
 * exports are ALL components; mixing a constant export (this
 * descriptor array) alongside the default-exported component
 * breaks the fast-refresh boundary and causes the entire renderer
 * subtree to remount on every save. Splitting the descriptors
 * into a pure-data module restores HMR for the component itself
 * and keeps the descriptors trivially unit-testable as data.
 */
export interface ConnectorDescriptor {
  provider: string;
  label: string;
  /** Where the user creates an OAuth app + redirect URI to copy in. */
  consoleUrl: string;
  /** Help text shown in the connect modal. */
  help: string;
  /** Some providers (Notion) accept no secret in the public model. */
  secretRequired?: boolean;
}

/**
 * Connector metadata used by the renderer. The redirect URI is
 * intentionally NOT stored here — it is fetched from the main
 * process at mount time via `api.connectors.getAllRedirectUris()`
 * so that `providerOAuth.ts > PROVIDER_OAUTH_CONFIGS` remains the
 * single source of truth. Hardcoded fallbacks were removed
 * because they introduced a drift surface: a port-number change in
 * the OAuth config would silently work in the OAuth flow but show
 * a stale URI in the modal, leaving the user with
 * `redirect_uri_mismatch` errors that took several support cycles
 * to diagnose.
 */
export const CONNECTOR_DESCRIPTORS: ConnectorDescriptor[] = [
  {
    provider: "google_drive",
    label: "Google Drive",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    consoleUrl:
      "https://entra.microsoft.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    help: "Register an app in Microsoft Entra ID with the redirect URI below and request Files.Read.All + offline_access.",
    secretRequired: true,
  },
  {
    provider: "notion",
    label: "Notion",
    consoleUrl: "https://www.notion.so/my-integrations",
    help: "Create a Public integration in Notion and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "jira",
    label: "Jira (Atlassian)",
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:jira-work + offline_access scopes and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "confluence",
    label: "Confluence (Atlassian)",
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:confluence-content.* + offline_access scopes and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "figma",
    label: "Figma",
    consoleUrl: "https://www.figma.com/developers/apps",
    help: "Create a Figma OAuth app, request files:read, and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "hubspot",
    label: "HubSpot",
    consoleUrl: "https://developers.hubspot.com/get-started",
    help: "Create a HubSpot app, add the CRM read scopes and the redirect URI below, then copy the app's Client ID and Client Secret.",
    secretRequired: true,
  },
  {
    provider: "slack",
    label: "Slack",
    consoleUrl: "https://api.slack.com/apps",
    help: "Create a Slack app, add the channels/users read scopes under 'OAuth & Permissions', and register the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "email",
    label: "Email (Gmail)",
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Gmail API, and add the redirect URI below.",
    secretRequired: true,
  },
  {
    provider: "github",
    label: "GitHub",
    consoleUrl: "https://github.com/settings/developers",
    help: "Register a GitHub OAuth App with the redirect URI below and request repo + read:org scopes, then copy the Client ID and Client Secret.",
    secretRequired: true,
  },
];
