//! The runtime manager: spawns and supervises the local inference
//! sidecar process and brokers generation requests to it.

use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::{Duration, Instant};

use crate::config::{
    available_models_for_platform, detect_platform, select_model as select_model_fn, DeviceTier,
    ModelCapability, ModelInfo, Platform, RuntimeConfig, RuntimeState, RuntimeStatus,
};

#[derive(thiserror::Error, Debug)]
/// Runtime Error.
pub enum RuntimeError {
    #[error("Model not found: {0}")]
    /// Model not found.
    ModelNotFound(String),
    #[error("Binary not found at: {0}")]
    /// Binary not found at.
    BinaryNotFound(String),
    #[error("Failed to start sidecar: {0}")]
    /// Failed to start sidecar.
    StartFailed(String),
    #[error("Runtime not running")]
    /// Runtime not running.
    NotRunning,
    #[error("IO error: {0}")]
    /// IO error.
    Io(#[from] std::io::Error),
}

/// Result type alias.
pub type Result<T> = std::result::Result<T, RuntimeError>;

/// Runtime Manager.
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
    /// Creates a new instance.
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

    /// Detect device tier.
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

    /// Pick the best text model for the detected platform/tier.
    ///
    /// This wrapper is kept for the existing call sites that only
    /// ever cared about the text slot (the runtime manager itself
    /// drives `llama-server` for text completion). Use
    /// [`Self::select_model_for_capability`] for vision/imagegen slots.
    pub fn select_model(tier: DeviceTier) -> ModelInfo {
        select_model_fn(tier, detect_platform(), ModelCapability::Text)
    }

    /// Pick the best text model for an explicit platform/tier.
    pub fn select_model_for_platform(tier: DeviceTier, platform: Platform) -> ModelInfo {
        select_model_fn(tier, platform, ModelCapability::Text)
    }

    /// Pick the best model for an explicit capability slot.
    ///
    /// Block A adds vision and image-generation slots alongside the
    /// text slot; callers that resolve a model for those slots route
    /// through here.
    pub fn select_model_for_capability(
        tier: DeviceTier,
        platform: Platform,
        capability: ModelCapability,
    ) -> ModelInfo {
        select_model_fn(tier, platform, capability)
    }

    /// List available models.
    pub fn list_available_models() -> Vec<ModelInfo> {
        available_models_for_platform(detect_platform())
    }

    /// List available models for platform.
    pub fn list_available_models_for_platform(platform: Platform) -> Vec<ModelInfo> {
        available_models_for_platform(platform)
    }

    /// Start.
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

    /// Stop.
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

    /// Get status.
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

    /// Mark running.
    pub async fn mark_running(&self) {
        let mut state = self.state.lock().await;
        state.status = RuntimeStatus::Running;
        state.last_activity = Some(Instant::now());
    }

    /// Mark error.
    pub async fn mark_error(&self) {
        let mut state = self.state.lock().await;
        state.status = RuntimeStatus::Error;
    }

    /// Touch activity.
    pub async fn touch_activity(&self) {
        let mut state = self.state.lock().await;
        state.last_activity = Some(Instant::now());
    }

    /// Check idle timeout.
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

    /// Endpoint.
    pub fn endpoint(&self) -> String {
        format!("http://{}:{}", self.config.host, self.config.port)
    }
}

/// Sys total ram gb.
pub fn sys_total_ram_gb() -> f64 {
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/meminfo") {
            if let Some(gb) = parse_linux_meminfo(&content) {
                return gb;
            }
        }
        4.0
    }
    #[cfg(target_os = "macos")]
    {
        use std::process::Command as StdCmd;
        if let Ok(output) = StdCmd::new("sysctl").arg("-n").arg("hw.memsize").output() {
            if let Ok(s) = String::from_utf8(output.stdout) {
                if let Some(gb) = parse_macos_sysctl(&s) {
                    return gb;
                }
            }
        }
        4.0
    }
    #[cfg(target_os = "windows")]
    {
        use std::process::Command as StdCmd;
        // PowerShell / Get-CimInstance is the modern path. wmic was deprecated
        // in Windows 10 21H1 but is still present on many systems, so we keep
        // it as a fallback.
        if let Ok(output) = StdCmd::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
            ])
            .output()
        {
            if let Ok(s) = String::from_utf8(output.stdout) {
                if let Some(gb) = parse_windows_powershell(&s) {
                    return gb;
                }
            }
        }
        if let Ok(output) = StdCmd::new("wmic")
            .args(["ComputerSystem", "get", "TotalPhysicalMemory", "/value"])
            .output()
        {
            if let Ok(s) = String::from_utf8(output.stdout) {
                if let Some(gb) = parse_windows_wmic(&s) {
                    return gb;
                }
            }
        }
        4.0
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        4.0
    }
}

/// Parse the contents of `/proc/meminfo` and return total RAM in GB.
#[must_use]
pub fn parse_linux_meminfo(content: &str) -> Option<f64> {
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let mut parts = rest.split_whitespace();
            let kb_str = parts.next()?;
            let kb: f64 = kb_str.parse().ok()?;
            return Some(kb / 1_048_576.0);
        }
    }
    None
}

/// Parse the stdout of `sysctl -n hw.memsize` and return total RAM in GB.
#[must_use]
pub fn parse_macos_sysctl(stdout: &str) -> Option<f64> {
    let bytes: f64 = stdout.trim().parse().ok()?;
    Some(bytes / (1024.0 * 1024.0 * 1024.0))
}

