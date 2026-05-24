use std::path::{Path, PathBuf};
use tessera_core::error::Result;
use tessera_core::ArtifactType;
use walkdir::WalkDir;

use crate::parser::parse_template_file;
use crate::template::Template;
use crate::validator::validate_template;

pub struct TemplateRegistry {
    templates: Vec<Template>,
}

/// Failure mode for a single template file encountered during
/// `load_from_directory_with_failures`. Mirrors the two `match`
/// arms in the load loop: a YAML that did not deserialize into
/// `Template` is `Parse`; a YAML that deserialized but failed
/// `validate_template` (missing sections, invalid max_tokens, etc.)
/// is `Validation`. The distinction matters to the audit layer
/// because parse failures are typically schema drift (operator
/// edits the YAML by hand and breaks the shape) while validation
/// failures are typically authoring mistakes (forgot a section,
/// out-of-range max_tokens) — different remediation paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplateLoadFailureKind {
    Parse,
    Validation,
}

impl TemplateLoadFailureKind {
    /// Stable string form used by audit payloads. Matches the
    /// `kind` parameter accepted by
    /// `tessera_audit::AuditLogger::log_template_validation_failed`.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Parse => "parse",
            Self::Validation => "validation",
        }
    }
}

/// One template file that failed parse or validation during
/// registry load. The bridge layer audits these via
/// `log_template_validation_failed` so operators can grep the
/// audit log for templates that went missing from the registry.
#[derive(Debug, Clone)]
pub struct TemplateLoadFailure {
    pub path: PathBuf,
    pub kind: TemplateLoadFailureKind,
    pub error: String,
}

/// Result of `load_from_directory_with_failures`. Carries the
/// successfully-loaded registry plus the list of files that were
/// silently dropped due to parse or validation failure, so the
/// caller can audit / report on the dropped files instead of only
/// seeing them in stderr.
pub struct TemplateLoadResult {
    pub registry: TemplateRegistry,
    pub failures: Vec<TemplateLoadFailure>,
}

impl TemplateRegistry {
    pub fn new() -> Self {
        Self {
            templates: Vec::new(),
        }
    }

    pub fn load_from_directory(path: &Path) -> Result<Self> {
        // Preserve the historical signature (and the eprintln-based
        // operator surface) for every caller that only cares about
        // the successful subset. The new
        // `load_from_directory_with_failures` is the entry point for
        // callers that need to inspect the dropped files — the
        // bridge layer uses it to route failures into the audit log.
        let result = Self::load_from_directory_with_failures(path)?;
        Ok(result.registry)
    }

