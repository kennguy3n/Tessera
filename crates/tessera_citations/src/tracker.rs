use tessera_core::error::Result;
use tessera_core::{ArtifactId, CitationId};

use crate::citation::Citation;
use crate::store::CitationStore;

pub struct CitationTracker {
    store: CitationStore,
}

impl CitationTracker {
    pub fn new(db_path: &str) -> Result<Self> {
        let store = CitationStore::open(db_path)?;
        Ok(Self { store })
    }

    pub fn new_in_memory() -> Result<Self> {
        let store = CitationStore::open_in_memory()?;
        Ok(Self { store })
    }

    pub fn add(&mut self, artifact_id: ArtifactId, citation: Citation) -> Result<CitationId> {
        let id = citation.citation_id;
        self.store.insert(&artifact_id, &citation)?;
        Ok(id)
    }

    pub fn remove(&mut self, _artifact_id: &ArtifactId, citation_id: &CitationId) -> Result<()> {
        self.store.remove(citation_id)
    }

    pub fn get(&self, citation_id: &CitationId) -> Result<Option<Citation>> {
        self.store.get(citation_id)
    }

    pub fn list_for_artifact(&self, artifact_id: &ArtifactId) -> Result<Vec<Citation>> {
        self.store.list_for_artifact(artifact_id)
    }

    pub fn check_source_changed(
        &self,
        citation_id: &CitationId,
        current_hash: &str,
    ) -> Result<Option<bool>> {
        Ok(self
            .store
            .get(citation_id)?
            .map(|c| c.source_changed(current_hash)))
    }

    pub fn count(&self) -> Result<usize> {
        self.store.count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::citation::Citation;
    use tessera_core::{ArtifactId, SourceId, SourceType};

    fn make_citation(section: &str) -> Citation {
        Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "test.pdf".to_string(),
            "file:///test.pdf".to_string(),
            "chunk_hash_123".to_string(),
            "file_hash_456".to_string(),
            section.to_string(),
            0.85,
        )
    }

    #[test]
    fn add_and_get_citation() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let citation = make_citation("Problem Statement");
        let cid = tracker.add(aid, citation).unwrap();

        assert!(tracker.get(&cid).unwrap().is_some());
        assert_eq!(tracker.count().unwrap(), 1);
    }

    #[test]
    fn list_for_artifact() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        tracker.add(aid, make_citation("Section A")).unwrap();
        tracker.add(aid, make_citation("Section B")).unwrap();

        let citations = tracker.list_for_artifact(&aid).unwrap();
        assert_eq!(citations.len(), 2);
    }

    #[test]
    fn remove_citation() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let cid = tracker.add(aid, make_citation("Test")).unwrap();

        tracker.remove(&aid, &cid).unwrap();
        assert!(tracker.get(&cid).unwrap().is_none());
        assert_eq!(tracker.list_for_artifact(&aid).unwrap().len(), 0);
    }

    #[test]
    fn check_source_changed() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let cid = tracker.add(aid, make_citation("Test")).unwrap();

        // Same file hash → not changed
        assert_eq!(
            tracker.check_source_changed(&cid, "file_hash_456").unwrap(),
            Some(false)
        );
        // Different file hash → changed
        assert_eq!(
            tracker.check_source_changed(&cid, "different").unwrap(),
            Some(true)
        );
    }

    #[test]
    fn persists_across_instances() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("citations.db");
        let db_str = db_path.to_str().unwrap();

        let aid = ArtifactId::new();
        let cid;
        {
            let mut tracker = CitationTracker::new(db_str).unwrap();
            cid = tracker.add(aid, make_citation("Persisted")).unwrap();
            assert_eq!(tracker.count().unwrap(), 1);
        }
        // Open a new tracker pointing at same DB
        {
            let tracker = CitationTracker::new(db_str).unwrap();
            let loaded = tracker.get(&cid).unwrap().unwrap();
            assert_eq!(loaded.used_for, "Persisted");
            assert_eq!(tracker.count().unwrap(), 1);
        }
    }
}
