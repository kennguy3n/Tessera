//! Connector layer v2 — wraps the knowledge substrate's
//! [`connector_framework`] + [`connectors`] crates behind Tessera's
//! existing Electron IPC contract.
//!
//! # Why this module exists
//!
//! Tessera historically shipped six hand-rolled OAuth connectors
//! implemented entirely in TypeScript (`apps/desktop/electron/ipc/
//! connectors/*.ts`). The knowledge substrate provides a trait-based
//! connector framework with ten production-grade providers that share
//! a single audited OAuth2 / pagination / rate-limit / webhook code
//! path. This module is the Rust bridge that lets the desktop host
//! drive those substrate connectors through the *same* IPC channels
//! (`connectors:authenticate` / `:sync` / `:disconnect` / `:status`),
//! so the migration is invisible to the renderer and the legacy
//! `tessera_connectors` path stays available as a fallback (gated by
//! the host's `useV2Connectors` config flag).
//!
//! # Security & multi-tenancy posture (5000 SME tenants)
//!
//! * **Tokens never persist on the Rust side.** This layer is
//!   deliberately stateless with respect to credential storage: every
//!   entry point receives the current [`OAuth2Token`] as an argument
//!   and returns the (possibly refreshed) token for the host to write
//!   back into its OS-keychain-backed vault
//!   (`apps/desktop/electron/secretsVault.ts`). The keychain remains
//!   the single source of truth, which keeps secrets off the Rust heap
//!   for any longer than a single call and avoids a second copy of
//!   tenant credentials living in process-global Rust state.
//! * **`client_secret` resolution** uses the framework's
//!   [`ClientSecretResolver`] extension point. The host can register a
//!   keychain-backed resolver (see [`set_client_secret_resolver`]); in
//!   its absence the framework reads `auth_config_json.client_secret`
//!   as a documented dev/single-tenant fallback. The resolver value is
//!   consulted per call and never cached here.
//! * **Scope isolation.** Every connector is bound to an
//!   [`evidence_store::ScopeId`]; synced content is handed to the
//!   [`EvidenceSink`] tagged with that scope so the substrate's
//!   per-scope DEK / ACL isolation applies end-to-end.
//!
//! # Note on the keychain token vault adapter
//!
//! The original plan modelled the token vault on knowledge's
//! `JsClientSecretResolver` (a `ThreadsafeFunction`-backed adapter in
//! `crates/napi/`). That crate is built against **napi-rs 3.x**, whose
//! `Function::build_threadsafe_function` API does not exist in the
//! **napi-rs 2.x** that `tessera_bridge` links. Rather than fork the
//! addon onto a different napi major (a large, risky change that would
//! ripple across every existing `bridge_*` export), the token vault is
//! kept on the JS side where `safeStorage` already lives, and the Rust
//! core is made generic over a [`TokenStore`] trait so the
//! pluggable-backend abstraction is real and unit-tested with
//! [`InMemoryTokenStore`]. The FFI surface passes tokens in/out as
//! JSON, so the JS keychain vault *is* the production `TokenStore`
//! implementation, reached through ordinary synchronous return values
//! rather than a re-entrant threadsafe callback.

#![allow(clippy::module_name_repetitions)]

use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock, RwLock};

use base64::Engine as _;
use chrono::{DateTime, Utc};
use connector_framework::{
    ClientSecretResolver, Connector, ConnectorConfig, ConnectorEvent, ConnectorInstanceId,
    ConnectorKind, FetchedContent, OAuth2Client, OAuth2Token, RefreshedToken, SecretToken,
    SourceDocumentId, SyncMode, SyncRunResult, SyncState,
};
use evidence_store::ScopeId;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Stable provider identifier as used by Tessera's IPC layer and the
/// `KNOWN_PROVIDERS` list in `apps/desktop/electron/ipc/validate.ts`.
///
/// These strings are guaranteed to match
/// [`ConnectorKind::as_str`] so the two layers agree on naming.
pub mod provider_ids {
    /// Google Drive.
    pub const GOOGLE_DRIVE: &str = "google_drive";
    /// Microsoft OneDrive / SharePoint.
    pub const ONEDRIVE: &str = "onedrive";
    /// Notion.
    pub const NOTION: &str = "notion";
    /// Atlassian Jira.
    pub const JIRA: &str = "jira";
    /// Atlassian Confluence.
    pub const CONFLUENCE: &str = "confluence";
    /// Figma.
    pub const FIGMA: &str = "figma";
    /// HubSpot CRM.
    pub const HUBSPOT: &str = "hubspot";
    /// Slack.
    pub const SLACK: &str = "slack";
    /// Email (Gmail / Microsoft Graph).
    pub const EMAIL: &str = "email";
    /// GitHub.
    pub const GITHUB: &str = "github";
    /// Dropbox.
    pub const DROPBOX: &str = "dropbox";
    /// Box.
    pub const BOX: &str = "box";
    /// Linear.
    pub const LINEAR: &str = "linear";
    /// Miro.
    pub const MIRO: &str = "miro";
}

/// Errors surfaced by the connector v2 bridge. Kept deliberately small
/// and string-y at the boundary: the rich [`connector_framework`]
/// error taxonomy is flattened to a category + message so the FFI/JSON
/// surface stays stable and host-agnostic.
#[derive(Debug, thiserror::Error)]
pub enum ConnectorV2Error {
    /// The provider id is not one of the stable, feature-enabled set.
    #[error("unknown or disabled connector provider: {0}")]
    UnknownProvider(String),
    /// A field required to build the request was missing/invalid.
    #[error("invalid connector configuration: {0}")]
    InvalidConfig(String),
    /// The underlying connector framework returned an error.
    #[error("{category}: {message}")]
    Connector {
        /// Stable machine-readable category (e.g. `auth`, `transport`).
        category: &'static str,
        /// Human-readable detail.
        message: String,
    },
    /// Failure constructing the production HTTP / OAuth stack.
    #[error("connector transport initialisation failed: {0}")]
    Transport(String),
}

/// Convenience alias.
pub type Result<T> = std::result::Result<T, ConnectorV2Error>;

impl ConnectorV2Error {
    /// Map a [`connector_framework::ConnectorError`] into the flat
    /// boundary representation, preserving a stable category string.
    fn from_framework(err: &connector_framework::ConnectorError) -> Self {
        use connector_framework::ConnectorError as E;
        let category = match err {
            E::Auth(_) => "auth",
            E::Transport(_) => "transport",
            E::TokenRefresh(_) => "token_refresh",
            E::TokenNotFound => "token_not_found",
            E::Sync(_) => "sync",
            E::Webhook(_) => "webhook",
            E::PermissionDenied => "permission_denied",
            E::Unimplemented(_) => "unimplemented",
            E::Json(_) => "parse",
            _ => "connector",
        };
        Self::Connector {
            category,
            message: err.to_string(),
        }
    }
}

// ───────────────────────── provider ↔ kind mapping ─────────────────────────

/// Map a Tessera provider id to a [`ConnectorKind`], honouring the
/// per-provider cargo features so a build that excludes a provider
/// also refuses to resolve it.
#[must_use]
pub fn provider_to_kind(provider: &str) -> Option<ConnectorKind> {
    match provider {
        #[cfg(feature = "connector-google-drive")]
        provider_ids::GOOGLE_DRIVE => Some(ConnectorKind::GoogleDrive),
        #[cfg(feature = "connector-onedrive")]
        provider_ids::ONEDRIVE => Some(ConnectorKind::OneDrive),
        #[cfg(feature = "connector-notion")]
        provider_ids::NOTION => Some(ConnectorKind::Notion),
        #[cfg(feature = "connector-jira")]
        provider_ids::JIRA => Some(ConnectorKind::Jira),
        #[cfg(feature = "connector-confluence")]
        provider_ids::CONFLUENCE => Some(ConnectorKind::Confluence),
        #[cfg(feature = "connector-figma")]
        provider_ids::FIGMA => Some(ConnectorKind::Figma),
        #[cfg(feature = "connector-hubspot")]
        provider_ids::HUBSPOT => Some(ConnectorKind::HubSpot),
        #[cfg(feature = "connector-slack")]
        provider_ids::SLACK => Some(ConnectorKind::Slack),
        #[cfg(feature = "connector-email")]
        provider_ids::EMAIL => Some(ConnectorKind::Email),
        #[cfg(feature = "connector-github")]
        provider_ids::GITHUB => Some(ConnectorKind::GitHub),
        #[cfg(feature = "connector-dropbox")]
        provider_ids::DROPBOX => Some(ConnectorKind::Dropbox),
        #[cfg(feature = "connector-box")]
        provider_ids::BOX => Some(ConnectorKind::Box),
        #[cfg(feature = "connector-linear")]
        provider_ids::LINEAR => Some(ConnectorKind::Linear),
        #[cfg(feature = "connector-miro")]
        provider_ids::MIRO => Some(ConnectorKind::Miro),
        _ => None,
    }
}

