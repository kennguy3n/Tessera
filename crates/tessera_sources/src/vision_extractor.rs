//! Vision-powered extraction hooks for source indexing.
//!
//! Adds a separate "describe the image with a VLM" path alongside the
//! existing native `extract_image_metadata` extractor. The two are
//! complementary:
//!
//!   * `extract_image_metadata` (in [`crate::image_metadata`]) emits a
//!     line-oriented key/value summary (format, dimensions, EXIF
//!     fields, GPS, camera body) that is always cheap and never
//!     touches a model. This runs unconditionally for every supported
//!     image.
//!
//!   * `VisionExtractor::describe_image` (this module) emits the
//!     VLM's natural-language description of the image contents
//!     (e.g. "A whiteboard with a hand-drawn flowchart showing the
//!     user signup pipeline; nodes labelled 'lead form',
//!     'verification email', and 'first login'."). This call costs a
//!     few seconds of VLM time and requires a vision model to be
//!     installed — so it is gated by `is_available()` at the
//!     [`crate::indexer::Indexer`] level and skipped when absent.
//!
//! The two outputs are stored as **separate** chunks on the same
//! `indexed_files` row:
//!
//!   - The metadata chunk carries `extraction_method = None`
//!     ("native, no model").
//!   - The VLM chunk carries
//!     `extraction_method = Some(ExtractionMethod::Vlm)` and the
//!     `extraction_model_id = Some(<manifest id>)` provenance so a
//!     future model swap can `DELETE` and re-extract just the
//!     VLM-derived rows without touching the metadata rows.
//!
//! The trait is deliberately object-safe (no associated types, no
//! generics) so the [`crate::indexer::Indexer`] can hold an
//! `Arc<dyn VisionExtractor>` and the runtime wiring (which calls
//! `tessera_runtime::vision::vision_describe` through the bridge)
//! can be swapped for a test fixture without touching indexer code.

use std::path::Path;

use tessera_core::error::{Error, Result};

use crate::chunker::{Chunk, ExtractionMethod};
use crate::image_metadata::is_image_extension;

/// Trait implemented by the bridge layer (production) and by test
/// fixtures (`#[cfg(test)]`) to supply VLM descriptions for image
/// files. Object-safe by construction.
pub trait VisionExtractor: Send + Sync {
    /// Generate a natural-language description for the image at
    /// `image_path`. Returns `Ok(text)` on success.
    ///
    /// Implementations MUST be synchronous — the indexer drives
    /// extraction on a single worker thread per source today, and
    /// the bridge layer is expected to wrap the underlying async
    /// `vision_describe` call (which itself drives a libuv
    /// AsyncTask) with a blocking handle. This keeps the indexer's
    /// extraction loop simple and lets the IPC layer own all
    /// async-runtime concerns.
    fn describe_image(&self, image_path: &Path) -> Result<String>;

    /// Generate a structured chart / figure description for the
    /// image at `image_path`. Used by the chart-extraction pass in
    /// [`crate::pdf_extractor::vlm_chart_chunks_for_pdf`] to surface
    /// embedded charts as searchable chunks tagged with
    /// `extraction_method = Some(ExtractionMethod::VlmChart)`.
    ///
    /// Implementations are expected to drive the VLM with a
    /// structured prompt of the shape
    /// "Describe this chart. Include: chart type, axes, key data
    /// points, trends, and conclusions." so the output is
    /// information-dense enough to be useful as a chunk on its own
    /// (without the user re-opening the original PDF).
    ///
    /// The default implementation delegates to [`Self::describe_image`].
    /// This keeps existing test fixtures and the [`NullVisionExtractor`]
    /// fallback working, and lets the bridge layer override with the
    /// chart-mode prompt (`VisionMode::Chart` in
    /// `tessera_bridge`) by implementing this method directly.
    fn describe_chart(&self, image_path: &Path) -> Result<String> {
        self.describe_image(image_path)
    }

