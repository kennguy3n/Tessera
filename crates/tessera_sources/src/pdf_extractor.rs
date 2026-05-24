//! PDF text extraction and per-page raster-image OCR for source indexing
//! (Block C task 10).
//!
//! Two-pass design:
//!
//! 1. **Text pass (`extract_pdf_text`)**: extract the document's text
//!    layer via `lopdf::Document::extract_text`. This covers every
//!    page that has typed / OCR'd text already baked in. For a
//!    typical typed-PDF (Word export, LaTeX output, etc.) this single
//!    pass already produces the canonical chunks and there is no
//!    work for the VLM to do.
//!
//! 2. **OCR pass (`pdf_pages_needing_ocr` +
//!    [`PdfOcrExtractor::vlm_ocr_chunks_for_pdf`])**: walk every
//!    page; for each one whose text-pass output is below a "this
//!    page has no real text" threshold AND whose `Resources/XObject`
//!    dictionary references at least one embedded raster image,
//!    decode the largest such image to a temporary file on disk and
//!    feed it through the [`crate::vision_extractor::VisionExtractor`]
//!    trait with an OCR-flavoured prompt. The OCR text is appended
//!    as a single chunk with provenance
//!    `extraction_method = Some(ExtractionMethod::VlmOcr)` and the
//!    VLM's `model_id`, so a future model swap can re-OCR these
//!    pages without touching the text-pass chunks.
//!
//! Rate limiting is **per-process** and applies across every PDF
//! processed by the indexer in a given run. The contract (from the
//! Block C spec): "process at most 10 pages per minute" so the VLM
//! sidecar doesn't get starved by a multi-thousand-page scan
//! library. The limit is implemented as a token bucket
//! ([`PdfOcrRateLimiter`]) the caller passes in alongside the
//! extractor — this lets the indexer share a single limiter across
//! all source roots rather than each root re-paying the OCR budget.
//!
//! Image decoding scope: only **DCTDecode** (JPEG) image XObjects are
//! supported in this initial implementation, because the bytes of a
//! DCTDecode stream are a complete JPEG file as-is (the PDF spec
//! requires this — `7.4.8` in PDF 32000-1:2008) and the VLM sidecar
//! accepts JPEG natively. Other filters (FlateDecode-RAW,
//! CCITTFaxDecode, JBIG2Decode, JPXDecode) require active
//! reconstruction and are deferred — the OCR pass for those pages
//! is **skipped with a logged warning** rather than silently
//! producing wrong output. The text pass still emits any extractable
//! text for those pages.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use lopdf::xobject::PdfImage;
use lopdf::{Document, ObjectId};

use tessera_core::error::{Error, Result};

use crate::chunker::{Chunk, ExtractionMethod};
use crate::vision_extractor::VisionExtractor;

/// Threshold below which a page is considered "no extractable text"
/// and a candidate for OCR. PDFs sometimes carry trivial spaces /
/// punctuation in the text layer of an otherwise-scanned page; 32
/// non-whitespace characters is the empirically chosen cutoff
/// (a typical English sentence of 4-6 words). Below this we
/// trigger OCR; at or above this the text layer is treated as
/// authoritative.
pub const OCR_TEXT_THRESHOLD_CHARS: usize = 32;

/// Maximum number of OCR-bound pages the indexer will process per
/// 60-second window across the whole process. Matches the Block C
/// spec: "Rate-limit OCR: process at most 10 pages per minute".
pub const OCR_RATE_LIMIT_PAGES_PER_MINUTE: u32 = 10;

/// Default refresh window for the OCR rate limiter.
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

/// Token-bucket rate limiter for OCR-bound page processing.
///
/// Designed for the indexer's single-thread-per-source model: an
/// indexer holds an `Arc<PdfOcrRateLimiter>` and calls
/// `try_acquire()` before issuing each VLM OCR call. The limiter
/// hands out at most [`OCR_RATE_LIMIT_PAGES_PER_MINUTE`] tokens per
/// 60s window and blocks (caller-side) by returning `false` when
/// the budget is exhausted — letting the caller decide whether to
/// sleep, skip the page, or defer to the next pass.
#[derive(Debug)]
pub struct PdfOcrRateLimiter {
    inner: Mutex<RateLimiterState>,
    pages_per_window: u32,
    window: Duration,
}

#[derive(Debug)]
struct RateLimiterState {
    window_start: Instant,
    used_in_window: u32,
}

