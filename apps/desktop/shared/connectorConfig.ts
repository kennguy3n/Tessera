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
 * Declarative client-side validation rule for a {@link ConnectorConfigField}.
 *
 * These rules drive the connect modal's INLINE per-field validation:
 * the renderer checks the entered value against the rule and surfaces a
 * precise message next to the field (and disables Connect) before any
 * IPC round-trip, so an obvious format mistake — a GitLab token missing
 * its `glpat-` prefix, a malformed base URL — never reaches the backend
 * as a raw connector error.
 *
 * The rules are intentionally CONSERVATIVE: the upstream connectors
 * percent-encode whatever id they are given into a request path and do
 * not themselves constrain the format, so a rule that is too strict
 * would reject a legitimate value and block a real tenant. Each field
 * therefore only validates the unambiguous, documented shape of its
 * credential/id. The data lives here (not in the renderer) so the
 * connect-spec stays the single source of truth and the rules are
 * unit-testable as pure data.
 */
export interface ConnectorFieldValidation {
  /**
   * Regular-expression SOURCE (no anchors/flags) the trimmed value must
   * match in full. The validator anchors it as `^(?:…)$` and compiles
   * it once (cached), so callers supply only the body.
   */
  pattern?: string;
  /** Minimum trimmed length (inclusive). */
  minLength?: number;
  /** Maximum trimmed length (inclusive). */
  maxLength?: number;
  /**
   * When true, a non-empty value must parse as an absolute `https://`
   * URL. Used for optional self-managed/region API base URLs.
   */
  httpsUrl?: boolean;
  /** Message shown next to the field when the value fails the rule. */
  message: string;
}

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
  /**
   * JSON type the value must take in the `auth_config_json` bag. The
   * connect modal always collects a string, but some upstream
   * connectors read a field as a typed JSON value rather than a string
   * — e.g. monday.com reads `board_id` via `serde_json::Value::as_i64`,
   * so a string `"123"` would fail its `is required` check. Declaring
   * `valueType: "integer"` makes `buildAuthConfig` emit a JSON number
   * for that field. Defaults to `"string"` (the common case). A field
   * marked `"integer"` should also carry a digits-only `validation`
   * pattern so a non-numeric entry is rejected inline before injection.
   */
  valueType?: "string" | "integer";
  /**
   * Optional declarative format rule driving inline validation in the
   * connect modal. Absent ⇒ only the required/non-empty check applies.
   */
  validation?: ConnectorFieldValidation;
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
  /**
   * HTTP authentication scheme the upstream connector sends the stored
   * credential with — the `token_type` on the wire token the Rust
   * connector reads. Defaults to `"Bearer"` (the OAuth2 norm, and what
   * every Bearer-token connector expects). Discord is the sole
   * exception: a Discord bot token must be sent as
   * `Authorization: Bot <token>`, so its spec sets `tokenType: "Bot"`.
   * This is the single source of truth for the scheme; it is threaded
   * into the wire token in `connectorsV2.ts > storedToWire`.
   */
  tokenType?: string;
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
        help: "The numeric gid of the Asana project to index. Open the project in Asana — it is the long number in the URL (…/0/<project gid>/list).",
        validation: {
          pattern: "\\d+",
          message:
            "The Asana project gid is the numeric value from the project URL.",
        },
      },
      {
        key: "api_base_url",
        label: "API base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://app.asana.com/api/1.0",
        help: "Leave blank unless Asana directs you to a region-specific API host.",
        validation: {
          httpsUrl: true,
          message:
            "Enter a full https:// URL, e.g. https://app.asana.com/api/1.0.",
        },
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
        help: "Create a token with the read-only read_api scope (Settings → Access Tokens). Works for gitlab.com and self-managed instances.",
        validation: {
          // GitLab personal/project/group access tokens are the
          // `glpat-` prefix followed by a 20+ char URL-safe body.
          pattern: "glpat-[A-Za-z0-9_-]{20,}",
          message:
            "GitLab access tokens start with 'glpat-' followed by the token body.",
        },
      },
      {
        key: "project_id",
        label: "Project ID or path",
        required: true,
        secret: false,
        placeholder: "12345  (or  group/subgroup/project)",
        help: "The numeric project ID (shown on the project's home page) or its full namespace path.",
        validation: {
          // Either the numeric id, or a namespace path of one or more
          // `/`-separated segments (group/subgroup/project).
          pattern:
            "\\d+|[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*",
          message:
            "Enter the numeric project ID or its group/subgroup/project path.",
        },
      },
      {
        key: "api_base_url",
        label: "Self-managed base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://gitlab.example.com",
        help: "Leave blank for gitlab.com. Set the instance origin for self-managed GitLab.",
        validation: {
          httpsUrl: true,
          message:
            "Enter a full https:// URL, e.g. https://gitlab.example.com.",
        },
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
        placeholder: "a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d",
        help: "In Teams, open the team → ⋯ → Get link to team; the groupId query parameter (a GUID) is the team ID.",
        validation: {
          // Microsoft group/team IDs are GUIDs.
          pattern:
            "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
          message: "The Team ID is the groupId GUID from the team link.",
        },
      },
      {
        key: "channel_id",
        label: "Channel ID",
        required: true,
        secret: false,
        placeholder: "19:abcd…@thread.tacv2",
        help: "Open the channel → ⋯ → Get link to channel; the channel ID is the first segment of the link.",
        validation: {
          // Teams channel thread ids: `19:<body>@thread.tacv2` (or the
          // legacy `@thread.skype`).
          pattern: "19:[A-Za-z0-9._-]+@thread\\.(tacv2|skype)",
          message: "The Channel ID looks like 19:…@thread.tacv2.",
        },
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
        validation: {
          // Trello API keys are 32-char alphanumeric.
          pattern: "[A-Za-z0-9]{32}",
          message: "A Trello API key is 32 letters and digits.",
        },
      },
      {
        key: "token",
        label: "API token",
        required: true,
        secret: true,
        placeholder: "read-only token",
        help: "On the same page choose Token and authorise read-only access; paste the generated token here.",
        validation: {
          // Trello tokens are 64+ alphanumeric characters.
          pattern: "[A-Za-z0-9]{64,}",
          message: "A Trello API token is 64+ letters and digits.",
        },
      },
      {
        key: "board_id",
        label: "Board ID",
        required: true,
        secret: false,
        placeholder: "24-character board id",
        help: "Open the board, append .json to its URL, and copy the top-level id value.",
        validation: {
          // The board's short link (8 chars) or its full 24-char hex id.
          pattern: "[A-Za-z0-9]{8}|[a-fA-F0-9]{24}",
          message:
            "Enter the board's 24-character id (or its 8-character short link).",
        },
      },
    ],
  },
  // ── Tranche 4: per-target / per-resource providers ─────────────────
  discord: {
    connectMethod: "token",
    tokenField: "bot_token",
    // A Discord bot token authenticates with the `Bot` scheme, not the
    // OAuth2 `Bearer` default: the REST API rejects `Authorization:
    // Bearer <bot token>`. See ConnectorConnectSpec.tokenType.
    tokenType: "Bot",
    configFields: [
      {
        key: "bot_token",
        label: "Bot token",
        required: true,
        secret: true,
        placeholder: "bot token",
        help: "In the Discord Developer Portal open your application → Bot → Reset Token. Invite the bot to your server with only the read-only View Channels + Read Message History permissions.",
        validation: {
          // Discord bot tokens are three dot-separated base64url
          // segments (~59-72 chars). Validate the charset + a
          // conservative minimum length without over-constraining the
          // exact segment sizes (which Discord has changed over time).
          pattern: "[A-Za-z0-9_.-]{50,}",
          message:
            "Paste the full Discord bot token from the Developer Portal.",
        },
      },
      {
        key: "channel_id",
        label: "Channel ID",
        required: true,
        secret: false,
        placeholder: "1107583106847408128",
        help: "Enable Developer Mode (User Settings → Advanced), then right-click the channel → Copy Channel ID.",
        validation: {
          // Discord IDs are snowflakes: 17-20 digit integers.
          pattern: "\\d{17,20}",
          message:
            "The Channel ID is the 17-20 digit number from Copy Channel ID.",
        },
      },
      {
        key: "api_base_url",
        label: "API base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://discord.com/api/v10",
        help: "Leave blank unless you proxy the Discord REST API through a different host.",
        validation: {
          httpsUrl: true,
          message:
            "Enter a full https:// URL, e.g. https://discord.com/api/v10.",
        },
      },
    ],
  },
  bitbucket: {
    connectMethod: "token",
    tokenField: "access_token",
    configFields: [
      {
        key: "access_token",
        label: "Access token",
        required: true,
        secret: true,
        placeholder: "repository access token",
        help: "Create a Repository (or Workspace) Access Token with the read-only repository + pullrequest scopes (Repository settings → Access tokens). Paste it here.",
        validation: {
          // Bitbucket access tokens / app passwords are opaque; only a
          // conservative charset + length is enforced.
          pattern: "[A-Za-z0-9_.=+/-]{20,}",
          message: "Paste the Bitbucket access token (20+ characters).",
        },
      },
      {
        key: "workspace",
        label: "Workspace ID",
        required: true,
        secret: false,
        placeholder: "my-workspace",
        help: "The workspace slug from the repository URL: bitbucket.org/<workspace>/<repo>.",
        validation: {
          // Bitbucket workspace slugs: alphanumeric plus -_ separators.
          pattern: "[A-Za-z0-9][A-Za-z0-9_-]*",
          message: "Enter the workspace slug, e.g. my-workspace.",
        },
      },
      {
        key: "repo_slug",
        label: "Repository slug",
        required: true,
        secret: false,
        placeholder: "my-repo",
        help: "The repository slug from the URL: bitbucket.org/<workspace>/<repo>.",
        validation: {
          // Repo slugs allow a dot in addition to the workspace charset.
          pattern: "[A-Za-z0-9][A-Za-z0-9_.-]*",
          message: "Enter the repository slug, e.g. my-repo.",
        },
      },
      {
        key: "api_base_url",
        label: "Server base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://api.bitbucket.org/2.0",
        help: "Leave blank for Bitbucket Cloud. Set the API origin for Bitbucket Server/Data Center.",
        validation: {
          httpsUrl: true,
          message:
            "Enter a full https:// URL, e.g. https://api.bitbucket.org/2.0.",
        },
      },
    ],
  },
  airtable: {
    connectMethod: "token",
    tokenField: "personal_access_token",
    configFields: [
      {
        key: "personal_access_token",
        label: "Personal access token",
        required: true,
        secret: true,
        placeholder: "pat…",
        help: "Create a personal access token at airtable.com/create/tokens with the read-only data.records:read + schema.bases:read scopes, granted to the base you want to index.",
        validation: {
          // Airtable PATs are `pat` + 14 alphanumerics + "." + a 64+
          // char secret body.
          pattern: "pat[A-Za-z0-9]{14}\\.[A-Za-z0-9]{40,}",
          message: "An Airtable token looks like patXXXXXXXXXXXXXX.<secret>.",
        },
      },
      {
        key: "base_id",
        label: "Base ID",
        required: true,
        secret: false,
        placeholder: "appXXXXXXXXXXXXXX",
        help: "Open the base in the Airtable API docs (airtable.com/api) — the base ID is the appXXXXXXXXXXXXXX value.",
        validation: {
          // Airtable base IDs are `app` followed by 14 alphanumerics.
          pattern: "app[A-Za-z0-9]{14}",
          message: "A base ID looks like appXXXXXXXXXXXXXX.",
        },
      },
      {
        key: "table",
        label: "Table name or ID",
        required: true,
        secret: false,
        placeholder: "Tasks  (or  tblXXXXXXXXXXXXXX)",
        help: "The exact table name as shown in Airtable, or its tblXXXXXXXXXXXXXX id.",
      },
      {
        key: "api_base_url",
        label: "API base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://api.airtable.com",
        help: "Leave blank unless Airtable directs you to a different API host.",
        validation: {
          httpsUrl: true,
          message: "Enter a full https:// URL, e.g. https://api.airtable.com.",
        },
      },
    ],
  },
  monday: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "board_id",
        label: "Board ID",
        required: true,
        secret: false,
        // The upstream monday connector reads board_id as a JSON
        // integer (`serde_json::Value::as_i64`), so it must be injected
        // into auth_config_json as a number, not a string.
        valueType: "integer",
        placeholder: "1234567890",
        help: "Open the board in monday.com — the board ID is the numeric value at the end of the URL (…/boards/<board id>).",
        validation: {
          // monday.com board IDs are integers.
          pattern: "\\d+",
          message: "The board ID is the numeric value from the board URL.",
        },
      },
    ],
  },
  clickup: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "team_id",
        label: "Workspace (Team) ID",
        required: true,
        secret: false,
        // The upstream ClickUp connector reads team_id as a string and
        // percent-encodes it into `/api/v2/team/{team_id}/task`, so it
        // is injected as a JSON string (not a number).
        placeholder: "9001234567",
        help: "Open ClickUp in the browser — the Workspace (Team) ID is the numeric value in the URL (app.clickup.com/<team id>/…).",
        validation: {
          // ClickUp Workspace/Team IDs are numeric.
          pattern: "\\d+",
          message:
            "The Workspace ID is the numeric value from the ClickUp URL.",
        },
      },
      {
        key: "api_base_url",
        label: "API base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://api.clickup.com",
        help: "Leave blank unless ClickUp directs you to a different API host.",
        validation: {
          httpsUrl: true,
          message: "Enter a full https:// URL, e.g. https://api.clickup.com.",
        },
      },
    ],
  },
  intercom: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "api_base_url",
        label: "API base URL (optional)",
        required: false,
        secret: false,
        placeholder: "https://api.intercom.io",
        help: "Leave blank for US-hosted workspaces. EU/AU-hosted workspaces use https://api.eu.intercom.io or https://api.au.intercom.io.",
        validation: {
          httpsUrl: true,
          message:
            "Enter a full https:// URL, e.g. https://api.eu.intercom.io.",
        },
      },
    ],
  },
  salesforce: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "api_base_url",
        label: "My Domain instance URL",
        required: true,
        secret: false,
        placeholder: "https://your-domain.my.salesforce.com",
        help: "Your Salesforce org's My Domain URL (Setup → My Domain). The connector reads Cases from this instance — it is per-org, so it must be provided.",
        validation: {
          httpsUrl: true,
          message:
            "Enter your full Salesforce My Domain URL, e.g. https://your-domain.my.salesforce.com.",
        },
      },
    ],
  },
  // Tranche 6: per-instance (per-subdomain) OAuth providers. The
  // `subdomain` field is the per-instance value the OAuth `instanceUrls`
  // seam derives the authorize/token URLs from (see providerOAuth.ts).
  // Its `validation.pattern` MUST stay in lockstep with the seam's
  // `INSTANCE_LABEL_RE` host-allowlist guard: a single 2–63 char DNS
  // label (letters, digits, hyphens; no dots) so the derived host can
  // only be `<subdomain>.<baseDomain>` and never an attacker-chosen host
  // (SSRF/open-redirect). The `minLength: 2` rule mirrors the regex's
  // mandatory trailing group (no real instance is one character) and
  // runs first so a too-short value gets a clear length error rather
  // than a generic pattern failure. The connector reads the derived
  // `api_base_url` origin, not this raw value, so `subdomain` is
  // intentionally NOT a field the upstream connector reads directly.
  zendesk: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "subdomain",
        label: "Zendesk subdomain",
        required: true,
        secret: false,
        placeholder: "acme",
        help: "Just your Zendesk subdomain — the first label of your Zendesk URL (https://<subdomain>.zendesk.com). Enter 'acme' for acme.zendesk.com, not the full URL.",
        validation: {
          // A single 2–63 char DNS label (matches the seam's
          // INSTANCE_LABEL_RE byte-for-byte, case-insensitively — the
          // host derivation lowercases it). `minLength` mirrors the
          // regex's mandatory trailing group.
          minLength: 2,
          pattern: "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])",
          message:
            "Enter just your Zendesk subdomain (at least 2 characters; letters, digits, hyphens) — e.g. 'acme' for acme.zendesk.com.",
        },
      },
    ],
  },
  servicenow: {
    connectMethod: "oauth2",
    configFields: [
      {
        key: "subdomain",
        label: "ServiceNow instance",
        required: true,
        secret: false,
        placeholder: "dev12345",
        help: "Just your ServiceNow instance name — the first label of your instance URL (https://<instance>.service-now.com). Enter 'dev12345' for dev12345.service-now.com, not the full URL.",
        validation: {
          minLength: 2,
          pattern: "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])",
          message:
            "Enter just your ServiceNow instance name (at least 2 characters; letters, digits, hyphens) — e.g. 'dev12345' for dev12345.service-now.com.",
        },
      },
    ],
  },
};

