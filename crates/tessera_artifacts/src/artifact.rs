use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{ArtifactId, ArtifactType, CitationId, TemplateId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub id: ArtifactId,
    pub title: String,
    pub artifact_type: ArtifactType,
    pub template_id: Option<TemplateId>,
    pub content: String,
    pub citations: Vec<CitationId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub version: u32,
}

impl Artifact {
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

    pub fn update_content(&mut self, content: String) {
        self.content = content;
        self.updated_at = Utc::now();
        self.version += 1;
    }

    pub fn add_citation(&mut self, citation_id: CitationId) {
        if !self.citations.contains(&citation_id) {
            self.citations.push(citation_id);
            self.updated_at = Utc::now();
        }
    }

    pub fn remove_citation(&mut self, citation_id: &CitationId) {
        self.citations.retain(|c| c != citation_id);
        self.updated_at = Utc::now();
    }
}
