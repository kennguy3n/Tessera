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

/// Weight format for a Ternary-Bonsai variant.
///
/// `Gguf` is the only GGUF quantization Tessera ships — the
/// `Q1_0_g128` ternary repack from the PrismML llama.cpp fork.
/// `Mlx` is the 2-bit MLX weight used on Apple Silicon.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelFormat {
    Gguf,
    Mlx,
}

impl ModelFormat {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Gguf => "gguf",
            Self::Mlx => "mlx",
        }
    }

    pub fn display_label(&self) -> &'static str {
        match self {
            Self::Gguf => "GGUF Q1_0_g128",
            Self::Mlx => "MLX 2-bit",
        }
    }
}

/// Compute backend the runtime can dispatch to.
///
/// The PrismML llama.cpp fork's ggml dispatcher selects the best
/// kernel at runtime; Tessera uses this enum to (a) show the user
/// which acceleration paths are available and (b) pick which
/// pre-built `llama-server` binary variant to download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComputeBackend {
    Cpu,
    Cuda,
    Vulkan,
    Metal,
    Rocm,
}

impl ComputeBackend {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Cuda => "cuda",
            Self::Vulkan => "vulkan",
            Self::Metal => "metal",
            Self::Rocm => "rocm",
        }
    }

    pub fn display_label(&self) -> &'static str {
        match self {
            Self::Cpu => "CPU (AVX2 / AVX-VNNI / AVX-512 VNNI / ARM NEON)",
            Self::Cuda => "CUDA (NVIDIA)",
            Self::Vulkan => "Vulkan",
            Self::Metal => "Metal",
            Self::Rocm => "ROCm (AMD)",
        }
    }
}

/// Host platform Tessera is running on.
///
/// Used to pick which model variant (MLX vs GGUF) and which
/// `llama-server` binary archive (linux/macos/windows × cpu/cuda/vulkan)
/// to download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Platform {
    MacosAppleSilicon,
    MacosIntel,
    WindowsX64,
    LinuxX64,
    LinuxArm64,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::MacosAppleSilicon => "macos-apple-silicon",
            Self::MacosIntel => "macos-intel",
            Self::WindowsX64 => "windows-x64",
            Self::LinuxX64 => "linux-x64",
            Self::LinuxArm64 => "linux-arm64",
        }
    }

    pub fn display_label(&self) -> &'static str {
        match self {
            Self::MacosAppleSilicon => "macOS Apple Silicon",
            Self::MacosIntel => "macOS Intel",
            Self::WindowsX64 => "Windows x64",
            Self::LinuxX64 => "Linux x64",
            Self::LinuxArm64 => "Linux arm64",
        }
    }

    pub fn preferred_format(&self) -> ModelFormat {
        match self {
            Self::MacosAppleSilicon => ModelFormat::Mlx,
            _ => ModelFormat::Gguf,
        }
    }
}

