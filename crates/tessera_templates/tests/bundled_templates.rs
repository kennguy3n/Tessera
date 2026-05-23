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

/// The published `schemas/template.schema.json` is the contract that
/// external template authors validate against. The Rust deserializer
/// silently ignores unknown YAML fields, so a YAML that drifts away
/// from the schema (e.g. by adding a new visual-hint field like
/// `icon_suggestion` without declaring it in the schema, or using a
/// pre-canonical field like `heading:` instead of `title:`) would
/// still load at runtime but would reject template authors who run
/// the YAML through any JSON Schema validator. This test pins the
/// schema and the on-disk YAML files to the same vocabulary so they
/// can never drift apart.
///
/// History: this test was added in WS3 R11 after the legacy visual
/// templates (`templates/infographics/*.yaml`,
/// `templates/landing_pages/saas-product.yaml`) were migrated from
/// pre-canonical `heading:` schema to canonical `title:` schema in
/// R10. The migration kept the visual-hint fields (`layout`,
/// `default_icon_set`, `color_scheme`, `icon_suggestion`) on those
/// files, and at the time the schema still declared
/// `additionalProperties: false` without listing those fields — so
/// external schema validators would have rejected those YAMLs. R11
/// fixed the schema and this test now guards against the same drift
/// recurring.
#[test]
fn every_bundled_template_validates_against_json_schema() {
    let schema_path = workspace_templates_root()
        .parent()
        .expect("templates root has a parent")
        .join("schemas/template.schema.json");
    let schema_raw = std::fs::read_to_string(&schema_path).unwrap_or_else(|e| {
        panic!(
            "Failed to read JSON schema at {}: {e}",
            schema_path.display()
        )
    });
    let schema_json: serde_json::Value = serde_json::from_str(&schema_raw)
        .unwrap_or_else(|e| panic!("Schema at {} is not valid JSON: {e}", schema_path.display()));
    let compiled = jsonschema::JSONSchema::options()
        .with_draft(jsonschema::Draft::Draft7)
        .compile(&schema_json)
        .unwrap_or_else(|e| panic!("Failed to compile JSON schema: {e}"));

    let mut failures: Vec<String> = Vec::new();
    for path in discover_all_templates() {
        let display = display_path(&path);
        let raw = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("Failed to read {display}: {e}"));
        // YAML -> serde_json::Value so the validator can consume it.
        // `serde_yaml::from_str` to a generic value, then transcode.
        let yaml_value: serde_yaml::Value = serde_yaml::from_str(&raw)
            .unwrap_or_else(|e| panic!("YAML parse error in {display}: {e}"));
        let json_value: serde_json::Value = serde_json::to_value(&yaml_value)
            .unwrap_or_else(|e| panic!("YAML->JSON transcode error in {display}: {e}"));
        // Collect the per-instance error strings eagerly while the
        // `json_value` borrow is still live. The validator iterator
        // borrows `&json_value`, so it cannot escape this scope —
        // `let detail: Vec<String> = ...` materializes the messages
        // immediately and lets the borrow drop.
        let detail: Vec<String> = match compiled.validate(&json_value) {
            Ok(()) => continue,
            Err(errors) => errors
                .map(|e| format!("  - at `{}`: {e}", e.instance_path))
                .collect(),
        };
        failures.push(format!("{display}:\n{}", detail.join("\n")));
    }
    assert!(
        failures.is_empty(),
        "JSON schema validation failed for {} template(s):\n\n{}\n\n\
         Either (a) update the YAML to comply with the published schema, \
         or (b) declare the new field in schemas/template.schema.json and \
         update the Rust `Template` struct.",
        failures.len(),
        failures.join("\n\n")
    );
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
        let tmpl = parse_template_file(path).unwrap_or_else(|e| {
            panic!(
                "Failed to parse {} for id-uniqueness check: {e}",
                display_path(path)
            )
        });
        let id = tmpl.id.clone();
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

