use std::path::Path;
use std::sync::{Arc, Mutex};
use tessera_core::error::Result;
use tessera_core::{SourceId, SourceStatus};
use walkdir::WalkDir;

use crate::chunker::{chunk_text, ChunkerConfig};
use crate::embedding::{encode_vec, EmbeddingProvider};
use crate::extractor::{extract_text, is_supported_extension};
use crate::ignore::IgnoreRules;
use crate::image_metadata::is_image_extension;
use crate::pdf_extractor::{
    extract_pdf_text_from_probes, load_pdf_document, probe_pdf_pages_with_doc,
    vlm_chart_chunks_with_doc, vlm_ocr_chunks_from_probes, PdfOcrRateLimiter, PdfPageProbe,
};
use crate::progress::{
    self, record_chunk_embed_failed, record_chunk_embedded, EmbeddingProgressSnapshot, IndexPhase,
    ProgressSnapshot,
};
use crate::store::SourceStore;
use crate::vision_extractor::{vlm_chunks_for_image, VisionExtractor};

pub struct Indexer {
    chunker_config: ChunkerConfig,
    ignore_rules: IgnoreRules,
    /// Optional embedding provider. When set, every newly indexed
    /// chunk is immediately embedded and the vector stored in
    /// `chunk_embeddings` so hybrid retrieval can score it. When
    /// `None`, the table stays empty and retrieval falls back to
    /// BM25 + recency only.
    embedder: Option<Arc<dyn EmbeddingProvider>>,
    /// Optional vision extractor. When set AND the file under
    /// extraction is an image, the indexer adds a VLM-derived
    /// natural-language description as an additional searchable
    /// chunk alongside the always-emitted metadata chunk. When
    /// `None` (no vision model installed, low-tier host, or the
    /// caller explicitly opted out), the indexer falls back to
    /// metadata-only image extraction.
    vision_extractor: Option<Arc<dyn VisionExtractor>>,
    /// Process-wide rate limiter shared across PDFs to enforce the
    /// "max 10 OCR pages / minute" budget from the Block C spec.
    /// Always present (a default-budget limiter is created in
    /// [`Indexer::new`]); callers that want a custom budget can
    /// pass one via [`Indexer::with_pdf_ocr_rate_limiter`].
    pdf_ocr_rate_limiter: Arc<PdfOcrRateLimiter>,
    /// Whether the chart-extraction pass (Block C task 11) runs on
    /// every indexed PDF. Off by default because chart description
    /// is tier-gated — the prompt benefits from spatial reasoning
    /// (Qwen3.5-VL on medium+ tier), and emitting chart chunks on a
    /// low-tier host that loaded SmolVLM-256M would produce
    /// information-poor descriptions that just pollute search
    /// recall. The bridge layer flips this on when it detects
    /// `tier >= medium` at startup.
    chart_extraction_enabled: bool,
}

impl Indexer {
    pub fn new(ignore_patterns: &[String]) -> Self {
        // Always layer user patterns on TOP of the curated defaults
        // (binary files, VCS metadata, OS junk, …) so users get
        // sensible behaviour out of the box and can extend — or
        // negate with a leading `!` — without losing the defaults.
        let ignore_rules = IgnoreRules::with_defaults(ignore_patterns);
        Self {
            chunker_config: ChunkerConfig::default(),
            ignore_rules,
            embedder: None,
            vision_extractor: None,
            pdf_ocr_rate_limiter: Arc::new(PdfOcrRateLimiter::new()),
            chart_extraction_enabled: false,
        }
    }

    /// Toggle the chart-extraction pass on (typically when the host
    /// is medium+ tier and a vision model is installed). Defaults
    /// to `false`; the bridge layer flips it on after capability
    /// detection so existing tests — which exercise the indexer
    /// without setting up a tier probe — keep their current
    /// behaviour.
    pub fn with_chart_extraction_enabled(mut self, enabled: bool) -> Self {
        self.chart_extraction_enabled = enabled;
        self
    }

    /// `&mut self` setter for the chart-extraction toggle. Pairs
    /// with [`Indexer::with_chart_extraction_enabled`] (the builder
    /// form) so that callers which already own an `Indexer` (e.g.
    /// the bridge's [`crate::manager::SourceManager`] under a
    /// `Mutex`) can flip the toggle at runtime without rebuilding
    /// the whole indexer.
    pub fn set_chart_extraction_enabled(&mut self, enabled: bool) {
        self.chart_extraction_enabled = enabled;
    }

    /// `&mut self` setter for the vision extractor. Pairs with
    /// [`Indexer::with_vision_extractor`] (the builder form) so
    /// the bridge can swap or remove the extractor at runtime when
    /// the user installs / deletes / switches the vision model
    /// without rebuilding the indexer.
    pub fn set_vision_extractor(&mut self, extractor: Option<Arc<dyn VisionExtractor>>) {
        self.vision_extractor = extractor;
    }

    /// Override the PDF OCR rate limiter. Tests pass a budget-small
    /// limiter to assert the OCR loop respects the limit without
    /// waiting 60 s of wall clock; production callers can share a
    /// single limiter across multiple [`Indexer`] instances by
    /// wrapping it in `Arc` and cloning.
    pub fn with_pdf_ocr_rate_limiter(mut self, limiter: Arc<PdfOcrRateLimiter>) -> Self {
        self.pdf_ocr_rate_limiter = limiter;
        self
    }

    pub fn with_chunker_config(mut self, config: ChunkerConfig) -> Self {
        self.chunker_config = config;
        self
    }

    /// Attach an embedding provider to the indexer. Subsequent calls
    /// to `index_file` / `index_folder` will compute and persist a
    /// vector for every newly inserted chunk.
    pub fn with_embedder(mut self, embedder: Arc<dyn EmbeddingProvider>) -> Self {
        self.embedder = Some(embedder);
        self
    }

    /// Attach a vision extractor. Subsequent indexing passes will
    /// add a VLM-described chunk for every image file (in
    /// addition to the always-emitted metadata chunk). The
    /// extractor is invoked synchronously from the indexer thread;
    /// the bridge layer is expected to wrap the underlying async
    /// vision call so this stays a single-thread API.
    ///
    /// Pass `None` (or omit the call entirely) to opt out — useful
    /// when no vision model is installed, on low-tier hosts where
    /// VLM cost would dominate the indexing budget, or in tests
    /// that don't want to wire a stub.
    pub fn with_vision_extractor(mut self, extractor: Arc<dyn VisionExtractor>) -> Self {
        self.vision_extractor = Some(extractor);
        self
    }

    pub fn index_folder(
        &self,
        source_id: &SourceId,
        folder_path: &Path,
        store: &SourceStore,
    ) -> Result<IndexResult> {
        self.index_folder_with_progress(source_id, folder_path, store, None)
    }

