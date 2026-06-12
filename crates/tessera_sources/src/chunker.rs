//! Splitting extracted source text into overlapping, provenance-tagged
//! chunks ready for embedding and indexing.

use serde::{Deserialize, Serialize};

/// Provenance tag for a chunk's content. `None` means the chunk
/// came from the native text-extraction pipeline (txt / md / csv /
/// json / html / xlsx / image-metadata); a `Some(_)` value records
/// which non-text pipeline emitted the chunk so the indexer can
/// re-generate stale chunks when the underlying model changes.
///
/// Stored as the lower-snake-case discriminant in
/// `chunks.extraction_method` (e.g. `"vlm"`, `"vlm_ocr"`,
/// `"vlm_chart"`). The accompanying `extraction_model_id` column
/// pins which VLM produced the description — when the user swaps
/// out their vision model the indexer can `DELETE` chunks whose
/// `extraction_model_id` does NOT match the new model's id and
/// re-run the VLM pass against them, instead of re-indexing the
/// whole corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionMethod {
    /// VLM description of an image file (JPEG/PNG/...). The chunk
    /// content is the VLM's freeform description; the EXIF-metadata
    /// chunk for the same file is kept separately with
    /// `extraction_method = None`.
    Vlm,
    /// VLM-driven OCR of a PDF page that had effectively no text
    /// layer. The chunk content is the OCRed text; one chunk per
    /// OCRed page is emitted.
    VlmOcr,
    /// Structured VLM description of an embedded chart / figure
    /// image extracted from a PDF (or PPTX in future). The chunk
    /// content is the structured prose returned by
    /// `vision_describe_chart`.
    VlmChart,
}

impl ExtractionMethod {
    /// Discriminant string written to the `chunks.extraction_method`
    /// column. We hand-roll this rather than relying on
    /// `serde_json::to_value` so the column value is a stable wire
    /// contract (changing the serde rename would silently invalidate
    /// every existing row).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vlm => "vlm",
            Self::VlmOcr => "vlm_ocr",
            Self::VlmChart => "vlm_chart",
        }
    }

    /// Parse the discriminant string back into the enum. Returns
    /// `None` for the empty / NULL case so callers can pattern-match
    /// `extraction_method = None` for legacy / native chunks without
    /// needing a sentinel variant.
    ///
    /// Named `from_wire` (not `from_str`) so the function signature
    /// — returning `Option<Self>` rather than `Result<Self, _>` —
    /// doesn't collide with the standard [`std::str::FromStr`]
    /// trait method, which would otherwise produce a
    /// `clippy::should-implement-trait` warning. Implementing
    /// `FromStr` itself isn't worth the boilerplate here: callers
    /// always know they're reading the SQLite-stored discriminant
    /// and `None == legacy native chunk` is more ergonomic than
    /// `Err(())`.
    #[must_use]
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "vlm" => Some(Self::Vlm),
            "vlm_ocr" => Some(Self::VlmOcr),
            "vlm_chart" => Some(Self::VlmChart),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// A contiguous slice of a source's extracted text, the unit that
/// gets embedded and searched.
pub struct Chunk {
    /// Path of the source file this chunk came from.
    pub source_path: String,
    /// Zero-based position of this chunk within the source.
    pub chunk_index: usize,
    /// Byte offset of this chunk's start within the source text.
    pub byte_offset: usize,
    /// The chunk's text content.
    pub content: String,
    /// Content hash, used to detect changes and dedupe.
    pub hash: String,
    /// Provenance of this chunk's content. `None` for legacy /
    /// native extraction; `Some(_)` for VLM-derived content.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction_method: Option<ExtractionMethod>,
    /// Identifier of the model that produced this chunk's content,
    /// when applicable. `None` for native extraction; for VLM
    /// chunks this is the manifest entry id of the vision model
    /// that generated the description (e.g. `"qwen3.5-4b-vision-gguf"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extraction_model_id: Option<String>,
}

#[derive(Debug, Clone)]
/// Tuning for [`chunk_text`]: target chunk size and the overlap
/// carried between consecutive chunks.
pub struct ChunkerConfig {
    /// Target chunk length in bytes (chunks are cut at char
    /// boundaries near this size).
    pub chunk_size: usize,
    /// Number of bytes each chunk re-includes from the previous one,
    /// so context isn't lost at boundaries.
    pub chunk_overlap: usize,
}

