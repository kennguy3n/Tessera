//! Vision-language-model inference client.
//!
//! Talks to a `llama-server` process that was started with the
//! `--mmproj <projector>` flag pointing at a multimodal projector
//! file (e.g. SmolVLM2 or Qwen3.5-VL). The Electron main process
//! manages that sidecar — see
//! `apps/desktop/electron/diffusionSidecar.ts` for the diffusion
//! counterpart and `apps/desktop/electron/sidecar.ts` (the
//! `extraArgs` field) for how the vision sidecar gets the
//! `--mmproj` flag.
//!
//! ## Wire format
//!
//! llama.cpp's server exposes a multimodal `/completion` endpoint
//! that accepts an `image_data` array of `{data, id}` records,
//! where `data` is base64-encoded image bytes and `id` is a
//! positive integer used inside the prompt with the `[img-N]`
//! token. The server substitutes those tokens with the vision
//! tower's image embeddings before running the language head.
//!
//! Reference:
//! <https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#post-completion-perform-text-completion-with-the-given-prompt>
//!
//! ## Error handling
//!
//! All errors are surfaced as `String` to match the existing
//! `generation::generate` signature — the N-API bridge wraps the
//! `Result<_, String>` into a JS exception with the same message.
//! This crate deliberately does not bring in `anyhow` / a richer
//! error type because the only consumers (the bridge and a future
//! Rust-side TUI) just need a printable failure reason.

use serde::{Deserialize, Serialize};

#[cfg(feature = "http")]
use base64::Engine;

#[cfg(feature = "http")]
use std::sync::OnceLock;

/// Module-shared `reqwest::Client` for the vision sidecar. A
/// single client owns the underlying connection pool so repeated
/// `vision_complete` calls during indexing — which can fire
/// 10-100 of these in close succession over the loopback to
/// `llama-server --mmproj` — reuse the TCP connection instead of
/// paying the handshake on every call.
///
/// The previous implementation constructed `reqwest::Client::new()`
/// per call, which silently created a fresh pool each time and
/// disabled keep-alive reuse entirely. For the diffusion sidecar
/// (10-30 s per call) the overhead was negligible; for vision
/// (sub-second per call during a batch indexing run) it measurably
/// inflated wall-clock time.
///
/// Constructed lazily on first use so a process that never invokes
/// the vision sidecar (e.g. headless CI, smoke tests) doesn't pay
/// the cost of standing up the client.
#[cfg(feature = "http")]
fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// A vision-completion request. The image is referenced by path so
/// the bridge can pass a local file straight through without
/// holding the bytes in JS heap; the Rust side reads + base64-
/// encodes the file before sending to the sidecar.
///
/// `prompt` is the textual instruction the user wants the VLM to
/// answer about the image (e.g. "Describe this whiteboard photo").
/// The wrapper prompts (`vision_describe`, `vision_ocr`,
/// `vision_describe_chart`) prepend the `[img-1]` placeholder so
/// the model knows where in the conversation the image should be
/// substituted. Hand-rolled prompts via `vision_complete` must
/// include `[img-1]` themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionRequest {
    /// Image path.
    pub image_path: String,
    /// Prompt.
    pub prompt: String,
    /// Max tokens.
    pub max_tokens: u32,
}

impl VisionRequest {
    /// Creates a new instance.
    pub fn new(image_path: String, prompt: String) -> Self {
        Self {
            image_path,
            prompt,
            max_tokens: 512,
        }
    }

    /// With max tokens.
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }
}

/// Response from a single non-streaming vision completion. Mirrors
/// `generation::CompletionResponse` so callers can treat vision
/// and text completions interchangeably for the purposes of
/// citation / chunk creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionResponse {
    /// Content.
    pub content: String,
    /// Stop.
    pub stop: bool,
    /// Tokens predicted.
    pub tokens_predicted: Option<u32>,
    /// Tokens evaluated.
    pub tokens_evaluated: Option<u32>,
}

/// Errors specific to the vision client. Network / HTTP / response
/// failures are folded into `String` because the public API uses
/// `Result<_, String>`. The fine-grained variants here are
/// internal — they exist so `image_to_base64` can fail loudly with
/// the actual `io::Error` rather than swallowing it.
#[derive(thiserror::Error, Debug)]
pub enum VisionError {
    #[error("Failed to read image file {path}: {source}")]
    /// Failed to read image file.
    ImageIo {
        /// Path.
        path: String,
        #[source]
        /// Source.
        source: std::io::Error,
    },
}