/**
 * Fallback spec for providers using the plain whole-account OAuth2 flow.
 *
 * `getConnectSpec` returns this shared singleton for every provider not in
 * `CONNECTOR_CONNECT_SPECS`, so it is frozen (object + its `configFields`
 * array) to guarantee a caller cannot mutate the empty field list and have
 * it leak across all default providers.
 */
const DEFAULT_OAUTH2_SPEC: ConnectorConnectSpec = {
  connectMethod: "oauth2",
  configFields: [],
};
Object.freeze(DEFAULT_OAUTH2_SPEC.configFields);
Object.freeze(DEFAULT_OAUTH2_SPEC);

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

/**
 * The HTTP auth scheme (`token_type`) the upstream connector sends the
 * stored credential with. Defaults to `"Bearer"` — the OAuth2 norm and
 * what every Bearer-token connector expects — unless the provider's
 * spec overrides it (Discord bot tokens use `"Bot"`). Single source of
 * truth consumed by `connectorsV2.ts > storedToWire`.
 */
export function connectorTokenType(provider: string): string {
  return getConnectSpec(provider).tokenType ?? "Bearer";
}

/**
 * Compiled-pattern cache. A field's `validation.pattern` is a constant
 * from `CONNECTOR_CONNECT_SPECS`, so the same handful of sources are
 * validated on every keystroke; compiling each once (anchored to match
 * the whole value) keeps inline validation allocation-free on the hot
 * path.
 */
