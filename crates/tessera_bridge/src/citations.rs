//! N-API surface for citation tracking and freshness checks.

use std::borrow::Cow;

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_citations::citation::Citation;
use tessera_citations::freshness::FreshnessStatus;
use tessera_citations::tracker::{CitationReplacement, CitationTracker};
use tessera_core::{ArtifactId, CitationId, SourceId, SourceType};
use tessera_sources::manager::SourceManager;

use crate::{BridgeError, BridgeResult};

/// Translate a citation's stored `source_uri` into the
/// `indexed_files.path` key used for freshness hashing.
///
/// File citations store the absolute path verbatim, which already is
/// the `indexed_files.path`. KChat-post citations instead store the
/// server-agnostic `kchat://channel/<channel_id>/post/<post_id>` URN,
/// while the post's `indexed_files` row is keyed by the synthetic
/// `kchat:post:<post_id>` path minted in
/// `Store::insert_kchat_post_bookkeeping`. Without this translation the
/// hash lookup always misses, so a KChat-post citation captures an
/// empty baseline hash at creation and is then mis-reported as
/// `SourceMissing` on every freshness check.
///
/// Any non-kchat URI — and any malformed kchat URN (missing or empty
/// `post_id`, or a `post_id` that still contains a path separator) — is
/// returned unchanged, so the lookup simply misses and the citation is
/// surfaced for attention rather than silently hashing the wrong key.
fn freshness_lookup_key(source_uri: &str) -> Cow<'_, str> {
    if let Some(rest) = source_uri.strip_prefix("kchat://") {
        if let Some((_, post_id)) = rest.rsplit_once("/post/") {
            if !post_id.is_empty() && !post_id.contains('/') {
                return Cow::Owned(format!("kchat:post:{post_id}"));
            }
        }
    }
    Cow::Borrowed(source_uri)
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing view of a [`Citation`]: source provenance plus the
/// captured snapshot used for freshness checks.
pub struct CitationInfo {
    /// Citation id, stringified.
    pub citation_id: String,
    /// Id of the cited source, stringified.
    pub source_id: String,
    /// Source kind (`"local_file"`, `"kchat"`, …).
    pub source_type: String,
    /// Human-readable source title for display.
    pub source_title: String,
    /// URI/path locating the cited source.
    pub source_uri: String,
    /// Hash of the cited chunk, captured at citation time.
    pub chunk_hash: String,
    /// 1-based page number for paginated sources, if applicable.
    pub page: Option<u32>,
    /// Extraction confidence in `[0, 1]`.
    pub confidence: f64,
    /// Which artifact section the citation supports.
    pub used_for: String,
    /// When the citation was created, RFC 3339.
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[napi(object)]
/// Renderer request to attach a new citation to an artifact.
pub struct AddCitationRequest {
    /// Id of the artifact to cite into, stringified.
    pub artifact_id: String,
    /// Id of the source being cited, stringified.
    pub source_id: String,
    /// Source kind (`"local_file"`, `"kchat"`, …).
    pub source_type: String,
    /// Human-readable source title for display.
    pub source_title: String,
    /// URI/path locating the cited source.
    pub source_uri: String,
    /// Hash of the cited chunk.
    pub chunk_hash: String,
    /// 1-based page number for paginated sources, if applicable.
    pub page: Option<u32>,
    /// Extraction confidence in `[0, 1]`.
    pub confidence: f64,
    /// Which artifact section the citation supports.
    pub used_for: String,
}

impl From<&Citation> for CitationInfo {
    fn from(c: &Citation) -> Self {
        Self {
            citation_id: c.citation_id.to_string(),
            source_id: c.source_id.to_string(),
            source_type: c.source_type.to_string(),
            source_title: c.source_title.clone(),
            source_uri: c.source_uri.clone(),
            chunk_hash: c.chunk_hash.clone(),
            page: c.page,
            confidence: c.confidence,
            used_for: c.used_for.clone(),
            created_at: c.created_at.to_rfc3339(),
        }
    }
}

/// Returns every citation attached to the given artifact.
pub fn list_citations(
    tracker: &CitationTracker,
    artifact_id: &str,
) -> BridgeResult<Vec<CitationInfo>> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let citations = tracker
        .list_for_artifact(&ArtifactId(uuid))
        .map_err(BridgeError::Core)?;
    Ok(citations.iter().map(CitationInfo::from).collect())
}

