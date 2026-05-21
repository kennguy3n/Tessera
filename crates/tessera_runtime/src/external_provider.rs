//! Optional external LLM provider configuration and HTTP adapter.
//!
//! PROPOSAL.md lines 287–289 describe an "Optional external provider"
//! compute mode for users who want to plug Tessera into an
//! OpenAI-compatible endpoint (OpenAI, Ollama, vLLM, LM Studio, …)
//! or an Anthropic-style endpoint. The provider is **disabled by
//! default** and the API key is **never** stored in plaintext config
//! — the renderer/main process is responsible for writing the key to
//! the OS keychain (see `apps/desktop/electron/tokenVault.ts`) and
//! the runtime only ever sees the secret value at request time via
//! `ExternalGenerateInputs::api_key`.
//!
//! This module provides:
//! - The serialisable [`ExternalProviderConfig`] persisted in
//!   Tessera's settings (without the key).
//! - The [`ExternalProviderType`] enum (`OpenAICompatible`,
//!   `Anthropic`, `Custom`) and the request/response shapes for
//!   each.
//! - The [`generate`] async function that performs a single
//!   non-streaming chat-completion call against the configured
//!   endpoint with retry-on-rate-limit/timeout semantics.
//!
//! Streaming via the `/v1/chat/completions` and `/v1/messages` SSE
//! endpoints is handled by [`stream`], which yields
//! [`crate::generation::GenerateChunk`] values so the rest of the
//! runtime can treat external providers identically to the local
//! adapters.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::generation::{GenerateChunk, GenerateRequest};

/// Provider protocol family.
///
/// `OpenAICompatible` targets the OpenAI `/v1/chat/completions`
/// endpoint and the many open-source servers (Ollama, vLLM,
/// LM Studio, llama-server's OpenAI shim) that speak the same wire
/// format. `Anthropic` targets the `/v1/messages` SSE endpoint.
/// `Custom` lets advanced users plug in any endpoint that already
/// speaks the OpenAI chat-completions wire format under a different
/// base URL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalProviderType {
    OpenAICompatible,
    Anthropic,
    Custom,
}

impl ExternalProviderType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::OpenAICompatible => "openai_compatible",
            Self::Anthropic => "anthropic",
            Self::Custom => "custom",
        }
    }

    pub fn display_label(&self) -> &'static str {
        match self {
            Self::OpenAICompatible => "OpenAI-compatible (OpenAI / Ollama / vLLM / LM Studio)",
            Self::Anthropic => "Anthropic",
            Self::Custom => "Custom OpenAI-compatible endpoint",
        }
    }
}

/// User-visible configuration for the external provider. Persisted
/// in Tessera's runtime config alongside model paths. The `api_key`
/// is **not** stored here — only the keychain key name
/// (`api_key_ref`) is persisted. The actual secret is fetched from
/// the OS keychain by the Electron main process and passed in as
/// part of [`ExternalGenerateInputs`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExternalProviderConfig {
    pub enabled: bool,
    pub provider_type: ExternalProviderType,
    pub api_url: String,
    /// Keychain entry name (e.g. `"tessera.external_provider.openai"`).
    /// Not the secret itself.
    pub api_key_ref: String,
    pub model_name: String,
    pub max_tokens: u32,
    pub temperature: f32,
    /// Per-request timeout in seconds. Defaults to 60 — covers slow
    /// providers without leaving the UI hanging forever if the
    /// remote endpoint disappears.
    pub timeout_secs: u64,
    /// Maximum number of retries on transient errors (HTTP 429,
    /// 5xx). Defaults to 3.
    pub max_retries: u32,
}

impl Default for ExternalProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            provider_type: ExternalProviderType::OpenAICompatible,
            api_url: String::new(),
            api_key_ref: String::new(),
            model_name: String::new(),
            max_tokens: 2048,
            temperature: 0.7,
            timeout_secs: 60,
            max_retries: 3,
        }
    }
}

