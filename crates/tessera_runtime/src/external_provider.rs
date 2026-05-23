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
//! endpoints is handled by [`stream`], which parses Server-Sent
//! Events directly off the response body and invokes a caller-
//! supplied closure for each parsed token chunk. The same closure
//! contract works for tests (push into a Vec), for the N-API
//! bridge (forward to a `ThreadsafeFunction`), and for direct
//! consumers — the [`crate::generation::GenerateChunk`] payload is
//! shape-compatible with the local llama-server adapter so the rest
//! of the runtime can treat external providers identically.
//!
//! Two wire formats are supported:
//!
//!  * **OpenAI-compatible** (`provider_type: OpenAICompatible` or
//!    `Custom`) — `data: {"choices":[{"delta":{"content":"..."}}]}\n\n`
//!    framing with a final `data: [DONE]` sentinel. This is what
//!    OpenAI, Ollama (`/v1/chat/completions`), vLLM, LM Studio, and
//!    llama-server's OpenAI shim emit.
//!  * **Anthropic** (`provider_type: Anthropic`) — typed events
//!    (`event: content_block_delta\ndata: {"delta":{"text":"..."}}`,
//!    `event: message_stop`, …) per the Anthropic Messages API
//!    streaming spec.
//!
//! The parser handles partial UTF-8 across chunk boundaries (via
//! `bytes_stream` + a running byte buffer), multi-line `data:`
//! continuations per the SSE spec, and CRLF / LF line endings.

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

    /// Build a reqwest client with a full-request timeout for
    /// non-streaming use. Appropriate for `generate()` where the
    /// entire response body arrives in one shot — capping total
    /// wall-clock time is what we want.
    fn build_client(timeout: Duration) -> reqwest::Result<reqwest::Client> {
        reqwest::Client::builder()
            .timeout(timeout)
            .user_agent("tessera/0.1 (external-provider)")
            .build()
    }

    /// Build a reqwest client for the streaming `stream()` path.
    ///
    /// Critically, this uses `connect_timeout` (cap on the time spent
    /// establishing the TCP/TLS handshake) rather than `timeout`
    /// (cap on the *entire* request including the SSE body). The
    /// streaming response delivers tokens incrementally over the
    /// generation lifetime — for any non-trivial prompt this routinely
    /// exceeds the default `timeout_secs` (60s). If we used `.timeout`
    /// here, the timer would fire mid-stream and `bytes_stream().next()`
    /// would yield a transport error, silently truncating the
    /// generation and losing every subsequently-emitted token.
    ///
    /// Connection-establishment failures are still bounded by the
    /// same `timeout_secs` value, so the user still gets a fast
    /// failure if the provider endpoint is unreachable; only the
    /// streaming-body phase is uncapped. Wall-clock control over the
    /// in-progress stream is delegated to the caller's
    /// `AbortController` / `tokio::select!` cancellation surface,
    /// mirroring how the TypeScript adapter (`externalProviderStream.ts`)
    /// has always behaved — it uses no fetch timeout and relies on
    /// the caller's `AbortSignal`. The two adapters now agree on the
    /// timeout policy.
    fn build_streaming_client(connect_timeout: Duration) -> reqwest::Result<reqwest::Client> {
        reqwest::Client::builder()
            .connect_timeout(connect_timeout)
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
        let stop: Vec<String> = inputs.request.stop.clone().unwrap_or_default();
        // Anthropic's `stop_sequences` field has no documented hard
        // cap (unlike OpenAI's `stop` which rejects more than 4),
        // so we forward the caller's list verbatim. Anthropic still
        // rejects oversized requests at the API gateway, but the
        // ceiling is much higher than 4 — capping here would
        // silently drop legitimate user-supplied stop sequences.
        let stop = if stop.is_empty() { None } else { Some(stop) };
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

    /// Stream tokens from the external provider via Server-Sent
    /// Events. For each parsed delta the caller-supplied `emit`
    /// closure is invoked with a [`GenerateChunk`]; a final
    /// `GenerateChunk { content: "", stop: true }` is emitted once
    /// the upstream signals completion (`data: [DONE]` for
    /// OpenAI-compatible providers, `event: message_stop` for
    /// Anthropic) OR the connection terminates cleanly without a
    /// sentinel (which we treat as an implicit stop so the renderer
    /// never hangs).
    ///
    /// **Error handling.** Pre-stream errors (validation, client
    /// build, non-2xx status before the body opens) are returned as
    /// `Err(String)` and `emit` is never called. Once the stream
    /// opens, mid-stream transport errors propagate as `Err` AFTER
    /// any successfully-parsed chunks have already been emitted —
    /// the caller is expected to surface this to the UI and not
    /// retry (retrying mid-stream would duplicate tokens).
    ///
    /// **Body framing.** SSE per [WHATWG] is line-oriented with
    /// `\n`-terminated lines, optional CRLF, blank line as
    /// event-terminator, and `data:` lines concatenated with `\n`
    /// inside a single event payload. This parser implements that
    /// spec exactly. Unknown event names and unparseable JSON
    /// payloads are silently skipped (provider-side telemetry, ping
    /// events, etc.) rather than failing the whole stream.
    ///
    /// [WHATWG]: https://html.spec.whatwg.org/multipage/server-sent-events.html
    pub async fn stream<F>(inputs: ExternalGenerateInputs<'_>, mut emit: F) -> Result<(), String>
    where
        F: FnMut(GenerateChunk),
    {
        use futures_util::StreamExt;

        inputs.config.validate()?;

        // Critical: `build_streaming_client` caps `connect_timeout`
        // (TCP/TLS handshake duration) but does NOT cap the overall
        // request — long streams must be allowed to deliver tokens
        // for the full generation lifetime. Using `build_client`
        // here would arm reqwest's full-request `.timeout()` and
        // kill any stream that runs past `timeout_secs` (default
        // 60s), losing every subsequently-emitted token. See
        // `build_streaming_client` docstring for the full rationale
        // and the parity with the TypeScript streaming adapter.
        let client = build_streaming_client(Duration::from_secs(inputs.config.timeout_secs))
            .map_err(|e| format!("http client init failed: {e}"))?;

        let mut body = match inputs.config.provider_type {
            ExternalProviderType::Anthropic => anthropic_body(&inputs),
            _ => openai_body(&inputs),
        };
        // Force stream=true regardless of what the GenerateRequest carried —
        // calling stream() with stream=false in the body would just get a
        // non-SSE JSON response and the parser would dead-loop waiting for
        // a `data:` line that never arrives.
        body["stream"] = json!(true);

        let url = endpoint_url(&inputs.config.api_url, inputs.config.provider_type);
        let mut builder = client.post(&url).json(&body);
        builder = match inputs.config.provider_type {
            ExternalProviderType::Anthropic => builder
                .header("x-api-key", inputs.api_key)
                .header("anthropic-version", "2023-06-01")
                .header("accept", "text/event-stream"),
            _ => builder
                .bearer_auth(inputs.api_key)
                .header("accept", "text/event-stream"),
        };

        let resp = builder
            .send()
            .await
            .map_err(|e| format!("stream request failed: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {status}: {body}"));
        }

        // The byte stream is consumed line-by-line. We accumulate
        // bytes into a buffer; whenever we find a newline, we split
        // off a line, strip CR, and feed the SSE state machine. UTF-8
        // boundaries are respected by deferring the utf-8 decode
        // until a full line is in hand.
        let mut byte_stream = resp.bytes_stream();
        let mut byte_buf: Vec<u8> = Vec::new();
        let mut event_name: String = String::new();
        let mut event_data: String = String::new();
        let mut saw_stop_sentinel = false;

        while let Some(chunk_result) = byte_stream.next().await {
            let chunk = chunk_result.map_err(|e| format!("stream read failed: {e}"))?;
            byte_buf.extend_from_slice(&chunk);

            // Drain whole lines from the buffer. Each iteration of
            // the inner loop handles one line.
            while let Some(nl_idx) = byte_buf.iter().position(|&b| b == b'\n') {
                let line_bytes = byte_buf.drain(..=nl_idx).collect::<Vec<u8>>();
                // Strip trailing \n (always present) and \r (optional CRLF).
                let line_end = line_bytes.len().saturating_sub(
                    if line_bytes.len() >= 2 && line_bytes[line_bytes.len() - 2] == b'\r' {
                        2
                    } else {
                        1
                    },
                );
                let Ok(line) = std::str::from_utf8(&line_bytes[..line_end]) else {
                    continue; // skip lines that aren't valid utf-8 (shouldn't happen)
                };

                if line.is_empty() {
                    // Event terminator. Dispatch what we've accumulated.
                    if !event_data.is_empty()
                        && dispatch_sse_event(
                            &event_name,
                            &event_data,
                            inputs.config.provider_type,
                            &mut emit,
                        )
                    {
                        saw_stop_sentinel = true;
                    }
                    event_name.clear();
                    event_data.clear();
                    if saw_stop_sentinel {
                        break;
                    }
                    continue;
                }

                // SSE comment lines start with ':' — ignore them.
                if line.starts_with(':') {
                    continue;
                }

                if let Some(name) = line.strip_prefix("event:") {
                    event_name = name.trim_start().to_string();
                } else if let Some(data) = line.strip_prefix("data:") {
                    let data = data.strip_prefix(' ').unwrap_or(data);
                    if !event_data.is_empty() {
                        event_data.push('\n');
                    }
                    event_data.push_str(data);
                }
                // Other field names (id:, retry:) are intentionally
                // not handled — they don't affect token streaming.
            }

            if saw_stop_sentinel {
                break;
            }
        }

        // End-of-stream drain. Some providers (notably some
        // Anthropic reverse-proxies and older Ollama builds) close
        // the connection without flushing the spec-required `\n\n`
        // terminator after the last event — and a smaller set close
        // mid-line without even the trailing `\n`. Recover both
        // shapes so the consumer doesn't lose the final token.
        if !saw_stop_sentinel {
            // (a) Promote any unterminated trailing line in the byte
            // buffer into the event accumulators as if a newline
            // had arrived. Strip an optional CR for CRLF tolerance.
            if !byte_buf.is_empty() {
                let mut end = byte_buf.len();
                if end >= 1 && byte_buf[end - 1] == b'\r' {
                    end -= 1;
                }
                if let Ok(line) = std::str::from_utf8(&byte_buf[..end]) {
                    if !line.is_empty() && !line.starts_with(':') {
                        if let Some(name) = line.strip_prefix("event:") {
                            event_name = name.trim_start().to_string();
                        } else if let Some(data) = line.strip_prefix("data:") {
                            let data = data.strip_prefix(' ').unwrap_or(data);
                            if !event_data.is_empty() {
                                event_data.push('\n');
                            }
                            event_data.push_str(data);
                        }
                    }
                }
                byte_buf.clear();
            }

            // (b) Dispatch whatever event we accumulated.
            if !event_data.is_empty() {
                dispatch_sse_event(
                    &event_name,
                    &event_data,
                    inputs.config.provider_type,
                    &mut emit,
                );
            }
        }

        // Always emit a final stop chunk so consumers can rely on
        // exactly one stop signal regardless of upstream behaviour.
        emit(GenerateChunk {
            content: String::new(),
            stop: true,
        });

        Ok(())
    }

    /// Parse one assembled SSE event into a [`GenerateChunk`] and
    /// hand it to the caller's `emit` closure. Returns `true` if
    /// the event signals end-of-stream (so `stream` can break the
    /// outer read loop without waiting for the server to close).
    fn dispatch_sse_event<F: FnMut(GenerateChunk)>(
        event_name: &str,
        event_data: &str,
        provider: ExternalProviderType,
        emit: &mut F,
    ) -> bool {
        // OpenAI uses `data: [DONE]` regardless of `event:` field.
        if event_data.trim() == "[DONE]" {
            return true;
        }

        let parsed: serde_json::Value = match serde_json::from_str(event_data) {
            Ok(v) => v,
            // Unparseable data is provider noise (keep-alive ping
            // payloads, telemetry, …) — skip and keep streaming.
            Err(_) => return false,
        };

        match provider {
            ExternalProviderType::Anthropic => {
                // Anthropic SSE event taxonomy (subset relevant to
                // token streaming):
                //   message_start          — metadata, no content
                //   content_block_start    — empty text, no content
                //   content_block_delta    — delta.text is the token
                //   content_block_stop     — block boundary, no content
                //   message_delta          — stop_reason / usage
                //   message_stop           — end of stream
                //   ping                   — keep-alive, no content
                //
                // The `event:` field is authoritative; the `type`
                // field inside `data` echoes it but we trust the
                // header line.
                match event_name {
                    "content_block_delta" => {
                        if let Some(text) = parsed
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            if !text.is_empty() {
                                emit(GenerateChunk {
                                    content: text.to_string(),
                                    stop: false,
                                });
                            }
                        }
                        false
                    }
                    "message_stop" => true,
                    // message_start, content_block_start,
                    // content_block_stop, message_delta, ping,
                    // and any unknown future event: skip.
                    _ => false,
                }
            }
            ExternalProviderType::OpenAICompatible | ExternalProviderType::Custom => {
                // OpenAI chunked completion shape:
                //   { "choices": [{ "delta": { "content": "..." },
                //                   "finish_reason": null | "stop" }] }
                //
                // Many providers wrap the same shape — Ollama, vLLM,
                // LM Studio, llama-server's OpenAI shim all match.
                // We tolerate `delta.content` being absent (e.g.
                // first chunk often just sets `role: "assistant"`).
                let choice = parsed.get("choices").and_then(|c| c.get(0));
                if let Some(content) = choice
                    .and_then(|c| c.get("delta"))
                    .and_then(|d| d.get("content"))
                    .and_then(|c| c.as_str())
                {
                    if !content.is_empty() {
                        emit(GenerateChunk {
                            content: content.to_string(),
                            stop: false,
                        });
                    }
                }
                // Some providers signal completion via `finish_reason`
                // in the last chunk rather than (or in addition to)
                // `data: [DONE]`. We honour either signal.
                let finish_reason = choice
                    .and_then(|c| c.get("finish_reason"))
                    .and_then(|f| f.as_str());
                matches!(finish_reason, Some(reason) if !reason.is_empty())
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
pub use http_impl::{endpoint_url, generate, stream};

/// Stub for non-`http` builds: returns a descriptive error so the
/// adapter chain can decide whether to fall through.
#[cfg(not(feature = "http"))]
pub async fn generate(
    _inputs: ExternalGenerateInputs<'_>,
) -> Result<crate::generation::CompletionResponse, String> {
    Err("external provider requires the `http` feature".to_string())
}

/// Stub for non-`http` builds. The streaming surface mirrors the
/// [`http_impl::stream`] callback signature so consumers can keep a
/// single call site behind a feature flag.
#[cfg(not(feature = "http"))]
pub async fn stream<F>(_inputs: ExternalGenerateInputs<'_>, _emit: F) -> Result<(), String>
where
    F: FnMut(GenerateChunk),
{
    Err("external provider requires the `http` feature".to_string())
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

    /// Helper: drive `stream` against a wiremock server that
    /// already has an SSE-shaped response mounted. Returns the
    /// full sequence of chunks the emit closure observed.
    async fn collect_stream_chunks(
        server: &MockServer,
        provider: ExternalProviderType,
        api_key: &str,
    ) -> Result<Vec<GenerateChunk>, String> {
        let cfg = cfg_for(&server.uri(), provider);
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key,
            request: &req,
        };
        // `stream` runs the emit closure synchronously inline on the
        // single tokio task driving this test, so a plain `&mut Vec`
        // capture in an `FnMut` closure is enough — no Arc/Mutex
        // synchronization is required. Keeping this helper minimal
        // makes the test surface easier to reason about and avoids
        // implying (via the previous Arc<Mutex<...>> shape) that the
        // streaming adapter fans out the emit callback across
        // threads, which it does not.
        let mut chunks: Vec<GenerateChunk> = Vec::new();
        stream(inputs, |c| chunks.push(c)).await?;
        Ok(chunks)
    }

    /// Mount an SSE response. wiremock's `set_body_raw` ships the
    /// bytes verbatim; the Content-Type header makes reqwest accept
    /// the body without buffering it as JSON.
    fn sse_response(body: &str) -> ResponseTemplate {
        ResponseTemplate::new(200)
            .set_body_raw(body.as_bytes().to_vec(), "text/event-stream")
            .insert_header("cache-control", "no-cache")
    }

    #[tokio::test]
    async fn openai_stream_parses_delta_content_and_emits_stop() {
        let server = MockServer::start().await;
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\", \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"world!\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-secret"))
            .and(header("accept", "text/event-stream"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks = collect_stream_chunks(
            &server,
            ExternalProviderType::OpenAICompatible,
            "test-secret",
        )
        .await
        .unwrap();

        // The role-only chunk has no content, the finish-reason chunk
        // signals stop server-side but emits no content. The parser
        // emits three content chunks plus a final stop sentinel.
        let content_chunks: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.content.is_empty())
            .map(|c| c.content.as_str())
            .collect();
        assert_eq!(content_chunks, vec!["Hello", ", ", "world!"]);

        let stop = chunks.last().expect("at least one chunk");
        assert!(stop.stop, "final chunk should be stop=true");
        assert!(
            stop.content.is_empty(),
            "final chunk content should be empty"
        );
    }

    #[tokio::test]
    async fn anthropic_stream_parses_content_block_delta_and_emits_stop() {
        let server = MockServer::start().await;
        // Anthropic SSE event ordering per the Messages streaming
        // spec: message_start → content_block_start → N ×
        // content_block_delta → content_block_stop → message_delta
        // → message_stop.
        let sse = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\"}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n",
            "event: content_block_delta\n",
            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\" Claude\"}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
            "event: message_delta\n",
            "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "anthropic-secret"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks =
            collect_stream_chunks(&server, ExternalProviderType::Anthropic, "anthropic-secret")
                .await
                .unwrap();

        let content_chunks: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.content.is_empty())
            .map(|c| c.content.as_str())
            .collect();
        assert_eq!(content_chunks, vec!["Hello", " Claude"]);

        let stop = chunks.last().expect("at least one chunk");
        assert!(stop.stop);
    }

    #[tokio::test]
    async fn stream_handles_crlf_line_endings() {
        // Some reverse proxies (notably nginx) rewrite SSE \n to \r\n.
        // The parser must accept either.
        let server = MockServer::start().await;
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"crlf\"}}]}\r\n\r\n",
            "data: [DONE]\r\n\r\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks = collect_stream_chunks(&server, ExternalProviderType::OpenAICompatible, "s")
            .await
            .unwrap();
        let content: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.content.is_empty())
            .map(|c| c.content.as_str())
            .collect();
        assert_eq!(content, vec!["crlf"]);
    }

    #[tokio::test]
    async fn stream_skips_unparseable_data_and_comments() {
        // SSE comments start with ':' and must be ignored. Junk
        // `data:` payloads should also be skipped without aborting
        // the stream.
        let server = MockServer::start().await;
        let sse = concat!(
            ": keepalive\n\n",
            "data: not-json\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"survived\"}}]}\n\n",
            "data: [DONE]\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks = collect_stream_chunks(&server, ExternalProviderType::OpenAICompatible, "s")
            .await
            .unwrap();
        let content: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.content.is_empty())
            .map(|c| c.content.as_str())
            .collect();
        assert_eq!(content, vec!["survived"]);
    }

    #[tokio::test]
    async fn stream_propagates_pre_stream_http_error() {
        // 4xx before the body opens is returned as Err; emit is
        // never invoked.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("invalid api key"))
            .mount(&server)
            .await;

        let cfg = cfg_for(&server.uri(), ExternalProviderType::OpenAICompatible);
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "bad",
            request: &req,
        };
        let mut emit_count = 0u32;
        let err = stream(inputs, |_| {
            emit_count += 1;
        })
        .await
        .unwrap_err();

        assert!(err.contains("401"), "got: {err}");
        assert_eq!(
            emit_count, 0,
            "emit must not run when the pre-stream response is non-2xx"
        );
    }

    #[tokio::test]
    async fn stream_emits_final_stop_when_upstream_closes_without_done_sentinel() {
        // Server sends content but no terminator. The parser must
        // still emit a final stop chunk so the renderer doesn't hang.
        let server = MockServer::start().await;
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"orphan\"}}]}\n\n";
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks = collect_stream_chunks(&server, ExternalProviderType::OpenAICompatible, "s")
            .await
            .unwrap();
        let stop = chunks.last().expect("at least one chunk");
        assert!(
            stop.stop,
            "implicit stop must be emitted when upstream closes without [DONE]"
        );
    }

    #[tokio::test]
    async fn openai_stream_honours_finish_reason_without_done() {
        // Some providers (notably older Ollama, certain LM Studio
        // versions) only send finish_reason and close the connection,
        // skipping the `data: [DONE]` sentinel.
        let server = MockServer::start().await;
        let sse = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"final\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks = collect_stream_chunks(&server, ExternalProviderType::OpenAICompatible, "s")
            .await
            .unwrap();
        let content: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.content.is_empty())
            .map(|c| c.content.as_str())
            .collect();
        assert_eq!(content, vec!["final"]);
        assert!(chunks.last().unwrap().stop);
    }

    #[tokio::test]
    async fn anthropic_stream_ignores_ping_events() {
        // Anthropic emits periodic `event: ping` keep-alive frames
        // during long generations. They carry an empty JSON payload
        // and must not be treated as either content OR an error.
        let server = MockServer::start().await;
        let sse = concat!(
            "event: ping\n",
            "data: {\"type\":\"ping\"}\n\n",
            "event: content_block_delta\n",
            "data: {\"delta\":{\"text\":\"after-ping\"}}\n\n",
            "event: message_stop\n",
            "data: {}\n\n",
        );
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks =
            collect_stream_chunks(&server, ExternalProviderType::Anthropic, "anthropic-secret")
                .await
                .unwrap();
        let content: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.content.is_empty())
            .map(|c| c.content.as_str())
            .collect();
        assert_eq!(content, vec!["after-ping"]);
    }

    #[tokio::test]
    async fn anthropic_body_does_not_cap_stop_sequences_at_four() {
        // Anthropic's `stop_sequences` field has no documented hard
        // cap; the previous copy-paste-from-OpenAI behaviour would
        // silently drop legitimate user-supplied sequences past
        // index 3. This test guards against regressing.
        let cfg = cfg_for("https://example.invalid", ExternalProviderType::Anthropic);
        let req = GenerateRequest::new("hi".to_string()).with_stop(vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
            "e".to_string(),
            "f".to_string(),
            "g".to_string(),
        ]);
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "s",
            request: &req,
        };
        let body = http_impl::anthropic_body(&inputs);
        let stops = body
            .get("stop_sequences")
            .and_then(|v| v.as_array())
            .expect("stop_sequences must be present");
        assert_eq!(stops.len(), 7, "anthropic must accept >4 stop sequences");
    }

    #[tokio::test]
    async fn openai_body_caps_stop_sequences_at_four() {
        // OpenAI's `stop` field is documented to reject more than 4
        // entries with HTTP 400 — the truncation is required.
        let cfg = cfg_for(
            "https://example.invalid",
            ExternalProviderType::OpenAICompatible,
        );
        let req = GenerateRequest::new("hi".to_string()).with_stop(vec![
            "a".to_string(),
            "b".to_string(),
            "c".to_string(),
            "d".to_string(),
            "e".to_string(),
        ]);
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "s",
            request: &req,
        };
        let body = http_impl::openai_body(&inputs);
        let stops = body
            .get("stop")
            .and_then(|v| v.as_array())
            .expect("stop must be present");
        assert_eq!(stops.len(), 4, "openai must cap stop sequences at 4");
    }

    #[tokio::test]
    async fn stream_recovers_event_closed_without_any_trailing_newline() {
        // A hostile / misbehaving proxy closes the TCP connection
        // mid-line — no `\n` terminator at all, never mind the
        // spec-required `\n\n`. The Rust drain must still promote
        // the unterminated line into the final event so the
        // renderer doesn't lose the last token.
        let server = MockServer::start().await;
        let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"truncated\"}}]}";
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(sse_response(sse))
            .mount(&server)
            .await;

        let chunks = collect_stream_chunks(&server, ExternalProviderType::OpenAICompatible, "s")
            .await
            .unwrap();
        let content: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.content.is_empty())
            .map(|c| c.content.as_str())
            .collect();
        assert_eq!(
            content,
            vec!["truncated"],
            "final unterminated line must be drained on close"
        );
        assert!(chunks.last().unwrap().stop);
    }

    #[tokio::test]
    async fn stream_validates_config_before_hitting_network() {
        // A disabled provider must short-circuit at validate() and
        // never make a network call.
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(500))
            .expect(0)
            .mount(&server)
            .await;

        let mut cfg = cfg_for(&server.uri(), ExternalProviderType::OpenAICompatible);
        cfg.enabled = false;
        let req = GenerateRequest::new("hi".to_string());
        let inputs = ExternalGenerateInputs {
            config: &cfg,
            api_key: "s",
            request: &req,
        };
        let err = stream(inputs, |_| {}).await.unwrap_err();
        assert!(err.contains("disabled"), "got: {err}");
    }
}
