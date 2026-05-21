//! Integration tests for the Phase 9 templates: Form (Document),
//! Asset Inventory (Base), Tracker (Sheet), Inventory (Sheet), and
//! Roadmap (Base). These fixtures live at the workspace root and are
//! resolved via `CARGO_MANIFEST_DIR` so the test works from any
//! `cargo test` working directory.

use std::path::PathBuf;
use tessera_core::types::ArtifactType;
use tessera_templates::parser::parse_template_file;
use tessera_templates::registry::TemplateRegistry;
use tessera_templates::validator::validate_template;

fn workspace_templates_root() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("templates")
}

fn template_at(category: &str, name: &str) -> PathBuf {
    workspace_templates_root().join(category).join(name)
}

fn parse_and_validate(category: &str, file: &str) -> tessera_templates::template::Template {
    let path = template_at(category, file);
    let tmpl = parse_template_file(&path)
        .unwrap_or_else(|e| panic!("Failed to parse {category}/{file}: {e}"));
    validate_template(&tmpl)
        .unwrap_or_else(|e| panic!("Failed to validate {category}/{file}: {e}"));
    tmpl
}

#[test]
fn form_template_is_a_document() {
    let tmpl = parse_and_validate("documents", "form.yaml");
    assert_eq!(tmpl.id, "form-v1");
    assert_eq!(tmpl.name, "Form");
    assert_eq!(tmpl.artifact_type, ArtifactType::Document);
    assert!(tmpl.sections.len() >= 4);

    let titles: Vec<String> = tmpl.sections.iter().map(|s| s.title.clone()).collect();
    let has_field_section = titles
        .iter()
        .any(|t| t.to_lowercase().contains("field") || t.to_lowercase().contains("respondent"));
    assert!(
        has_field_section,
        "Form template should describe its form fields. titles: {titles:?}"
    );
    let has_submission_section = titles
        .iter()
        .any(|t| t.to_lowercase().contains("submission"));
    assert!(
        has_submission_section,
        "Form template should include submission instructions. titles: {titles:?}"
    );
}

#[test]
fn asset_inventory_template_is_a_base() {
    let tmpl = parse_and_validate("bases", "asset-inventory.yaml");
    assert_eq!(tmpl.id, "asset-inventory-v1");
    assert_eq!(tmpl.name, "Asset Inventory");
    assert_eq!(tmpl.artifact_type, ArtifactType::Base);
    assert!(tmpl.sections.len() >= 4);

    let titles: Vec<String> = tmpl.sections.iter().map(|s| s.title.clone()).collect();
    assert!(
        titles
            .iter()
            .any(|t| t.to_lowercase().contains("status") || t.to_lowercase().contains("lifecycle")),
        "Asset Inventory should include a status/lifecycle section. titles: {titles:?}"
    );
    let prompts_joined: String = tmpl.sections.iter().map(|s| s.prompt.clone()).collect();
    let prompts_l = prompts_joined.to_lowercase();
    for required in ["serial", "location", "value"] {
        assert!(
            prompts_l.contains(required),
            "Asset Inventory should mention {required} in its prompts"
        );
    }
}

#[test]
fn tracker_template_is_a_sheet() {
    let tmpl = parse_and_validate("sheets", "tracker.yaml");
    assert_eq!(tmpl.id, "tracker-v1");
    assert_eq!(tmpl.name, "Tracker");
    assert_eq!(tmpl.artifact_type, ArtifactType::Sheet);
    assert!(tmpl.sections.len() >= 3);

    let prompts: String = tmpl
        .sections
        .iter()
        .map(|s| s.prompt.clone())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    for required in ["status", "owner", "due date", "priority"] {
        assert!(
            prompts.contains(required),
            "Tracker template should mention {required}; got: {prompts}"
        );
    }
}

#[test]
fn inventory_template_is_a_sheet() {
    let tmpl = parse_and_validate("sheets", "inventory.yaml");
    assert_eq!(tmpl.id, "inventory-v1");
    assert_eq!(tmpl.name, "Inventory");
    assert_eq!(tmpl.artifact_type, ArtifactType::Sheet);
    assert!(tmpl.sections.len() >= 3);

    let prompts: String = tmpl
        .sections
        .iter()
        .map(|s| s.prompt.clone())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    for required in ["sku", "quantity", "reorder", "supplier", "location"] {
        assert!(
            prompts.contains(required),
            "Inventory template should mention {required}; got: {prompts}"
        );
    }
}

#[test]
fn roadmap_base_template_is_a_base() {
    let tmpl = parse_and_validate("bases", "roadmap.yaml");
    assert_eq!(tmpl.id, "roadmap-base-v1");
    assert_eq!(tmpl.name, "Roadmap (Base)");
    assert_eq!(tmpl.artifact_type, ArtifactType::Base);
    assert!(tmpl.sections.len() >= 4);

    let prompts: String = tmpl
        .sections
        .iter()
        .map(|s| s.prompt.clone())
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase();
    for required in ["theme", "quarter", "status", "owner", "dependencies"] {
        assert!(
            prompts.contains(required),
            "Roadmap Base should mention {required}; got: {prompts}"
        );
    }
}

#[test]
fn phase_9_templates_have_unique_ids() {
    let mut ids = std::collections::HashSet::new();
    for (category, name) in [
        ("documents", "form.yaml"),
        ("bases", "asset-inventory.yaml"),
        ("sheets", "tracker.yaml"),
        ("sheets", "inventory.yaml"),
        ("bases", "roadmap.yaml"),
    ] {
        let tmpl = parse_template_file(&template_at(category, name)).unwrap();
        assert!(
            ids.insert(tmpl.id.clone()),
            "Duplicate id in Phase 9 templates: {}",
            tmpl.id
        );
    }
}

#[test]
fn full_template_registry_finds_phase_9_templates() {
    let root = workspace_templates_root();
    let registry = TemplateRegistry::load_from_directory(&root).expect("load");

    for expected_id in [
        "form-v1",
        "asset-inventory-v1",
        "tracker-v1",
        "inventory-v1",
        "roadmap-base-v1",
    ] {
        let tmpl = registry
            .get_by_id(expected_id)
            .unwrap_or_else(|| panic!("Registry missing {expected_id}"));
        assert!(!tmpl.sections.is_empty());
        assert!(!tmpl.export.is_empty());
    }
}
