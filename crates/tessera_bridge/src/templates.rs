//! N-API surface for loading, listing and validating templates.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tessera_audit::AuditLogger;
use tessera_core::ArtifactType;
use tessera_core::Error as CoreError;
use tessera_templates::parser::load_template_by_id;
use tessera_templates::template::Template;
use tessera_templates::validator::validate_template;
use tessera_templates::{TemplateLoadFailureKind, TemplateRegistry};

use crate::{BridgeError, BridgeResult};

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing summary of a [`Template`]: identity plus the metadata
/// the template picker needs without loading section bodies.
pub struct TemplateInfo {
    /// Template id, stringified.
    pub id: String,
    /// Human-readable template name.
    pub name: String,
    /// Artifact kind the template produces (`"document"`, …).
    pub artifact_type: String,
    /// Short description shown in the picker.
    pub description: String,
    /// Number of sections the template defines.
    pub section_count: i32,
    /// Export formats the template supports (e.g. `"pdf"`,
    /// `"docx"`).
    pub export_formats: Vec<String>,
    /// Industry domains this template is tailored for (mirrors the
    /// YAML `industry:` list). Empty means industry-agnostic
    /// ("General"). Lets the renderer derive its industry filter
    /// straight from the registry instead of a hand-maintained list.
    #[serde(default)]
    pub industry: Vec<String>,
    /// BCP-47 locale tag for this template variant. Base templates
    /// default to `"en"`; localized variants shipped as
    /// `<base-id>-<locale>` carry their own tag (e.g. `"es"`), which
    /// the renderer groups to derive each card's available languages.
    #[serde(default = "default_locale")]
    pub locale: String,
    /// On-disk category (directory) the template belongs to, derived
    /// from its artifact type (`document` → `"documents"`,
    /// `slides` → `"slides"`, …). Lets the renderer group templates
    /// without re-implementing the artifact→directory mapping.
    #[serde(default)]
    pub category: String,
}

/// Serde default for [`TemplateInfo::locale`]: mirrors the template
/// schema's `en` default so a deserialized record with no `locale`
/// field reflects the same base-language assumption as the loader.
fn default_locale() -> String {
    "en".to_string()
}