    /// Same load loop as `load_from_directory`, but additionally
    /// returns every template file that was silently dropped due to
    /// parse or validation failure. The successful registry is
    /// still returned (load-and-continue posture preserved), so a
    /// single broken template never takes down the entire list
    /// operation — the bridge gate is
    /// `bundled_templates.rs::every_bundled_template_parses_and_validates`
    /// in CI.
    pub fn load_from_directory_with_failures(path: &Path) -> Result<TemplateLoadResult> {
        let mut registry = Self::new();
        let mut failures: Vec<TemplateLoadFailure> = Vec::new();

        // Walk every canonical template-category directory rooted at
        // `path/<category>/`. This mirrors `parser::load_template_by_id`
        // so the list and the by-id lookup paths can never disagree on
        // which files count as templates — adding a new category at
        // `crate::TEMPLATE_CATEGORIES` updates both paths atomically.
        // Walking the entire `path` tree (as an earlier implementation
        // did) would also process stray YAML under `templates/grammars/`
        // or any other non-category subdirectory the runtime parser
        // deliberately ignores, which would silently desync the "list"
        // and "load by id" semantics. The tests in this file create
        // their fixtures under the same canonical category names, so
        // they continue to pass unchanged.
        for category in crate::TEMPLATE_CATEGORIES {
            let category_root = path.join(category);
            if !category_root.is_dir() {
                continue;
            }
            for entry_result in WalkDir::new(&category_root).follow_links(false) {
                let entry = match entry_result {
                    Ok(entry) => entry,
                    Err(e) => {
                        // Walkdir failed to descend (e.g. permission
                        // denied on `locales/<code>/`). The earlier
                        // implementation propagated IO errors via
                        // `read_dir(&dir).map_err(...)?`; the walkdir
                        // migration would silently drop them via
                        // `filter_map(Result::ok)`. Log so an
                        // unreadable directory shows up in operator
                        // logs instead of silently shrinking the
                        // registry list. Mirrors the convention used
                        // for parse / validate failures below.
                        eprintln!(
                            "[tessera_templates] walkdir error under {}: {e}",
                            category_root.display()
                        );
                        continue;
                    }
                };
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
                            // max_tokens, etc.). Skip it so the rest
                            // of the registry still loads, but surface
                            // the error so the operator can fix the
                            // offending file. We also record the
                            // failure structurally so the bridge can
                            // emit an audit row — eprintln alone is
                            // not durable (it goes to the Electron
                            // main process stderr which the user
                            // typically does not see in a packaged
                            // build).
                            eprintln!(
                                "[tessera_templates] template at {} failed validation: {e}",
                                file_path.display()
                            );
                            failures.push(TemplateLoadFailure {
                                path: file_path.to_path_buf(),
                                kind: TemplateLoadFailureKind::Validation,
                                error: e.to_string(),
                            });
                        }
                    },
                    Err(e) => {
                        // YAML couldn't deserialize into the canonical
                        // `Template` struct. Historically the four
                        // legacy visual templates
                        // (infographics/{comparison, process-flow,
                        // stats-overview}.yaml and
                        // landing_pages/saas-product.yaml) failed here
                        // because they used the pre-canonical
                        // `heading:` section schema; an earlier release migrated
                        // those YAMLs to canonical `title:` / `prompt:`
                        // and they now parse successfully (the
                        // visual-hint fields `layout`,
                        // `default_icon_set`, `color_scheme`, and
                        // per-section `icon_suggestion` are silently
                        // ignored by serde, by design).
                        //
                        // Today this arm exists purely as a guard
                        // against future schema drift / typos: any
                        // YAML newly committed under a category root
                        // that doesn't deserialize into `Template`
                        // surfaces here with the file path so the
                        // operator can fix it rather than have it
                        // silently disappear from the registry. We
                        // log-and-continue rather than `?`-propagate
                        // so a single broken template doesn't take
                        // down the entire list operation —
                        // `bundled_templates.rs::every_bundled_
                        // template_parses_and_validates` is the
                        // hard-fail gate in CI.
                        eprintln!(
                            "[tessera_templates] skipping unparseable template at {}: {e}",
                            file_path.display()
                        );
                        failures.push(TemplateLoadFailure {
                            path: file_path.to_path_buf(),
                            kind: TemplateLoadFailureKind::Parse,
                            error: e.to_string(),
                        });
                    }
                }
            }
        }

        registry.templates.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(TemplateLoadResult { registry, failures })
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

    /// `load_from_directory_with_failures` must
    /// distinguish parse failures (YAML did not deserialize) from
    /// validation failures (deserialized but missing required
    /// fields), so the bridge can route them to the right audit
    /// payload kind. The successful registry must still load,
    /// preserving the load-and-continue posture.
    #[test]
    fn load_with_failures_surfaces_parse_and_validation_failures() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::create_dir_all(dir.path().join("slides")).unwrap();

        // 1. A healthy template that should land in the registry.
        std::fs::write(
            dir.path().join("documents/prd.yaml"),
            r#"
id: prd-v1
name: PRD
type: document
description: Healthy
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        // 2. YAML that parses but fails validation (empty sections).
        std::fs::write(
            dir.path().join("documents/missing-sections.yaml"),
            r#"
id: missing-sections-v1
name: Missing
type: document
description: Missing sections
sections: []
export:
  - markdown
"#,
        )
        .unwrap();

        // 3. YAML that does not deserialize into `Template`
        //    (malformed top-level structure).
        std::fs::write(
            dir.path().join("slides/broken.yaml"),
            ": this is not a valid template document :\n",
        )
        .unwrap();

        let result = TemplateRegistry::load_from_directory_with_failures(dir.path()).unwrap();

        // The healthy template still loads.
        assert_eq!(result.registry.count(), 1, "healthy template should load");
        assert!(result.registry.get_by_id("prd-v1").is_some());

        // Both failure kinds are surfaced structurally.
        assert_eq!(
            result.failures.len(),
            2,
            "expected one parse + one validation failure"
        );

        let validation = result
            .failures
            .iter()
            .find(|f| f.kind == TemplateLoadFailureKind::Validation)
            .expect("validation failure should be present");
        assert!(
            validation
                .path
                .to_string_lossy()
                .ends_with("missing-sections.yaml"),
            "validation failure should reference missing-sections.yaml, got {}",
            validation.path.display()
        );
        assert!(
            !validation.error.is_empty(),
            "validation failure should carry a non-empty error message"
        );

        let parse = result
            .failures
            .iter()
            .find(|f| f.kind == TemplateLoadFailureKind::Parse)
            .expect("parse failure should be present");
        assert!(
            parse.path.to_string_lossy().ends_with("broken.yaml"),
            "parse failure should reference broken.yaml, got {}",
            parse.path.display()
        );
    }

    /// `TemplateLoadFailureKind::as_str` returns a stable, audit-
    /// payload-friendly string for each variant. Pin the contract so
    /// a refactor that renames the enum variants cannot silently
    /// change the audit-log grep surface.
    #[test]
    fn template_load_failure_kind_audit_strings() {
        assert_eq!(TemplateLoadFailureKind::Parse.as_str(), "parse");
        assert_eq!(TemplateLoadFailureKind::Validation.as_str(), "validation");
    }
}
