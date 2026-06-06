//! The `Artifact` domain model: a versioned unit of generated content
//! (its id, title, type, body and citation links) as persisted and
//! exchanged across the crate.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{ArtifactId, ArtifactType, CitationId, TemplateId};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// A versioned unit of generated content. Holds the body plus the
/// citation links that back it; mutating helpers bump
/// [`Artifact::version`] and [`Artifact::updated_at`] so history and
/// staleness can be tracked.
pub struct Artifact {
    /// Stable unique identity of this artifact.
    pub id: ArtifactId,
    /// Human-readable title shown in the UI.
    pub title: String,
    /// Which kind of artifact this is (document, slides, …); selects
    /// the editor and valid export formats.
    pub artifact_type: ArtifactType,
    /// Template this artifact was generated from, if any; `None` for
    /// artifacts created without a template.
    pub template_id: Option<TemplateId>,
    /// The artifact body. Encoding depends on `artifact_type` (e.g.
    /// Markdown for documents, HTML for landing pages).
    pub content: String,
    /// Citations backing the content, in insertion order; deduplicated
    /// by [`Artifact::add_citation`].
    pub citations: Vec<CitationId>,
    /// Creation time, in UTC. Never changes after construction.
    pub created_at: DateTime<Utc>,
    /// Last-modification time, in UTC. Advanced by every mutating
    /// helper.
    pub updated_at: DateTime<Utc>,
    /// Monotonic revision counter starting at 1; incremented on each
    /// content update so saved versions can be ordered.
    pub version: u32,
}

impl Artifact {
    /// Creates an empty artifact: mints a new id, sets `version` to 1,
    /// stamps both timestamps to now, and starts with no content or
    /// citations.
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

    /// Replaces the body, advances `updated_at`, and increments
    /// `version` so the change is recorded as a new revision.
    pub fn update_content(&mut self, content: String) {
        self.content = content;
        self.updated_at = Utc::now();
        self.version += 1;
    }

    /// Links `citation_id` to this artifact if not already present
    /// (idempotent), touching `updated_at` only when it was added.
    /// Does not bump `version` — citation links are metadata, not
    /// content revisions.
    pub fn add_citation(&mut self, citation_id: CitationId) {
        if !self.citations.contains(&citation_id) {
            self.citations.push(citation_id);
            self.updated_at = Utc::now();
        }
    }

    /// Unlinks `citation_id` if present and touches `updated_at`.
    pub fn remove_citation(&mut self, citation_id: &CitationId) {
        self.citations.retain(|c| c != citation_id);
        self.updated_at = Utc::now();
    }
}
