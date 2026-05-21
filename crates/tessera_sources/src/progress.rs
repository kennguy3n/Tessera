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
            .entry(source_id.clone())
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

pub fn finish(slot: &Arc<Mutex<ProgressSnapshot>>, total_files: u64) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.status = IndexStatus::Done;
    s.total_files = total_files;
    s.current_path = None;
}

pub fn mark_failed(slot: &Arc<Mutex<ProgressSnapshot>>, error: &str) {
    let mut s = slot.lock().expect("snapshot mutex poisoned");
    s.status = IndexStatus::Failed;
    s.last_error = Some(error.to_string());
    s.current_path = None;
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
}