/// Maps an [`ArtifactType`] to the plural on-disk category directory
/// the template ships under. Kept in lock-step with
/// `tessera_templates::TEMPLATE_CATEGORIES`.
fn category_for(artifact_type: ArtifactType) -> &'static str {
    match artifact_type {
        ArtifactType::Document => "documents",
        ArtifactType::Slides => "slides",
        ArtifactType::Sheet => "sheets",
        ArtifactType::Base => "bases",
        ArtifactType::Infographic => "infographics",
        ArtifactType::LandingPage => "landing_pages",
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[napi(object)]
/// JS-facing view of one section within a template.
pub struct TemplateSectionInfo {
    /// Heading shown for this section in the template.
    pub title: String,
    /// Generation prompt used to fill this section.
    pub prompt: String,
    /// Whether the section requires at least one bound source.
    pub required_sources: bool,
}

/// Lists every template found under `template_dir` (no audit
/// logging; broken templates are skipped).
pub fn list_templates(template_dir: &str) -> BridgeResult<Vec<TemplateInfo>> {
    // No audit logger — only the on-disk eprintln surface fires for
    // dropped templates. Used by callers that don't have an audit
    // logger (e.g. unit tests). The IPC path in
    // `napi_exports::bridge_list_templates` calls
    // `list_templates_with_audit` instead so dropped templates land
    // in the audit log.
    list_templates_inner(template_dir, None)
}

/// Same as `list_templates` but routes every parse / validation
/// failure into the supplied audit logger via
/// `log_template_validation_failed`. The successful registry is
/// still returned in full (load-and-continue posture preserved)
/// so a single broken template never takes down the entire list
/// operation. Wired into the napi bridge so the renderer's
/// `templates:list` IPC produces audit rows for any template the
/// user has on disk that no longer parses or validates —
/// previously the only surface was the Electron main process's
/// stderr, which a packaged-build user has no way to read.
pub fn list_templates_with_audit(
    template_dir: &str,
    audit: &AuditLogger,
) -> BridgeResult<Vec<TemplateInfo>> {
    list_templates_inner(template_dir, Some(audit))
}

fn list_templates_inner(
    template_dir: &str,
    audit: Option<&AuditLogger>,
) -> BridgeResult<Vec<TemplateInfo>> {
    let path = Path::new(template_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }

    let result =
        TemplateRegistry::load_from_directory_with_failures(path).map_err(BridgeError::Core)?;

    if let Some(logger) = audit {
        for failure in &result.failures {
            // Ignore audit-write errors so a failed audit row
            // (full disk, locked DB) can never sabotage the
            // template list. Mirrors the `_ = logger.log_*`
            // convention used by every other audit call in
            // `napi_exports.rs`.
            let _ = logger.log_template_validation_failed(
                &failure.path.to_string_lossy(),
                failure.kind.as_str(),
                &failure.error,
            );
        }
    }

    let templates = result
        .registry
        .list()
        .iter()
        .map(template_to_info)
        .collect();

    Ok(templates)
}

/// Loads a single template by id, or `None` if not found (no
/// audit logging).
pub fn get_template(template_dir: &str, template_id: &str) -> BridgeResult<Option<TemplateInfo>> {
    get_template_inner(template_dir, template_id, None)
}

/// Same as `get_template` but routes a validation failure into
/// the supplied audit logger. The IPC path in
/// `napi_exports::bridge_get_template` calls this variant so a
/// user trying to load a known-broken template (e.g. the
/// `TemplateRunner` mounts after `templates:list` already silently
/// dropped it) still produces an audit row pinpointing the file.
pub fn get_template_with_audit(
    template_dir: &str,
    template_id: &str,
    audit: &AuditLogger,
) -> BridgeResult<Option<TemplateInfo>> {
    get_template_inner(template_dir, template_id, Some(audit))
}

fn get_template_inner(
    template_dir: &str,
    template_id: &str,
    audit: Option<&AuditLogger>,
) -> BridgeResult<Option<TemplateInfo>> {
    let path = Path::new(template_dir);
    if !path.exists() {
        return Ok(None);
    }

    // Short-circuit lookup that streams the template tree and stops at
    // the first id match, instead of materializing the full registry
    // (`TemplateRegistry::load_from_directory`) every call. The
    // renderer's `useEffect` on every `TemplateRunner` mount hits this
    // path, and a prior expansion grew the on-disk template set ~5x
    // to 170+ files across locales, so the full-registry walk became
    // measurable.
    //
    // We deliberately reproduce two semantics from the previous
    // registry-backed implementation:
    //
    // 1. Missing id -> `Ok(None)`.
    //    `load_template_by_id` returns the dedicated
    //    `Error::TemplateNotFound(id)` variant on miss (previously
    //    this was a string-matched `TemplateValidation("Template not
    //    found: <id>")`, which made the bridge contract fragile to
    //    any refactor of the error wording). The renderer treats
    //    `None` as "no such template" and `Err` as "lookup failed",
    //    so we map this specific variant back to `Ok(None)`.
    //
    // 2. Validation failure -> `Ok(None)`.
    //    The old `TemplateRegistry::load_from_directory` ran
    //    `validate_template` on every template before adding it to
    //    the registry, so `registry.get_by_id` would only ever return
    //    a validated template (and would yield `None` for parse- or
    //    validate-failed YAML). `load_template_by_id` only parses, so
    //    we need to call the validator here to keep `get_template`
    //    contractually equivalent. Logging the validation failure to
    //    stderr matches the convention already used in
    //    `parser::load_template_by_id` and
    //    `registry::load_from_directory`.
    //
    // Every other error (IO, malformed YAML, etc.) still propagates
    // so callers can distinguish a real failure from a missing or
    // invalid id.
    match load_template_by_id(template_dir, template_id) {
        Ok(template) => match validate_template(&template) {
            Ok(()) => Ok(Some(template_to_info(&template))),
            Err(e) => {
                eprintln!("[tessera_bridge] template `{template_id}` failed validation: {e}");
                if let Some(logger) = audit {
                    // The template parsed but failed validation
                    // (missing sections, out-of-range max_tokens,
                    // etc.). The IPC contract maps this to
                    // `Ok(None)` for back-compat, so the renderer
                    // would silently see "no such template" — the
                    // audit row is the only persistent surface
                    // the operator can grep to find the offending
                    // file.
                    let _ = logger.log_template_validation_failed(
                        template_id,
                        TemplateLoadFailureKind::Validation.as_str(),
                        &e.to_string(),
                    );
                }
                Ok(None)
            }
        },
        Err(CoreError::TemplateNotFound(_)) => Ok(None),
        Err(e) => Err(BridgeError::Core(e)),
    }
}

fn template_to_info(t: &Template) -> TemplateInfo {
    TemplateInfo {
        id: t.id.clone(),
        name: t.name.clone(),
        artifact_type: t.artifact_type.to_string(),
        description: t.description.clone(),
        section_count: t.section_count() as i32,
        export_formats: t
            .export_formats()
            .iter()
            .map(std::string::ToString::to_string)
            .collect(),
        industry: t.industry.clone(),
        locale: t.locale.clone(),
        category: category_for(t.artifact_type).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_templates_from_dir() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::write(
            dir.path().join("documents/prd.yaml"),
            r#"
id: prd-v1
name: PRD
type: document
description: Product Requirements Document
sections:
  - title: Problem
    prompt: Describe the problem.
export:
  - markdown
  - html
"#,
        )
        .unwrap();

        let templates = list_templates(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(templates.len(), 1);
        assert_eq!(templates[0].id, "prd-v1");
    }

    /// A base template that omits `industry`/`locale` must surface the
    /// schema defaults (empty industry list, `"en"` locale) and a
    /// `category` derived from its artifact type. The renderer relies
    /// on these to derive its industry filter and a card's "General"
    /// (industry-agnostic) bucket, so the defaults are part of the
    /// IPC contract.
    #[test]
    fn list_templates_surfaces_default_metadata() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::write(
            dir.path().join("documents/prd.yaml"),
            r#"
id: prd-v1
name: PRD
type: document
description: Product Requirements Document
sections:
  - title: Problem
    prompt: Describe the problem.
export:
  - markdown
"#,
        )
        .unwrap();

        let templates = list_templates(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(templates.len(), 1);
        let info = &templates[0];
        assert!(
            info.industry.is_empty(),
            "industry-agnostic template must surface an empty industry list"
        );
        assert_eq!(info.locale, "en", "base templates default to the en locale");
        assert_eq!(
            info.category, "documents",
            "category must be derived from the document artifact type"
        );
    }

    /// Explicit `industry`/`locale` metadata and the artifact→category
    /// mapping must round-trip through `template_to_info` unchanged so
    /// the renderer can build its filters and locale grouping from the
    /// registry alone. A `slides` template with a non-`en` locale and a
    /// multi-industry list exercises every additive field at once.
    #[test]
    fn list_templates_surfaces_explicit_metadata() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("slides")).unwrap();
        std::fs::write(
            dir.path().join("slides/pitch-es.yaml"),
            r#"
id: pitch-v1-es
name: Presentación
type: slides
description: Plataforma de presentación localizada
locale: es
industry:
  - finance
  - legal
sections:
  - title: Resumen
    prompt: Describe el resumen.
export:
  - pdf
  - pptx
"#,
        )
        .unwrap();

        let templates = list_templates(dir.path().to_str().unwrap()).unwrap();
        assert_eq!(templates.len(), 1);
        let info = &templates[0];
        assert_eq!(info.id, "pitch-v1-es");
        assert_eq!(info.locale, "es");
        assert_eq!(info.industry, vec!["finance".to_string(), "legal".to_string()]);
        assert_eq!(
            info.category, "slides",
            "category must be derived from the slides artifact type"
        );
    }

    /// `category_for` must cover every [`ArtifactType`] with the
    /// matching plural directory from
    /// `tessera_templates::TEMPLATE_CATEGORIES`. Pins the mapping so a
    /// new artifact type cannot silently surface an empty category.
    #[test]
    fn category_for_maps_every_artifact_type() {
        assert_eq!(category_for(ArtifactType::Document), "documents");
        assert_eq!(category_for(ArtifactType::Slides), "slides");
        assert_eq!(category_for(ArtifactType::Sheet), "sheets");
        assert_eq!(category_for(ArtifactType::Base), "bases");
        assert_eq!(category_for(ArtifactType::Infographic), "infographics");
        assert_eq!(category_for(ArtifactType::LandingPage), "landing_pages");
    }

    #[test]
    fn get_template_by_id() {
        let dir = tempfile::tempdir().unwrap();
        // Templates must live under a canonical category subdirectory
        // (see `tessera_templates::TEMPLATE_CATEGORIES`). The
        // `list_templates_from_dir` test above already follows this
        // layout — `get_template_by_id` was written before the
        // contract tightening and used to drop the YAML at the root,
        // which the registry now correctly ignores so its by-id lookup
        // can never diverge from `load_template_by_id` for stray files
        // outside the canonical category tree.
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::write(
            dir.path().join("documents/test.yaml"),
            r#"
id: test-v1
name: Test
type: document
description: Test template
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        let result = get_template(dir.path().to_str().unwrap(), "test-v1").unwrap();
        assert!(result.is_some());
        assert_eq!(result.unwrap().name, "Test");
    }

    #[test]
    fn nonexistent_dir_returns_empty() {
        let templates = list_templates("/nonexistent/path").unwrap();
        assert!(templates.is_empty());
    }

    /// `get_template` must return `Ok(None)` (not `Err(...)`) when the
    /// requested id does not exist in any canonical category. The
    /// previous implementation distinguished "not found" from other
    /// errors via `Err(CoreError::TemplateValidation(msg))
    /// if msg.starts_with("Template not found:")`, which would have
    /// silently propagated as `Err` the moment somebody refactored the
    /// error message in `parser::load_template_by_id`. The new
    /// dedicated `Error::TemplateNotFound` variant makes this contract
    /// type-checked; this test pins it down.
    #[test]
    fn get_template_returns_none_for_missing_id() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        // Drop one real template in so the directory exists and the
        // walker has something to traverse.
        std::fs::write(
            dir.path().join("documents/prd.yaml"),
            r#"
id: prd-v1
name: PRD
type: document
description: Product Requirements Document
sections:
  - title: Problem
    prompt: Describe the problem.
export:
  - markdown
"#,
        )
        .unwrap();

        let result = get_template(dir.path().to_str().unwrap(), "no-such-id-v1").unwrap();
        assert!(
            result.is_none(),
            "expected Ok(None) for missing template id; got Ok(Some({result:?}))"
        );
    }

    /// `get_template` must return `Ok(None)` (not `Ok(Some(...))`) for a
    /// template that parses successfully but fails `validate_template`.
    /// The earlier implementation enforced this implicitly via
    /// `TemplateRegistry::load_from_directory`, which excluded
    /// validate-failed templates from the registry; the perf
    /// refactor switched to `load_template_by_id` which only parses,
    /// so the validation step has to be re-applied explicitly inside
    /// `get_template`. This test fails the moment somebody removes
    /// that re-application.
    #[test]
    fn get_template_skips_validate_failed_template() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        // `description` is required (validator at
        // `tessera_templates::validator::validate_template` rejects an
        // empty description). The YAML parses fine; only the validator
        // catches it.
        std::fs::write(
            dir.path().join("documents/invalid.yaml"),
            r#"
id: invalid-v1
name: Invalid
type: document
description: ""
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        let result = get_template(dir.path().to_str().unwrap(), "invalid-v1").unwrap();
        assert!(
            result.is_none(),
            "expected Ok(None) for validate-failed template; got Ok(Some({result:?}))"
        );
    }

    /// `list_templates_with_audit` must emit one
    /// `TemplateValidationFailed` audit row for every dropped
    /// template (parse OR validation kind), while still returning
    /// the successful subset of the registry. The bridge ties this
    /// to the `templates:list` IPC so an operator can grep the
    /// audit log for templates that silently disappeared from the
    /// renderer's template picker.
    #[test]
    fn list_templates_with_audit_emits_one_row_per_dropped_template() {
        use tessera_audit::AuditEventType;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::create_dir_all(dir.path().join("slides")).unwrap();

        // Healthy template.
        std::fs::write(
            dir.path().join("documents/healthy.yaml"),
            r#"
id: healthy-v1
name: Healthy
type: document
description: ok
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        // Validation failure: empty description.
        std::fs::write(
            dir.path().join("documents/empty-desc.yaml"),
            r#"
id: empty-desc-v1
name: EmptyDesc
type: document
description: ""
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        // Parse failure: not a YAML map at the top level.
        std::fs::write(
            dir.path().join("slides/broken.yaml"),
            "- this is not a template document\n",
        )
        .unwrap();

        let audit = AuditLogger::new_in_memory().unwrap();
        let templates = list_templates_with_audit(dir.path().to_str().unwrap(), &audit).unwrap();

        // The healthy template still loads.
        assert_eq!(
            templates.len(),
            1,
            "healthy template should land in the returned list"
        );
        assert_eq!(templates[0].id, "healthy-v1");

        // Two audit rows: one for the validation failure, one for
        // the parse failure.
        let rows = audit
            .query_by_type(&AuditEventType::TemplateValidationFailed)
            .unwrap();
        assert_eq!(
            rows.len(),
            2,
            "expected one audit row per dropped template; got {}",
            rows.len()
        );

        let by_path: Vec<&str> = rows.iter().map(|r| r.details.as_str()).collect();
        assert!(by_path.iter().any(|d| d.contains("empty-desc.yaml")
            && d.contains("kind=validation")
            && d.contains("description")));
        assert!(by_path
            .iter()
            .any(|d| d.contains("broken.yaml") && d.contains("kind=parse")));
    }

    /// `get_template_with_audit` must emit a `TemplateValidationFailed`
    /// row when the requested template parses but fails validation.
    /// The IPC contract maps this to `Ok(None)` for back-compat, so
    /// the audit row is the only surface the operator can grep to
    /// find the offending file.
    #[test]
    fn get_template_with_audit_emits_validation_row() {
        use tessera_audit::AuditEventType;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::write(
            dir.path().join("documents/invalid.yaml"),
            r#"
id: invalid-v1
name: Invalid
type: document
description: ""
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        let audit = AuditLogger::new_in_memory().unwrap();
        let result =
            get_template_with_audit(dir.path().to_str().unwrap(), "invalid-v1", &audit).unwrap();
        assert!(
            result.is_none(),
            "validate-failed template must surface as Ok(None) to preserve the IPC contract"
        );

        let rows = audit
            .query_by_type(&AuditEventType::TemplateValidationFailed)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].details.contains("kind=validation"));
        // The template id is the surface the user has at the IPC
        // boundary; preserve it in the details so an operator can
        // grep audit rows for the same id they typed into the
        // template picker.
        assert!(rows[0].details.contains("invalid-v1"));
    }

    /// Missing-id lookups must NOT emit an audit row — the operator
    /// did nothing wrong, and conflating "template not found" with
    /// "template failed validation" would dilute the audit signal.
    #[test]
    fn get_template_with_audit_does_not_audit_missing_id() {
        use tessera_audit::AuditEventType;
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("documents")).unwrap();
        std::fs::write(
            dir.path().join("documents/healthy.yaml"),
            r#"
id: healthy-v1
name: Healthy
type: document
description: ok
sections:
  - title: Intro
    prompt: Write intro.
export:
  - markdown
"#,
        )
        .unwrap();

        let audit = AuditLogger::new_in_memory().unwrap();
        let result =
            get_template_with_audit(dir.path().to_str().unwrap(), "no-such-id-v1", &audit).unwrap();
        assert!(result.is_none());

        let rows = audit
            .query_by_type(&AuditEventType::TemplateValidationFailed)
            .unwrap();
        assert!(
            rows.is_empty(),
            "missing-id lookup must not emit a validation-failed audit row"
        );
    }
}
