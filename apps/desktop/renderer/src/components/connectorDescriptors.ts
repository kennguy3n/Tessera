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

/**
 * Stable category buckets for the connector gallery. Keeping this a
 * closed string-literal union (rather than a free-form string) means
 * a typo in a descriptor's `category` is a compile error, and the
 * grouping/ordering logic below can rely on every value being known.
 *
 * Categories are a renderer-only presentation concern — they do NOT
 * exist in the IPC layer or any zod schema, so adding them here
 * cannot affect `check:ipc-types`.
 */
export type ConnectorCategory =
  | "Storage"
  | "Docs & Wiki"
  | "Chat"
  | "CRM"
  | "Issues"
  | "Mail"
  | "Calendar & Meetings"
  | "Design"
  | "Code";

/**
 * Display order for category sections in the gallery. Descriptors
 * are grouped into these buckets in this order; any descriptor with
 * no `category` (or an unknown one) falls into a trailing "Other"
 * bucket so a newly-added provider is never silently dropped from
 * the UI before someone assigns it a category.
 */
export const CONNECTOR_CATEGORY_ORDER: readonly ConnectorCategory[] = [
  "Storage",
  "Docs & Wiki",
  "Chat",
  "CRM",
  "Issues",
  "Mail",
  "Calendar & Meetings",
  "Design",
  "Code",
] as const;

/** Label used for descriptors that have no (or an unknown) category. */
export const UNCATEGORIZED_LABEL = "Other";

export interface ConnectorDescriptor {
  provider: string;
  label: string;
  /** Where the user creates an OAuth app + redirect URI to copy in. */
  consoleUrl: string;
  /** Help text shown in the connect modal. */
  help: string;
  /** Some providers (Notion) accept no secret in the public model. */
  secretRequired?: boolean;
  /**
   * Gallery grouping bucket. Optional on the type so external
   * callers can construct partial descriptors, but every shipped
   * provider below assigns one.
   */
  category?: ConnectorCategory;
  /**
   * Extra free-text search aliases (brand names, synonyms) so the
   * gallery search box finds a connector by terms that don't appear
   * in its `label` — e.g. "microsoft"/"sharepoint" for OneDrive or
   * "atlassian" for Jira/Confluence.
   */
  keywords?: readonly string[];
  /**
   * Plain-language, user-facing summary of the data Tessera reads
   * from this provider. Derived from the read-only OAuth scopes in
   * `electron/ipc/connectors/providerOAuth.ts` (the authoritative
   * source); kept here as human copy because scope strings like
   * `read:jira-work` are not meaningful to an end user. Shown in the
   * "what we read / what we never touch" transparency disclosure.
   */
  reads?: readonly string[];
  /**
   * Plain-language list of things Tessera explicitly never accesses
   * or mutates. Every connector requests read-only scopes, so this
   * always includes "never writes, edits, or deletes anything".
   */
  neverTouches?: readonly string[];
}

/**
 * Boilerplate scope-transparency copy shared by every connector:
 * every provider requests read-only OAuth scopes, so none of them
 * can write, modify, delete, or share remote content, and none
 * grant Tessera a way to act on the user's behalf. Per-provider
 * `neverTouches` entries below extend (not replace) this baseline.
 */
