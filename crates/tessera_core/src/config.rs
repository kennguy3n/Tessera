use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Tessera Config.
pub struct TesseraConfig {
    /// Data dir.
    pub data_dir: PathBuf,
    /// Template dir.
    pub template_dir: PathBuf,
    /// Theme.
    pub theme: Theme,
    /// Default export format.
    pub default_export_format: String,
    /// Ignore patterns.
    pub ignore_patterns: Vec<String>,
    /// Watch patterns.
    pub watch_patterns: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
/// Theme.
pub enum Theme {
    #[default]
    /// The `Light` variant.
    Light,
    /// The `Dark` variant.
    Dark,
    /// The `System` variant.
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
    /// Load.
    pub fn load(path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let config: Self = serde_json::from_str(&content)?;
        config.validate()?;
        Ok(config)
    }

    /// Save.
    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = serde_json::to_string_pretty(self)?;
        std::fs::write(path, content)?;
        Ok(())
    }

    /// Validate.
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