/// Detect the platform Tessera is running on at compile time.
#[must_use]
pub fn detect_platform() -> Platform {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Platform::MacosAppleSilicon
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        Platform::MacosIntel
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Platform::WindowsX64
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Platform::LinuxX64
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        Platform::LinuxArm64
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
    )))]
    {
        // Fallback — closest LinuxX64 contract for unknown unix-like targets.
        Platform::LinuxX64
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub parameters: String,
    /// Quantization label — for Ternary-Bonsai this is `Q1_0_g128` (GGUF)
    /// or `2-bit` (MLX). Never `Q4_K_M`.
    pub quantization: String,
    pub format: ModelFormat,
    pub platform: Platform,
    pub compute_backends: Vec<ComputeBackend>,
    pub required_ram_gb: f64,
    /// Compressed download size in MB.
    pub download_size_mb: u64,
    /// On-disk size in MB once extracted (equal to `download_size_mb`
    /// for single-file GGUF, larger for archived MLX directories).
    pub disk_size_mb: u64,
    pub context_length: u32,
    pub tier: DeviceTier,
    /// File name written to the model cache directory on disk.
    pub filename: String,
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

// --- Model registry ------------------------------------------------------

const MLX_COMPUTE: [ComputeBackend; 1] = [ComputeBackend::Metal];
const GGUF_COMPUTE: [ComputeBackend; 4] = [
    ComputeBackend::Cpu,
    ComputeBackend::Cuda,
    ComputeBackend::Vulkan,
    ComputeBackend::Rocm,
];

const HF_BASE: &str = "https://huggingface.co";

fn mlx_url(slug: &str, archive: &str) -> Option<String> {
    Some(format!("{HF_BASE}/{slug}/resolve/main/{archive}"))
}

fn gguf_url(slug: &str, filename: &str) -> Option<String> {
    Some(format!("{HF_BASE}/{slug}/resolve/main/{filename}"))
}

/// Every Ternary-Bonsai variant Tessera knows about.
///
/// This is the canonical in-code registry. The packaged
/// `sidecars/models.json` manifest mirrors it; `load_model_registry`
/// prefers the manifest at runtime and falls back to this list.
#[must_use]
pub fn full_model_registry() -> Vec<ModelInfo> {
    vec![
        // 1.7B
        ModelInfo {
            id: "ternary-bonsai-1.7b-mlx".into(),
            name: "Ternary-Bonsai 1.7B".into(),
            parameters: "1.7B".into(),
            quantization: "2-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 2.0,
            download_size_mb: 248,
            disk_size_mb: 248,
            context_length: 2048,
            tier: DeviceTier::Low,
            filename: "ternary-bonsai-1.7b-2bit.mlx.tar.gz".into(),
            url: mlx_url(
                "kennguy3n/Ternary-Bonsai-1.7B-MLX",
                "ternary-bonsai-1.7b-2bit.mlx.tar.gz",
            ),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-1.7b-gguf".into(),
            name: "Ternary-Bonsai 1.7B".into(),
            parameters: "1.7B".into(),
            quantization: "Q1_0_g128".into(),
            format: ModelFormat::Gguf,
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 2.0,
            download_size_mb: 450,
            disk_size_mb: 450,
            context_length: 2048,
            tier: DeviceTier::Low,
            filename: "ternary-bonsai-1.7b-q1_0_g128.gguf".into(),
            url: gguf_url(
                "kennguy3n/Ternary-Bonsai-1.7B-GGUF",
                "ternary-bonsai-1.7b-q1_0_g128.gguf",
            ),
            checksum: None,
            local_path: None,
        },
        // 4B
        ModelInfo {
            id: "ternary-bonsai-4b-mlx".into(),
            name: "Ternary-Bonsai 4B".into(),
            parameters: "4B".into(),
            quantization: "2-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 4.0,
            download_size_mb: 600,
            disk_size_mb: 600,
            context_length: 4096,
            tier: DeviceTier::Medium,
            filename: "ternary-bonsai-4b-2bit.mlx.tar.gz".into(),
            url: mlx_url(
                "kennguy3n/Ternary-Bonsai-4B-MLX",
                "ternary-bonsai-4b-2bit.mlx.tar.gz",
            ),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-4b-gguf".into(),
            name: "Ternary-Bonsai 4B".into(),
            parameters: "4B".into(),
            quantization: "Q1_0_g128".into(),
            format: ModelFormat::Gguf,
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 4.0,
            download_size_mb: 1000,
            disk_size_mb: 1000,
            context_length: 4096,
            tier: DeviceTier::Medium,
            filename: "ternary-bonsai-4b-q1_0_g128.gguf".into(),
            url: gguf_url(
                "kennguy3n/Ternary-Bonsai-4B-GGUF",
                "ternary-bonsai-4b-q1_0_g128.gguf",
            ),
            checksum: None,
            local_path: None,
        },
        // 8B
        ModelInfo {
            id: "ternary-bonsai-8b-mlx".into(),
            name: "Ternary-Bonsai 8B".into(),
            parameters: "8B".into(),
            quantization: "2-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 8.0,
            download_size_mb: 1200,
            disk_size_mb: 1200,
            context_length: 8192,
            tier: DeviceTier::High,
            filename: "ternary-bonsai-8b-2bit.mlx.tar.gz".into(),
            url: mlx_url(
                "kennguy3n/Ternary-Bonsai-8B-MLX",
                "ternary-bonsai-8b-2bit.mlx.tar.gz",
            ),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-8b-gguf".into(),
            name: "Ternary-Bonsai 8B".into(),
            parameters: "8B".into(),
            quantization: "Q1_0_g128".into(),
            format: ModelFormat::Gguf,
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 8.0,
            download_size_mb: 2000,
            disk_size_mb: 2000,
            context_length: 8192,
            tier: DeviceTier::High,
            filename: "ternary-bonsai-8b-q1_0_g128.gguf".into(),
            url: gguf_url(
                "kennguy3n/Ternary-Bonsai-8B-GGUF",
                "ternary-bonsai-8b-q1_0_g128.gguf",
            ),
            checksum: None,
            local_path: None,
        },
    ]
}

/// Variants of the registry applicable to a specific platform.
///
/// macOS Apple Silicon returns the three MLX variants; every other
/// platform returns the three GGUF variants with the `platform`
/// field rewritten so callers can introspect which platform the
/// runtime is targeting.
#[must_use]
pub fn available_models_for_platform(platform: Platform) -> Vec<ModelInfo> {
    let preferred = platform.preferred_format();
    full_model_registry()
        .into_iter()
        .filter(|m| m.format == preferred)
        .map(|mut m| {
            m.platform = platform;
            m
        })
        .collect()
}

/// Models available on the current platform (compile-time detected).
#[must_use]
pub fn available_models() -> Vec<ModelInfo> {
    available_models_for_platform(detect_platform())
}

/// Pick the model that matches the device tier on the given platform.
///
/// Returns the lowest-tier variant if the requested tier is not in
/// the registry (this never happens for the shipped registry but
/// keeps the call infallible for callers).
#[must_use]
pub fn select_model(tier: DeviceTier, platform: Platform) -> ModelInfo {
    let mut models = available_models_for_platform(platform);
    if let Some(idx) = models.iter().position(|m| m.tier == tier) {
        models.swap_remove(idx)
    } else {
        models.swap_remove(0)
    }
}

/// Backwards-compatible wrapper that uses the current platform.
#[must_use]
pub fn select_model_for_tier(tier: DeviceTier) -> ModelInfo {
    select_model(tier, detect_platform())
}

// --- Compute-backend detection ------------------------------------------

/// Detect which compute backends the host can dispatch to.
///
/// CPU is always reported. Metal is reported on Apple Silicon. CUDA,
/// Vulkan, and ROCm are best-effort detections based on whether the
/// usual diagnostic tools and SDK directories are present.
#[must_use]
pub fn detect_compute_backends() -> Vec<ComputeBackend> {
    let mut backends = vec![ComputeBackend::Cpu];

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        backends.push(ComputeBackend::Metal);
    }

    if has_nvidia_gpu() {
        backends.push(ComputeBackend::Cuda);
    }
    if has_vulkan() {
        backends.push(ComputeBackend::Vulkan);
    }
    #[cfg(target_os = "linux")]
    {
        if has_rocm() {
            backends.push(ComputeBackend::Rocm);
        }
    }

    backends
}

