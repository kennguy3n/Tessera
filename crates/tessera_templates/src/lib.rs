pub mod parser;
pub mod registry;
pub mod template;
pub mod validator;

pub use registry::{
    TemplateLoadFailure, TemplateLoadFailureKind, TemplateLoadResult, TemplateRegistry,
};
pub use template::Template;

/// Canonical list of template-category directories rooted at
/// `templates/<category>/`. This is the **single source of truth** for
/// every code path that walks the template tree:
///   - `parser::load_template_by_id` iterates this list when resolving a
///     template id at runtime.
///   - `tests/bundled_templates.rs` iterates it when enumerating every
///     YAML that ships in the workspace.
///   - Any future tool (validator binary, sync script) that needs the
///     full template set should consume this constant rather than
///     redeclaring the list.
///
/// Adding a new category is a one-line edit here; the parser and the
/// registry test pick it up automatically. The 2026 cleanup of the
/// pre-existing "three parallel lists must be kept in sync manually"
/// problem (flagged by ) is what introduced this
/// constant.
pub const TEMPLATE_CATEGORIES: &[&str] = &[
    "documents",
    "slides",
    "sheets",
    "bases",
    "infographics",
    "landing_pages",
];
