use std::path::Path;
use tessera_core::error::Result;
use tessera_core::ArtifactType;
use walkdir::WalkDir;

use crate::parser::parse_template_file;
use crate::template::Template;
use crate::validator::validate_template;

pub struct TemplateRegistry {
    templates: Vec<Template>,
}

impl TemplateRegistry {
    pub fn new() -> Self {
        Self {
            templates: Vec::new(),
        }
    }

    pub fn load_from_directory(path: &Path) -> Result<Self> {
        let mut registry = Self::new();

        for entry in WalkDir::new(path)
            .follow_links(false)
            .into_iter()
            .filter_map(std::result::Result::ok)
        {
            let file_path = entry.path();
            if !file_path.is_file() {
                continue;
            }
            let ext = file_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or_default();
            if ext != "yaml" && ext != "yml" {
                continue;
            }
            match parse_template_file(file_path) {
                Ok(template) => match validate_template(&template) {
                    Ok(()) => registry.templates.push(template),
                    Err(e) => {
                        // The template parsed but failed semantic
                        // validation (missing sections, invalid
                        // max_tokens, etc.). Skip it so the rest of the
                        // registry still loads, but surface the error
                        // so the operator can fix the offending file.
                        eprintln!(
                            "[tessera_templates] template at {} failed validation: {e}",
                            file_path.display()
                        );
                    }
                },
                Err(e) => {
                    // YAML couldn't deserialize into the canonical
                    // Template struct. The 4 known legacy visual
                    // templates fall into this bucket today (different
                    // section schema); see
                    // `LEGACY_VISUAL_SCHEMA_TEMPLATES` in
                    // `bundled_templates.rs`. Other parse failures
                    // here indicate a typo or schema drift — we surface
                    // them rather than swallow silently.
                    eprintln!(
                        "[tessera_templates] skipping unparseable template at {}: {e}",
                        file_path.display()
                    );
                }
            }
        }

        registry.templates.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(registry)
    }

    pub fn list(&self) -> &[Template] {
        &self.templates
    }

    pub fn get_by_id(&self, id: &str) -> Option<&Template> {
        self.templates.iter().find(|t| t.id == id)
    }

    pub fn list_by_type(&self, artifact_type: ArtifactType) -> Vec<&Template> {
        self.templates
            .iter()
            .filter(|t| t.artifact_type == artifact_type)
            .collect()
    }

    pub fn count(&self) -> usize {
        self.templates.len()
    }
}

impl Default for TemplateRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_templates(dir: &Path) {
        std::fs::create_dir_all(dir.join("documents")).unwrap();
        std::fs::create_dir_all(dir.join("slides")).unwrap();

        std::fs::write(
            dir.join("documents/prd.yaml"),
            r#"
id: prd-v1
name: Product Requirements Document
type: document
description: Standard PRD
sections:
  - title: Problem Statement
    prompt: Describe the problem.
  - title: Solution
    prompt: Describe the solution.
export:
  - markdown
  - html
"#,
        )
        .unwrap();

        std::fs::write(
            dir.join("slides/qbr.yaml"),
            r#"
id: qbr-v1
name: Quarterly Business Review
type: slides
description: QBR deck
sections:
  - title: Executive Summary
    prompt: Summarize the quarter.
  - title: Metrics
    prompt: Present key metrics.
export:
  - markdown
"#,
        )
        .unwrap();
    }

    #[test]
    fn load_templates_from_directory() {
        let dir = tempfile::tempdir().unwrap();
        create_test_templates(dir.path());

        let registry = TemplateRegistry::load_from_directory(dir.path()).unwrap();
        assert_eq!(registry.count(), 2);
    }

    #[test]
    fn get_template_by_id() {
        let dir = tempfile::tempdir().unwrap();
        create_test_templates(dir.path());

        let registry = TemplateRegistry::load_from_directory(dir.path()).unwrap();
        let prd = registry.get_by_id("prd-v1");
        assert!(prd.is_some());
        assert_eq!(prd.unwrap().name, "Product Requirements Document");
    }

    #[test]
    fn list_by_type() {
        let dir = tempfile::tempdir().unwrap();
        create_test_templates(dir.path());

        let registry = TemplateRegistry::load_from_directory(dir.path()).unwrap();
        let docs = registry.list_by_type(ArtifactType::Document);
        assert_eq!(docs.len(), 1);

        let slides = registry.list_by_type(ArtifactType::Slides);
        assert_eq!(slides.len(), 1);
    }

    #[test]
    fn empty_directory_produces_empty_registry() {
        let dir = tempfile::tempdir().unwrap();
        let registry = TemplateRegistry::load_from_directory(dir.path()).unwrap();
        assert_eq!(registry.count(), 0);
    }
}
