use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SourceId(pub Uuid);

impl SourceId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SourceId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SourceId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ArtifactId(pub Uuid);

impl ArtifactId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ArtifactId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for ArtifactId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TemplateId(pub Uuid);

impl TemplateId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    pub fn from_string(s: &str) -> Self {
        Self(Uuid::new_v5(&Uuid::NAMESPACE_OID, s.as_bytes()))
    }
}

impl Default for TemplateId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for TemplateId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct CitationId(pub Uuid);

impl CitationId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for CitationId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for CitationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaskId(pub Uuid);

impl TaskId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for TaskId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for TaskId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct AutomationId(pub Uuid);

impl AutomationId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for AutomationId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for AutomationId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Todo,
    InProgress,
    Done,
    Blocked,
}

impl std::fmt::Display for TaskStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Todo => write!(f, "todo"),
            Self::InProgress => write!(f, "in_progress"),
            Self::Done => write!(f, "done"),
            Self::Blocked => write!(f, "blocked"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskPriority {
    Low,
    Medium,
    High,
    Critical,
}

impl std::fmt::Display for TaskPriority {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Low => write!(f, "low"),
            Self::Medium => write!(f, "medium"),
            Self::High => write!(f, "high"),
            Self::Critical => write!(f, "critical"),
        }
    }
}

pub type Timestamp = DateTime<Utc>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    LocalFolder,
    LocalFile,
    GoogleDrive,
    OneDrive,
    Notion,
    Jira,
    Confluence,
    Figma,
    /// Email connector — multiplexes Gmail (Google Workspace) and
    /// Microsoft Graph (Outlook / Microsoft 365) under one `email`
    /// `SourceType`. The specific provider is recorded on the
    /// per-connector config alongside the source row.
    Email,
    /// HubSpot CRM connector — pulls contacts / companies / deals /
    /// notes from the HubSpot v3 API.
    HubSpot,
    /// KChat channel connector — files shared into a KChat channel
    /// surface as an indexed source. The renderer downloads the
    /// channel files via the Node-side KChat client and indexes the
    /// cached copies through the standard local-file pipeline. The
    /// `Source.path` for a `Kchat` source points at the on-disk
    /// cache directory for the channel.
    Kchat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    Connected,
    Indexing,
    Indexed,
    Error,
    Disconnected,
}

impl std::fmt::Display for SourceType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::LocalFolder => write!(f, "local_folder"),
            Self::LocalFile => write!(f, "local_file"),
            Self::GoogleDrive => write!(f, "google_drive"),
            Self::OneDrive => write!(f, "one_drive"),
            Self::Notion => write!(f, "notion"),
            Self::Jira => write!(f, "jira"),
            Self::Confluence => write!(f, "confluence"),
            Self::Figma => write!(f, "figma"),
            Self::Email => write!(f, "email"),
            Self::HubSpot => write!(f, "hubspot"),
            Self::Kchat => write!(f, "kchat"),
        }
    }
}

impl std::fmt::Display for SourceStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connected => write!(f, "connected"),
            Self::Indexing => write!(f, "indexing"),
            Self::Indexed => write!(f, "indexed"),
            Self::Error => write!(f, "error"),
            Self::Disconnected => write!(f, "disconnected"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactType {
    Document,
    Slides,
    Sheet,
    Base,
    Infographic,
    LandingPage,
}

impl std::fmt::Display for ArtifactType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Document => write!(f, "document"),
            Self::Slides => write!(f, "slides"),
            Self::Sheet => write!(f, "sheet"),
            Self::Base => write!(f, "base"),
            Self::Infographic => write!(f, "infographic"),
            Self::LandingPage => write!(f, "landing_page"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportFormat {
    Markdown,
    Html,
    Csv,
    Pdf,
    Docx,
    Pptx,
    Xlsx,
    Json,
}

impl std::fmt::Display for ExportFormat {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Markdown => write!(f, "markdown"),
            Self::Html => write!(f, "html"),
            Self::Csv => write!(f, "csv"),
            Self::Pdf => write!(f, "pdf"),
            Self::Docx => write!(f, "docx"),
            Self::Pptx => write!(f, "pptx"),
            Self::Xlsx => write!(f, "xlsx"),
            Self::Json => write!(f, "json"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_id_is_unique() {
        let a = SourceId::new();
        let b = SourceId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn template_id_from_string_is_deterministic() {
        let a = TemplateId::from_string("prd-v1");
        let b = TemplateId::from_string("prd-v1");
        assert_eq!(a, b);

        let c = TemplateId::from_string("proposal-v1");
        assert_ne!(a, c);
    }

    #[test]
    fn source_type_serializes_to_snake_case() {
        let json = serde_json::to_string(&SourceType::LocalFolder).unwrap();
        assert_eq!(json, r#""local_folder""#);
    }

    #[test]
    fn artifact_type_round_trips() {
        let original = ArtifactType::Document;
        let json = serde_json::to_string(&original).unwrap();
        let restored: ArtifactType = serde_json::from_str(&json).unwrap();
        assert_eq!(original, restored);
    }

    #[test]
    fn export_format_round_trips() {
        for fmt in [
            ExportFormat::Markdown,
            ExportFormat::Html,
            ExportFormat::Csv,
            ExportFormat::Json,
        ] {
            let json = serde_json::to_string(&fmt).unwrap();
            let restored: ExportFormat = serde_json::from_str(&json).unwrap();
            assert_eq!(fmt, restored);
        }
    }
}