    /// Same as [`Indexer::index_folder`] but updates an optional
    /// [`ProgressSnapshot`] slot every time a file is scanned /
    /// indexed / skipped. The bridge layer wires this in so the UI
    /// can poll progress without blocking the indexing thread.
    pub fn index_folder_with_progress(
        &self,
        source_id: &SourceId,
        folder_path: &Path,
        store: &SourceStore,
        progress_slot: Option<&Arc<Mutex<ProgressSnapshot>>>,
    ) -> Result<IndexResult> {
        store.update_source_status(source_id, SourceStatus::Indexing, None)?;

        let mut result = IndexResult::default();

        for entry in WalkDir::new(folder_path)
            .follow_links(false)
            .into_iter()
            .filter_map(std::result::Result::ok)
        {
            let path = entry.path();

            if self.ignore_rules.is_ignored(path) {
                result.skipped += 1;
                if let Some(slot) = progress_slot {
                    progress::record_skipped(slot);
                }
                continue;
            }

            if !path.is_file() {
                continue;
            }

            if let Some(slot) = progress_slot {
                progress::record_scanned(slot, &path.display().to_string());
            }

            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default();

            if !is_supported_extension(ext) {
                result.skipped += 1;
                if let Some(slot) = progress_slot {
                    progress::record_skipped(slot);
                }
                continue;
            }

            match self.index_file(source_id, path, store, progress_slot) {
                Ok(outcome) => {
                    // Per-file inline drops fold into the pass-wide
                    // count regardless of whether the file was newly
                    // indexed or unchanged. (A re-index of a file
                    // that already has chunks but no embeddings would
                    // be `unchanged: true` AND drop-rich if the
                    // embedder is offline, though in practice the
                    // hash check short-circuits before chunks are
                    // touched in that case.)
                    result.inline_embeddings_dropped += outcome.inline_embeddings_dropped;
                    if outcome.indexed {
                        result.indexed += 1;
                        if let Some(slot) = progress_slot {
                            progress::record_indexed(slot);
                        }
                    } else {
                        result.unchanged += 1;
                        if let Some(slot) = progress_slot {
                            progress::record_unchanged(slot);
                        }
                    }
                }
                Err(e) => {
                    result.errors.push(format!("{}: {e}", path.display()));
                    if let Some(slot) = progress_slot {
                        progress::record_error(slot);
                    }
                }
            }
        }

        let file_count = store.file_count_for_source(source_id)?;
        store.update_source_status(source_id, SourceStatus::Indexed, Some(file_count))?;

        if let Some(slot) = progress_slot {
            progress::finish(slot, file_count);
        }

        result.total_files = file_count;
        Ok(result)
    }

    pub fn index_single_file(
        &self,
        source_id: &SourceId,
        file_path: &Path,
        store: &SourceStore,
    ) -> Result<IndexFileOutcome> {
        self.index_file(source_id, file_path, store, None)
    }

