use std::path::Path;
use tessera_core::config::TesseraConfig;

use crate::{BridgeError, BridgeResult};

pub fn get_settings(config_path: &str) -> BridgeResult<String> {
    let path = Path::new(config_path);
    let config = if path.exists() {
        TesseraConfig::load(path).map_err(BridgeError::Core)?
    } else {
        TesseraConfig::default()
    };
    serde_json::to_string(&config).map_err(|e| BridgeError::Serialization(e.to_string()))
}

pub fn update_settings(config_path: &str, settings_json: &str) -> BridgeResult<()> {
    let config: TesseraConfig =
        serde_json::from_str(settings_json).map_err(|e| BridgeError::InvalidArgs(e.to_string()))?;
    config.validate().map_err(BridgeError::Core)?;
    config
        .save(Path::new(config_path))
        .map_err(BridgeError::Core)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_default_settings() {
        let json = get_settings("/nonexistent/config.json").unwrap();
        let config: TesseraConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config.theme, tessera_core::config::Theme::Light);
    }

    #[test]
    fn update_and_read_settings() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let path_str = path.to_str().unwrap();

        let new_settings = r#"{
            "data_dir": "custom_data",
            "template_dir": "templates",
            "theme": "dark",
            "default_export_format": "html",
            "ignore_patterns": [".git"],
            "watch_patterns": ["*"]
        }"#;

        update_settings(path_str, new_settings).unwrap();

        let json = get_settings(path_str).unwrap();
        let config: TesseraConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(config.theme, tessera_core::config::Theme::Dark);
        assert_eq!(config.default_export_format, "html");
    }
}
