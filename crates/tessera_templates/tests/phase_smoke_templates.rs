//! Cross-tree smoke test for the bundled template registry.
//!
//! Tracking-integrity guarantee: every bundled YAML template under
//! `templates/` must (a) parse, (b) validate, and (c) appear in the
//! registry that the renderer-side `CreatePage.tsx` sources its
//! picker from.
//!
//! This test is intentionally broader than `bundled_templates.rs` (the
//! pre-existing per-category test). It walks the entire `templates/`
//! tree from disk and applies the parse + validate + invariants check
//! to every `.yaml`/`.yml` file it finds — so future templates added
//! without being mentioned in the per-category enumerations still get
//! verified, and a malformed template can't sneak into a release.
//!
//! Companion suites:
//!   * Renderer side — `apps/desktop/renderer/src/__tests__/smoke/
//!     phaseVerification.test.ts` (cross-checks template ids against
//!     CreatePage.tsx CATEGORIES).
//!   * Connectors — `crates/tessera_connectors/tests/
//!     phase_smoke_connectors.rs`
//!   * Export — `crates/tessera_export/tests/phase_smoke_export.rs`

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tessera_templates::parser::parse_template_file;
use tessera_templates::registry::TemplateRegistry;
use tessera_templates::validator::validate_template;

/// Resolve the workspace-root `templates/` directory from the
/// crate manifest dir. Works no matter what working dir cargo is
/// invoked from.
fn templates_root() -> PathBuf {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    PathBuf::from(manifest_dir).join("../..").join("templates")
}

/// Subdirectories under `templates/` whose YAML files are
/// `tessera_templates::Template`-compatible. The infographic and
/// landing-page templates intentionally use a richer renderer-side
/// schema (with `hero:`, `features:`, `stats:`, `layout:`, ...) that
/// the Rust struct does not model — those are still parsed for
/// well-formedness by `every_renderer_only_template_is_well_formed_yaml`
/// below, just not subjected to the full `validate_template` pass.
const RUST_TEMPLATE_DIRS: &[&str] = &["documents", "slides", "sheets", "bases"];

/// Subdirectories under `templates/` whose YAML files use the
/// renderer-side schema. These don't deserialize into the Rust
/// `Template` struct, but they still need to be syntactically valid
/// YAML — a malformed `hero:` block in an infographic or landing-page
/// template would crash the renderer at runtime. We use a minimal
/// `serde_yaml::Value` parse below so this Rust test still gates
/// malformed YAML before it can land on `main`.
const RENDERER_ONLY_TEMPLATE_DIRS: &[&str] = &["infographics", "landing_pages"];

/// Subdirectories under `templates/` that are NOT template categories
/// at all and must be excluded from the dynamic-discovery test below.
/// Currently just `grammars/` (GBNF files for LLM output constraint).
/// If a future addition lands (e.g. `templates/shared/` for reusable
/// fragments), the maintainer must explicitly classify it here so a
/// new template category cannot quietly bypass the smoke suite.
const NON_TEMPLATE_DIRS: &[&str] = &["grammars"];

