# Adding a connector

Tessera's **Connectors v2** layer is a thin exposure layer over the
connectors the [`knowledge`](https://github.com/kennguy3n/knowledge)
substrate already implements. The substrate's `connectors` crate ships
140+ production SaaS connectors (each with real `initial_sync`,
`incremental_sync`, and `fetch_content` implementations); Tessera
decides **which** of them to surface, how they authenticate, and how
they appear in the desktop UI.

Because the sync/content logic already exists upstream, exposing a
**standard, whole-account, read-only OAuth2 provider** is a small,
mechanical change — a mapping entry, a cargo feature line, an OAuth
config, and a renderer descriptor. There is no new connector module to
write. A standard provider should take **well under a day** end-to-end.

This document is the authoritative recipe. The 2024 tranche
(Dropbox, Box, Linear, Miro) was added following exactly these steps and
is a good reference diff.

---

## When this recipe applies

This "fast path" covers a provider that is:

- **Already implemented upstream** — it has a `ConnectorKind` variant in
  `connector_framework` and a `*Connector` type exported from the
  `connectors` crate (check
  `crates/connectors/src/lib.rs` in the knowledge repo).
- **OAuth2, authorization-code grant** — the same flow every existing
  connector uses.
- **Read-only** — least-privilege read scopes only (see
  [Security checklist](#security-checklist)).
- **Whole-account** — it syncs everything the granted token can see and
  needs **no per-target configuration** (no board id, project id,
  channel id, etc.) to start a sync.

Providers that need extra per-instance config (e.g. Asana's `project`,
GitLab's `project_id`, Microsoft Teams' `team_id`/`channel_id`) or a
non-OAuth2 credential (e.g. Trello's `api_key`+token) are **not** on the
fast path. They additionally require a sync-config seam in
`buildAuthConfig` (`apps/desktop/electron/ipc/connectors/connectorsV2.ts`)
plus UI to collect those fields. See
[Providers that need extra config](#providers-that-need-extra-config).

---

## The recipe

Throughout, replace `<provider>` with the stable provider id (snake_case,
**must** equal `ConnectorKind::as_str()` so all layers agree on naming),
and `<Provider>` with the upstream connector type.

### 1. Rust — provider id, mapping, factory, label

All four edits are in
`crates/tessera_bridge/src/connectors_v2.rs`.

1. **Stable id constant** in the `provider_ids` module:

   ```rust
   /// <Provider>.
   pub const PROVIDER: &str = "<provider>";
   ```

2. **`provider_to_kind`** — add a feature-gated arm:

   ```rust
   #[cfg(feature = "connector-<provider>")]
   provider_ids::PROVIDER => Some(ConnectorKind::<Provider>),
   ```

3. **`enabled_providers`** — add `provider_ids::PROVIDER` to the list so
   the provider is listed to the host/UI.

4. **`build_connector`** — add a feature-gated arm that constructs the
   upstream connector (this is the end-to-end wiring; there is no stub):

   ```rust
   #[cfg(feature = "connector-<provider>")]
   ConnectorKind::<Provider> => Some(Box::new(connectors::<Provider>Connector::new(
       instance, transport, oauth,
   ))),
   ```

5. **`display_name`** — add the human label:

   ```rust
   ConnectorKind::<Provider> => "<Provider>",
   ```

Then extend the unit tests in the same file: add the id to
`STABLE_PROVIDER_IDS` (the count assertions derive from it) and, if
useful, a `display_name`/`is_supported` assertion. The
`factory_builds_every_stable_connector` test already iterates
`enabled_providers()`, so it asserts your new arm builds a real
connector automatically.

### 2. Rust — cargo feature

In `crates/tessera_bridge/Cargo.toml`:

- Add `"connector-<provider>"` to the `connectors-v2-stable` bundle.
- Add the feature definition:

  ```toml
  connector-<provider> = ["connectors-v2"]
  ```

The upstream `connectors` crate compiles every vendor impl regardless
(it has no per-connector features), so this gate controls the *exposed*
surface, not codegen.

### 3. TypeScript — allowlist

In `apps/desktop/electron/ipc/validate.ts`, add `"<provider>"` to the
`KNOWN_PROVIDERS` tuple. `ProviderId` is derived from this tuple, so
this single edit makes every exhaustiveness check (the `runSync` /
`runDisconnect` switches, the `PROVIDER_OAUTH_CONFIGS` record) require a
matching entry — a compile error until you finish the steps below.

### 4. TypeScript — OAuth config

In `apps/desktop/electron/ipc/connectors/providerOAuth.ts`, add a
`PROVIDER_OAUTH_CONFIGS["<provider>"]` entry. Required fields:

| field | notes |
| --- | --- |
| `authUrl`, `tokenUrl` | provider's documented OAuth endpoints (constants, never runtime config) |
| `scope` | **least-privilege read-only** scopes — see [Security checklist](#security-checklist) |
| `redirectPort` | next free loopback port (the existing set runs 9876–988x; pick the next integer and keep it unique) |
| `supportsRefresh` | `true` only if the flow issues a refresh token; otherwise the UI surfaces a "reconnect" prompt on expiry |
| `usePkce` | `true` for public/desktop clients that support PKCE |
| `extraAuthorizeParams` | e.g. Dropbox needs `token_access_type: "offline"` to get a refresh token |

The `getRedirectUriMap` IPC is the single source of truth for the
redirect URI shown in the connect modal — do **not** hardcode it in the
renderer.

### 5. TypeScript — renderer descriptor

In `apps/desktop/renderer/src/components/connectorDescriptors.ts`, append
a `ConnectorDescriptor`:

```ts
{
  provider: "<provider>",
  label: "<Provider>",
  category: "Storage", // one of ConnectorCategory
  keywords: ["…"],     // search aliases
  consoleUrl: "https://…", // where the user creates the OAuth app
  help: "How to create the OAuth app + which scopes to grant.",
  secretRequired: true,
  reads: ["Plain-language summary of what Tessera reads (read-only)"],
  neverTouches: [
    "Provider-specific write/delete actions we never do",
    ...READ_ONLY_GUARANTEES,
  ],
},
```

`reads` / `neverTouches` are user-facing scope-transparency copy derived
from the OAuth scopes in step 4 — keep them accurate, since users read
them on the connect screen. The gallery groups by `category` and the
search box matches `label` / `provider` / `category` / `keywords`, so no
further UI wiring is needed.

### 6. Sync / disconnect routing

Substrate-only providers (everything outside `LEGACY_PROVIDERS` in
`apps/desktop/electron/ipc/connectors/handlers.ts`) are routed to the v2
bridge automatically — connect, sync, and evidence ingestion all flow
through `runProviderV2Sync` / `disconnectV2Provider` with no
per-provider code. Add your `case "<provider>":` to the substrate-only
groups in the `runSync` and `runDisconnect` switches (they share the
generic v2 handling) so the exhaustiveness checks stay honest.

### 7. Tests

- **Rust:** covered by the `connectors_v2.rs` unit tests you extended in
  step 1 (`enabled_providers_covers_stable_set`,
  `factory_builds_every_stable_connector`,
  `provider_kind_roundtrips_through_as_str`).
- **TypeScript:** `providerOAuth.test.ts` iterates `KNOWN_PROVIDERS` and
  asserts a unique-port OAuth config for each; add scope assertions for
  your provider there. `validate.test.ts` checks the allowlist, and
  `connectorsList.test.tsx` iterates `CONNECTOR_DESCRIPTORS`, so the UI
  row + transparency disclosure are covered automatically.

---

## Validate locally

```bash
# Rust (toolchain pinned at 1.88)
cargo +1.88 fmt --check
cargo +1.88 clippy --all-targets -- -D warnings
cargo +1.88 test -p tessera_bridge

# Desktop
cd apps/desktop
npm run lint
npm run type-check
npm run test
npm run build
```

---

## Security checklist

Tessera is multi-tenant (thousands of SME tenants). Every connector must
uphold the read-only, least-privilege contract:

- [ ] **Read-only scopes only.** No write/manage/delete/admin scopes. If
      the provider has a dedicated read-only scope (e.g. Box's
      `root_readonly`), use it.
- [ ] **Minimal surface.** Request only the scopes the connector
      actually ingests — do not request mail if you only read files.
- [ ] **Accurate transparency copy.** `reads` / `neverTouches` in the
      descriptor must match the scopes you requested. Users rely on this
      to consent.
- [ ] **Refresh honestly.** Set `supportsRefresh` to match what the flow
      actually returns; request offline access explicitly when the
      provider gates refresh tokens behind a parameter.
- [ ] **Unique loopback port.** Reusing a port breaks concurrent auth
      flows; the `providerOAuth` test enforces uniqueness.

---

## Providers that need extra config

Some upstream connectors require per-instance configuration to scope a
sync (they are *not* whole-account), and some authenticate with a pasted
long-lived credential rather than a browser OAuth2 grant. The 2025
tranche (**Asana, GitLab, Microsoft Teams, Trello**) was added following
this path and is the reference diff. The required inputs (confirmed
against the upstream `connectors` crate's `auth_config_json` reads) are:

| Provider | Connect method | Inputs (`auth_config_json` key) |
| --- | --- | --- |
| Asana | `oauth2` | `project` (gid); optional `api_base_url` |
| Microsoft Teams | `oauth2` | `team_id`, `channel_id` |
| GitLab | `token` | `personal_access_token` (→ bearer), `project_id`; optional `api_base_url` |
| Trello | `token` | `key`, `token` (→ bearer), `board_id` |

The 2026 tranche (**Discord, Bitbucket, Airtable, Monday.com**) extends
the same seam with the next batch of per-target / per-resource
connectors:

| Provider | Connect method | Inputs (`auth_config_json` key) |
| --- | --- | --- |
| Discord | `token` | `bot_token` (→ bearer, `Bot` scheme), `channel_id`; optional `api_base_url` |
| Bitbucket | `token` | `access_token` (→ bearer), `workspace`, `repo_slug`; optional `api_base_url` |
| Airtable | `token` | `personal_access_token` (→ bearer), `base_id`, `table`; optional `api_base_url` |
| Monday.com | `oauth2` | `board_id` |

Discord is the one provider whose stored credential is **not** sent with
the default `Bearer` scheme: a bot token must travel as `Authorization:
Bot <token>`. The scheme is single-sourced on the connect spec
(`ConnectorConnectSpec.tokenType`, defaulting to `"Bearer"`) and threaded
onto the wire token in `connectorsV2.ts > storedToWire`.

The 2026 support / CRM tranche (**ClickUp, Intercom, Salesforce**)
surfaces three more upstream `connectors`-crate impls. All three use the
**read-only OAuth2 browser grant** (loopback ports 9904–9906):

| Provider | Connect method | Inputs (`auth_config_json` key) | Scope | Port |
| --- | --- | --- | --- | --- |
| ClickUp | `oauth2` | `team_id` (Workspace ID); optional `api_base_url` | *(scope-less — workspace-bound)* | 9904 |
| Intercom | `oauth2` | optional `api_base_url` (EU/AU host) | *(scope-less — app-configured)* | 9905 |
| Salesforce | `oauth2` | `api_base_url` (My Domain instance URL, **required**) | `api refresh_token` | 9906 |

Notes on this tranche:

- **ClickUp** reads tasks from one workspace (`/api/v2/team/{team_id}/task`),
  so the connect modal collects the numeric Workspace (Team) ID. ClickUp's
  OAuth flow takes **no `scope` parameter** — access is governed by the
  authorizing user's own workspace permissions — so it is added to
  `SCOPELESS_PROVIDERS` and issues no refresh token (reconnect-on-expiry).
- **Intercom** syncs the whole workspace's conversations
  (`/conversations/search`); no per-target id is needed. Two quirks are
  single-sourced in the OAuth config: it is **scope-less** (data access is
  configured on the app in Intercom's Developer Hub), and its
  `/auth/eagle/token` endpoint returns the access token in a non-standard
  **`token`** field — declared via `ProviderOAuthConfig.accessTokenField`
  (the exchange reads it first, then falls back to `access_token`).
- **Salesforce** reads support **Cases** via SOQL over the REST API
  (`/services/data/vXX.X/query`). Orgs are per-instance, so the **My
  Domain instance URL is required**. It requests only `api` (REST read;
  the connector issues `SELECT`/`GET` against Cases) plus Salesforce's
  `refresh_token` protocol scope, which is treated as an OAuth **meta-scope**
  (`OAUTH_META_SCOPES`, alongside `offline_access`) so it is requested but
  not validated as an API permission. Salesforce supports PKCE and issues a
  refresh token.

The 2026 per-instance tranche (**Zendesk, ServiceNow**) surfaces two
more upstream `connectors`-crate impls whose OAuth authorize/token
endpoints are **not fixed constants** — they live on the customer's own
instance host (`https://<subdomain>.zendesk.com/oauth/...`,
`https://<instance>.service-now.com/oauth_*.do`). They are wired on the
**per-instance OAuth URL seam** described below (loopback ports
9907–9908):

| Provider | Connect method | Inputs (`auth_config_json` key) | Scope | Port |
| --- | --- | --- | --- | --- |
| Zendesk | `oauth2` | `subdomain` (single DNS label, e.g. `acme`) | `read` | 9907 |
| ServiceNow | `oauth2` | `subdomain` (instance id, e.g. `dev12345`) | *(scope-less — role-based ACLs)* | 9908 |

Notes on this tranche:

- **Zendesk** reads Support **tickets** via the read-only Support API.
  The connect modal collects only the **subdomain** (never a full URL);
  the seam derives `https://<subdomain>.zendesk.com/oauth/authorizations/new`
  (authorize) and `/oauth/tokens` (token), and pins the connector's
  `api_base_url` to the same origin. It requests Zendesk's global
  read-only **`read`** scope. Zendesk OAuth access tokens do not expire
  and the grant issues no refresh token, so it is reconnect-on-expiry.
- **ServiceNow** reads **incidents** via the Table API
  (`/api/now/table/incident`). It is **scope-less** — a ServiceNow OAuth
  token inherits the authenticating user's role-based ACLs, so
  least-privilege is enforced by connecting a read-only account (it is
  added to `SCOPELESS_PROVIDERS`). The seam derives `oauth_auth.do`
  (authorize), `oauth_token.do` (token) and `oauth_revoke_token.do`
  (revoke on disconnect) on the per-instance host. ServiceNow issues
  refresh tokens, and the persisted `subdomain` lets refresh re-derive
  the token URL after an app restart.

**Audited but skipped — Freshdesk.** Freshdesk *is* implemented upstream
and is per-domain (`https://<domain>.freshdesk.com`), but unlike Zendesk
/ServiceNow it has **no verified, stable per-subdomain OAuth
authorize/token URL pair** (its app auth goes through the Freshworks
marketplace OAuth flow / API-key auth, not a simple
`https://<domain>.freshdesk.com/oauth/...` endpoint shape). Rather than
guess a wrong fixed endpoint, Freshdesk stays deferred until its real
OAuth endpoint shape is confirmed — at which point the seam below makes
wiring it a config-only change.

This tranche brings `STABLE_PROVIDER_IDS` to **33** providers.

### The per-instance OAuth URL seam

Most providers declare **fixed** `authUrl`/`tokenUrl` compile-time
constants on `ProviderOAuthConfig`. A per-instance provider instead
declares an `instanceUrls` template and leaves `authUrl`/`tokenUrl`
**undefined** (the two are mutually exclusive — enforced at module load
by `assertOAuthConfigInvariant`, and asserted unchanged for every fixed
provider by the backward-compat tests):

```ts
zendesk: {
  provider: "zendesk",
  instanceUrls: {
    instanceField: "subdomain",          // connect-time field that supplies the instance value
    baseDomain: "zendesk.com",            // host is pinned to EXACTLY <label>.<baseDomain>
    authorizePath: "/oauth/authorizations/new",
    tokenPath: "/oauth/tokens",
    apiBaseUrlField: "api_base_url",      // derived origin injected here for the connector
    // revokePath?: ...                    // optional (ServiceNow declares oauth_revoke_token.do)
  },
  scope: "read",
  redirectPort: 9907,
  supportsRefresh: false,
  usePkce: false,
},
```

`resolveProviderOAuthConfig(provider, connectorConfig)` turns a raw
config into a `ResolvedProviderOAuthConfig` with **concrete** string
URLs, reading the instance value from the persisted `connectorConfig`.
Fixed-URL providers pass through unchanged. The whole OAuth flow —
`buildAuthorizeUrl`, `exchangeAuthorizationCode`, `refreshProviderToken`,
and disconnect-time revoke — runs on the **resolved** config; passing a
raw (template-only) config to the flow throws (`requireResolvedUrl`), so
an unresolved URL can never silently become `undefined`.

**SSRF / open-redirect safety.** The instance value is validated by
`deriveInstanceUrls` with defence-in-depth:

1. It must match a single RFC-1035 DNS label
   (`[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?`, case-insensitive, trimmed +
   lowercased) — so a value containing a dot, slash, `@`, `:`, scheme,
   whitespace or any other authority/path/query/fragment character is
   rejected before any URL is built.
2. The host is constructed as **exactly** `<label>.<baseDomain>` — the
   user value can only ever be the left-most label; it can never drop or
   replace the pinned `baseDomain` suffix.
3. Each derived URL is **re-parsed** and its `host` re-checked against
   the pinned host, so even a malformed template path cannot smuggle a
   foreign authority through.

The same DNS-label pattern is mirrored on the connect-time field
(`CONNECTOR_CONNECT_SPECS`) so the user sees an **anchored inline error**
in the connect modal before the flow starts. Failures inside the OAuth
flow throw `InstanceUrlError` (stamped with the provider id). Wiring the
next self-hosted / per-subdomain provider is therefore a config-only
change: declare its `instanceUrls` template + a `subdomain` connect
field, with no flow code to touch.

The seam is the single source of truth in
`apps/desktop/shared/connectorConfig.ts` — a dependency-free module
imported by **both** the Electron main process and the renderer:

1. **Declare the connect spec** in `CONNECTOR_CONNECT_SPECS`: the
   `connectMethod` (`"oauth2"` for a browser grant that *also* needs
   target ids, `"token"` for a pasted credential), the ordered
   `configFields` (each `key` **must** equal the exact `auth_config_json`
   field name the upstream connector reads — e.g. `.get("project")`,
   `required_field(config, "team_id")`), and for `"token"` providers the
   `tokenField` whose value becomes the connector's bearer token.
2. **Injection is automatic.** `buildAuthConfig`
   (`connectorsV2.ts`) calls `authConfigFields(provider)` to inject every
   declared field *except* the `tokenField` (which travels as
   `TokenWire.access_token`) into the `auth_config_json` bag. Empty
   optional values are skipped so the connector's own "field is required"
   error surfaces clearly.
3. **Validation is automatic.** The `connectors:authenticate` handler
   calls `assertConnectorConfig`, which rejects unknown keys, enforces
   `required` fields, and length-caps every value. `"token"` providers
   route through `authenticateWithToken` (no browser flow); the
   credential is stored as the access token with a long, non-expiring
   lifetime and `supportsRefresh: false`.
4. **UI is automatic.** `ConnectorsList.tsx` renders the `configFields`
   from the spec (password inputs for `secret` fields) and hides the
   OAuth client id/secret inputs for `"token"` providers.

So the additional work beyond the fast-path steps 1–7 is: add the
`connectorConfig.ts` spec entry, set the OAuth config's `supportsRefresh`
/ `usePkce` honestly, and write accurate descriptor `help` + `reads` /
`neverTouches` copy. Everything downstream (injection, validation, UI,
tests that iterate `KNOWN_PROVIDERS` / `CONNECTOR_DESCRIPTORS`) follows
from the single source of truth.