/// Attaches a new citation to an artifact, capturing the source's
/// current file hash for later freshness checks.
pub fn add_citation(
    tracker: &mut CitationTracker,
    source_manager: &SourceManager,
    req: AddCitationRequest,
) -> BridgeResult<CitationInfo> {
    let artifact_uuid = uuid::Uuid::parse_str(&req.artifact_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source_uuid = uuid::Uuid::parse_str(&req.source_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source_type: SourceType = serde_json::from_str(&format!("\"{}\"", req.source_type))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;

    // Look up the source-level hash at citation creation time for
    // change detection. `freshness_lookup_key` maps a KChat-post URN
    // to the synthetic `kchat:post:<id>` path its `indexed_files` row
    // is keyed by; file URIs pass through unchanged.
    let source_file_hash = source_manager
        .get_current_file_hash(freshness_lookup_key(&req.source_uri).as_ref())
        .map_err(BridgeError::Core)?
        .unwrap_or_default();

    let mut citation = Citation::new(
        SourceId(source_uuid),
        source_type,
        req.source_title,
        req.source_uri,
        req.chunk_hash,
        source_file_hash,
        req.used_for,
        req.confidence,
    );
    if let Some(page) = req.page {
        citation = citation.with_page(page);
    }

    let cid = tracker
        .add(ArtifactId(artifact_uuid), citation.clone())
        .map_err(BridgeError::Core)?;
    let stored = tracker
        .get(&cid)
        .map_err(BridgeError::Core)?
        .ok_or_else(|| BridgeError::InvalidArgs("Failed to retrieve saved citation".to_string()))?;
    Ok(CitationInfo::from(&stored))
}

/// Detaches a citation from an artifact.
pub fn remove_citation(
    tracker: &mut CitationTracker,
    artifact_id: &str,
    citation_id: &str,
) -> BridgeResult<()> {
    let artifact_uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let citation_uuid =
        uuid::Uuid::parse_str(citation_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    tracker
        .remove(&ArtifactId(artifact_uuid), &CitationId(citation_uuid))
        .map_err(BridgeError::Core)?;
    Ok(())
}

/// Returns `true` if the cited source has changed since the
/// citation was captured (legacy boolean form of
/// [`check_source_freshness`]).
pub fn check_source_changed(
    tracker: &CitationTracker,
    source_manager: &SourceManager,
    citation_id: &str,
) -> BridgeResult<bool> {
    let status = check_source_freshness(tracker, source_manager, citation_id)?;
    Ok(status.is_stale())
}

/// Typed freshness lookup — returns one of `Fresh`, `Changed`, or
/// `SourceMissing` so the UI can distinguish the cases. Used by the
/// `citations:checkFreshness` IPC handler. The legacy
/// `check_source_changed` keeps returning `bool` for backwards
/// compatibility with existing callers.
pub fn check_source_freshness(
    tracker: &CitationTracker,
    source_manager: &SourceManager,
    citation_id: &str,
) -> BridgeResult<FreshnessStatus> {
    let citation_uuid =
        uuid::Uuid::parse_str(citation_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    tracker
        .check_freshness(&CitationId(citation_uuid), |uri| {
            source_manager.get_current_file_hash(freshness_lookup_key(uri).as_ref())
        })
        .map_err(BridgeError::Core)
}

#[derive(Debug, Deserialize)]
#[napi(object)]
/// Renderer request to repoint an existing citation at a new
/// source snapshot.
pub struct ReplaceCitationRequest {
    /// Id of the owning artifact, stringified.
    pub artifact_id: String,
    /// Id of the citation to replace, stringified.
    pub citation_id: String,
    /// Id of the new source, stringified.
    pub source_id: String,
    /// New source kind (`"local_file"`, `"kchat"`, …).
    pub source_type: String,
    /// New source title for display.
    pub source_title: String,
    /// New source URI/path.
    pub source_uri: String,
    /// Hash of the new cited chunk.
    pub chunk_hash: String,
    /// 1-based page number for paginated sources, if applicable.
    pub page: Option<u32>,
    /// Extraction confidence in `[0, 1]`.
    pub confidence: f64,
}

#[derive(Debug, Serialize)]
#[napi(object)]
/// Result of a citation replacement: the updated citation plus the
/// URI it previously pointed at.
pub struct ReplaceCitationResult {
    /// The citation after the swap.
    pub citation: CitationInfo,
    /// URI the citation pointed at before the swap.
    pub previous_source_uri: String,
}

/// Repoints a citation at a new source snapshot, returning the
/// updated citation and its previous URI.
pub fn replace_citation(
    tracker: &mut CitationTracker,
    source_manager: &SourceManager,
    req: ReplaceCitationRequest,
) -> BridgeResult<ReplaceCitationResult> {
    let artifact_uuid = uuid::Uuid::parse_str(&req.artifact_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let citation_uuid = uuid::Uuid::parse_str(&req.citation_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source_uuid = uuid::Uuid::parse_str(&req.source_id)
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let source_type: SourceType = serde_json::from_str(&format!("\"{}\"", req.source_type))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;

    let previous = tracker
        .get(&CitationId(citation_uuid))
        .map_err(BridgeError::Core)?
        .ok_or_else(|| BridgeError::InvalidArgs("Citation not found".to_string()))?;
    let previous_source_uri = previous.source_uri.clone();

    // Resolve the new source's current hash so freshness checks are
    // valid immediately after the swap. `freshness_lookup_key` maps a
    // KChat-post URN to its synthetic `indexed_files` path.
    let source_file_hash = source_manager
        .get_current_file_hash(freshness_lookup_key(&req.source_uri).as_ref())
        .map_err(BridgeError::Core)?
        .unwrap_or_default();

    let replacement = CitationReplacement {
        source_id: SourceId(source_uuid),
        source_type,
        source_title: req.source_title,
        source_uri: req.source_uri,
        chunk_hash: req.chunk_hash,
        source_file_hash,
        page: req.page,
        confidence: req.confidence,
    };

    let updated = tracker
        .replace(
            &ArtifactId(artifact_uuid),
            &CitationId(citation_uuid),
            replacement,
        )
        .map_err(BridgeError::Core)?;

    Ok(ReplaceCitationResult {
        citation: CitationInfo::from(&updated),
        previous_source_uri,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_add_and_list_citations() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();

        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();

        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: SourceId::new().to_string(),
            source_type: "local_file".to_string(),
            source_title: "test.pdf".to_string(),
            source_uri: "file:///test.pdf".to_string(),
            chunk_hash: "hash123".to_string(),
            page: Some(1),
            confidence: 0.9,
            used_for: "Problem Statement".to_string(),
        };

        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();
        assert_eq!(info.source_title, "test.pdf");
        assert_eq!(info.page, Some(1));

        let citations = list_citations(&tracker, &aid.to_string()).unwrap();
        assert_eq!(citations.len(), 1);
    }

    #[test]
    fn bridge_remove_citation() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();

        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();

        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: SourceId::new().to_string(),
            source_type: "local_file".to_string(),
            source_title: "test.pdf".to_string(),
            source_uri: "file:///test.pdf".to_string(),
            chunk_hash: "hash123".to_string(),
            page: None,
            confidence: 0.85,
            used_for: "Test".to_string(),
        };

        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();
        remove_citation(&mut tracker, &aid.to_string(), &info.citation_id).unwrap();

        let citations = list_citations(&tracker, &aid.to_string()).unwrap();
        assert!(citations.is_empty());
    }

    #[test]
    fn bridge_check_source_changed() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let test_file = dir.path().join("test.txt");
        std::fs::write(&test_file, "test content").unwrap();

        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();
        let source = source_mgr
            .add_local_file(test_file.to_str().unwrap())
            .unwrap();

        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();

        // The indexed file hash is the hash stored by the source manager
        let files = source_mgr.list_indexed_files(&source.id).unwrap();
        let file_hash = &files[0].hash;

        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: source.id.to_string(),
            source_type: "local_file".to_string(),
            source_title: "test.pdf".to_string(),
            source_uri: test_file.to_str().unwrap().to_string(),
            chunk_hash: file_hash.clone(),
            page: None,
            confidence: 0.85,
            used_for: "Test".to_string(),
        };

        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();
        // File hash matches indexed file — not changed
        assert!(!check_source_changed(&tracker, &source_mgr, &info.citation_id).unwrap());

        // Change the file and reindex so hash differs
        std::fs::write(&test_file, "modified content").unwrap();
        source_mgr.reindex_source(&source.id).unwrap();
        assert!(check_source_changed(&tracker, &source_mgr, &info.citation_id).unwrap());
        assert_eq!(
            check_source_freshness(&tracker, &source_mgr, &info.citation_id).unwrap(),
            FreshnessStatus::Changed,
        );
    }

    #[test]
    fn bridge_check_freshness_reports_missing_when_source_removed() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();

        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: SourceId::new().to_string(),
            source_type: "local_file".to_string(),
            source_title: "ghost.pdf".to_string(),
            source_uri: "file:///does/not/exist.pdf".to_string(),
            chunk_hash: "abc".to_string(),
            page: None,
            confidence: 0.5,
            used_for: "Section".to_string(),
        };
        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();

        assert_eq!(
            check_source_freshness(&tracker, &source_mgr, &info.citation_id).unwrap(),
            FreshnessStatus::SourceMissing
        );
        assert!(check_source_changed(&tracker, &source_mgr, &info.citation_id).unwrap());
    }

    #[test]
    fn bridge_replace_citation_updates_source_and_preserves_used_for() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let old_file = dir.path().join("old.txt");
        let new_file = dir.path().join("new.txt");
        std::fs::write(&old_file, "old content").unwrap();
        std::fs::write(&new_file, "new content").unwrap();

        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();
        let old_source = source_mgr
            .add_local_file(old_file.to_str().unwrap())
            .unwrap();
        let new_source = source_mgr
            .add_local_file(new_file.to_str().unwrap())
            .unwrap();

        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();

        let initial_files = source_mgr.list_indexed_files(&old_source.id).unwrap();
        let old_hash = initial_files[0].hash.clone();
        let new_files = source_mgr.list_indexed_files(&new_source.id).unwrap();
        let new_hash = new_files[0].hash.clone();
        assert_ne!(old_hash, new_hash);

        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: old_source.id.to_string(),
            source_type: "local_file".to_string(),
            source_title: "old.txt".to_string(),
            source_uri: old_file.to_str().unwrap().to_string(),
            chunk_hash: old_hash.clone(),
            page: None,
            confidence: 0.5,
            used_for: "Problem Statement".to_string(),
        };
        let citation = add_citation(&mut tracker, &source_mgr, req).unwrap();

        let replace_req = ReplaceCitationRequest {
            artifact_id: aid.to_string(),
            citation_id: citation.citation_id.clone(),
            source_id: new_source.id.to_string(),
            source_type: "local_file".to_string(),
            source_title: "new.txt".to_string(),
            source_uri: new_file.to_str().unwrap().to_string(),
            chunk_hash: new_hash.clone(),
            page: Some(3),
            confidence: 0.9,
        };
        let result = replace_citation(&mut tracker, &source_mgr, replace_req).unwrap();

        assert_eq!(result.previous_source_uri, citation.source_uri);
        assert_eq!(result.citation.citation_id, citation.citation_id);
        assert_eq!(result.citation.source_title, "new.txt");
        assert_eq!(result.citation.chunk_hash, new_hash);
        assert_eq!(result.citation.page, Some(3));
        // used_for is preserved across the replace.
        assert_eq!(result.citation.used_for, "Problem Statement");
        // Citation count for the artifact is unchanged.
        let list = list_citations(&tracker, &aid.to_string()).unwrap();
        assert_eq!(list.len(), 1);
        // After replace, freshness is Fresh because the new source's
        // file hash was just resolved.
        assert_eq!(
            check_source_freshness(&tracker, &source_mgr, &citation.citation_id).unwrap(),
            FreshnessStatus::Fresh,
        );
    }

    #[test]
    fn bridge_replace_citation_rejects_unknown_artifact() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();
        let mut tracker = CitationTracker::new_in_memory().unwrap();

        let aid = ArtifactId::new();
        let other_aid = ArtifactId::new();
        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: SourceId::new().to_string(),
            source_type: "local_file".to_string(),
            source_title: "doc.pdf".to_string(),
            source_uri: "file:///doc.pdf".to_string(),
            chunk_hash: "h".to_string(),
            page: None,
            confidence: 0.5,
            used_for: "Section".to_string(),
        };
        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();

        let replace = ReplaceCitationRequest {
            artifact_id: other_aid.to_string(),
            citation_id: info.citation_id.clone(),
            source_id: SourceId::new().to_string(),
            source_type: "local_file".to_string(),
            source_title: "other.pdf".to_string(),
            source_uri: "file:///other.pdf".to_string(),
            chunk_hash: "h2".to_string(),
            page: None,
            confidence: 0.5,
        };
        let result = replace_citation(&mut tracker, &source_mgr, replace);
        assert!(result.is_err(), "should reject mismatched artifact");
    }

    #[test]
    fn freshness_lookup_key_maps_kchat_urn_to_synthetic_path() {
        // KChat-post URN → synthetic `indexed_files` path.
        assert_eq!(
            freshness_lookup_key("kchat://channel/eng-general/post/post-abc").as_ref(),
            "kchat:post:post-abc",
        );
        // File URIs and bare paths pass through unchanged.
        assert_eq!(
            freshness_lookup_key("file:///docs/q3.md").as_ref(),
            "file:///docs/q3.md",
        );
        assert_eq!(
            freshness_lookup_key("/abs/path.txt").as_ref(),
            "/abs/path.txt",
        );
        // Malformed kchat URNs (no `/post/` segment, empty post id, or a
        // post id carrying a stray separator) are returned unchanged so
        // the lookup simply misses rather than hashing a wrong key.
        assert_eq!(
            freshness_lookup_key("kchat://channel/eng-general").as_ref(),
            "kchat://channel/eng-general",
        );
        assert_eq!(
            freshness_lookup_key("kchat://channel/eng/post/").as_ref(),
            "kchat://channel/eng/post/",
        );
        assert_eq!(
            freshness_lookup_key("kchat://channel/eng/post/a/b").as_ref(),
            "kchat://channel/eng/post/a/b",
        );
    }

    /// End-to-end regression for the KChat-post citation freshness bug:
    /// a post citation stores the `kchat://channel/<c>/post/<p>` URN,
    /// but the post's `indexed_files` row is keyed by the synthetic
    /// `kchat:post:<p>` path. Before the fix the URN never matched, so
    /// every post citation captured an empty baseline hash and was then
    /// permanently mis-reported as `SourceMissing`. The bridge now
    /// translates the URN, so freshness correctly tracks the post
    /// through edit (→ `Changed`) and delete (→ `SourceMissing`).
    #[test]
    fn bridge_kchat_post_citation_tracks_freshness_across_edit_and_delete() {
        use tessera_sources::manager::KchatPostIngestInput;

        let db_dir = tempfile::tempdir().unwrap();
        let db_path = db_dir.path().join("test.db");
        let cache = tempfile::tempdir().unwrap();
        let cache_dir = cache.path().to_str().unwrap();

        let source_mgr = SourceManager::new(db_path.to_str().unwrap(), &[]).unwrap();
        let added = source_mgr.add_kchat_channel(cache_dir).unwrap();

        let post = KchatPostIngestInput {
            cache_dir: cache_dir.to_string(),
            post_id: "post-abc".to_string(),
            channel_id: "channel-xyz".to_string(),
            root_id: None,
            sender_user_id: "user-ken".to_string(),
            body: "team agreed: push Q3 launch to Sept 15".to_string(),
            created_at_ms: 1_700_000_000_000,
            edited_at_ms: 0,
        };
        source_mgr.ingest_kchat_post(&post).unwrap();

        let mut tracker = CitationTracker::new_in_memory().unwrap();
        let aid = ArtifactId::new();
        let req = AddCitationRequest {
            artifact_id: aid.to_string(),
            source_id: added.source.id.to_string(),
            source_type: "kchat".to_string(),
            source_title: "Eng - General".to_string(),
            source_uri: "kchat://channel/channel-xyz/post/post-abc".to_string(),
            chunk_hash: "chathash".to_string(),
            page: None,
            confidence: 0.82,
            used_for: "claim/q3".to_string(),
        };
        let info = add_citation(&mut tracker, &source_mgr, req).unwrap();

        // The baseline captured the post's real `indexed_files` hash
        // (not the empty string the URN-keyed lookup used to yield), so
        // the freshly-cited, unchanged post reports `Fresh`.
        assert_eq!(
            check_source_freshness(&tracker, &source_mgr, &info.citation_id).unwrap(),
            FreshnessStatus::Fresh,
        );

        // Editing the post changes its body hash → `Changed`.
        let edited = KchatPostIngestInput {
            body: "team agreed: push Q3 launch to Oct 1 instead".to_string(),
            ..post.clone()
        };
        source_mgr.edit_kchat_post(&edited).unwrap();
        assert_eq!(
            check_source_freshness(&tracker, &source_mgr, &info.citation_id).unwrap(),
            FreshnessStatus::Changed,
        );

        // Deleting the post drops its `indexed_files` row → genuinely
        // `SourceMissing` (the only case that should now report it).
        source_mgr.delete_kchat_post(cache_dir, "post-abc").unwrap();
        assert_eq!(
            check_source_freshness(&tracker, &source_mgr, &info.citation_id).unwrap(),
            FreshnessStatus::SourceMissing,
        );
    }
}