/// Recursively collect every `.yaml`/`.yml` file under the supplied
/// templates root that belongs to a Rust-side template category
/// (`documents/`, `slides/`, `sheets/`, `bases/`).
///
/// Returns paths in deterministic sort order so test failures point
/// at the same file across runs.
fn collect_template_files(root: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for sub in RUST_TEMPLATE_DIRS {
        let dir = root.join(sub);
        if !dir.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir)
            .follow_links(false)
            .into_iter()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.into_path();
            if matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("yaml" | "yml")
            ) {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

/// Every bundled YAML template must parse, validate, and meet the
/// repository-wide invariants (non-empty id, non-empty name, at least
/// one section, at least one export format).
///
/// The smoke suite calls for a smoke test that catches templates
/// claimed in docs but not wired into the registry. This is exactly
/// that test: it walks the on-disk fixtures so any new YAML file is
/// automatically covered without an edit here.
#[test]
fn every_bundled_template_parses_validates_and_has_required_fields() {
    let root = templates_root();
    let files = collect_template_files(&root);
    assert!(
        !files.is_empty(),
        "expected at least one bundled template under {}",
        root.display()
    );

    for path in &files {
        let rel = path.strip_prefix(&root).unwrap_or(path);
        let display = rel.display();

        let tmpl =
            parse_template_file(path).unwrap_or_else(|e| panic!("failed to parse {display}: {e}"));
        validate_template(&tmpl).unwrap_or_else(|e| panic!("failed to validate {display}: {e}"));

        assert!(!tmpl.id.is_empty(), "{display} has empty id");
        assert!(!tmpl.name.is_empty(), "{display} has empty name");
        assert!(
            !tmpl.description.is_empty(),
            "{display} has empty description"
        );
        assert!(!tmpl.sections.is_empty(), "{display} has zero sections");
        assert!(
            !tmpl.export.is_empty(),
            "{display} has no export formats configured"
        );

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

/// Template ids are the registry key the renderer uses to look up
/// templates by name. Duplicates would shadow each other silently in
/// the picker, so the smoke suite makes uniqueness an explicit
/// guarantee rather than relying on convention.
#[test]
fn every_bundled_template_has_a_unique_id() {
    let root = templates_root();
    let files = collect_template_files(&root);

    let mut seen: HashSet<String> = HashSet::new();
    let mut duplicates: Vec<(String, PathBuf)> = Vec::new();

    for path in &files {
        let tmpl = parse_template_file(path)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()));
        if !seen.insert(tmpl.id.clone()) {
            duplicates.push((tmpl.id, path.clone()));
        }
    }

    assert!(
        duplicates.is_empty(),
        "found duplicate template ids — these would shadow each other in the picker: {duplicates:?}"
    );
}

/// Templates of each Rust-modelled artifact type must appear in the
/// on-disk fixtures. This is the structural floor implied by the
/// README: at least one template per artifact category.
///
/// Only the four categories that `tessera_templates::Template` can
/// represent (Document, Slides, Sheet, Base) are covered here.
/// Infographic and LandingPage templates use a richer renderer-side
/// schema (with `hero:`, `features:`, `stats:`, `layout:`, etc.)
/// that the Rust struct does not model — the renderer's
/// `phaseVerification.test.ts` smoke suite enforces the floor for
/// those two categories instead.
#[test]
fn every_rust_modelled_category_has_at_least_one_template() {
    use tessera_core::ArtifactType;

    let root = templates_root();
    let files = collect_template_files(&root);

    // `ArtifactType` doesn't derive `Hash`, so we accumulate a `Vec`
    // and use linear `.contains()` checks. The set is at most 4 wide.
    let mut seen: Vec<ArtifactType> = Vec::new();
    for path in &files {
        if let Ok(tmpl) = parse_template_file(path) {
            if !seen.contains(&tmpl.artifact_type) {
                seen.push(tmpl.artifact_type);
            }
        }
    }

    let expected = [
        ArtifactType::Document,
        ArtifactType::Slides,
        ArtifactType::Sheet,
        ArtifactType::Base,
    ];

    for ty in expected {
        assert!(
            seen.contains(&ty),
            "no bundled template found with artifact_type = {ty:?} — phase 5/6 floor regressed; seen types: {seen:?}"
        );
    }
}

/// The `TemplateRegistry::load_from_directory` API is what the desktop
/// app uses at startup. This test enforces two distinct properties:
///
/// 1. Every Rust-modelled on-disk template (documents/, slides/,
///    sheets/, bases/) must appear in the registry. A regression in
///    `WalkDir` filtering or in `parse_template_file` that silently
///    skips a fixture would fail this check — which is the core
///    tracking-integrity guarantee.
///
/// 2. Every registry entry must correspond to a real .yaml/.yml file
///    on disk somewhere under templates/. A phantom template (e.g.
///    one duplicated by a future caching layer) would fail this
///    check.
///
/// We deliberately do NOT compare the registry's full id set against
/// our Rust-modelled-only collector (`collect_template_files`). The
/// registry walks the entire `templates/` tree, including the
/// `infographics/` and `landing_pages/` subdirectories. Templates
/// under those two categories use a richer renderer-side schema that
/// `tessera_templates::Template` does not model, so today the
/// registry skips them — but a future infographic/landing-page YAML
/// happening to use only Rust-modelled fields (e.g. a stripped-down
/// `infographics/onboarding-summary.yaml` with a normal `sections:`
/// block) would be silently picked up by the registry, land in
/// `loaded_ids`, and a naïve symmetric-difference assertion would
/// false-positive. Property (2) above is enforced against a separate
/// full-tree id set instead, so the bidirectional check remains
/// strict while staying robust to additions in the
/// renderer-only directories.
#[test]
fn registry_loads_every_bundled_template() {
    let root = templates_root();
    let rust_modelled_on_disk = collect_template_files(&root);
    let registry = TemplateRegistry::load_from_directory(&root)
        .expect("TemplateRegistry::load_from_directory must succeed for bundled templates");

    // Property (1): every Rust-modelled on-disk template must be in
    // the registry.
    let mut rust_modelled_ids: HashSet<String> = HashSet::new();
    for path in &rust_modelled_on_disk {
        let tmpl = parse_template_file(path)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()));
        rust_modelled_ids.insert(tmpl.id);
    }
    let loaded_ids: HashSet<String> = registry.list().iter().map(|t| t.id.clone()).collect();

    let missing: Vec<&String> = rust_modelled_ids.difference(&loaded_ids).collect();
    assert!(
        missing.is_empty(),
        "TemplateRegistry::load_from_directory skipped these on-disk Rust-modelled templates: {missing:?}"
    );

    // Property (2): every registry id corresponds to a real .yaml/.yml
    // file somewhere on disk. We rebuild ground truth by walking the
    // whole tree (not just RUST_TEMPLATE_DIRS) and parsing every file
    // the registry's WalkDir would visit, so a renderer-only template
    // that happens to be Rust-parseable counts as legitimate ground
    // truth rather than a phantom.
    let mut all_on_disk_ids: HashSet<String> = HashSet::new();
    for entry in walkdir::WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.into_path();
        if !matches!(
            path.extension().and_then(|s| s.to_str()),
            Some("yaml" | "yml")
        ) {
            continue;
        }
        // Mirror the registry's silent-skip behaviour on parse/validate
        // failures: a YAML that doesn't fit `Template` is not a phantom,
        // it's just out-of-scope for the registry (and out-of-scope here
        // too).
        if let Ok(tmpl) = parse_template_file(&path) {
            if validate_template(&tmpl).is_ok() {
                all_on_disk_ids.insert(tmpl.id);
            }
        }
    }

    let phantoms: Vec<&String> = loaded_ids.difference(&all_on_disk_ids).collect();
    assert!(
        phantoms.is_empty(),
        "TemplateRegistry reported templates not present on disk anywhere under templates/: {phantoms:?}"
    );
}

