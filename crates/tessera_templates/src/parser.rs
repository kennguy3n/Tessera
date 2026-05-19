use std::path::Path;
use tessera_core::error::{Error, Result};

use crate::template::Template;

pub fn parse_template(yaml_content: &str) -> Result<Template> {
    let template: Template =
        serde_yaml::from_str(yaml_content).map_err(|e| Error::TemplateValidation(e.to_string()))?;
    Ok(template.with_computed_id())
}

pub fn parse_template_file(path: &Path) -> Result<Template> {
    let content = std::fs::read_to_string(path)?;
    parse_template(&content)
}

pub fn load_template_by_id(template_dir: &str, template_id: &str) -> Result<Template> {
    let base = Path::new(template_dir);
    let subdirs = ["documents", "slides", "sheets", "bases"];
    for subdir in &subdirs {
        let dir = base.join(subdir);
        if !dir.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(&dir).map_err(Error::Io)? {
            let entry = entry.map_err(Error::Io)?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("yaml")
                || path.extension().and_then(|e| e.to_str()) == Some("yml")
            {
                if let Ok(tmpl) = parse_template_file(&path) {
                    if tmpl.id == template_id {
                        return Ok(tmpl);
                    }
                }
            }
        }
    }
    Err(Error::TemplateValidation(format!(
        "Template not found: {template_id}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_valid_template() {
        let yaml = r#"
id: prd-v1
name: Product Requirements Document
type: document
description: Standard PRD with problem, solution, scope, and success criteria
sections:
  - title: Problem Statement
    prompt: >
      Summarize the core problem this product addresses,
      citing relevant source material.
    required_sources:
      - type: local
        min: 1
  - title: Proposed Solution
    prompt: >
      Describe the proposed solution.
  - title: Scope
    prompt: >
      Define what is in scope and out of scope.
  - title: Success Criteria
    prompt: >
      List measurable success criteria with targets.
export:
  - markdown
  - html
"#;
        let template = parse_template(yaml).unwrap();
        assert_eq!(template.id, "prd-v1");
        assert_eq!(template.name, "Product Requirements Document");
        assert_eq!(template.sections.len(), 4);
        assert_eq!(template.export.len(), 2);
        assert_eq!(
            template.sections[0].required_sources[0].source_type,
            "local"
        );
    }

    #[test]
    fn parse_invalid_yaml_returns_error() {
        let result = parse_template("not: valid: yaml: {{{}}}");
        assert!(result.is_err());
    }

    #[test]
    fn parse_template_file_works() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.yaml");
        std::fs::write(
            &path,
            r#"
id: test-v1
name: Test Template
type: document
description: A test template
sections:
  - title: Intro
    prompt: Write an introduction.
export:
  - markdown
"#,
        )
        .unwrap();

        let template = parse_template_file(&path).unwrap();
        assert_eq!(template.id, "test-v1");
    }
}
