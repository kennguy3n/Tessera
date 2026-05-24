//! Integration tests for the PDF text + OCR pipeline (Block C task 10).
//!
//! These tests build PDFs in memory using `lopdf`, write them to a
//! tempdir, and exercise `extract_pdf_text`, `probe_pdf_pages`,
//! `vlm_ocr_chunks_for_pdf`, and the indexer's wired-in PDF OCR
//! pass. They avoid checking a binary PDF fixture into the repo —
//! every test PDF is constructed deterministically at runtime.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::{ImageBuffer, Rgb};
use lopdf::content::{Content, Operation};
use lopdf::{dictionary, Document, Object, Stream};

use tessera_core::error::Result;
use tessera_sources::chunker::ExtractionMethod;
use tessera_sources::pdf_extractor::{
    extract_pdf_text, pdf_pages_needing_ocr, probe_pdf_pages, vlm_chart_chunks_for_pdf,
    vlm_ocr_chunks_for_pdf, PdfOcrRateLimiter,
};
use tessera_sources::vision_extractor::VisionExtractor;

/// Stub VLM that returns a canned OCR result for any image it
/// receives. Records every input path so the test can verify which
/// pages were OCRed.
struct OcrStub {
    canned: String,
    calls: Mutex<Vec<PathBuf>>,
    model: String,
}

impl OcrStub {
    fn new(canned: &str, model: &str) -> Self {
        Self {
            canned: canned.to_string(),
            calls: Mutex::new(Vec::new()),
            model: model.to_string(),
        }
    }

    fn called(&self) -> Vec<PathBuf> {
        self.calls.lock().unwrap().clone()
    }
}

impl VisionExtractor for OcrStub {
    fn describe_image(&self, image_path: &Path) -> Result<String> {
        // Assert the file actually exists at the moment of OCR — a
        // bug in the OCR pass that hands the VLM a path it just
        // deleted would otherwise pass silently.
        assert!(
            image_path.exists(),
            "OCR stub received a path that does not exist: {}",
            image_path.display()
        );
        self.calls.lock().unwrap().push(image_path.to_path_buf());
        Ok(self.canned.clone())
    }

    fn model_id(&self) -> &str {
        &self.model
    }
}

/// Encode a 4×4 solid-colour JPEG and return its bytes. JPEG is the
/// only image filter the OCR pass currently decodes (DCTDecode), so
/// we use it as the page-2 embedded image.
fn tiny_jpeg() -> Vec<u8> {
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> =
        ImageBuffer::from_fn(4, 4, |_, _| Rgb([240, 240, 240]));
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Jpeg)
        .expect("JPEG encode must succeed");
    buf.into_inner()
}

/// Build a PDF with `text_pages` pages of plain text followed by
/// `raster_pages` pages whose only content is a Do reference to an
/// embedded JPEG XObject. Returns the serialized PDF bytes.
fn build_pdf(text_pages: &[&str], raster_pages: usize) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });

    let jpeg_bytes = tiny_jpeg();
    let mut img_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => 4,
        "Height" => 4,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8,
    };
    img_dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    let img_stream = Stream::new(img_dict, jpeg_bytes);
    let img_id = doc.add_object(img_stream);

    // `lopdf::Document::get_page_images` looks at the page's OWN
    // `Resources/XObject` dict — it does not walk the page-tree
    // inheritance chain. So we attach a fresh resources dictionary
    // to every page rather than putting one on the Pages parent.
    let text_resources = dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    };
    let raster_resources = dictionary! {
        "Font" => dictionary! { "F1" => font_id },
        "XObject" => dictionary! { "Im1" => img_id },
    };

    let mut kids: Vec<Object> = Vec::new();

    for text in text_pages {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new("Tj", vec![Object::string_literal(*text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let stream = Stream::new(dictionary! {}, content.encode().unwrap());
        let content_id = doc.add_object(stream);
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => text_resources.clone(),
        });
        kids.push(page_id.into());
    }

    for _ in 0..raster_pages {
        // Raster-only page: paints the embedded image scaled to
        // page coordinates. NO text-operator (Tj/TJ) at all so the
        // text extractor produces an empty string for this page.
        let content = Content {
            operations: vec![
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        100.into(),
                        0.into(),
                        0.into(),
                        100.into(),
                        100.into(),
                        600.into(),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Im1".to_vec())]),
                Operation::new("Q", vec![]),
            ],
        };
        let stream = Stream::new(dictionary! {}, content.encode().unwrap());
        let content_id = doc.add_object(stream);
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => raster_resources.clone(),
        });
        kids.push(page_id.into());
    }

    let kids_count = kids.len() as i32;
    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Kids" => kids,
        "Count" => kids_count,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut buf: Vec<u8> = Vec::new();
    doc.save_to(&mut buf).expect("PDF save must succeed");
    buf
}

