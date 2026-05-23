//! Integration test that verifies every bundled YAML template under
//! `templates/` parses, validates, and has well-formed sections + export
//! formats. The fixtures live at the workspace root; the test resolves
//! them via `CARGO_MANIFEST_DIR` so it works from `cargo test` in any
//! working directory.
//!
//! WS3 (template / artifact expansion) grew the registry from ~36
//! English-only corporate-tech templates to >170 templates across
//! ten industries and ten locales (English plus nine localized
//! variants). Hand-listing every file would be fragile: the registry
//! would drift on every new YAML the moment a contributor forgot to
//! append to a constant. Instead, this test discovers templates by
//! walking the filesystem under the same category set the runtime
//! parser walks (`TEMPLATE_CATEGORIES` mirrors `load_template_by_id`
//! in `src/parser.rs`). Every YAML file the parser would load at
//! runtime is therefore covered automatically — adding a new template
//! to the registry is just creating the YAML; this test will pick it
//! up on the next `cargo test` run.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tessera_core::types::ArtifactType;
use tessera_templates::parser::parse_template_file;
use tessera_templates::template::Template;
use tessera_templates::validator::validate_template;
// `TEMPLATE_CATEGORIES` is the canonical list of `templates/<category>/`
// roots — see `crates/tessera_templates/src/lib.rs`. The runtime parser
// and this test both consume it so there is exactly one list to update
// when adding a new category.
use tessera_templates::TEMPLATE_CATEGORIES;

/// Some legacy visual templates (infographics + the SaaS landing page)
/// ship with a richer, type-specific schema that uses `heading:` instead
/// of `title:` for sections and adds top-level fields like `layout`,
/// `default_icon_set`, `color_scheme`, `hero`, `features`. The runtime
/// `TemplateRegistry::load_from_directory` silently skips these files
/// (see `crates/tessera_templates/src/registry.rs:46`) because the
/// canonical `Template` deserialiser is strict. Until the visual
/// schema is reconciled with the canonical one, this test deliberately
/// mirrors that runtime behaviour: it tolerates a parse failure on the
/// listed files while still asserting that *every other* template
/// parses cleanly. Adding a new file here without first reconciling
/// the schemas would mask a real regression.
const LEGACY_VISUAL_SCHEMA_TEMPLATES: &[&str] = &[
    "infographics/comparison.yaml",
    "infographics/process-flow.yaml",
    "infographics/stats-overview.yaml",
    "landing_pages/saas-product.yaml",
];

/// Returns `true` if `path` matches one of the legacy visual-schema
/// templates listed above. Comparison is done against the workspace-
/// relative path so it works regardless of where the test is run from.
fn is_legacy_visual_template(path: &Path) -> bool {
    let root = workspace_templates_root();
    let Ok(relative) = path.strip_prefix(&root) else {
        return false;
    };
    let relative_str = relative.to_string_lossy().replace('\\', "/");
    LEGACY_VISUAL_SCHEMA_TEMPLATES
        .iter()
        .any(|s| relative_str == *s)
}

/// BCP-47 locales the WS3 expansion ships localized variants in.
/// `en` is the implicit default for every English-source template;
/// every other locale corresponds to a `locales/<code>/` subdirectory
/// under one or more category roots. Keep this in sync with the
/// `locale` enum in `schemas/template.schema.json`.
const SUPPORTED_LOCALES: &[&str] = &["en", "es", "fr", "de", "ja", "zh", "pt", "ko", "ar", "hi"];

fn workspace_templates_root() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("templates")
}

