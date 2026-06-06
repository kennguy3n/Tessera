use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{ArtifactId, ArtifactType, CitationId, TemplateId};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Artifact.
pub struct Artifact {
    /// Id.
    pub id: ArtifactId,
    /// Title.
    pub title: String,
    /// Artifact type.
    pub artifact_type: ArtifactType,
    /// Template id.
    pub template_id: Option<TemplateId>,
    /// Content.
    pub content: String,
    /// Citations.
    pub citations: Vec<CitationId>,
    /// Created at.
    pub created_at: DateTime<Utc>,
    /// Updated at.
    pub updated_at: DateTime<Utc>,
    /// Version.
    pub version: u32,
}

impl Artifact {
    /// Creates a new instance.
    pub fn new(
        title: String,
        artifact_type: ArtifactType,
        template_id: Option<TemplateId>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: ArtifactId::new(),
            title,
            artifact_type,
            template_id,
            content: String::new(),
            citations: Vec::new(),
            created_at: now,
            updated_at: now,
            version: 1,
        }
    }

    /// Update content.
    pub fn update_content(&mut self, content: String) {
        self.content = content;
        self.updated_at = Utc::now();
        self.version += 1;
    }

    /// Add citation.
    pub fn add_citation(&mut self, citation_id: CitationId) {
        if !self.citations.contains(&citation_id) {
            self.citations.push(citation_id);
            self.updated_at = Utc::now();
        }
    }

    /// Remove citation.
    pub fn remove_citation(&mut self, citation_id: &CitationId) {
        self.citations.retain(|c| c != citation_id);
        self.updated_at = Utc::now();
    }
}