fn write_pdf(name: &str, bytes: &[u8]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join(name);
    std::fs::write(&path, bytes).expect("write pdf");
    dir
}

/// Build a PDF with `text_pages` of plain text and `chart_pages`
/// of pages that embed a single JPEG XObject whose dictionary
/// `Width` × `Height` is `chart_w × chart_h`. The JPEG payload
/// itself is still a 4×4 placeholder — the heuristic reads
/// dimensions from the dictionary, not from the JPEG header, so
/// this is sufficient to exercise the chart-extraction code path
/// without materialising a multi-megabyte JPEG.
///
/// Used by the chart-pass integration tests so we can simulate a
/// PDF carrying a 1600×1200 chart image without actually encoding
/// 1.92 M pixels of test fixture.
fn build_pdf_with_chart_image(
    text_pages: &[&str],
    chart_pages: usize,
    chart_w: i64,
    chart_h: i64,
) -> Vec<u8> {
    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();

    let font_id = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
    });

    let jpeg_bytes = tiny_jpeg();
    let mut img_dict = dictionary! {
        "Type" => "XObject",
        "Subtype" => "Image",
        "Width" => chart_w,
        "Height" => chart_h,
        "ColorSpace" => "DeviceRGB",
        "BitsPerComponent" => 8,
    };
    img_dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    let img_stream = Stream::new(img_dict, jpeg_bytes);
    let img_id = doc.add_object(img_stream);

    let text_resources = dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    };
    let chart_resources = dictionary! {
        "Font" => dictionary! { "F1" => font_id },
        "XObject" => dictionary! { "Im1" => img_id },
    };

    let mut kids: Vec<Object> = Vec::new();

    for text in text_pages {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new("Tj", vec![Object::string_literal(*text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let stream = Stream::new(dictionary! {}, content.encode().unwrap());
        let content_id = doc.add_object(stream);
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => text_resources.clone(),
        });
        kids.push(page_id.into());
    }

    for _ in 0..chart_pages {
        // Page that paints the chart-sized image AND has a real
        // text layer (so it's not eligible for OCR — chart pass
        // must trigger independently of the OCR threshold).
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 720.into()]),
                Operation::new(
                    "Tj",
                    vec![Object::string_literal("Figure 1 — sales by quarter")],
                ),
                Operation::new("ET", vec![]),
                Operation::new("q", vec![]),
                Operation::new(
                    "cm",
                    vec![
                        400.into(),
                        0.into(),
                        0.into(),
                        300.into(),
                        100.into(),
                        200.into(),
                    ],
                ),
                Operation::new("Do", vec![Object::Name(b"Im1".to_vec())]),
                Operation::new("Q", vec![]),
            ],
        };
        let stream = Stream::new(dictionary! {}, content.encode().unwrap());
        let content_id = doc.add_object(stream);
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Contents" => content_id,
            "Resources" => chart_resources.clone(),
        });
        kids.push(page_id.into());
    }

    let kids_count = kids.len() as i32;
    let pages_dict = dictionary! {
        "Type" => "Pages",
        "Kids" => kids,
        "Count" => kids_count,
        "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
    };
    doc.objects.insert(pages_id, Object::Dictionary(pages_dict));

    let catalog_id = doc.add_object(dictionary! {
        "Type" => "Catalog",
        "Pages" => pages_id,
    });
    doc.trailer.set("Root", catalog_id);

    let mut buf: Vec<u8> = Vec::new();
    doc.save_to(&mut buf).expect("PDF save must succeed");
    buf
}

