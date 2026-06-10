//! Core domain identifiers and enums shared across every crate
//! (source/artifact/citation ids, types and statuses).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
/// Stable identity of an indexed [`SourceType`] connection (a local
/// folder, cloud drive, KChat channel, …). Wraps a [`Uuid`] so ids are
/// globally unique without a central allocator and are safe to mint
/// offline on any device. Used as the foreign key that ties chunks,
/// indexed files, and citations back to their origin.
pub struct SourceId(pub Uuid);

impl SourceId {
    /// Mints a fresh, random identity (UUIDv4). Collisions are
    /// cryptographically improbable, so callers never need to consult
    /// the database to guarantee uniqueness.
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

impl std::str::FromStr for SourceId {
    type Err = uuid::Error;

    /// Parse a [`SourceId`] from its canonical [`Display`](std::fmt::Display)
    /// form. The inverse of `to_string()`, used to reconstruct an id from the
    /// `source_id` TEXT column (e.g. when re-wrapping per-source DEKs during a
    /// crypto-scheme upgrade).
    fn from_str(s: &str) -> std::result::Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(s)?))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
/// Stable identity of a generated [`ArtifactType`] (document, slides,
/// sheet, …). A random [`Uuid`] minted at creation time and never
/// reused, so an artifact keeps the same id across edits, exports, and
/// version history.
pub struct ArtifactId(pub Uuid);

impl ArtifactId {
    /// Mints a fresh, random identity (UUIDv4) for a new artifact.
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
/// Identity of an artifact-generation template. Unlike the other ids,
/// a template id may be either random (user-authored templates) or
/// *derived deterministically from a name* (built-in templates) — see
/// [`TemplateId::from_string`] — so the same built-in always resolves to
/// the same id across installs.
pub struct TemplateId(pub Uuid);

impl TemplateId {
    /// Mints a fresh, random identity (UUIDv4) for a user-authored
    /// template.
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }

    /// Derives a *deterministic* id from a stable template name via
    /// UUIDv5 (OID namespace). The same `s` always yields the same id,
    /// letting built-in templates ship with fixed ids that survive
    /// reinstalls and stay identical across every device.
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
/// Identity of a single citation — the link binding a span of
/// generated artifact content back to the source chunk it was drawn
/// from. A random [`Uuid`] so citations can be minted during generation
/// without coordinating with storage.
pub struct CitationId(pub Uuid);

impl CitationId {
    /// Mints a fresh, random identity (UUIDv4) for a new citation.
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
/// Identity of a task in the planning/automation layer. A random
/// [`Uuid`] minted at creation and used to reference the task from
/// dependencies, automations, and the Gantt view.
pub struct TaskId(pub Uuid);

impl TaskId {
    /// Mints a fresh, random identity (UUIDv4) for a new task.
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
/// Identity of an automation rule (a trigger/action pairing that runs
/// in the runtime). A random [`Uuid`] minted when the rule is defined.
pub struct AutomationId(pub Uuid);

impl AutomationId {
    /// Mints a fresh, random identity (UUIDv4) for a new automation.
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
/// Lifecycle state of a task. Serialised to `snake_case` for storage
/// and the IPC wire (`todo`, `in_progress`, `done`, `blocked`).
pub enum TaskStatus {
    /// Not yet started — the default state of a freshly created task.
    Todo,
    /// Actively being worked on.
    InProgress,
    /// Completed; counts as finished work in progress rollups.
    Done,
    /// Cannot progress until an external dependency or blocker clears.
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
/// Relative urgency of a task. Ordered low → critical: the derived
/// [`Ord`] follows declaration order, so `Low < Medium < High <
/// Critical` and tasks can be sorted by priority directly.
pub enum TaskPriority {
    /// Nice-to-have; no schedule pressure.
    Low,
    /// Default priority for ordinary work.
    Medium,
    /// Should be addressed ahead of medium/low work.
    High,
    /// Must be addressed immediately; sorts above all other levels.
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

/// Wall-clock instant in UTC used for every stored time field
/// (created/updated/indexed timestamps). Storing every instant in UTC
/// keeps the whole workspace time zone-independent; conversion to local
/// time happens only at the presentation layer.
///
/// Aliased to [`chrono::DateTime`]`<`[`chrono::Utc`]`>`.
pub type Timestamp = DateTime<Utc>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Kind of backend a [`SourceId`] connects to. Determines which
/// connector drives sync and how `Source.path` is interpreted.
/// Serialised to `snake_case` for storage and IPC.
pub enum SourceType {
    /// A directory on the local filesystem, indexed recursively;
    /// `Source.path` is the folder path.
    LocalFolder,
    /// A single file on the local filesystem; `Source.path` is the
    /// file path.
    LocalFile,
    /// A Google Drive account/folder synced via the Drive connector.
    GoogleDrive,
    /// A Microsoft OneDrive account/folder synced via the OneDrive
    /// connector.
    OneDrive,
    /// A Notion workspace synced via the Notion connector.
    Notion,
    /// A Jira project synced via the Jira connector.
    Jira,
    /// A Confluence space synced via the Confluence connector.
    Confluence,
    /// A Figma project synced via the Figma connector.
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
/// Where a source sits in the connect → index lifecycle. Serialised to
/// `snake_case`; retrieval paths use [`SourceStatus::as_stored_json`]
/// to filter on the persisted form.
pub enum SourceStatus {
    /// Authenticated and reachable, but its corpus has not been
    /// indexed yet (also the state a source returns to after an ACL
    /// regrant, until a full re-sync runs).
    Connected,
    /// A sync/index pass is currently in flight.
    Indexing,
    /// Fully indexed and searchable.
    Indexed,
    /// The last sync failed; see the connector's failure state for the
    /// reason.
    Error,
    /// Intentionally disconnected by the user; retained but not synced.
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
/// Kind of artifact a generator produces. Selects the editor and the
/// set of valid export formats. Serialised to `snake_case`.
pub enum ArtifactType {
    /// Long-form rich-text document.
    Document,
    /// Slide deck / presentation.
    Slides,
    /// Tabular spreadsheet.
    Sheet,
    /// Structured database (records + fields), Tessera's "base".
    Base,
    /// Single-canvas infographic.
    Infographic,
    /// Standalone HTML landing page.
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
/// Target file format for exporting an artifact. Which formats are
/// valid depends on the [`ArtifactType`] being exported. Serialised to
/// `snake_case`.
pub enum ExportFormat {
    /// CommonMark Markdown text.
    Markdown,
    /// Self-contained HTML.
    Html,
    /// Comma-separated values (tabular artifacts).
    Csv,
    /// Portable Document Format.
    Pdf,
    /// Microsoft Word document.
    Docx,
    /// Microsoft PowerPoint presentation.
    Pptx,
    /// Microsoft Excel workbook.
    Xlsx,
    /// Raw JSON serialisation of the artifact.
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