/// Walk every category root recursively (so `locales/<code>/...` files
/// are included) and return the absolute path of every `*.yaml` /
/// `*.yml` template file. Order is deterministic so test failures point
/// at the same offending file across runs.
fn discover_all_templates() -> Vec<PathBuf> {
    let root = workspace_templates_root();
    let mut paths = Vec::new();
    for category in TEMPLATE_CATEGORIES {
        let category_root = root.join(category);
        if !category_root.is_dir() {
            // Some categories may not exist yet (e.g. before the first
            // template in that category is committed). Skip silently —
            // a missing category is not a bug.
            continue;
        }
        for entry in walkdir::WalkDir::new(&category_root)
            .follow_links(false)
            .into_iter()
            .filter_map(std::result::Result::ok)
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if matches!(
                path.extension().and_then(|e| e.to_str()),
                Some("yaml" | "yml")
            ) {
                paths.push(path.to_path_buf());
            }
        }
    }
    paths.sort();
    paths
}

/// Parse + validate every template. The test fails fast on the first
/// broken template and includes the file path in the panic message so
/// the contributor can fix it without grepping the workspace.
#[test]
fn every_bundled_template_parses_and_validates() {
    let paths = discover_all_templates();
    assert!(
        !paths.is_empty(),
        "no templates discovered under {}",
        workspace_templates_root().display()
    );

    for path in &paths {
        let display = display_path(path);
        if is_legacy_visual_template(path) {
            // Verify the file is still well-formed YAML so a typo or
            // accidental deletion is still caught — but accept that
            // it does not deserialize into `Template` until the
            // visual schema is reconciled.
            let raw = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("Failed to read {display}: {e}"));
            let _value: serde_yaml::Value = serde_yaml::from_str(&raw).unwrap_or_else(|e| {
                panic!("Legacy visual template {display} is not valid YAML: {e}")
            });
            continue;
        }
        let tmpl =
            parse_template_file(path).unwrap_or_else(|e| panic!("Failed to parse {display}: {e}"));
        validate_template(&tmpl).unwrap_or_else(|e| panic!("Failed to validate {display}: {e}"));

        assert!(!tmpl.id.is_empty(), "{display} has empty id");
        assert!(!tmpl.name.is_empty(), "{display} has empty name");
        assert!(
            !tmpl.description.is_empty(),
            "{display} has empty description"
        );
        assert!(!tmpl.sections.is_empty(), "{display} has no sections");
        assert!(!tmpl.export.is_empty(), "{display} has no export formats");
        for (i, section) in tmpl.sections.iter().enumerate() {
            assert!(
                !section.title.is_empty(),
                "{display} section {i} has empty title"
            );
            assert!(
                !section.prompt.is_empty(),
                "{display} section {i} has empty prompt"
            );
        }
    }
}

/// Every template id MUST be globally unique across the whole registry.
/// Localized variants follow the convention `<base-id>-<locale>` (e.g.
/// `prd-v1-es`) so they get distinct ids automatically. A collision
/// here indicates either a copy-paste error or a missing locale suffix.
#[test]
fn all_bundled_template_ids_are_unique() {
    let paths = discover_all_templates();
    let mut seen: HashMap<String, PathBuf> = HashMap::new();
    for path in &paths {
        // Extract the id from raw YAML so legacy visual templates
        // (which cannot deserialize into `Template`) are still
        // included in the uniqueness check — duplicate ids across
        // schemas would still confuse `load_template_by_id`.
        let id = template_id_from_yaml(path);
        if let Some(prev) = seen.insert(id.clone(), path.clone()) {
            panic!(
                "Duplicate template id `{}` found in both {} and {}",
                id,
                display_path(&prev),
                display_path(path)
            );
        }
    }
}

/// Pull the top-level `id:` value from a template YAML file without
/// going through the strict `Template` deserialiser. Used so the
/// id-uniqueness check still covers legacy visual templates.
fn template_id_from_yaml(path: &Path) -> String {
    let display = display_path(path);
    let raw =
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("Failed to read {display}: {e}"));
    let value: serde_yaml::Value = serde_yaml::from_str(&raw)
        .unwrap_or_else(|e| panic!("Failed to parse YAML for {display}: {e}"));
    match value.get("id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => panic!("{display} has no top-level `id` field"),
    }
}