/// The set of providers compiled into this build, in stable display
/// order. Used by the host to render connector cards and by tests to
/// assert the full stable surface is present.
#[must_use]
pub fn enabled_providers() -> Vec<ConnectorKind> {
    [
        provider_ids::GOOGLE_DRIVE,
        provider_ids::ONEDRIVE,
        provider_ids::NOTION,
        provider_ids::JIRA,
        provider_ids::CONFLUENCE,
        provider_ids::FIGMA,
        provider_ids::HUBSPOT,
        provider_ids::SLACK,
        provider_ids::EMAIL,
        provider_ids::GITHUB,
        provider_ids::DROPBOX,
        provider_ids::BOX,
        provider_ids::LINEAR,
        provider_ids::MIRO,
    ]
    .into_iter()
    .filter_map(provider_to_kind)
    .collect()
}

// ───────────────────────────── token store ─────────────────────────────────

/// Pluggable persistence backend for [`OAuth2Token`]s.
///
/// The knowledge framework's [`connector_framework::OAuth2TokenVault`]
/// is an in-memory `HashMap` with no pluggable backend; this trait is
/// the seam Tessera needs so the production path can delegate to the
/// OS keychain while tests use an in-memory map. Implementations MUST
/// be cheap to clone-share (`Arc`) and safe to call from any thread.
pub trait TokenStore: Send + Sync {
    /// Load the token for `instance`, if present.
    fn load(&self, instance: &ConnectorInstanceId) -> Option<OAuth2Token>;
    /// Persist (insert or replace) the token for `instance`.
    fn store(&self, instance: &ConnectorInstanceId, token: OAuth2Token);
    /// Remove the token for `instance`. Idempotent.
    fn remove(&self, instance: &ConnectorInstanceId);
}

/// In-memory [`TokenStore`] used by tests and as a default backend.
///
/// Production hosts persist tokens in the OS keychain on the JS side;
/// this implementation exists so the Rust orchestration core is
/// exercisable end-to-end without an FFI round-trip.
#[derive(Debug, Default)]
pub struct InMemoryTokenStore {
    inner: Mutex<BTreeMap<Uuid, OAuth2Token>>,
}

impl InMemoryTokenStore {
    /// Construct an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }
}

impl TokenStore for InMemoryTokenStore {
    fn load(&self, instance: &ConnectorInstanceId) -> Option<OAuth2Token> {
        self.inner
            .lock()
            .expect("token store mutex poisoned")
            .get(&instance.as_uuid())
            .map(clone_token)
    }

    fn store(&self, instance: &ConnectorInstanceId, token: OAuth2Token) {
        self.inner
            .lock()
            .expect("token store mutex poisoned")
            .insert(instance.as_uuid(), token);
    }

    fn remove(&self, instance: &ConnectorInstanceId) {
        self.inner
            .lock()
            .expect("token store mutex poisoned")
            .remove(&instance.as_uuid());
    }
}

/// Clone an [`OAuth2Token`] (its `SecretToken` fields do not derive
/// `Clone` to discourage accidental secret duplication, so we rebuild
/// it explicitly through the public API).
fn clone_token(token: &OAuth2Token) -> OAuth2Token {
    OAuth2Token {
        access_token: SecretToken::new(token.access_token.expose()),
        refresh_token: token
            .refresh_token
            .as_ref()
            .map(|s| SecretToken::new(s.expose())),
        expires_at: token.expires_at,
        scope: token.scope.clone(),
        token_type: token.token_type.clone(),
    }
}

// ─────────────────────────── client-secret resolver ────────────────────────

/// Process-global client-secret resolver registry.
///
/// Registered once by the host (via [`set_client_secret_resolver`])
/// and consulted by [`OAuth2Client`] during the authorization-code and
/// refresh grants. Kept behind an `RwLock<Option<…>>` so registration
/// is a rare write and per-call reads are cheap and concurrent.
static CLIENT_SECRET_RESOLVER: OnceLock<RwLock<Option<Arc<dyn ClientSecretResolver>>>> =
    OnceLock::new();

fn resolver_slot() -> &'static RwLock<Option<Arc<dyn ClientSecretResolver>>> {
    CLIENT_SECRET_RESOLVER.get_or_init(|| RwLock::new(None))
}

/// Register a host-provided [`ClientSecretResolver`]. Replaces any
/// previously-registered resolver. Passing the keychain-backed
/// resolver here keeps OAuth `client_secret` values out of
/// `auth_config_json` (and therefore off disk) for production tenants.
pub fn set_client_secret_resolver(resolver: Arc<dyn ClientSecretResolver>) {
    *resolver_slot().write().expect("resolver lock poisoned") = Some(resolver);
}

/// Clear any registered client-secret resolver (falls back to the
/// `auth_config_json.client_secret` dev path).
pub fn clear_client_secret_resolver() {
    *resolver_slot().write().expect("resolver lock poisoned") = None;
}

fn current_resolver() -> Option<Arc<dyn ClientSecretResolver>> {
    resolver_slot()
        .read()
        .expect("resolver lock poisoned")
        .clone()
}

// ───────────────────────────── evidence sink ───────────────────────────────

/// Sink for content fetched during a sync.
///
/// This is the clean interface to the substrate's evidence pipeline
/// (evidence ingest → observation extract → memory manager). Session
/// 1's `tessera_substrate` is expected to provide the production
/// implementation that opens the per-scope [`evidence_store`] and runs
/// the observation/memory stages; until it lands, the host can run
/// with the [`NoopEvidenceSink`] (content still flows back to the host
/// over the FFI return value for the existing search-index path), so
/// the connector migration does not block on Session 1.
pub trait EvidenceSink: Send + Sync {
    /// Ingest one fetched document, tagged with the connector's scope.
    ///
    /// # Errors
    ///
    /// Returns a human-readable error string if ingestion fails. The
    /// orchestrator treats sink errors as non-fatal per-document so a
    /// single bad document does not abort an entire sync run.
    fn ingest(
        &self,
        scope: &ScopeId,
        document_id: &SourceDocumentId,
        content: &FetchedContent,
    ) -> std::result::Result<(), String>;
}

/// No-op sink: content is not forwarded into the evidence pipeline.
/// Used until Session 1's substrate ingest is wired in.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopEvidenceSink;

impl EvidenceSink for NoopEvidenceSink {
    fn ingest(
        &self,
        _scope: &ScopeId,
        _document_id: &SourceDocumentId,
        _content: &FetchedContent,
    ) -> std::result::Result<(), String> {
        Ok(())
    }
}

// ─────────────────────────── connector factory ─────────────────────────────