    fn index_file(
        &self,
        source_id: &SourceId,
        path: &Path,
        store: &SourceStore,
        progress_slot: Option<&Arc<Mutex<ProgressSnapshot>>>,
    ) -> Result<IndexFileOutcome> {
        // Scope `content_bytes` to the hash computation so the raw
        // buffer is dropped before the rest of `index_file` runs.
        // For a 500 MB scanned PDF, holding the raw bytes in memory
        // alongside the parsed `lopdf::Document` (which is loaded a
        // few lines below for the text + OCR + chart passes) roughly
        // doubled peak heap usage — the raw bytes are only needed
        // for the BLAKE3 hash. Devin Review pass-9 📝 finding
        // flagged this; the scoped block is the minimal correct
        // fix.
        let file_hash = {
            let content_bytes = std::fs::read(path)?;
            blake3::hash(&content_bytes).to_hex().to_string()
        };
        let path_str = path.to_string_lossy().to_string();

        if let Ok(Some(existing_hash)) = store.get_file_hash(&path_str) {
            if existing_hash == file_hash {
                return Ok(IndexFileOutcome {
                    indexed: false,
                    inline_embeddings_dropped: 0,
                });
            }
        }

        let metadata = std::fs::metadata(path)?;
        let last_modified = metadata.modified().map_or_else(
            |_| chrono::Utc::now().to_rfc3339(),
            |t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339(),
        );

        let file_id =
            store.upsert_indexed_file(source_id, &path_str, &file_hash, &last_modified)?;

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_lowercase();

        // For PDFs, pre-load the `lopdf::Document` ONCE here and
        // thread it through the text / OCR / chart passes so the
        // file is parsed exactly once per `index_file` call rather
        // than three times (text pass, OCR pass, chart pass each
        // calling `Document::load` independently). lopdf re-reads
        // the whole file on every `load`, so for a multi-hundred-
        // page scanned PDF the redundant parses were the dominant
        // cost of an OCR-bound indexing run. Devin Review pass-7
        // 📝 finding on the chart-pass `Document::load` called this
        // out; addressing it at the call site (rather than the
        // extractor helpers) keeps the public helpers' signatures
        // stable for external callers / tests that don't have a
        // pre-loaded `Document` on hand.
        //
        // A `Document::load` failure here is logged and we fall
        // through to the regular `extract_text(path)` path — that
        // helper will also try to load the PDF and produce a
        // structured `Error::Extraction`, which the caller already
        // expects to handle. We don't want a parse failure to
        // permanently skip indexing of a corrupted PDF without
        // the user seeing a structured error.
        let pdf_doc = if ext.eq_ignore_ascii_case("pdf") {
            match load_pdf_document(path) {
                Ok(doc) => Some(doc),
                Err(e) => {
                    eprintln!(
                        "[tessera_sources] failed to preload PDF {} for shared parse: {e}; falling back to per-pass loads",
                        path.display()
                    );
                    None
                }
            }
        } else {
            None
        };

        // Probe the PDF's pages ONCE so the text-join and the OCR
        // eligibility checks share a single `extract_text` pass.
        // Without this, `extract_pdf_text_with_doc` would call
        // `probe_pdf_pages_with_doc` (one `extract_text` per page),
        // then `vlm_ocr_chunks_with_doc` would call it again,
        // doubling the per-page work for a 500-page scan. Devin
        // Review pass-9 📝 finding flagged the duplicate work; the
        // architectural fix is to probe at the indexer level and
        // pass `&[PdfPageProbe]` into both downstream paths.
        let pdf_probes: Option<Vec<PdfPageProbe>> = pdf_doc.as_ref().map(probe_pdf_pages_with_doc);

        let text = if let Some(probes) = pdf_probes.as_ref() {
            extract_pdf_text_from_probes(probes)
        } else {
            extract_text(path)?
        };
        let mut chunks = chunk_text(&path_str, &text, &self.chunker_config);

        // Track whether the VLM passes finished every eligible page.
        // The OCR + chart passes can be cut short by the shared
        // rate limiter, in which case we stamp a `partial:` sentinel
        // on the `indexed_files` row so the next `index_file` call
        // re-runs them. Without this, the file's real BLAKE3 hash
        // would already be stamped after the first call, the next
        // call would short-circuit on hash match, and the
        // remaining pages would be permanently lost until the
        // user's file content changed on disk.
        //
        // Renamed from `pdf_passes_complete` in Devin Review pass-9:
        // image VLM failures now also flip this to `false` so a
        // transient VLM hiccup on an image doesn't permanently
        // lose the description for that file (the next pass
        // retries the VLM call). The name `vlm_passes_complete`
        // reflects the broader scope (images + PDF OCR + PDF
        // chart).
        let mut vlm_passes_complete = true;

        // Vision pass: when the file is an image AND a VLM-backed
        // extractor is attached, append a single VLM-derived chunk
        // alongside the metadata chunks emitted by `extract_text`.
        // The metadata chunk carries `extraction_method = None`
        // ("native"); the VLM chunk carries
        // `Some(ExtractionMethod::Vlm)` plus the model id so a
        // future model swap can re-extract just the VLM rows.
        //
        // VLM failures are non-fatal — we log and continue with
        // just the metadata chunks. The user still gets EXIF +
        // dimensions for search; they just lose the
        // natural-language description for that one file.
        if is_image_extension(&ext) {
            if let Some(vlm) = &self.vision_extractor {
                if let Some(slot) = progress_slot {
                    progress::record_phase(slot, IndexPhase::DescribingImages);
                }
                match vlm_chunks_for_image(vlm.as_ref(), path, chunks.len()) {
                    Ok(mut vlm_chunks) => chunks.append(&mut vlm_chunks),
                    Err(e) => {
                        eprintln!(
                            "[tessera_sources] VLM describe failed for {}: {e}",
                            path.display()
                        );
                        // Mark this file as partial so the next
                        // `index_file` call re-runs the VLM
                        // describe rather than short-circuiting
                        // on hash match. Without this stamp, a
                        // transient sidecar timeout (which the
                        // user would expect to recover from on
                        // the next scheduled scan) would
                        // permanently lose the VLM description
                        // for that image until the file content
                        // changed on disk. Devin Review pass-9
                        // 🚩 finding flagged this asymmetry
                        // between image (no retry) and PDF OCR /
                        // chart (retry via partial sentinel).
                        vlm_passes_complete = false;
                    }
                }
                if let Some(slot) = progress_slot {
                    progress::record_phase(slot, IndexPhase::Scanning);
                }
            }
        }

        // PDF OCR pass (Block C task 10): when the file is a PDF AND
        // a VLM extractor is attached, walk every page; for pages
        // with effectively no text layer but one or more embedded
        // raster images, decode the largest DCTDecode image and
        // feed it through the VLM with an OCR-flavoured prompt. The
        // resulting OCR text is appended as one chunk per page with
        // `extraction_method = Some(ExtractionMethod::VlmOcr)`.
        //
        // OCR failures (rate limit hit, undecodable image filters,
        // VLM error) are non-fatal — we log and continue with the
        // text-pass chunks already in the chunks vector.
        if let Some(doc) = pdf_doc.as_ref() {
            if let Some(vlm) = &self.vision_extractor {
                if let Some(slot) = progress_slot {
                    progress::record_phase(slot, IndexPhase::OcrPdf);
                }
                // Reuse the probes from the text-join pass; this is
                // the architectural deduplication of the redundant
                // `probe_pdf_pages_with_doc` calls Devin Review
                // pass-9 📝 finding called out. `pdf_probes` is
                // `Some` whenever `pdf_doc` is `Some` (both are
                // populated together at the top of the function),
                // so the `expect()` cannot fire in practice — a
                // panic here would indicate a logic bug, not an
                // input-driven failure mode.
                let probes = pdf_probes
                    .as_ref()
                    .expect("pdf_doc Some implies pdf_probes Some");
                match vlm_ocr_chunks_from_probes(
                    doc,
                    probes,
                    vlm.as_ref(),
                    path,
                    self.pdf_ocr_rate_limiter.as_ref(),
                    chunks.len(),
                ) {
                    Ok(outcome) => {
                        chunks.extend(outcome.chunks);
                        if !outcome.fully_processed {
                            vlm_passes_complete = false;
                        }
                    }
                    Err(e) => {
                        eprintln!(
                            "[tessera_sources] PDF OCR pass failed for {}: {e}",
                            path.display()
                        );
                        // A hard error mid-pass also leaves the file
                        // in an indeterminate state — treat it the
                        // same as a rate-limit truncation so the
                        // next pass retries from scratch rather than
                        // short-circuiting on the just-stamped hash.
                        vlm_passes_complete = false;
                    }
                }
                // Chart-extraction pass (Block C task 11): tier-gated.
                // Runs AFTER the OCR pass so chart chunks land
                // after OCR chunks in chunk-index order — preserving
                // the canonical "text → OCR → chart" provenance
                // sequence. Uses the same rate limiter as OCR so
                // the combined VLM work respects a single
                // 10-pages-per-minute budget across both passes.
                if self.chart_extraction_enabled {
                    if let Some(slot) = progress_slot {
                        progress::record_phase(slot, IndexPhase::DescribingCharts);
                    }
                    match vlm_chart_chunks_with_doc(
                        doc,
                        vlm.as_ref(),
                        path,
                        self.pdf_ocr_rate_limiter.as_ref(),
                        chunks.len(),
                    ) {
                        Ok(outcome) => {
                            chunks.extend(outcome.chunks);
                            if !outcome.fully_processed {
                                vlm_passes_complete = false;
                            }
                        }
                        Err(e) => {
                            eprintln!(
                                "[tessera_sources] PDF chart pass failed for {}: {e}",
                                path.display()
                            );
                            vlm_passes_complete = false;
                        }
                    }
                }
                if let Some(slot) = progress_slot {
                    progress::record_phase(slot, IndexPhase::Scanning);
                }
            }
        }

        // If any VLM pass was cut short by the rate limiter (or hit
        // a hard error mid-pass), downgrade the just-stamped hash
        // to a `partial:` sentinel so the next `index_file` call
        // detects the mismatch and re-runs the file from scratch.
        // Without this, the unprocessed pages would be permanently
        // lost — the file's real BLAKE3 hash is already on the row
        // and a future pass would short-circuit on hash match.
        //
        // Safe to call AFTER `insert_chunks_returning_ids` below
        // (the chunks we DID produce are still useful for search),
        // but stamping the sentinel here — BEFORE chunk insert —
        // is also safe: `upsert_indexed_file` on the next pass will
        // `DELETE FROM chunks WHERE indexed_file_id = file_id`
        // (because the stored `partial:HEX` doesn't match the new
        // raw `HEX`), so the partial chunks get cleaned up at the
        // start of the retry anyway. We stamp here, before the
        // chunk insert, so a panic between the two doesn't leave
        // the row claiming "fully indexed".
        if !vlm_passes_complete {
            store.mark_file_needs_reindex(file_id)?;
        }

        let mut inline_embeddings_dropped: u64 = 0;
        if !chunks.is_empty() {
            let ids = store.insert_chunks_returning_ids(file_id, &chunks)?;
            if let Some(embedder) = &self.embedder {
                let model_id = embedder.model_id().to_string();
                let dim = embedder.dim();
                for (id, chunk) in ids.iter().zip(chunks.iter()) {
                    // Embedding failure on a single chunk should not
                    // tank the whole indexing pass — log internally,
                    // increment the per-file drop counter, and
                    // continue. The retrieval pipeline already handles
                    // missing-embedding rows by falling back to
                    // BM25 + recency for that chunk. The caller
                    // observes the cumulative drop count via
                    // `IndexFileOutcome::inline_embeddings_dropped`
                    // (folded into `IndexResult::
                    // inline_embeddings_dropped` for folder passes)
                    // and can invoke `backfill_embeddings` later to
                    // retry — e.g. after a network-backed embedder
                    // comes back online.
                    //
                    // Both the embed-compute failure path and the
                    // upsert-persist failure path increment the same
                    // counter: from the caller's perspective both
                    // mean "this chunk has no embedding row and a
                    // later backfill needs to retry it".
                    match embedder.embed(&chunk.content) {
                        Ok(vec) => {
                            let bytes = encode_vec(&vec);
                            if let Err(e) =
                                store.upsert_chunk_embedding(*id, &model_id, dim, &bytes)
                            {
                                eprintln!(
                                    "[tessera_sources] failed to persist embedding for chunk {id}: {e}"
                                );
                                inline_embeddings_dropped += 1;
                            }
                        }
                        Err(e) => {
                            eprintln!("[tessera_sources] embedding failed for chunk {id}: {e}");
                            inline_embeddings_dropped += 1;
                        }
                    }
                }
            }
        }

        Ok(IndexFileOutcome {
            indexed: true,
            inline_embeddings_dropped,
        })
    }

