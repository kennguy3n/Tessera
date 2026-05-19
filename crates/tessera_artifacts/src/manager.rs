use tessera_core::error::Result;
use tessera_core::{ArtifactId, ArtifactType, CitationId, TemplateId};

use crate::artifact::Artifact;
use crate::store::ArtifactStore;

pub struct ArtifactManager {
    store: ArtifactStore,
}

impl ArtifactManager {
    pub fn new(db_path: &str) -> Result<Self> {
        let store = ArtifactStore::open(db_path)?;
        Ok(Self { store })
    }

    pub fn new_in_memory() -> Result<Self> {
        let store = ArtifactStore::open_in_memory()?;
        Ok(Self { store })
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
}