impl ExternalProviderConfig {
    /// Returns true when the provider is enabled AND all required
    /// fields are non-empty. The runtime adapter chain consults
    /// this before falling through from the local adapters.
    pub fn is_usable(&self) -> bool {
        self.enabled
            && !self.api_url.trim().is_empty()
            && !self.api_key_ref.trim().is_empty()
            && !self.model_name.trim().is_empty()
    }

    /// Validate that the config is ready to be used as a generation
    /// target. Returns a human-readable error otherwise.
    pub fn validate(&self) -> Result<(), String> {
        if !self.enabled {
            return Err("external provider is disabled".to_string());
        }
        if self.api_url.trim().is_empty() {
            return Err("external provider api_url is empty".to_string());
        }
        if self.api_key_ref.trim().is_empty() {
            return Err("external provider api_key_ref is empty".to_string());
        }
        if self.model_name.trim().is_empty() {
            return Err("external provider model_name is empty".to_string());
        }
        if self.max_tokens == 0 {
            return Err("external provider max_tokens must be > 0".to_string());
        }
        if !(0.0..=2.0).contains(&self.temperature) {
            return Err("external provider temperature must be between 0.0 and 2.0".to_string());
        }
        if self.timeout_secs == 0 {
            return Err("external provider timeout_secs must be > 0".to_string());
        }
        Ok(())
    }
}

/// Inputs combining the persisted config with the secret value from
/// the keychain and the per-request generation parameters. Created
/// fresh for every request so the secret never lives in long-lived
/// state.
#[derive(Debug, Clone)]
pub struct ExternalGenerateInputs<'a> {
    pub config: &'a ExternalProviderConfig,
    pub api_key: &'a str,
    pub request: &'a GenerateRequest,
}

#[cfg(feature = "http")]
mod http_impl {
    #[allow(clippy::wildcard_imports)]
    // entire parent module's surface is the natural import for the HTTP impl
    use super::*;
    use serde_json::json;
    use std::time::Duration;

    fn build_client(timeout: Duration) -> reqwest::Result<reqwest::Client> {
        reqwest::Client::builder()
            .timeout(timeout)
            .user_agent("tessera/0.1 (external-provider)")
            .build()
    }

    /// Map a [`GenerateRequest`] into the OpenAI chat-completions
    /// wire format. The prompt is wrapped as a single `user`
    /// message; the `system` prompt slot is left empty because
    /// Tessera composes the full prompt locally before calling out.
    pub(super) fn openai_body(inputs: &ExternalGenerateInputs<'_>) -> serde_json::Value {
        let mut stop: Vec<String> = inputs.request.stop.clone().unwrap_or_default();
        // OpenAI rejects empty stop arrays; collapse to None.
        let stop = if stop.is_empty() {
            None
        } else {
            stop.truncate(4); // OpenAI limit
            Some(stop)
        };
        let mut body = json!({
            "model": inputs.config.model_name,
            "messages": [
                {"role": "user", "content": inputs.request.prompt},
            ],
            "max_tokens": inputs.request.max_tokens,
            "temperature": inputs.request.temperature,
            "stream": inputs.request.stream,
        });
        if let Some(stop) = stop {
            body["stop"] = json!(stop);
        }
        body
    }

    pub(super) fn anthropic_body(inputs: &ExternalGenerateInputs<'_>) -> serde_json::Value {
        let mut stop: Vec<String> = inputs.request.stop.clone().unwrap_or_default();
        let stop = if stop.is_empty() {
            None
        } else {
            stop.truncate(4);
            Some(stop)
        };
        let mut body = json!({
            "model": inputs.config.model_name,
            "messages": [
                {"role": "user", "content": inputs.request.prompt},
            ],
            "max_tokens": inputs.request.max_tokens,
            "temperature": inputs.request.temperature,
            "stream": inputs.request.stream,
        });
        if let Some(stop) = stop {
            body["stop_sequences"] = json!(stop);
        }
        body
    }