/// Vision stub that distinguishes describe_chart from describe_image
/// so the chart-pass tests can assert the *chart* mode is invoked
/// (rather than falling back to the image-mode prompt).
struct ChartStub {
    chart_canned: String,
    image_calls: Mutex<u32>,
    chart_calls: Mutex<u32>,
    model: String,
}

impl ChartStub {
    fn new(canned: &str, model: &str) -> Self {
        Self {
            chart_canned: canned.to_string(),
            image_calls: Mutex::new(0),
            chart_calls: Mutex::new(0),
            model: model.to_string(),
        }
    }
    fn image_call_count(&self) -> u32 {
        *self.image_calls.lock().unwrap()
    }
    fn chart_call_count(&self) -> u32 {
        *self.chart_calls.lock().unwrap()
    }
}

impl VisionExtractor for ChartStub {
    fn describe_image(&self, _image_path: &Path) -> Result<String> {
        *self.image_calls.lock().unwrap() += 1;
        Ok("plain image description".to_string())
    }
    fn describe_chart(&self, image_path: &Path) -> Result<String> {
        assert!(
            image_path.exists(),
            "chart stub received a path that does not exist: {}",
            image_path.display()
        );
        *self.chart_calls.lock().unwrap() += 1;
        Ok(self.chart_canned.clone())
    }
    fn model_id(&self) -> &str {
        &self.model
    }
}

#[test]
fn extract_pdf_text_returns_text_layer_for_typed_pdf() {
    let bytes = build_pdf(&["Hello Tessera world"], 0);
    let dir = write_pdf("typed.pdf", &bytes);
    let path = dir.path().join("typed.pdf");
    let text = extract_pdf_text(&path).expect("typed PDF must extract");
    assert!(
        text.to_lowercase().contains("hello"),
        "expected text layer to contain 'hello', got: {text:?}"
    );
}

#[test]
fn probe_pdf_pages_identifies_raster_page_for_ocr() {
    let bytes = build_pdf(&["Page one has real text we can read"], 1);
    let dir = write_pdf("mixed.pdf", &bytes);
    let path = dir.path().join("mixed.pdf");
    let probes = probe_pdf_pages(&path).expect("probe must succeed");
    assert_eq!(probes.len(), 2, "expected exactly 2 pages");

    // Page 1: text layer present, no OCR.
    assert!(
        !probes[0].needs_ocr(),
        "text page must not need OCR; probe = {:?}",
        probes[0]
    );
    // Page 2: raster only, OCR candidate.
    assert!(
        probes[1].needs_ocr(),
        "raster-only page must need OCR; probe = {:?}",
        probes[1]
    );

    let ocr_pages = pdf_pages_needing_ocr(&probes);
    assert_eq!(ocr_pages, vec![probes[1].page_number]);
}

#[test]
fn vlm_ocr_chunks_for_pdf_emits_one_chunk_per_raster_page() {
    let bytes = build_pdf(&["Page one is text only"], 2);
    let dir = write_pdf("two-raster.pdf", &bytes);
    let path = dir.path().join("two-raster.pdf");

    let stub = OcrStub::new("INVOICE TOTAL: $1,234.56", "test-vlm-stub");
    let limiter = PdfOcrRateLimiter::with_budget(10, Duration::from_secs(60));

    let outcome = vlm_ocr_chunks_for_pdf(&stub, &path, &limiter, 0).expect("OCR pass must succeed");
    let chunks = &outcome.chunks;

    assert_eq!(
        chunks.len(),
        2,
        "expected one OCR chunk per raster page, got {} (probe: {:?})",
        chunks.len(),
        probe_pdf_pages(&path).unwrap()
    );
    assert!(
        outcome.fully_processed,
        "every OCR-eligible page processed within budget → fully_processed must be true"
    );
    for c in chunks {
        assert_eq!(c.extraction_method, Some(ExtractionMethod::VlmOcr));
        assert_eq!(c.extraction_model_id.as_deref(), Some("test-vlm-stub"));
        assert_eq!(c.content, "INVOICE TOTAL: $1,234.56");
        assert!(c.source_path.ends_with("two-raster.pdf"));
    }
    // Chunk indices are monotonic, starting from the starting_chunk_index.
    assert_eq!(chunks[0].chunk_index, 0);
    assert_eq!(chunks[1].chunk_index, 1);
    // byte_offset stores the PDF page number so the chunk can be
    // traced back to its source page.
    assert_eq!(chunks[0].byte_offset, 2);
    assert_eq!(chunks[1].byte_offset, 3);

    // VLM was called once per raster page.
    assert_eq!(stub.called().len(), 2);
}

