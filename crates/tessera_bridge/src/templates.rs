use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tessera_templates::TemplateRegistry;

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct TemplateInfo {
    pub id: String,
    pub name: String,
    pub artifact_type: String,
    pub description: String,
    pub section_count: i32,
    pub export_formats: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
pub struct TemplateSectionInfo {
    pub title: String,
    pub prompt: String,
    pub required_sources: bool,
}

pub fn list_templates(template_dir: &str) -> BridgeResult<Vec<TemplateInfo>> {
    let path = Path::new(template_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let registry = TemplateRegistry::load_from_directory(path).map_err(BridgeError::Core)?;

    let templates = registry
        .list()
        .iter()
        .map(|t| TemplateInfo {
            id: t.id.clone(),
            name: t.name.clone(),
            artifact_type: t.artifact_type.to_string(),
            description: t.description.clone(),
            section_count: t.section_count() as i32,
            export_formats: t
                .export_formats()
                .iter()
                .map(std::string::ToString::to_string)
                .collect(),
        })
        .collect();

    Ok(templates)
}

pub fn get_template(template_dir: &str, template_id: &str) -> BridgeResult<Option<TemplateInfo>> {
    let path = Path::new(template_dir);
    if !path.exists() {
        return Ok(None);
    }

    let registry = TemplateRegistry::load_from_directory(path).map_err(BridgeError::Core)?;

    Ok(registry.get_by_id(template_id).map(|t| TemplateInfo {
        id: t.id.clone(),
        name: t.name.clone(),
        artifact_type: t.artifact_type.to_string(),
        description: t.description.clone(),
        section_count: t.section_count() as i32,
        export_formats: t
            .export_formats()
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_templates_from_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::write(
            dir.path().join("documents/prd.yaml"),
            r#"
id: prd-v1
name: PRD
type: document
description: Product Requirements Document
sections:
  - title: Problem
    prompt: Describe the problem.
export:
  - markdown
  - html
"#,
        )
        .unwrap();

        let templates = list_templates(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].id, "prd-v1");
    }

    #[test]
    fn get_template_by_id() {
        let dir = tempfile::tempdir().unwrap();
        // Templates must live under a canonical category subdirectory
        // (see `tessera_templates::TEMPLATE_CATEGORIES`). The
        // `list_templates_from_dir` test above already follows this
        // layout — `get_template_by_id` was written before the WS3
        // contract tightening and used to drop the YAML at the root,
        // which the registry now correctly ignores so its by-id lookup
        // can never diverge from `load_template_by_id` for stray files
        // outside the canonical category tree.
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::write(
            dir.path().join("documents/test.yaml"),
            r#"
id: test-v1
name: Test
type: document
description: Test template
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        let result = get_template(dir.path().to_str().unwrap(), "test-v1").unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "Test");
    }

    #[test]
    fn nonexistent_dir_returns_empty() {
        let templates = list_templates("/nonexistent/path").unwrap();
        assert!(templates.is_empty());
    }
}
