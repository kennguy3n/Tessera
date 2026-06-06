//! Image-generation client. Talks to a `sd-server` (stable-
//! diffusion.cpp) sidecar; the lifecycle of the binary is managed
//! by the Electron main process — see
//! `apps/desktop/electron/diffusionSidecar.ts`.
//!
//! ## Wire format
//!
//! `sd-server` exposes a `/txt2img` endpoint that accepts a JSON
//! body with `prompt`, `width`, `height`, `sample_steps`, optional
//! `cfg_scale`, and optional `seed`. The response is a JSON
//! envelope: `{ "images": [{ "data": "<base64-png>", "seed": N }] }`.
//! We decode the base64 PNG and return the raw bytes — the
//! Electron main process writes them to disk in
//! `<userData>/generated-images/<artifactId>/`.
//!
//! Reference: <https://github.com/leejet/stable-diffusion.cpp>
//! (sd-server section in the README, ./bin/sd-server --help)
//!
//! ## Why return `Vec<u8>` (PNG bytes) rather than a path
//!
//! The Rust runtime crate is filesystem-agnostic — only the
//! Electron main process knows the per-user data directory. The
//! N-API bridge gets `Vec<u8>` back, hands it to the main process,
//! and the main process writes to `generated-images/<id>.png`.
//! Keeping the runtime ignorant of paths makes the same crate
//! usable from a future TUI / web variant without leaking the
//! Electron-specific layout.

use serde::{Deserialize, Serialize};

#[cfg(feature = "http")]
use base64::Engine;

#[cfg(feature = "http")]
use std::sync::OnceLock;

/// Module-shared `reqwest::Client` for the diffusion sidecar.
/// Matches the pattern used by [`crate::vision`] — see that
/// module's `shared_http_client` JSDoc for the full rationale.
///
/// For diffusion specifically, the connection-pool overhead per
/// call is negligible compared to the 10-30 s generation latency,
/// so this is more about API consistency and reducing socket
/// churn than a measurable speed-up. The OnceLock construction is
/// also free in the no-imagegen / headless-CI case because it
/// lazily initialises on first use.
#[cfg(feature = "http")]
fn shared_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

/// Request to generate a single image. Defaults to FLUX.2-klein's
/// recommended settings (20 steps, CFG 3.5) so callers that just
/// want "make me an image of X" don't have to know diffusion
/// sampling internals.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenRequest {
    /// Text prompt describing the desired image.
    pub prompt: String,
    /// Output image width in pixels.
    pub width: u32,
    /// Output image height in pixels.
    pub height: u32,
    /// Number of diffusion sampling steps.
    pub steps: u32,
    /// Classifier-free guidance scale (prompt adherence).
    pub cfg_scale: f32,
    /// Optional negative prompt — concepts the model should
    /// actively avoid. Defaults to a generic quality-floor
    /// negative ("blurry, distorted, low quality") when None.
    pub negative_prompt: Option<String>,
    /// Optional seed. None means sd-server picks one and reports
    /// it back in the response, which is what we want for the
    /// default "give me variety" use case.
    pub seed: Option<u64>,
}

impl ImageGenRequest {
    /// Builds a request for `prompt` at the given dimensions with
    /// FLUX.2-klein defaults (20 steps, CFG 3.5).
    pub fn new(prompt: String, width: u32, height: u32) -> Self {
        Self {
            prompt,
            width,
            height,
            // FLUX.2-klein default: 20 steps is the recommended
            // sweet spot in the FLUX.2-klein model card; fewer
            // steps drop detail visibly, more steps don't improve
            // quality enough to justify the doubled latency.
            steps: 20,
            // FLUX.2-klein recommends CFG ~3.5 (FLUX models use a
            // lower CFG range than SD-XL because of how the model
            // was trained).
            cfg_scale: 3.5,
            negative_prompt: None,
            seed: None,
        }
    }