/// Every template's `locale` field must be a member of `SUPPORTED_LOCALES`.
/// Catches typos (`"jp"` instead of `"ja"`) and unbounded locale growth.
/// Localized files MUST also live under `locales/<locale>/` matching the
/// `locale` value in the YAML — otherwise the renderer's CreatePage
/// filter will never surface them at runtime.
#[test]
fn locale_field_matches_directory_layout() {
    let root = workspace_templates_root();
    let supported: HashSet<&str> = SUPPORTED_LOCALES.iter().copied().collect();

    for path in discover_all_templates() {
        let display = display_path(&path);
        if is_legacy_visual_template(&path) {
            // Legacy visual templates ship only in English today and
            // don't carry a `locale` field — they live directly under
            // their category root and the runtime treats them as `en`.
            continue;
        }
        let tmpl =
            parse_template_file(&path).unwrap_or_else(|e| panic!("Failed to parse {display}: {e}"));

        assert!(
            supported.contains(tmpl.locale.as_str()),
            "{display} declares locale `{}` which is not in SUPPORTED_LOCALES",
            tmpl.locale
        );

        // Derive the locale implied by directory layout. Files under
        // `templates/<category>/locales/<code>/...` MUST set
        // `locale: <code>` in the YAML; files directly under
        // `templates/<category>/` MUST set `locale: en` (or omit the
        // field, which defaults to `en`).
        let relative = path
            .strip_prefix(&root)
            .expect("discovered path lives under templates root");
        let dir_locale = locale_from_relative_path(relative);
        assert_eq!(
            tmpl.locale, dir_locale,
            "{display} sits in a `{}`-locale directory but declares `locale: {}`",
            dir_locale, tmpl.locale
        );

        // Localized variants must use the `<base>-<locale>` id suffix
        // so they don't collide with the English source template.
        if tmpl.locale != "en" {
            let suffix = format!("-{}", tmpl.locale);
            assert!(
                tmpl.id.ends_with(&suffix),
                "{display} is a `{}` locale variant but its id `{}` does not end with `{}`",
                tmpl.locale,
                tmpl.id,
                suffix
            );
        }
    }
}

/// Slide / sheet / base / infographic / landing-page templates have
/// category-specific minimum requirements. Asserting these on every
/// new template catches "I copied a document YAML into the wrong
/// directory" mistakes that would otherwise surface only at runtime
/// when the renderer tried to load them.
#[test]
fn category_specific_artifact_types_match_directory() {
    for path in discover_all_templates() {
        let display = display_path(&path);
        if is_legacy_visual_template(&path) {
            // Skip: legacy visual templates do declare a `type:` field
            // but cannot be deserialized into the canonical `Template`
            // struct (different section schema). Their `type:` is
            // verified by raw YAML inspection in the
            // legacy_visual_templates_declare_expected_type test.
            continue;
        }
        let tmpl =
            parse_template_file(&path).unwrap_or_else(|e| panic!("Failed to parse {display}: {e}"));

        let category = category_for(&path);
        let expected = expected_artifact_type(category);
        assert_eq!(
            tmpl.artifact_type, expected,
            "{display} sits under `{}` but declares `type: {:?}`",
            category, tmpl.artifact_type
        );
    }
}