/// Did `nvidia-smi` (or its Windows equivalent) run successfully?
#[must_use]
pub fn has_nvidia_gpu() -> bool {
    let cmd = if cfg!(target_os = "windows") {
        "nvidia-smi.exe"
    } else {
        "nvidia-smi"
    };
    std::process::Command::new(cmd)
        .arg("-L")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Is the Vulkan loader present?
///
/// We probe `vulkaninfo` first (always installed alongside a working
/// loader) and fall back to filesystem checks for the loader library
/// on Linux/macOS/Windows.
#[must_use]
pub fn has_vulkan() -> bool {
    if std::process::Command::new("vulkaninfo")
        .arg("--summary")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
    {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        let candidates = [
            "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
            "/usr/lib64/libvulkan.so.1",
            "/usr/lib/libvulkan.so.1",
            "/lib/x86_64-linux-gnu/libvulkan.so.1",
        ];
        return candidates.iter().any(|p| std::path::Path::new(p).exists());
    }
    #[cfg(target_os = "windows")]
    {
        return std::path::Path::new(r"C:\Windows\System32\vulkan-1.dll").exists();
    }
    #[cfg(target_os = "macos")]
    {
        return std::path::Path::new("/usr/local/lib/libvulkan.dylib").exists()
            || std::path::Path::new("/opt/homebrew/lib/libvulkan.dylib").exists();
    }
    #[allow(unreachable_code)]
    false
}

/// Is ROCm installed? Linux only.
#[cfg(target_os = "linux")]
#[must_use]
pub fn has_rocm() -> bool {
    std::path::Path::new("/opt/rocm").exists() || std::path::Path::new("/opt/rocm-dkms").exists()
}

#[cfg(not(target_os = "linux"))]
#[must_use]
pub fn has_rocm() -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_no_q4km(m: &ModelInfo) {
        assert_ne!(
            m.quantization, "Q4_K_M",
            "model {} must not use Q4_K_M quantization",
            m.id
        );
    }

    #[test]
    fn registry_contains_three_sizes_per_format() {
        let registry = full_model_registry();
        let mlx: Vec<_> = registry.iter().filter(|m| m.format == ModelFormat::Mlx).collect();
        let gguf: Vec<_> = registry.iter().filter(|m| m.format == ModelFormat::Gguf).collect();
        assert_eq!(mlx.len(), 3);
        assert_eq!(gguf.len(), 3);
    }

    #[test]
    fn no_model_uses_q4km() {
        for m in full_model_registry() {
            assert_no_q4km(&m);
            assert!(
                m.quantization == "Q1_0_g128" || m.quantization == "2-bit",
                "unexpected quantization {} on {}",
                m.quantization,
                m.id
            );
        }
    }

    #[test]
    fn apple_silicon_returns_only_mlx() {
        let models = available_models_for_platform(Platform::MacosAppleSilicon);
        assert_eq!(models.len(), 3);
        for m in &models {
            assert_eq!(m.format, ModelFormat::Mlx);
            assert_eq!(m.platform, Platform::MacosAppleSilicon);
            assert_eq!(m.compute_backends, vec![ComputeBackend::Metal]);
            assert!(m.filename.ends_with(".mlx.tar.gz"));
        }
    }

    #[test]
    fn windows_returns_only_gguf() {
        let models = available_models_for_platform(Platform::WindowsX64);
        assert_eq!(models.len(), 3);
        for m in &models {
            assert_eq!(m.format, ModelFormat::Gguf);
            assert_eq!(m.platform, Platform::WindowsX64);
            assert_eq!(m.quantization, "Q1_0_g128");
            assert!(m.filename.ends_with(".gguf"));
            assert!(m.compute_backends.contains(&ComputeBackend::Cpu));
        }
    }

    #[test]
    fn linux_returns_only_gguf() {
        let models = available_models_for_platform(Platform::LinuxX64);
        assert_eq!(models.len(), 3);
        for m in &models {
            assert_eq!(m.format, ModelFormat::Gguf);
            assert_eq!(m.platform, Platform::LinuxX64);
        }
    }

    #[test]
    fn macos_intel_returns_only_gguf() {
        let models = available_models_for_platform(Platform::MacosIntel);
        for m in &models {
            assert_eq!(m.format, ModelFormat::Gguf);
            assert_eq!(m.platform, Platform::MacosIntel);
        }
    }

    #[test]
    fn select_model_high_apple_silicon() {
        let m = select_model(DeviceTier::High, Platform::MacosAppleSilicon);
        assert_eq!(m.parameters, "8B");
        assert_eq!(m.format, ModelFormat::Mlx);
        assert!((1100..=1300).contains(&m.download_size_mb));
    }

    #[test]
    fn select_model_high_windows() {
        let m = select_model(DeviceTier::High, Platform::WindowsX64);
        assert_eq!(m.parameters, "8B");
        assert_eq!(m.format, ModelFormat::Gguf);
        assert!((1800..=2200).contains(&m.download_size_mb));
        assert_eq!(m.quantization, "Q1_0_g128");
    }

    #[test]
    fn select_model_medium_linux() {
        let m = select_model(DeviceTier::Medium, Platform::LinuxX64);
        assert_eq!(m.parameters, "4B");
        assert!((900..=1100).contains(&m.download_size_mb));
    }

    #[test]
    fn select_model_low_apple_silicon_size_reasonable() {
        let m = select_model(DeviceTier::Low, Platform::MacosAppleSilicon);
        // 1.58-bit MLX, must NOT be Q4_K_M-inflated (~1.1 GB).
        assert!(m.download_size_mb < 400);
        assert_eq!(m.format, ModelFormat::Mlx);
    }

    #[test]
    fn select_model_low_windows_size_reasonable() {
        let m = select_model(DeviceTier::Low, Platform::WindowsX64);
        // 1.58-bit GGUF, must NOT be Q4_K_M-inflated (~1.1 GB).
        assert!(m.download_size_mb < 600);
        assert_eq!(m.format, ModelFormat::Gguf);
    }

    #[test]
    fn detect_platform_returns_known_variant() {
        let p = detect_platform();
        // Just confirm it round-trips through the enum.
        let _ = p.as_str();
        let _ = p.display_label();
        assert_eq!(p, p);
    }

    #[test]
    fn preferred_format_per_platform() {
        assert_eq!(Platform::MacosAppleSilicon.preferred_format(), ModelFormat::Mlx);
        assert_eq!(Platform::MacosIntel.preferred_format(), ModelFormat::Gguf);
        assert_eq!(Platform::WindowsX64.preferred_format(), ModelFormat::Gguf);
        assert_eq!(Platform::LinuxX64.preferred_format(), ModelFormat::Gguf);
        assert_eq!(Platform::LinuxArm64.preferred_format(), ModelFormat::Gguf);
    }

    #[test]
    fn detect_compute_backends_always_includes_cpu() {
        let backends = detect_compute_backends();
        assert!(backends.contains(&ComputeBackend::Cpu));
    }

    #[test]
    fn compute_backend_labels_stable() {
        assert_eq!(ComputeBackend::Cpu.as_str(), "cpu");
        assert_eq!(ComputeBackend::Cuda.as_str(), "cuda");
        assert_eq!(ComputeBackend::Vulkan.as_str(), "vulkan");
        assert_eq!(ComputeBackend::Metal.as_str(), "metal");
        assert_eq!(ComputeBackend::Rocm.as_str(), "rocm");
    }

    #[test]
    fn platform_labels_stable() {
        assert_eq!(Platform::MacosAppleSilicon.as_str(), "macos-apple-silicon");
        assert_eq!(Platform::WindowsX64.as_str(), "windows-x64");
        assert_eq!(Platform::LinuxX64.as_str(), "linux-x64");
        assert_eq!(Platform::LinuxArm64.as_str(), "linux-arm64");
        assert_eq!(Platform::MacosIntel.as_str(), "macos-intel");
    }

    #[test]
    fn select_model_low_tier_back_compat() {
        // Existing call sites use the platform-less helper.
        let m = select_model_for_tier(DeviceTier::Low);
        assert_eq!(m.context_length, 2048);
        assert_no_q4km(&m);
    }

    #[test]
    fn select_model_medium_tier_back_compat() {
        let m = select_model_for_tier(DeviceTier::Medium);
        assert_eq!(m.context_length, 4096);
        assert_no_q4km(&m);
    }

    #[test]
    fn select_model_high_tier_back_compat() {
        let m = select_model_for_tier(DeviceTier::High);
        assert_eq!(m.context_length, 8192);
        assert_no_q4km(&m);
    }

    #[test]
    fn default_config() {
        let config = RuntimeConfig::default();
        assert_eq!(config.port, 8384);
        assert_eq!(config.host, "127.0.0.1");
    }

    #[test]
    fn model_format_labels() {
        assert_eq!(ModelFormat::Gguf.display_label(), "GGUF Q1_0_g128");
        assert_eq!(ModelFormat::Mlx.display_label(), "MLX 2-bit");
    }
}