/// Renderer-only template categories (`infographics/`, `landing_pages/`)
/// use a richer schema that the Rust `Template` struct doesn't model.
/// They are loaded by the renderer at runtime, so a malformed YAML
/// would only blow up in jsdom or production Electron — neither of
/// which gates CI as effectively as a `cargo test` failure.
///
/// This test closes that gap: every `.yaml`/`.yml` file under the
/// renderer-only category dirs must parse as a valid YAML document
/// (via `serde_yaml::Value`, the loose-typed parse path), AND it must
/// expose the three structural fields every CreatePage.tsx-registered
/// template needs to be picker-addressable: a non-empty `id`, a
/// non-empty `name`, and a non-empty `type`. Schema-specific fields
/// (`hero:`, `features:`, `stats:`, ...) are deliberately NOT asserted
/// here — that's the renderer's job — but the floor enforced below is
/// enough to make a typo'd colon, an unbalanced quote, or a missing
/// id break the Rust build instead of the runtime.
#[test]
fn every_renderer_only_template_is_well_formed_yaml() {
    let root = templates_root();
    let mut files: Vec<PathBuf> = Vec::new();
    for sub in RENDERER_ONLY_TEMPLATE_DIRS {
        let dir = root.join(sub);
        if !dir.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir)
            .follow_links(false)
            .into_iter()
            .filter_map(std::result::Result::ok)
            .filter(|e| e.file_type().is_file())
        {
            let path = entry.into_path();
            if matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("yaml" | "yml")
            ) {
                files.push(path);
            }
        }
    }
    files.sort();
    assert!(
        !files.is_empty(),
        "expected at least one renderer-only template under templates/{{infographics,landing_pages}}/, found none — was the directory renamed?",
    );

    let mut ids_seen: HashSet<String> = HashSet::new();
    for path in &files {
        let body = std::fs::read_to_string(path)
            .unwrap_or_else(|e| panic!("failed to read renderer-only template {path:?}: {e}"));
        let value: serde_yaml::Value = serde_yaml::from_str(&body)
            .unwrap_or_else(|e| panic!("renderer-only template {path:?} is not valid YAML: {e}"));
        let mapping = value.as_mapping().unwrap_or_else(|| {
            panic!(
                "renderer-only template {path:?} must be a YAML mapping at the top level, got {:?}",
                value
            )
        });

        // The three picker-addressable fields. We use `serde_yaml::Value`
        // accessors rather than a derived struct because the renderer-side
        // schema isn't stable enough across infographic / landing-page
        // variants to be worth modelling here — the renderer applies its
        // own per-variant validation downstream.
        for required in ["id", "name", "type"] {
            let v = mapping
                .get(serde_yaml::Value::String(required.to_string()))
                .unwrap_or_else(|| {
                    panic!(
                        "renderer-only template {path:?} is missing required top-level field `{required}`"
                    )
                });
            let s = v.as_str().unwrap_or_else(|| {
                panic!(
                    "renderer-only template {path:?} field `{required}` must be a string, got {v:?}"
                )
            });
            assert!(
                !s.trim().is_empty(),
                "renderer-only template {path:?} field `{required}` must not be empty",
            );
        }

        let id = mapping
            .get(serde_yaml::Value::String("id".to_string()))
            .and_then(|v| v.as_str())
            .expect("id presence and string-ness asserted above")
            .to_string();
        assert!(
            ids_seen.insert(id.clone()),
            "renderer-only template {path:?} declares duplicate id `{id}` (already seen in another file)",
        );
    }
}