/// Canonical set of localized templates whose shape must mirror the
/// English source. This is the ten most-used templates listed in the
/// WS3 spec. Lifted to a module-level constant so the presence check,
/// section-count check, and export-format check all share one source
/// of truth — adding a new canonical template is a single-line edit
/// that all three parity tests pick up automatically.
const CANONICAL_LOCALIZED_TEMPLATES: &[(&str, &str)] = &[
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

/// Sanity-check that every supported non-English locale has the same
/// canonical set of localized templates so the renderer's locale
/// filter shows a consistent picker across languages. The canonical
/// set is the ten most-used templates listed in the WS3 spec.
#[test]
fn every_non_english_locale_ships_the_canonical_template_set() {
    let root = workspace_templates_root();
    let non_english: Vec<&&str> = SUPPORTED_LOCALES.iter().filter(|l| **l != "en").collect();
    for locale in &non_english {
        for (category, filename) in CANONICAL_LOCALIZED_TEMPLATES {
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

/// Localized variants must have the same section count as the English
/// source they translate. Drift surfaces as a downstream renderer that
/// produces structurally different artifacts per locale (e.g. a 6-section
/// agenda in Spanish vs. a 7-section agenda in English), which silently
/// breaks layouts that assume a fixed shape. The validator only checks
/// non-empty sections, so without this test a translator who merged two
/// sections into one (or dropped a section) would commit successfully.
///
/// We only enforce *count* parity, not section-by-section title parity:
/// it's legitimate (and sometimes necessary) for a translator to retitle
/// a section into idiomatic phrasing in the target language, but the
/// *structure* must remain identical.
#[test]
fn localized_variants_match_english_section_count() {
    let root = workspace_templates_root();
    let non_english: Vec<&&str> = SUPPORTED_LOCALES.iter().filter(|l| **l != "en").collect();
    for (category, filename) in CANONICAL_LOCALIZED_TEMPLATES {
        let english_path = root.join(category).join(filename);
        let english = parse_template_file(&english_path)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", display_path(&english_path)));
        let expected = english.section_count();
        for locale in &non_english {
            let path = root
                .join(category)
                .join("locales")
                .join(**locale)
                .join(filename);
            let translated = parse_template_file(&path)
                .unwrap_or_else(|e| panic!("failed to parse {}: {e}", display_path(&path)));
            let actual = translated.section_count();
            assert_eq!(
                actual,
                expected,
                "section-count drift in {}: locale `{}` has {} sections but English source `{}` has {}",
                display_path(&path),
                locale,
                actual,
                display_path(&english_path),
                expected,
            );
        }
    }
}

/// Localized variants must offer the same set of `export` formats as
/// their English source. The user-visible export picker in the renderer
/// is keyed off this list, so a French `meeting-agenda.fr.yaml` that
/// silently dropped `pdf` would surprise the user with a different menu
/// than the English variant. The validator does not enforce this (it
/// only checks individual format identifiers parse), so a translator
/// pruning the list — intentionally or accidentally — would commit
/// successfully.
///
/// We enforce *set* equality rather than order: the renderer dedupes
/// and re-sorts before display, so list ordering is cosmetic, but the
/// set of formats is contractually load-bearing.
#[test]
fn localized_variants_match_english_export_formats() {
    let root = workspace_templates_root();
    let non_english: Vec<&&str> = SUPPORTED_LOCALES.iter().filter(|l| **l != "en").collect();
    for (category, filename) in CANONICAL_LOCALIZED_TEMPLATES {
        let english_path = root.join(category).join(filename);
        let english = parse_template_file(&english_path)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", display_path(&english_path)));
        // `ExportFormat` does not derive `Hash`; compare via the canonical
        // `Display` string each variant emits (which is what the renderer
        // ultimately surfaces to the user anyway).
        let expected: HashSet<String> = english
            .export_formats()
            .iter()
            .map(std::string::ToString::to_string)
            .collect();
        for locale in &non_english {
            let path = root
                .join(category)
                .join("locales")
                .join(**locale)
                .join(filename);
            let translated = parse_template_file(&path)
                .unwrap_or_else(|e| panic!("failed to parse {}: {e}", display_path(&path)));
            let actual: HashSet<String> = translated
                .export_formats()
                .iter()
                .map(std::string::ToString::to_string)
                .collect();
            let mut actual_sorted: Vec<&String> = actual.iter().collect();
            actual_sorted.sort();
            let mut expected_sorted: Vec<&String> = expected.iter().collect();
            expected_sorted.sort();
            assert_eq!(
                actual,
                expected,
                "export-format drift in {}: locale `{}` exports {:?} but English source `{}` exports {:?}",
                display_path(&path),
                locale,
                actual_sorted,
                display_path(&english_path),
                expected_sorted,
            );
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
