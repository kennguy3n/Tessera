//! Indexing progress tracker.
//!
//! `crate::indexer::Indexer` runs synchronously (one folder, one
//! thread) but can take a while on large folders. The UI wants to
//! show a progress bar while it runs, so we expose a small
//! lock-protected snapshot the bridge can poll on a timer without
//! threading callbacks across the N-API boundary.
//!
//! Lifecycle:
//!   1. `IndexerSession::start(source_id)` — set status to
//!      `Running`, reset counters.
//!   2. The indexer calls `record_scanned`, `record_indexed`,
//!      `record_unchanged`, `record_skipped`, `record_error` as it
//!      walks the tree.
//!   3. `finish(total_files)` flips status to `Done` so the UI
//!      knows to stop polling.
//!
//! All updates are cheap (Mutex + plain counters) so this is safe
//! to call on every file. Per-source snapshots live inside a
//! `HashMap<SourceId, Arc<Mutex<ProgressSnapshot>>>` so multiple
//! reindexes can run in parallel from the bridge layer (e.g.
//! scheduled automations + a user-triggered reindex on a different
//! source).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tessera_core::SourceId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexStatus {
    Idle,
    Running,
    Done,
    Failed,
}

/// Optional sub-phase of an indexing pass. The bulk of indexing is
/// uniform "walk + extract + chunk" work but a few stages (notably
/// VLM image description and PDF OCR) take seconds-to-minutes per
/// file, so the UI shows a separate label for them. The phase is
/// `None` while the pass is doing ordinary text extraction.
///
/// Wire-format is stable (`describing_images`, `ocr_pdf`,
/// `describing_charts`) so the renderer's i18n strings can map
/// directly off this enum without an additional translation layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexPhase {
    /// Generic text-only extraction (txt/md/csv/json/html/xlsx) and
    /// per-image metadata extraction. The "default" state.
    Scanning,
    /// Running a VLM over an image file to produce a natural-language
    /// description chunk. Slow (seconds per file). Block C task 9.
    DescribingImages,
    /// Running a VLM over scanned-PDF pages to OCR them into text
    /// chunks. Slow + rate-limited. Block C task 10.
    OcrPdf,
    /// Running a VLM over detected chart images to produce
    /// structured descriptions. Medium+ tier only. Block C task 11.
    DescribingCharts,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgressSnapshot {
    pub status: IndexStatus,
    pub scanned: u64,
    pub indexed: u64,
    pub unchanged: u64,
    pub skipped: u64,
    pub errors: u64,
    /// Final file count when `status == Done`. Zero while running.
    pub total_files: u64,
    /// Latest in-flight file path, when known. Helpful for the UI
    /// to show "Indexing src/big-file.pdf" while a long file is
    /// being chunked.
    pub current_path: Option<String>,
    /// Optional human-readable failure reason populated by
    /// `mark_failed`. Empty on success or while running.
    pub last_error: Option<String>,
    /// Current sub-phase. The default `Scanning` covers the
    /// bulk of indexing work; the indexer flips this to the
    /// VLM-specific variants for the (slow) image / OCR / chart
    /// passes so the UI can show a more accurate label.
    pub phase: IndexPhase,
}

impl Default for ProgressSnapshot {
    fn default() -> Self {
        Self {
            status: IndexStatus::Idle,
            scanned: 0,
            indexed: 0,
            unchanged: 0,
            skipped: 0,
            errors: 0,
            total_files: 0,
            current_path: None,
            last_error: None,
            phase: IndexPhase::Scanning,
        }
    }
}

#[derive(Default, Debug)]
pub struct ProgressTracker {
    inner: Mutex<HashMap<SourceId, Arc<Mutex<ProgressSnapshot>>>>,
}

