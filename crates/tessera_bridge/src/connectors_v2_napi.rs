//! N-API entry points for the v2 connector layer.
//!
//! These are the bridge functions the Electron main process calls from
//! `apps/desktop/electron/ipc/connectors/*` to drive the knowledge
//! substrate connectors. They are intentionally thin: argument parsing,
//! delegation to [`crate::connectors_v2`], and error flattening to a
//! JS promise rejection message.
//!
//! # Wire convention
//!
//! Token and sync payloads carry nested/optional fields and binary
//! bodies that do not map cleanly onto napi-rs 2.x's `#[napi(object)]`
//! surface (no `serde_json::Value`, no `DateTime`, no `Vec<u8>` as
//! base64). To keep the contract stable and lossless, those payloads
//! cross the boundary as JSON **strings** that the TS side parses with
//! the zod schemas in `apps/desktop/electron/ipc/schemas.ts`. The
//! simple connector list is returned as a typed object since it has no
//! such fields.
//!
//! # Security
//!
//! No token or `client_secret` is ever held in process-global Rust
//! state by this layer: every call receives the current token (and, in
//! the resolver-less dev path, the `client_secret` inside
//! `auth_config_json`) as an argument, uses it for the single
//! operation, and returns the updated token to the host's
//! keychain-backed vault. See the module docs on [`crate::connectors_v2`].

use napi::bindgen_prelude::{AsyncTask, Error as NapiError};
use napi::{Env, Task};
use napi_derive::napi;

use crate::connectors_v2::{self, ConnectorV2Error, NoopEvidenceSink, SyncOptions, TokenWire};

/// JS-facing connector descriptor (`connectors:list` / `:status`).
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ConnectorV2InfoNapi {
    /// Stable provider id (`google_drive`, `github`, …).
    pub provider: String,
    /// Human-facing display label.
    pub display_name: String,
    /// Authentication strategy (`oauth2` / `api_key` / `none`).
    pub auth_kind: String,
}

fn to_napi(err: &ConnectorV2Error) -> NapiError {
    NapiError::from_reason(err.to_string())
}

fn parse_json(label: &str, raw: &str) -> Result<serde_json::Value, NapiError> {
    serde_json::from_str(raw)
        .map_err(|e| NapiError::from_reason(format!("invalid {label} JSON: {e}")))
}

/// List the connector providers compiled into this build, in stable
/// display order. Backs the renderer's connector cards and the
/// `connectors:list` / `connectors:status` channels.
#[napi]
#[must_use]
pub fn bridge_connectors_v2_list() -> Vec<ConnectorV2InfoNapi> {
    connectors_v2::list_connectors()
        .into_iter()
        .map(|info| ConnectorV2InfoNapi {
            provider: info.provider,
            display_name: info.display_name,
            auth_kind: info.auth_kind,
        })
        .collect()
}

/// Whether `provider` is a feature-enabled stable connector in this
/// build. Lets the host fall back to `tessera_connectors` for a
/// provider the v2 layer does not (yet) expose.
#[napi]
#[must_use]
pub fn bridge_connectors_v2_supported(provider: String) -> bool {
    connectors_v2::is_supported(&provider)
}

/// Exchange an authorization code for an OAuth2 token
/// (`connectors:connect` / `connectors:authenticate`).
///
/// * `auth_config_json` — provider-specific JSON bag (token_url,
///   client_id, redirect_uri, authorization_code, …).
/// * `scope_id` — optional per-tenant scope uuid; a deterministic
///   per-provider scope is derived when omitted.
///
/// Returns the new token as a JSON string ([`TokenWire`]) for the host
/// to persist in its keychain vault.
///
/// # Errors
///
/// Rejects with the flattened connector error on auth/transport/config
/// failure.
#[napi]
pub fn bridge_connectors_v2_authenticate(
    provider: String,
    auth_config_json: String,
    scope_id: Option<String>,
) -> Result<String, NapiError> {
    let auth_config = parse_json("auth_config", &auth_config_json)?;
    let token = connectors_v2::authenticate(&provider, auth_config, scope_id.as_deref())
        .map_err(|e| to_napi(&e))?;
    serde_json::to_string(&token)
        .map_err(|e| NapiError::from_reason(format!("token serialize: {e}")))
}

/// Refresh an access token using its refresh token. Returns the
/// refreshed token as a JSON string ([`TokenWire`]).
///
/// # Errors
///
/// Rejects if the token has no refresh token or the refresh grant
/// fails.
#[napi]
pub fn bridge_connectors_v2_refresh(
    provider: String,
    auth_config_json: String,
    token_json: String,
    scope_id: Option<String>,
) -> Result<String, NapiError> {
    let auth_config = parse_json("auth_config", &auth_config_json)?;
    let token: TokenWire = serde_json::from_str(&token_json)
        .map_err(|e| NapiError::from_reason(format!("invalid token JSON: {e}")))?;
    let refreshed = connectors_v2::refresh(&provider, auth_config, token, scope_id.as_deref())
        .map_err(|e| to_napi(&e))?;
    serde_json::to_string(&refreshed)
        .map_err(|e| NapiError::from_reason(format!("token serialize: {e}")))
}

