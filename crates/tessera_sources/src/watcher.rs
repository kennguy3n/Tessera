//! Filesystem watcher that debounces change events to trigger
//! re-indexing of sources on disk.

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tessera_core::error::{Error, Result};

/// default coalescing window for
/// [`FileWatcher::recv_coalesced_batch`]. 500 ms is the window the
/// task spec calls for and matches the empirical median save burst
/// produced by VS Code (atomic save: temp-write → fsync → rename →
/// chmod, all within ~80–200 ms) and JetBrains IDEs (incremental
/// auto-save bursts of 5–10 modify events over ~250 ms). With the
/// 500 ms window, a typical save burst collapses to a single
/// re-index trigger per file instead of N.
pub const DEFAULT_COALESCE_WINDOW: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
/// A filesystem change observed under a watched source, normalized
/// to the three actions the indexer reacts to.
pub enum FileEvent {
    /// A new file appeared at the path.
    Created(PathBuf),
    /// An existing file's contents changed.
    Modified(PathBuf),
    /// A file was deleted (or moved out of the watched tree).
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
}

/// Recursively watches a directory and delivers normalized
/// [`FileEvent`]s for the indexer to act on.
pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    receiver: mpsc::Receiver<FileEvent>,
}

impl FileWatcher {
    /// Starts watching `path` recursively, spawning the OS watcher
    /// and the event channel.
    pub fn new(path: &Path) -> Result<Self> {
        let (tx, rx) = mpsc::channel();

        let watch_root = canonicalize_path(path);
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
            .watch(&watch_root, RecursiveMode::Recursive)
            .map_err(|e| Error::Io(std::io::Error::other(e.to_string())))?;

        Ok(Self {
            _watcher: watcher,
            receiver: rx,
        })
    }

    /// Drains all events currently queued without blocking.
    pub fn poll_events(&self) -> Vec<FileEvent> {
        let mut events = Vec::new();
        while let Ok(event) = self.receiver.try_recv() {
            events.push(event);
        }
        events
    }

    /// Blocks up to `timeout` for the next event, returning `None`
    /// on timeout.
    pub fn recv_event(&self, timeout: std::time::Duration) -> Option<FileEvent> {
        self.receiver.recv_timeout(timeout).ok()
    }

    /// collect every event the watcher emits for
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
    ///     path, with last-event-wins semantics (so an atomic-save
    ///     `Removed → Modified` correctly resolves to `Modified`).
    ///     See [`coalesce_events`] for the full rationale.
    ///
    /// This is the entrypoint the bridge layer's watcher tick
    /// should call instead of the raw [`Self::poll_events`] /
    /// [`Self::recv_event`] APIs — it gives the indexer one batch
    /// per save burst rather than per-keystroke or per-rename-
    /// fsync event.
    pub fn recv_coalesced_batch(&self, max_wait: Duration, window: Duration) -> Vec<FileEvent> {
        coalesce_events(self.drain_burst(max_wait, window))
    }

    /// LW-7 directory-burst variant of [`Self::recv_coalesced_batch`].
    ///
    /// Returns the same per-path-coalesced burst, but additionally folds
    /// any directory that saw at least [`DEFAULT_DIRECTORY_BURST_THRESHOLD`]
    /// distinct file changes into a single [`WatchTrigger::DirectoryRescan`].
    /// This is the entrypoint the bridge watcher tick should prefer when a
    /// bulk operation (a `git checkout`, an archive extract, an `rsync` of a
    /// folder) lands many files in one directory inside a single window:
    /// instead of handing the indexer N per-file triggers it hands one
    /// directory-level rescan, so the indexer walks the directory once and
    /// reconciles the whole folder against its index in a single pass —
    /// bounding peak work (and peak RSS) regardless of burst size. Lone
    /// changes still flow through as per-file [`WatchTrigger::File`]s so the
    /// common single-save path is unchanged.
    pub fn recv_coalesced_triggers(
        &self,
        max_wait: Duration,
        window: Duration,
    ) -> Vec<WatchTrigger> {
        coalesce_directory_bursts(
            coalesce_events(self.drain_burst(max_wait, window)),
            DEFAULT_DIRECTORY_BURST_THRESHOLD,
        )
    }