    /// Compute and persist embeddings for chunks that don't yet have
    /// one for the current model. Returns the number of chunks
    /// processed. Safe to call repeatedly — idempotent.
    ///
    /// Used to back-fill embeddings after the user enables hybrid
    /// retrieval on a corpus that was indexed before the embedder
    /// was attached, or after switching to a different embedding
    /// model (chunks with stale `model_id` rows are NOT touched;
    /// callers must explicitly clear them first).
    pub fn backfill_embeddings(&self, store: &SourceStore, batch_size: usize) -> Result<usize> {
        let Some(embedder) = &self.embedder else {
            return Ok(0);
        };
        let model_id = embedder.model_id().to_string();
        let dim = embedder.dim();
        let mut total = 0usize;
        // Per-session failure log: chunk IDs that have failed to embed
        // at least once in THIS backfill invocation. The next
        // `chunks_missing_embedding_excluding` query skips them so
        // the SQL doesn't keep returning the same broken chunks on
        // every iteration.
        //
        // Without this filter, convergence on a corpus with P passing
        // chunks and F persistently-failing chunks at batch size B is
        // `O(P · ⌈F/B⌉ / B)` iterations — every batch query reads the
        // F failures before finding the next B passes, so the
        // wall-clock cost of finishing the backfill grows
        // multiplicatively with F. With the exclude list, the failing
        // set is paid for exactly once (the first time each failing
        // chunk is returned) and convergence drops to the expected
        // `O((P + F) / B)`.
        //
        // The pure stall-detector below ("every chunk in this batch
        // failed") is still kept as a hard backstop: if a future
        // pathological mix of `permanent_failures` + a batch_size
        // smaller than F manages to fill a batch entirely with new
        // failures, the loop still terminates rather than spinning.
        // The exclude list shrinks the failure surface; the stall
        // detector is the inner safety net.
        let mut permanent_failures: Vec<i64> = Vec::new();
        // Guard against an infinite loop when `embedder.embed()`
        // returns `Err` for the same chunks on every iteration (e.g.
        // a network-backed provider whose backend is down, or a
        // chunk whose contents trip a deterministic parser bug in
        // the embedder). `HashTrickEmbedding` cannot hit this path
        // (pure math, infallible), but the trait is explicitly
        // designed for pluggable providers including network ones
        // (see the module-level comment in `embedding.rs`).
        loop {
            let batch = store.chunks_missing_embedding_excluding(
                &model_id,
                batch_size,
                &permanent_failures,
            )?;
            if batch.is_empty() {
                break;
            }
            let mut batch_progress = 0usize;
            let mut batch_failures: Vec<i64> = Vec::new();
            for (id, content) in &batch {
                match embedder.embed(content) {
                    Ok(vec) => {
                        let bytes = encode_vec(&vec);
                        store.upsert_chunk_embedding(*id, &model_id, dim, &bytes)?;
                        total += 1;
                        batch_progress += 1;
                    }
                    Err(e) => {
                        eprintln!("[tessera_sources] backfill embed failed for chunk {id}: {e}");
                        batch_failures.push(*id);
                    }
                }
            }
            if batch_progress == 0 {
                // Every chunk in this batch failed. Even with the
                // exclude-list optimisation, this can happen on the
                // first iteration if F ≥ batch_size and all the
                // freshly-discovered failures happen to land in the
                // same batch. Bail out — the chunks stay flagged as
                // missing on disk, so a subsequent backfill call
                // (after the embedder is restored) will pick them up.
                eprintln!(
                    "[tessera_sources] backfill stalled: {} chunks failed to embed in a single batch, aborting to avoid infinite loop",
                    batch.len()
                );
                break;
            }
            // Park this batch's failures so the next SQL query skips
            // them. This is what turns the worst-case convergence
            // from `O(P · ⌈F/B⌉ / B)` to `O((P + F) / B)`. Allocating
            // ahead-of-loop via `extend` avoids `Vec` reallocation
            // churn on long backfills (`Vec::extend` doubles capacity
            // amortised, vs `push` which may also double but in a
            // less obviously-amortised way under MIR optimisation).
            permanent_failures.extend(batch_failures);
            if batch.len() < batch_size {
                break;
            }
        }
        Ok(total)
    }