/// Approval workflows (purchase-approval, budget-approval,
/// policy-exception, vendor-review, plus the WS3 additions:
/// audit-findings, compliance-audit, hipaa-incident-report,
/// safety-incident-report) must surface either a risk or an approval
/// section so reviewers can see the decision trail. We don't lock
/// down the exact title — we just require *some* section that
/// mentions risk or approval.
#[test]
fn approval_documents_expose_governance_section() {
    let approval_docs = [
        "purchase-approval.yaml",
        "budget-approval.yaml",
        "policy-exception.yaml",
        "vendor-review.yaml",
        "audit-findings.yaml",
        "compliance-audit.yaml",
        "hipaa-incident-report.yaml",
        "safety-incident-report.yaml",
    ];
    let docs_root = workspace_templates_root().join("documents");
    for name in approval_docs {
        let path = docs_root.join(name);
        if !path.exists() {
            // Some governance templates only exist in WS3 — if the
            // file isn't present yet (e.g. on a branch predating WS3)
            // we skip it rather than fail the whole suite.
            continue;
        }
        let tmpl =
            parse_template_file(&path).unwrap_or_else(|e| panic!("Failed to parse {name}: {e}"));
        let has_governance = tmpl.sections.iter().any(|s| {
            let t = s.title.to_lowercase();
            t.contains("risk")
                || t.contains("approval")
                || t.contains("approver")
                || t.contains("remediation")
                || t.contains("finding")
        });
        assert!(
            has_governance,
            "{name} should expose a risk / approval / finding / remediation section"
        );
    }
}

/// Sanity-check that every supported non-English locale has the same
/// canonical set of localized templates so the renderer's locale
/// filter shows a consistent picker across languages. The canonical
/// set is the ten most-used templates listed in the WS3 spec.
#[test]
fn every_non_english_locale_ships_the_canonical_template_set() {
    let canonical = [
        ("documents", "prd.yaml"),
        ("documents", "proposal.yaml"),
        ("documents", "sop.yaml"),
        ("documents", "report.yaml"),
        ("documents", "meeting-agenda.yaml"),
        ("documents", "meeting-notes.yaml"),
        ("documents", "task-list.yaml"),
        ("documents", "form.yaml"),
        ("sheets", "budget.yaml"),
        ("slides", "pitch.yaml"),
    ];
    let root = workspace_templates_root();
    let non_english: Vec<&&str> = SUPPORTED_LOCALES.iter().filter(|l| **l != "en").collect();
    for locale in &non_english {
        for (category, filename) in &canonical {
            let path = root
                .join(category)
                .join("locales")
                .join(**locale)
                .join(filename);
            assert!(
                path.is_file(),
                "missing `{}` translation: expected {}",
                locale,
                display_path(&path)
            );
            let tmpl = parse_template_file(&path)
                .unwrap_or_else(|e| panic!("failed to parse {}: {e}", display_path(&path)));
            validate_template(&tmpl)
                .unwrap_or_else(|e| panic!("failed to validate {}: {e}", display_path(&path)));
        }
    }
}

/// Derive `<category>/<locale>/<basename>` style display path so
/// failure messages don't leak absolute paths from the build agent.
fn display_path(path: &Path) -> String {
    let root = workspace_templates_root();
    path.strip_prefix(&root)
        .map_or_else(|_| path.display().to_string(), |p| p.display().to_string())
}

/// Map a path relative to `templates/` to the locale it implies.
/// Path shape is one of:
///   - `<category>/<file>.yaml`                       → "en"
///   - `<category>/locales/<locale>/<file>.yaml`      → "<locale>"
fn locale_from_relative_path(relative: &Path) -> String {
    let components: Vec<_> = relative
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .collect();
    // ["documents", "locales", "es", "prd.yaml"] → "es"
    // ["documents", "prd.yaml"] → "en"
    if components.len() >= 4 && components[1] == "locales" {
        return components[2].to_string();
    }
    "en".to_string()
}

/// Map a discovered path back to the first directory component under
/// `templates/`. Used to derive the expected `ArtifactType`.
fn category_for(path: &Path) -> &'static str {
    let root = workspace_templates_root();
    let relative = path
        .strip_prefix(&root)
        .expect("discovered path lives under templates root");
    let first = relative
        .components()
        .find_map(|c| match c {
            std::path::Component::Normal(s) => s.to_str(),
            _ => None,
        })
        .expect("template path has at least one component");
    // Borrow check: we want a `&'static str` so the panic messages
    // can interpolate without a lifetime parameter. Match against the
    // known categories.
    match first {
        "documents" => "documents",
        "slides" => "slides",
        "sheets" => "sheets",
        "bases" => "bases",
        "infographics" => "infographics",
        "landing_pages" => "landing_pages",
        other => panic!("unrecognized template category `{}`", other),
    }
}

