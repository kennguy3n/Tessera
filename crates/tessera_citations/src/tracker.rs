//! The `CitationTracker`: keeps artifact citations in sync with their
//! sources, including freshness checks and re-binding.

use tessera_core::error::{Error, Result};
use tessera_core::{ArtifactId, CitationId, SharedConnection, SourceId, SourceType};

use crate::citation::Citation;
use crate::freshness::{check_source_freshness, FreshnessStatus};
use crate::store::CitationStore;

/// Input to [`CitationTracker::replace`] — describes the new source
/// pointer the citation should be re-bound to. Mirrors the fields
/// that the user picks when they choose a replacement source in the
/// React `CitationPanel`. The original `used_for` label is
/// preserved automatically.
#[derive(Debug, Clone)]
pub struct CitationReplacement {
    /// Source id.
    pub source_id: SourceId,
    /// Source type.
    pub source_type: SourceType,
    /// Source title.
    pub source_title: String,
    /// Source uri.
    pub source_uri: String,
    /// Chunk hash.
    pub chunk_hash: String,
    /// Source file hash.
    pub source_file_hash: String,
    /// Page.
    pub page: Option<u32>,
    /// Confidence.
    pub confidence: f64,
}

/// Citation Tracker.
pub struct CitationTracker {
    store: CitationStore,
}

impl CitationTracker {
    /// Creates a new instance.
    pub fn new(db_path: &str) -> Result<Self> {
        let store = CitationStore::open(db_path)?;
        Ok(Self { store })
    }

    /// New in memory.
    pub fn new_in_memory() -> Result<Self> {
        let store = CitationStore::open_in_memory()?;
        Ok(Self { store })
    }

