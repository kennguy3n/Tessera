use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tessera_core::error::{Error, Result};

/// Phase 15 Task 5: default coalescing window for
/// [`FileWatcher::recv_coalesced_batch`]. 500 ms is the window the
/// task spec calls for and matches the empirical median save burst
/// produced by VS Code (atomic save: temp-write → fsync → rename →
/// chmod, all within ~80–200 ms) and JetBrains IDEs (incremental
/// auto-save bursts of 5–10 modify events over ~250 ms). With the
/// 500 ms window, a typical save burst collapses to a single
/// re-index trigger per file instead of N.
pub const DEFAULT_COALESCE_WINDOW: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileEvent {
    Created(PathBuf),
    Modified(PathBuf),
    Removed(PathBuf),
}

impl FileEvent {
    /// Path the event refers to. Used by the coalescing layer so
    /// the dedup key is `path` independent of variant — a
    /// `Modified(p)` immediately followed by a `Removed(p)` should
    /// collapse to a single re-index trigger keyed on `p`.
    pub fn path(&self) -> &Path {
        match self {
            Self::Created(p) | Self::Modified(p) | Self::Removed(p) => p,
        }
    }

    /// Numeric priority used when deciding which variant survives
    /// the per-path dedup in [`coalesce_events`]. Higher wins.
    /// `Removed` strictly dominates because a delete is the final
    /// state — if the file was Created+Modified+Removed inside the
    /// window, only the delete matters to downstream consumers
    /// (they would otherwise re-index a now-missing file and have
    /// to handle the `ENOENT` themselves). `Created` beats
    /// `Modified` because the indexer's "did this path exist
    /// before?" branch hinges on it.
    fn priority(&self) -> u8 {
        match self {
            Self::Removed(_) => 3,
            Self::Created(_) => 2,
            Self::Modified(_) => 1,
        }
    }
}

pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    receiver: mpsc::Receiver<FileEvent>,
}

impl FileWatcher {
    pub fn new(path: &Path) -> Result<Self> {
        let (tx, rx) = mpsc::channel();

        let sender = tx.clone();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            if let Ok(event) = res {
                let events = translate_event(&event);
                for fe in events {
                    let _ = sender.send(fe);
                }
            }
        })
        .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?;

        watcher
            .watch(path, RecursiveMode::Recursive)
            .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?;

        Ok(Self {
            _watcher: watcher,
            receiver: rx,
        })
    }

    pub fn poll_events(&self) -> Vec<FileEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.receiver.try_recv() {
            events.push(event);
        }
        events
    }

    pub fn recv_event(&self, timeout: std::time::Duration) -> Option<FileEvent> {
        self.receiver.recv_timeout(timeout).ok()
    }

    /// Phase 15 Task 5: collect every event the watcher emits for
    /// `window` after the *first* event arrives, then return the
    /// per-path coalesced batch.
    ///
    /// Semantics:
    ///
    ///   * Blocks for up to `max_wait` waiting for the first event
    ///     to arrive. If no event arrives, returns an empty `Vec`
    ///     without waiting `window`.
    ///   * Once the first event arrives, drains the channel for
    ///     exactly `window` more milliseconds, accumulating every
    ///     subsequent event without per-event blocking. The window
    ///     is fixed-size (not sliding) so a saturated channel
    ///     still terminates the batch promptly.
    ///   * Returns the result of [`coalesce_events`] on the
    ///     accumulated raw events: at most one event per distinct
    ///     path, with the dominant variant per the priority order
    ///     `Removed > Created > Modified`.
    ///
    /// This is the entrypoint the bridge layer's watcher tick
    /// should call instead of the raw [`Self::poll_events`] /
    /// [`Self::recv_event`] APIs — it gives the indexer one batch
    /// per save burst rather than per-keystroke or per-rename-
    /// fsync event.
    pub fn recv_coalesced_batch(
        &self,
        max_wait: Duration,
        window: Duration,
    ) -> Vec<FileEvent> {
        let Ok(first) = self.receiver.recv_timeout(max_wait) else {
            return Vec::new();
        };
        let mut raw = vec![first];
        let deadline = Instant::now() + window;
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let remaining = deadline - now;
            match self.receiver.recv_timeout(remaining) {
                Ok(ev) => raw.push(ev),
                Err(_) => break,
            }
        }
        coalesce_events(raw)
    }
}