    /// Generate plain-text OCR output for the image at `image_path`.
    /// Used by the PDF OCR pass in
    /// [`crate::pdf_extractor::vlm_ocr_chunks_for_pdf`] to surface
    /// scanned-page text as searchable chunks tagged with
    /// `extraction_method = Some(ExtractionMethod::VlmOcr)`.
    ///
    /// Implementations are expected to drive the VLM with an
    /// OCR-flavoured prompt of the shape "Transcribe every visible
    /// character on this image. Preserve line breaks. Do not
    /// describe the image; output the text only." so the output is
    /// usable as a citation-quality transcription rather than a
    /// free-form description.
    ///
    /// The default implementation delegates to [`Self::describe_image`].
    /// This keeps existing test fixtures and the [`NullVisionExtractor`]
    /// fallback working, and lets the bridge layer override with the
    /// OCR-mode prompt (`VisionMode::Ocr` in `tessera_bridge`) by
    /// implementing this method directly. Mirrors the
    /// [`Self::describe_chart`] pattern so the trait API stays
    /// symmetric across the three VLM modes Block B exposes.
    fn ocr_text(&self, image_path: &Path) -> Result<String> {
        self.describe_image(image_path)
    }

    /// Identifier of the underlying model emitting these
    /// descriptions, used for the `extraction_model_id` column on
    /// chunks. Typically the manifest entry id (e.g.
    /// `"qwen3.5-4b-vision-gguf"`); the bridge populates this from
    /// the active vision slot's installed-model record at startup.
    fn model_id(&self) -> &str;
}

/// True when `ext` (case-insensitive, no leading dot) is an image
/// extension the indexer should attempt to VLM-describe. Identical
/// to the metadata-extractor's supported set so the two pipelines
/// stay in lockstep — adding a new image extension is a single
/// edit in `image_metadata::is_image_extension`.
#[must_use]
pub fn is_vision_extension(ext: &str) -> bool {
    is_image_extension(ext)
}

/// Produce the VLM-extracted chunks for a single image file. Returns
/// a single-chunk `Vec<Chunk>` on success and an empty `Vec` when
/// the extractor declines (e.g. unsupported extension, empty
/// description). Errors propagate so the indexer can decide whether
/// to count them in the pass-wide error counter without skipping
/// the metadata chunk that was already inserted.
///
/// The returned chunk's `source_path` matches the file path so the
/// VLM chunk co-locates with the metadata chunk on the same
/// `indexed_file` row, and its `chunk_index` is offset by
/// `metadata_chunk_count` (the number of metadata chunks the
/// caller has already produced for this file) so chunk_index stays
/// monotonic.
pub fn vlm_chunks_for_image(
    extractor: &dyn VisionExtractor,
    image_path: &Path,
    metadata_chunk_count: usize,
) -> Result<Vec<Chunk>> {
    let ext = image_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if !is_vision_extension(&ext) {
        return Ok(Vec::new());
    }

    let description = extractor.describe_image(image_path)?;
    let trimmed = description.trim();
    if trimmed.is_empty() {
        // Producing an empty chunk would pollute FTS with zero-
        // length rows and rank low for legitimate queries. Drop it.
        return Ok(Vec::new());
    }

    let path_str = image_path.to_string_lossy().to_string();
    let hash = blake3::hash(trimmed.as_bytes()).to_hex().to_string();

    Ok(vec![Chunk {
        source_path: path_str,
        chunk_index: metadata_chunk_count,
        byte_offset: 0,
        content: trimmed.to_string(),
        hash,
        extraction_method: Some(ExtractionMethod::Vlm),
        extraction_model_id: Some(extractor.model_id().to_string()),
    }])
}

/// Convenience extractor for tests / `cargo test` and for the
/// "VLM not available" fallback in production (the indexer never
/// invokes the trait in that case; this struct exists primarily so
/// tests can build an `Arc<dyn VisionExtractor>` without spinning
/// up a sidecar).
#[derive(Debug)]
pub struct NullVisionExtractor;

