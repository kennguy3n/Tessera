use serde::{Deserialize, Serialize};
use tessera_artifacts::manager::ArtifactManager;
use tessera_core::{ArtifactId, ArtifactType, TemplateId};

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Serialize, Deserialize)]
pub struct ArtifactInfo {
    pub id: String,
    pub title: String,
    pub artifact_type: String,
    pub template_id: Option<String>,
    pub content: String,
    pub citation_count: usize,
    pub created_at: String,
    pub updated_at: String,
    pub version: u32,
}

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
        artifact_type: serde_json::to_string(&artifact.artifact_type).unwrap_or_default(),
        template_id: artifact.template_id.map(|t| t.to_string()),
        content: artifact.content,
        citation_count: artifact.citations.len(),
        created_at: artifact.created_at.to_rfc3339(),
        updated_at: artifact.updated_at.to_rfc3339(),
        version: artifact.version,
    })
}

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
        artifact_type: serde_json::to_string(&artifact.artifact_type).unwrap_or_default(),
        template_id: artifact.template_id.map(|t| t.to_string()),
        content: artifact.content,
        citation_count: artifact.citations.len(),
        created_at: artifact.created_at.to_rfc3339(),
        updated_at: artifact.updated_at.to_rfc3339(),
        version: artifact.version,
    })
}

pub fn list_artifacts(manager: &ArtifactManager) -> BridgeResult<Vec<ArtifactInfo>> {
    let artifacts = manager.list().map_err(BridgeError::Core)?;
    Ok(artifacts
        .iter()
        .map(|a| ArtifactInfo {
            id: a.id.to_string(),
            title: a.title.clone(),
            artifact_type: serde_json::to_string(&a.artifact_type).unwrap_or_default(),
            template_id: a.template_id.map(|t| t.to_string()),
            content: a.content.clone(),
            citation_count: a.citations.len(),
            created_at: a.created_at.to_rfc3339(),
            updated_at: a.updated_at.to_rfc3339(),
            version: a.version,
        })
        .collect())
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
}
