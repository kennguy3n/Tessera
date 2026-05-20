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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateSection {
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub required_sources: Vec<RequiredSource>,
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
