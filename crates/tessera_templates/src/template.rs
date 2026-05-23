use serde::{Deserialize, Serialize};
use tessera_core::{ArtifactType, ExportFormat, TemplateId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Template {
    pub id: String,
    #[serde(skip)]
    pub template_id: TemplateId,
    pub name: String,
    #[serde(rename = "type")]
    pub artifact_type: ArtifactType,
    pub description: String,
    pub sections: Vec<TemplateSection>,
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
pub struct TemplateSection {
    pub title: String,
    pub prompt: String,
    #[serde(default)]
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
pub struct RequiredSource {
    #[serde(rename = "type")]
    pub source_type: String,
    #[serde(default)]
    pub min: Option<u32>,
}

impl Template {
    pub fn with_computed_id(mut self) -> Self {
        self.template_id = TemplateId::from_string(&self.id);
        self
    }

    pub fn section_count(&self) -> usize {
        self.sections.len()
    }

    pub fn export_formats(&self) -> &[ExportFormat] {
        &self.export
    }
}