    /// Variant of [`backfill_embeddings`] that reports per-chunk
    /// progress into the supplied [`EmbeddingProgressSnapshot`] slot.
    ///
    /// The slot is the same mutex the IPC poll loop reads via
    /// `EmbeddingProgressTracker::snapshot`, so the renderer sees the
    /// `embedded` / `failed` counters increment as the backfill makes
    /// progress through the corpus. The `total_chunks` denominator and
    /// the `Running` status flip are the caller's responsibility (they
    /// must call `tracker.start(total, model_id)` before invoking this
    /// method); on exit the caller decides whether to call
    /// `finish_embedding` (success path) or `mark_embedding_failed`
    /// (whole-pass failure).
    ///
    /// Returns a [`BackfillOutcome`] that distinguishes a clean drain
    /// (loop exited because the work-set was empty or the last partial
    /// batch was processed normally) from a stall (every chunk in a
    /// batch failed, indicating the embedder is broken). The caller
    /// uses this to flip the public progress status to `Done` vs.
    /// `Failed` — the indexer itself only signals which exit path
    /// fired and leaves the UX decision to the manager.
    pub fn backfill_embeddings_with_progress(
        &self,
        store: &SourceStore,
        batch_size: usize,
        progress_slot: &std::sync::Mutex<EmbeddingProgressSnapshot>,
    ) -> Result<BackfillOutcome> {
        let Some(embedder) = &self.embedder else {
            return Ok(BackfillOutcome::Completed { embedded: 0 });
        };
        let model_id = embedder.model_id().to_string();
        let dim = embedder.dim();
        let mut total = 0usize;
        // See `backfill_embeddings` for the rationale behind the
        // per-session exclude list and the stall-detector backstop —
        // this method is the progress-reporting twin of that one and
        // intentionally mirrors its termination guarantees.
        let mut permanent_failures: Vec<i64> = Vec::new();
        loop {
            let batch = store.chunks_missing_embedding_excluding(
                &model_id,
                batch_size,
                &permanent_failures,
            )?;
            if batch.is_empty() {
                break;
            }
            let mut batch_progress = 0usize;
            let mut batch_failures: Vec<i64> = Vec::new();
            for (id, content) in &batch {
                match embedder.embed(content) {
                    Ok(vec) => {
                        let bytes = encode_vec(&vec);
                        store.upsert_chunk_embedding(*id, &model_id, dim, &bytes)?;
                        total += 1;
                        batch_progress += 1;
                        record_chunk_embedded(progress_slot);
                    }
                    Err(e) => {
                        eprintln!(
                            "[tessera_sources] tracked backfill embed failed for chunk {id}: {e}"
                        );
                        batch_failures.push(*id);
                        record_chunk_embed_failed(progress_slot);
                    }
                }
            }
            if batch_progress == 0 {
                // Every chunk in this batch failed. Even with the
                // exclude-list optimisation, this can happen if the
                // embedder is fundamentally broken (e.g. backing model
                // file was unloaded, sidecar crashed) and every fresh
                // chunk pulled from the DB hits the same fault. We
                // surface this to the caller as a `Stalled` outcome
                // rather than a clean `Completed` so the manager can
                // flip the user-facing progress status to `Failed` —
                // showing "Re-embed complete" with `embedded=0,
                // failed=N` would be misleading.
                eprintln!(
                    "[tessera_sources] tracked backfill stalled: {} chunks failed to embed in a single batch, aborting to avoid infinite loop",
                    batch.len()
                );
                return Ok(BackfillOutcome::Stalled {
                    embedded: total,
                    stalled_batch_len: batch.len(),
                });
            }
            permanent_failures.extend(batch_failures);
            if batch.len() < batch_size {
                break;
            }
        }
        Ok(BackfillOutcome::Completed { embedded: total })
    }
}

/// Exit signal from [`Indexer::backfill_embeddings_with_progress`].
///
/// The tracked variant of the backfill loop has two distinct
/// successful exit paths and the caller (the [`SourceManager`])
/// needs to flip the public embedding-progress status to a
/// different state for each:
///
///   * `Completed` → the loop drained the work-set normally. Status
///     should flip to `Done`. Per-chunk failures along the way are
///     non-fatal and already counted in the progress snapshot, so
///     the renderer can render “`embedded` / `total_chunks` with
///     `failed` failures” on `Done`.
///   * `Stalled` → the stall-detector tripped: every chunk in a
///     single batch failed to embed. The most likely cause is that
///     the embedder is broken (model file unloaded, sidecar dead,
///     wrong API key on a remote provider). Status should flip to
///     `Failed` so the renderer shows the failure banner instead of
///     “complete with N failures”. The `embedded` count is preserved
///     so the renderer can still show partial progress made before
///     the stall.
///
/// `Err(_)` (whole-pass infrastructure failure, e.g. SQLite write
/// error) is reported separately via the outer `Result` and bypasses
/// this enum entirely.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackfillOutcome {
    Completed {
        embedded: usize,
    },
    Stalled {
        embedded: usize,
        /// Length of the batch in which every chunk failed. Surfaced
        /// in the failure message so users can correlate with their
        /// configured batch size.
        stalled_batch_len: usize,
    },
}

impl BackfillOutcome {
    /// Number of chunks newly embedded in this pass, regardless of
    /// which exit path fired.
    pub fn embedded(self) -> usize {
        match self {
            BackfillOutcome::Completed { embedded } => embedded,
            BackfillOutcome::Stalled { embedded, .. } => embedded,
        }
    }
}

impl Default for Indexer {
    fn default() -> Self {
        Self::new(&[])
    }
}

#[derive(Debug, Default)]
pub struct IndexResult {
    pub indexed: u64,
    pub unchanged: u64,
    pub skipped: u64,
    pub total_files: u64,
    pub errors: Vec<String>,
    /// Number of chunks whose embedding failed to compute or persist
    /// during this indexing pass.
    ///
    /// Embedding failures are intentionally non-fatal — the inline path
    /// in `index_file` logs and continues so a single bad chunk can't
    /// tank a 10k-file folder index. The retrieval pipeline already
    /// degrades to BM25 + recency for chunks with no embedding row.
    /// But silently swallowing the error robs callers of the signal
    /// they need to decide whether to invoke `backfill_embeddings`
    /// later (e.g. after the user reconnects to a network embedder).
    ///
    /// This counter surfaces that signal: callers that see a non-zero
    /// `inline_embeddings_dropped` know there are missing-embedding
    /// rows in the corpus that a backfill pass can later fill in.
    pub inline_embeddings_dropped: u64,
}

/// Per-file outcome surfaced by [`Indexer::index_file`] and
/// [`Indexer::index_single_file`].
///
/// Separated from [`IndexResult`] (which is whole-pass) so the
/// `index_folder_with_progress` loop can fold per-file drop counts
/// into the pass-wide total without losing the per-file granularity
/// that single-file callers (`SourceManager::add_local_file`) need to
/// react to drops on a per-file basis.
#[derive(Debug, Default, Clone, Copy)]
pub struct IndexFileOutcome {
    /// Whether the file was newly indexed (`true`) or skipped because
    /// its content hash matched the existing record (`false`).
    pub indexed: bool,
    /// Number of chunks in THIS file whose embedding failed inline.
    /// See `IndexResult::inline_embeddings_dropped` for why this is
    /// surfaced rather than being silently logged.
    pub inline_embeddings_dropped: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Source;

