use std::collections::HashMap;
use tessera_core::{ArtifactId, CitationId};

use crate::citation::Citation;

pub struct CitationTracker {
    citations: HashMap<CitationId, Citation>,
    artifact_citations: HashMap<ArtifactId, Vec<CitationId>>,
}

impl CitationTracker {
    pub fn new() -> Self {
        Self {
            citations: HashMap::new(),
            artifact_citations: HashMap::new(),
        }
    }

    pub fn add(&mut self, artifact_id: ArtifactId, citation: Citation) -> CitationId {
        let id = citation.citation_id;
        self.citations.insert(id, citation);
        self.artifact_citations
            .entry(artifact_id)
            .or_default()
            .push(id);
        id
    }

    pub fn remove(&mut self, artifact_id: &ArtifactId, citation_id: &CitationId) {
        self.citations.remove(citation_id);
        if let Some(ids) = self.artifact_citations.get_mut(artifact_id) {
            ids.retain(|id| id != citation_id);
        }
    }

    pub fn get(&self, citation_id: &CitationId) -> Option<&Citation> {
        self.citations.get(citation_id)
    }

    pub fn list_for_artifact(&self, artifact_id: &ArtifactId) -> Vec<&Citation> {
        self.artifact_citations
            .get(artifact_id)
            .map(|ids| ids.iter().filter_map(|id| self.citations.get(id)).collect())
            .unwrap_or_default()
    }

    pub fn check_source_changed(
        &self,
        citation_id: &CitationId,
        current_hash: &str,
    ) -> Option<bool> {
        self.citations
            .get(citation_id)
            .map(|c| c.source_changed(current_hash))
    }

    pub fn count(&self) -> usize {
        self.citations.len()
    }
}

impl Default for CitationTracker {
    fn default() -> Self {
        Self::new()
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
        let mut tracker = CitationTracker::new();
        let aid = ArtifactId::new();
        let citation = make_citation("Problem Statement");
        let cid = tracker.add(aid, citation);

        assert!(tracker.get(&cid).is_some());
        assert_eq!(tracker.count(), 1);
    }

    #[test]
    fn list_for_artifact() {
        let mut tracker = CitationTracker::new();
        let aid = ArtifactId::new();
        tracker.add(aid, make_citation("Section A"));
        tracker.add(aid, make_citation("Section B"));

        let citations = tracker.list_for_artifact(&aid);
        assert_eq!(citations.len(), 2);
    }

    #[test]
    fn remove_citation() {
        let mut tracker = CitationTracker::new();
        let aid = ArtifactId::new();
        let cid = tracker.add(aid, make_citation("Test"));

        tracker.remove(&aid, &cid);
        assert!(tracker.get(&cid).is_none());
        assert_eq!(tracker.list_for_artifact(&aid).len(), 0);
    }

    #[test]
    fn check_source_changed() {
        let mut tracker = CitationTracker::new();
        let aid = ArtifactId::new();
        let cid = tracker.add(aid, make_citation("Test"));

        // Same file hash → not changed
        assert_eq!(
            tracker.check_source_changed(&cid, "file_hash_456"),
            Some(false)
        );
        // Different file hash → changed
        assert_eq!(tracker.check_source_changed(&cid, "different"), Some(true));
    }
}