impl ProgressTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Get (or insert) the per-source slot. The returned handle
    /// can be cloned cheaply and updated concurrently from the
    /// indexer thread.
    pub fn slot(&self, source_id: &SourceId) -> Arc<Mutex<ProgressSnapshot>> {
        let mut guard = self.inner.lock().expect("tracker mutex poisoned");
        guard
            .entry(*source_id)
            .or_insert_with(|| Arc::new(Mutex::new(ProgressSnapshot::default())))
            .clone()
    }

    /// Reset and mark `Running` at the start of an index pass.
    pub fn start(&self, source_id: &SourceId) -> Arc<Mutex<ProgressSnapshot>> {
        let slot = self.slot(source_id);
        let mut s = slot.lock().expect("snapshot mutex poisoned");
        *s = ProgressSnapshot {
            status: IndexStatus::Running,
            ..ProgressSnapshot::default()
        };
        drop(s);
        slot
    }

    /// Public read-only snapshot for the IPC layer. Returns the
    /// idle snapshot if nothing has been indexed for this source.
    pub fn snapshot(&self, source_id: &SourceId) -> ProgressSnapshot {
        let guard = self.inner.lock().expect("tracker mutex poisoned");
        guard
            .get(source_id)
            .map(|s| s.lock().expect("snapshot mutex poisoned").clone())
            .unwrap_or_default()
    }
}

/// Convenience helpers so the indexer doesn't have to reach into
/// the Mutex by hand. Each call is a single short critical section.
pub fn record_scanned(slot: &Arc<Mutex<ProgressSnapshot>>, path: &str) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.scanned = s.scanned.saturating_add(1);
    s.current_path = Some(path.to_string());
}

pub fn record_indexed(slot: &Arc<Mutex<ProgressSnapshot>>) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.indexed = s.indexed.saturating_add(1);
}

pub fn record_unchanged(slot: &Arc<Mutex<ProgressSnapshot>>) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.unchanged = s.unchanged.saturating_add(1);
}

pub fn record_skipped(slot: &Arc<Mutex<ProgressSnapshot>>) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.skipped = s.skipped.saturating_add(1);
}

pub fn record_error(slot: &Arc<Mutex<ProgressSnapshot>>) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.errors = s.errors.saturating_add(1);
}

/// Update the current sub-phase. Cheap to call (single short
/// critical section). Used by the indexer to signal entering /
/// leaving slow VLM passes so the UI can show a more accurate
/// label than the generic "Scanning" default.
///
/// Pairs with `record_phase_scanning` which resets to the default
/// in a finally-style block — callers MUST reset to `Scanning`
/// after the VLM pass completes, otherwise the UI will keep
/// showing "Describing images" through the rest of the indexing
/// pass.
pub fn record_phase(slot: &Arc<Mutex<ProgressSnapshot>>, phase: IndexPhase) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.phase = phase;
}

pub fn finish(slot: &Arc<Mutex<ProgressSnapshot>>, total_files: u64) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.status = IndexStatus::Done;
    s.total_files = total_files;
    s.current_path = None;
    s.phase = IndexPhase::Scanning;
}

pub fn mark_failed(slot: &Arc<Mutex<ProgressSnapshot>>, error: &str) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.status = IndexStatus::Failed;
    s.last_error = Some(error.to_string());
    s.current_path = None;
}

// =====================================================================
// Embedding backfill progress
// =====================================================================
//
// The indexing tracker above is per-source — multiple folders can reindex
// concurrently, each with its own counters. Embedding backfill is
// fundamentally different: it operates over the entire corpus (any chunk
// missing an embedding for the current model) rather than over a single
// source, and runs as a single global pass. A second concurrent invocation
// would just race over the same row set, so we expose a single shared
// snapshot rather than a per-source map.
//
// The UI polls `EmbeddingProgressSnapshot` on a short interval (same
// pattern as `ProgressSnapshot`) so the renderer can show a determinate
// progress bar (`embedded / total_chunks`) plus a failure count without
// keeping a long-lived IPC subscription open. Status transitions follow
// the same `Idle → Running → (Done | Failed)` lifecycle so the renderer
// can reuse its existing polling machinery.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmbeddingStatus {
    Idle,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EmbeddingProgressSnapshot {
    pub status: EmbeddingStatus,
    /// Total chunks the current backfill pass intended to embed at
    /// the moment `start` was called. Snapshotted once and kept
    /// constant for the duration of the pass so the UI shows a
    /// stable denominator.
    pub total_chunks: u64,
    /// Chunks that were successfully embedded and persisted by the
    /// current (or most recent) pass.
    pub embedded: u64,
    /// Chunks the embedder returned `Err` for during the current
    /// (or most recent) pass. Embedding failures are non-fatal —
    /// retrieval still works via BM25 + recency — but the count is
    /// surfaced so the user knows their corpus has unembedded chunks
    /// they may want to investigate.
    pub failed: u64,
    /// `model_id` of the embedder the current (or most recent) pass
    /// was targeting. `None` when no pass has been started since
    /// the bridge process came up.
    pub model_id: Option<String>,
    /// Human-readable failure reason populated by [`mark_embedding_failed`].
    /// Empty in `Idle` / `Running` / `Done` states.
    pub last_error: Option<String>,
}

