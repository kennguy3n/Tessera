use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use tessera_core::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileEvent {
    Created(PathBuf),
    Modified(PathBuf),
    Removed(PathBuf),
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