/// Build a boxed [`Connector`] for `kind`, injecting the HTTP
/// transport and OAuth code-exchange dependencies.
///
/// Each arm is gated on the corresponding per-provider cargo feature
/// so the exposed connector set tracks the build configuration. Every
/// stable provider in this build maps to a concrete `connectors::*`
/// implementation — there are no stubs.
#[must_use]
pub fn build_connector(
    kind: ConnectorKind,
    instance: ConnectorInstanceId,
    transport: Arc<dyn connector_framework::HttpTransport>,
    oauth: Arc<dyn connector_framework::OAuth2CodeExchange>,
) -> Option<Box<dyn Connector>> {
    match kind {
        #[cfg(feature = "connector-google-drive")]
        ConnectorKind::GoogleDrive => Some(Box::new(connectors::GoogleDriveConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-onedrive")]
        ConnectorKind::OneDrive => Some(Box::new(connectors::OneDriveConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-notion")]
        ConnectorKind::Notion => Some(Box::new(connectors::NotionConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-jira")]
        ConnectorKind::Jira => Some(Box::new(connectors::JiraConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-confluence")]
        ConnectorKind::Confluence => Some(Box::new(connectors::ConfluenceConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-figma")]
        ConnectorKind::Figma => Some(Box::new(connectors::FigmaConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-hubspot")]
        ConnectorKind::HubSpot => Some(Box::new(connectors::HubSpotConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-slack")]
        ConnectorKind::Slack => Some(Box::new(connectors::SlackConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-email")]
        ConnectorKind::Email => Some(Box::new(connectors::EmailConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-github")]
        ConnectorKind::GitHub => Some(Box::new(connectors::GitHubConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-dropbox")]
        ConnectorKind::Dropbox => Some(Box::new(connectors::DropboxConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-box")]
        ConnectorKind::Box => Some(Box::new(connectors::BoxConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-linear")]
        ConnectorKind::Linear => Some(Box::new(connectors::LinearConnector::new(
            instance, transport, oauth,
        ))),
        #[cfg(feature = "connector-miro")]
        ConnectorKind::Miro => Some(Box::new(connectors::MiroConnector::new(
            instance, transport, oauth,
        ))),
        #[allow(unreachable_patterns)]
        _ => None,
    }
}

/// Build the production HTTP transport + OAuth2 client stack, applying
/// the registered [`ClientSecretResolver`] if present.
///
/// The reqwest-backed [`connector_framework::BlockingHttpTransport`]
/// is shared between the connector's content/sync calls and the OAuth
/// client so the connection pool is reused across both.
///
/// # Errors
///
/// Returns [`ConnectorV2Error::Transport`] if the reqwest client
/// cannot be constructed (e.g. TLS backend init failure).
fn production_stack() -> Result<(
    Arc<dyn connector_framework::HttpTransport>,
    Arc<dyn connector_framework::OAuth2CodeExchange>,
)> {
    let transport = Arc::new(
        connector_framework::BlockingHttpTransport::new()
            .map_err(|e| ConnectorV2Error::Transport(e.to_string()))?,
    );
    let client = OAuth2Client::new(transport.clone());
    if let Some(resolver) = current_resolver() {
        client.set_resolver(resolver);
    }
    let transport_dyn: Arc<dyn connector_framework::HttpTransport> = transport;
    let oauth_dyn: Arc<dyn connector_framework::OAuth2CodeExchange> = Arc::new(client);
    Ok((transport_dyn, oauth_dyn))
}

/// Resolve a provider id + auth-config bag + optional scope into the
/// concrete connector instance and its [`ConnectorConfig`].
///
/// The returned [`ConnectorInstanceId`] is deterministic in the scope
/// so repeated calls for the same `(provider, scope)` address the same
/// logical instance (important for token-store keying and webhook
/// subscription identity).
///
/// # Errors
///
/// * [`ConnectorV2Error::UnknownProvider`] if the provider is not a
///   feature-enabled stable connector.
/// * [`ConnectorV2Error::Transport`] if the production HTTP stack fails
///   to initialise.
fn resolve_connector(
    provider: &str,
    auth_config: serde_json::Value,
    scope: ScopeId,
) -> Result<(Box<dyn Connector>, ConnectorConfig, ConnectorInstanceId)> {
    let kind = provider_to_kind(provider)
        .ok_or_else(|| ConnectorV2Error::UnknownProvider(provider.into()))?;
    let instance = instance_id_for(kind, scope);
    let (transport, oauth) = production_stack()?;
    let connector = build_connector(kind, instance, transport, oauth)
        .ok_or_else(|| ConnectorV2Error::UnknownProvider(provider.into()))?;
    let config =
        ConnectorConfig::new(kind, default_auth_kind(kind), scope).with_auth_config(auth_config);
    Ok((connector, config, instance))
}

/// Deterministically derive a [`ConnectorInstanceId`] from a provider
/// kind and scope using a UUIDv5 over the scope and provider name.
///
/// This keeps the instance id stable across host restarts without the
/// host having to persist it separately — the `(scope, provider)` pair
/// is the natural key for a single-tenant desktop connector.
#[must_use]
fn instance_id_for(kind: ConnectorKind, scope: ScopeId) -> ConnectorInstanceId {
    // Namespace UUID (random, fixed) for connector-instance derivation.
    const NS: Uuid = Uuid::from_bytes([
        0x6b, 0x1f, 0x2c, 0x3d, 0x4e, 0x5a, 0x6b, 0x7c, 0x8d, 0x9e, 0xaf, 0xb0, 0xc1, 0xd2, 0xe3,
        0xf4,
    ]);
    let name = format!("{}:{}", scope.as_uuid(), kind.as_str());
    ConnectorInstanceId::from_uuid(Uuid::new_v5(&NS, name.as_bytes()))
}

/// The default [`connector_framework::AuthKind`] for a provider kind.
/// All ten stable providers authenticate via OAuth2 in Tessera's flow
/// (HubSpot private-app tokens are modelled as OAuth2 bearer tokens by
/// the host), so this is currently uniform but kept as a function so a
/// future API-key provider can diverge without touching call sites.
#[must_use]
fn default_auth_kind(_kind: ConnectorKind) -> connector_framework::AuthKind {
    connector_framework::AuthKind::OAuth2
}

/// Human-facing display label for a provider kind.
#[must_use]
fn display_name(kind: ConnectorKind) -> &'static str {
    match kind {
        ConnectorKind::GoogleDrive => "Google Drive",
        ConnectorKind::OneDrive => "OneDrive",
        ConnectorKind::Notion => "Notion",
        ConnectorKind::Jira => "Jira",
        ConnectorKind::Confluence => "Confluence",
        ConnectorKind::Figma => "Figma",
        ConnectorKind::HubSpot => "HubSpot",
        ConnectorKind::Slack => "Slack",
        ConnectorKind::Email => "Email",
        ConnectorKind::GitHub => "GitHub",
        ConnectorKind::Dropbox => "Dropbox",
        ConnectorKind::Box => "Box",
        ConnectorKind::Linear => "Linear",
        ConnectorKind::Miro => "Miro",
        // The upstream `ConnectorKind` enum carries 130+ providers; we
        // only ship the stable subset, so fall back to the canonical
        // id string for any provider not in the stable set.
        other => other.as_str(),
    }
}

// ─────────────────────────────── wire DTOs ─────────────────────────────────

/// Serializable description of an OAuth2 token for transport across the
/// FFI boundary to the host's keychain vault.
///
/// `SecretToken` deliberately does not implement `Serialize` (to avoid
/// accidental leakage via logging/telemetry), so this DTO carries the
/// exposed string forms — it exists *only* at the bridge boundary and
/// is converted to/from [`OAuth2Token`] immediately on each side.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenWire {
    /// Bearer access token.
    pub access_token: String,
    /// Refresh token, when the provider issued one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    /// RFC3339 expiry of `access_token`.
    pub expires_at: DateTime<Utc>,
    /// Granted scope string.
    pub scope: String,
    /// Token type (typically `Bearer`).
    pub token_type: String,
}

impl TokenWire {
    /// Build a wire DTO from a live [`OAuth2Token`].
    #[must_use]
    pub fn from_token(token: &OAuth2Token) -> Self {
        Self {
            access_token: token.access_token.expose().to_string(),
            refresh_token: token.refresh_token.as_ref().map(|s| s.expose().to_string()),
            expires_at: token.expires_at,
            scope: token.scope.clone(),
            token_type: token.token_type.clone(),
        }
    }

    /// Reconstruct an [`OAuth2Token`] from the wire DTO.
    #[must_use]
    pub fn into_token(self) -> OAuth2Token {
        OAuth2Token {
            access_token: SecretToken::new(self.access_token),
            refresh_token: self.refresh_token.map(SecretToken::new),
            expires_at: self.expires_at,
            scope: self.scope,
            token_type: self.token_type,
        }
    }
}

/// Apply a [`RefreshedToken`] onto an existing token, preserving the
/// old refresh token / scope when the provider did not rotate them.
#[must_use]
fn apply_refresh(existing: &OAuth2Token, refreshed: RefreshedToken) -> OAuth2Token {
    OAuth2Token {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token.or_else(|| {
            existing
                .refresh_token
                .as_ref()
                .map(|s| SecretToken::new(s.expose()))
        }),
        expires_at: refreshed.expires_at,
        scope: refreshed.scope.unwrap_or_else(|| existing.scope.clone()),
        token_type: existing.token_type.clone(),
    }
}

/// Provider metadata for the host's connector list (`connectors:list`
/// / `connectors:status`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorV2Info {
    /// Stable provider id (matches `ConnectorKind::as_str`).
    pub provider: String,
    /// Human-facing display label.
    pub display_name: String,
    /// Authentication strategy (`oauth2` / `api_key` / `none`).
    pub auth_kind: String,
}

/// Classification of a sync event, flattened for the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncEventKind {
    /// Document newly created at the source.
    Created,
    /// Existing document updated at the source.
    Updated,
    /// Document deleted/trashed at the source.
    Deleted,
    /// A permission/ACL grant changed at the source.
    PermissionChanged,
}

/// A single fetched document returned to the host after a sync, for the
/// existing search-index path. The body is base64 so binary content
/// (PDFs, images) survives the JSON boundary intact.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FetchedDocV2 {
    /// Source-side document id.
    pub document_id: String,
    /// What happened to the document.
    pub event_kind: SyncEventKind,
    /// Document title, when the provider exposes one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// RFC6838 media type of `body_base64`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Canonical document URL, when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    /// Base64-encoded content body. `None` for deletions and for
    /// providers whose `fetch_content` is unimplemented.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body_base64: Option<String>,
    /// Provider-specific metadata JSON (never carries secrets).
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub metadata: serde_json::Value,
}

/// Outcome of a single sync run (one page of events).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SyncOutcome {
    /// Count of created documents observed.
    pub created: u32,
    /// Count of updated documents observed.
    pub updated: u32,
    /// Count of deleted documents observed.
    pub deleted: u32,
    /// Count of permission-change events observed.
    pub permission_changed: u32,
    /// Cursor to persist for the next incremental run. `None` means
    /// the source surface is fully drained for now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
    /// Fetched documents (for the host's search-index path).
    pub documents: Vec<FetchedDocV2>,
    /// Non-fatal per-document errors (fetch/ingest failures). The run
    /// still succeeds; the host can surface these for observability.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
    /// Source-side document ids whose body was **not** materialised this
    /// run and must be re-fetched later — the per-run `max_fetch` budget
    /// was exhausted before reaching them, or a (likely transient) fetch
    /// error occurred. The connector cursor advances past these
    /// documents (it is a single terminal watermark for the whole
    /// drained batch and cannot be split), so without carrying these ids
    /// forward their content would be lost until the source happens to
    /// touch them again. The host persists this list and feeds it back
    /// as `pending` on the next run, where [`run_sync`] drains it via the
    /// id-addressable [`Connector::fetch_content`]. Order is
    /// deferral-order (oldest first) and ids are de-duplicated.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_fetch: Vec<String>,
}

// ─────────────────────────── sync orchestration ────────────────────────────

/// Options controlling a sync run.
#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    /// Whether to materialise document bodies via `fetch_content` and
    /// pipe them into the [`EvidenceSink`]. When `false`, only event
    /// metadata is collected (cheaper "what changed" probe).
    pub fetch_content: bool,
    /// Upper bound on `fetch_content` calls per run, as a defensive
    /// memory/throughput guard for very large pages.
    pub max_fetch: usize,
}

impl Default for SyncOptions {
    fn default() -> Self {
        Self {
            fetch_content: true,
            max_fetch: 512,
        }
    }
}

/// Outcome of materialising a single document's body.
enum FetchResult {
    /// Body materialised; the doc carries it and should be emitted.
    Materialised(FetchedDocV2),
    /// Provider has no fetchable content for this document
    /// ([`ConnectorError::Unimplemented`]). Emit the metadata-only doc
    /// (the host's ingest skips body-less docs, so this produces no
    /// index entry) — there is nothing to retry, so it is **not**
    /// deferred.
    NoContent(FetchedDocV2),
    /// Fetch failed for a (likely transient) reason. The id must be
    /// retried on a future run rather than dropped — the caller records
    /// it in [`SyncOutcome::pending_fetch`].
    Deferred,
}

/// Fetch one document's body via the id-addressable
/// [`Connector::fetch_content`], ingest it into `sink`, and build the
/// host-facing [`FetchedDocV2`]. Pure per-document work shared by the
/// backlog-drain and fresh-event phases of [`run_sync`].
fn fetch_document(
    connector: &dyn Connector,
    config: &ConnectorConfig,
    token: &OAuth2Token,
    sink: &dyn EvidenceSink,
    document_id: &SourceDocumentId,
    kind: SyncEventKind,
    warnings: &mut Vec<String>,
) -> FetchResult {
    let mut doc = FetchedDocV2 {
        document_id: document_id.as_str().to_string(),
        event_kind: kind,
        title: None,
        mime_type: None,
        source_url: None,
        body_base64: None,
        metadata: serde_json::Value::Null,
    };

    match connector.fetch_content(config, token, document_id) {
        Ok(content) => {
            if let Err(err) = sink.ingest(&config.scope_id, document_id, &content) {
                warnings.push(format!("ingest {}: {err}", document_id.as_str()));
            }
            doc.title.clone_from(&content.title);
            doc.mime_type = Some(content.mime_type.clone());
            doc.source_url.clone_from(&content.source_url);
            doc.body_base64 = Some(base64_encode(&content.body));
            doc.metadata = content.metadata;
            FetchResult::Materialised(doc)
        }
        Err(connector_framework::ConnectorError::Unimplemented(_)) => FetchResult::NoContent(doc),
        Err(e) => {
            warnings.push(format!("fetch {}: {e}", document_id.as_str()));
            FetchResult::Deferred
        }
    }
}

/// Run one sync pass against `connector`, fetching changed content and
/// piping it through `sink`, and returning a host-facing [`SyncOutcome`].
///
/// Chooses [`Connector::initial_sync`] for a never-run state and
/// [`Connector::incremental_sync`] otherwise. Per-document fetch/ingest
/// failures are collected as non-fatal warnings so a single bad
/// document cannot abort the whole run (important when a sync touches
/// thousands of documents for a tenant).
///
/// # Bounded, lossless content fetching
///
/// The `connector_framework` connectors drain **every** page of their
/// change feed into a single [`SyncRunResult`] and return one terminal
/// [`SyncRunResult::next_cursor`] for the whole batch (a connector loops
/// internally up to its own page cap — e.g. tens of thousands of pages —
/// so one call routinely surfaces far more than `max_fetch` events). The
/// cursor is opaque and cannot be split, so once we persist it the
/// source will not re-surface those documents until they change again.
///
/// Fetching every body in one run is unbounded (memory / throughput /
/// the JSON payload back across the host boundary), so `max_fetch` caps
/// the bodies materialised per run. To avoid the cursor silently
/// advancing past un-fetched documents — which would lose their content
/// indefinitely — every created/updated document whose body is not
/// obtained this run (budget exhausted, or a transient fetch error) is
/// recorded in [`SyncOutcome::pending_fetch`]. The host persists that
/// list and feeds it back as `pending`; this function drains it FIRST on
/// the next run (oldest deferrals first) via the id-addressable
/// [`Connector::fetch_content`], so every document is eventually indexed
/// while per-run work stays bounded by `max_fetch`.
///
/// # Errors
///
/// Returns [`ConnectorV2Error::Connector`] only for failures of the
/// sync call itself (auth/transport/parse); per-document issues are
/// returned in [`SyncOutcome::warnings`].
pub fn run_sync(
    connector: &dyn Connector,
    config: &ConnectorConfig,
    token: &OAuth2Token,
    state: &SyncState,
    sink: &dyn EvidenceSink,
    opts: SyncOptions,
    pending: &[SourceDocumentId],
) -> Result<SyncOutcome> {
    let is_initial = matches!(state.mode, SyncMode::Full)
        && state.cursor.is_none()
        && state.last_synced_at.is_none();

    let run: SyncRunResult = if is_initial {
        connector
            .initial_sync(config, token)
            .map_err(|e| ConnectorV2Error::from_framework(&e))?
    } else {
        connector
            .incremental_sync(config, token, state)
            .map_err(|e| ConnectorV2Error::from_framework(&e))?
    };

    let mut outcome = SyncOutcome {
        next_cursor: run.next_cursor,
        ..SyncOutcome::default()
    };

    // Total content-fetch budget for THIS run, shared between draining
    // the deferred backlog and fetching freshly-changed documents. When
    // `fetch_content` is off (metadata-only "what changed" probe) the
    // budget is zero and the inbound backlog passes through untouched.
    let mut budget = if opts.fetch_content {
        opts.max_fetch
    } else {
        0
    };
    // Ids materialised this run, so a doc present in BOTH the backlog and
    // the fresh event stream is fetched only once.
    let mut handled: HashSet<String> = HashSet::new();
    // Deferred ids (undrained backlog + fresh overflow), in deferral
    // order. Pruned of deletions and successful re-fetches before return.
    let mut deferred: Vec<String> = Vec::new();
    // O(1) membership companion to `deferred` (which only preserves
    // order): every defer site dedupes against this set, so a run that
    // overflows by thousands of documents stays linear instead of the
    // O(n²) it would be scanning the Vec on each push.
    let mut deferred_set: HashSet<String> = HashSet::new();

    // Document ids this run deletes at the source, scanned up front so
    // Phase 1 can skip them. A backlog id that is also deleted this run
    // must NOT be re-fetched: some providers still serve recently-trashed
    // bodies, so fetching one would ingest a file (and register a source)
    // that the Phase-2 deletion can't clean up — the host's delete path
    // keys off the PRIOR manifest, which never saw this still-deferred,
    // never-ingested doc. Skipping the fetch leaves nothing to orphan.
    let deleted_ids: HashSet<String> = run
        .events
        .iter()
        .filter_map(|e| match e {
            ConnectorEvent::DocumentDeleted { document_id, .. } => {
                Some(document_id.as_str().to_string())
            }
            _ => None,
        })
        .collect();

    // ── Phase 1: drain the deferred backlog (id-addressable) ────────────
    for id in pending {
        let key = id.as_str().to_string();
        if handled.contains(&key) || deferred_set.contains(&key) || deleted_ids.contains(&key) {
            continue;
        }
        if budget == 0 {
            if deferred_set.insert(key.clone()) {
                deferred.push(key);
            }
            continue;
        }
        budget -= 1;
        match fetch_document(
            connector,
            config,
            token,
            sink,
            id,
            SyncEventKind::Updated,
            &mut outcome.warnings,
        ) {
            FetchResult::Materialised(doc) | FetchResult::NoContent(doc) => {
                handled.insert(key);
                outcome.documents.push(doc);
            }
            FetchResult::Deferred => {
                if deferred_set.insert(key.clone()) {
                    deferred.push(key);
                }
            }
        }
    }

    // ── Phase 2: process this run's fresh events ────────────────────────
    for event in run.events {
        let (document_id, kind) = match &event {
            ConnectorEvent::DocumentCreated { document_id, .. } => {
                outcome.created += 1;
                (document_id.clone(), SyncEventKind::Created)
            }
            ConnectorEvent::DocumentUpdated { document_id, .. } => {
                outcome.updated += 1;
                (document_id.clone(), SyncEventKind::Updated)
            }
            ConnectorEvent::DocumentDeleted { document_id, .. } => {
                outcome.deleted += 1;
                outcome.documents.push(FetchedDocV2 {
                    document_id: document_id.as_str().to_string(),
                    event_kind: SyncEventKind::Deleted,
                    title: None,
                    mime_type: None,
                    source_url: None,
                    body_base64: None,
                    metadata: serde_json::Value::Null,
                });
                continue;
            }
            ConnectorEvent::PermissionChanged { .. } => {
                outcome.permission_changed += 1;
                continue;
            }
        };

        let key = document_id.as_str().to_string();
        // Already materialised while draining the backlog above — the
        // body we just fetched is current, so skip the duplicate fetch.
        if handled.contains(&key) {
            continue;
        }

        if !opts.fetch_content {
            // Metadata-only probe: surface the event without a body and
            // without deferring (there is no content phase to defer to).
            outcome.documents.push(FetchedDocV2 {
                document_id: key,
                event_kind: kind,
                title: None,
                mime_type: None,
                source_url: None,
                body_base64: None,
                metadata: serde_json::Value::Null,
            });
            continue;
        }

        if budget == 0 {
            // Out of budget this run — defer rather than advance the
            // cursor past an un-fetched body.
            if deferred_set.insert(key.clone()) {
                deferred.push(key);
            }
            continue;
        }
        budget -= 1;
        match fetch_document(
            connector,
            config,
            token,
            sink,
            &document_id,
            kind,
            &mut outcome.warnings,
        ) {
            FetchResult::Materialised(doc) | FetchResult::NoContent(doc) => {
                handled.insert(key);
                outcome.documents.push(doc);
            }
            FetchResult::Deferred => {
                if deferred_set.insert(key.clone()) {
                    deferred.push(key);
                }
            }
        }
    }

    // Drop ids we no longer need to carry forward:
    //  - documents deleted at the source this run never need a body, and
    //  - documents a later phase successfully materialised: an id present
    //    in BOTH the backlog and this run's fresh events whose Phase-1
    //    re-fetch failed transiently but whose Phase-2 fetch then
    //    succeeded must not linger as stale `pending` (it is already
    //    ingested) and trigger a redundant re-fetch next run.
    if !deleted_ids.is_empty() || !handled.is_empty() {
        deferred.retain(|id| !deleted_ids.contains(id) && !handled.contains(id));
    }
    outcome.pending_fetch = deferred;

    Ok(outcome)
}

/// Standard, padded base64 (RFC 4648) for encoding fetched bodies onto
/// the JSON boundary, delegating to the workspace `base64` crate.
fn base64_encode(input: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(input)
}

// ───────────────────────────── public API ──────────────────────────────────

/// Parse an optional scope id string into a [`ScopeId`], defaulting to
/// a deterministic per-provider scope when absent. For Tessera's
/// single-user desktop host the scope is stable; multi-tenant hosts can
/// pass an explicit per-tenant scope uuid.
fn parse_scope(scope_id: Option<&str>, provider: &str) -> Result<ScopeId> {
    if let Some(s) = scope_id {
        let uuid = Uuid::parse_str(s)
            .map_err(|e| ConnectorV2Error::InvalidConfig(format!("scope_id: {e}")))?;
        Ok(ScopeId::from_uuid(uuid))
    } else {
        // Deterministic scope derived from the provider so repeated
        // calls without an explicit scope stay consistent.
        const NS: Uuid = Uuid::from_bytes([
            0x9a, 0x3b, 0x1c, 0x7d, 0x2e, 0x4f, 0x5a, 0x6b, 0x7c, 0x8d, 0x9e, 0xaf, 0xb0, 0xc1,
            0xd2, 0xe3,
        ]);
        Ok(ScopeId::from_uuid(Uuid::new_v5(&NS, provider.as_bytes())))
    }
}

/// List the connector providers compiled into this build.
#[must_use]
pub fn list_connectors() -> Vec<ConnectorV2Info> {
    enabled_providers()
        .into_iter()
        .map(|kind| ConnectorV2Info {
            provider: kind.as_str().to_string(),
            display_name: display_name(kind).to_string(),
            auth_kind: auth_kind_str(default_auth_kind(kind)),
        })
        .collect()
}

fn auth_kind_str(kind: connector_framework::AuthKind) -> String {
    match kind {
        connector_framework::AuthKind::OAuth2 => "oauth2",
        connector_framework::AuthKind::ApiKey => "api_key",
        connector_framework::AuthKind::None => "none",
    }
    .to_string()
}

/// Whether `provider` is a feature-enabled stable connector in this
/// build.
#[must_use]
pub fn is_supported(provider: &str) -> bool {
    provider_to_kind(provider).is_some()
}

/// Exchange an authorization code (carried in `auth_config`) for an
/// OAuth2 token via the provider's connector.
///
/// `auth_config` is the provider-specific JSON bag the host already
/// assembles (token_url, client_id, redirect_uri, authorization_code,
/// and — only in the resolver-less dev path — client_secret).
///
/// # Errors
///
/// Propagates connector auth/transport failures and config errors.
pub fn authenticate(
    provider: &str,
    auth_config: serde_json::Value,
    scope_id: Option<&str>,
) -> Result<TokenWire> {
    let scope = parse_scope(scope_id, provider)?;
    let (connector, config, _instance) = resolve_connector(provider, auth_config, scope)?;
    let token = connector
        .authenticate(&config)
        .map_err(|e| ConnectorV2Error::from_framework(&e))?;
    Ok(TokenWire::from_token(&token))
}

/// Refresh an access token using its refresh token.
///
/// # Errors
///
/// Returns [`ConnectorV2Error::InvalidConfig`] if no refresh token is
/// present, or a connector error if the refresh grant fails.
pub fn refresh(
    provider: &str,
    auth_config: serde_json::Value,
    token: TokenWire,
    scope_id: Option<&str>,
) -> Result<TokenWire> {
    let scope = parse_scope(scope_id, provider)?;
    let kind = provider_to_kind(provider)
        .ok_or_else(|| ConnectorV2Error::UnknownProvider(provider.into()))?;
    let existing = token.into_token();
    let refresh_token = existing
        .refresh_token
        .as_ref()
        .map(|s| s.expose().to_string())
        .ok_or_else(|| {
            ConnectorV2Error::InvalidConfig("no refresh_token present on token".into())
        })?;

    let transport = Arc::new(
        connector_framework::BlockingHttpTransport::new()
            .map_err(|e| ConnectorV2Error::Transport(e.to_string()))?,
    );
    let client = OAuth2Client::new(transport);
    if let Some(resolver) = current_resolver() {
        client.set_resolver(resolver);
    }
    let config = ConnectorConfig::new(kind, default_auth_kind(kind), scope)
        .with_auth_config(existing_auth_config(&auth_config));
    let refreshed = client
        .refresh_with_config(&config, &refresh_token)
        .map_err(|e| ConnectorV2Error::from_framework(&e))?;
    Ok(TokenWire::from_token(&apply_refresh(&existing, refreshed)))
}

/// Pass-through that keeps `auth_config` as-is (placeholder seam for
/// future per-provider normalisation without changing call sites).
#[inline]
fn existing_auth_config(auth_config: &serde_json::Value) -> serde_json::Value {
    auth_config.clone()
}

/// Run an incremental sync for `provider`, fetching changed content and
/// piping it through `sink`.
///
/// `state_json` is the persisted [`SyncState`] from the previous run
/// (or `null`/absent for a first sync). `pending` is the host's
/// deferred-fetch backlog from the previous run (document ids whose
/// bodies were not materialised yet); it is drained first within the
/// `max_fetch` budget. The returned [`SyncOutcome`] carries the new
/// cursor and the updated backlog for the host to persist.
///
/// # Errors
///
/// Propagates connector and config errors.
// Boundary function threading the connector wire params (auth, token,
// state, scope, sink, options, deferred-fetch backlog) into one run;
// these are inherently positional and mirror the NAPI signature.
#[allow(clippy::too_many_arguments)]
pub fn sync(
    provider: &str,
    auth_config: serde_json::Value,
    token: TokenWire,
    state_json: Option<serde_json::Value>,
    scope_id: Option<&str>,
    sink: &dyn EvidenceSink,
    opts: SyncOptions,
    pending: &[String],
) -> Result<SyncOutcome> {
    let scope = parse_scope(scope_id, provider)?;
    let (connector, config, instance) = resolve_connector(provider, auth_config, scope)?;
    let token = token.into_token();

    let state = match state_json {
        Some(v) if !v.is_null() => {
            let mut st: SyncState = serde_json::from_value(v)
                .map_err(|e| ConnectorV2Error::InvalidConfig(format!("state_json: {e}")))?;
            // Pin the state's connector id to the resolved instance so a
            // host that round-trips an opaque blob can't desync it.
            st.connector = instance;
            st
        }
        _ => SyncState::new(instance),
    };

    let pending_ids: Vec<SourceDocumentId> = pending
        .iter()
        .map(|id| SourceDocumentId::new(id.clone()))
        .collect();

    run_sync(
        &*connector,
        &config,
        &token,
        &state,
        sink,
        opts,
        &pending_ids,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use connector_framework::{
        AuthKind, ConnectorError, HttpTransport, OAuth2CodeExchange, WebhookSubscription,
    };
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn token() -> OAuth2Token {
        OAuth2Token {
            access_token: SecretToken::new("access-123"),
            refresh_token: Some(SecretToken::new("refresh-456")),
            expires_at: Utc::now() + chrono::Duration::hours(1),
            scope: "read".to_string(),
            token_type: "Bearer".to_string(),
        }
    }

    fn cfg() -> ConnectorConfig {
        ConnectorConfig::new(ConnectorKind::GitHub, AuthKind::OAuth2, ScopeId::new_v4())
    }

    /// Recording sink that captures every ingested document.
    #[derive(Default)]
    struct RecordingSink {
        ingested: Mutex<Vec<(Uuid, String, Vec<u8>)>>,
    }

    impl EvidenceSink for RecordingSink {
        fn ingest(
            &self,
            scope: &ScopeId,
            document_id: &SourceDocumentId,
            content: &FetchedContent,
        ) -> std::result::Result<(), String> {
            self.ingested.lock().unwrap().push((
                scope.as_uuid(),
                document_id.as_str().to_string(),
                content.body.clone(),
            ));
            Ok(())
        }
    }

    /// Sink that always fails, to exercise the non-fatal warning path.
    struct FailingSink;
    impl EvidenceSink for FailingSink {
        fn ingest(
            &self,
            _scope: &ScopeId,
            _document_id: &SourceDocumentId,
            _content: &FetchedContent,
        ) -> std::result::Result<(), String> {
            Err("disk full".to_string())
        }
    }

    /// Configurable fake connector for orchestration tests.
    struct FakeConnector {
        events: Vec<ConnectorEvent>,
        next_cursor: Option<String>,
        fetch_behaviour: FetchBehaviour,
        initial_calls: AtomicUsize,
        incremental_calls: AtomicUsize,
        fetch_calls: AtomicUsize,
    }

    #[derive(Clone, Copy)]
    enum FetchBehaviour {
        Ok,
        Unimplemented,
        Error,
        /// Fail the first `fetch_content` call (simulating a transient
        /// error), then succeed on every subsequent call.
        FailFirstThenOk,
    }

    impl FakeConnector {
        fn new(events: Vec<ConnectorEvent>, fetch: FetchBehaviour) -> Self {
            Self {
                events,
                next_cursor: Some("cursor-1".to_string()),
                fetch_behaviour: fetch,
                initial_calls: AtomicUsize::new(0),
                incremental_calls: AtomicUsize::new(0),
                fetch_calls: AtomicUsize::new(0),
            }
        }
    }

    impl Connector for FakeConnector {
        fn authenticate(
            &self,
            _config: &ConnectorConfig,
        ) -> connector_framework::Result<OAuth2Token> {
            Ok(token())
        }

        fn initial_sync(
            &self,
            _config: &ConnectorConfig,
            _token: &OAuth2Token,
        ) -> connector_framework::Result<SyncRunResult> {
            self.initial_calls.fetch_add(1, Ordering::SeqCst);
            Ok(SyncRunResult {
                events: self.events.clone(),
                next_cursor: self.next_cursor.clone(),
            })
        }

        fn incremental_sync(
            &self,
            _config: &ConnectorConfig,
            _token: &OAuth2Token,
            _state: &SyncState,
        ) -> connector_framework::Result<SyncRunResult> {
            self.incremental_calls.fetch_add(1, Ordering::SeqCst);
            Ok(SyncRunResult {
                events: self.events.clone(),
                next_cursor: self.next_cursor.clone(),
            })
        }

        fn fetch_content(
            &self,
            _config: &ConnectorConfig,
            _token: &OAuth2Token,
            document_id: &SourceDocumentId,
        ) -> connector_framework::Result<FetchedContent> {
            let nth = self.fetch_calls.fetch_add(1, Ordering::SeqCst);
            let ok = || FetchedContent {
                body: format!("body-of-{}", document_id.as_str()).into_bytes(),
                mime_type: "text/plain".to_string(),
                title: Some(format!("Title {}", document_id.as_str())),
                metadata: json!({"doc": document_id.as_str()}),
                source_url: Some(format!("https://example/{}", document_id.as_str())),
            };
            match self.fetch_behaviour {
                FetchBehaviour::Ok => Ok(ok()),
                FetchBehaviour::Unimplemented => {
                    Err(ConnectorError::Unimplemented("fetch".to_string()))
                }
                FetchBehaviour::Error => Err(ConnectorError::Transport("boom".to_string())),
                FetchBehaviour::FailFirstThenOk => {
                    if nth == 0 {
                        Err(ConnectorError::Transport("boom".to_string()))
                    } else {
                        Ok(ok())
                    }
                }
            }
        }

        fn subscribe_webhook(
            &self,
            _config: &ConnectorConfig,
            _token: &OAuth2Token,
            _callback_url: &str,
        ) -> connector_framework::Result<WebhookSubscription> {
            Err(ConnectorError::Unimplemented("webhook".to_string()))
        }

        fn handle_webhook_event(
            &self,
            _body: &[u8],
        ) -> connector_framework::Result<Vec<ConnectorEvent>> {
            Ok(vec![])
        }
    }

    fn created(id: &str) -> ConnectorEvent {
        ConnectorEvent::DocumentCreated {
            document_id: SourceDocumentId::new(id),
            occurred_at: Utc::now(),
        }
    }

    fn updated(id: &str) -> ConnectorEvent {
        ConnectorEvent::DocumentUpdated {
            document_id: SourceDocumentId::new(id),
            occurred_at: Utc::now(),
        }
    }

    fn deleted(id: &str) -> ConnectorEvent {
        ConnectorEvent::DocumentDeleted {
            document_id: SourceDocumentId::new(id),
            occurred_at: Utc::now(),
        }
    }

    /// Every provider id that must be compiled into the default
    /// (`connectors-v2-stable`) build. Adding a provider to the stable
    /// bundle means adding it here; the count assertions below derive
    /// from this list so they never drift.
    const STABLE_PROVIDER_IDS: &[&str] = &[
        "google_drive",
        "onedrive",
        "notion",
        "jira",
        "confluence",
        "figma",
        "hubspot",
        "slack",
        "email",
        "github",
        "dropbox",
        "box",
        "linear",
        "miro",
    ];

    #[test]
    fn enabled_providers_covers_stable_set() {
        let providers = enabled_providers();
        assert_eq!(
            providers.len(),
            STABLE_PROVIDER_IDS.len(),
            "every stable provider must be enabled"
        );
        let ids: Vec<&str> = providers.iter().map(|k| k.as_str()).collect();
        for expected in STABLE_PROVIDER_IDS {
            assert!(ids.contains(expected), "missing provider {expected}");
        }
    }

    #[test]
    fn provider_kind_roundtrips_through_as_str() {
        for kind in enabled_providers() {
            let id = kind.as_str();
            assert_eq!(
                provider_to_kind(id),
                Some(kind),
                "roundtrip failed for {id}"
            );
        }
        assert_eq!(provider_to_kind("not_a_provider"), None);
    }

    #[test]
    fn list_connectors_reports_oauth_providers() {
        let infos = list_connectors();
        assert_eq!(infos.len(), STABLE_PROVIDER_IDS.len());
        assert!(infos.iter().all(|i| i.auth_kind == "oauth2"));
        let gh = infos.iter().find(|i| i.provider == "github").unwrap();
        assert_eq!(gh.display_name, "GitHub");
        let dropbox = infos.iter().find(|i| i.provider == "dropbox").unwrap();
        assert_eq!(dropbox.display_name, "Dropbox");
        let miro = infos.iter().find(|i| i.provider == "miro").unwrap();
        assert_eq!(miro.display_name, "Miro");
    }

    #[test]
    fn is_supported_matches_enabled_set() {
        assert!(is_supported("github"));
        assert!(is_supported("hubspot"));
        assert!(is_supported("dropbox"));
        assert!(is_supported("box"));
        assert!(is_supported("linear"));
        assert!(is_supported("miro"));
        assert!(!is_supported("salesforce"));
    }

    #[test]
    fn factory_builds_every_stable_connector() {
        let transport: Arc<dyn HttpTransport> =
            Arc::new(connector_framework::BlockingHttpTransport::new().unwrap());
        let oauth: Arc<dyn OAuth2CodeExchange> = Arc::new(OAuth2Client::new(Arc::new(
            connector_framework::BlockingHttpTransport::new().unwrap(),
        )));
        for kind in enabled_providers() {
            let built = build_connector(
                kind,
                ConnectorInstanceId::new_v4(),
                transport.clone(),
                oauth.clone(),
            );
            assert!(
                built.is_some(),
                "factory returned None for {}",
                kind.as_str()
            );
        }
    }

    #[test]
    fn token_wire_roundtrips_with_and_without_refresh() {
        let original = token();
        let wire = TokenWire::from_token(&original);
        let json_str = serde_json::to_string(&wire).unwrap();
        let parsed: TokenWire = serde_json::from_str(&json_str).unwrap();
        let back = parsed.into_token();
        assert_eq!(back.access_token.expose(), "access-123");
        assert_eq!(back.refresh_token.as_ref().unwrap().expose(), "refresh-456");
        assert_eq!(back.scope, "read");
        assert_eq!(back.token_type, "Bearer");

        let no_refresh = OAuth2Token {
            refresh_token: None,
            ..clone_token(&original)
        };
        let wire = TokenWire::from_token(&no_refresh);
        assert!(wire.refresh_token.is_none());
        let back = wire.into_token();
        assert!(back.refresh_token.is_none());
    }

    #[test]
    fn apply_refresh_preserves_unrotated_fields() {
        let existing = token();
        let refreshed = RefreshedToken {
            access_token: SecretToken::new("new-access"),
            refresh_token: None,
            expires_at: Utc::now() + chrono::Duration::hours(2),
            scope: None,
        };
        let merged = apply_refresh(&existing, refreshed);
        assert_eq!(merged.access_token.expose(), "new-access");
        // Refresh token + scope preserved from the existing token.
        assert_eq!(
            merged.refresh_token.as_ref().unwrap().expose(),
            "refresh-456"
        );
        assert_eq!(merged.scope, "read");
    }

    #[test]
    fn in_memory_token_store_roundtrip() {
        let store = InMemoryTokenStore::new();
        let instance = ConnectorInstanceId::new_v4();
        assert!(store.load(&instance).is_none());
        store.store(&instance, token());
        let loaded = store.load(&instance).unwrap();
        assert_eq!(loaded.access_token.expose(), "access-123");
        store.remove(&instance);
        assert!(store.load(&instance).is_none());
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn run_sync_initial_fetches_and_pipes_to_sink() {
        let connector = FakeConnector::new(
            vec![created("d1"), updated("d2"), deleted("d3")],
            FetchBehaviour::Ok,
        );
        let sink = RecordingSink::default();
        let config = cfg();
        let state = SyncState::new(ConnectorInstanceId::new_v4());

        let outcome = run_sync(
            &connector,
            &config,
            &token(),
            &state,
            &sink,
            SyncOptions::default(),
            &[],
        )
        .unwrap();

        assert_eq!(connector.initial_calls.load(Ordering::SeqCst), 1);
        assert_eq!(connector.incremental_calls.load(Ordering::SeqCst), 0);
        assert_eq!(outcome.created, 1);
        assert_eq!(outcome.updated, 1);
        assert_eq!(outcome.deleted, 1);
        assert_eq!(outcome.next_cursor.as_deref(), Some("cursor-1"));
        // Two fetched docs (created + updated) plus a deletion record.
        assert_eq!(outcome.documents.len(), 3);
        assert!(outcome.warnings.is_empty());

        let ingested = sink.ingested.lock().unwrap();
        assert_eq!(
            ingested.len(),
            2,
            "only created+updated are fetched/ingested"
        );
        assert_eq!(ingested[0].1, "d1");
        assert_eq!(ingested[0].2, b"body-of-d1");

        let d1 = outcome
            .documents
            .iter()
            .find(|d| d.document_id == "d1")
            .unwrap();
        assert_eq!(d1.event_kind, SyncEventKind::Created);
        assert_eq!(d1.mime_type.as_deref(), Some("text/plain"));
        assert_eq!(d1.body_base64.as_deref(), Some("Ym9keS1vZi1kMQ=="));

        let d3 = outcome
            .documents
            .iter()
            .find(|d| d.document_id == "d3")
            .unwrap();
        assert_eq!(d3.event_kind, SyncEventKind::Deleted);
        assert!(d3.body_base64.is_none());
    }

    #[test]
    fn run_sync_uses_incremental_when_state_has_cursor() {
        let connector = FakeConnector::new(vec![created("d1")], FetchBehaviour::Ok);
        let sink = NoopEvidenceSink;
        let config = cfg();
        let mut state = SyncState::new(ConnectorInstanceId::new_v4());
        state.mode = SyncMode::Incremental;
        state.cursor = Some("prev".to_string());
        state.last_synced_at = Some(Utc::now());

        run_sync(
            &connector,
            &config,
            &token(),
            &state,
            &sink,
            SyncOptions::default(),
            &[],
        )
        .unwrap();
        assert_eq!(connector.incremental_calls.load(Ordering::SeqCst), 1);
        assert_eq!(connector.initial_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn run_sync_treats_unimplemented_fetch_as_metadata_only() {
        let connector = FakeConnector::new(vec![created("d1")], FetchBehaviour::Unimplemented);
        let sink = RecordingSink::default();
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            SyncOptions::default(),
            &[],
        )
        .unwrap();
        assert_eq!(outcome.documents.len(), 1);
        assert!(outcome.documents[0].body_base64.is_none());
        assert!(
            outcome.warnings.is_empty(),
            "unimplemented is not a warning"
        );
        assert!(
            outcome.pending_fetch.is_empty(),
            "a provider with no content fetch has nothing to retry"
        );
        assert!(sink.ingested.lock().unwrap().is_empty());
    }

    #[test]
    fn run_sync_defers_fetch_errors_instead_of_dropping() {
        let connector = FakeConnector::new(vec![created("d1")], FetchBehaviour::Error);
        let sink = RecordingSink::default();
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            SyncOptions::default(),
            &[],
        )
        .unwrap();
        assert_eq!(outcome.warnings.len(), 1);
        assert!(outcome.warnings[0].contains("fetch d1"));
        // A transient fetch failure must not silently drop the document:
        // the cursor advances, so the id is deferred for a future retry
        // rather than emitted body-less.
        assert!(outcome.documents.is_empty());
        assert_eq!(outcome.pending_fetch, vec!["d1".to_string()]);
    }

    #[test]
    fn run_sync_records_sink_errors_as_warnings() {
        let connector = FakeConnector::new(vec![created("d1")], FetchBehaviour::Ok);
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &FailingSink,
            SyncOptions::default(),
            &[],
        )
        .unwrap();
        assert_eq!(outcome.warnings.len(), 1);
        assert!(outcome.warnings[0].contains("ingest d1"));
        // The doc is still returned to the host for the search-index path
        // (the body WAS fetched; only the substrate ingest failed), so it
        // is not deferred.
        assert_eq!(outcome.documents.len(), 1);
        assert!(outcome.pending_fetch.is_empty());
    }

    #[test]
    fn run_sync_respects_max_fetch_guard() {
        let connector = FakeConnector::new(
            vec![created("d1"), created("d2"), created("d3")],
            FetchBehaviour::Ok,
        );
        let sink = RecordingSink::default();
        let opts = SyncOptions {
            fetch_content: true,
            max_fetch: 2,
        };
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            opts,
            &[],
        )
        .unwrap();
        // Two bodies fetched within budget; the third is deferred (not
        // dropped) so the cursor advancing past it does not lose content.
        assert_eq!(outcome.documents.len(), 2);
        assert_eq!(sink.ingested.lock().unwrap().len(), 2);
        let with_body = outcome
            .documents
            .iter()
            .filter(|d| d.body_base64.is_some())
            .count();
        assert_eq!(with_body, 2);
        assert_eq!(outcome.pending_fetch, vec!["d3".to_string()]);
        // Event counters still reflect every event observed.
        assert_eq!(outcome.created, 3);
    }

    #[test]
    fn run_sync_drains_pending_backlog_first() {
        // No fresh events; the backlog from a prior run is drained.
        let connector = FakeConnector::new(vec![], FetchBehaviour::Ok);
        let sink = RecordingSink::default();
        let pending = [SourceDocumentId::new("old1"), SourceDocumentId::new("old2")];
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            SyncOptions::default(),
            &pending,
        )
        .unwrap();
        assert_eq!(outcome.documents.len(), 2);
        assert_eq!(sink.ingested.lock().unwrap().len(), 2);
        assert!(outcome.documents.iter().all(|d| d.body_base64.is_some()));
        assert!(
            outcome.pending_fetch.is_empty(),
            "a fully-drained backlog leaves nothing pending"
        );
    }

    #[test]
    fn run_sync_backlog_drain_is_bounded_by_budget() {
        // Budget of 2 must cover backlog + fresh events: the backlog
        // drains first, leaving fresh events to defer.
        let connector = FakeConnector::new(vec![created("new1")], FetchBehaviour::Ok);
        let sink = RecordingSink::default();
        let opts = SyncOptions {
            fetch_content: true,
            max_fetch: 2,
        };
        let pending = [
            SourceDocumentId::new("old1"),
            SourceDocumentId::new("old2"),
            SourceDocumentId::new("old3"),
        ];
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            opts,
            &pending,
        )
        .unwrap();
        // old1, old2 drained; old3 and new1 deferred (backlog first, then
        // fresh overflow), preserving deferral order.
        assert_eq!(outcome.documents.len(), 2);
        assert_eq!(
            outcome.pending_fetch,
            vec!["old3".to_string(), "new1".to_string()]
        );
    }

    #[test]
    fn run_sync_prunes_deleted_ids_from_backlog() {
        // A doc still pending from a prior run is deleted at the source;
        // it must not be retried (and must not linger in the backlog).
        let connector = FakeConnector::new(vec![deleted("old1")], FetchBehaviour::Ok);
        let sink = RecordingSink::default();
        let opts = SyncOptions {
            fetch_content: true,
            max_fetch: 0,
        };
        let pending = [SourceDocumentId::new("old1"), SourceDocumentId::new("old2")];
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            opts,
            &pending,
        )
        .unwrap();
        assert_eq!(outcome.deleted, 1);
        assert_eq!(
            outcome.pending_fetch,
            vec!["old2".to_string()],
            "deleted old1 is pruned; undrained old2 stays pending"
        );
    }

    #[test]
    fn run_sync_does_not_fetch_backlog_id_deleted_this_run() {
        // "d1" is in the backlog AND deleted at the source this run, with
        // budget to spare. It must NOT be re-fetched: ingesting a body for
        // a doc the host is about to delete (whose deletion can't be
        // cleaned up — it was never in the prior manifest) would orphan a
        // file/source on disk. Only the deletion event is surfaced.
        let connector = FakeConnector::new(vec![deleted("d1")], FetchBehaviour::Ok);
        let sink = RecordingSink::default();
        let pending = [SourceDocumentId::new("d1")];
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            SyncOptions::default(),
            &pending,
        )
        .unwrap();
        // No body was fetched (no Updated doc, nothing ingested), only the
        // deletion is emitted, and nothing lingers in the backlog.
        assert_eq!(connector.fetch_calls.load(Ordering::SeqCst), 0);
        assert_eq!(outcome.deleted, 1);
        assert_eq!(outcome.documents.len(), 1);
        assert_eq!(outcome.documents[0].event_kind, SyncEventKind::Deleted);
        assert!(outcome.documents[0].body_base64.is_none());
        assert!(sink.ingested.lock().unwrap().is_empty());
        assert!(outcome.pending_fetch.is_empty());
    }

    #[test]
    fn run_sync_prunes_backlog_id_resolved_by_fresh_event() {
        // "d1" is carried in the backlog AND changed again at the source
        // this run. Its Phase-1 re-fetch fails transiently, but the fresh
        // Phase-2 event re-fetches it successfully. It must NOT remain in
        // pending_fetch — it is already ingested, so carrying it forward
        // would cause a redundant re-fetch next run.
        let connector = FakeConnector::new(vec![updated("d1")], FetchBehaviour::FailFirstThenOk);
        let sink = RecordingSink::default();
        let pending = [SourceDocumentId::new("d1")];
        let outcome = run_sync(
            &connector,
            &cfg(),
            &token(),
            &SyncState::new(ConnectorInstanceId::new_v4()),
            &sink,
            SyncOptions::default(),
            &pending,
        )
        .unwrap();
        // Phase 1 fetch failed (warning recorded); Phase 2 fetch succeeded.
        assert_eq!(outcome.warnings.len(), 1);
        assert_eq!(outcome.documents.len(), 1);
        assert!(outcome.documents[0].body_base64.is_some());
        assert_eq!(sink.ingested.lock().unwrap().len(), 1);
        assert!(
            outcome.pending_fetch.is_empty(),
            "a backlog id resolved by a fresh event must not stay pending"
        );
    }

    #[test]
    fn parse_scope_is_deterministic_without_explicit_id() {
        let a = parse_scope(None, "github").unwrap();
        let b = parse_scope(None, "github").unwrap();
        let c = parse_scope(None, "slack").unwrap();
        assert_eq!(a.as_uuid(), b.as_uuid());
        assert_ne!(a.as_uuid(), c.as_uuid());

        let explicit = parse_scope(Some("00000000-0000-0000-0000-000000000001"), "github").unwrap();
        assert_eq!(
            explicit.as_uuid().to_string(),
            "00000000-0000-0000-0000-000000000001"
        );
        assert!(parse_scope(Some("not-a-uuid"), "github").is_err());
    }

    #[test]
    fn instance_id_is_stable_per_scope_and_provider() {
        let scope = ScopeId::new_v4();
        let a = instance_id_for(ConnectorKind::GitHub, scope);
        let b = instance_id_for(ConnectorKind::GitHub, scope);
        let c = instance_id_for(ConnectorKind::Slack, scope);
        assert_eq!(a.as_uuid(), b.as_uuid());
        assert_ne!(a.as_uuid(), c.as_uuid());
    }

    #[test]
    fn client_secret_resolver_registration_roundtrips() {
        struct DummyResolver;
        impl ClientSecretResolver for DummyResolver {
            fn resolve(&self, _kind: &str, _scope_id: &str, _client_id: &str) -> Option<String> {
                Some("secret".to_string())
            }
        }
        clear_client_secret_resolver();
        assert!(current_resolver().is_none());
        set_client_secret_resolver(Arc::new(DummyResolver));
        assert!(current_resolver().is_some());
        clear_client_secret_resolver();
        assert!(current_resolver().is_none());
    }
}