#[test]
fn vlm_ocr_chunks_for_pdf_respects_rate_limit() {
    // Three raster pages but only two OCR tokens — third page must
    // be skipped (logged, not errored).
    let bytes = build_pdf(&[], 3);
    let dir = write_pdf("three-raster.pdf", &bytes);
    let path = dir.path().join("three-raster.pdf");

    let stub = OcrStub::new("ocr-text", "test-vlm");
    let limiter = PdfOcrRateLimiter::with_budget(2, Duration::from_secs(60));

    let outcome = vlm_ocr_chunks_for_pdf(&stub, &path, &limiter, 0).expect("must succeed");

    assert_eq!(
        outcome.chunks.len(),
        2,
        "rate limiter must cap OCR at 2 chunks"
    );
    assert!(
        !outcome.fully_processed,
        "third page was skipped by rate limiter → pass MUST flag fully_processed=false so the indexer can defer the hash stamp and retry on the next pass"
    );
    assert_eq!(stub.called().len(), 2);
}

#[test]
fn vlm_ocr_chunks_for_pdf_drops_empty_ocr_output() {
    let bytes = build_pdf(&[], 1);
    let dir = write_pdf("one-raster.pdf", &bytes);
    let path = dir.path().join("one-raster.pdf");

    let stub = OcrStub::new("   \n\t ", "test-vlm");
    let limiter = PdfOcrRateLimiter::new();

    let outcome = vlm_ocr_chunks_for_pdf(&stub, &path, &limiter, 0).expect("must succeed");
    assert!(
        outcome.chunks.is_empty(),
        "whitespace-only OCR must be dropped"
    );
    assert!(
        outcome.fully_processed,
        "the page WAS processed (the VLM returned a blank, which we filtered) → fully_processed must remain true"
    );
}

#[test]
fn vlm_ocr_chunks_for_pdf_continues_when_one_page_vlm_call_fails_but_flags_partial() {
    // Devin Review pass-13 🚩 finding regression guard.
    //
    // When a single page's VLM call returns Err (transient sidecar
    // restart / OOM / timeout), the OCR pass MUST:
    //   1. continue to the next page (don't lose the OTHER pages'
    //      successful OCR text), AND
    //   2. flip `fully_processed = false` so the indexer stamps the
    //      `partial:` sentinel on the `indexed_files` row and the
    //      next scan re-runs the OCR pass from scratch.
    //
    // Prior to the fix, this test asserted `fully_processed == true`
    // and the failed page's OCR was permanently lost (the file's
    // real BLAKE3 hash got stamped, and the next pass short-circuited
    // on hash match). That assertion encoded the bug.
    struct FlakyStub {
        calls: Mutex<u32>,
    }
    impl VisionExtractor for FlakyStub {
        fn describe_image(&self, _: &Path) -> Result<String> {
            let mut n = self.calls.lock().unwrap();
            *n += 1;
            if *n == 1 {
                Err(tessera_core::error::Error::Extraction {
                    path: "<flaky>".to_string(),
                    message: "transient sidecar error".to_string(),
                })
            } else {
                Ok(format!("ocr-text-{n}"))
            }
        }
        fn model_id(&self) -> &'static str {
            "flaky-vlm"
        }
    }

    let bytes = build_pdf(&[], 3);
    let dir = write_pdf("three-raster.pdf", &bytes);
    let path = dir.path().join("three-raster.pdf");

    let stub = FlakyStub {
        calls: Mutex::new(0),
    };
    let limiter = PdfOcrRateLimiter::new();
    let outcome = vlm_ocr_chunks_for_pdf(&stub, &path, &limiter, 0).expect("must succeed");
    assert_eq!(
        outcome.chunks.len(),
        2,
        "one failing VLM call should not abort the whole OCR pass — the other two pages must still produce chunks"
    );
    assert!(
        !outcome.fully_processed,
        "one VLM call failed → pass MUST flag fully_processed=false so the indexer stamps the `partial:` sentinel and retries on the next scan (otherwise the failed page's OCR is permanently lost)"
    );
}

