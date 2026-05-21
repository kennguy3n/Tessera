//! Integration test that verifies the bundled YAML templates under
//! `templates/documents/` all parse, validate, and have well-formed
//! sections + export formats. These fixtures live at the workspace
//! root; the test resolves them via `CARGO_MANIFEST_DIR` so it works
//! from `cargo test` in any working directory.

use std::path::PathBuf;
use tessera_templates::parser::parse_template_file;
use tessera_templates::validator::validate_template;

fn workspace_template(name: &str) -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir)
        .join("../..")
        .join("templates/documents")
        .join(name)
}

const PLAN_TEMPLATES: &[&str] = &[
    "meeting-agenda.yaml",
    "project-plan.yaml",
    "task-list.yaml",
    "launch-checklist.yaml",
    "meeting-notes.yaml",
    "brief.yaml",
];

const APPROVE_TEMPLATES: &[&str] = &[
    "purchase-approval.yaml",
    "budget-approval.yaml",
    "policy-exception.yaml",
    "vendor-review.yaml",
];

#[test]
fn plan_templates_parse_and_validate() {
    for name in PLAN_TEMPLATES {
        let path = workspace_template(name);
        let tmpl =
            parse_template_file(&path).unwrap_or_else(|e| panic!("Failed to parse {name}: {e}"));
        validate_template(&tmpl).unwrap_or_else(|e| panic!("Failed to validate {name}: {e}"));
        assert!(!tmpl.id.is_empty(), "{name} has empty id");
        assert!(!tmpl.name.is_empty(), "{name} has empty name");
        assert!(!tmpl.sections.is_empty(), "{name} has no sections");
        assert!(!tmpl.export.is_empty(), "{name} has no export formats");
        assert_eq!(
            tmpl.artifact_type,
            tessera_core::types::ArtifactType::Document,
            "{name} not a document template"
        );
    }
}

#[test]
fn approve_templates_parse_and_validate() {
    for name in APPROVE_TEMPLATES {
        let path = workspace_template(name);
        let tmpl =
            parse_template_file(&path).unwrap_or_else(|e| panic!("Failed to parse {name}: {e}"));
        validate_template(&tmpl).unwrap_or_else(|e| panic!("Failed to validate {name}: {e}"));
        // Approve workflows must surface either Risk Assessment or
        // an Approval Chain section so reviewers can see the decision
        // trail. We don't lock down the exact title, just require
        // *some* section that mentions risk or approval.
        let has_governance = tmpl.sections.iter().any(|s| {
            let t = s.title.to_lowercase();
            t.contains("risk") || t.contains("approval") || t.contains("approver")
        });
        assert!(
            has_governance,
            "{name} should include a risk or approval section"
        );
    }
}

#[test]
fn all_plan_and_approve_templates_have_unique_ids() {
    let mut ids = std::collections::HashSet::new();
    for name in PLAN_TEMPLATES.iter().chain(APPROVE_TEMPLATES) {
        let path = workspace_template(name);
        let tmpl =
            parse_template_file(&path).unwrap_or_else(|e| panic!("Failed to parse {name}: {e}"));
        assert!(
            ids.insert(tmpl.id.clone()),
            "Duplicate template id detected: {}",
            tmpl.id
        );
    }
}
