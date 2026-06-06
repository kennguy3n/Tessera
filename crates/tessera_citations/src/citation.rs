//! The `Citation` model linking an artifact back to the source span it
//! was derived from.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tessera_core::{CitationId, SourceId, SourceType};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// A provenance record binding a span of generated artifact content to
/// the exact source chunk it was derived from. Snapshots the source's
/// identity and content hashes at creation time so staleness can later
/// be detected even if the source is renamed or edited.
pub struct Citation {
    /// Unique identity of this citation.
    pub citation_id: CitationId,
    /// The source this content was drawn from.
    pub source_id: SourceId,
    /// Kind of the cited source, copied here so the citation renders
    /// without a join back to the source row.
    pub source_type: SourceType,
    /// Human-readable source title at citation time (denormalised
    /// snapshot; not kept in sync if the source is later renamed).
    pub source_title: String,
    /// Locator for the cited source (file URI, document URL, …).
    pub source_uri: String,
    /// BLAKE3 hash of the specific chunk cited — identifies the exact
    /// passage even if surrounding content shifts.
    pub chunk_hash: String,
    /// BLAKE3 hash of the whole source file at citation time. Compared
    /// against the current file hash by [`Citation::source_changed`]
    /// to flag a citation as potentially stale.
    pub source_file_hash: String,
    /// 1-based page number within the source, when it has pages (PDFs,
    /// slide decks); `None` for sources without a page model.
    pub page: Option<u32>,
    /// Model confidence that this source actually supports the cited
    /// content, in `0.0..=1.0` (higher is more confident).
    pub confidence: f64,
    /// Short label for which part of the artifact this citation backs
    /// (e.g. a section name).
    pub used_for: String,
    /// When the citation was created, in UTC.
    pub created_at: DateTime<Utc>,
}

impl Citation {
    #[allow(clippy::too_many_arguments)]
    /// Builds a citation from a freshly retrieved source chunk: mints
    /// a new id, stamps the current UTC time, and leaves `page`
    /// unset (use [`Citation::with_page`] to attach one). `confidence`
    /// is expected in `0.0..=1.0`.
    pub fn new(
        source_id: SourceId,
        source_type: SourceType,
        source_title: String,
        source_uri: String,
        chunk_hash: String,
        source_file_hash: String,
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
            source_file_hash,
            page: None,
            confidence,
            used_for,
            created_at: Utc::now(),
        }
    }

    /// Returns the citation with `page` recorded as its 1-based source
    /// page number (builder-style).
    pub fn with_page(mut self, page: u32) -> Self {
        self.page = Some(page);
        self
    }

    /// Compares the file-level hash stored at citation creation with the current file hash.
    pub fn source_changed(&self, current_file_hash: &str) -> bool {
        self.source_file_hash != current_file_hash
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
            blake3::hash(b"full file content").to_hex().to_string(),
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
        // Same file hash → not changed
        assert!(!citation.source_changed(&citation.source_file_hash));
        // Different file hash → changed
        assert!(citation.source_changed("different_file_hash"));
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