#[test]
fn indexer_integration_extracts_text_and_ocr_chunks_for_mixed_pdf() {
    use tessera_sources::indexer::Indexer;
    use tessera_sources::source::Source;
    use tessera_sources::store::SourceStore;

    let bytes = build_pdf(&["Quarterly results: revenue up 14% in Q3."], 1);
    let dir = write_pdf("mixed.pdf", &bytes);
    let pdf_path = dir.path().join("mixed.pdf");

    let store = SourceStore::open_in_memory().expect("source store must open");
    let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
    store.add_source(&source).expect("add_source");

    let stub: Arc<dyn VisionExtractor> = Arc::new(OcrStub::new(
        "OCR: Annual Report 2024 Cover Page",
        "test-vlm",
    ));
    let indexer = Indexer::new(&[]).with_vision_extractor(stub.clone());

    let outcome = indexer
        .index_single_file(&source.id, &pdf_path, &store)
        .expect("index_single_file must succeed");
    assert!(outcome.indexed, "the PDF must be marked indexed");

    let chunks = store
        .all_chunks_for_path(&pdf_path.to_string_lossy())
        .expect("chunk fetch must succeed");

    assert!(
        chunks
            .iter()
            .any(|c| c.content.to_lowercase().contains("revenue")),
        "text-pass chunks must include the text-layer content; chunks={:?}",
        chunks.iter().map(|c| &c.content).collect::<Vec<_>>()
    );
    let ocr_chunks: Vec<_> = chunks
        .iter()
        .filter(|c| c.extraction_method == Some(ExtractionMethod::VlmOcr))
        .collect();
    assert_eq!(
        ocr_chunks.len(),
        1,
        "exactly one OCR chunk must be emitted for the raster page; chunks={:?}",
        chunks
    );
    assert_eq!(ocr_chunks[0].content, "OCR: Annual Report 2024 Cover Page");
    assert_eq!(
        ocr_chunks[0].extraction_model_id.as_deref(),
        Some("test-vlm")
    );
}

// --- Chart-pass integration tests (Block C task 11) ----------------------

#[test]
fn vlm_chart_chunks_for_pdf_emits_one_chunk_per_chart_image() {
    // Two text pages + two chart pages. Each chart page embeds a
    // 1600×1200 (4:3) JPEG. Expected: chart pass emits 2 chunks
    // (one per chart-image instance), tagged VlmChart, with
    // chunk_index continuing from `starting_chunk_index=5`.
    let bytes = build_pdf_with_chart_image(&["page 1 text", "page 2 text"], 2, 1600, 1200);
    let dir = write_pdf("with-charts.pdf", &bytes);
    let path = dir.path().join("with-charts.pdf");

    let stub = ChartStub::new("Bar chart: Q1=10, Q2=20, Q3=30, Q4=40.", "test-chart-vlm");
    let limiter = PdfOcrRateLimiter::with_budget(10, Duration::from_secs(60));

    let outcome = vlm_chart_chunks_for_pdf(&stub, &path, &limiter, 5)
        .expect("chart pass must succeed on chart-bearing PDF");
    let chunks = &outcome.chunks;

    assert_eq!(
        chunks.len(),
        2,
        "expected one chart chunk per chart-image instance; chunks={:?}",
        chunks.iter().map(|c| &c.content).collect::<Vec<_>>()
    );
    assert!(
        outcome.fully_processed,
        "every chart-eligible page processed within budget → fully_processed must be true"
    );
    for c in chunks {
        assert_eq!(c.extraction_method, Some(ExtractionMethod::VlmChart));
        assert_eq!(c.extraction_model_id.as_deref(), Some("test-chart-vlm"));
        assert_eq!(c.content, "Bar chart: Q1=10, Q2=20, Q3=30, Q4=40.");
        assert!(c.source_path.ends_with("with-charts.pdf"));
    }
    assert_eq!(chunks[0].chunk_index, 5);
    assert_eq!(chunks[1].chunk_index, 6);
    // byte_offset = page number (chart pages are page 3 and 4 since
    // text pages 1 and 2 come first in the kids list).
    assert_eq!(chunks[0].byte_offset, 3);
    assert_eq!(chunks[1].byte_offset, 4);

    // describe_chart was called (NOT describe_image) — this is the
    // critical assertion: the chart pass MUST drive the chart-mode
    // prompt, not the generic image-mode prompt.
    assert_eq!(stub.chart_call_count(), 2);
    assert_eq!(stub.image_call_count(), 0);
}

