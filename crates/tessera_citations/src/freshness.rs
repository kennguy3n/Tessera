//! Citation source-freshness detection.
//!
//! A citation's [`crate::citation::Citation`] stores the file-level
//! hash of the source at the time the citation was created. Once a
//! source is re-indexed (by [`tessera_sources::indexer::Indexer`])
//! the hash will change if the bytes on disk changed. The
//! [`FreshnessChecker`] consumes a callback that maps a `source_uri`
//! to the current file hash and produces a typed [`FreshnessStatus`]
//! so callers can distinguish three cases:
//!
//! 1. `Fresh` — the source bytes still match the citation.
//! 2. `Changed` — the source still exists but the bytes are different.
//! 3. `SourceMissing` — the source URI is no longer indexed (file
//!    deleted, source disconnected, etc.).
//!
//! The bridge layer and the React `CitationPanel` use this result
//! to render the warning indicator described in
//! `PROPOSAL.md` line 255 ("Show if source changed").

use serde::{Deserialize, Serialize};

use crate::citation::Citation;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FreshnessStatus {
    Fresh,
    Changed,
    SourceMissing,
}

impl FreshnessStatus {
    pub fn is_stale(self) -> bool {
        !matches!(self, Self::Fresh)
    }

    /// Snake-case string form mirroring the `serde(rename_all)`
    /// representation. Useful at FFI boundaries where the renderer
    /// expects a stable string discriminator.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Changed => "changed",
            Self::SourceMissing => "source_missing",
        }
    }
}

/// Compute the freshness status for a single citation.
///
/// `current_hash_lookup` is called once with the citation's
/// `source_uri`. It returns `Ok(Some(hash))` when the source is
/// still indexed, `Ok(None)` when the source has been removed, and
/// `Err(_)` on store errors which the caller should propagate.
pub fn check_source_freshness<F, E>(
    citation: &Citation,
    current_hash_lookup: F,
) -> std::result::Result<FreshnessStatus, E>
where
    F: FnOnce(&str) -> std::result::Result<Option<String>, E>,
{
    match current_hash_lookup(&citation.source_uri)? {
        None => Ok(FreshnessStatus::SourceMissing),
        Some(current) if citation.source_changed(&current) => Ok(FreshnessStatus::Changed),
        Some(_) => Ok(FreshnessStatus::Fresh),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::{SourceId, SourceType};

    fn sample_citation() -> Citation {
        Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "doc.pdf".to_string(),
            "file:///tmp/doc.pdf".to_string(),
            "chunk_hash_aaa".to_string(),
            "file_hash_bbb".to_string(),
            "Section".to_string(),
            0.9,
        )
    }

    #[test]
    fn fresh_when_hash_matches() {
        let c = sample_citation();
        let status: FreshnessStatus =
            check_source_freshness::<_, ()>(&c, |_| Ok(Some(c.source_file_hash.clone()))).unwrap();
        assert_eq!(status, FreshnessStatus::Fresh);
        assert!(!status.is_stale());
    }

    #[test]
    fn changed_when_hash_differs() {
        let c = sample_citation();
        let status: FreshnessStatus =
            check_source_freshness::<_, ()>(&c, |_| Ok(Some("file_hash_changed".to_string())))
                .unwrap();
        assert_eq!(status, FreshnessStatus::Changed);
        assert!(status.is_stale());
    }

    #[test]
    fn source_missing_when_not_indexed() {
        let c = sample_citation();
        let status: FreshnessStatus = check_source_freshness::<_, ()>(&c, |_| Ok(None)).unwrap();
        assert_eq!(status, FreshnessStatus::SourceMissing);
        assert!(status.is_stale());
    }

    #[test]
    fn propagates_lookup_errors() {
        let c = sample_citation();
        let err = check_source_freshness::<_, String>(&c, |_| Err("boom".to_string()));
        assert_eq!(err.unwrap_err(), "boom");
    }

    #[test]
    fn freshness_status_serialises_snake_case() {
        let json = serde_json::to_string(&FreshnessStatus::SourceMissing).unwrap();
        assert_eq!(json, "\"source_missing\"");
        let parsed: FreshnessStatus = serde_json::from_str("\"changed\"").unwrap();
        assert_eq!(parsed, FreshnessStatus::Changed);
    }
}