fn expected_artifact_type(category: &str) -> ArtifactType {
    match category {
        "documents" => ArtifactType::Document,
        "slides" => ArtifactType::Slides,
        "sheets" => ArtifactType::Sheet,
        "bases" => ArtifactType::Base,
        "infographics" => ArtifactType::Infographic,
        "landing_pages" => ArtifactType::LandingPage,
        other => panic!("unrecognized template category `{}`", other),
    }
}

/// Smoke check: the parser correctly threads optional metadata
/// (locale / industry / profile) through the round-trip, with the
/// `default_locale` fallback firing for any baseline English template
/// that omits the field.
#[test]
fn locale_industry_profile_round_trip_through_parser() {
    let docs_root = workspace_templates_root().join("documents");
    // English source PRD omits `locale:` → parser should default to "en".
    let prd = parse_template_file(&docs_root.join("prd.yaml")).expect("baseline prd.yaml parses");
    assert_eq!(prd.locale, "en", "English source must default to en");

    // Explicit German variant should round-trip the literal value.
    let prd_de = parse_template_file(&docs_root.join("locales/de/prd.yaml"))
        .expect("locales/de/prd.yaml parses");
    assert_eq!(prd_de.locale, "de");

    // Industry/profile fields default to empty vectors when omitted
    // (every baseline template) and round-trip non-empty vectors on
    // the WS3 industry-specific templates.
    assert!(
        prd.industry.is_empty(),
        "baseline prd should not declare an industry"
    );
    let clinical = docs_root.join("clinical-protocol.yaml");
    if clinical.exists() {
        let tmpl = parse_template_file(&clinical).expect("clinical-protocol parses");
        // The WS3 clinical-protocol template MUST tag itself as
        // healthcare so the CreatePage industry filter can surface it.
        assert!(
            tmpl.industry.iter().any(|i| i == "healthcare"),
            "clinical-protocol should declare `healthcare` industry, got {:?}",
            tmpl.industry
        );
    }

    // Sanity-check that the `Template` struct's debug repr is stable
    // enough to use in error messages: not strictly necessary, but
    // prevents regressions if someone accidentally drops the derive.
    let _ = format!("{:?}", Template { ..prd });
}

/// Legacy visual templates declare their artifact type in the YAML
/// even though the canonical parser cannot deserialize them. We still
/// want to catch the "I copied this file into the wrong directory"
/// mistake — so we verify the raw YAML's `type:` field matches the
/// expected `ArtifactType` for the directory the file sits in.
#[test]
fn legacy_visual_templates_declare_expected_type() {
    let root = workspace_templates_root();
    for relative in LEGACY_VISUAL_SCHEMA_TEMPLATES {
        let path = root.join(relative);
        if !path.is_file() {
            // Legacy file could be removed in a future cleanup — that's
            // fine, just don't fail the test.
            continue;
        }
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Failed to read {relative}: {e}"));
        let value: serde_yaml::Value = serde_yaml::from_str(&raw)
            .unwrap_or_else(|e| panic!("Failed to parse YAML for {relative}: {e}"));
        let declared = value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_else(|| panic!("{relative} missing `type:` field"));

        let category = category_for(&path);
        // ArtifactType uses snake_case serde rename, so the YAML
        // string is the snake_case variant: `infographic`,
        // `landing_page`, etc.
        let expected_str = match expected_artifact_type(category) {
            ArtifactType::Document => "document",
            ArtifactType::Slides => "slides",
            ArtifactType::Sheet => "sheet",
            ArtifactType::Base => "base",
            ArtifactType::Infographic => "infographic",
            ArtifactType::LandingPage => "landing_page",
        };
        assert_eq!(
            declared, expected_str,
            "legacy visual template {relative} sits under `{category}/` but declares `type: {declared}`"
        );
    }
}