#[test]
fn vlm_chart_chunks_for_pdf_skips_below_size_threshold_images() {
    // 200×150 image (4:3 ratio but below CHART_MIN_PIXELS_PER_SIDE
    // of 400) — must not trigger the chart pass.
    let bytes = build_pdf_with_chart_image(&["text page"], 1, 200, 150);
    let dir = write_pdf("tiny-chart.pdf", &bytes);
    let path = dir.path().join("tiny-chart.pdf");

    let stub = ChartStub::new("should-not-appear", "test-chart-vlm");
    let limiter = PdfOcrRateLimiter::with_budget(10, Duration::from_secs(60));

    let outcome = vlm_chart_chunks_for_pdf(&stub, &path, &limiter, 0)
        .expect("chart pass must not error on tiny images");
    assert!(
        outcome.chunks.is_empty(),
        "tiny images must not trigger chart pass"
    );
    assert!(
        outcome.fully_processed,
        "the page WAS visited (the heuristic rejected it cleanly) → fully_processed must remain true"
    );
    assert_eq!(stub.chart_call_count(), 0);
}

#[test]
fn vlm_chart_chunks_for_pdf_respects_rate_limit() {
    // Three chart pages but only two tokens — third chart skipped.
    let bytes = build_pdf_with_chart_image(&[], 3, 1920, 1080);
    let dir = write_pdf("three-charts.pdf", &bytes);
    let path = dir.path().join("three-charts.pdf");

    let stub = ChartStub::new("chart-text", "test-chart-vlm");
    let limiter = PdfOcrRateLimiter::with_budget(2, Duration::from_secs(60));

    let outcome = vlm_chart_chunks_for_pdf(&stub, &path, &limiter, 0).expect("must succeed");
    assert_eq!(
        outcome.chunks.len(),
        2,
        "rate limiter must cap chart pass at 2 chunks"
    );
    assert!(
        !outcome.fully_processed,
        "third chart page was skipped by rate limiter → pass MUST flag fully_processed=false so the indexer can defer the hash stamp and retry on the next pass"
    );
    assert_eq!(stub.chart_call_count(), 2);
}

#[test]
fn vlm_chart_chunks_for_pdf_continues_when_one_chart_vlm_call_fails_but_flags_partial() {
    // Devin Review pass-13 🚩 finding regression guard (chart-pass
    // companion to `vlm_ocr_chunks_for_pdf_continues_when_one_page
    // _vlm_call_fails_but_flags_partial`).
    //
    // When the chart-pass `describe_chart` call fails on a single
    // chart image (transient sidecar restart / OOM / timeout), the
    // pass MUST:
    //   1. continue to the next chart image (don't lose other
    //      successful chart descriptions), AND
    //   2. flip `fully_processed = false` so the indexer stamps the
    //      `partial:` sentinel and the next scan re-runs the chart
    //      pass from scratch.
    //
    // Without this, a file where the FIRST chart's VLM call
    // transiently failed would be stamped fully-indexed and the
    // failed chart's description would be permanently lost.
    struct FlakyChartStub {
        calls: Mutex<u32>,
        model: String,
    }
    impl VisionExtractor for FlakyChartStub {
        fn describe_image(&self, _: &Path) -> Result<String> {
            Ok("plain image description".to_string())
        }
        fn describe_chart(&self, _: &Path) -> Result<String> {
            let mut n = self.calls.lock().unwrap();
            *n += 1;
            if *n == 1 {
                Err(tessera_core::error::Error::Extraction {
                    path: "<flaky-chart>".to_string(),
                    message: "transient sidecar error".to_string(),
                })
            } else {
                Ok(format!("chart-text-{n}"))
            }
        }
        fn model_id(&self) -> &str {
            &self.model
        }
    }

    let bytes = build_pdf_with_chart_image(&[], 3, 1920, 1080);
    let dir = write_pdf("three-charts-flaky.pdf", &bytes);
    let path = dir.path().join("three-charts-flaky.pdf");

    let stub = FlakyChartStub {
        calls: Mutex::new(0),
        model: "flaky-chart-vlm".to_string(),
    };
    let limiter = PdfOcrRateLimiter::with_budget(10, Duration::from_secs(60));
    let outcome = vlm_chart_chunks_for_pdf(&stub, &path, &limiter, 0).expect("must succeed");
    assert_eq!(
        outcome.chunks.len(),
        2,
        "one failing chart VLM call should not abort the whole chart pass — the other two charts must still produce chunks"
    );
    assert!(
        !outcome.fully_processed,
        "one chart VLM call failed → pass MUST flag fully_processed=false so the indexer stamps the `partial:` sentinel and retries on the next scan (otherwise the failed chart's description is permanently lost)"
    );
}