const PATTERN_CACHE = new Map<string, RegExp>();

function anchoredPattern(source: string): RegExp {
  let re = PATTERN_CACHE.get(source);
  if (!re) {
    re = new RegExp(`^(?:${source})$`);
    PATTERN_CACHE.set(source, re);
  }
  return re;
}

/** Whether `value` is an absolute `https://` URL. */
function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:";
}

/** Outcome of validating a single field value. */
export interface FieldValidationResult {
  /** Whether the value satisfies the field's required + format rules. */
  valid: boolean;
  /**
   * Human-readable reason the value is invalid, suitable for display
   * next to the field. `undefined` iff `valid` is true.
   */
  error?: string;
}

const VALID: FieldValidationResult = { valid: true };

/**
 * Validate a single connect-modal field value against its declarative
 * rules. Pure and dependency-free so it runs identically in the
 * renderer (inline, per-keystroke) and in unit tests.
 *
 * Order of checks:
 *   1. Required/non-empty (trimmed). An empty optional field is valid.
 *   2. The field's {@link ConnectorFieldValidation} rule, if any:
 *      length bounds, then `https://` URL shape, then the anchored
 *      regex `pattern`. The first failing check yields the rule's
 *      `message`.
 *
 * Whitespace is trimmed before every check, matching how the host
 * normalises values before persisting them.
 */
export function validateConnectorField(
  field: ConnectorConfigField,
  rawValue: string,
): FieldValidationResult {
  const value = rawValue.trim();
  if (value.length === 0) {
    return field.required
      ? { valid: false, error: `${field.label} is required.` }
      : VALID;
  }
  const rule = field.validation;
  if (!rule) return VALID;
  if (rule.minLength !== undefined && value.length < rule.minLength) {
    return { valid: false, error: rule.message };
  }
  if (rule.maxLength !== undefined && value.length > rule.maxLength) {
    return { valid: false, error: rule.message };
  }
  if (rule.httpsUrl && !isHttpsUrl(value)) {
    return { valid: false, error: rule.message };
  }
  if (rule.pattern && !anchoredPattern(rule.pattern).test(value)) {
    return { valid: false, error: rule.message };
  }
  return VALID;
}