    /// Build a tracker backed by a [`SharedConnection`] that is also
    /// used by other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection) -> Result<Self> {
        let store = CitationStore::with_shared_conn(conn)?;
        Ok(Self { store })
    }

    /// Add.
    pub fn add(&mut self, artifact_id: ArtifactId, citation: Citation) -> Result<CitationId> {
        let id = citation.citation_id;
        self.store.insert(&artifact_id, &citation)?;
        Ok(id)
    }

    /// Remove.
    pub fn remove(&mut self, _artifact_id: &ArtifactId, citation_id: &CitationId) -> Result<()> {
        self.store.remove(citation_id)
    }

    /// Get.
    pub fn get(&self, citation_id: &CitationId) -> Result<Option<Citation>> {
        self.store.get(citation_id)
    }

    /// List for artifact.
    pub fn list_for_artifact(&self, artifact_id: &ArtifactId) -> Result<Vec<Citation>> {
        self.store.list_for_artifact(artifact_id)
    }

    /// Check source changed.
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

    /// Compute the typed freshness status for a citation.
    /// `current_hash_lookup` should return `Ok(Some(hash))` when the
    /// source is still indexed and `Ok(None)` when the source URI
    /// has been removed. Returns
    /// `Err(Error::Database("citation not found: ..."))` if the
    /// citation does not exist.
    pub fn check_freshness<F>(
        &self,
        citation_id: &CitationId,
        current_hash_lookup: F,
    ) -> Result<FreshnessStatus>
    where
        F: FnOnce(&str) -> Result<Option<String>>,
    {
        let citation = self
            .store
            .get(citation_id)?
            .ok_or_else(|| Error::Database(format!("citation not found: {}", citation_id.0)))?;
        check_source_freshness(&citation, current_hash_lookup)
    }

    /// Atomically swap the source the citation points at. The
    /// citation keeps its original id, artifact, `used_for` label,
    /// and `created_at` timestamp. Returns the citation as it
    /// appears in the store after the update so callers (the bridge
    /// layer) can return the new state to the UI.
    pub fn replace(
        &mut self,
        artifact_id: &ArtifactId,
        citation_id: &CitationId,
        replacement: CitationReplacement,
    ) -> Result<Citation> {
        let existing = self
            .store
            .get(citation_id)?
            .ok_or_else(|| Error::Database(format!("citation not found: {}", citation_id.0)))?;

        let owning_artifact = self.store.artifact_for(citation_id)?.ok_or_else(|| {
            Error::Database(format!(
                "citation has no artifact association: {}",
                citation_id.0
            ))
        })?;
        if owning_artifact != *artifact_id {
            return Err(Error::Database(format!(
                "citation {} belongs to a different artifact",
                citation_id.0
            )));
        }

        self.store.replace_source(
            citation_id,
            &replacement.source_id,
            replacement.source_type,
            &replacement.source_title,
            &replacement.source_uri,
            &replacement.chunk_hash,
            &replacement.source_file_hash,
            replacement.page,
            replacement.confidence,
        )?;

        // The store update preserves used_for/created_at by design,
        // but we re-read the row so the caller sees a consistent
        // round-tripped value.
        let updated = self.store.get(citation_id)?.ok_or_else(|| {
            Error::Database(format!(
                "citation disappeared after replace: {}",
                citation_id.0
            ))
        })?;
        // Defensive: confirm the persisted row kept the original
        // used_for label so we never silently drop provenance.
        debug_assert_eq!(updated.used_for, existing.used_for);
        Ok(updated)
    }

    /// Count.
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

    fn make_replacement(uri: &str) -> CitationReplacement {
        CitationReplacement {
            source_id: SourceId::new(),
            source_type: SourceType::LocalFile,
            source_title: "new.pdf".to_string(),
            source_uri: uri.to_string(),
            chunk_hash: "chunk_new".to_string(),
            source_file_hash: "file_hash_new".to_string(),
            page: Some(2),
            confidence: 0.77,
        }
    }

    #[test]
    fn replace_swaps_source_and_preserves_used_for() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let cid = tracker
            .add(aid, make_citation("Problem Statement"))
            .unwrap();

        let updated = tracker
            .replace(&aid, &cid, make_replacement("file:///new/source.pdf"))
            .unwrap();

        assert_eq!(updated.citation_id, cid);
        assert_eq!(updated.source_uri, "file:///new/source.pdf");
        assert_eq!(updated.source_file_hash, "file_hash_new");
        assert_eq!(updated.page, Some(2));
        // used_for label is preserved across the swap.
        assert_eq!(updated.used_for, "Problem Statement");
    }

    #[test]
    fn replace_rejects_wrong_artifact() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let other = ArtifactId::new();
        let cid = tracker.add(aid, make_citation("Section")).unwrap();

        let result = tracker.replace(&other, &cid, make_replacement("file:///x.pdf"));
        assert!(
            result.is_err(),
            "replace should refuse to swap a citation for a different artifact"
        );
    }

    #[test]
    fn replace_errors_on_missing_citation() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let missing = CitationId::new();
        let result = tracker.replace(&aid, &missing, make_replacement("file:///x.pdf"));
        assert!(result.is_err());
    }

    #[test]
    fn check_freshness_reports_fresh_changed_and_missing() {
        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let cid = tracker.add(aid, make_citation("Section")).unwrap();

        let fresh = tracker
            .check_freshness(&cid, |_uri| Ok(Some("file_hash_456".to_string())))
            .unwrap();
        assert_eq!(fresh, FreshnessStatus::Fresh);

        let changed = tracker
            .check_freshness(&cid, |_uri| Ok(Some("file_hash_different".to_string())))
            .unwrap();
        assert_eq!(changed, FreshnessStatus::Changed);

        let missing = tracker.check_freshness(&cid, |_uri| Ok(None)).unwrap();
        assert_eq!(missing, FreshnessStatus::SourceMissing);
    }

    #[test]
    fn check_freshness_errors_on_missing_citation() {
        let tracker = CitationTracker::new_in_memory().unwrap();
        let missing = CitationId::new();
        let result = tracker.check_freshness(&missing, |_uri| Ok(Some("h".into())));
        assert!(result.is_err());
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