const READ_ONLY_GUARANTEES: readonly string[] = [
  "Never writes, edits, moves, or deletes anything in your account",
  "Never posts, shares, or sends on your behalf",
  "Indexed content stays on this device — it is never uploaded to Tessera",
];

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
    category: "Storage",
    keywords: ["google", "gdrive", "docs", "sheets", "slides"],
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console and add the redirect URI below.",
    secretRequired: true,
    reads: [
      "File and folder names, metadata, and contents you choose to index",
    ],
    neverTouches: [
      "Files you don't select for indexing",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "onedrive",
    label: "OneDrive",
    category: "Storage",
    keywords: ["microsoft", "sharepoint", "office", "entra", "m365"],
    consoleUrl:
      "https://entra.microsoft.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    help: "Register an app in Microsoft Entra ID with the redirect URI below and request Files.Read.All + offline_access.",
    secretRequired: true,
    reads: ["File and folder names, metadata, and contents (read-only)"],
    neverTouches: [
      "Your mailbox, calendar, or Teams chats",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "notion",
    label: "Notion",
    category: "Docs & Wiki",
    keywords: ["wiki", "pages", "knowledge base"],
    consoleUrl: "https://www.notion.so/my-integrations",
    help: "Create a Public integration in Notion and add the redirect URI below.",
    secretRequired: true,
    reads: ["Pages and databases you share with the integration"],
    neverTouches: [
      "Pages outside the workspaces you connect",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "jira",
    label: "Jira (Atlassian)",
    category: "Issues",
    keywords: ["atlassian", "tickets", "issues", "agile", "sprint"],
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:jira-work + offline_access scopes and add the redirect URI below.",
    secretRequired: true,
    reads: ["Issues, projects, and user names you can already see (read-only)"],
    neverTouches: [
      "Issues in projects you cannot access",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "confluence",
    label: "Confluence (Atlassian)",
    category: "Docs & Wiki",
    keywords: ["atlassian", "wiki", "pages", "spaces"],
    consoleUrl: "https://developer.atlassian.com/console/myapps/",
    help: "Create an OAuth 2.0 (3LO) integration with read:confluence-content.* + offline_access scopes and add the redirect URI below.",
    secretRequired: true,
    reads: ["Pages, spaces, and content summaries you can view (read-only)"],
    neverTouches: [
      "Spaces or pages you don't have permission to view",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "figma",
    label: "Figma",
    category: "Design",
    keywords: ["design", "files", "prototypes"],
    consoleUrl: "https://www.figma.com/developers/apps",
    help: "Create a Figma OAuth app, request files:read, and add the redirect URI below.",
    secretRequired: true,
    reads: ["File names and design contents you can access (read-only)"],
    neverTouches: [
      "Your team's billing or admin settings",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "hubspot",
    label: "HubSpot",
    category: "CRM",
    keywords: ["crm", "contacts", "companies", "deals", "sales"],
    consoleUrl: "https://developers.hubspot.com/get-started",
    help: "Create a HubSpot app, add the CRM read scopes and the redirect URI below, then copy the app's Client ID and Client Secret.",
    secretRequired: true,
    reads: ["Contacts, companies, and deals (read-only)"],
    neverTouches: [
      "Marketing emails, workflows, or payment data",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "slack",
    label: "Slack",
    category: "Chat",
    keywords: ["chat", "messages", "channels", "dm"],
    consoleUrl: "https://api.slack.com/apps",
    help: "Create a Slack app, add the channels/users read scopes under 'OAuth & Permissions', and register the redirect URI below.",
    secretRequired: true,
    reads: [
      "Messages and member names in channels you add the app to (read-only)",
    ],
    neverTouches: [
      "Channels the app hasn't been added to",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "email",
    label: "Email (Gmail)",
    category: "Mail",
    keywords: ["gmail", "google", "inbox", "mail"],
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Gmail API, and add the redirect URI below.",
    secretRequired: true,
    reads: ["Message headers and bodies in your mailbox (read-only)"],
    neverTouches: [
      "Sending, drafting, or deleting mail",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "github",
    label: "GitHub",
    category: "Code",
    keywords: ["git", "repos", "code", "org"],
    consoleUrl: "https://github.com/settings/developers",
    help: "Register a GitHub OAuth App with the redirect URI below and request repo + read:org scopes, then copy the Client ID and Client Secret.",
    secretRequired: true,
    reads: [
      "Repository code, issues, and the orgs/profile you belong to (read-only)",
    ],
    neverTouches: [
      "Pushing commits, opening PRs, or changing repo settings",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "dropbox",
    label: "Dropbox",
    category: "Storage",
    keywords: ["files", "storage", "cloud"],
    consoleUrl: "https://www.dropbox.com/developers/apps",
    help: "Create a Dropbox app (scoped access) in the App Console, grant the account_info.read / files.metadata.read / files.content.read scopes, add the redirect URI below, then copy the App key and App secret.",
    secretRequired: true,
    reads: [
      "File and folder names, metadata, and contents in your Dropbox (read-only)",
    ],
    neverTouches: [
      "Uploading, moving, or deleting files in your Dropbox",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "box",
    label: "Box",
    category: "Storage",
    keywords: ["files", "storage", "cloud", "content"],
    consoleUrl: "https://app.box.com/developers/console",
    help: "Create a Box 'Custom App' using Standard OAuth 2.0, configure it with read-only application scopes, add the redirect URI below, then copy the Client ID and Client Secret.",
    secretRequired: true,
    reads: [
      "File and folder names, metadata, and contents in your Box account (read-only)",
    ],
    neverTouches: [
      "Uploading, moving, or deleting files in your Box account",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "linear",
    label: "Linear",
    category: "Issues",
    keywords: ["issues", "tickets", "projects", "tasks"],
    consoleUrl: "https://linear.app/settings/api/applications/new",
    help: "Create a Linear OAuth application, request the 'read' scope, add the redirect URI below, then copy the Client ID and Client Secret.",
    secretRequired: true,
    reads: [
      "Issue titles, descriptions, comments, and project metadata (read-only)",
    ],
    neverTouches: [
      "Creating, editing, or closing issues",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "miro",
    label: "Miro",
    category: "Design",
    keywords: ["boards", "whiteboard", "diagrams"],
    consoleUrl: "https://miro.com/app/settings/user-profile/apps",
    help: "Create a Miro app, request the boards:read scope, add the redirect URI below, then copy the Client ID and Client Secret.",
    secretRequired: true,
    reads: [
      "Board names, metadata, and contents you can access (read-only)",
    ],
    neverTouches: [
      "Creating, editing, or deleting boards",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "asana",
    label: "Asana",
    category: "Issues",
    keywords: ["tasks", "projects", "work management"],
    consoleUrl: "https://app.asana.com/0/my-apps",
    help: "Create an Asana OAuth app, request the read-only projects:read and tasks:read scopes, add the redirect URI below, then copy the Client ID and Client Secret. Enter the Project ID of the project to index.",
    secretRequired: true,
    reads: [
      "Task names, notes, assignees, and completion state in the configured project (read-only)",
      "The project's section and metadata",
    ],
    neverTouches: [
      "Creating, editing, completing, or deleting tasks",
      "Any project other than the one you configure",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "gitlab",
    label: "GitLab",
    category: "Code",
    keywords: ["git", "repos", "issues", "merge requests", "self-hosted"],
    consoleUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
    help: "Create a personal access token with the read-only read_api scope (works for gitlab.com and self-managed instances). Paste the token and the Project ID (or path); set the base URL only for self-managed GitLab.",
    secretRequired: false,
    reads: [
      "Issue titles, descriptions, and notes in the configured project (read-only)",
      "Project metadata",
    ],
    neverTouches: [
      "Creating, editing, or closing issues or merge requests",
      "Pushing code or changing repository settings",
      "Any project other than the one you configure",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "teams",
    label: "Microsoft Teams",
    category: "Chat",
    keywords: ["microsoft", "teams", "channels", "messages"],
    consoleUrl: "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    help: "Register an Entra (Azure AD) app, grant the read-only ChannelMessage.Read.All scope, add the redirect URI below, then copy the Application (client) ID and a client secret. Enter the Team ID and Channel ID to index.",
    secretRequired: true,
    reads: [
      "Messages and replies in the configured Teams channel (read-only)",
      "Author display names and timestamps",
    ],
    neverTouches: [
      "Posting, editing, or deleting messages",
      "Any team or channel other than the one you configure",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "trello",
    label: "Trello",
    category: "Issues",
    keywords: ["boards", "cards", "kanban", "atlassian"],
    consoleUrl: "https://trello.com/app-key",
    help: "Copy your API key, then generate a read-only token from the same page. Paste both along with the Board ID of the board to index.",
    secretRequired: false,
    reads: [
      "Card names, descriptions, and list placement on the configured board (read-only)",
      "Board and list metadata",
    ],
    neverTouches: [
      "Creating, moving, editing, or archiving cards",
      "Any board other than the one you configure",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "zoom",
    label: "Zoom",
    category: "Calendar & Meetings",
    keywords: ["zoom", "recordings", "meetings", "transcripts"],
    consoleUrl: "https://marketplace.zoom.us/develop/create",
    help: "Create a User-managed OAuth app in the Zoom Marketplace, add the redirect URI below, and add the read-only cloud_recording:read:list_user_recordings scope. Tessera indexes your own cloud recordings — no account-admin access is needed.",
    secretRequired: true,
    reads: [
      "Your Zoom cloud recordings: titles, timestamps, and transcripts (read-only)",
      "Meeting metadata for recordings you own",
    ],
    neverTouches: [
      "Starting, scheduling, or ending meetings",
      "Other users' recordings or any account-admin data",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "google_calendar",
    label: "Google Calendar",
    category: "Calendar & Meetings",
    keywords: ["google", "calendar", "events", "schedule", "gcal"],
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Google Calendar API, and add the redirect URI below. Tessera reads events from your primary calendar.",
    secretRequired: true,
    reads: [
      "Event titles, descriptions, times, and attendees on your primary calendar (read-only)",
    ],
    neverTouches: [
      "Creating, editing, moving, or deleting events",
      "Sending invitations or responding on your behalf",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "google_docs",
    label: "Google Docs",
    category: "Docs & Wiki",
    keywords: ["google", "docs", "documents", "drive"],
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Google Drive and Google Docs APIs, and add the redirect URI below. Tessera discovers and reads the Google Docs in your Drive.",
    secretRequired: true,
    reads: [
      "Titles and text contents of Google Docs in your Drive (read-only)",
      "Document metadata (owner, last-modified time)",
    ],
    neverTouches: [
      "Creating, editing, or deleting documents",
      "Non-Docs files in your Drive",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "google_sheets",
    label: "Google Sheets",
    category: "Docs & Wiki",
    keywords: ["google", "sheets", "spreadsheets", "drive"],
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Google Drive and Google Sheets APIs, and add the redirect URI below. Tessera discovers and reads the spreadsheets in your Drive.",
    secretRequired: true,
    reads: [
      "Titles and cell values of Google Sheets in your Drive (read-only)",
      "Spreadsheet metadata (owner, last-modified time)",
    ],
    neverTouches: [
      "Creating, editing, or deleting spreadsheets",
      "Non-Sheets files in your Drive",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "google_meet",
    label: "Google Meet",
    category: "Calendar & Meetings",
    keywords: ["google", "meet", "recordings", "transcripts", "conferences"],
    consoleUrl: "https://console.cloud.google.com/apis/credentials",
    help: "Create an OAuth 2.0 Client ID of type 'Desktop app' in Google Cloud Console, enable the Google Meet API, and add the redirect URI below. Tessera reads your conference records and their transcripts.",
    secretRequired: true,
    reads: [
      "Conference records you participated in: timestamps and metadata (read-only)",
      "Meeting transcripts where available",
    ],
    neverTouches: [
      "Starting, joining, or ending meetings",
      "Recordings or conferences for other users",
      ...READ_ONLY_GUARANTEES,
    ],
  },
  {
    provider: "sharepoint",
    label: "SharePoint",
    category: "Storage",
    keywords: ["microsoft", "sharepoint", "office", "m365", "sites", "documents"],
    consoleUrl:
      "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
    help: "Register an app in Microsoft Entra ID with the redirect URI below and grant the read-only Sites.Read.All + offline_access scopes. Tessera indexes the document library of your tenant's root SharePoint site.",
    secretRequired: true,
    reads: [
      "File and folder names, metadata, and contents in your SharePoint document libraries (read-only)",
    ],
    neverTouches: [
      "Creating, editing, moving, or deleting files",
      "Site settings, permissions, or lists outside document libraries",
      ...READ_ONLY_GUARANTEES,
    ],
  },
];

/**
 * Case-insensitive predicate used by the gallery's search box. The
 * query is split into whitespace-separated tokens and a descriptor
 * matches only when *every* token is a substring of at least one of
 * its fields (label, provider id, category, or any `keywords`). This
 * token-AND behaviour lets a user combine terms across fields — e.g.
 * "google docs" matches Google Drive (token "google" hits the label,
 * "docs" hits a keyword) — instead of requiring the whole phrase to
 * appear verbatim in a single field. An empty (or whitespace-only)
 * query matches everything so clearing the box restores the full list.
 *
 * Exported (and kept pure) so the matching contract can be unit
 * tested directly as data without rendering the component.
 */
export function connectorMatchesQuery(
  descriptor: ConnectorDescriptor,
  query: string,
): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack: string[] = [
    descriptor.label,
    descriptor.provider,
    descriptor.category ?? "",
    ...(descriptor.keywords ?? []),
  ].map((field) => field.toLowerCase());
  return tokens.every((token) =>
    haystack.some((field) => field.includes(token)),
  );
}

export interface ConnectorCategoryGroup {
  category: ConnectorCategory | typeof UNCATEGORIZED_LABEL;
  descriptors: ConnectorDescriptor[];
}

/**
 * Group descriptors into category sections following
 * `CONNECTOR_CATEGORY_ORDER`, preserving each descriptor's original
 * relative order within its bucket. Empty categories are omitted so
 * the gallery never renders a header with nothing under it. Any
 * descriptor without a known category is collected into a trailing
 * `UNCATEGORIZED_LABEL` group so it stays visible.
 *
 * Pure and side-effect-free — safe to call on every render and to
 * unit test directly.
 */
export function groupConnectorsByCategory(
  descriptors: readonly ConnectorDescriptor[],
): ConnectorCategoryGroup[] {
  const buckets = new Map<string, ConnectorDescriptor[]>();
  for (const d of descriptors) {
    const key =
      d.category && CONNECTOR_CATEGORY_ORDER.includes(d.category)
        ? d.category
        : UNCATEGORIZED_LABEL;
    const existing = buckets.get(key);
    if (existing) existing.push(d);
    else buckets.set(key, [d]);
  }

  const groups: ConnectorCategoryGroup[] = [];
  for (const category of CONNECTOR_CATEGORY_ORDER) {
    const items = buckets.get(category);
    if (items && items.length > 0) {
      groups.push({ category, descriptors: items });
    }
  }
  const other = buckets.get(UNCATEGORIZED_LABEL);
  if (other && other.length > 0) {
    groups.push({ category: UNCATEGORIZED_LABEL, descriptors: other });
  }
  return groups;
}