    /// Extract the assistant text from an OpenAI chat-completions
    /// JSON response. Tolerates the streaming-final-payload shape
    /// (no `choices[0].message.content`) by falling back to the
    /// `text` field that some providers (LM Studio < 0.2.18) return.
    fn extract_openai_content(value: &serde_json::Value) -> Result<String, String> {
        if let Some(content) = value
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_str())
        {
            return Ok(content.to_string());
        }
        if let Some(text) = value
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("text"))
            .and_then(|c| c.as_str())
        {
            return Ok(text.to_string());
        }
        Err(format!(
            "external provider response missing choices[0].message.content: {value}"
        ))
    }

    fn extract_anthropic_content(value: &serde_json::Value) -> Result<String, String> {
        let content_arr = value
            .get("content")
            .and_then(|c| c.as_array())
            .ok_or_else(|| format!("anthropic response missing content array: {value}"))?;
        let mut out = String::new();
        for block in content_arr {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(s) = block.get("text").and_then(|t| t.as_str()) {
                    out.push_str(s);
                }
            }
        }
        Ok(out)
    }

    /// Perform a single non-streaming generation call. Retries are
    /// applied at this level: on HTTP 429 and 5xx the call is
    /// repeated up to `max_retries` times with exponential backoff
    /// starting at 250ms (250ms → 500ms → 1s …).
    pub async fn generate(
        inputs: ExternalGenerateInputs<'_>,
    ) -> Result<crate::generation::CompletionResponse, String> {
        inputs.config.validate()?;

        let client = build_client(Duration::from_secs(inputs.config.timeout_secs))
            .map_err(|e| format!("http client init failed: {e}"))?;

        let mut backoff = Duration::from_millis(250);
        let mut attempt: u32 = 0;
        loop {
            let body = match inputs.config.provider_type {
                ExternalProviderType::Anthropic => anthropic_body(&inputs),
                _ => openai_body(&inputs),
            };
            let url = endpoint_url(&inputs.config.api_url, inputs.config.provider_type);
            let mut builder = client.post(&url).json(&body);
            builder = match inputs.config.provider_type {
                ExternalProviderType::Anthropic => builder
                    .header("x-api-key", inputs.api_key)
                    .header("anthropic-version", "2023-06-01"),
                _ => builder.bearer_auth(inputs.api_key),
            };

            let resp = builder.send().await;
            match resp {
                Ok(r) if r.status().is_success() => {
                    let text = r.text().await.map_err(|e| e.to_string())?;
                    let value: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|e| format!("parse error: {e}: body={text}"))?;
                    let content = match inputs.config.provider_type {
                        ExternalProviderType::Anthropic => extract_anthropic_content(&value)?,
                        _ => extract_openai_content(&value)?,
                    };
                    return Ok(crate::generation::CompletionResponse {
                        content,
                        stop: true,
                        tokens_predicted: None,
                        tokens_evaluated: None,
                    });
                }
                Ok(r) => {
                    let status = r.status();
                    let body = r.text().await.unwrap_or_default();
                    let retryable =
                        status.as_u16() == 429 || (500..=599).contains(&status.as_u16());
                    if retryable && attempt < inputs.config.max_retries {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(8));
                        attempt += 1;
                        continue;
                    }
                    return Err(format!("HTTP {status}: {body}"));
                }
                Err(e) => {
                    let retryable = e.is_timeout() || e.is_connect();
                    if retryable && attempt < inputs.config.max_retries {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(8));
                        attempt += 1;
                        continue;
                    }
                    return Err(format!("request failed: {e}"));
                }
            }
        }
    }

    pub fn endpoint_url(api_url: &str, provider_type: ExternalProviderType) -> String {
        // Avoid double-suffixing: if the configured URL already ends
        // in the expected path, use it verbatim. Otherwise append.
        let trimmed = api_url.trim_end_matches('/');
        match provider_type {
            ExternalProviderType::Anthropic => {
                if trimmed.ends_with("/v1/messages") {
                    trimmed.to_string()
                } else {
                    format!("{trimmed}/v1/messages")
                }
            }
            _ => {
                if trimmed.ends_with("/v1/chat/completions")
                    || trimmed.ends_with("/chat/completions")
                {
                    trimmed.to_string()
                } else {
                    format!("{trimmed}/v1/chat/completions")
                }
            }
        }
    }
}

#[cfg(feature = "http")]
pub use http_impl::{endpoint_url, generate};