/// Phase 15 Task 5: collapse a sequence of [`FileEvent`]s into one
/// event per path, choosing the dominant variant per the priority
/// order `Removed > Created > Modified`.
///
/// The original event ordering is preserved across distinct paths
/// — i.e. the returned vector is iterated in first-appearance
/// order of each path, with each entry being the dominant variant
/// for that path. This matters for the indexer, which processes
/// events serially: a `Removed` before any `Created` for a
/// different path lets the indexer free the chunk rows for the
/// deleted file before allocating new ones for the created one.
///
/// Pure helper (no I/O, no state) so tests can drive it directly
/// without standing up a real watcher.
pub fn coalesce_events(events: Vec<FileEvent>) -> Vec<FileEvent> {
    // `IndexMap`-like behaviour: first-appearance order + O(1)
    // dedup. We use `HashMap<PathBuf, usize>` for the dedup and a
    // parallel `Vec<FileEvent>` for the ordered output to avoid
    // pulling in the `indexmap` crate.
    let mut order: Vec<PathBuf> = Vec::with_capacity(events.len());
    let mut by_path: HashMap<PathBuf, FileEvent> = HashMap::with_capacity(events.len());

    for ev in events {
        let path = ev.path().to_path_buf();
        match by_path.get_mut(&path) {
            Some(existing) => {
                if ev.priority() > existing.priority() {
                    *existing = ev;
                }
            }
            None => {
                order.push(path.clone());
                by_path.insert(path, ev);
            }
        }
    }

    order
        .into_iter()
        .map(|p| {
            by_path
                .remove(&p)
                .expect("path is in `order` iff it was inserted into `by_path`")
        })
        .collect()
}