    /// Overrides the number of diffusion steps.
    pub fn with_steps(mut self, steps: u32) -> Self {
        self.steps = steps;
        self
    }

    /// Overrides the classifier-free guidance scale.
    pub fn with_cfg_scale(mut self, cfg_scale: f32) -> Self {
        self.cfg_scale = cfg_scale;
        self
    }

    /// Pins the RNG seed for reproducible output.
    pub fn with_seed(mut self, seed: u64) -> Self {
        self.seed = Some(seed);
        self
    }

    /// Sets a negative prompt of concepts to avoid.
    pub fn with_negative_prompt(mut self, prompt: String) -> Self {
        self.negative_prompt = Some(prompt);
        self
    }
}

/// Result of a single image generation. Carries the seed the
/// server actually used so the caller can persist it next to the
/// image for reproducibility ("make me one more in the same
/// style"). PNG bytes are owned; the caller writes them out.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageGenResponse {
    /// Generated image encoded as PNG bytes.
    pub png_bytes: Vec<u8>,
    /// Seed the server actually used (for reproducibility).
    pub seed: u64,
}

/// Errors raised when calling the sd-server sidecar. As with
/// `vision::VisionError`, the public API folds these into
/// `String` for the bridge; the structured variants exist so
/// callers in this crate can pattern-match on what went wrong
/// (HTTP vs. malformed base64 vs. missing image entry).
#[derive(thiserror::Error, Debug)]
pub enum ImageGenError {
    #[error("Image generation request failed: {0}")]
    /// The HTTP request to sd-server failed.
    Http(String),
    #[error("sd-server returned no image data")]
    /// sd-server responded without any image entry.
    MissingImage,
    #[error("sd-server returned malformed base64 image: {0}")]
    /// The returned image was not valid base64.
    Base64Decode(#[from] base64::DecodeError),
}

impl From<ImageGenError> for String {
    fn from(e: ImageGenError) -> Self {
        e.to_string()
    }
}

/// Build the JSON body for an sd-server `/txt2img` request. Pulled
/// out as a free function so the unit tests can pin the wire
/// shape without going through the HTTP client.
#[cfg(feature = "http")]
fn build_body(request: &ImageGenRequest) -> serde_json::Value {
    // sd-server's API: snake_case JSON; `sample_steps` (not
    // `n_predict`); `cfg_scale` (not `guidance`); `negative_prompt`
    // optional. Default negative prompt fills in a generic
    // quality-floor — callers can override.
    let negative = request
        .negative_prompt
        .clone()
        .unwrap_or_else(|| "blurry, distorted, low quality".to_string());

    let mut body = serde_json::json!({
        "prompt": request.prompt,
        "negative_prompt": negative,
        "width": request.width,
        "height": request.height,
        "sample_steps": request.steps,
        "cfg_scale": request.cfg_scale,
        // sd-server emits PNG by default; pin it explicitly so a
        // future server-side default change can't surprise us.
        "output_format": "png",
        // Number of images to return per call. Always 1 — the
        // diffusion sidecar is rate-limited to one in-flight
        // generation by the Electron main process (`imagegen:*`
        // IPC), so batching more here would just waste VRAM.
        "batch_count": 1,
    });

    if let Some(seed) = request.seed {
        body["seed"] = serde_json::Value::Number(seed.into());
    }

    body
}

/// Generate one image via the sd-server sidecar.
///
/// `endpoint` is the base URL (e.g. `http://127.0.0.1:8386`).
/// Returns the PNG bytes plus the seed sd-server reports it used.
///
/// This call blocks for the full diffusion latency — typically
/// 10-30 seconds for FLUX.2-klein at 1024×1024 on a consumer GPU.
/// The Electron main process must surface a cancel button to the
/// user; the cancel path uses Node's AbortController on the IPC
/// side, which severs the underlying connection.
#[cfg(feature = "http")]
pub async fn generate_image(
    endpoint: &str,
    request: &ImageGenRequest,
) -> std::result::Result<ImageGenResponse, String> {
    let body = build_body(request);
    let url = format!("{endpoint}/txt2img");

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

    let envelope: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let first_image = envelope
        .get("images")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .ok_or_else(|| ImageGenError::MissingImage.to_string())?;

    let data_b64 = first_image
        .get("data")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ImageGenError::MissingImage.to_string())?;