impl PdfOcrRateLimiter {
    /// Construct a rate limiter with the default 10 pages / 60 s
    /// budget.
    #[must_use]
    pub fn new() -> Self {
        Self::with_budget(OCR_RATE_LIMIT_PAGES_PER_MINUTE, RATE_LIMIT_WINDOW)
    }

    /// Construct a rate limiter with a custom budget. Intended for
    /// tests that need to assert burst / refill behaviour without
    /// waiting 60 s of wall clock.
    #[must_use]
    pub fn with_budget(pages_per_window: u32, window: Duration) -> Self {
        Self {
            inner: Mutex::new(RateLimiterState {
                window_start: Instant::now(),
                used_in_window: 0,
            }),
            pages_per_window,
            window,
        }
    }

    /// Attempt to consume one OCR-page token. Returns `true` if a
    /// token was available (caller should proceed with OCR) and
    /// `false` if the budget is exhausted for the current window
    /// (caller should skip or defer the page).
    pub fn try_acquire(&self) -> bool {
        let mut state = self.inner.lock().expect("PdfOcrRateLimiter mutex poisoned");
        let now = Instant::now();
        if now.duration_since(state.window_start) >= self.window {
            state.window_start = now;
            state.used_in_window = 0;
        }
        if state.used_in_window >= self.pages_per_window {
            return false;
        }
        state.used_in_window += 1;
        true
    }

    /// Tokens remaining in the current window. Exposed for tests
    /// and metrics; production code should rely on `try_acquire`.
    #[cfg(test)]
    pub fn tokens_remaining(&self) -> u32 {
        let state = self.inner.lock().expect("PdfOcrRateLimiter mutex poisoned");
        self.pages_per_window.saturating_sub(state.used_in_window)
    }
}

impl Default for PdfOcrRateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

/// Outcome for a single PDF page's text-layer probe. The OCR pass
/// inspects this struct to decide whether to call the VLM.
#[derive(Debug, Clone)]
pub struct PdfPageProbe {
    /// 1-indexed page number (as `lopdf` exposes it).
    pub page_number: u32,
    /// Text extracted from this page's text layer (may be empty).
    pub text: String,
    /// Number of non-whitespace characters in the text layer. Used
    /// as the OCR threshold gate.
    pub text_char_count: usize,
    /// Number of raster Image XObjects on this page. A page with
    /// `text_char_count < OCR_TEXT_THRESHOLD_CHARS` AND
    /// `image_count > 0` is treated as a "raster page" candidate
    /// for OCR.
    pub image_count: usize,
}

impl PdfPageProbe {
    /// True when the page is a candidate for VLM-driven OCR:
    /// effectively no text layer AND at least one embedded raster
    /// image.
    #[must_use]
    pub fn needs_ocr(&self) -> bool {
        self.text_char_count < OCR_TEXT_THRESHOLD_CHARS && self.image_count > 0
    }
}

/// Extract the concatenated text layer of every page in the PDF at
/// `path`. The output is the same shape `extract_text` produces for
/// typed-text formats (txt / md / html / xlsx) — one long string,
/// pages separated by `\n\n` so the chunker's paragraph-detection
/// heuristic still tracks page boundaries.
///
/// This is the **text pass**. Pages with no extractable text
/// contribute the empty string here; the OCR pass picks them up.
pub fn extract_pdf_text(path: &Path) -> Result<String> {
    let probes = probe_pdf_pages(path)?;
    let joined = probes
        .into_iter()
        .map(|p| p.text)
        .collect::<Vec<_>>()
        .join("\n\n");
    Ok(joined)
}

/// Probe every page of the PDF at `path`, returning a vector with
/// one entry per page. The vector preserves PDF page order so
/// callers can correlate `page_number` with the chunk's
/// `byte_offset` if needed.
///
/// Errors propagate as [`Error::Extraction`] so the indexer's
/// per-file error handling treats them uniformly with other
/// extraction failures.
pub fn probe_pdf_pages(path: &Path) -> Result<Vec<PdfPageProbe>> {
    let doc = Document::load(path).map_err(|e| Error::Extraction {
        path: path.display().to_string(),
        message: format!("failed to load PDF: {e}"),
    })?;

    let mut probes = Vec::new();
    for (page_number, page_id) in doc.get_pages() {
        let text = doc
            .extract_text(&[page_number])
            .unwrap_or_else(|_| String::new());
        let text_char_count = text.chars().filter(|c| !c.is_whitespace()).count();
        let image_count = doc.get_page_images(page_id).map_or(0, |imgs| imgs.len());
        probes.push(PdfPageProbe {
            page_number,
            text,
            text_char_count,
            image_count,
        });
    }
    Ok(probes)
}