    /// Block up to `max_wait` for the first event, then drain the channel
    /// for a fixed `window` more, returning the raw (un-coalesced) burst.
    /// Shared by both [`Self::recv_coalesced_batch`] and
    /// [`Self::recv_coalesced_triggers`] so the timing contract lives in one
    /// place.
    fn drain_burst(&self, max_wait: Duration, window: Duration) -> Vec<FileEvent> {
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
        raw
    }
}

/// collapse a sequence of [`FileEvent`]s into one
/// event per path using **last-event-wins** semantics — the final
/// event observed for a given path within the coalescing window is
/// the one returned.
///
/// Why last-event-wins instead of a static priority order:
///
/// The 500 ms coalescing window must reflect the file's *final*
/// state, not a fixed `Removed > Created > Modified` rank. Atomic-
/// save patterns produce real `Removed → Modified` and
/// `Removed → Created` sequences where the file ends up existing
/// with new content, but a static `Removed`-wins rule would emit a
/// stale `Removed` and the indexer would drop the file from the
/// index even though it is present on disk with fresh bytes.
/// Concrete worked examples we need to handle correctly:
///
///   * **`sed -i` / atomic editor save**: editor writes to
///     `file.tmp`, `unlink(file)`, `rename(file.tmp, file)`. The
///     `notify` crate emits `Removed(file)` from the unlink and
///     `Modified(file)` from the rename-to (inotify translates
///     `IN_MOVED_TO` to `Modify(Name(To))`). Final state is the
///     file exists with new content → must coalesce to
///     `Modified(file)`.
///   * **rsync `--inplace=false`**: writes `.tmp.XXXX`,
///     `rename(.tmp.XXXX, file)`. Same shape as above for the
///     destination path.
///   * **`rm file; cp other file`**: `Removed → Created`. Final
///     state is the file exists → must coalesce to `Created`.
///   * **`touch file; rm file`**: `Created → Removed`. Final
///     state is the file is gone → must coalesce to `Removed`
///     (which last-event-wins gives us for free).
///
/// The original event ordering is preserved across distinct paths:
/// the returned vector is iterated in first-appearance order of
/// each path, with each entry being the last variant observed for
/// that path. First-appearance order matters for the indexer,
/// which processes events serially: a `Removed` before any
/// `Created` for a different path lets the indexer free the chunk
/// rows for the deleted file before allocating new ones for the
/// created one.
///
/// Pure helper (no I/O, no state) so tests can drive it directly
/// without standing up a real watcher.
pub fn coalesce_events(events: Vec<FileEvent>) -> Vec<FileEvent> {
    // `IndexMap`-like behaviour: first-appearance order + O(1)
    // dedup. We use a `Vec<PathBuf>` for the ordered keys and a
    // parallel `HashMap<PathBuf, FileEvent>` for the value lookup
    // to avoid pulling in the `indexmap` crate.
    let mut order: Vec<PathBuf> = Vec::with_capacity(events.len());
    let mut by_path: HashMap<PathBuf, FileEvent> = HashMap::with_capacity(events.len());

    for ev in events {
        let path = ev.path().to_path_buf();
        if let Some(existing) = by_path.get_mut(&path) {
            // Last event wins: the final filesystem state for a
            // path within the coalescing window is what the
            // indexer needs to observe. See the function-level doc
            // comment for the atomic-save / rsync examples that
            // make this the correct rule.
            *existing = ev;
        } else {
            order.push(path.clone());
            by_path.insert(path, ev);
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

/// Default fan-out threshold for [`coalesce_directory_bursts`]. When a
/// single coalescing window contains changes to **2 or more distinct
/// files under the same parent directory**, those per-file events
/// collapse into one [`WatchTrigger::DirectoryRescan`]. A lone file
/// change stays a per-file trigger. 2 is deliberately aggressive: the
/// common bulk-mutation patterns a desktop app sees — `git checkout`,
/// `npm install`, an editor "Save All", an `rsync` pull — touch many
/// files in one directory at once, and a single directory re-walk is
/// far cheaper than N independent index passes that each re-open the
/// store and re-run the FTS writer.
pub const DEFAULT_DIRECTORY_BURST_THRESHOLD: usize = 2;

/// The unit of work the indexer's watcher tick should act on after
/// both coalescing layers have run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchTrigger {
    /// A single file changed in isolation — index just this path.
    File(FileEvent),
    /// Enough files under one directory changed within the window
    /// that re-walking the directory once is cheaper than handling
    /// each file event.
    ///
    /// A re-scan is a **reconcile**: the indexer re-walks `dir`,
    /// (re)indexes present files, and drops index rows for files no
    /// longer on disk. This is why removals can safely fold into a
    /// rescan — the reconcile observes the deletion just as a per-file
    /// `Removed` would, without the indexer having to special-case it.
    DirectoryRescan(PathBuf),
}

/// Second-stage coalescing: collapse a per-path event list (already
/// deduped by [`coalesce_events`]) into a mix of per-file triggers and
/// per-directory re-scans.
///
/// Algorithm (single pass + grouping, all pure):
///
///   1. Group the incoming events by parent directory, preserving the
///      first-appearance order of both directories and the files
///      within them (so the indexer still frees deleted-file rows
///      before allocating new ones, matching [`coalesce_events`]).
///   2. A directory whose group holds `>= threshold` distinct files
///      emits exactly one [`WatchTrigger::DirectoryRescan`], placed at
///      the position of that directory's *first* event.
///   3. A directory below the threshold emits its files unchanged as
///      [`WatchTrigger::File`], in order.
///
/// A `threshold` of 0 or 1 is clamped to 2 — a threshold below 2 would
/// turn every single-file save into a full-directory rescan, which is
/// strictly more work and never desirable.
///
/// Pure helper (no I/O, no state) so the fan-out policy is unit
/// testable without standing up a real watcher.
pub fn coalesce_directory_bursts(events: Vec<FileEvent>, threshold: usize) -> Vec<WatchTrigger> {
    let threshold = threshold.max(2);

    // Ordered directory keys + per-directory event lists, both in
    // first-appearance order. A plain Vec-of-(dir, events) keeps the
    // ordering guarantee without pulling in `indexmap`.
    let mut dir_order: Vec<PathBuf> = Vec::new();
    let mut groups: HashMap<PathBuf, Vec<FileEvent>> = HashMap::new();

    for ev in events {
        // A path with no parent (e.g. a bare filename or the FS root)
        // groups under an empty path; it can still coalesce with its
        // siblings, which is the correct behaviour.
        let dir = ev
            .path()
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        if let Some(bucket) = groups.get_mut(&dir) {
            bucket.push(ev);
        } else {
            dir_order.push(dir.clone());
            groups.insert(dir, vec![ev]);
        }
    }

    let mut out: Vec<WatchTrigger> = Vec::with_capacity(dir_order.len());
    for dir in dir_order {
        let bucket = groups
            .remove(&dir)
            .expect("dir is in `dir_order` iff it was inserted into `groups`");
        if bucket.len() >= threshold {
            out.push(WatchTrigger::DirectoryRescan(dir));
        } else {
            out.extend(bucket.into_iter().map(WatchTrigger::File));
        }
    }
    out
}

fn translate_event(event: &Event) -> Vec<FileEvent> {
    let mut result = Vec::new();
    for path in &event.paths {
        let canonical = canonicalize_path(path);
        match event.kind {
            EventKind::Create(_) => {
                result.push(FileEvent::Created(canonical));
            }
            EventKind::Modify(_) => {
                result.push(FileEvent::Modified(canonical));
            }
            EventKind::Remove(_) => {
                result.push(FileEvent::Removed(canonical));
            }
            _ => {}
        }
    }
    result
}

/// Resolve symlinks and relative components in `path` so watcher
/// paths are stable across macOS `/private` symlink aliasing and
/// user-supplied symlinked source roots. Falls back to the input
/// path on failure (e.g., a `Removed` event for a file that was
/// already deleted before canonicalization runs).
fn canonicalize_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
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
    fn coalesce_create_modify_then_remove_resolves_to_remove() {
        // The file was created, edited, then deleted. The final
        // filesystem state is "gone" — the coalesced event must
        // reflect that so the indexer drops the row.
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
    fn coalesce_modify_create_modify_resolves_to_modify_via_last_event_wins() {
        // The trailing event is `Modified` — the file exists with
        // new content. Last-event-wins gives us that, where a
        // static `Created > Modified` rule would emit a stale
        // `Created`.
        let raw = vec![
            FileEvent::Modified(p("/a.txt")),
            FileEvent::Created(p("/a.txt")),
            FileEvent::Modified(p("/a.txt")),
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], FileEvent::Modified(_)));
    }

    #[test]
    fn coalesce_atomic_save_remove_then_modify_resolves_to_modify() {
        // `sed -i` / VS Code atomic save shape: explicit unlink
        // followed by an inotify `IN_MOVED_TO` (which `notify`
        // surfaces as `Modify(Name(To))` → `FileEvent::Modified`).
        // The file ends up existing with new content; the static
        // `Removed`-wins rule used to emit a stale `Removed` here.
        let raw = vec![
            FileEvent::Removed(p("/a.txt")),
            FileEvent::Modified(p("/a.txt")),
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 1);
        assert!(
            matches!(out[0], FileEvent::Modified(_)),
            "atomic-save remove→modify must coalesce to Modified, got {:?}",
            out[0]
        );
    }

    #[test]
    fn coalesce_replace_remove_then_create_resolves_to_create() {
        // `rm a; cp other a` shape. Final state is the file exists
        // (possibly with very different content / inode); the
        // indexer treats `Created` as "this is a fresh file,
        // re-extract", which is exactly what we want.
        let raw = vec![
            FileEvent::Removed(p("/a.txt")),
            FileEvent::Created(p("/a.txt")),
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], FileEvent::Created(_)));
    }

    #[test]
    fn coalesce_create_then_remove_resolves_to_remove() {
        // The file briefly existed within the window then was
        // deleted. Last-event-wins gives `Removed`, which is what
        // the indexer needs to know (don't bother extracting a
        // file that no longer exists).
        let raw = vec![
            FileEvent::Created(p("/a.txt")),
            FileEvent::Removed(p("/a.txt")),
        ];
        let out = coalesce_events(raw);
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], FileEvent::Removed(_)));
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
        // This is the regression spec verbatim.
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

        let batch = watcher.recv_coalesced_batch(Duration::from_secs(2), DEFAULT_COALESCE_WINDOW);

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
        assert_eq!(touched_path, canonicalize_path(&file_path));
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
        let batch =
            watcher.recv_coalesced_batch(Duration::from_millis(100), DEFAULT_COALESCE_WINDOW);
        assert!(batch.is_empty());
        // Belt-and-suspenders: the empty-batch path must NOT also
        // pay the `window` cost. Allow ~50 ms slop for slow CI.
        assert!(
            started.elapsed() < Duration::from_millis(300),
            "no-event path should return promptly after `max_wait`, not also wait `window`",
        );
    }

    #[test]
    fn recv_coalesced_triggers_folds_a_directory_burst_into_one_rescan() {
        // A bulk extract-into-one-folder burst: several distinct files
        // created in the same directory inside a single window must
        // surface as exactly one DirectoryRescan trigger (not N per-file
        // triggers), so the indexer walks the folder once.
        let dir = tempfile::tempdir().unwrap();
        let watcher = FileWatcher::new(dir.path()).unwrap();
        std::thread::sleep(Duration::from_millis(100));

        for i in 0..5 {
            std::fs::write(dir.path().join(format!("doc-{i}.txt")), format!("body-{i}")).unwrap();
        }

        let triggers =
            watcher.recv_coalesced_triggers(Duration::from_secs(2), DEFAULT_COALESCE_WINDOW);
        assert!(
            !triggers.is_empty(),
            "expected at least one trigger for the burst"
        );
        // Every distinct file landed in the same directory, so the five
        // (or more, if the OS double-stamps) per-path events collapse to a
        // single directory rescan rooted at the temp dir.
        assert_eq!(
            triggers.len(),
            1,
            "a single-directory burst must yield exactly one trigger; got {triggers:?}",
        );
        let expected_dir = canonicalize_path(dir.path());
        match &triggers[0] {
            WatchTrigger::DirectoryRescan(p) => {
                assert_eq!(
                    p, &expected_dir,
                    "rescan must be rooted at the burst directory"
                );
            }
            file @ WatchTrigger::File(_) => panic!("expected DirectoryRescan, got {file:?}"),
        }
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

    #[test]
    fn dir_burst_collapses_two_plus_files_in_one_dir_to_one_rescan() {
        let raw = vec![
            FileEvent::Modified(p("/proj/src/a.rs")),
            FileEvent::Created(p("/proj/src/b.rs")),
            FileEvent::Modified(p("/proj/src/c.rs")),
        ];
        let out = coalesce_directory_bursts(raw, DEFAULT_DIRECTORY_BURST_THRESHOLD);
        assert_eq!(out, vec![WatchTrigger::DirectoryRescan(p("/proj/src"))]);
    }

    #[test]
    fn dir_burst_leaves_a_lone_file_change_as_a_file_trigger() {
        let raw = vec![FileEvent::Modified(p("/proj/src/only.rs"))];
        let out = coalesce_directory_bursts(raw, DEFAULT_DIRECTORY_BURST_THRESHOLD);
        assert_eq!(
            out,
            vec![WatchTrigger::File(FileEvent::Modified(p(
                "/proj/src/only.rs"
            )))]
        );
    }

    #[test]
    fn dir_burst_groups_per_directory_independently() {
        // Two files in /a (rescan) + one file in /b (stays per-file).
        let raw = vec![
            FileEvent::Modified(p("/a/one.txt")),
            FileEvent::Modified(p("/b/solo.txt")),
            FileEvent::Created(p("/a/two.txt")),
        ];
        let out = coalesce_directory_bursts(raw, DEFAULT_DIRECTORY_BURST_THRESHOLD);
        // /a appears first, so its rescan leads; /b's lone file follows.
        assert_eq!(
            out,
            vec![
                WatchTrigger::DirectoryRescan(p("/a")),
                WatchTrigger::File(FileEvent::Modified(p("/b/solo.txt"))),
            ]
        );
    }

    #[test]
    fn dir_burst_preserves_first_appearance_order_of_directories() {
        // /z bursts first, then /a bursts — output must keep /z before
        // /a so the indexer processes them in observed order.
        let raw = vec![
            FileEvent::Modified(p("/z/1")),
            FileEvent::Modified(p("/z/2")),
            FileEvent::Modified(p("/a/1")),
            FileEvent::Modified(p("/a/2")),
        ];
        let out = coalesce_directory_bursts(raw, DEFAULT_DIRECTORY_BURST_THRESHOLD);
        assert_eq!(
            out,
            vec![
                WatchTrigger::DirectoryRescan(p("/z")),
                WatchTrigger::DirectoryRescan(p("/a")),
            ]
        );
    }

    #[test]
    fn dir_burst_folds_removals_into_the_rescan() {
        // A bulk delete (e.g. `rm src/*.tmp`) — the rescan reconciles
        // the deletions, so we must NOT leak per-file Removed triggers.
        let raw = vec![
            FileEvent::Removed(p("/src/a.tmp")),
            FileEvent::Removed(p("/src/b.tmp")),
        ];
        let out = coalesce_directory_bursts(raw, DEFAULT_DIRECTORY_BURST_THRESHOLD);
        assert_eq!(out, vec![WatchTrigger::DirectoryRescan(p("/src"))]);
    }

    #[test]
    fn dir_burst_threshold_below_two_is_clamped() {
        // A threshold of 0 or 1 would turn every single save into a
        // full rescan; the clamp prevents that pathology.
        let raw = vec![FileEvent::Modified(p("/d/only.txt"))];
        for bad in [0usize, 1usize] {
            let out = coalesce_directory_bursts(raw.clone(), bad);
            assert_eq!(
                out,
                vec![WatchTrigger::File(FileEvent::Modified(p("/d/only.txt")))],
                "threshold {bad} should clamp to 2 and leave a lone file per-file",
            );
        }
    }
}