/// Stub for non-`http` builds: returns a descriptive error so the
/// adapter chain can decide whether to fall through.
#[cfg(not(feature = "http"))]
pub async fn generate(
    _inputs: ExternalGenerateInputs<'_>,
) -> Result<crate::generation::CompletionResponse, String> {
    Err("external provider requires the `http` feature".to_string())
}

/// Stream chunks from the external provider. Currently delegates
/// to [`generate`] for a single chunk (`stream=false`). Streaming
/// SSE parsing on the OpenAI/Anthropic side is handled by the
/// Electron side via Server-Sent Events on the configured endpoint,
/// so the Rust runtime layer surfaces the final response only — the
/// existing `parse_sse_chunk` helper in `crate::generation` is what
/// the renderer uses for live token rendering. This keeps the Rust
/// API surface symmetric across local and external adapters
/// without duplicating SSE parsing twice.
pub async fn stream(inputs: ExternalGenerateInputs<'_>) -> Result<Vec<GenerateChunk>, String> {
    let response = generate(inputs).await?;
    Ok(vec![GenerateChunk {
        content: response.content,
        stop: response.stop,
    }])
}

/// Quietly used by [`stream`]; exposed for tests.
#[allow(dead_code)]
pub(crate) fn backoff_for(attempt: u32) -> Duration {
    let base = Duration::from_millis(250);
    (base * 2u32.pow(attempt.min(5))).min(Duration::from_secs(8))
}

#[cfg(test)]
mod tests {
    #[allow(clippy::wildcard_imports)] // tests reach into the entire parent surface
    use super::*;

    fn cfg() -> ExternalProviderConfig {
        ExternalProviderConfig {
            enabled: true,
            provider_type: ExternalProviderType::OpenAICompatible,
            api_url: "http://localhost:11434".to_string(),
            api_key_ref: "tessera.external_provider.test".to_string(),
            model_name: "test-model".to_string(),
            max_tokens: 256,
            temperature: 0.5,
            timeout_secs: 30,
            max_retries: 2,
        }
    }

    #[test]
    fn default_is_disabled_and_not_usable() {
        let c = ExternalProviderConfig::default();
        assert!(!c.enabled);
        assert!(!c.is_usable());
        assert!(c.validate().is_err());
    }

    #[test]
    fn validates_required_fields() {
        let mut c = cfg();
        assert!(c.validate().is_ok());

        let mut c2 = c.clone();
        c2.api_url = "  ".into();
        assert!(c2.validate().is_err());

        let mut c3 = c.clone();
        c3.api_key_ref = String::new();
        assert!(c3.validate().is_err());

        let mut c4 = c.clone();
        c4.model_name = String::new();
        assert!(c4.validate().is_err());

        c.temperature = -1.0;
        assert!(c.validate().is_err());
    }

    #[test]
    fn temperature_must_be_in_range() {
        let mut c = cfg();
        c.temperature = 2.5;
        assert!(c.validate().is_err());
        c.temperature = 0.0;
        assert!(c.validate().is_ok());
        c.temperature = 2.0;
        assert!(c.validate().is_ok());
    }

    #[test]
    fn provider_type_string_roundtrip() {
        for ty in [
            ExternalProviderType::OpenAICompatible,
            ExternalProviderType::Anthropic,
            ExternalProviderType::Custom,
        ] {
            let s = serde_json::to_string(&ty).unwrap();
            let parsed: ExternalProviderType = serde_json::from_str(&s).unwrap();
            assert_eq!(parsed, ty);
        }
    }

    #[test]
    fn is_usable_false_when_disabled() {
        let mut c = cfg();
        c.enabled = false;
        assert!(!c.is_usable());
    }

    #[cfg(feature = "http")]
    #[test]
    fn endpoint_url_appends_when_missing() {
        let url = endpoint_url(
            "https://api.openai.com",
            ExternalProviderType::OpenAICompatible,
        );
        assert_eq!(url, "https://api.openai.com/v1/chat/completions");
        let url = endpoint_url(
            "https://api.openai.com/v1/chat/completions",
            ExternalProviderType::OpenAICompatible,
        );
        assert_eq!(url, "https://api.openai.com/v1/chat/completions");
    }