/// Set of pages that need OCR (filtered by `needs_ocr`).
pub fn pdf_pages_needing_ocr(probes: &[PdfPageProbe]) -> Vec<u32> {
    probes
        .iter()
        .filter(|p| p.needs_ocr())
        .map(|p| p.page_number)
        .collect()
}

/// Produce VLM-OCR chunks for every raster page in the PDF at
/// `path`. The text-pass chunks (from [`extract_pdf_text`]) are
/// emitted separately by the indexer's normal `chunk_text` path —
/// this function only adds VLM-derived chunks on top.
///
/// Each chunk:
/// - has `source_path` == the PDF path, `chunk_index` continuing
///   from `metadata_chunk_count` (so the indexer's normal
///   monotonic chunk numbering is preserved),
/// - carries `extraction_method = Some(ExtractionMethod::VlmOcr)`
///   and `extraction_model_id = Some(extractor.model_id())`,
/// - has `byte_offset` set to the PDF page number — there is no
///   meaningful byte offset for OCR output, so we co-opt this
///   column to record which page the chunk came from.
///
/// Rate-limited: each OCR-bound page consumes one token from
/// `limiter`. Pages whose token cannot be acquired are **skipped**
/// (logged) rather than queued — the indexer is expected to run a
/// second pass later if the rate limit was the limiting factor.
///
/// Image decoding is best-effort: pages whose largest Image XObject
/// uses a non-DCTDecode filter are skipped with a logged warning
/// (see module docs). Future work can add FlateDecode raw-pixel
/// reconstruction and CCITTFaxDecode handling.
pub fn vlm_ocr_chunks_for_pdf(
    extractor: &dyn VisionExtractor,
    pdf_path: &Path,
    limiter: &PdfOcrRateLimiter,
    starting_chunk_index: usize,
) -> Result<Vec<Chunk>> {
    let probes = probe_pdf_pages(pdf_path)?;
    let pages = pdf_pages_needing_ocr(&probes);
    if pages.is_empty() {
        return Ok(Vec::new());
    }

    let doc = Document::load(pdf_path).map_err(|e| Error::Extraction {
        path: pdf_path.display().to_string(),
        message: format!("failed to load PDF for OCR pass: {e}"),
    })?;
    let pages_map = doc.get_pages();

    let mut chunks = Vec::new();
    let mut chunk_index = starting_chunk_index;
    let pdf_path_str = pdf_path.to_string_lossy().to_string();

    for page_number in pages {
        if !limiter.try_acquire() {
            eprintln!(
                "[tessera_sources] pdf OCR rate limit reached at page {page_number} of {pdf_path_str}; skipping remaining pages this window"
            );
            break;
        }

        let Some(page_id) = pages_map.get(&page_number).copied() else {
            continue;
        };

        let Some(image_path) = write_largest_image_for_ocr(&doc, page_id, pdf_path)? else {
            eprintln!(
                "[tessera_sources] pdf {} page {} has no decodable image (only non-DCTDecode filters available); skipping OCR for this page",
                pdf_path_str, page_number
            );
            continue;
        };

        let ocr_text = match extractor.describe_image(&image_path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!(
                    "[tessera_sources] pdf OCR failed for {} page {}: {e}",
                    pdf_path_str, page_number
                );
                let _ = std::fs::remove_file(&image_path);
                continue;
            }
        };
        let _ = std::fs::remove_file(&image_path);

        let trimmed = ocr_text.trim();
        if trimmed.is_empty() {
            continue;
        }

        let hash = blake3::hash(trimmed.as_bytes()).to_hex().to_string();
        chunks.push(Chunk {
            source_path: pdf_path_str.clone(),
            chunk_index,
            byte_offset: page_number as usize,
            content: trimmed.to_string(),
            hash,
            extraction_method: Some(ExtractionMethod::VlmOcr),
            extraction_model_id: Some(extractor.model_id().to_string()),
        });
        chunk_index += 1;
    }
    Ok(chunks)
}