/// Parse the stdout of PowerShell's `(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory`
/// and return total RAM in GB.
#[must_use]
pub fn parse_windows_powershell(stdout: &str) -> Option<f64> {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return None;
    }
    let bytes: f64 = trimmed.parse().ok()?;
    Some(bytes / (1024.0 * 1024.0 * 1024.0))
}

/// Parse `wmic ComputerSystem get TotalPhysicalMemory /value` output.
///
/// `wmic /value` emits `Key=Value` lines plus blank padding; we walk
/// lines looking for the `TotalPhysicalMemory=` prefix.
#[must_use]
pub fn parse_windows_wmic(stdout: &str) -> Option<f64> {
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(val) = line.strip_prefix("TotalPhysicalMemory=") {
            let bytes: f64 = val.trim().parse().ok()?;
            return Some(bytes / (1024.0 * 1024.0 * 1024.0));
        }
    }
    None
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

    #[tokio::test]
    async fn start_missing_binary_returns_error() {
        let config = RuntimeConfig {
            binary_path: "/nonexistent/llama-server".to_string(),
            ..RuntimeConfig::default()
        };
        let mgr = RuntimeManager::new(config);
        let result = mgr.start("/also/nonexistent/model.gguf").await;
        assert!(result.is_err());
        match result.unwrap_err() {
            RuntimeError::BinaryNotFound(path) => assert!(path.contains("nonexistent")),
            other => panic!("Expected BinaryNotFound, got: {other}"),
        }
    }

    #[tokio::test]
    async fn stop_when_already_stopped_is_ok() {
        let config = RuntimeConfig::default();
        let mgr = RuntimeManager::new(config);
        let result = mgr.stop().await;
        assert!(result.is_ok());
        let state = mgr.get_status().await;
        assert_eq!(state.status, RuntimeStatus::Stopped);
    }

    #[tokio::test]
    async fn mark_running_then_error_transitions() {
        let config = RuntimeConfig::default();
        let mgr = RuntimeManager::new(config);
        mgr.mark_running().await;
        let state = mgr.get_status().await;
        assert_eq!(state.status, RuntimeStatus::Running);

        mgr.mark_error().await;
        let state = mgr.get_status().await;
        assert_eq!(state.status, RuntimeStatus::Error);
    }

    #[tokio::test]
    async fn endpoint_matches_config() {
        let config = RuntimeConfig {
            host: "127.0.0.1".to_string(),
            port: 9999,
            ..RuntimeConfig::default()
        };
        let mgr = RuntimeManager::new(config);
        assert_eq!(mgr.endpoint(), "http://127.0.0.1:9999");
    }

    #[test]
    fn list_available_models_not_empty() {
        let models = RuntimeManager::list_available_models();
        assert!(!models.is_empty());
        for model in &models {
            assert!(!model.name.is_empty());
            assert!(model.required_ram_gb > 0.0);
        }
    }

    #[test]
    fn parse_linux_meminfo_typical_16gb() {
        let sample = "\
MemTotal:       16384000 kB
MemFree:         1234567 kB
Buffers:          123456 kB
";
        let gb = parse_linux_meminfo(sample).expect("parse");
        // 16384000 kB / 1_048_576 = 15.625 GB
        assert!((gb - 15.625).abs() < 0.01, "got {gb}");
    }

    #[test]
    fn parse_linux_meminfo_4gb() {
        let sample = "MemTotal:        4194304 kB\n";
        let gb = parse_linux_meminfo(sample).expect("parse");
        // 4194304 kB / 1_048_576 = 4.0 GB exactly
        assert!((gb - 4.0).abs() < 0.001, "got {gb}");
    }

    #[test]
    fn parse_linux_meminfo_returns_none_when_missing() {
        assert!(parse_linux_meminfo("SomethingElse: 10\n").is_none());
    }

    #[test]
    fn parse_macos_sysctl_16gb() {
        // 16 GiB in bytes
        let s = "17179869184\n";
        let gb = parse_macos_sysctl(s).expect("parse");
        assert!((gb - 16.0).abs() < 0.001, "got {gb}");
    }

    #[test]
    fn parse_macos_sysctl_invalid() {
        assert!(parse_macos_sysctl("not-a-number").is_none());
    }

    #[test]
    fn parse_windows_powershell_16gb() {
        // PowerShell prints with trailing \r\n on Windows
        let s = "17179869184\r\n";
        let gb = parse_windows_powershell(s).expect("parse");
        assert!((gb - 16.0).abs() < 0.001, "got {gb}");
    }

    #[test]
    fn parse_windows_powershell_8gb() {
        let s = "8589934592\r\n";
        let gb = parse_windows_powershell(s).expect("parse");
        assert!((gb - 8.0).abs() < 0.001, "got {gb}");
    }

    #[test]
    fn parse_windows_powershell_empty_returns_none() {
        assert!(parse_windows_powershell("").is_none());
        assert!(parse_windows_powershell("   \r\n").is_none());
    }

    #[test]
    fn parse_windows_wmic_value_format() {
        // `wmic /value` emits blank-padded Key=Value lines.
        let s = "\r\n\r\nTotalPhysicalMemory=17179869184\r\n\r\n\r\n";
        let gb = parse_windows_wmic(s).expect("parse");
        assert!((gb - 16.0).abs() < 0.001, "got {gb}");
    }

    #[test]
    fn parse_windows_wmic_missing_key_returns_none() {
        assert!(parse_windows_wmic("OtherKey=1234\r\n").is_none());
    }
}