impl Default for EmbeddingProgressSnapshot {
    fn default() -> Self {
        Self {
            status: EmbeddingStatus::Idle,
            total_chunks: 0,
            embedded: 0,
            failed: 0,
            model_id: None,
            last_error: None,
        }
    }
}

#[derive(Default, Debug)]
pub struct EmbeddingProgressTracker {
    inner: Mutex<EmbeddingProgressSnapshot>,
}

impl EmbeddingProgressTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reset state and mark `Running` at the start of a backfill pass.
    /// Returns a slot the caller can hand to the helper functions
    /// below for cheap per-chunk progress updates.
    pub fn start(&self, total_chunks: u64, model_id: &str) -> &Mutex<EmbeddingProgressSnapshot> {
        let mut s = self.inner.lock().expect("embedding tracker poisoned");
        *s = EmbeddingProgressSnapshot {
            status: EmbeddingStatus::Running,
            total_chunks,
            embedded: 0,
            failed: 0,
            model_id: Some(model_id.to_string()),
            last_error: None,
        };
        drop(s);
        &self.inner
    }

    /// Pre-flight reset called *before* a backfill is dispatched to a
    /// worker thread. Flips status to `Running` and zeroes the
    /// counters, but does NOT require `total_chunks` / `model_id` —
    /// the worker thread will overwrite those via [`start`] once it
    /// has acquired its locks and computed the real numbers.
    ///
    /// The reason this method exists, despite [`start`] doing
    /// strictly more, is a race condition in the napi bridge's
    /// `AsyncTask` flow:
    ///
    /// 1. The renderer clicks "Re-embed" — the IPC handler calls
    ///    `bridge_backfill_embeddings`, which immediately returns
    ///    an `AsyncTask` to be scheduled on a libuv worker thread.
    /// 2. The renderer simultaneously bumps the polling generation
    ///    and starts hitting `bridge_get_embedding_progress` on the
    ///    JS main thread.
    /// 3. Before the worker thread has had a chance to acquire the
    ///    `SourceManager` lock and call [`start`], the first poll
    ///    response observes the *previous* run's terminal state
    ///    (`Done` or `Failed`) — because that's still what's in the
    ///    snapshot from last time.
    /// 4. The renderer's `useEmbeddingProgress` hook treats `Done`
    ///    /`Failed` as terminal and stops polling. The user never
    ///    sees the in-flight progress for the new backfill.
    ///
    /// Calling `mark_starting` synchronously on the main thread
    /// *before* the napi function returns the `AsyncTask` flips the
    /// snapshot to `Running` so any poll that races with the worker
    /// thread's `start()` sees an in-progress run rather than the
    /// stale terminal status. The worker thread's subsequent
    /// `start()` will overwrite `total_chunks` and `model_id` with
    /// the real values once it knows them.
    pub fn mark_starting(&self) {
        let mut s = self.inner.lock().expect("embedding tracker poisoned");
        *s = EmbeddingProgressSnapshot {
            status: EmbeddingStatus::Running,
            total_chunks: 0,
            embedded: 0,
            failed: 0,
            // Leave `model_id` empty — the worker thread will populate
            // it via [`start`] once it has read the active provider.
            // Until then the renderer's progress card just shows
            // generic "starting" copy without a model label.
            model_id: None,
            last_error: None,
        };
    }

    /// Read-only snapshot for the IPC poll loop.
    pub fn snapshot(&self) -> EmbeddingProgressSnapshot {
        self.inner
            .lock()
            .expect("embedding tracker poisoned")
            .clone()
    }
}

