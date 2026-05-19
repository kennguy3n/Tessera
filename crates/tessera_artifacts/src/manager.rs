use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

use tessera_core::error::Result;
use tessera_core::{ArtifactId, ArtifactType, CitationId, TemplateId};

use crate::artifact::Artifact;
use crate::store::{ArtifactStore, ArtifactVersion};

/// Minimum interval between automatic version snapshots for the same artifact.
const VERSION_RATE_LIMIT_SECS: u64 = 60;

pub struct ArtifactManager {
    store: ArtifactStore,
    /// Tracks the last time a version was auto-saved per artifact for rate limiting.
    last_version_at: Mutex<HashMap<ArtifactId, Instant>>,
}

impl ArtifactManager {
    pub fn new(db_path: &str) -> Result<Self> {
        let store = ArtifactStore::open(db_path)?;
        Ok(Self {
            store,
            last_version_at: Mutex::new(HashMap::new()),
        })
    }

    pub fn new_in_memory() -> Result<Self> {
        let store = ArtifactStore::open_in_memory()?;
        Ok(Self {
            store,
            last_version_at: Mutex::new(HashMap::new()),
        })
    }

    pub fn create(
        &self,
        title: String,
        artifact_type: ArtifactType,
        template_id: Option<TemplateId>,
    ) -> Result<Artifact> {
        let artifact = Artifact::new(title, artifact_type, template_id);
        self.store.insert(&artifact)?;
        Ok(artifact)
    }

    pub fn update_content(&self, id: &ArtifactId, content: String) -> Result<Artifact> {
        let mut artifact = self.store.get(id)?;

        // Rate-limit version snapshots: at most one per VERSION_RATE_LIMIT_SECS
        let should_save_version = {
            let map = self
                .last_version_at
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match map.get(id) {
                Some(last) => last.elapsed().as_secs() >= VERSION_RATE_LIMIT_SECS,
                None => true, // first save for this artifact always creates a version
            }
        };

        if should_save_version {
            self.store
                .save_version(id, artifact.version, &artifact.content)?;
            let mut map = self
                .last_version_at
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            map.insert(*id, Instant::now());
        }

        artifact.update_content(content);
        self.store.update(&artifact)?;
        Ok(artifact)
    }

    pub fn add_citation(&self, id: &ArtifactId, citation_id: CitationId) -> Result<Artifact> {
        let mut artifact = self.store.get(id)?;
        artifact.add_citation(citation_id);
        self.store.update(&artifact)?;
        Ok(artifact)
    }

    pub fn get(&self, id: &ArtifactId) -> Result<Artifact> {
        self.store.get(id)
    }

    pub fn list(&self) -> Result<Vec<Artifact>> {
        self.store.list()
    }

    pub fn delete(&self, id: &ArtifactId) -> Result<()> {
        self.store.delete(id)
    }

    pub fn list_versions(&self, id: &ArtifactId) -> Result<Vec<ArtifactVersion>> {
        self.store.list_versions(id)
    }

    pub fn restore_version(&self, id: &ArtifactId, version_number: u32) -> Result<Artifact> {
        let version = self.store.get_version(id, version_number)?;
        // Force a version save before restoring, bypassing rate limit
        let artifact = self.store.get(id)?;
        self.store
            .save_version(id, artifact.version, &artifact.content)?;
        let mut artifact = artifact;
        artifact.update_content(version.content_snapshot);
        self.store.update(&artifact)?;
        Ok(artifact)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_create_and_get() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();
        let loaded = manager.get(&artifact.id).unwrap();
        assert_eq!(loaded.title, "Test");
    }

    #[test]
    fn manager_update_content() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();
        let updated = manager
            .update_content(&artifact.id, "New content".to_string())
            .unwrap();
        assert_eq!(updated.content, "New content");
        assert_eq!(updated.version, 2);
    }

    #[test]
    fn manager_add_citation() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();
        let cid = CitationId::new();
        let updated = manager.add_citation(&artifact.id, cid).unwrap();
        assert_eq!(updated.citations.len(), 1);
    }

    #[test]
    fn version_auto_saved_on_first_update() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();

        // First update always creates a version
        manager
            .update_content(&artifact.id, "First update".to_string())
            .unwrap();

        let versions = manager.list_versions(&artifact.id).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].content_snapshot, "");
    }

    #[test]
    fn version_rate_limited_on_rapid_updates() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();

        // First update creates version
        manager
            .update_content(&artifact.id, "v1".to_string())
            .unwrap();
        // Rapid second update — within rate limit, no new version
        manager
            .update_content(&artifact.id, "v2".to_string())
            .unwrap();
        manager
            .update_content(&artifact.id, "v3".to_string())
            .unwrap();

        let versions = manager.list_versions(&artifact.id).unwrap();
        // Only one version snapshot (from the first update)
        assert_eq!(versions.len(), 1);
    }

    #[test]
    fn restore_version() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let artifact = manager
            .create("Test".to_string(), ArtifactType::Document, None)
            .unwrap();

        manager
            .update_content(&artifact.id, "v2 content".to_string())
            .unwrap();
        manager
            .update_content(&artifact.id, "v3 content".to_string())
            .unwrap();

        // Restore to version 1 (the original empty content)
        let restored = manager.restore_version(&artifact.id, 1).unwrap();
        assert_eq!(restored.content, "");
    }
}
