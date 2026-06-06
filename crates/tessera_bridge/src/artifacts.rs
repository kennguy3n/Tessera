use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_artifacts::manager::ArtifactManager;
use tessera_core::{ArtifactId, ArtifactType, TemplateId};

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
/// Artifact Info.
pub struct ArtifactInfo {
    /// Id.
    pub id: String,
    /// Title.
    pub title: String,
    /// Artifact type.
    pub artifact_type: String,
    /// Template id.
    pub template_id: Option<String>,
    /// Content.
    pub content: String,
    /// Citation count.
    pub citation_count: i32,
    /// Created at.
    pub created_at: String,
    /// Updated at.
    pub updated_at: String,
    /// Version.
    pub version: u32,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// Artifact Version Info.
pub struct ArtifactVersionInfo {
    /// Version.
    pub version: u32,
    /// Content.
    pub content: String,
    /// Created at.
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
    /// Label.
    pub label: String,
    /// Frequency.
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
    /// Similarity score.
    pub similarity_score: f64,
    /// Common themes.
    pub common_themes: Vec<ThemeInfo>,
    /// Unique to a.
    pub unique_to_a: Vec<ThemeInfo>,
    /// Unique to b.
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
    /// Artifact.
    pub artifact: ArtifactInfo,
    /// Comparison.
    pub comparison: ComparisonInfo,
    /// Label a.
    pub label_a: String,
    /// Label b.
    pub label_b: String,
}

/// Create artifact.
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

/// Update artifact content.
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

/// Get artifact.
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

/// List artifacts.
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

/// Delete artifact.
pub fn delete_artifact(manager: &ArtifactManager, artifact_id: &str) -> BridgeResult<()> {
    let uuid =
        uuid::Uuid::parse_str(artifact_id).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    manager.delete(&ArtifactId(uuid)).map_err(BridgeError::Core)
}

/// Artifact to info.
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