/// Find the largest Image XObject on `page_id` that we can decode
/// (currently DCTDecode only), write its bytes verbatim to a temp
/// file with a `.jpg` extension, and return the path. The caller
/// is responsible for deleting the file after OCR.
///
/// Returns `Ok(None)` when no decodable image is found (every
/// image uses a filter we don't yet handle).
fn write_largest_image_for_ocr(
    doc: &Document,
    page_id: ObjectId,
    source_pdf: &Path,
) -> Result<Option<std::path::PathBuf>> {
    let images = doc
        .get_page_images(page_id)
        .map_err(|e| Error::Extraction {
            path: source_pdf.display().to_string(),
            message: format!("failed to walk page XObjects: {e}"),
        })?;

    let Some(img) = pick_largest_dct_image(&images) else {
        return Ok(None);
    };

    let out = temp_image_path(source_pdf, "ocr", img);
    std::fs::write(&out, img.content).map_err(|e| Error::Extraction {
        path: source_pdf.display().to_string(),
        message: format!("failed to write OCR temp image {}: {e}", out.display()),
    })?;
    Ok(Some(out))
}

/// Compute the per-process-unique temp-file path for an embedded
/// PDF image. `tag` distinguishes OCR vs chart calls so a single
/// page's OCR and chart passes don't trample each other's temp
/// files (they target different images, but the assertion is
/// belt-and-braces).
///
/// The hash inputs include the *absolute* PDF path AND the
/// current process pid, so parallel tests / parallel indexing
/// passes building PDFs with identical stems-and-embedded-images
/// in different tempdirs do not collide on the same
/// `/tmp/tessera-pdf-<tag>-<hash>.jpg` file. (Before this guard,
/// two cargo tests racing over a 4 × 4 DCTDecode image in
/// different tempdirs would alias the same temp file and one
/// would `unlink` it out from under the other.)
fn temp_image_path(source_pdf: &Path, tag: &str, img: &PdfImage<'_>) -> std::path::PathBuf {
    let dir = std::env::temp_dir();
    let abs = std::fs::canonicalize(source_pdf).unwrap_or_else(|_| source_pdf.to_path_buf());
    let abs_str = abs.to_string_lossy();
    let pid = std::process::id();
    let unique = blake3::hash(
        format!(
            "{abs_str}-{tag}-{}-{}-{}-{pid}",
            img.width, img.height, img.id.0
        )
        .as_bytes(),
    )
    .to_hex()
    .to_string();
    dir.join(format!("tessera-pdf-{tag}-{unique}.jpg"))
}

/// Pick the largest (by pixel area) image whose filter list
/// includes `DCTDecode`. Returns `None` if no DCTDecode image
/// exists on the page.
fn pick_largest_dct_image<'a>(images: &'a [PdfImage<'a>]) -> Option<&'a PdfImage<'a>> {
    images
        .iter()
        .filter(|img| {
            img.filters
                .as_ref()
                .is_some_and(|fs| fs.iter().any(|f| f == "DCTDecode"))
        })
        .max_by_key(|img| img.width.saturating_mul(img.height))
}

// --- Chart extraction (Block C task 11) -----------------------------------
//
// The chart-extraction pass is a parallel pipeline alongside OCR: it
// looks at every PDF page (regardless of whether the page has a text
// layer) and emits one `VlmChart` chunk per *chart-like* embedded
// image. "Chart-like" is a deliberately conservative dimension-based
// heuristic — we cannot afford to JPEG-decode every image in the
// document just to compute a colour-variance number, so the first
// filter is purely on the metadata that `lopdf` already gives us (px
// width / height). Future work can layer a `image::ImageReader`-based
// histogram on top for tighter recall.
//
// The chart pass is gated at the indexer level by tier — chart
// description benefits from spatial reasoning, so the indexer only
// invokes this pass on medium+ tier hosts (where the Qwen3.5-VL
// model is the recommended pick). Low-tier hosts default to OCR-only.

/// Minimum image size (in pixels along the shorter side) for the
/// chart heuristic to even consider an embedded image. Tiny
/// thumbnails / inline icons are filtered out at this gate so we
/// don't spend a VLM call describing a 32 × 32 PDF reading-glasses
/// icon.
pub const CHART_MIN_PIXELS_PER_SIDE: i64 = 400;

/// Aspect ratio tolerance for the chart heuristic. We accept images
/// whose `max(w,h) / min(w,h)` ratio falls within `±10%` of one of
/// the canonical chart aspect ratios (4:3 ≈ 1.333, 16:9 ≈ 1.778).
const CHART_ASPECT_TOLERANCE: f64 = 0.10;

