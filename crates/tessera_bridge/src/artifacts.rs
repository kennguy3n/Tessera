//! N-API surface for artifact operations, marshalling between the
//! desktop app and `tessera_artifacts`.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_artifacts::manager::ArtifactManager;
use tessera_core::{ArtifactId, ArtifactType, TemplateId};

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing view of an artifact: identity, type, content body and
/// version metadata.
pub struct ArtifactInfo {
    /// Artifact id, stringified.
    pub id: String,
    /// Human-readable artifact title.
    pub title: String,
    /// Artifact kind (`"document"`, `"sheet"`, …).
    pub artifact_type: String,
    /// Id of the template this artifact was generated from, if any.
    pub template_id: Option<String>,
    /// Full artifact content (markdown or type-specific body).
    pub content: String,
    /// Number of citations attached to the artifact.
    pub citation_count: i32,
    /// When the artifact was created, RFC 3339.
    pub created_at: String,
    /// When the artifact was last updated, RFC 3339.
    pub updated_at: String,
    /// Monotonic version number, bumped on each content update.
    pub version: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing view of one entry in an artifact's version history.
pub struct ArtifactVersionInfo {
    /// Version number of this snapshot.
    pub version: u32,
    /// Artifact content as of this version.
    pub content: String,
    /// When this version was created, RFC 3339.
    pub created_at: String,
}

/// One theme surfaced by `tessera_artifacts::comparison::compare_sources`
/// after it streams over the two sources' chunks and extracts shared
/// /  unique key phrases. Surfaced to the renderer so the
/// `ComparisonResultModal` can render structured theme badges with
/// frequency counts — previously the renderer only had the rendered
/// markdown content, which it would have had to re-parse to extract
/// the same structural data the Rust side already produces.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct ThemeInfo {
    /// Key phrase that names the theme.
    pub label: String,
    /// Number of occurrences across the compared chunks.
    pub frequency: i32,
}

/// Structured comparison surface mirroring
/// `tessera_artifacts::comparison::ComparisonResult`. `similarity_score`
/// is the symmetric-overlap fraction in `[0.0, 1.0]` (the renderer
/// scales it to a percentage). Theme arrays preserve the Rust-side
/// truncation order (`common_themes` ≤ 30, `unique_to_*` ≤ 20)
/// already applied by `compare_sources`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct ComparisonInfo {
    /// Symmetric-overlap fraction in `[0.0, 1.0]`.
    pub similarity_score: f64,
    /// Themes present in both sources (≤ 30, truncation order
    /// preserved).
    pub common_themes: Vec<ThemeInfo>,
    /// Themes unique to the first source (≤ 20).
    pub unique_to_a: Vec<ThemeInfo>,
    /// Themes unique to the second source (≤ 20).
    pub unique_to_b: Vec<ThemeInfo>,
}

/// Return type for `bridge_compare_sources`. Carries BOTH the
/// persisted artifact (so the renderer can navigate to it / link
/// it from elsewhere) AND the structured comparison data (so the
/// modal can render rich theme badges without re-parsing the
/// artifact's markdown). Also carries human-readable source labels
/// computed bridge-side from the source paths so the renderer
/// doesn't have to look them up itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct CompareSourcesResult {
    /// The persisted comparison artifact.
    pub artifact: ArtifactInfo,
    /// Structured comparison data (similarity + theme breakdown).
    pub comparison: ComparisonInfo,
    /// Human-readable label for the first source.
    pub label_a: String,
    /// Human-readable label for the second source.
    pub label_b: String,
}

/// Creates a new artifact of the given type and returns it.
pub fn create_artifact(
    manager: &ArtifactManager,
    title: &str,
    artifact_type: &str,
    template_id: Option<&str>,
) -> BridgeResult<ArtifactInfo> {
    let atype: ArtifactType = serde_json::from_str(&format!("\"{artifact_type}\""))
        .map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let tid = template_id.map(TemplateId::from_string);

    let artifact = manager
        .create(title.to_string(), atype, tid)
        .map_err(BridgeError::Core)?;

    Ok(ArtifactInfo {
        id: artifact.id.to_string(),
        title: artifact.title,
        artifact_type: artifact.artifact_type.to_string(),
        template_id: artifact.template_id.map(|t| t.to_string()),
        content: artifact.content,
        citation_count: artifact.citations.len() as i32,
        created_at: artifact.created_at.to_rfc3339(),
        updated_at: artifact.updated_at.to_rfc3339(),
        version: artifact.version,
    })
}

