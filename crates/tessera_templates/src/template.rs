//! The `Template` model describing an artifact template and its
//! sections.

use serde::{Deserialize, Serialize};
use tessera_core::{ArtifactType, ExportFormat, TemplateId};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// A declarative recipe for generating one artifact: an ordered list
/// of [`TemplateSection`]s plus rendering/export metadata. Loaded from
/// YAML on disk; the canonical schema lives in
/// `schemas/template.schema.json`.
pub struct Template {
    /// Stable, human-authored slug (e.g. `"prd-v1"`). Unique within the
    /// registry and used to derive [`Template::template_id`].
    pub id: String,
    #[serde(skip)]
    /// Deterministic [`TemplateId`] derived from [`Template::id`] via
    /// UUIDv5. Not serialised — recomputed on load by
    /// [`Template::with_computed_id`] so it is always consistent with
    /// `id`.
    pub template_id: TemplateId,
    /// Display name shown in the template picker.
    pub name: String,
    #[serde(rename = "type")]
    /// Kind of artifact this template produces (document, slides, …).
    pub artifact_type: ArtifactType,
    /// One-line summary shown under the name in the UI.
    pub description: String,
    /// Ordered sections generated in sequence; their order is the
    /// order they appear in the finished artifact.
    pub sections: Vec<TemplateSection>,
    /// Export formats this template's output is valid for / offered in
    /// the export menu.
    pub export: Vec<ExportFormat>,
    /// Optional output format for the template (e.g. "marp" for slide decks
    /// that should be rendered with Marp Core / Marp CLI). Mirrors the
    /// `format:` field in the YAML.
    #[serde(default)]
    pub format: Option<String>,
    /// Optional preferred theme passed to the rendering engine when `format`
    /// implies one (e.g. Marp themes: default / gaia / uncover).
    #[serde(default)]
    pub theme: Option<String>,
    /// Whether the rendering engine should paginate the output. Marp uses
    /// this directly; other engines may ignore it.
    #[serde(default)]
    pub paginate: Option<bool>,
    /// Raw Marp Markdown template body. When present the template engine
    /// can emit Marp output directly without re-rendering from sections.
    #[serde(default)]
    pub marp_template: Option<String>,
    /// BCP-47 language tag for the template's section titles and prompts.
    /// Defaults to `"en"` when the YAML omits the field. Localized variants
    /// (Spanish, French, German, Japanese, Chinese, Portuguese, Korean,
    /// Arabic, Hindi, etc.) live under `templates/<category>/locales/<locale>/`
    /// and share the same base id with a locale suffix (e.g. `prd-v1-es`).
    /// The renderer's CreatePage filters on this field to present the right
    /// language to the current user.
    #[serde(default = "default_locale")]
    pub locale: String,
    /// Industry domains this template is tailored for (e.g. `"healthcare"`,
    /// `"legal"`, `"education"`, `"government"`, `"finance"`,
    /// `"manufacturing"`, `"retail"`, `"nonprofit"`, `"creative"`,
    /// `"real-estate"`). An empty vector means the template is
    /// industry-agnostic — the default for most general-purpose templates.
    /// Multiple values are permitted for cross-industry templates that span
    /// multiple domains (e.g. a "compliance audit" template tagged with
    /// both `"legal"` and `"finance"`).
    #[serde(default)]
    pub industry: Vec<String>,
    /// Intended user profile(s) this template was authored for (e.g.
    /// `"executive"`, `"analyst"`, `"teacher"`, `"nurse"`,
    /// `"product-manager"`, `"engineer"`). Used by the CreatePage UI to
    /// rank templates by relevance to the current user's profile
    /// preferences. An empty vector means the template is profile-agnostic.
    #[serde(default)]
    pub profile: Vec<String>,
}

/// Default locale for `Template::locale` when the YAML omits the field.
/// Returns the BCP-47 language tag `"en"` — English is the canonical
/// locale for every template that does not carry an explicit override.
fn default_locale() -> String {
    "en".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// One section of a [`Template`]: a heading plus the LLM prompt used
/// to generate its body, with optional source requirements and a
/// generation budget.
pub struct TemplateSection {
    /// Heading rendered for this section in the artifact.
    pub title: String,
    /// Instruction handed to the LLM to generate this section's body.
    pub prompt: String,
    #[serde(default)]
    /// Source-type/count constraints that must be satisfied before
    /// this section can be generated; empty means no requirement.
    pub required_sources: Vec<RequiredSource>,
    /// Maximum tokens the LLM should generate for this section. Mirrors
    /// the `max_tokens` field on the JSON Schema and gives the runtime
    /// a per-section budget for streaming generation. `None` falls back
    /// to the engine's default. Range is checked by
    /// `validator::validate_template`, not at deserialize time, so that
    /// authors get a useful error message rather than a silent failure.
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Expected output structure for this section. Drives both the
    /// generation prompt (e.g. asking for a Markdown table for `Table`)
    /// and the post-generation validator (which can reject prose where
    /// a bulleted list was requested). Defaults to `None`, which means
    /// "free-form prose, no structural assertion".
    #[serde(default)]
    pub output_format: Option<SectionOutputFormat>,
}

/// Structural shape the LLM is asked to produce for a single section.
/// Mirrors the `output_format` enum in `schemas/template.schema.json`.
/// Renaming a variant here is a breaking schema change — bump
/// `schema_version` on every template that references the old name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SectionOutputFormat {
    /// Free-form prose paragraphs. The renderer treats the section body
    /// as Markdown without any structural assertion.
    Prose,
    /// Bullet list. The renderer asserts that the section body is a
    /// Markdown unordered list and rejects non-list output.
    Bullets,
    /// Ordered (numbered) list with one item per line. Used when
    /// sequence matters — e.g. step-by-step SOPs.
    NumberedList,
    /// Markdown table. The renderer expects pipe-delimited rows; the
    /// generator is prompted to emit a header row plus at least one
    /// data row.
    Table,
    /// Structured JSON object. The renderer parses the section body as
    /// JSON and routes it to the downstream artifact-typed renderer
    /// (sheet rows, base records, etc.).
    Json,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// A constraint that a section requires at least `min` connected
/// sources of a given type before it can be generated.
pub struct RequiredSource {
    #[serde(rename = "type")]
    /// Source type that satisfies this requirement, as the
    /// `snake_case` source-type string (e.g. `"local_folder"`).
    pub source_type: String,
    #[serde(default)]
    /// Minimum number of matching sources required; `None` means “at
    /// least one”.
    pub min: Option<u32>,
}

impl Template {
    /// Recomputes [`Template::template_id`] from [`Template::id`] and
    /// returns the updated template. Called after deserialising (the
    /// id field is `#[serde(skip)]`) so the derived id always matches
    /// the slug.
    pub fn with_computed_id(mut self) -> Self {
        self.template_id = TemplateId::from_string(&self.id);
        self
    }

    /// Number of sections in this template.
    pub fn section_count(&self) -> usize {
        self.sections.len()
    }

    /// Export formats this template supports.
    pub fn export_formats(&self) -> &[ExportFormat] {
        &self.export
    }
}