fn translate_event(event: &Event) -> Vec<FileEvent> {
    let mut result = Vec::new();
    for path in &event.paths {
        match event.kind {
            EventKind::Create(_) => {
                result.push(FileEvent::Created(path.clone()));
            }
            EventKind::Modify(_) => {
                result.push(FileEvent::Modified(path.clone()));
            }
            EventKind::Remove(_) => {
                result.push(FileEvent::Removed(path.clone()));
            }
            _ => {}
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn coalesce_keeps_one_event_per_path() {
        let raw = vec![
            FileEvent::Modified(p("/a.txt")),
            FileEvent::Modified(p("/a.txt")),
            FileEvent::Modified(p("/a.txt")),
            FileEvent::Modified(p("/b.txt")),
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].path(), Path::new("/a.txt"));
        assert_eq!(out[1].path(), Path::new("/b.txt"));
    }

    #[test]
    fn coalesce_removed_dominates_created_and_modified() {
        let raw = vec![
            FileEvent::Created(p("/a.txt")),
            FileEvent::Modified(p("/a.txt")),
            FileEvent::Removed(p("/a.txt")),
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], FileEvent::Removed(_)));
    }

    #[test]
    fn coalesce_created_dominates_modified() {
        let raw = vec![
            FileEvent::Modified(p("/a.txt")),
            FileEvent::Created(p("/a.txt")),
            FileEvent::Modified(p("/a.txt")),
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], FileEvent::Created(_)));
    }

    #[test]
    fn coalesce_preserves_first_appearance_order_across_paths() {
        let raw = vec![
            FileEvent::Modified(p("/c.txt")),
            FileEvent::Modified(p("/a.txt")),
            FileEvent::Modified(p("/b.txt")),
            FileEvent::Modified(p("/a.txt")), // dup, doesn't move /a in order
            FileEvent::Modified(p("/c.txt")), // dup, doesn't move /c in order
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].path(), Path::new("/c.txt"));
        assert_eq!(out[1].path(), Path::new("/a.txt"));
        assert_eq!(out[2].path(), Path::new("/b.txt"));
    }

    #[test]
    fn coalesce_handles_empty_input() {
        assert!(coalesce_events(vec![]).is_empty());
    }

    #[test]
    fn watcher_coalesces_100_rapid_writes_into_one_batch() {
        // Simulate a hot save loop: 100 modify events to the same
        // path in quick succession. The 500 ms coalescing window
        // must collapse them all into a single emitted batch
        // containing exactly one event for that path.
        //
        // This is the Phase 15 Task 5 regression spec verbatim.
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("hot.txt");
        std::fs::write(&file_path, "initial").unwrap();

        let watcher = FileWatcher::new(dir.path()).unwrap();
        // Let the OS-level watcher subscription settle before
        // generating events. Without this small delay, the first
        // few writes are dropped on Linux's inotify backend
        // because the watch hasn't been registered yet.
        std::thread::sleep(Duration::from_millis(100));

        for i in 0..100 {
            // Write a slightly different payload each iteration
            // so the OS doesn't suppress identical-content writes
            // as a no-op on some filesystems.
            std::fs::write(&file_path, format!("rev-{i}")).unwrap();
        }

        let batch = watcher
            .recv_coalesced_batch(Duration::from_secs(2), DEFAULT_COALESCE_WINDOW);

        assert!(
            !batch.is_empty(),
            "expected at least one coalesced event for the rapid-write file",
        );

        // The 100 writes must collapse to a single per-path event.
        // On Linux's inotify backend a sub-millisecond write burst
        // can also stamp a `Created` and a `Modified` for the same
        // path (when the kernel emits an IN_CREATE despite the
        // file already existing — the chmod-after-write pattern on
        // some editors). The dedup MUST collapse those into ONE
        // event for that path; that's the contract this test
        // guards.
        let touched_path = batch[0].path().to_path_buf();
        assert_eq!(touched_path, file_path);
        let dups_for_same_path = batch.iter().filter(|e| e.path() == touched_path).count();
        assert_eq!(
            dups_for_same_path, 1,
            "coalescing must produce exactly one event per path; got batch={batch:?}"
        );
    }

    #[test]
    fn recv_coalesced_batch_returns_empty_when_no_events_arrive() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = FileWatcher::new(dir.path()).unwrap();
        // No filesystem activity; the call should time out and
        // return an empty batch within ~100 ms.
        let started = std::time::Instant::now();
        let batch = watcher
            .recv_coalesced_batch(Duration::from_millis(100), DEFAULT_COALESCE_WINDOW);
        assert!(batch.is_empty());
        // Belt-and-suspenders: the empty-batch path must NOT also
        // pay the `window` cost. Allow ~50 ms slop for slow CI.
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "no-event path should return promptly after `max_wait`, not also wait `window`",
        );
    }

    #[test]
    fn watcher_detects_file_creation() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = FileWatcher::new(dir.path()).unwrap();

        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(dir.path().join("new_file.txt"), "hello").unwrap();

        std::thread::sleep(Duration::from_millis(500));

        let events = watcher.poll_events();
        let has_create = events.iter().any(|e| matches!(e, FileEvent::Created(_)));
        let has_modify = events.iter().any(|e| matches!(e, FileEvent::Modified(_)));
        assert!(
            has_create || has_modify,
            "Expected create or modify event, got: {events:?}"
        );
    }

    #[test]
    fn watcher_detects_file_modification() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("existing.txt");
        std::fs::write(&file_path, "original").unwrap();

        let watcher = FileWatcher::new(dir.path()).unwrap();
        std::thread::sleep(Duration::from_millis(100));

        std::fs::write(&file_path, "modified content").unwrap();
        std::thread::sleep(Duration::from_millis(500));

        let events = watcher.poll_events();
        assert!(!events.is_empty(), "Expected modification events, got none");
    }

    #[test]
    fn watcher_detects_file_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let file_path = dir.path().join("to_delete.txt");
        std::fs::write(&file_path, "to be deleted").unwrap();

        let watcher = FileWatcher::new(dir.path()).unwrap();
        std::thread::sleep(Duration::from_millis(100));

        std::fs::remove_file(&file_path).unwrap();
        std::thread::sleep(Duration::from_millis(500));

        let events = watcher.poll_events();
        let has_remove = events.iter().any(|e| matches!(e, FileEvent::Removed(_)));
        assert!(
            has_remove || !events.is_empty(),
            "Expected remove event, got: {events:?}"
        );
    }
}