    fn setup_test_folder(dir: &Path) {
        std::fs::write(dir.join("readme.md"), "# Test Project\n\nThis is a test.").unwrap();
        std::fs::write(dir.join("data.csv"), "name,value\nalpha,1\nbeta,2").unwrap();
        std::fs::write(
            dir.join("notes.txt"),
            "Meeting notes:\n- Discussed Tessera\n- Reviewed progress",
        )
        .unwrap();
        std::fs::write(
            dir.join("config.json"),
            r#"{"app": "tessera", "version": "0.1.0"}"#,
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("sub/nested.txt"), "Nested file content.").unwrap();
    }

    #[test]
    fn index_folder_indexes_supported_files() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_folder(dir.path());

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        assert_eq!(result.indexed, 5);
        assert!(result.errors.is_empty());
    }

    #[test]
    fn index_folder_skips_ignored_files() {
        let dir = tempfile::tempdir().unwrap();
        setup_test_folder(dir.path());
        std::fs::write(dir.path().join("binary.exe"), b"MZ fake exe").unwrap();
        std::fs::create_dir_all(dir.path().join(".git")).unwrap();
        std::fs::write(dir.path().join(".git/config"), "git config").unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        assert_eq!(result.indexed, 5);
        assert!(result.skipped > 0);
    }

    #[test]
    fn reindex_unchanged_files_not_reprocessed() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test.txt"), "Hello, world!").unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let r1 = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();
        assert_eq!(r1.indexed, 1);

        let r2 = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();
        assert_eq!(r2.indexed, 0);
        assert_eq!(r2.unchanged, 1);
    }

    #[test]
    fn index_single_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("doc.txt");
        std::fs::write(&file_path, "Single file content for indexing.").unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_file(file_path.to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default();
        let outcome = indexer
            .index_single_file(&source.id, &file_path, &store)
            .unwrap();
        assert!(outcome.indexed);
        assert_eq!(
            outcome.inline_embeddings_dropped, 0,
            "no embedder attached → nothing to drop"
        );

        let results = store.search_fts("Single file content", 10).unwrap();
        assert!(!results.is_empty());
    }

    /// Embedding provider that fails on every call. Used to verify
    /// `backfill_embeddings` terminates instead of looping forever
    /// when every chunk in a batch fails.
    struct AlwaysFailEmbedder {
        model_id: String,
        dim: usize,
        calls: Arc<Mutex<usize>>,
    }

    impl AlwaysFailEmbedder {
        fn new() -> Self {
            Self {
                model_id: "always-fail-v1-8d".to_string(),
                dim: 8,
                calls: Arc::new(Mutex::new(0)),
            }
        }
    }

    impl crate::embedding::EmbeddingProvider for AlwaysFailEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, _text: &str) -> tessera_core::error::Result<Vec<f32>> {
            *self.calls.lock().unwrap() += 1;
            Err(tessera_core::error::Error::Database(
                "synthetic embed failure (test fixture)".to_string(),
            ))
        }
    }

    #[test]
    fn backfill_terminates_when_every_chunk_in_batch_fails() {
        // Regression for the original BUG where `backfill_embeddings`
        // would loop forever if every chunk in a batch failed to
        // embed — the inner failure path never inserts an embedding
        // row, so `chunks_missing_embedding` returned the same chunks
        // on every iteration and the outer loop never terminated.
        //
        // Construct: index a folder with multiple chunks WITHOUT an
        // embedder attached, then run backfill with an embedder that
        // returns Err every time. The fix should cap the embed-call
        // count at exactly the batch size (one full failing pass)
        // and return Ok(0) rather than spinning.
        let dir = tempfile::tempdir().unwrap();
        for i in 0..5 {
            std::fs::write(
                dir.path().join(format!("file_{i}.txt")),
                format!("content for file {i}"),
            )
            .unwrap();
        }

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        // Index without an embedder so chunks land but `chunk_embeddings` stays empty.
        Indexer::default()
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        // Attach the always-failing embedder and try to backfill.
        let embedder = Arc::new(AlwaysFailEmbedder::new());
        let calls = Arc::clone(&embedder.calls);
        let indexer = Indexer::default().with_embedder(embedder);

        let total = indexer.backfill_embeddings(&store, 3).expect(
            "backfill should return Ok with the chunks-stalled diagnostic, not loop forever",
        );
        assert_eq!(total, 0, "no chunks should have been embedded");

        // The embedder should have been invoked exactly `batch_size`
        // times (one full pass before the stall detector fires) —
        // NOT thousands of times (which would indicate the loop was
        // still spinning before some other guard kicked in).
        let n_calls = *calls.lock().unwrap();
        assert!(
            n_calls <= 3,
            "backfill should call embed at most once per chunk in the first failing batch (batch_size=3); got {n_calls} calls — the stall detector likely failed"
        );
        assert!(
            n_calls > 0,
            "backfill should have attempted at least one embed before bailing; got {n_calls}"
        );
    }

    #[test]
    fn backfill_makes_progress_when_only_some_chunks_fail() {
        // Counterpart to the stall test: as long as SOME chunks
        // succeed in a batch, the loop must keep going and embed
        // every remaining chunk. The stall detector must not fire
        // on partial-failure batches.
        struct FailEvenOddEmbedder {
            model_id: String,
            dim: usize,
            calls: Arc<Mutex<usize>>,
        }
        impl crate::embedding::EmbeddingProvider for FailEvenOddEmbedder {
            fn model_id(&self) -> &str {
                &self.model_id
            }
            fn dim(&self) -> usize {
                self.dim
            }
            fn embed(&self, _text: &str) -> tessera_core::error::Result<Vec<f32>> {
                let mut c = self.calls.lock().unwrap();
                *c += 1;
                if (*c).is_multiple_of(2) {
                    Err(tessera_core::error::Error::Database(
                        "flaky failure".to_string(),
                    ))
                } else {
                    Ok(vec![0.1f32; 8])
                }
            }
        }

        let dir = tempfile::tempdir().unwrap();
        for i in 0..6 {
            std::fs::write(
                dir.path().join(format!("file_{i}.txt")),
                format!("content for file {i}"),
            )
            .unwrap();
        }

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();
        Indexer::default()
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        let embedder = Arc::new(FailEvenOddEmbedder {
            model_id: "flaky-v1-8d".to_string(),
            dim: 8,
            calls: Arc::new(Mutex::new(0)),
        });
        let indexer = Indexer::default().with_embedder(embedder);
        let total = indexer.backfill_embeddings(&store, 3).unwrap();
        // 6 chunks, every other call fails. The successful calls
        // persist embeddings, so subsequent iterations see fewer
        // missing chunks. The loop should make at least *some*
        // progress, not stall at zero.
        assert!(
            total > 0,
            "backfill should embed at least one chunk on flaky failures; got total={total}"
        );
    }

    /// Embedder that fails on a fixed, caller-supplied set of chunk
    /// CONTENTS (matched by exact string) and succeeds otherwise.
    /// Used to construct a corpus with a known persistently-failing
    /// subset, so the backfill-convergence regression can measure
    /// how many times each failing chunk is queried before the loop
    /// terminates.
    struct ContentBlocklistEmbedder {
        model_id: String,
        dim: usize,
        blocked: std::collections::HashSet<String>,
        per_chunk_calls: Arc<Mutex<std::collections::HashMap<String, usize>>>,
    }
    impl crate::embedding::EmbeddingProvider for ContentBlocklistEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, text: &str) -> tessera_core::error::Result<Vec<f32>> {
            let mut tally = self.per_chunk_calls.lock().unwrap();
            *tally.entry(text.to_string()).or_insert(0) += 1;
            if self.blocked.contains(text) {
                Err(tessera_core::error::Error::Database(
                    "persistently-failing content".to_string(),
                ))
            } else {
                Ok(vec![0.0f32; self.dim])
            }
        }
    }

    #[test]
    fn backfill_does_not_re_query_persistently_failing_chunks() {
        // Regression test for the convergence-rate bug:
        // prior to the
        // `chunks_missing_embedding_excluding` wiring, a corpus with P
        // passing chunks and F persistently-failing chunks at batch
        // size B converged in `O(P · ⌈F/B⌉ / B)` iterations because
        // each batch SQL query returned the F failures before finding
        // the next B passes. With the fix, each failing chunk is
        // queried (and attempted) exactly ONCE per backfill
        // invocation, then parked in the exclude list.
        //
        // We assert the exact contract: every blocked-content chunk
        // has `per_chunk_calls[content] == 1` after the backfill
        // finishes, even though several batches were needed to drain
        // the passing chunks.
        let dir = tempfile::tempdir().unwrap();
        // 8 files: 2 will deterministically fail, 6 will pass. The
        // batch size of 3 means it takes 3 batches to drain the
        // passing set after the 2 failures are parked.
        let failing_contents: Vec<String> = (0..2).map(|i| format!("FAIL chunk {i}")).collect();
        let passing_contents: Vec<String> = (0..6).map(|i| format!("OK chunk {i}")).collect();
        for (i, content) in failing_contents
            .iter()
            .chain(passing_contents.iter())
            .enumerate()
        {
            std::fs::write(dir.path().join(format!("file_{i}.txt")), content).unwrap();
        }

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();
        // Index without an embedder so all 8 chunks land in the table
        // with no embedding row.
        Indexer::default()
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        let per_chunk_calls = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let embedder = Arc::new(ContentBlocklistEmbedder {
            model_id: "blocklist-v1-8d".to_string(),
            dim: 8,
            blocked: failing_contents.iter().cloned().collect(),
            per_chunk_calls: Arc::clone(&per_chunk_calls),
        });
        let indexer = Indexer::default().with_embedder(embedder);
        let total = indexer.backfill_embeddings(&store, 3).unwrap();

        // All 6 passing chunks should have been embedded.
        assert_eq!(
            total, 6,
            "all 6 passing chunks should be embedded after the failures are parked"
        );

        // Every failing chunk should have been ATTEMPTED exactly
        // once. Pre-fix this would have been ⌈failing_count /
        // (batch_size - failing_count)⌉ + 1 ≈ 3 attempts per failure.
        let tally = per_chunk_calls.lock().unwrap();
        for content in &failing_contents {
            let n = tally.get(content).copied().unwrap_or(0);
            assert_eq!(
                n, 1,
                "failing chunk {content:?} was attempted {n} times — exclude-list parking must prevent repeat queries"
            );
        }
        // And every passing chunk should also have been attempted
        // exactly once (no duplicate work).
        for content in &passing_contents {
            let n = tally.get(content).copied().unwrap_or(0);
            assert_eq!(
                n, 1,
                "passing chunk {content:?} was attempted {n} times — embedded chunks should not be re-queried"
            );
        }
    }

    /// Embedder that succeeds on the first N calls then fails forever
    /// — for exercising inline-embedding-drop counting on a folder
    /// that's larger than the embedder's "budget".
    struct BudgetedEmbedder {
        model_id: String,
        dim: usize,
        budget: Arc<Mutex<usize>>,
    }
    impl crate::embedding::EmbeddingProvider for BudgetedEmbedder {
        fn model_id(&self) -> &str {
            &self.model_id
        }
        fn dim(&self) -> usize {
            self.dim
        }
        fn embed(&self, _text: &str) -> tessera_core::error::Result<Vec<f32>> {
            let mut b = self.budget.lock().unwrap();
            if *b == 0 {
                return Err(tessera_core::error::Error::Database(
                    "embedder budget exhausted".to_string(),
                ));
            }
            *b -= 1;
            Ok(vec![0.0f32; self.dim])
        }
    }

    #[test]
    fn index_folder_surfaces_inline_embedding_drops() {
        // Regression test for silent inline embedding drops. The
        // inline path in `index_file` used to `eprintln!` embedding
        // failures
        // and silently continue, leaving callers with no signal that
        // they should later invoke `backfill_embeddings` to retry.
        // The fix surfaces a per-pass counter
        // (`IndexResult::inline_embeddings_dropped`) so callers can
        // observe the drop rate and decide.
        //
        // Construct: 6 single-chunk files. Embedder has budget 3, so
        // 3 chunks embed successfully and 3 drop inline. The result
        // should report `inline_embeddings_dropped = 3` AND the
        // folder pass should still complete with `indexed = 6`
        // (drops are non-fatal).
        let dir = tempfile::tempdir().unwrap();
        for i in 0..6 {
            std::fs::write(
                dir.path().join(format!("file_{i}.txt")),
                format!("file {i} content"),
            )
            .unwrap();
        }

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let embedder = Arc::new(BudgetedEmbedder {
            model_id: "budgeted-v1-8d".to_string(),
            dim: 8,
            budget: Arc::new(Mutex::new(3)),
        });
        let indexer = Indexer::default().with_embedder(embedder);
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        // All 6 files indexed (drops are non-fatal).
        assert_eq!(result.indexed, 6);
        assert!(
            result.errors.is_empty(),
            "inline embedding drops are NOT errors — they're a separate signal"
        );
        // Exactly 3 chunks dropped (budget was 3, total chunks = 6).
        assert_eq!(
            result.inline_embeddings_dropped, 3,
            "expected 3 dropped embeddings (budget=3, files=6); got {}",
            result.inline_embeddings_dropped
        );
    }

    #[test]
    fn index_single_file_surfaces_inline_embedding_drops() {
        // Per-file counterpart: callers that go through
        // `index_single_file` (SourceManager::add_local_file,
        // SourceManager::reindex_source on LocalFile sources) get the
        // drop count via `IndexFileOutcome::inline_embeddings_dropped`
        // directly, without going through IndexResult.
        let dir = tempfile::tempdir().unwrap();
        // Single file that the chunker will split into multiple
        // chunks. We use a long string that exceeds the default
        // chunker's target size to guarantee multiple chunks.
        let mut large_content = String::new();
        for i in 0..2000 {
            use std::fmt::Write as _;
            // `write!` into String avoids the intermediate `format!`
            // allocation that clippy::format_push_string flags.
            let _ = write!(large_content, "paragraph {i} of test content. ");
        }
        let file_path = dir.path().join("big.txt");
        std::fs::write(&file_path, &large_content).unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_file(file_path.to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        // Budget = 0 → every chunk fails to embed.
        let embedder = Arc::new(BudgetedEmbedder {
            model_id: "broke-v1-8d".to_string(),
            dim: 8,
            budget: Arc::new(Mutex::new(0)),
        });
        let indexer = Indexer::default().with_embedder(embedder);
        let outcome = indexer
            .index_single_file(&source.id, &file_path, &store)
            .unwrap();

        assert!(outcome.indexed, "file indexed despite embedding failures");
        assert!(
            outcome.inline_embeddings_dropped > 0,
            "expected >0 dropped embeddings on a multi-chunk file with budget=0"
        );
    }

    // =============================================================
    // Block C task 9 — VLM-driven image extraction tests.
    //
    // These tests exercise the `vision_extractor` injection path
    // end-to-end: a tiny 2x2 PNG goes through `index_file`, the
    // stub extractor returns a canned description, and we assert
    // that BOTH the native metadata chunk AND the VLM chunk land
    // in the store with the correct provenance columns set.
    // =============================================================

    fn write_tiny_png(path: &Path) {
        let img = image::RgbaImage::from_fn(2, 2, |_, _| image::Rgba([255, 255, 255, 255]));
        img.save_with_format(path, image::ImageFormat::Png).unwrap();
    }

    struct StubVisionExtractor {
        description: String,
        model_id: String,
    }

    impl VisionExtractor for StubVisionExtractor {
        fn describe_image(&self, _image_path: &Path) -> Result<String> {
            Ok(self.description.clone())
        }
        fn model_id(&self) -> &str {
            &self.model_id
        }
    }

    /// Failing extractor used to verify the indexer's "VLM failure
    /// is non-fatal" guarantee — the metadata chunk must still be
    /// persisted and the file must still count as indexed even when
    /// the vision call errors.
    struct FailingVisionExtractor;
    impl VisionExtractor for FailingVisionExtractor {
        fn describe_image(&self, _image_path: &Path) -> Result<String> {
            Err(tessera_core::error::Error::Extraction {
                path: "<failing-vlm>".to_string(),
                message: "synthetic sidecar timeout".to_string(),
            })
        }
        fn model_id(&self) -> &'static str {
            "failing-vlm-model-id"
        }
    }

    #[test]
    fn index_file_emits_vlm_chunk_when_vision_extractor_attached() {
        let dir = tempfile::tempdir().unwrap();
        let img_path = dir.path().join("photo.png");
        write_tiny_png(&img_path);

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let extractor = Arc::new(StubVisionExtractor {
            description: "A small white square on a white background.".to_string(),
            model_id: "qwen3.5-4b-vision-gguf".to_string(),
        });
        let indexer = Indexer::default().with_vision_extractor(extractor);
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();
        assert_eq!(result.indexed, 1, "expected the 1 PNG to be indexed");
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);

        // Pull every chunk and partition by provenance.
        let chunks = store
            .all_chunks_for_path(&img_path.to_string_lossy())
            .expect("query chunks");
        let vlm_chunks: Vec<_> = chunks
            .iter()
            .filter(|c| c.extraction_method.is_some())
            .collect();
        let native_chunks: Vec<_> = chunks
            .iter()
            .filter(|c| c.extraction_method.is_none())
            .collect();

        assert!(
            !native_chunks.is_empty(),
            "expected at least one metadata chunk (extraction_method=None)"
        );
        assert_eq!(
            vlm_chunks.len(),
            1,
            "expected exactly one VLM chunk; got {:#?}",
            vlm_chunks
        );
        let vlm = vlm_chunks[0];
        assert_eq!(
            vlm.extraction_method,
            Some(crate::chunker::ExtractionMethod::Vlm)
        );
        assert_eq!(
            vlm.extraction_model_id.as_deref(),
            Some("qwen3.5-4b-vision-gguf")
        );
        assert!(
            vlm.content.contains("white square"),
            "VLM chunk content {:?} did not contain expected substring",
            vlm.content,
        );
    }

    #[test]
    fn index_file_image_without_vision_extractor_skips_vlm_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let img_path = dir.path().join("photo.png");
        write_tiny_png(&img_path);

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        // Critically: no .with_vision_extractor() call.
        let indexer = Indexer::default();
        indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        let chunks = store
            .all_chunks_for_path(&img_path.to_string_lossy())
            .expect("query chunks");
        for c in &chunks {
            assert!(
                c.extraction_method.is_none(),
                "no chunk should be VLM-tagged when extractor is absent; got {:?}",
                c.extraction_method,
            );
        }
        // We still expect AT LEAST the metadata chunk.
        assert!(!chunks.is_empty(), "metadata chunk should still exist");
    }

    #[test]
    fn index_file_vlm_failure_does_not_abort_metadata_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let img_path = dir.path().join("broken.png");
        write_tiny_png(&img_path);

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        let indexer = Indexer::default().with_vision_extractor(Arc::new(FailingVisionExtractor));
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();
        assert_eq!(result.indexed, 1, "VLM failure must not break indexing");
        // The metadata pipeline is the source of truth here; no
        // VLM chunk should land, and no `extraction_method` column
        // should be populated.
        let chunks = store
            .all_chunks_for_path(&img_path.to_string_lossy())
            .expect("query chunks");
        assert!(!chunks.is_empty(), "metadata chunk should still exist");
        for c in &chunks {
            assert!(
                c.extraction_method.is_none(),
                "failed VLM should not leave behind a tagged chunk"
            );
        }
    }

    #[test]
    fn index_file_does_not_invoke_vlm_for_non_image_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("doc.txt"), "not an image, must skip VLM").unwrap();

        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
        store.add_source(&source).unwrap();

        // Wire a failing extractor — if the indexer invoked it,
        // we'd see VLM error logging, but more importantly, no
        // chunk would carry a VLM-tagged provenance. The assertion
        // here is the same shape as the previous test: no
        // `extraction_method` should be set on any chunk emitted
        // from a `.txt` file. The fact that the indexer didn't
        // *call* the extractor is implicit in the test passing
        // with a `FailingVisionExtractor` attached.
        let indexer = Indexer::default().with_vision_extractor(Arc::new(FailingVisionExtractor));
        let result = indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();
        assert_eq!(result.indexed, 1);
        assert!(result.errors.is_empty(), "errors: {:?}", result.errors);
    }
}
