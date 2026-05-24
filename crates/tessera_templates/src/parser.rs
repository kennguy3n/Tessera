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
    // The category list is the canonical `crate::TEMPLATE_CATEGORIES`
    // constant — `tests/bundled_templates.rs` and any future tooling
    // that walks the template tree share the same source of truth, so
    // adding a category is a one-line edit at the crate root.
    for subdir in crate::TEMPLATE_CATEGORIES {
        let dir = base.join(subdir);
        if !dir.is_dir() {
            continue;
        }
        for entry_result in walkdir::WalkDir::new(&dir).follow_links(false) {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(e) => {
                    // Walkdir failed to descend into a subdirectory
                    // (most commonly: permission denied on
                    // `locales/<code>/`). The earlier implementation
                    // used `std::fs::read_dir(&dir).map_err(...)?` and
                    // would have propagated the IO error to the caller;
                    // the walkdir migration would silently drop it via
                    // `filter_map(Result::ok)`. Log it so an unreadable
                    // template directory surfaces in operator logs
                    // (matching the convention used for parse / validate
                    // failures below) instead of producing a misleading
                    // "Template not found" error downstream.
                    eprintln!(
                        "[tessera_templates] walkdir error under {}: {e}",
                        dir.display()
                    );
                    continue;
                }
            };
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
                    // `if let Ok` swallow; the walkdir migration in an earlier release
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
    // Dedicated `TemplateNotFound` variant (not `TemplateValidation`)
    // so callers like the NAPI bridge can distinguish a missing id
    // (`Ok(None)` in the UI) from a parse/validation error (real
    // failure) without resorting to string matching on the error
    // message. Previously this returned
    // `Error::TemplateValidation(format!("Template not found: {id}"))`
    // and the bridge did
    // `if msg.starts_with("Template not found:")` to recover the
    // not-found semantics; any future refactor of the error text
    // would have silently broken that contract. See
    // `crates/tessera_bridge/src/templates.rs::get_template` for
    // the matching consumer.
    Err(Error::TemplateNotFound(template_id.to_string()))
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