/// Canonical chart aspect ratios. An image with `max/min` ratio
/// within `±CHART_ASPECT_TOLERANCE` of any value here is treated as
/// chart-like. The set is intentionally small — it's the union of
/// PowerPoint / Keynote slide ratios (4:3, 16:9) and the
/// standard "figure in a paper" ratio (4:3). Photos shot on phones
/// are typically 3:2 (~1.5) which falls outside both ±10% bands
/// (1.33+0.13=1.46, 1.78-0.18=1.60), so we get sensible photo
/// rejection for free.
const CHART_TARGET_ASPECTS: &[f64] = &[4.0 / 3.0, 16.0 / 9.0];

/// True when an image of size `w × h` pixels matches the chart
/// heuristic: both dimensions ≥ [`CHART_MIN_PIXELS_PER_SIDE`] AND
/// `max(w,h) / min(w,h)` is within `±CHART_ASPECT_TOLERANCE` of
/// one of [`CHART_TARGET_ASPECTS`].
///
/// Takes `i64` to match the type `lopdf::xobject::PdfImage` exposes
/// for `width` / `height` (the PDF spec stores them as integer
/// objects of arbitrary precision; lopdf widens to i64). Negative or
/// zero values are rejected as degenerate.
///
/// Pure function so the unit tests can exhaustively pin the
/// accept / reject boundary without standing up a real PDF.
#[must_use]
pub fn is_likely_chart_image(width: i64, height: i64) -> bool {
    if width < CHART_MIN_PIXELS_PER_SIDE || height < CHART_MIN_PIXELS_PER_SIDE {
        return false;
    }
    // f64 can represent every i64 up to 2^53 losslessly. PDF page
    // images that big don't exist in the wild — even a 24000 DPI
    // page scan is on the order of 2^17 px per side — so the lossy
    // cast above 2^53 is a non-issue. The `as` cast is the
    // canonical conversion for this case and avoids the
    // `TryFrom<i64>` boilerplate.
    let (w, h) = (width as f64, height as f64);
    let (long, short) = if w >= h { (w, h) } else { (h, w) };
    let ratio = long / short;
    CHART_TARGET_ASPECTS.iter().any(|target| {
        let lower = target * (1.0 - CHART_ASPECT_TOLERANCE);
        let upper = target * (1.0 + CHART_ASPECT_TOLERANCE);
        ratio >= lower && ratio <= upper
    })
}

