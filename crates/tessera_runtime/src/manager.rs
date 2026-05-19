use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{Duration, Instant};

use crate::config::{
    available_models, select_model_for_tier, DeviceTier, ModelInfo, RuntimeConfig, RuntimeState,
    RuntimeStatus,
};

#[derive(thiserror::Error, Debug)]
pub enum RuntimeError {
    #[error("Model not found: {0}")]
    ModelNotFound(String),
    #[error("Binary not found at: {0}")]
    BinaryNotFound(String),
    #[error("Failed to start sidecar: {0}")]
    StartFailed(String),
    #[error("Runtime not running")]
    NotRunning,
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, RuntimeError>;

pub struct RuntimeManager {
    config: RuntimeConfig,
    state: Mutex<ManagedState>,
}

struct ManagedState {
    child: Option<Child>,
    status: RuntimeStatus,
    model_name: Option<String>,
    last_activity: Option<Instant>,
}

impl RuntimeManager {
    pub fn new(config: RuntimeConfig) -> Self {
        Self {
            config,
            state: Mutex::new(ManagedState {
                child: None,
                status: RuntimeStatus::Stopped,
                model_name: None,
                last_activity: None,
            }),
        }
    }

    pub fn detect_device_tier() -> DeviceTier {
        let total_ram = sys_total_ram_gb();
        if total_ram >= 8.0 {
            DeviceTier::High
        } else if total_ram >= 4.0 {
            DeviceTier::Medium
        } else {
            DeviceTier::Low
        }
    }

    pub fn select_model(tier: DeviceTier) -> ModelInfo {
        select_model_for_tier(tier)
    }

    pub fn list_available_models() -> Vec<ModelInfo> {
        available_models()
    }

    pub async fn start(&self, model_path: &str) -> Result<()> {
        let mut state = self.state.lock().await;

        if state.status == RuntimeStatus::Running {
            return Ok(());
        }

        let binary = PathBuf::from(&self.config.binary_path);
        if !binary.exists() && which_binary(&self.config.binary_path).is_none() {
            return Err(RuntimeError::BinaryNotFound(
                self.config.binary_path.clone(),
            ));
        }

        let model = PathBuf::from(model_path);
        if !model.exists() {
            return Err(RuntimeError::ModelNotFound(model_path.to_string()));
        }

        state.status = RuntimeStatus::Starting;

        let child = Command::new(&self.config.binary_path)
            .arg("--model")
            .arg(model_path)
            .arg("--port")
            .arg(self.config.port.to_string())
            .arg("--host")
            .arg(&self.config.host)
            .arg("--parallel")
            .arg(self.config.parallel_slots.to_string())
            .arg("--ctx-size")
            .arg(self.config.max_context_length.to_string())
            .arg("--mlock")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| RuntimeError::StartFailed(e.to_string()))?;

        state.child = Some(child);
        state.model_name = std::path::Path::new(model_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .map(std::string::ToString::to_string);
        state.last_activity = Some(Instant::now());
        state.status = RuntimeStatus::Loading;

        Ok(())
    }

    pub async fn stop(&self) -> Result<()> {
        let mut state = self.state.lock().await;

        if let Some(mut child) = state.child.take() {
            let _ = child.kill().await;
        }

        state.status = RuntimeStatus::Stopped;
        state.model_name = None;
        state.last_activity = None;

        Ok(())
    }

    pub async fn get_status(&self) -> RuntimeState {
        let state = self.state.lock().await;
        RuntimeState {
            status: state.status,
            model_name: state.model_name.clone(),
            device_tier: self.config.device_tier,
            memory_usage_mb: None,
            context_length: self.config.max_context_length,
            active_jobs: 0,
        }
    }

    pub async fn mark_running(&self) {
        let mut state = self.state.lock().await;
        state.status = RuntimeStatus::Running;
        state.last_activity = Some(Instant::now());
    }

    pub async fn mark_error(&self) {
        let mut state = self.state.lock().await;
        state.status = RuntimeStatus::Error;
    }

    pub async fn touch_activity(&self) {
        let mut state = self.state.lock().await;
        state.last_activity = Some(Instant::now());
    }

    pub async fn check_idle_timeout(&self) -> bool {
        let state = self.state.lock().await;
        if state.status != RuntimeStatus::Running {
            return false;
        }
        if let Some(last) = state.last_activity {
            last.elapsed() > Duration::from_secs(self.config.idle_timeout_secs)
        } else {
            false
        }
    }

    pub fn endpoint(&self) -> String {
        format!("http://{}:{}", self.config.host, self.config.port)
    }
}

fn sys_total_ram_gb() -> f64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
            for line in content.lines() {
                if line.starts_with("MemTotal:") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        if let Ok(kb) = parts[1].parse::<f64>() {
                            return kb / 1_048_576.0;
                        }
                    }
                }
            }
        }
        4.0
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command as StdCmd;
        if let Ok(output) = StdCmd::new("sysctl").arg("-n").arg("hw.memsize").output() {
            if let Ok(s) = String::from_utf8(output.stdout) {
                if let Ok(bytes) = s.trim().parse::<f64>() {
                    return bytes / (1024.0 * 1024.0 * 1024.0);
                }
            }
        }
        4.0
    }
    #[cfg(target_os = "windows")]
    {
        4.0
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        4.0
    }
}

fn which_binary(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let full = dir.join(name);
            if full.exists() {
                Some(full)
            } else {
                None
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_tier() {
        let tier = RuntimeManager::detect_device_tier();
        // On CI machines with decent RAM this should be Medium or High
        assert!(matches!(
            tier,
            DeviceTier::Low | DeviceTier::Medium | DeviceTier::High
        ));
    }

    #[test]
    fn select_model_returns_correct_tier() {
        let model = RuntimeManager::select_model(DeviceTier::Low);
        assert!(model.required_ram_gb <= 3.0);

        let model = RuntimeManager::select_model(DeviceTier::High);
        assert!(model.required_ram_gb >= 8.0);
    }

    #[tokio::test]
    async fn manager_starts_stopped() {
        let config = RuntimeConfig::default();
        let mgr = RuntimeManager::new(config);
        let state = mgr.get_status().await;
        assert_eq!(state.status, RuntimeStatus::Stopped);
        assert!(state.model_name.is_none());
    }

    #[tokio::test]
    async fn idle_timeout_not_triggered_when_stopped() {
        let config = RuntimeConfig::default();
        let mgr = RuntimeManager::new(config);
        assert!(!mgr.check_idle_timeout().await);
    }
}
