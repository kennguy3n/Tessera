use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{CitationId, SourceId, SourceType};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Citation {
    pub citation_id: CitationId,
    pub source_id: SourceId,
    pub source_type: SourceType,
    pub source_title: String,
    pub source_uri: String,
    pub chunk_hash: String,
    pub page: Option<u32>,
    pub confidence: f64,
    pub used_for: String,
    pub created_at: DateTime<Utc>,
}

impl Citation {
    pub fn new(
        source_id: SourceId,
        source_type: SourceType,
        source_title: String,
        source_uri: String,
        chunk_hash: String,
        used_for: String,
        confidence: f64,
    ) -> Self {
        Self {
            citation_id: CitationId::new(),
            source_id,
            source_type,
            source_title,
            source_uri,
            chunk_hash,
            page: None,
            confidence,
            used_for,
            created_at: Utc::now(),
        }
    }

    pub fn with_page(mut self, page: u32) -> Self {
        self.page = Some(page);
        self
    }

    pub fn source_changed(&self, current_hash: &str) -> bool {
        self.chunk_hash != current_hash
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_citation() -> Citation {
        Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "Q4 Planning Brief.pdf".to_string(),
            "file:///Users/alice/Documents/Q4-brief.pdf".to_string(),
            blake3::hash(b"sample chunk content").to_hex().to_string(),
            "Problem Statement".to_string(),
            0.92,
        )
    }

    #[test]
    fn citation_has_unique_id() {
        let a = sample_citation();
        let b = sample_citation();
        assert_ne!(a.citation_id, b.citation_id);
    }

    #[test]
    fn source_changed_detects_modification() {
        let citation = sample_citation();
        assert!(!citation.source_changed(&citation.chunk_hash));
        assert!(citation.source_changed("different_hash"));
    }

    #[test]
    fn citation_with_page() {
        let citation = sample_citation().with_page(4);
        assert_eq!(citation.page, Some(4));
    }

    #[test]
    fn citation_serializes_to_json() {
        let citation = sample_citation().with_page(4);
        let json = serde_json::to_string(&citation).unwrap();
        assert!(json.contains("citation_id"));
        assert!(json.contains("source_title"));
        assert!(json.contains("chunk_hash"));
        assert!(json.contains("confidence"));

        let restored: Citation = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.citation_id, citation.citation_id);
        assert!((restored.confidence - 0.92).abs() < f64::EPSILON);
        assert_eq!(restored.page, Some(4));
    }
}
