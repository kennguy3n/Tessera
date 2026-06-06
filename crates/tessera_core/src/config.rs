//! The `TesseraConfig` application configuration and its on-disk
//! load/save handling.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// User-level application configuration, persisted as JSON and loaded
/// at startup. All paths are absolute (or resolved relative to the app
/// working directory) by the time they reach the rest of the system.
pub struct TesseraConfig {
    /// Root directory holding the SQLCipher database and all indexed
    /// caches; the local-first store lives entirely under here.
    pub data_dir: PathBuf,
    /// Directory scanned for artifact-generation templates.
    pub template_dir: PathBuf,
    /// Active UI colour theme.
    pub theme: Theme,
    /// Export format pre-selected in the UI, as the `snake_case`
    /// [`ExportFormat`](crate::types::ExportFormat) string (e.g.
    /// `"markdown"`). Must be non-empty — enforced by
    /// [`TesseraConfig::validate`].
    pub default_export_format: String,
    /// Glob patterns excluded when indexing local sources (build
    /// artifacts, VCS metadata, binaries, …). Defaults cover common
    /// noise like `.git`, `node_modules`, `target`, and compiled
    /// binaries.
    pub ignore_patterns: Vec<String>,
    /// Glob patterns whose matching files trigger re-indexing on
    /// change; `["*"]` (the default) watches everything not ignored.
    pub watch_patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// UI colour theme. Serialised to `snake_case`; `Light` is the
/// default.
pub enum Theme {
    #[default]
    /// Always use the light palette.
    Light,
    /// Always use the dark palette.
    Dark,
    /// Follow the operating system's light/dark preference.
    System,
}

impl Default for TesseraConfig {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("data"),
            template_dir: PathBuf::from("templates"),
            theme: Theme::default(),
            default_export_format: "markdown".to_string(),
            ignore_patterns: default_ignore_patterns(),
            watch_patterns: vec!["*".to_string()],
        }
    }
}

fn default_ignore_patterns() -> Vec<String> {
    vec![
        ".git".to_string(),
        "node_modules".to_string(),
        ".DS_Store".to_string(),
        "Thumbs.db".to_string(),
        "*.exe".to_string(),
        "*.dll".to_string(),
        "*.so".to_string(),
        "*.dylib".to_string(),
        "*.bin".to_string(),
        "*.o".to_string(),
        "*.a".to_string(),
        "target".to_string(),
        "dist".to_string(),
        "__pycache__".to_string(),
    ]
}

impl TesseraConfig {
    /// Reads and parses the JSON config at `path`, then runs
    /// [`TesseraConfig::validate`]. Returns an error if the file is
    /// missing, malformed, or fails validation.
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Self = serde_json::from_str(&content)?;
        config.validate()?;
        Ok(config)
    }

    /// Serialises the config to pretty JSON and writes it to `path`,
    /// creating parent directories as needed.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }

    /// Checks invariants the rest of the system relies on — currently
    /// that `default_export_format` is non-empty. Called automatically
    /// by [`TesseraConfig::load`].
    pub fn validate(&self) -> Result<()> {
        if self.default_export_format.is_empty() {
            return Err(Error::InvalidConfig(
                "default_export_format cannot be empty".to_string(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid() {
        let config = TesseraConfig::default();
        assert!(config.validate().is_ok());
    }

    #[test]
    fn config_round_trips_through_json() {
        let config = TesseraConfig::default();
        let json = serde_json::to_string(&config).unwrap();
        let restored: TesseraConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config.data_dir, restored.data_dir);
        assert_eq!(config.theme, restored.theme);
    }

    #[test]
    fn config_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let config = TesseraConfig::default();
        config.save(&path).unwrap();
        let loaded = TesseraConfig::load(&path).unwrap();
        assert_eq!(config.data_dir, loaded.data_dir);
        assert_eq!(config.theme, loaded.theme);
        assert_eq!(config.ignore_patterns.len(), loaded.ignore_patterns.len());
    }

    #[test]
    fn invalid_config_rejected() {
        let config = TesseraConfig {
            default_export_format: String::new(),
            ..TesseraConfig::default()
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn default_ignore_patterns_present() {
        let config = TesseraConfig::default();
        assert!(config.ignore_patterns.contains(&".git".to_string()));
        assert!(config.ignore_patterns.contains(&"node_modules".to_string()));
    }
}