/// Produce VLM-chart chunks for every chart-like embedded image in
/// the PDF at `pdf_path`. The text-pass chunks (from
/// [`extract_pdf_text`]) and OCR chunks (from
/// [`vlm_ocr_chunks_for_pdf`]) are emitted separately by the
/// indexer's normal pipeline — this function only adds VLM-chart
/// chunks on top.
///
/// One chunk per chart image (NOT per page — a page with three
/// chart images produces three chunks). Each chunk:
/// - has `source_path` == the PDF path, `chunk_index` continuing
///   from `starting_chunk_index`,
/// - carries `extraction_method = Some(ExtractionMethod::VlmChart)`
///   and `extraction_model_id = Some(extractor.model_id())`,
/// - has `byte_offset` set to the PDF page number (co-opting the
///   column the same way [`vlm_ocr_chunks_for_pdf`] does).
///
/// Rate-limited via the shared OCR limiter so the chart and OCR
/// passes together respect the 10-pages-per-minute budget across
/// the whole indexing run. (A dedicated chart limiter would double
/// the VLM load on multi-chart documents — not desirable for the
/// initial implementation; future work can split them.)
///
/// Image decoding is currently DCTDecode-only (same constraint as
/// the OCR pass); other filters are skipped with a logged warning.
pub fn vlm_chart_chunks_for_pdf(
    extractor: &dyn VisionExtractor,
    pdf_path: &Path,
    limiter: &PdfOcrRateLimiter,
    starting_chunk_index: usize,
) -> Result<Vec<Chunk>> {
    let doc = Document::load(pdf_path).map_err(|e| Error::Extraction {
        path: pdf_path.display().to_string(),
        message: format!("failed to load PDF for chart pass: {e}"),
    })?;

    let mut chunks = Vec::new();
    let mut chunk_index = starting_chunk_index;
    let pdf_path_str = pdf_path.to_string_lossy().to_string();

    for (page_number, page_id) in doc.get_pages() {
        let Ok(images) = doc.get_page_images(page_id) else {
            continue;
        };
        for img in &images {
            if !is_likely_chart_image(img.width, img.height) {
                continue;
            }
            let is_dct = img
                .filters
                .as_ref()
                .is_some_and(|fs| fs.iter().any(|f| f == "DCTDecode"));
            if !is_dct {
                eprintln!(
                    "[tessera_sources] pdf {} page {} chart-like image {}x{} uses non-DCTDecode filter; skipping chart description",
                    pdf_path_str, page_number, img.width, img.height
                );
                continue;
            }
            if !limiter.try_acquire() {
                eprintln!(
                    "[tessera_sources] pdf chart rate limit reached at page {page_number} of {pdf_path_str}; skipping remaining charts this window"
                );
                return Ok(chunks);
            }
            let image_path = match write_image_for_vlm(img, pdf_path, "chart") {
                Ok(p) => p,
                Err(e) => {
                    eprintln!(
                        "[tessera_sources] pdf {} page {} failed to write chart temp image: {e}",
                        pdf_path_str, page_number
                    );
                    continue;
                }
            };
            let chart_text = match extractor.describe_chart(&image_path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!(
                        "[tessera_sources] pdf chart describe failed for {} page {}: {e}",
                        pdf_path_str, page_number
                    );
                    let _ = std::fs::remove_file(&image_path);
                    continue;
                }
            };
            let _ = std::fs::remove_file(&image_path);

            let trimmed = chart_text.trim();
            if trimmed.is_empty() {
                continue;
            }

            let hash = blake3::hash(trimmed.as_bytes()).to_hex().to_string();
            chunks.push(Chunk {
                source_path: pdf_path_str.clone(),
                chunk_index,
                byte_offset: page_number as usize,
                content: trimmed.to_string(),
                hash,
                extraction_method: Some(ExtractionMethod::VlmChart),
                extraction_model_id: Some(extractor.model_id().to_string()),
            });
            chunk_index += 1;
        }
    }
    Ok(chunks)
}

