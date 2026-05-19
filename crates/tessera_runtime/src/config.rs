use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeviceTier {
    Low,
    Medium,
    High,
}

impl DeviceTier {
    pub fn label(&self) -> &str {
        match self {
            Self::Low => "Low (2-3 GB RAM)",
            Self::Medium => "Medium (4-6 GB RAM)",
            Self::High => "High (8+ GB RAM)",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub parameters: String,
    pub quantization: String,
    pub required_ram_gb: f64,
    pub download_size_mb: u64,
    pub context_length: u32,
    pub tier: DeviceTier,
    pub url: Option<String>,
    pub checksum: Option<String>,
    pub local_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeConfig {
    pub model_path: Option<String>,
    pub binary_path: String,
    pub port: u16,
    pub host: String,
    pub device_tier: DeviceTier,
    pub max_context_length: u32,
    pub parallel_slots: u8,
    pub idle_timeout_secs: u64,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            model_path: None,
            binary_path: String::from("llama-server"),
            port: 8384,
            host: String::from("127.0.0.1"),
            device_tier: DeviceTier::Medium,
            max_context_length: 4096,
            parallel_slots: 2,
            idle_timeout_secs: 60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeStatus {
    Stopped,
    Starting,
    Running,
    Loading,
    Error,
}

impl RuntimeStatus {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Loading => "loading",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeState {
    pub status: RuntimeStatus,
    pub model_name: Option<String>,
    pub device_tier: DeviceTier,
    pub memory_usage_mb: Option<u64>,
    pub context_length: u32,
    pub active_jobs: u32,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            status: RuntimeStatus::Stopped,
            model_name: None,
            device_tier: DeviceTier::Medium,
            memory_usage_mb: None,
            context_length: 0,
            active_jobs: 0,
        }
    }
}



pub fn available_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "ternary-bonsai-1.7b-q4km".into(),
            name: "Ternary-Bonsai 1.7B".into(),
            parameters: "1.7B".into(),
            quantization: "Q4_K_M".into(),
            required_ram_gb: 2.0,
            download_size_mb: 1200,
            context_length: 2048,
            tier: DeviceTier::Low,
            url: None,
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-4b-q4km".into(),
            name: "Ternary-Bonsai 4B".into(),
            parameters: "4B".into(),
            quantization: "Q4_K_M".into(),
            required_ram_gb: 4.0,
            download_size_mb: 2800,
            context_length: 4096,
            tier: DeviceTier::Medium,
            url: None,
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-8b-q4km".into(),
            name: "Ternary-Bonsai 8B".into(),
            parameters: "8B".into(),
            quantization: "Q4_K_M".into(),
            required_ram_gb: 8.0,
            download_size_mb: 5600,
            context_length: 8192,
            tier: DeviceTier::High,
            url: None,
            checksum: None,
            local_path: None,
        },
    ]
}

pub fn select_model_for_tier(tier: DeviceTier) -> ModelInfo {
    let models = available_models();
    models
        .into_iter()
        .find(|m| m.tier == tier)
        .unwrap_or_else(|| available_models().into_iter().next().unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn select_model_low_tier() {
        let model = select_model_for_tier(DeviceTier::Low);
        assert_eq!(model.id, "ternary-bonsai-1.7b-q4km");
        assert_eq!(model.context_length, 2048);
    }

    #[test]
    fn select_model_medium_tier() {
        let model = select_model_for_tier(DeviceTier::Medium);
        assert_eq!(model.id, "ternary-bonsai-4b-q4km");
        assert_eq!(model.context_length, 4096);
    }

    #[test]
    fn select_model_high_tier() {
        let model = select_model_for_tier(DeviceTier::High);
        assert_eq!(model.id, "ternary-bonsai-8b-q4km");
        assert_eq!(model.context_length, 8192);
    }

    #[test]
    fn default_config() {
        let config = RuntimeConfig::default();
        assert_eq!(config.port, 8384);
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.device_tier, DeviceTier::Medium);
    }
}