    let png_bytes = base64::engine::general_purpose::STANDARD
        .decode(data_b64.as_bytes())
        .map_err(|e| ImageGenError::Base64Decode(e).to_string())?;

    // sd-server reports the seed it used (whether caller-supplied
    // or server-chosen). Fall back to 0 if the field is missing —
    // we don't want to fail the whole call over a missing-seed
    // edge case, since the image bytes are the primary payload.
    let seed = first_image
        .get("seed")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);

    Ok(ImageGenResponse { png_bytes, seed })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imagegen_request_defaults_to_flux2_klein_settings() {
        let req = ImageGenRequest::new("a cat".into(), 1024, 1024);
        assert_eq!(req.prompt, "a cat");
        assert_eq!(req.width, 1024);
        assert_eq!(req.height, 1024);
        assert_eq!(req.steps, 20);
        assert!((req.cfg_scale - 3.5).abs() < f32::EPSILON);
        assert!(req.negative_prompt.is_none());
        assert!(req.seed.is_none());
    }

    #[test]
    fn imagegen_request_builder_threads_overrides() {
        let req = ImageGenRequest::new("p".into(), 512, 512)
            .with_steps(50)
            .with_cfg_scale(7.0)
            .with_seed(42)
            .with_negative_prompt("ugly".into());
        assert_eq!(req.steps, 50);
        assert!((req.cfg_scale - 7.0).abs() < f32::EPSILON);
        assert_eq!(req.seed, Some(42));
        assert_eq!(req.negative_prompt.as_deref(), Some("ugly"));
    }

    #[cfg(feature = "http")]
    #[test]
    fn shared_http_client_is_deduped_across_calls() {
        // Mirrors `vision::tests::shared_http_client_is_deduped_across_calls`
        // — pinning pointer identity here so a future refactor that
        // accidentally drops the OnceLock and falls back to per-call
        // `reqwest::Client::new()` fails loudly.
        let a = std::ptr::from_ref::<reqwest::Client>(shared_http_client());
        let b = std::ptr::from_ref::<reqwest::Client>(shared_http_client());
        assert_eq!(a, b, "shared_http_client must dedupe via OnceLock");
    }

    #[cfg(feature = "http")]
    #[test]
    fn build_body_uses_sd_server_field_names_and_defaults() {
        // Pinning the wire shape protects against an accidental
        // rename (e.g. `steps` vs `sample_steps`) that the
        // sd-server binary would silently reject.
        let req = ImageGenRequest::new("a cat".into(), 512, 768);
        let body = build_body(&req);
        assert_eq!(body["prompt"], serde_json::json!("a cat"));
        assert_eq!(body["width"], serde_json::json!(512));
        assert_eq!(body["height"], serde_json::json!(768));
        assert_eq!(body["sample_steps"], serde_json::json!(20));
        assert!((body["cfg_scale"].as_f64().unwrap() - 3.5).abs() < 1e-6);
        assert_eq!(body["output_format"], serde_json::json!("png"));
        assert_eq!(body["batch_count"], serde_json::json!(1));
        // Default quality-floor negative — keeps the worst FLUX
        // failure modes (blurry / smeared compositions) at bay
        // without forcing every caller to think about it.
        assert_eq!(
            body["negative_prompt"],
            serde_json::json!("blurry, distorted, low quality")
        );
        // Seed only emitted when caller asked for one. Otherwise
        // sd-server picks and reports it back in the response.
        assert!(body.get("seed").is_none());
    }

    #[cfg(feature = "http")]
    #[test]
    fn build_body_includes_seed_when_set() {
        let req = ImageGenRequest::new("p".into(), 512, 512).with_seed(7);
        let body = build_body(&req);
        assert_eq!(body["seed"], serde_json::json!(7));
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn generate_image_decodes_base64_png_and_seed_from_envelope() {
        let server = wiremock::MockServer::start().await;

        // Use a real PNG signature in the bytes so an integrity
        // check downstream (writing to disk + opening) would
        // succeed. Tests should exercise the real decode path —
        // a comically-short payload would mask a bug where the
        // decoder eats trailing whitespace.
        let png_bytes: &[u8] = b"\x89PNG\r\n\x1a\nFAKE_IDAT_PAYLOAD_FOR_TEST";
        let png_b64 = base64::engine::general_purpose::STANDARD.encode(png_bytes);

        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/txt2img"))
            .and(wiremock::matchers::body_partial_json(serde_json::json!({
                "prompt": "a cat",
                "width": 512,
                "height": 512,
                "sample_steps": 20,
                "output_format": "png"
            })))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "images": [{
                        "data": png_b64,
                        "seed": 1729
                    }]
                })),
            )
            .expect(1)
            .mount(&server)
            .await;

        let req = ImageGenRequest::new("a cat".into(), 512, 512);
        let resp = generate_image(&server.uri(), &req).await.unwrap();
        assert_eq!(resp.png_bytes, png_bytes);
        assert_eq!(resp.seed, 1729);
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn generate_image_surfaces_missing_image_when_envelope_empty() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/txt2img"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "images": [] })),
            )
            .mount(&server)
            .await;

        let req = ImageGenRequest::new("p".into(), 256, 256);
        let err = generate_image(&server.uri(), &req).await.unwrap_err();
        assert!(
            err.contains("no image data"),
            "must surface the empty-array case; got: {err}"
        );
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn generate_image_surfaces_malformed_base64() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/txt2img"))
            .respond_with(
                wiremock::ResponseTemplate::new(200).set_body_json(serde_json::json!({
                    "images": [{ "data": "not-valid-base64!!!!", "seed": 0 }]
                })),
            )
            .mount(&server)
            .await;

        let req = ImageGenRequest::new("p".into(), 256, 256);
        let err = generate_image(&server.uri(), &req).await.unwrap_err();
        assert!(
            err.contains("malformed base64"),
            "must surface decode failure; got: {err}"
        );
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn generate_image_surfaces_http_failure_with_status_and_body() {
        let server = wiremock::MockServer::start().await;
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/txt2img"))
            .respond_with(wiremock::ResponseTemplate::new(500).set_body_string("oom"))
            .mount(&server)
            .await;

        let req = ImageGenRequest::new("p".into(), 1024, 1024);
        let err = generate_image(&server.uri(), &req).await.unwrap_err();
        assert!(err.contains("500"));
        assert!(err.contains("oom"));
    }

    #[cfg(feature = "http")]
    #[tokio::test]
    async fn generate_image_falls_back_to_seed_zero_when_server_omits_seed() {
        // Forward-compatibility: a future sd-server that drops
        // the seed field must not blow up the whole call — the
        // PNG bytes are the primary payload, the seed is a "nice
        // to have for reproducibility" attribute.
        let server = wiremock::MockServer::start().await;
        let png_b64 = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nX");
        wiremock::Mock::given(wiremock::matchers::method("POST"))
            .and(wiremock::matchers::path("/txt2img"))
            .respond_with(
                wiremock::ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({ "images": [{ "data": png_b64 }] })),
            )
            .mount(&server)
            .await;

        let req = ImageGenRequest::new("p".into(), 128, 128);
        let resp = generate_image(&server.uri(), &req).await.unwrap();
        assert_eq!(resp.seed, 0);
    }
}