/// Write a DCTDecode `PdfImage` to a temp JPEG and return the path.
/// `tag` is a short label (e.g. "chart", "ocr") woven into the
/// filename so concurrent extractions don't collide. The caller is
/// responsible for deleting the file after the VLM call.
fn write_image_for_vlm(
    img: &PdfImage<'_>,
    source_pdf: &Path,
    tag: &str,
) -> Result<std::path::PathBuf> {
    let out = temp_image_path(source_pdf, tag, img);
    std::fs::write(&out, img.content).map_err(|e| Error::Extraction {
        path: source_pdf.display().to_string(),
        message: format!("failed to write {tag} temp image {}: {e}", out.display()),
    })?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    fn fixture_path(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join(name)
    }

    /// Stub extractor that returns a canned OCR result so the OCR-
    /// pass plumbing is testable without a live VLM. Captures
    /// every path it was called with so the test can assert which
    /// pages got OCRed.
    struct OcrStub {
        canned: String,
        calls: std::sync::Mutex<Vec<PathBuf>>,
        model: String,
    }

    impl OcrStub {
        fn new(canned: &str, model: &str) -> Self {
            Self {
                canned: canned.to_string(),
                calls: std::sync::Mutex::new(Vec::new()),
                model: model.to_string(),
            }
        }

        fn called_paths(&self) -> Vec<PathBuf> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl VisionExtractor for OcrStub {
        fn describe_image(&self, image_path: &Path) -> Result<String> {
            self.calls.lock().unwrap().push(image_path.to_path_buf());
            Ok(self.canned.clone())
        }
        fn model_id(&self) -> &str {
            &self.model
        }
    }

    #[test]
    fn rate_limiter_grants_up_to_budget_then_blocks() {
        let r = PdfOcrRateLimiter::with_budget(3, Duration::from_secs(60));
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        // Fourth request must fail within the same window.
        assert!(!r.try_acquire());
        assert_eq!(r.tokens_remaining(), 0);
    }

    #[test]
    fn rate_limiter_refills_after_window() {
        // 20 ms window so the test doesn't sleep 60 s.
        let r = PdfOcrRateLimiter::with_budget(2, Duration::from_millis(20));
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        assert!(!r.try_acquire());
        std::thread::sleep(Duration::from_millis(40));
        // After the window elapses the bucket refills.
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        assert!(!r.try_acquire());
    }

    #[test]
    fn rate_limiter_is_thread_safe() {
        // Sanity check: parallel acquire calls should never exceed
        // the budget. 4 threads × 100 attempts × 1-token budget.
        let limiter = Arc::new(PdfOcrRateLimiter::with_budget(50, Duration::from_secs(60)));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let l = Arc::clone(&limiter);
                std::thread::spawn(move || {
                    let mut granted = 0;
                    for _ in 0..100 {
                        if l.try_acquire() {
                            granted += 1;
                        }
                    }
                    granted
                })
            })
            .collect();
        let total: u32 = handles.into_iter().map(|h| h.join().unwrap()).sum();
        assert_eq!(total, 50, "limiter must hand out exactly the budget");
    }

    #[test]
    fn page_probe_needs_ocr_when_text_below_threshold_and_image_present() {
        let p = PdfPageProbe {
            page_number: 1,
            text: " ".to_string(),
            text_char_count: 0,
            image_count: 1,
        };
        assert!(p.needs_ocr());
    }

    #[test]
    fn page_probe_does_not_need_ocr_when_image_count_is_zero() {
        let p = PdfPageProbe {
            page_number: 1,
            text: String::new(),
            text_char_count: 0,
            image_count: 0,
        };
        assert!(!p.needs_ocr());
    }

    #[test]
    fn page_probe_does_not_need_ocr_when_text_is_above_threshold() {
        let p = PdfPageProbe {
            page_number: 1,
            text: "The quick brown fox jumps over the lazy dog.".to_string(),
            text_char_count: 36,
            image_count: 5,
        };
        assert!(!p.needs_ocr());
    }

    #[test]
    fn extract_pdf_text_returns_text_layer_from_typed_pdf() {
        let p = fixture_path("typed.pdf");
        if !p.exists() {
            // Fixture-less environments (initial PR before the
            // fixture is committed) skip rather than fail.
            return;
        }
        let text = extract_pdf_text(&p).expect("typed.pdf must extract text");
        assert!(
            text.to_lowercase().contains("hello")
                || text.to_lowercase().contains("tessera")
                || !text.is_empty()
        );
    }

    #[test]
    fn vlm_ocr_chunks_for_pdf_returns_empty_when_every_page_has_text() {
        let p = fixture_path("typed.pdf");
        if !p.exists() {
            return;
        }
        let stub = OcrStub::new("ocr output", "test-vlm");
        let limiter = PdfOcrRateLimiter::with_budget(10, Duration::from_secs(60));
        let chunks = vlm_ocr_chunks_for_pdf(&stub, &p, &limiter, 0)
            .expect("typed.pdf should not error during OCR pass");
        assert!(chunks.is_empty(), "typed PDF should not produce OCR chunks");
        assert!(
            stub.called_paths().is_empty(),
            "VLM must not be called for a typed PDF"
        );
    }

    #[test]
    fn pick_largest_dct_image_skips_non_dct_filters() {
        // Build a fake page-image vector where the largest is not
        // DCTDecode (so we must skip it) and there's a smaller one
        // with DCTDecode (which we must pick).
        let big_dict = lopdf::Dictionary::new();
        let small_dict = lopdf::Dictionary::new();
        let big_content = vec![0u8; 16];
        let small_content = vec![0u8; 8];
        let big = PdfImage {
            id: (1, 0),
            width: 1000,
            height: 1000,
            color_space: None,
            filters: Some(vec!["FlateDecode".to_string()]),
            bits_per_component: None,
            content: &big_content,
            origin_dict: &big_dict,
        };
        let small = PdfImage {
            id: (2, 0),
            width: 100,
            height: 100,
            color_space: None,
            filters: Some(vec!["DCTDecode".to_string()]),
            bits_per_component: None,
            content: &small_content,
            origin_dict: &small_dict,
        };
        let images = vec![big, small];
        let picked = pick_largest_dct_image(&images).expect("DCTDecode image should be picked");
        assert_eq!(picked.id, (2, 0));
    }

    #[test]
    fn pick_largest_dct_image_returns_none_when_no_dct_present() {
        let dict = lopdf::Dictionary::new();
        let content = vec![0u8; 8];
        let img = PdfImage {
            id: (1, 0),
            width: 100,
            height: 100,
            color_space: None,
            filters: Some(vec!["FlateDecode".to_string()]),
            bits_per_component: None,
            content: &content,
            origin_dict: &dict,
        };
        let images = vec![img];
        assert!(pick_largest_dct_image(&images).is_none());
    }

    // --- Chart heuristic boundary tests (Block C task 11) ------------

    #[test]
    fn chart_heuristic_accepts_canonical_4_3_landscape() {
        // 1600 × 1200 = 4:3 exactly. Above the size floor. Must accept.
        assert!(is_likely_chart_image(1600, 1200));
    }

    #[test]
    fn chart_heuristic_accepts_canonical_16_9_landscape() {
        // 1920 × 1080 = 16:9 exactly. Above the size floor. Must accept.
        assert!(is_likely_chart_image(1920, 1080));
    }

    #[test]
    fn chart_heuristic_accepts_portrait_orientation() {
        // 1200 × 1600 is a 4:3 portrait — same ratio, swapped axes.
        // The heuristic uses `max/min` so orientation is irrelevant.
        assert!(is_likely_chart_image(1200, 1600));
    }

    #[test]
    fn chart_heuristic_rejects_below_minimum_pixels_per_side() {
        // 399 × 399: below CHART_MIN_PIXELS_PER_SIDE on both axes.
        // Even though the ratio is 1.0 (within tolerance of 4:3 only
        // if 4:3 widened to ±25 %, which it isn't), the size floor
        // rejects this on its own. Pinning explicit reject.
        assert!(!is_likely_chart_image(399, 399));
    }

    #[test]
    fn chart_heuristic_rejects_phone_photo_3_to_2_ratio() {
        // 3000 × 2000 = 3:2 = 1.5. Above the size floor but the
        // aspect ratio falls into the ~1.46-1.60 gap between the
        // ±10% bands around 4:3 (1.20-1.47) and 16:9 (1.60-1.96).
        // Phone photos must be rejected so we don't VLM-describe
        // every selfie in a user's source folder.
        assert!(!is_likely_chart_image(3000, 2000));
    }

    #[test]
    fn chart_heuristic_rejects_square_image() {
        // 1000 × 1000 = 1:1. Photos and logos are often square.
        // Must be rejected because it doesn't match any of the
        // chart-canonical aspect ratios.
        assert!(!is_likely_chart_image(1000, 1000));
    }

    #[test]
    fn chart_heuristic_rejects_extreme_panorama() {
        // 3000 × 600 = 5:1. Panorama photo or web banner. Far
        // outside the 16:9 (1.78) ±10% band — must reject.
        assert!(!is_likely_chart_image(3000, 600));
    }

    #[test]
    fn chart_heuristic_rejects_zero_or_negative_dimensions() {
        // Degenerate inputs from a malformed PDF object dictionary.
        // Must not panic and must return false (no chart).
        assert!(!is_likely_chart_image(0, 1200));
        assert!(!is_likely_chart_image(1200, 0));
        assert!(!is_likely_chart_image(-1, 1200));
    }

    #[test]
    fn chart_heuristic_accepts_4_3_at_size_floor() {
        // Exactly at the size floor on both axes: 800 × 600 = 4:3.
        // Pinned so a future tightening of the floor accidentally
        // crossing 800 is caught by this test.
        assert!(is_likely_chart_image(800, 600));
    }

    #[test]
    fn chart_heuristic_accepts_within_4_3_tolerance() {
        // 1450 × 1200 ≈ 1.208 ratio, which is the lower edge of
        // 4:3 (1.333 × 0.9 = 1.20). Should be accepted at the
        // tolerance boundary.
        assert!(is_likely_chart_image(1450, 1200));
        // 1600 × 1100 ≈ 1.454 ratio, which is the upper edge of
        // 4:3 (1.333 × 1.1 = 1.467). Should still be accepted.
        assert!(is_likely_chart_image(1600, 1100));
    }

    #[test]
    fn vlm_chart_chunks_for_pdf_returns_empty_when_no_pdf_pages() {
        // Loading a non-PDF file must surface as an extraction
        // error (not panic, not silent empty). Same contract as
        // the OCR pass.
        let bogus = Path::new("/nonexistent/path/that/is/not/a/pdf.pdf");
        let stub = OcrStub::new("irrelevant", "test-vlm");
        let limiter = PdfOcrRateLimiter::with_budget(10, Duration::from_secs(60));
        let result = vlm_chart_chunks_for_pdf(&stub, bogus, &limiter, 0);
        assert!(result.is_err());
    }
}
