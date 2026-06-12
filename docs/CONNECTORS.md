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
sync (they are *not* whole-account). Examples confirmed in the upstream
`connectors` crate:

| Provider | Required config |
| --- | --- |
| Asana | `project` (gid) |
| GitLab | `project_id` |
| Microsoft Teams | `team_id`, `channel_id` |
| BitBucket | `workspace`, `repo_slug` |
| Trello | `api_key` + user token (non-OAuth2) |

To add one of these, follow steps 1–7 above **and** additionally:

1. Extend `buildAuthConfig`
   (`apps/desktop/electron/ipc/connectors/connectorsV2.ts`) to inject the
   extra fields into the `auth_config_json` bag the upstream connector
   reads (the connector validates the bag and errors clearly if a field
   is missing).
2. Add UI to collect those fields during onboarding and persist them
   alongside the provider's tokens.
3. Document the required fields in the descriptor `help` text.

These are deliberately out of the "under a day" fast path because they
touch the onboarding UI and the auth-config seam, not just data tables.
