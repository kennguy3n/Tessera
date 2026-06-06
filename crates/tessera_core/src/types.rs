use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
/// Source Id.
pub struct SourceId(pub Uuid);

impl SourceId {
    /// Creates a new instance.
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
/// Artifact Id.
pub struct ArtifactId(pub Uuid);

impl ArtifactId {
    /// Creates a new instance.
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
/// Template Id.
pub struct TemplateId(pub Uuid);

impl TemplateId {
    /// Creates a new instance.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// From string.
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
/// Citation Id.
pub struct CitationId(pub Uuid);

impl CitationId {
    /// Creates a new instance.
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
/// Task Id.
pub struct TaskId(pub Uuid);

impl TaskId {
    /// Creates a new instance.
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
/// Automation Id.
pub struct AutomationId(pub Uuid);

impl AutomationId {
    /// Creates a new instance.
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
/// Task Status.
pub enum TaskStatus {
    /// The `Todo` variant.
    Todo,
    /// In Progress.
    InProgress,
    /// The `Done` variant.
    Done,
    /// The `Blocked` variant.
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
/// Task Priority.
pub enum TaskPriority {
    /// The `Low` variant.
    Low,
    /// The `Medium` variant.
    Medium,
    /// The `High` variant.
    High,
    /// The `Critical` variant.
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

/// Timestamp type alias.
pub type Timestamp = DateTime<Utc>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Source Type.
pub enum SourceType {
    /// Local Folder.
    LocalFolder,
    /// Local File.
    LocalFile,
    /// Google Drive.
    GoogleDrive,
    /// One Drive.
    OneDrive,
    /// The `Notion` variant.
    Notion,
    /// The `Jira` variant.
    Jira,
    /// The `Confluence` variant.
    Confluence,
    /// The `Figma` variant.
    Figma,
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
/// Source Status.
pub enum SourceStatus {
    /// The `Connected` variant.
    Connected,
    /// The `Indexing` variant.
    Indexing,
    /// The `Indexed` variant.
    Indexed,
    /// The `Error` variant.
    Error,
    /// The `Disconnected` variant.
    Disconnected,
    /// The local user has lost authorisation to read this source.
    /// Block B Task 3 introduces this state for
    /// `SourceType::Kchat` rows where the most recent ACL
    /// projection (`SourceManager::refresh_kchat_acl`) did not
    /// include the locally-authenticated KChat principal, or where
    /// the channel was archived / deleted server-side. The source
    /// row is retained for forensics (audit trail, citation
    /// resolution against historical artifacts) but every
    /// retrieval path filters revoked sources out so a user who
    /// loses access to a KChat channel cannot search content that
    /// was indexed while they still had access.
    ///
    /// Block B Task 4 additionally cryptoshreds every
    /// chunk + indexed_file row on the revoke transition (see
    /// `SourceStore::cryptoshred_kchat_source_evidence`), so a
    /// re-added principal cannot resurrect stale indexed content
    /// silently. The regrant codepath transitions the source to
    /// `Connected` (not `Indexed`): the ACL is fine, but the
    /// corpus is empty until a full re-sync runs via
    /// `bridge_sync_source`, after which the indexer promotes
    /// status to `Indexing` and then back to `Indexed` on its own.
    AccessRevoked,
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
            Self::AccessRevoked => write!(f, "access_revoked"),
        }
    }
}

impl SourceStatus {
    /// SQL literal form of the JSON-serialised status string.
    ///
    /// `SourceStore` persists `status` as `serde_json::to_string`
    /// output (snake_case with surrounding double quotes), e.g.
    /// `"indexed"` (9 chars including quotes). Retrieval-side
    /// filters (FTS5 join, vector cosine load) need the exact
    /// stored form to express `status != ?` predicates without
    /// reaching for `serde_json::to_string` at every call site.
    /// This accessor centralises the mapping so a new variant
    /// cannot drift between the persisted form and the filter
    /// predicate.
    pub fn as_stored_json(&self) -> &'static str {
        match self {
            Self::Connected => "\"connected\"",
            Self::Indexing => "\"indexing\"",
            Self::Indexed => "\"indexed\"",
            Self::Error => "\"error\"",
            Self::Disconnected => "\"disconnected\"",
            Self::AccessRevoked => "\"access_revoked\"",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Artifact Type.
pub enum ArtifactType {
    /// The `Document` variant.
    Document,
    /// The `Slides` variant.
    Slides,
    /// The `Sheet` variant.
    Sheet,
    /// The `Base` variant.
    Base,
    /// The `Infographic` variant.
    Infographic,
    /// Landing Page.
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
/// Export Format.
pub enum ExportFormat {
    /// The `Markdown` variant.
    Markdown,
    /// The `Html` variant.
    Html,
    /// The `Csv` variant.
    Csv,
    /// The `Pdf` variant.
    Pdf,
    /// The `Docx` variant.
    Docx,
    /// The `Pptx` variant.
    Pptx,
    /// The `Xlsx` variant.
    Xlsx,
    /// The `Json` variant.
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