/// Reading the live `templates/` tree at test time, assert that every
/// subdirectory is explicitly classified as one of:
///
///   * `RUST_TEMPLATE_DIRS`        — schema-validated by tessera_templates
///   * `RENDERER_ONLY_TEMPLATE_DIRS` — well-formed-only check
///   * `NON_TEMPLATE_DIRS`         — not a template category (e.g. grammars/)
///
/// This closes the failure mode where, if a
/// contributor adds a new category directory (say `templates/forms/`)
/// without updating either list, the per-category tests above silently
/// skip it. Walking the directory at runtime here forces the new
/// category to be classified before the suite can pass — even if the
/// new category isn't yet referenced from `CreatePage.tsx::CATEGORIES`
/// (which is the only thing the renderer-side cross-check covers).
///
/// The companion test on the TS side
/// (`apps/desktop/renderer/src/__tests__/smoke/phaseVerification.test.ts::
/// "every templates/ subdirectory is a classified category"`) enforces
/// the same invariant against `TEMPLATE_CATEGORIES` there, so all three
/// hand-maintained lists (Rust × 2 + TS × 1) are gated by runtime
/// discovery.
#[test]
fn every_templates_subdirectory_is_classified() {
    let root = templates_root();
    assert!(
        root.is_dir(),
        "templates/ directory not found at {root:?} \u{2014} workspace layout changed?",
    );

    let mut discovered: Vec<String> = std::fs::read_dir(&root)
        .unwrap_or_else(|e| panic!("read_dir({root:?}) failed: {e}"))
        .filter_map(std::result::Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    discovered.sort();

    let classified: HashSet<&str> = RUST_TEMPLATE_DIRS
        .iter()
        .chain(RENDERER_ONLY_TEMPLATE_DIRS.iter())
        .chain(NON_TEMPLATE_DIRS.iter())
        .copied()
        .collect();

    let unclassified: Vec<&String> = discovered
        .iter()
        .filter(|d| !classified.contains(d.as_str()))
        .collect();

    assert!(
        unclassified.is_empty(),
        "Unclassified templates/ subdirectories found: {unclassified:?}.\n\
         Add each to RUST_TEMPLATE_DIRS (if its YAML deserialises into\n\
         tessera_templates::Template), RENDERER_ONLY_TEMPLATE_DIRS (if it\n\
         uses the renderer's richer schema), or NON_TEMPLATE_DIRS (if it\n\
         is not a template category at all). See the doc comments above\n\
         each constant for the distinction. The renderer-side\n\
         phaseVerification.test.ts must also be updated to reference the\n\
         new category in TEMPLATE_CATEGORIES.",
    );

    // Symmetry check: every name in the three lists must actually
    // correspond to a real directory. A stale entry (e.g. a category
    // that was removed) would otherwise sit forever in the constants
    // pretending to be covered.
    //
    // We collect the discovered names into a `HashSet<&str>` (not
    // `HashSet<&String>`) so the membership test below can hash a
    // borrowed `&str` directly — `HashSet::<&str>::contains(&str)`
    // avoids allocating a fresh `String` per check. clippy's
    // `inefficient_to_string` lint flagged the previous
    // `discovered_set.contains(&name.to_string())` form for exactly
    // this reason.
    let discovered_set: HashSet<&str> = discovered.iter().map(String::as_str).collect();
    let stale: Vec<&&str> = RUST_TEMPLATE_DIRS
        .iter()
        .chain(RENDERER_ONLY_TEMPLATE_DIRS.iter())
        .chain(NON_TEMPLATE_DIRS.iter())
        .filter(|name| !discovered_set.contains(**name))
        .collect();
    assert!(
        stale.is_empty(),
        "Classified directory names that don't exist under templates/: {stale:?}.\n\
         Remove them from the constants \u{2014} the smoke suite should not\n\
         claim coverage of a directory that isn't on disk.",
    );
}