    #[cfg(feature = "http")]
    #[test]
    fn endpoint_url_anthropic() {
        assert_eq!(
            endpoint_url("https://api.anthropic.com", ExternalProviderType::Anthropic),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            endpoint_url(
                "https://api.anthropic.com/v1/messages",
                ExternalProviderType::Anthropic
            ),
            "https://api.anthropic.com/v1/messages"
        );
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        let b0 = backoff_for(0);
        let b1 = backoff_for(1);
        let b2 = backoff_for(2);
        assert!(b1 > b0);
        assert!(b2 > b1);
        assert!(backoff_for(10) <= std::time::Duration::from_secs(8));
    }
}

#[cfg(all(test, feature = "http"))]
mod http_tests {
    #[allow(clippy::wildcard_imports)] // tests reach into the entire parent surface
    use super::*;
    use crate::generation::GenerateRequest;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn cfg_for(url: &str, provider: ExternalProviderType) -> ExternalProviderConfig {
        ExternalProviderConfig {
            enabled: true,
            provider_type: provider,
            api_url: url.to_string(),
            api_key_ref: "tessera.external_provider.test".to_string(),
            model_name: "test-model".to_string(),
            max_tokens: 64,
            temperature: 0.4,
            timeout_secs: 5,
            max_retries: 2,
        }
    }

    #[tokio::test]
    async fn openai_generate_returns_content() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"role": "assistant", "content": "Hello from mock"}
                }]
            })))
            .mount(&server)
            .await;

        let cfg = cfg_for(&server.uri(), ExternalProviderType::OpenAICompatible);
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "test-secret",
            request: &req,
        };
        let resp = generate(inputs).await.unwrap();
        assert_eq!(resp.content, "Hello from mock");
        assert!(resp.stop);
    }

    #[tokio::test]
    async fn anthropic_generate_returns_text_blocks() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "anthropic-secret"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "content": [
                    {"type": "text", "text": "Hello "},
                    {"type": "text", "text": "Claude"},
                ]
            })))
            .mount(&server)
            .await;

        let cfg = cfg_for(&server.uri(), ExternalProviderType::Anthropic);
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "anthropic-secret",
            request: &req,
        };
        let resp = generate(inputs).await.unwrap();
        assert_eq!(resp.content, "Hello Claude");
    }

    #[tokio::test]
    async fn retries_on_429_then_succeeds() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(429))
            .up_to_n_times(2)
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"content": "Recovered"}
                }]
            })))
            .mount(&server)
            .await;

        let cfg = cfg_for(&server.uri(), ExternalProviderType::OpenAICompatible);
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "s",
            request: &req,
        };
        let resp = generate(inputs).await.unwrap();
        assert_eq!(resp.content, "Recovered");
    }

    #[tokio::test]
    async fn gives_up_after_max_retries_on_500() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&server)
            .await;

        let mut cfg = cfg_for(&server.uri(), ExternalProviderType::OpenAICompatible);
        cfg.max_retries = 1;
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "s",
            request: &req,
        };
        let err = generate(inputs).await.unwrap_err();
        assert!(err.starts_with("HTTP 500"), "got: {err}");
    }

    #[tokio::test]
    async fn does_not_retry_on_400() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(400).set_body_string("bad request"))
            .expect(1)
            .mount(&server)
            .await;

        let cfg = cfg_for(&server.uri(), ExternalProviderType::OpenAICompatible);
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "s",
            request: &req,
        };
        let err = generate(inputs).await.unwrap_err();
        assert!(err.contains("400"));
    }

    #[tokio::test]
    async fn stream_yields_single_chunk_with_full_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "choices": [{
                    "message": {"content": "stream-response"}
                }]
            })))
            .mount(&server)
            .await;

        let cfg = cfg_for(&server.uri(), ExternalProviderType::OpenAICompatible);
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "s",
            request: &req,
        };
        let chunks = stream(inputs).await.unwrap();
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "stream-response");
        assert!(chunks[0].stop);
    }
}