/// Replaces an artifact's content, bumping its version, and
/// returns the updated artifact.
pub fn update_artifact_content(
    manager: &ArtifactManager,
    artifact_id: &str,
    content: &str,
) -> BridgeResult<ArtifactInfo> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let artifact = manager
        .update_content(&ArtifactId(uuid), content.to_string())
        .map_err(BridgeError::Core)?;

    Ok(ArtifactInfo {
        id: artifact.id.to_string(),
        title: artifact.title,
        artifact_type: artifact.artifact_type.to_string(),
        template_id: artifact.template_id.map(|t| t.to_string()),
        content: artifact.content,
        citation_count: artifact.citations.len() as i32,
        created_at: artifact.created_at.to_rfc3339(),
        updated_at: artifact.updated_at.to_rfc3339(),
        version: artifact.version,
    })
}

/// Fetches a single artifact by id.
pub fn get_artifact(manager: &ArtifactManager, artifact_id: &str) -> BridgeResult<ArtifactInfo> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    let artifact = manager.get(&ArtifactId(uuid)).map_err(BridgeError::Core)?;

    Ok(ArtifactInfo {
        id: artifact.id.to_string(),
        title: artifact.title,
        artifact_type: artifact.artifact_type.to_string(),
        template_id: artifact.template_id.map(|t| t.to_string()),
        content: artifact.content,
        citation_count: artifact.citations.len() as i32,
        created_at: artifact.created_at.to_rfc3339(),
        updated_at: artifact.updated_at.to_rfc3339(),
        version: artifact.version,
    })
}

/// Returns every artifact as [`ArtifactInfo`].
pub fn list_artifacts(manager: &ArtifactManager) -> BridgeResult<Vec<ArtifactInfo>> {
    let artifacts = manager.list().map_err(BridgeError::Core)?;
    Ok(artifacts
        .iter()
        .map(|a| ArtifactInfo {
            id: a.id.to_string(),
            title: a.title.clone(),
            artifact_type: a.artifact_type.to_string(),
            template_id: a.template_id.map(|t| t.to_string()),
            content: a.content.clone(),
            citation_count: a.citations.len() as i32,
            created_at: a.created_at.to_rfc3339(),
            updated_at: a.updated_at.to_rfc3339(),
            version: a.version,
        })
        .collect())
}

/// Deletes an artifact by id.
pub fn delete_artifact(manager: &ArtifactManager, artifact_id: &str) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager.delete(&ArtifactId(uuid)).map_err(BridgeError::Core)
}

/// Converts a core [`Artifact`](tessera_artifacts::Artifact) into
/// its JS-facing [`ArtifactInfo`].
pub fn artifact_to_info(artifact: &tessera_artifacts::Artifact) -> ArtifactInfo {
    ArtifactInfo {
        id: artifact.id.to_string(),
        title: artifact.title.clone(),
        artifact_type: artifact.artifact_type.to_string(),
        template_id: artifact.template_id.map(|t| t.to_string()),
        content: artifact.content.clone(),
        citation_count: artifact.citations.len() as i32,
        created_at: artifact.created_at.to_rfc3339(),
        updated_at: artifact.updated_at.to_rfc3339(),
        version: artifact.version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_create_and_list() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        create_artifact(&manager, "Test PRD", "document", Some("prd-v1")).unwrap();
        create_artifact(&manager, "Budget", "sheet", None).unwrap();

        let artifacts = list_artifacts(&manager).unwrap();
        assert_eq!(artifacts.len(), 2);
    }

    #[test]
    fn bridge_update_content() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let info = create_artifact(&manager, "Test", "document", None).unwrap();
        let updated = update_artifact_content(&manager, &info.id, "Updated content here").unwrap();
        assert_eq!(updated.content, "Updated content here");
        assert_eq!(updated.version, 2);
    }

    #[test]
    fn bridge_get_artifact() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let info = create_artifact(&manager, "Test", "document", None).unwrap();
        let fetched = get_artifact(&manager, &info.id).unwrap();
        assert_eq!(fetched.title, "Test");
    }

    #[test]
    fn bridge_delete_artifact() {
        let manager = ArtifactManager::new_in_memory().unwrap();
        let info = create_artifact(&manager, "Test", "document", None).unwrap();
        delete_artifact(&manager, &info.id).unwrap();
        let artifacts = list_artifacts(&manager).unwrap();
        assert!(artifacts.is_empty());
    }
}