impl VisionExtractor for NullVisionExtractor {
    fn describe_image(&self, _image_path: &Path) -> Result<String> {
        Err(Error::Extraction {
            path: "<null-vision-extractor>".to_string(),
            message: "vision extractor is the null implementation; no VLM is available".to_string(),
        })
    }

    fn model_id(&self) -> &'static str {
        "null-vision-extractor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Canned extractor that returns a fixed description so the
    /// `vlm_chunks_for_image` plumbing can be tested without a
    /// live VLM.
    struct StubExtractor {
        description: String,
        model: String,
    }

    impl VisionExtractor for StubExtractor {
        fn describe_image(&self, _image_path: &Path) -> Result<String> {
            Ok(self.description.clone())
        }
        fn model_id(&self) -> &str {
            &self.model
        }
    }

    #[test]
    fn vlm_chunks_for_image_emits_a_single_provenance_tagged_chunk() {
        let stub = StubExtractor {
            description: "A whiteboard with a flowchart.".to_string(),
            model: "qwen3.5-4b-vision-gguf".to_string(),
        };
        let path = PathBuf::from("/tmp/whiteboard.png");
        let chunks = vlm_chunks_for_image(&stub, &path, 1).unwrap();
        assert_eq!(chunks.len(), 1);
        let c = &chunks[0];
        assert_eq!(c.source_path, "/tmp/whiteboard.png");
        assert_eq!(c.chunk_index, 1);
        assert_eq!(c.byte_offset, 0);
        assert_eq!(c.content, "A whiteboard with a flowchart.");
        assert_eq!(c.extraction_method, Some(ExtractionMethod::Vlm));
        assert_eq!(
            c.extraction_model_id.as_deref(),
            Some("qwen3.5-4b-vision-gguf")
        );
    }

    #[test]
    fn vlm_chunks_for_image_returns_empty_for_non_image_extensions() {
        let stub = StubExtractor {
            description: "irrelevant".to_string(),
            model: "m".to_string(),
        };
        let path = PathBuf::from("/tmp/doc.txt");
        let chunks = vlm_chunks_for_image(&stub, &path, 0).unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn vlm_chunks_for_image_drops_empty_descriptions() {
        let stub = StubExtractor {
            description: "   \t  \n".to_string(),
            model: "m".to_string(),
        };
        let path = PathBuf::from("/tmp/photo.jpg");
        let chunks = vlm_chunks_for_image(&stub, &path, 0).unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn vlm_chunks_for_image_propagates_extractor_errors() {
        struct Erroring;
        impl VisionExtractor for Erroring {
            fn describe_image(&self, _: &Path) -> Result<String> {
                Err(Error::Extraction {
                    path: "/p".to_string(),
                    message: "sidecar dead".to_string(),
                })
            }
            fn model_id(&self) -> &'static str {
                "x"
            }
        }
        let path = PathBuf::from("/tmp/photo.jpg");
        let err = vlm_chunks_for_image(&Erroring, &path, 0).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("sidecar dead"), "unexpected error: {msg}");
    }

    #[test]
    fn null_extractor_always_errors() {
        let n = NullVisionExtractor;
        let path = PathBuf::from("/tmp/x.png");
        let err = n.describe_image(&path).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("null-vision-extractor") || msg.contains("no VLM"));
        assert_eq!(n.model_id(), "null-vision-extractor");
    }

    #[test]
    fn is_vision_extension_matches_image_metadata() {
        for ext in ["jpg", "jpeg", "PNG", "tif", "tiff", "webp"] {
            assert!(is_vision_extension(ext), "{ext} should be a vision ext");
        }
        for ext in ["txt", "md", "csv", "gif"] {
            assert!(
                !is_vision_extension(ext),
                "{ext} should NOT be a vision ext"
            );
        }
    }
}
