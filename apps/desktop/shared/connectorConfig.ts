/**
 * Per-target / non-OAuth2 connector configuration — the single source
 * of truth shared by the Electron main process (which validates the
 * inputs, persists them alongside the provider's tokens, and injects
 * them into the `auth_config` bag the Rust connector reads) and the
 * renderer connect modal (which renders the inputs).
 *
 * Background: the "fast path" connectors (Google Drive, Notion, …) are
 * whole-account, read-only OAuth2 providers — the user supplies only an
 * OAuth client id/secret and the browser authorization-code flow does
 * the rest. The connectors in this module need MORE than that:
 *
 *   - **Per-target scoping**: Asana syncs a single project, Microsoft
 *     Teams a single team + channel, GitLab a single project. The
 *     upstream connector reads these target ids from `auth_config_json`
 *     and errors clearly if one is missing, so the host must collect
 *     and persist them at connect time.
 *   - **Non-OAuth2 credentials**: Trello authenticates with an API
 *     key + token pair (not an OAuth2 browser grant) and GitLab is
 *     wired with a personal access token (which works uniformly across
 *     gitlab.com and self-managed instances without per-instance OAuth
 *     app registration). These connect via {@link ConnectorConnectMethod}
 *     `"token"`: no browser flow, the user-supplied credential becomes
 *     the connector's bearer/access token directly.
 *
 * This module is intentionally dependency-free (no Electron, no Node)
 * so the renderer can import it directly without crossing the
 * main/renderer trust boundary or pulling in `electron`.
 */

/**
 * How a provider establishes its connection.
 *
 *   - `"oauth2"`: the standard browser authorization-code flow. The
 *     user supplies an OAuth client id (+ secret); Tessera opens the
 *     provider's consent screen and exchanges the returned code for a
 *     token. May ALSO require per-target {@link ConnectorConfigField}s
 *     (e.g. Asana's project, Teams' team/channel) collected in the
 *     same modal and persisted alongside the token.
 *   - `"token"`: no browser flow. The user pastes a long-lived
 *     credential (a GitLab personal access token, a Trello API token)
 *     which becomes the connector's access token directly. The
 *     `tokenField` names which {@link ConnectorConfigField} carries
 *     that credential.
 */
export type ConnectorConnectMethod = "oauth2" | "token";

/**
 * A single user-supplied input collected at connect time. The `key` is
 * the exact `auth_config_json` field name the upstream Rust connector
 * reads (e.g. Trello's `key`, GitLab's `project_id`), so renaming one
 * here without matching the connector would silently break sync.
 */
export interface ConnectorConfigField {
  /** `auth_config_json` field name the upstream connector reads. */
  key: string;
  /** Human label shown next to the input in the connect modal. */
  label: string;
  /** Whether the connector errors without this field. */
  required: boolean;
  /**
   * Whether the value is a credential. Secret fields render as a
   * password input in the UI and are stored encrypted in the OS
   * keychain vault (never written to disk in plaintext).
   */
  secret: boolean;
  /** Optional input placeholder. */
  placeholder?: string;
  /** Optional one-line help shown under the input. */
  help?: string;
}

/**
 * Full connect specification for a provider that needs more than a
 * bare OAuth client id/secret.
 */
export interface ConnectorConnectSpec {
  connectMethod: ConnectorConnectMethod;
  /**
   * For `connectMethod: "token"` only — the {@link ConnectorConfigField}
   * `key` whose value becomes the connector's access token. That field
   * is therefore NOT injected into the `auth_config` bag (it travels as
   * the token instead); every other field is.
   */
  tokenField?: string;
  /** Ordered inputs to collect in the connect modal. */
  configFields: ConnectorConfigField[];
}

/**
 * Connect specs keyed by provider id. Providers absent from this map
 * use the default whole-account OAuth2 flow with no extra inputs (see
 * {@link getConnectSpec}).
 */
export const CONNECTOR_CONNECT_SPECS: Record<string, ConnectorConnectSpec> = {
  asana: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "project",
        label: "Project ID",
        required: true,
        secret: false,
        placeholder: "1201234567890123",
        help:
          "The numeric gid of the Asana project to index. Open the project in Asana — it is the long number in the URL (…/0/<project gid>/list).",
      },
      {
        key: "api_base_url",
        label: "API base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://app.asana.com/api/1.0",
        help: "Leave blank unless Asana directs you to a region-specific API host.",
      },
    ],
  },
  gitlab: {
    connectMethod: "token",
    tokenField: "personal_access_token",
    configFields: [
      {
        key: "personal_access_token",
        label: "Personal access token",
        required: true,
        secret: true,
        placeholder: "glpat-…",
        help:
          "Create a token with the read-only read_api scope (Settings → Access Tokens). Works for gitlab.com and self-managed instances.",
      },
      {
        key: "project_id",
        label: "Project ID or path",
        required: true,
        secret: false,
        placeholder: "12345  (or  group/subgroup/project)",
        help:
          "The numeric project ID (shown on the project's home page) or its full namespace path.",
      },
      {
        key: "api_base_url",
        label: "Self-managed base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://gitlab.example.com",
        help: "Leave blank for gitlab.com. Set the instance origin for self-managed GitLab.",
      },
    ],
  },
  teams: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "team_id",
        label: "Team ID",
        required: true,
        secret: false,
        placeholder: "19:abcd…@thread.tacv2",
        help:
          "In Teams, open the team → ⋯ → Get link to team; the groupId query parameter is the team ID.",
      },
      {
        key: "channel_id",
        label: "Channel ID",
        required: true,
        secret: false,
        placeholder: "19:abcd…@thread.tacv2",
        help:
          "Open the channel → ⋯ → Get link to channel; the channel ID is the first segment of the link.",
      },
    ],
  },
  trello: {
    connectMethod: "token",
    tokenField: "token",
    configFields: [
      {
        key: "key",
        label: "API key",
        required: true,
        secret: true,
        placeholder: "32-character key",
        help: "From https://trello.com/app-key — the Power-Up/API key for your account.",
      },
      {
        key: "token",
        label: "API token",
        required: true,
        secret: true,
        placeholder: "read-only token",
        help:
          "On the same page choose Token and authorise read-only access; paste the generated token here.",
      },
      {
        key: "board_id",
        label: "Board ID",
        required: true,
        secret: false,
        placeholder: "24-character board id",
        help:
          "Open the board, append .json to its URL, and copy the top-level id value.",
      },
    ],
  },
};

/** Fallback spec for providers using the plain whole-account OAuth2 flow. */
const DEFAULT_OAUTH2_SPEC: ConnectorConnectSpec = {
  connectMethod: "oauth2",
  configFields: [],
};

/**
 * Resolve a provider's connect spec, defaulting to the whole-account
 * OAuth2 flow (no extra inputs) when the provider is not in
 * {@link CONNECTOR_CONNECT_SPECS}.
 */
export function getConnectSpec(provider: string): ConnectorConnectSpec {
  return CONNECTOR_CONNECT_SPECS[provider] ?? DEFAULT_OAUTH2_SPEC;
}

/**
 * The config fields injected into the `auth_config` bag for a provider
 * — every declared field except the `tokenField` (which travels as the
 * access token, not in the bag). Order-preserving.
 */
export function authConfigFields(provider: string): ConnectorConfigField[] {
  const spec = getConnectSpec(provider);
  return spec.configFields.filter((f) => f.key !== spec.tokenField);
}
