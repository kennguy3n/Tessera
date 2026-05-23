use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tessera_core::Error as CoreError;
use tessera_templates::parser::load_template_by_id;
use tessera_templates::template::Template;
use tessera_templates::validator::validate_template;
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
    // We deliberately reproduce two semantics from the previous
    // registry-backed implementation:
    //
    // 1. Missing id  -> `Ok(None)`.
    //    `load_template_by_id` returns
    //    `Err(Error::TemplateValidation("Template not found: <id>"))`
    //    on miss. We map *that specific* error back to `Ok(None)` so
    //    the renderer's `None` ("no such template") vs. `Err`
    //    ("lookup failed") contract is preserved.
    //
    // 2. Validation failure -> `Ok(None)`.
    //    The old `TemplateRegistry::load_from_directory` ran
    //    `validate_template` on every template before adding it to
    //    the registry, so `registry.get_by_id` would only ever return
    //    a validated template (and would yield `None` for parse- or
    //    validate-failed YAML). `load_template_by_id` only parses, so
    //    we need to call the validator here to keep `get_template`
    //    contractually equivalent. Logging the validation failure to
    //    stderr matches the convention already used in
    //    `parser::load_template_by_id` and
    //    `registry::load_from_directory`.
    //
    // Every other error (IO, malformed YAML, etc.) still propagates
    // so callers can distinguish a real failure from a missing or
    // invalid id.
    match load_template_by_id(template_dir, template_id) {
        Ok(template) => match validate_template(&template) {
            Ok(()) => Ok(Some(template_to_info(&template))),
            Err(e) => {
                eprintln!("[tessera_bridge] template `{template_id}` failed validation: {e}");
                Ok(None)
            }
        },
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

    /// `get_template` must return `Ok(None)` (not `Ok(Some(...))`) for a
    /// template that parses successfully but fails `validate_template`.
    /// The pre-WS3 implementation enforced this implicitly via
    /// `TemplateRegistry::load_from_directory`, which excluded
    /// validate-failed templates from the registry; the WS3 perf
    /// refactor switched to `load_template_by_id` which only parses,
    /// so the validation step has to be re-applied explicitly inside
    /// `get_template`. This test fails the moment somebody removes
    /// that re-application.
    #[test]
    fn get_template_skips_validate_failed_template() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        // `description` is required (validator at
        // `tessera_templates::validator::validate_template` rejects an
        // empty description). The YAML parses fine; only the validator
        // catches it.
        std::fs::write(
            dir.path().join("documents/invalid.yaml"),
            r#"
id: invalid-v1
name: Invalid
type: document
description: ""
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        let result = get_template(dir.path().to_str().unwrap(), "invalid-v1").unwrap();
        assert!(
            result.is_none(),
            "expected Ok(None) for validate-failed template; got Ok(Some({result:?}))"
        );
    }
}
