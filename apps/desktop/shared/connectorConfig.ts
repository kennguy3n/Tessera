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
        validation: {
          pattern: "\\d+",
          message: "The Asana project gid is the numeric value from the project URL.",
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
          message: "Enter a full https:// URL, e.g. https://app.asana.com/api/1.0.",
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
        help:
          "Create a token with the read-only read_api scope (Settings → Access Tokens). Works for gitlab.com and self-managed instances.",
        validation: {
          // GitLab personal/project/group access tokens are the
          // `glpat-` prefix followed by a 20+ char URL-safe body.
          pattern: "glpat-[A-Za-z0-9_-]{20,}",
          message: "GitLab access tokens start with 'glpat-' followed by the token body.",
        },
      },
      {
        key: "project_id",
        label: "Project ID or path",
        required: true,
        secret: false,
        placeholder: "12345  (or  group/subgroup/project)",
        help:
          "The numeric project ID (shown on the project's home page) or its full namespace path.",
        validation: {
          // Either the numeric id, or a namespace path of one or more
          // `/`-separated segments (group/subgroup/project).
          pattern: "\\d+|[A-Za-z0-9][A-Za-z0-9_.-]*(?:/[A-Za-z0-9][A-Za-z0-9_.-]*)*",
          message: "Enter the numeric project ID or its group/subgroup/project path.",
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
          message: "Enter a full https:// URL, e.g. https://gitlab.example.com.",
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
        help:
          "In Teams, open the team → ⋯ → Get link to team; the groupId query parameter (a GUID) is the team ID.",
        validation: {
          // Microsoft group/team IDs are GUIDs.
          pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
          message: "The Team ID is the groupId GUID from the team link.",
        },
      },
      {
        key: "channel_id",
        label: "Channel ID",
        required: true,
        secret: false,
        placeholder: "19:abcd…@thread.tacv2",
        help:
          "Open the channel → ⋯ → Get link to channel; the channel ID is the first segment of the link.",
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
        help:
          "On the same page choose Token and authorise read-only access; paste the generated token here.",
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
        help:
          "Open the board, append .json to its URL, and copy the top-level id value.",
        validation: {
          // The board's short link (8 chars) or its full 24-char hex id.
          pattern: "[A-Za-z0-9]{8}|[a-fA-F0-9]{24}",
          message: "Enter the board's 24-character id (or its 8-character short link).",
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