/// Run an incremental sync (`connectors:sync`).
///
/// * `token_json` — current [`TokenWire`].
/// * `state_json` — persisted [`connector_framework::SyncState`] from
///   the previous run, or `None`/`"null"` for a first sync.
/// * `fetch_content` — when `true`, materialise document bodies and
///   pipe them into the evidence pipeline; when `false`, only collect
///   change metadata.
///
/// Returns a JSON string
/// ([`crate::connectors_v2::SyncOutcome`]) carrying change counts, the
/// fetched documents (base64 bodies) for the host's search index, the
/// new cursor to persist, and any non-fatal per-document warnings.
///
/// # Evidence pipeline
///
/// Until Session 1's `tessera_substrate` evidence-ingest is wired in,
/// this uses [`NoopEvidenceSink`] — content still flows back to the
/// host via the returned documents for the existing search-index path,
/// so the migration does not block on Session 1. When the substrate
/// lands, swap the sink here for the real evidence→observation→memory
/// ingest (the [`crate::connectors_v2::EvidenceSink`] trait is the
/// seam).
///
/// # Concurrency
///
/// A full sync makes one blocking HTTP round-trip per page of
/// changes plus one per fetched document body (up to `max_fetch`,
/// 512 by default). Running that on the Node main thread would
/// freeze the Electron UI for the whole sync — seconds to minutes
/// for a large initial import. To keep the event loop responsive
/// the work is offloaded to a libuv worker thread via an
/// [`AsyncTask`]; JS receives a `Promise` and `await`s it. The task
/// owns its inputs (the raw JSON strings) so nothing is borrowed
/// across the thread boundary, and the substrate's
/// `BlockingHttpTransport` is created and used entirely on the
/// worker thread. This mirrors the existing off-main pattern used
/// by `bridge_backfill_embeddings` / `bridge_download_embedding_model`.
///
/// # Errors
///
/// Rejects on connector/config failure. Per-document fetch/ingest
/// issues are returned as non-fatal warnings inside the outcome.
#[napi(ts_return_type = "Promise<string>")]
// NAPI boundary: each parameter maps to a positional JS argument the
// renderer passes, so they cannot be collapsed into a struct without
// breaking the `bridgeConnectorsV2Sync` call contract.
#[allow(clippy::too_many_arguments)]
pub fn bridge_connectors_v2_sync(
    provider: String,
    auth_config_json: String,
    token_json: String,
    state_json: Option<String>,
    scope_id: Option<String>,
    fetch_content: Option<bool>,
    max_fetch: Option<u32>,
    pending_json: Option<String>,
) -> AsyncTask<ConnectorsV2SyncTask> {
    AsyncTask::new(ConnectorsV2SyncTask {
        provider,
        auth_config_json,
        token_json,
        state_json,
        scope_id,
        fetch_content,
        max_fetch,
        pending_json,
    })
}

/// [`napi::Task`] that runs a full v2 connector sync on a libuv
/// worker thread. All argument parsing, the blocking HTTP sync, and
/// outcome serialisation happen in [`Task::compute`] off the Node
/// main thread; only the resulting JSON string crosses back. The
/// task owns `String`/`Option<String>` inputs (all `Send`), so no
/// host state is borrowed across the thread boundary.
pub struct ConnectorsV2SyncTask {
    provider: String,
    auth_config_json: String,
    token_json: String,
    state_json: Option<String>,
    scope_id: Option<String>,
    fetch_content: Option<bool>,
    max_fetch: Option<u32>,
    pending_json: Option<String>,
}

impl Task for ConnectorsV2SyncTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output, NapiError> {
        let auth_config = parse_json("auth_config", &self.auth_config_json)?;
        let token: TokenWire = serde_json::from_str(&self.token_json)
            .map_err(|e| NapiError::from_reason(format!("invalid token JSON: {e}")))?;
        let state = match &self.state_json {
            Some(s) if !s.trim().is_empty() => Some(parse_json("state", s)?),
            _ => None,
        };

        let opts = SyncOptions {
            fetch_content: self.fetch_content.unwrap_or(true),
            max_fetch: self
                .max_fetch
                .map_or(SyncOptions::default().max_fetch, |m| m as usize),
        };

        // Deferred-fetch backlog from the previous run (document ids).
        // Absent / blank / `"null"` means an empty backlog.
        let pending: Vec<String> = match &self.pending_json {
            Some(s) if !s.trim().is_empty() && s.trim() != "null" => serde_json::from_str(s)
                .map_err(|e| NapiError::from_reason(format!("invalid pending JSON: {e}")))?,
            _ => Vec::new(),
        };

        let sink = NoopEvidenceSink;
        let outcome = connectors_v2::sync(
            &self.provider,
            auth_config,
            token,
            state,
            self.scope_id.as_deref(),
            &sink,
            opts,
            &pending,
        )
        .map_err(|e| to_napi(&e))?;

        serde_json::to_string(&outcome)
            .map_err(|e| NapiError::from_reason(format!("outcome serialize: {e}")))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue, NapiError> {
        Ok(output)
    }
}
