use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tessera_core::Error as CoreError;
use tessera_templates::parser::load_template_by_id;
use tessera_templates::template::Template;
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

    let templates = registry.list().iter().map(template_to_info).collect();

    Ok(templates)
}

pub fn get_template(template_dir: &str, template_id: &str) -> BridgeResult<Option<TemplateInfo>> {
    let path = Path::new(template_dir);
    if !path.exists() {
        return Ok(None);
    }

    // Short-circuit lookup that streams the template tree and stops at
    // the first id match, instead of materializing the full registry
    // (`TemplateRegistry::load_from_directory`) every call. The
    // renderer's `useEffect` on every `TemplateRunner` mount hits this
    // path, and WS3 grew the on-disk template set ~5x to 170+ files
    // across locales, so the full-registry walk became measurable.
    //
    // `load_template_by_id` returns `Err(Error::TemplateValidation("Template not found: <id>"))`
    // on miss. We map *that specific* error back to `Ok(None)` to
    // preserve the bridge's `Option<TemplateInfo>` contract (the
    // renderer treats `None` as "no such template", not "lookup
    // failed"); every other error -- IO, malformed YAML, etc. -- must
    // still propagate so callers can distinguish a real failure from a
    // missing id.
    match load_template_by_id(template_dir, template_id) {
        Ok(template) => Ok(Some(template_to_info(&template))),
        Err(CoreError::TemplateValidation(msg)) if msg.starts_with("Template not found:") => {
            Ok(None)
        }
        Err(e) => Err(BridgeError::Core(e)),
    }
}

fn template_to_info(t: &Template) -> TemplateInfo {
    TemplateInfo {
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
    }
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