/// Record one chunk successfully embedded. Saturating add so a
/// pathologically large corpus can't overflow.
pub fn record_chunk_embedded(slot: &Mutex<EmbeddingProgressSnapshot>) {
    let mut s = slot.lock().expect("embedding snapshot poisoned");
    s.embedded = s.embedded.saturating_add(1);
}

/// Record one chunk that failed to embed.
pub fn record_chunk_embed_failed(slot: &Mutex<EmbeddingProgressSnapshot>) {
    let mut s = slot.lock().expect("embedding snapshot poisoned");
    s.failed = s.failed.saturating_add(1);
}

/// Flip status to `Done`. Called when the backfill loop exits
/// normally (no more chunks to embed or per-batch stall detector
/// tripped). `total_chunks` is left as-is so the renderer can show
/// `embedded / total_chunks` after completion.
pub fn finish_embedding(slot: &Mutex<EmbeddingProgressSnapshot>) {
    let mut s = slot.lock().expect("embedding snapshot poisoned");
    s.status = EmbeddingStatus::Done;
}

/// Flip status to `Failed` and record the error message. Reserved
/// for whole-pass failures (e.g. the DB connection died); per-chunk
/// errors should call [`record_chunk_embed_failed`] instead so the
/// pass keeps making progress on the other chunks.
pub fn mark_embedding_failed(slot: &Mutex<EmbeddingProgressSnapshot>, error: &str) {
    let mut s = slot.lock().expect("embedding snapshot poisoned");
    s.status = EmbeddingStatus::Failed;
    s.last_error = Some(error.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sid() -> SourceId {
        SourceId(uuid::Uuid::new_v4())
    }

    #[test]
    fn idle_snapshot_for_unknown_source() {
        let t = ProgressTracker::new();
        let snap = t.snapshot(&sid());
        assert_eq!(snap.status, IndexStatus::Idle);
        assert_eq!(snap.indexed, 0);
    }

    #[test]
    fn start_then_record_and_finish() {
        let t = ProgressTracker::new();
        let id = sid();
        let slot = t.start(&id);
        record_scanned(&slot, "a.md");
        record_indexed(&slot);
        record_scanned(&slot, "b.md");
        record_unchanged(&slot);
        record_skipped(&slot);
        record_error(&slot);
        finish(&slot, 2);

        let snap = t.snapshot(&id);
        assert_eq!(snap.status, IndexStatus::Done);
        assert_eq!(snap.scanned, 2);
        assert_eq!(snap.indexed, 1);
        assert_eq!(snap.unchanged, 1);
        assert_eq!(snap.skipped, 1);
        assert_eq!(snap.errors, 1);
        assert_eq!(snap.total_files, 2);
        assert!(snap.current_path.is_none());
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn mark_failed_sets_error_message() {
        let t = ProgressTracker::new();
        let id = sid();
        let slot = t.start(&id);
        mark_failed(&slot, "io error");
        let snap = t.snapshot(&id);
        assert_eq!(snap.status, IndexStatus::Failed);
        assert_eq!(snap.last_error.as_deref(), Some("io error"));
    }

    #[test]
    fn restart_resets_counters() {
        let t = ProgressTracker::new();
        let id = sid();
        let slot = t.start(&id);
        record_indexed(&slot);
        finish(&slot, 1);
        // Start a fresh pass.
        let slot2 = t.start(&id);
        let snap = t.snapshot(&id);
        assert_eq!(snap.status, IndexStatus::Running);
        assert_eq!(snap.indexed, 0);
        record_indexed(&slot2);
        record_indexed(&slot2);
        finish(&slot2, 2);
        assert_eq!(t.snapshot(&id).indexed, 2);
    }

    // ----------------------------------------------------------------
    // EmbeddingProgressTracker tests
    // ----------------------------------------------------------------

    #[test]
    fn embedding_idle_snapshot_before_any_start() {
        let t = EmbeddingProgressTracker::new();
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Idle);
        assert_eq!(snap.total_chunks, 0);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert!(snap.model_id.is_none());
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn embedding_start_initializes_running_state() {
        let t = EmbeddingProgressTracker::new();
        let _slot = t.start(42, "hash-trick-v1@256");
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Running);
        assert_eq!(snap.total_chunks, 42);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert_eq!(snap.model_id.as_deref(), Some("hash-trick-v1@256"));
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn embedding_record_embedded_and_failed_increment_counters() {
        let t = EmbeddingProgressTracker::new();
        let slot = t.start(5, "hash-trick-v1@256");
        record_chunk_embedded(slot);
        record_chunk_embedded(slot);
        record_chunk_embedded(slot);
        record_chunk_embed_failed(slot);
        record_chunk_embed_failed(slot);
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Running);
        assert_eq!(snap.total_chunks, 5);
        assert_eq!(snap.embedded, 3);
        assert_eq!(snap.failed, 2);
    }

    #[test]
    fn embedding_finish_flips_status_done_preserves_counters() {
        let t = EmbeddingProgressTracker::new();
        let slot = t.start(10, "hash-trick-v1@256");
        for _ in 0..7 {
            record_chunk_embedded(slot);
        }
        record_chunk_embed_failed(slot);
        finish_embedding(slot);
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Done);
        // Denominator preserved so the UI can show "7/10 embedded".
        assert_eq!(snap.total_chunks, 10);
        assert_eq!(snap.embedded, 7);
        assert_eq!(snap.failed, 1);
    }

    #[test]
    fn embedding_mark_failed_records_error_and_preserves_counters() {
        let t = EmbeddingProgressTracker::new();
        let slot = t.start(20, "hash-trick-v1@256");
        record_chunk_embedded(slot);
        record_chunk_embedded(slot);
        mark_embedding_failed(slot, "sqlite write failed: disk full");
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Failed);
        // Counters survive the fatal flip so the UI can show how far the
        // pass got before it died.
        assert_eq!(snap.embedded, 2);
        assert_eq!(snap.total_chunks, 20);
        assert_eq!(
            snap.last_error.as_deref(),
            Some("sqlite write failed: disk full"),
        );
    }

    #[test]
    fn embedding_restart_after_done_resets_counters_and_model() {
        let t = EmbeddingProgressTracker::new();
        let slot = t.start(5, "hash-trick-v1@256");
        for _ in 0..5 {
            record_chunk_embedded(slot);
        }
        finish_embedding(slot);
        assert_eq!(t.snapshot().status, EmbeddingStatus::Done);

        // Re-start with a fresh model_id; counters should reset to 0.
        let _slot2 = t.start(8, "transformer-v1@384");
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Running);
        assert_eq!(snap.total_chunks, 8);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert_eq!(snap.model_id.as_deref(), Some("transformer-v1@384"));
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn embedding_restart_after_failed_clears_error() {
        let t = EmbeddingProgressTracker::new();
        let slot = t.start(3, "hash-trick-v1@256");
        mark_embedding_failed(slot, "boom");
        assert_eq!(t.snapshot().status, EmbeddingStatus::Failed);

        // A subsequent start must wipe the prior error message — the new
        // pass shouldn't show a stale "boom" to the user.
        let _slot2 = t.start(3, "hash-trick-v1@256");
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Running);
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn embedding_mark_starting_resets_terminal_state_without_total_or_model() {
        // Regression test for the race fixed by introducing
        // `mark_starting`: the napi bridge calls this method on the
        // JS main thread *before* dispatching the backfill `AsyncTask`
        // to a worker thread, so the very first
        // `bridge_get_embedding_progress` poll from the renderer
        // doesn't observe the previous run's terminal status (`Done`
        // / `Failed`) and prematurely give up.
        let t = EmbeddingProgressTracker::new();

        // Simulate a prior run that finished `Done` with non-zero
        // counters and a populated model id.
        let slot = t.start(7, "hash-trick-v1@256");
        for _ in 0..7 {
            record_chunk_embedded(slot);
        }
        finish_embedding(slot);
        let prior = t.snapshot();
        assert_eq!(prior.status, EmbeddingStatus::Done);
        assert_eq!(prior.embedded, 7);
        assert_eq!(prior.model_id.as_deref(), Some("hash-trick-v1@256"));

        // Now the user clicks "Re-embed" again — the napi bridge
        // calls mark_starting() before returning the AsyncTask.
        t.mark_starting();
        let after = t.snapshot();

        // The snapshot must look like an in-progress run with zeroed
        // counters so the renderer's hook doesn't trip the
        // terminal-state guard. We deliberately do NOT require
        // total_chunks / model_id at this stage — the worker thread
        // will fill those in via the usual start() call when it gets
        // around to it.
        assert_eq!(after.status, EmbeddingStatus::Running);
        assert_eq!(after.embedded, 0);
        assert_eq!(after.failed, 0);
        assert_eq!(after.total_chunks, 0);
        assert!(after.model_id.is_none());
        assert!(after.last_error.is_none());
    }

    #[test]
    fn embedding_mark_starting_overwrites_failed_state_and_clears_error() {
        let t = EmbeddingProgressTracker::new();
        let slot = t.start(3, "hash-trick-v1@256");
        mark_embedding_failed(slot, "embedder crashed");

        let pre = t.snapshot();
        assert_eq!(pre.status, EmbeddingStatus::Failed);
        assert_eq!(pre.last_error.as_deref(), Some("embedder crashed"));

        // mark_starting must wipe the prior error so the renderer
        // doesn't render a stale "embedder crashed" banner while the
        // new pass is starting up.
        t.mark_starting();
        let post = t.snapshot();
        assert_eq!(post.status, EmbeddingStatus::Running);
        assert!(post.last_error.is_none());
    }

    #[test]
    fn embedding_mark_starting_then_full_start_yields_normal_running_state() {
        // The contract is: napi main thread calls mark_starting(),
        // then worker thread later calls start(N, model). The final
        // snapshot must look exactly like a normal start() — no
        // ghost values from mark_starting bleeding through.
        let t = EmbeddingProgressTracker::new();
        t.mark_starting();
        let _slot = t.start(42, "hash-trick-v1@256");
        let snap = t.snapshot();
        assert_eq!(snap.status, EmbeddingStatus::Running);
        assert_eq!(snap.total_chunks, 42);
        assert_eq!(snap.embedded, 0);
        assert_eq!(snap.failed, 0);
        assert_eq!(snap.model_id.as_deref(), Some("hash-trick-v1@256"));
        assert!(snap.last_error.is_none());
    }

    #[test]
    fn embedding_concurrent_recording_serialized_by_mutex() {
        // The slot returned by `start()` is shared across threads (a
        // backfill worker pool would call `record_chunk_embedded` from
        // multiple threads on the same slot). Verify the mutex
        // serializes increments correctly with no lost updates.
        use std::thread;

        let t = std::sync::Arc::new(EmbeddingProgressTracker::new());
        const TOTAL: u64 = 1_000;
        const THREADS: u64 = 4;
        const PER_THREAD: u64 = TOTAL / THREADS;

        t.start(TOTAL, "hash-trick-v1@256");

        let mut handles = Vec::new();
        for _ in 0..THREADS {
            let tracker = std::sync::Arc::clone(&t);
            handles.push(thread::spawn(move || {
                // SAFETY: we hold an Arc<EmbeddingProgressTracker> so the
                // inner Mutex outlives every borrow we hand to the
                // helpers. Each helper takes its own short critical
                // section.
                for _ in 0..PER_THREAD {
                    record_chunk_embedded(&tracker.inner);
                }
            }));
        }
        for h in handles {
            h.join().expect("worker thread panicked");
        }

        let snap = t.snapshot();
        assert_eq!(snap.embedded, TOTAL);
        assert_eq!(snap.failed, 0);
    }
}