#[test]
fn indexer_skips_chart_pass_when_chart_extraction_disabled() {
    use tessera_sources::indexer::Indexer;
    use tessera_sources::source::Source;
    use tessera_sources::store::SourceStore;

    let bytes = build_pdf_with_chart_image(&["page with text"], 1, 1920, 1080);
    let dir = write_pdf("chart.pdf", &bytes);
    let pdf_path = dir.path().join("chart.pdf");

    let store = SourceStore::open_in_memory().expect("source store must open");
    let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
    store.add_source(&source).expect("add_source");

    let stub: Arc<dyn VisionExtractor> = Arc::new(ChartStub::new("chart-desc", "test-vlm"));
    // Default: chart_extraction_enabled = false. Even though the
    // VLM is attached, the chart pass must NOT run.
    let indexer = Indexer::new(&[]).with_vision_extractor(stub.clone());

    indexer
        .index_single_file(&source.id, &pdf_path, &store)
        .expect("index_single_file must succeed");

    let chunks = store
        .all_chunks_for_path(&pdf_path.to_string_lossy())
        .expect("chunk fetch");
    let chart_chunks: Vec<_> = chunks
        .iter()
        .filter(|c| c.extraction_method == Some(ExtractionMethod::VlmChart))
        .collect();
    assert!(
        chart_chunks.is_empty(),
        "chart pass must be disabled by default; got chart chunks: {chart_chunks:?}"
    );
}

#[test]
fn indexer_runs_chart_pass_when_chart_extraction_enabled() {
    use tessera_sources::indexer::Indexer;
    use tessera_sources::source::Source;
    use tessera_sources::store::SourceStore;

    let bytes = build_pdf_with_chart_image(&["page with text"], 1, 1920, 1080);
    let dir = write_pdf("chart.pdf", &bytes);
    let pdf_path = dir.path().join("chart.pdf");

    let store = SourceStore::open_in_memory().expect("source store must open");
    let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
    store.add_source(&source).expect("add_source");

    let stub: Arc<dyn VisionExtractor> = Arc::new(ChartStub::new(
        "Line chart showing upward trend across 4 quarters.",
        "test-vlm-medium",
    ));
    let indexer = Indexer::new(&[])
        .with_vision_extractor(stub.clone())
        .with_chart_extraction_enabled(true);

    indexer
        .index_single_file(&source.id, &pdf_path, &store)
        .expect("index_single_file must succeed");

    let chunks = store
        .all_chunks_for_path(&pdf_path.to_string_lossy())
        .expect("chunk fetch");
    let chart_chunks: Vec<_> = chunks
        .iter()
        .filter(|c| c.extraction_method == Some(ExtractionMethod::VlmChart))
        .collect();
    assert_eq!(
        chart_chunks.len(),
        1,
        "exactly one chart chunk expected; all chunks: {chunks:?}"
    );
    assert_eq!(
        chart_chunks[0].content,
        "Line chart showing upward trend across 4 quarters."
    );
    assert_eq!(
        chart_chunks[0].extraction_model_id.as_deref(),
        Some("test-vlm-medium")
    );
}
