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
    // Recurse over every template-category directory. We list the
    // categories explicitly (rather than walking `template_dir` as a
    // single tree) so unrelated subdirectories like `grammars/` are
    // never opened. `walkdir::WalkDir` then visits every nested
    // `locales/<locale>/` directory so localized variants are
    // reachable by id without an additional lookup step.
    //
    // The category list mirrors `RUST_TEMPLATE_DIRS` /
    // `TEMPLATE_CATEGORIES` in the smoke suites — keep these three
    // lists in sync when adding a new category.
    let subdirs = [
        "documents",
        "slides",
        "sheets",
        "bases",
        "infographics",
        "landing_pages",
    ];
    for subdir in &subdirs {
        let dir = base.join(subdir);
        if !dir.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir)
            .follow_links(false)
            .into_iter()
            .filter_map(std::result::Result::ok)
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if !matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("yaml" | "yml")
            ) {
                continue;
            }
            match parse_template_file(path) {
                Ok(tmpl) => {
                    if tmpl.id == template_id {
                        return Ok(tmpl);
                    }
                }
                Err(e) => {
                    // Don't fail the whole lookup just because one YAML
                    // file is corrupted — the target template may still
                    // live in a sibling file. But surface the parse
                    // error so an unrelated typo doesn't silently mask
                    // a working template. This used to be a silent
                    // `if let Ok` swallow; the walkdir migration in WS3
                    // expanded the search set to every localized
                    // variant, making silent swallowing much more
                    // dangerous (a broken `prd-v1-ja` would mask
                    // nothing visible to the user). Mirrors the
                    // `eprintln!` convention used in tessera_sources.
                    eprintln!(
                        "[tessera_templates] skipping malformed template at {}: {e}",
                        path.display()
                    );
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
    fn parse_marp_slide_template_round_trips() {
        let yaml = r#"
id: deck-v1
name: Marp Deck
type: slides
description: A Marp-rendered deck template
format: marp
theme: gaia
paginate: true
sections:
  - title: Intro
    prompt: Lay out the headline.
export:
  - markdown
  - pptx
  - pdf
marp_template: |
  ---
  marp: true
  theme: gaia
  paginate: true
  ---

  # Hello world
"#;
        let template = parse_template(yaml).unwrap();
        assert_eq!(template.format.as_deref(), Some("marp"));
        assert_eq!(template.theme.as_deref(), Some("gaia"));
        assert_eq!(template.paginate, Some(true));
        let marp = template
            .marp_template
            .as_deref()
            .expect("marp_template should be present");
        assert!(marp.contains("marp: true"));
        assert!(marp.contains("# Hello world"));
    }

    #[test]
    fn parse_template_without_marp_fields_is_still_valid() {
        let yaml = r#"
id: plain-v1
name: Plain
type: document
description: A plain template
sections:
  - title: Body
    prompt: Body
export:
  - markdown
"#;
        let template = parse_template(yaml).unwrap();
        assert!(template.format.is_none());
        assert!(template.marp_template.is_none());
        assert!(template.theme.is_none());
        assert!(template.paginate.is_none());
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