impl Default for ChunkerConfig {
    fn default() -> Self {
        Self {
            chunk_size: 1024,
            chunk_overlap: 128,
        }
    }
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

/// Splits `text` into overlapping [`Chunk`]s per `config`, cutting at
/// UTF-8 char boundaries and skipping whitespace-only output.
pub fn chunk_text(source_path: &str, text: &str, config: &ChunkerConfig) -> Vec<Chunk> {
    if text.is_empty() {
        return Vec::new();
    }

    if text.len() <= config.chunk_size {
        // Mirror the long-text path's whitespace guard at line ~158:
        // a fully-scanned multi-page PDF with no text layer joins to a
        // string of only `\n\n` page separators (see
        // `extract_pdf_text_from_probes`), which falls into this
        // short-text branch but has zero search value. Without the
        // guard we'd emit a whitespace-only chunk into the store and
        // FTS index — wasting a row, an FTS entry, and (if an
        // embedder is attached) an embedding computation. Devin
        // Review pass-11 🟡 finding on chunker.rs:131-142.
        if text.trim().is_empty() {
            return Vec::new();
        }
        let hash = blake3::hash(text.as_bytes()).to_hex().to_string();
        return vec![Chunk {
            source_path: source_path.to_string(),
            chunk_index: 0,
            byte_offset: 0,
            content: text.to_string(),
            hash,
            extraction_method: None,
            extraction_model_id: None,
        }];
    }

    let mut chunks = Vec::new();
    let mut offset = 0;
    let mut index = 0;

    while offset < text.len() {
        let end = floor_char_boundary(text, offset + config.chunk_size);

        let actual_end = if end < text.len() {
            find_break_point(text, offset, end)
        } else {
            text.len()
        };

        let chunk_str = &text[offset..actual_end];
        if !chunk_str.trim().is_empty() {
            let hash = blake3::hash(chunk_str.as_bytes()).to_hex().to_string();
            chunks.push(Chunk {
                source_path: source_path.to_string(),
                chunk_index: index,
                byte_offset: offset,
                content: chunk_str.to_string(),
                hash,
                extraction_method: None,
                extraction_model_id: None,
            });
            index += 1;
        }

        let step = if actual_end - offset > config.chunk_overlap {
            actual_end - offset - config.chunk_overlap
        } else {
            actual_end - offset
        };
        let new_offset = ceil_char_boundary(text, offset + step);
        if new_offset <= offset {
            break;
        }
        offset = new_offset;
    }

    chunks
}

fn find_break_point(text: &str, start: usize, target: usize) -> usize {
    // Look back up to 100 bytes from `target` for a natural break, but
    // never before this chunk's own `start`. Clamping to `start` is
    // load-bearing: when `chunk_size < 100`, `target - 100` lands BEFORE
    // `start`, and the `rfind`s below (which return the *last* break in
    // the window) could then resolve to a break sitting before `start`.
    // That makes the returned `actual_end < offset` in `chunk_text`, so
    // the subsequent `&text[offset..actual_end]` slice panics (begin >
    // end) — crashing the indexing worker on any input with a long
    // unbroken token (URLs, hashes, base64, minified code). With the
    // clamp the search window is always within `[start, target]`, so the
    // worst case is "no break found" → cut at `target`.
    let raw_start = start.max(target.saturating_sub(100));
    let search_start = ceil_char_boundary(text, raw_start);
    let target = floor_char_boundary(text, target);

    if search_start >= target {
        return target;
    }

    if let Some(pos) = text[search_start..target].rfind("\n\n") {
        return search_start + pos + 2;
    }
    if let Some(pos) = text[search_start..target].rfind('\n') {
        return search_start + pos + 1;
    }
    if let Some(pos) = text[search_start..target].rfind(". ") {
        return search_start + pos + 2;
    }
    if let Some(pos) = text[search_start..target].rfind(' ') {
        return search_start + pos + 1;
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_produces_no_chunks() {
        let chunks = chunk_text("test.txt", "", &ChunkerConfig::default());
        assert!(chunks.is_empty());
    }

    #[test]
    fn short_text_produces_single_chunk() {
        let text = "Hello, world!";
        let chunks = chunk_text("test.txt", text, &ChunkerConfig::default());
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, text);
        assert_eq!(chunks[0].chunk_index, 0);
        assert_eq!(chunks[0].byte_offset, 0);
        assert!(!chunks[0].hash.is_empty());
    }

    #[test]
    fn short_whitespace_only_text_produces_no_chunks() {
        // Devin Review pass-11 🟡 regression guard: when a fully
        // scanned PDF has no text layer, `extract_pdf_text_from_probes`
        // joins per-page empty strings with `\n\n`, producing a
        // whitespace-only string under the default 1024-byte chunk
        // size. The short-text path used to emit that as a chunk
        // — wasting a row, an FTS entry, and (if an embedder is
        // attached) an embedding computation on zero-search-value
        // content. The long-text path's existing `.trim().is_empty()`
        // guard is now mirrored in the short-text path.
        let config = ChunkerConfig::default();
        for whitespace in &["\n\n", "\n\n\n\n", "   ", " \t\n ", "\r\n\r\n\r\n"] {
            assert!(
                chunk_text("scan.pdf", whitespace, &config).is_empty(),
                "whitespace-only short text {whitespace:?} must produce no chunks",
            );
        }
    }

    #[test]
    fn long_text_produces_multiple_chunks() {
        let text = "word ".repeat(500);
        let config = ChunkerConfig {
            chunk_size: 100,
            chunk_overlap: 20,
        };
        let chunks = chunk_text("test.txt", &text, &config);
        assert!(chunks.len() > 1);

        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.chunk_index, i);
            assert!(!chunk.content.is_empty());
        }
    }

    #[test]
    fn chunks_have_correct_provenance() {
        let text = "line one\nline two\nline three\nline four\nline five";
        let config = ChunkerConfig {
            chunk_size: 20,
            chunk_overlap: 5,
        };
        let chunks = chunk_text("doc.md", text, &config);
        for chunk in &chunks {
            assert_eq!(chunk.source_path, "doc.md");
        }
    }

    #[test]
    fn chunk_hashes_are_deterministic() {
        let text = "Hello, world! This is a test.";
        let c1 = chunk_text("test.txt", text, &ChunkerConfig::default());
        let c2 = chunk_text("test.txt", text, &ChunkerConfig::default());
        assert_eq!(c1[0].hash, c2[0].hash);
    }

    #[test]
    fn identical_content_produces_same_hash() {
        let text = "Identical content.";
        let c1 = chunk_text("a.txt", text, &ChunkerConfig::default());
        let c2 = chunk_text("b.txt", text, &ChunkerConfig::default());
        assert_eq!(c1[0].hash, c2[0].hash);
    }

    #[test]
    fn multibyte_utf8_does_not_panic() {
        let text = "Hello 🌍 world! 你好世界 こんにちは This is a test with émojis and ünïcödé characters spread across the text to ensure chunking works properly with multi-byte sequences.";
        let config = ChunkerConfig {
            chunk_size: 30,
            chunk_overlap: 5,
        };
        let chunks = chunk_text("utf8.txt", text, &config);
        assert!(!chunks.is_empty());
        for chunk in &chunks {
            assert!(!chunk.content.is_empty());
        }
    }

    #[test]
    fn break_prefers_paragraph_boundaries() {
        let text = format!(
            "{}.\n\n{}.",
            "First paragraph with enough words to fill a chunk".repeat(3),
            "Second paragraph after the break"
        );
        let config = ChunkerConfig {
            chunk_size: 150,
            chunk_overlap: 20,
        };
        let chunks = chunk_text("test.txt", &text, &config);
        assert!(chunks.len() >= 2);
    }

    #[test]
    fn small_chunk_size_with_long_unbroken_token_does_not_panic() {
        // Regression: with `chunk_size < 100`, the break-point search
        // window used to extend before the chunk's own start (`target -
        // 100 < offset`). On input whose only break char sits before the
        // current offset — e.g. a single space followed by a long
        // unbroken run (URL / hash / base64 / minified code) — `rfind`
        // returned a position < offset, so `chunk_text` sliced
        // `&text[offset..actual_end]` with `actual_end < offset` and
        // panicked, crashing the indexing worker. The window is now
        // clamped to `[start, target]`.
        let text = format!("{} {}", "x".repeat(60), "y".repeat(200));
        let config = ChunkerConfig {
            chunk_size: 30,
            chunk_overlap: 5,
        };
        let chunks = chunk_text("blob.txt", &text, &config);
        assert!(!chunks.is_empty());
        // Every chunk slice is well-formed and non-decreasing in offset.
        let mut last_offset = 0;
        for chunk in &chunks {
            assert!(!chunk.content.is_empty());
            assert!(chunk.byte_offset >= last_offset);
            last_offset = chunk.byte_offset;
        }
    }
}