impl From<VisionError> for String {
    fn from(e: VisionError) -> Self {
        e.to_string()
    }
}

#[derive(Debug, Clone, Serialize)]
struct ImageData {
    /// base64-encoded raw image bytes (no `data:` URL prefix —
    /// llama.cpp's server parses raw base64).
    data: String,
    /// Image slot id referenced from the prompt as `[img-1]`. We
    /// only ever pass a single image, so this is always 1.
    id: u32,
}

#[derive(Debug, Clone, Serialize)]
struct LlamaVisionBody {
    prompt: String,
    n_predict: u32,
    temperature: f64,
    stream: bool,
    image_data: Vec<ImageData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

/// Read a file from disk and return its base64 encoding (standard
/// alphabet, no padding stripped). The output is suitable for
/// embedding directly into a `LlamaVisionBody.image_data[*].data`
/// field — llama.cpp's server accepts the canonical base64
/// alphabet including padding.
#[cfg(feature = "http")]
fn image_to_base64(image_path: &str) -> Result<String, VisionError> {
    let bytes = std::fs::read(image_path).map_err(|source| VisionError::ImageIo {
        path: image_path.to_string(),
        source,
    })?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Build the JSON body for a vision completion. Public so a future
/// stateful client (e.g. the OCR rate-limiter) can construct the
/// body and reuse the same `reqwest::Client` instead of going
/// through `vision_complete` per call.
#[cfg(feature = "http")]
fn build_body(request: &VisionRequest, image_base64: String) -> LlamaVisionBody {
    LlamaVisionBody {
        // Caller-supplied prompts must already contain the
        // `[img-1]` placeholder; the convenience wrappers prepend
        // it for the caller. Don't auto-prepend here — that would
        // hide the placeholder requirement and surprise direct
        // `vision_complete` users.
        prompt: request.prompt.clone(),
        n_predict: request.max_tokens,
        // Temperature 0 is the right default for OCR / chart
        // description / image description — deterministic output
        // matters more than creativity, and downstream consumers
        // (search index, citations) treat the description as
        // ground-truth source text. Callers who want sampling can
        // construct the body themselves.
        temperature: 0.0,
        stream: false,
        image_data: vec![ImageData {
            data: image_base64,
            id: 1,
        }],
        stop: None,
    }
}

/// Send a vision completion to a running llama-server (`--mmproj`)
/// sidecar. Reads the image from disk, base64-encodes it, and
/// posts a single-shot non-streaming `/completion` request.
///
/// The `endpoint` is the base URL of the sidecar (e.g.
/// `http://127.0.0.1:8385`). The convenience wrappers
/// (`vision_describe`, `vision_ocr`, `vision_describe_chart`)
/// are preferred for the common cases — they bake the right
/// prompt template into the request and ensure `[img-1]` is
/// present.
#[cfg(feature = "http")]
pub async fn vision_complete(
    endpoint: &str,
    request: &VisionRequest,
) -> std::result::Result<VisionResponse, String> {
    let image_base64 = image_to_base64(&request.image_path).map_err(String::from)?;
    let body = build_body(request, image_base64);
    let url = format!("{endpoint}/completion");

    let resp = shared_http_client()
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("Parse error: {e}"))
}

/// Convenience wrapper: free-form natural-language description of
/// what's in the image. Used by the indexing pipeline (Block C
/// Task 9) to attach a searchable description to every image
/// source.
#[cfg(feature = "http")]
pub async fn vision_describe(
    endpoint: &str,
    image_path: &str,
    max_tokens: u32,
) -> std::result::Result<VisionResponse, String> {
    let req = VisionRequest::new(
        image_path.to_string(),
        String::from(
            "[img-1]Describe this image in detail. Include any visible \
             text, people, objects, scenes, and notable visual elements. \
             Write in clear, complete sentences suitable for a \
             searchable knowledge base.",
        ),
    )
    .with_max_tokens(max_tokens);
    vision_complete(endpoint, &req).await
}

/// Convenience wrapper: OCR-optimized prompt. Asks the VLM to
/// transcribe every visible character verbatim, preserving line
/// breaks. Used by Block C Task 10 for scanned-PDF pages and by
/// Block E Task 16 for whiteboard photos.
#[cfg(feature = "http")]
pub async fn vision_ocr(
    endpoint: &str,
    image_path: &str,
    max_tokens: u32,
) -> std::result::Result<VisionResponse, String> {
    let req = VisionRequest::new(
        image_path.to_string(),
        String::from(
            "[img-1]Transcribe every piece of visible text in this image \
             verbatim. Preserve line breaks and spatial layout using \
             markdown where useful (lists, headings, tables). Do not \
             paraphrase, summarize, or add commentary — only output the \
             text you see.",
        ),
    )
    .with_max_tokens(max_tokens);
    vision_complete(endpoint, &req).await
}

/// Convenience wrapper: chart / diagram description prompt. Asks
/// the VLM for a structured summary of a chart so the search index
/// can match queries like "Q2 revenue 2024" against the chart's
/// data. Block C Task 11.
#[cfg(feature = "http")]
pub async fn vision_describe_chart(
    endpoint: &str,
    image_path: &str,
    max_tokens: u32,
) -> std::result::Result<VisionResponse, String> {
    let req = VisionRequest::new(
        image_path.to_string(),
        String::from(
            "[img-1]Describe this chart. Include: chart type (bar, line, \
             pie, scatter, etc.), axes and their units, the most \
             important data points, trends or patterns, and the \
             conclusion the chart appears to support. Be specific with \
             numbers when they are readable.",
        ),
    )
    .with_max_tokens(max_tokens);
    vision_complete(endpoint, &req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vision_request_builder_sets_defaults_and_overrides() {
        let req = VisionRequest::new("/x/img.png".into(), "describe".into());
        assert_eq!(req.image_path, "/x/img.png");
        assert_eq!(req.prompt, "describe");
        assert_eq!(req.max_tokens, 512);

        let req2 = req.with_max_tokens(2048);
        assert_eq!(req2.max_tokens, 2048);
    }

    #[cfg(feature = "http")]
    #[test]
    fn image_to_base64_round_trips_via_decode() {
        // Real round-trip — write known bytes, read back, decode,
        // compare. The point of the helper is that the on-disk
        // bytes survive base64 encoding intact, so we verify that
        // end-to-end rather than mock-comparing strings.
        let tmp = tempfile::Builder::new().suffix(".png").tempfile().unwrap();
        let bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR-test";
        std::fs::write(tmp.path(), bytes).unwrap();

        let encoded = image_to_base64(tmp.path().to_str().unwrap()).unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[cfg(feature = "http")]
    #[test]
    fn image_to_base64_surfaces_io_errors_with_path() {
        // The error must carry the path the caller asked for so a
        // log/PR review can tell which file blew up without
        // grepping the sidecar logs.
        let err = image_to_base64("/this/path/does/not/exist.png").unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("/this/path/does/not/exist.png"),
            "error message must include offending path; got: {msg}"
        );
    }

    #[cfg(feature = "http")]
    #[test]
    fn shared_http_client_is_deduped_across_calls() {
        // Calling `shared_http_client()` repeatedly must return the
        // same underlying client (i.e. the OnceLock dedupes). If a
        // future refactor accidentally replaces this with
        // `reqwest::Client::new()` per call, the connection-pool
        // reuse promise from the doc comment is silently broken;
        // pinning pointer identity here catches that regression.
        let a = std::ptr::from_ref::<reqwest::Client>(shared_http_client());
        let b = std::ptr::from_ref::<reqwest::Client>(shared_http_client());
        assert_eq!(a, b, "shared_http_client must dedupe via OnceLock");
    }

    #[cfg(feature = "http")]
    #[test]
    fn build_body_uses_caller_prompt_and_image_slot_one() {
        let req = VisionRequest::new("/dev/null".into(), "[img-1]hi".into());
        let body = build_body(&req, "AAAA".into());
        assert_eq!(body.prompt, "[img-1]hi");
        assert_eq!(body.n_predict, 512);
        assert_eq!(body.image_data.len(), 1);
        assert_eq!(body.image_data[0].id, 1);
        assert_eq!(body.image_data[0].data, "AAAA");
        // Deterministic output for index / OCR.
        assert!(body.temperature.abs() < f64::EPSILON);
        assert!(!body.stream);
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn vision_complete_posts_base64_image_data_and_parses_response() {
        // Wiremock pretends to be llama-server. Verifies the wire
        // shape end-to-end: image is read from disk, base64-
        // encoded, embedded in `image_data[0].data`, posted to
        // `/completion`, and the JSON response is parsed into
        // VisionResponse.
        let server = wiremock::MockServer::start().await;

        // Test image: write known bytes, compute expected base64
        // out-of-band so the assertion catches even a one-byte
        // encoding regression.
        let tmp = tempfile::Builder::new().suffix(".png").tempfile().unwrap();
        let bytes: &[u8] = b"hello-world";
        std::fs::write(tmp.path(), bytes).unwrap();
        let expected_b64 = base64::engine::general_purpose::STANDARD.encode(bytes);

        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/completion"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "image_data": [{ "data": expected_b64, "id": 1 }]
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "content": "A grey cat sits on a yellow chair.",
                    "stop": true,
                    "tokens_predicted": 11,
                    "tokens_evaluated": 14
                })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let req = VisionRequest::new(
            tmp.path().to_str().unwrap().to_string(),
            "[img-1]Describe this image.".into(),
        );
        let resp = vision_complete(&server.uri(), &req).await.unwrap();
        assert_eq!(resp.content, "A grey cat sits on a yellow chair.");
        assert!(resp.stop);
        assert_eq!(resp.tokens_predicted, Some(11));
        assert_eq!(resp.tokens_evaluated, Some(14));
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn vision_complete_surfaces_http_error_with_status_and_body() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/completion"))
            .respond_with(wiremock::ResponseTemplate::new(503).set_body_string("overloaded"))
            .mount(&server)
            .await;

        let tmp = tempfile::Builder::new().tempfile().unwrap();
        std::fs::write(tmp.path(), b"x").unwrap();
        let req = VisionRequest::new(tmp.path().to_str().unwrap().to_string(), "[img-1]q".into());
        let err = vision_complete(&server.uri(), &req).await.unwrap_err();
        assert!(err.contains("503"), "error must include status; got: {err}");
        assert!(
            err.contains("overloaded"),
            "error must include body; got: {err}"
        );
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn vision_describe_prefixes_img_placeholder_and_uses_describe_prompt() {
        // The convenience wrapper must auto-include `[img-1]` —
        // forgetting it would silently produce a text-only
        // completion (the model never sees the image) and the
        // search index would be populated with hallucinated
        // descriptions. This test pins the contract.
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/completion"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "prompt": "[img-1]Describe this image in detail. Include any visible \
                          text, people, objects, scenes, and notable visual elements. \
                          Write in clear, complete sentences suitable for a \
                          searchable knowledge base."
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "content": "ok",
                    "stop": true,
                    "tokens_predicted": 1,
                    "tokens_evaluated": 1
                })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::Builder::new().tempfile().unwrap();
        std::fs::write(tmp.path(), b"img").unwrap();
        vision_describe(&server.uri(), tmp.path().to_str().unwrap(), 32)
            .await
            .unwrap();
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn vision_ocr_uses_verbatim_transcription_prompt() {
        // OCR prompt must forbid paraphrasing — pin the substring
        // so future "tone" tweaks don't accidentally turn the OCR
        // into a summary.
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/completion"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "prompt": "[img-1]Transcribe every piece of visible text in this image \
                          verbatim. Preserve line breaks and spatial layout using \
                          markdown where useful (lists, headings, tables). Do not \
                          paraphrase, summarize, or add commentary — only output the \
                          text you see."
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "content": "verbatim text",
                    "stop": true,
                    "tokens_predicted": 1,
                    "tokens_evaluated": 1
                })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::Builder::new().tempfile().unwrap();
        std::fs::write(tmp.path(), b"img").unwrap();
        vision_ocr(&server.uri(), tmp.path().to_str().unwrap(), 32)
            .await
            .unwrap();
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn vision_describe_chart_uses_structured_chart_prompt() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/completion"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "prompt": "[img-1]Describe this chart. Include: chart type (bar, line, \
                          pie, scatter, etc.), axes and their units, the most \
                          important data points, trends or patterns, and the \
                          conclusion the chart appears to support. Be specific with \
                          numbers when they are readable."
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "content": "bar chart",
                    "stop": true,
                    "tokens_predicted": 1,
                    "tokens_evaluated": 1
                })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let tmp = tempfile::Builder::new().tempfile().unwrap();
        std::fs::write(tmp.path(), b"img").unwrap();
        vision_describe_chart(&server.uri(), tmp.path().to_str().unwrap(), 32)
            .await
            .unwrap();
    }
}
