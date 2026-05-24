use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

/// What a model is good for.
///
/// Tessera ships per-capability model slots — text generation is the
/// long-standing Bonsai family, vision understanding is Qwen3.5-VL /
/// SmolVLM, and image generation is FLUX.2-klein. A single device may
/// have one model installed per capability simultaneously (the
/// single-model-on-disk invariant is per-slot, not global). See
/// `apps/desktop/electron/modelManagement.ts` for the matching
/// TypeScript declaration and on-disk layout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelCapability {
    /// Text-only completion (Bonsai / Ternary-Bonsai).
    Text,
    /// Image+text → text. VLMs (Qwen3.5-VL, SmolVLM).
    Vision,
    /// Text → image. Diffusion models (FLUX.2-klein).
    Imagegen,
}

impl ModelCapability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Vision => "vision",
            Self::Imagegen => "imagegen",
        }
    }

    pub fn display_label(&self) -> &'static str {
        match self {
            Self::Text => "Text generation",
            Self::Vision => "Vision understanding",
            Self::Imagegen => "Image generation",
        }
    }

    /// Every capability shipped by the registry. Ordering is stable —
    /// callers (e.g. the Settings UI multi-section renderer) rely on
    /// this for consistent display order.
    pub fn all() -> [Self; 3] {
        [Self::Text, Self::Vision, Self::Imagegen]
    }
}

/// Weight format for a model variant.
///
/// `Gguf` is the GGUF quantization Tessera ships — for text it is the
/// `Q1_0_g128` ternary repack from the PrismML llama.cpp fork; for
/// vision it is Q4_K_M / Q4_K_S; for image generation it is Q4_0
/// (FLUX.2-klein).  `Mlx` is the equivalent quantized MLX weight used
/// on Apple Silicon.
///
/// Serialised lowercase to match the TypeScript wire format used by
/// `apps/desktop/electron/modelManagement.ts` and the `sidecars/models.json`
/// manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
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

    /// Format-level human label. Intentionally just the format name
    /// without a hardcoded quantization — each capability ships its
    /// own quantization (Bonsai text uses `Q1_0_g128` / `MLX 2-bit`,
    /// Qwen3.5 vision uses `Q4_K_M` / `MLX 4-bit`, FLUX imagegen uses
    /// `Q4_0` / `MLX 4-bit`), so pinning a single quantization here
    /// would mislabel every non-text entry. Callers that want the
    /// "format + quantization" pair should use `ModelInfo::display_label`
    /// or the TS-side `ResolvedModel.formatLabel`, both of which read
    /// the per-entry `quantization` field.
    pub fn display_label(&self) -> &'static str {
        match self {
            Self::Gguf => "GGUF",
            Self::Mlx => "MLX",
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
#[serde(rename_all = "lowercase")]
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

    /// Whether this backend dispatches work to a GPU.
    ///
    /// Used by [`is_capability_available`] to gate image generation
    /// (FLUX.2-klein on a quantized CPU path is unusably slow, so
    /// the slot is hidden on CPU-only hosts).
    #[must_use]
    pub fn is_gpu(&self) -> bool {
        match self {
            Self::Cpu => false,
            Self::Cuda | Self::Vulkan | Self::Metal | Self::Rocm => true,
        }
    }
}

/// Host platform Tessera is running on.
///
/// Used to pick which model variant (MLX vs GGUF) and which
/// `llama-server` binary archive (linux/macos/windows × cpu/cuda/vulkan)
/// to download.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
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
    /// What slot this model occupies — text, vision, or image generation.
    /// Defaults to [`ModelCapability::Text`] when the manifest predates
    /// the capability field (kept on a `serde(default)` so historical
    /// `active-model-*.json` records and older serialized blobs still
    /// deserialize).
    #[serde(default = "default_capability")]
    pub capability: ModelCapability,
    /// Quantization label. For text models this is `Q1_0_g128` /
    /// `2-bit` (Ternary-Bonsai), for vision `Q4_K_M` / `Q4_K_S` /
    /// `4-bit`, for image generation `Q4_0` / `4-bit`.
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

fn default_capability() -> ModelCapability {
    ModelCapability::Text
}

impl ModelInfo {
    /// Human-readable "{Format} {Quantization}" label derived from the
    /// entry's actual quantization. Mirrors the TS-side `formatLabel`
    /// in `apps/desktop/electron/modelManagement.ts` so any future
    /// Rust-side surface (logs, TUI, FFI consumer) gets the same
    /// "GGUF Q4_K_M" / "MLX 4-bit" labels the renderer shows. Avoids
    /// the trap that the bare `ModelFormat::display_label()` would
    /// fall into, where a single hardcoded quantization mislabels
    /// every non-text entry.
    pub fn display_label(&self) -> String {
        format!("{} {}", self.format.display_label(), self.quantization)
    }
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

/// GPU-only compute backends for image generation.
///
/// Stable-diffusion.cpp's CPU path on a quantized FLUX.2-klein takes
/// minutes per step on consumer hardware, so we treat image
/// generation as GPU-only — the manifest entries deliberately omit
/// [`ComputeBackend::Cpu`] and [`ComputeBackend::Rocm`] (the latter
/// because sd-server's ROCm build is not yet shipped). The detection
/// helpers [`available_models_for_capability`] and
/// [`is_capability_available`] use this list to gate the image-gen
/// slot on hosts without one of these backends.
const IMAGEGEN_GGUF_COMPUTE: [ComputeBackend; 2] = [ComputeBackend::Cuda, ComputeBackend::Vulkan];

const HF_BASE: &str = "https://huggingface.co";

fn mlx_url(slug: &str, archive: &str) -> String {
    format!("{HF_BASE}/{slug}/resolve/main/{archive}")
}

fn gguf_url(slug: &str, filename: &str) -> String {
    format!("{HF_BASE}/{slug}/resolve/main/{filename}")
}

/// Every Ternary-Bonsai variant Tessera knows about.
///
/// This is the canonical in-code registry. The packaged
/// `sidecars/models.json` manifest mirrors it; `load_model_registry`
/// prefers the manifest at runtime and falls back to this list.
///
/// ### About the `platform` field on GGUF entries
///
/// The GGUF entries in this registry hardcode
/// [`Platform::LinuxX64`] as their `platform` value. **This is a
/// placeholder, not a claim that the GGUF variant only runs on Linux.**
/// GGUF is the universal "non-Apple-Silicon" format and runs identically
/// on Linux x64, Linux arm64, Windows x64, and macOS Intel. Every
/// non-test consumer goes through [`available_models_for_platform`],
/// which **rewrites** `platform` to the caller's actual platform before
/// returning the entry. The registry simply needs *some* concrete
/// `Platform` value to satisfy the type system; `Platform::LinuxX64`
/// was chosen as the most common non-Apple target. Do not read the
/// raw registry directly outside of [`available_models_for_platform`]
/// or you will see misleading platform labels.
#[must_use]
pub fn full_model_registry() -> Vec<ModelInfo> {
    vec![
        // 1.7B
        ModelInfo {
            id: "ternary-bonsai-1.7b-mlx".into(),
            name: "Ternary-Bonsai 1.7B".into(),
            parameters: "1.7B".into(),
            capability: ModelCapability::Text,
            quantization: "2-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 2.0,
            // MLX models ship as `.tar.gz`; the post-extract directory
            // is larger than the compressed archive because the
            // already-quantized weight blobs only compress marginally
            // (~3-6%) while the metadata (config.json, tokenizer.json)
            // compresses heavily. Net expansion is ~8-12%. The
            // `diskSizeMb` here MUST be the post-extract footprint so
            // swap-planning accounting ("this swap saves X MB") is
            // correct — the user evicts the on-disk size, not the
            // compressed download size.
            download_size_mb: 248,
            disk_size_mb: 275,
            context_length: 2048,
            tier: DeviceTier::Low,
            filename: "ternary-bonsai-1.7b-2bit.mlx.tar.gz".into(),
            url: Some(mlx_url(
                "kennguy3n/Ternary-Bonsai-1.7B-MLX",
                "ternary-bonsai-1.7b-2bit.mlx.tar.gz",
            )),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-1.7b-gguf".into(),
            name: "Ternary-Bonsai 1.7B".into(),
            parameters: "1.7B".into(),
            capability: ModelCapability::Text,
            quantization: "Q1_0_g128".into(),
            format: ModelFormat::Gguf,
            // Placeholder; rewritten by available_models_for_platform.
            // GGUF runs on every non-Apple-Silicon platform. See the
            // doc-comment on full_model_registry.
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 2.0,
            download_size_mb: 450,
            disk_size_mb: 450,
            context_length: 2048,
            tier: DeviceTier::Low,
            filename: "ternary-bonsai-1.7b-q1_0_g128.gguf".into(),
            url: Some(gguf_url(
                "kennguy3n/Ternary-Bonsai-1.7B-GGUF",
                "ternary-bonsai-1.7b-q1_0_g128.gguf",
            )),
            checksum: None,
            local_path: None,
        },
        // 4B
        ModelInfo {
            id: "ternary-bonsai-4b-mlx".into(),
            name: "Ternary-Bonsai 4B".into(),
            parameters: "4B".into(),
            capability: ModelCapability::Text,
            quantization: "2-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 4.0,
            download_size_mb: 600,
            disk_size_mb: 660,
            context_length: 4096,
            tier: DeviceTier::Medium,
            filename: "ternary-bonsai-4b-2bit.mlx.tar.gz".into(),
            url: Some(mlx_url(
                "kennguy3n/Ternary-Bonsai-4B-MLX",
                "ternary-bonsai-4b-2bit.mlx.tar.gz",
            )),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-4b-gguf".into(),
            name: "Ternary-Bonsai 4B".into(),
            parameters: "4B".into(),
            capability: ModelCapability::Text,
            quantization: "Q1_0_g128".into(),
            format: ModelFormat::Gguf,
            // Placeholder; rewritten by available_models_for_platform.
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 4.0,
            download_size_mb: 1000,
            disk_size_mb: 1000,
            context_length: 4096,
            tier: DeviceTier::Medium,
            filename: "ternary-bonsai-4b-q1_0_g128.gguf".into(),
            url: Some(gguf_url(
                "kennguy3n/Ternary-Bonsai-4B-GGUF",
                "ternary-bonsai-4b-q1_0_g128.gguf",
            )),
            checksum: None,
            local_path: None,
        },
        // 8B
        ModelInfo {
            id: "ternary-bonsai-8b-mlx".into(),
            name: "Ternary-Bonsai 8B".into(),
            parameters: "8B".into(),
            capability: ModelCapability::Text,
            quantization: "2-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 8.0,
            download_size_mb: 1200,
            disk_size_mb: 1320,
            context_length: 8192,
            tier: DeviceTier::High,
            filename: "ternary-bonsai-8b-2bit.mlx.tar.gz".into(),
            url: Some(mlx_url(
                "kennguy3n/Ternary-Bonsai-8B-MLX",
                "ternary-bonsai-8b-2bit.mlx.tar.gz",
            )),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "ternary-bonsai-8b-gguf".into(),
            name: "Ternary-Bonsai 8B".into(),
            parameters: "8B".into(),
            capability: ModelCapability::Text,
            quantization: "Q1_0_g128".into(),
            format: ModelFormat::Gguf,
            // Placeholder; rewritten by available_models_for_platform.
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 8.0,
            download_size_mb: 2000,
            disk_size_mb: 2000,
            context_length: 8192,
            tier: DeviceTier::High,
            filename: "ternary-bonsai-8b-q1_0_g128.gguf".into(),
            url: Some(gguf_url(
                "kennguy3n/Ternary-Bonsai-8B-GGUF",
                "ternary-bonsai-8b-q1_0_g128.gguf",
            )),
            checksum: None,
            local_path: None,
        },
        // --- Vision (VLM) -------------------------------------------------
        // Qwen3.5-4B Vision — mid-tier VLM. Served by llama-server with
        // `--mmproj` for the multimodal projector. Q4_K_M GGUF on
        // non-Apple platforms, 4-bit MLX on Apple Silicon.
        ModelInfo {
            id: "qwen3.5-4b-vision-gguf".into(),
            name: "Qwen3.5-4B Vision".into(),
            parameters: "4B".into(),
            capability: ModelCapability::Vision,
            quantization: "Q4_K_M".into(),
            format: ModelFormat::Gguf,
            // Placeholder; rewritten by available_models_for_platform.
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 4.0,
            download_size_mb: 2500,
            disk_size_mb: 2500,
            context_length: 4096,
            tier: DeviceTier::Medium,
            filename: "Qwen3.5-4B-Revised-q4_k_m.gguf".into(),
            url: Some(gguf_url(
                "Smoffyy/Qwen3.5-4B-Instruct-Revised-GGUF",
                "Qwen3.5-4B-Revised-q4_k_m.gguf",
            )),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "qwen3.5-4b-vision-mlx".into(),
            name: "Qwen3.5-4B Vision".into(),
            parameters: "4B".into(),
            capability: ModelCapability::Vision,
            quantization: "4-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 4.0,
            download_size_mb: 2500,
            disk_size_mb: 2750,
            context_length: 4096,
            tier: DeviceTier::Medium,
            filename: "qwen3.5-4b-mlx-4bit.tar.gz".into(),
            url: Some(mlx_url(
                "mlx-community/Qwen3.5-4B-MLX-4bit",
                "qwen3.5-4b-mlx-4bit.tar.gz",
            )),
            checksum: None,
            local_path: None,
        },
        // SmolVLM 256M — low-tier VLM. Small enough to run on CPU
        // at low device tier; both GGUF and MLX variants ship.
        ModelInfo {
            id: "smolvlm-256m-vision-gguf".into(),
            name: "SmolVLM 256M Vision".into(),
            parameters: "256M".into(),
            capability: ModelCapability::Vision,
            quantization: "Q4_K_S".into(),
            format: ModelFormat::Gguf,
            // Placeholder; rewritten by available_models_for_platform.
            platform: Platform::LinuxX64,
            compute_backends: GGUF_COMPUTE.to_vec(),
            required_ram_gb: 1.0,
            download_size_mb: 150,
            disk_size_mb: 150,
            context_length: 2048,
            tier: DeviceTier::Low,
            filename: "SmolVLM2-256M-Video-Instruct.Q4_K_S.gguf".into(),
            url: Some(gguf_url(
                "mradermacher/SmolVLM2-256M-Video-Instruct-GGUF",
                "SmolVLM2-256M-Video-Instruct.Q4_K_S.gguf",
            )),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "smolvlm-256m-vision-mlx".into(),
            name: "SmolVLM 256M Vision".into(),
            parameters: "256M".into(),
            capability: ModelCapability::Vision,
            quantization: "4-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 1.0,
            download_size_mb: 150,
            disk_size_mb: 170,
            context_length: 2048,
            tier: DeviceTier::Low,
            filename: "smolvlm-256m-instruct-4bit.tar.gz".into(),
            url: Some(mlx_url(
                "mlx-community/SmolVLM-256M-Instruct-4bit",
                "smolvlm-256m-instruct-4bit.tar.gz",
            )),
            checksum: None,
            local_path: None,
        },
        // --- Image generation (FLUX.2-klein) -----------------------------
        // GPU-only — `compute_backends` deliberately excludes CPU.
        // Image generation is served by sd-server (stable-diffusion.cpp).
        ModelInfo {
            id: "flux2-klein-4b-gguf".into(),
            name: "FLUX.2-klein 4B".into(),
            parameters: "4B".into(),
            capability: ModelCapability::Imagegen,
            quantization: "Q4_0".into(),
            format: ModelFormat::Gguf,
            // Placeholder; rewritten by available_models_for_platform.
            platform: Platform::LinuxX64,
            compute_backends: IMAGEGEN_GGUF_COMPUTE.to_vec(),
            required_ram_gb: 6.0,
            download_size_mb: 2300,
            disk_size_mb: 2300,
            // Diffusion models don't have a transformer context window;
            // the manifest carries `0` to make the absence explicit.
            context_length: 0,
            tier: DeviceTier::Medium,
            filename: "flux-2-klein-4b-Q4_0.gguf".into(),
            url: Some(gguf_url(
                "leejet/FLUX.2-klein-4B-GGUF",
                "flux-2-klein-4b-Q4_0.gguf",
            )),
            checksum: None,
            local_path: None,
        },
        ModelInfo {
            id: "flux2-klein-4b-mlx".into(),
            name: "FLUX.2-klein 4B".into(),
            parameters: "4B".into(),
            capability: ModelCapability::Imagegen,
            quantization: "4-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            // Metal-only on Apple Silicon — sd-server falls back to CPU
            // when Metal is unavailable, but we surface the GPU-only
            // contract at the registry level so the UI can grey out
            // the slot rather than start a job that hangs for minutes.
            compute_backends: MLX_COMPUTE.to_vec(),
            required_ram_gb: 6.0,
            download_size_mb: 2300,
            disk_size_mb: 2530,
            context_length: 0,
            tier: DeviceTier::Medium,
            filename: "flux2-klein-4b-mlx-4bit.tar.gz".into(),
            url: Some(mlx_url(
                "themindstudio/flux2-klein-4b-mlx-4bit",
                "flux2-klein-4b-mlx-4bit.tar.gz",
            )),
            checksum: None,
            local_path: None,
        },
    ]
}

/// Variants of the registry applicable to a specific platform.
///
/// Returns every entry whose [`ModelFormat`] matches the platform's
/// preferred format (MLX on Apple Silicon, GGUF elsewhere), with the
/// `platform` field rewritten to the caller's `platform` so callers
/// can introspect which platform the runtime is targeting. The list
/// spans every capability (text, vision, imagegen) — callers that
/// want a single capability should pair this with
/// [`available_models_for_capability`].
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

/// Variants of the registry applicable to a specific platform AND
/// capability, gated by the detected compute backends.
///
/// This is the helper the renderer/UI calls to populate the model
/// dropdown for a given slot. For text and vision capabilities the
/// model entries always include `Cpu` in their `compute_backends`,
/// so the intersection-with-detected-backends gate is always
/// non-empty on any host. For `ImageGeneration` the entries
/// deliberately omit `Cpu` (see [`IMAGEGEN_GGUF_COMPUTE`] and the
/// MLX variant), so a host without a GPU returns an empty list —
/// the UI uses that to grey out the image-gen slot.
///
/// The `detected_backends` parameter is taken explicitly (rather
/// than calling [`detect_compute_backends`] internally) so unit
/// tests can exercise the gating without depending on the test
/// machine's hardware. Production callers typically pass the
/// result of [`detect_compute_backends`].
#[must_use]
pub fn available_models_for_capability(
    platform: Platform,
    capability: ModelCapability,
    detected_backends: &[ComputeBackend],
) -> Vec<ModelInfo> {
    available_models_for_platform(platform)
        .into_iter()
        .filter(|m| m.capability == capability)
        .filter(|m| {
            m.compute_backends
                .iter()
                .any(|b| detected_backends.contains(b))
        })
        .collect()
}

/// Whether the given capability is usable on a host of `tier` with
/// `detected_backends`.
///
/// - `Text` is always available.
/// - `Vision` is always available (SmolVLM 256M runs on CPU even at
///   [`DeviceTier::Low`]).
/// - `Imagegen` requires both [`DeviceTier::Medium`] or higher AND
///   at least one GPU backend (CUDA/Vulkan/Metal/ROCm). CPU-only
///   diffusion on a quantized FLUX is unusable in practice — the
///   gate prevents a model that would never produce a result from
///   appearing in the UI.
#[must_use]
pub fn is_capability_available(
    tier: DeviceTier,
    capability: ModelCapability,
    detected_backends: &[ComputeBackend],
) -> bool {
    match capability {
        ModelCapability::Text | ModelCapability::Vision => true,
        ModelCapability::Imagegen => {
            if matches!(tier, DeviceTier::Low) {
                return false;
            }
            detected_backends.iter().any(ComputeBackend::is_gpu)
        }
    }
}

/// Models available on the current platform (compile-time detected).
#[must_use]
pub fn available_models() -> Vec<ModelInfo> {
    available_models_for_platform(detect_platform())
}

/// Pick the model that matches the device tier on the given platform.
///
/// Returns the first variant in the platform's list if the requested
/// tier is not present (this never happens for the shipped registry
/// but keeps the call infallible for callers).
///
/// If the per-platform list is empty (would only happen if a new
/// [`Platform`] variant were added without a matching format entry in
/// [`full_model_registry`]), this falls back to the full registry with
/// the `platform` field rewritten, so the call remains infallible from
/// the caller's perspective. The final assertion only fires if a
/// developer empties [`full_model_registry`] entirely — that's a build
/// bug, not a runtime condition.
#[must_use]
pub fn select_model(
    tier: DeviceTier,
    platform: Platform,
    capability: ModelCapability,
) -> ModelInfo {
    let candidates: Vec<ModelInfo> = available_models_for_platform(platform)
        .into_iter()
        .filter(|m| m.capability == capability)
        .collect();
    if !candidates.is_empty() {
        return pick_or_first(candidates, tier);
    }
    // Per-(platform, capability) list was empty — every capability has
    // at least one MLX and one GGUF entry today so this only triggers
    // when a developer adds a `Platform` or `ModelCapability` variant
    // without a matching registry entry. Fall back to any registry
    // entry for the requested capability with the `platform` rewritten,
    // so the call remains infallible for the caller. The final assert
    // only fires if [`full_model_registry`] is empty entirely.
    let mut fallback: Vec<ModelInfo> = full_model_registry()
        .into_iter()
        .filter(|m| m.capability == capability)
        .map(|mut m| {
            m.platform = platform;
            m
        })
        .collect();
    assert!(
        !fallback.is_empty(),
        "full_model_registry() has no entry for capability {capability:?} — this is a build bug; the registry must include at least one variant per capability",
    );
    if let Some(idx) = fallback.iter().position(|m| m.tier == tier) {
        fallback.swap_remove(idx)
    } else {
        fallback.swap_remove(0)
    }
}

/// Pick the entry whose tier matches; otherwise return the first entry.
///
/// `models` must be non-empty; callers in this module guarantee that
/// before invoking. The panic is unreachable in practice.
fn pick_or_first(mut models: Vec<ModelInfo>, tier: DeviceTier) -> ModelInfo {
    if let Some(idx) = models.iter().position(|m| m.tier == tier) {
        models.swap_remove(idx)
    } else {
        models.swap_remove(0)
    }
}

/// Backwards-compatible wrapper that uses the current platform and
/// the text-generation capability.
///
/// Kept for the long tail of call sites that pre-date capability
/// dispatch and only ever cared about the text slot. New code should
/// call [`select_model`] directly with an explicit
/// [`ModelCapability`].
#[must_use]
pub fn select_model_for_tier(tier: DeviceTier) -> ModelInfo {
    select_model(tier, detect_platform(), ModelCapability::Text)
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
        .is_ok_and(|o| o.status.success())
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
        .is_ok_and(|o| o.status.success())
    {
        return true;
    }
    #[cfg(target_os = "linux")]
    {
        let candidates = [
            "/usr/lib/x86_64-linux-gnu/libvulkan.so.1",
            // Linux arm64 multiarch path (Debian/Ubuntu aarch64). Required
            // for first-class Linux arm64 support so headless aarch64 hosts
            // with the Vulkan loader installed but `vulkaninfo` missing are
            // still detected as Vulkan-capable.
            "/usr/lib/aarch64-linux-gnu/libvulkan.so.1",
            "/usr/lib64/libvulkan.so.1",
            "/usr/lib/libvulkan.so.1",
            "/lib/x86_64-linux-gnu/libvulkan.so.1",
            "/lib/aarch64-linux-gnu/libvulkan.so.1",
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
#[allow(clippy::case_sensitive_file_extension_comparisons)]
mod tests {
    use super::*;

    fn assert_no_q4km_for_text(m: &ModelInfo) {
        if m.capability == ModelCapability::Text {
            assert_ne!(
                m.quantization, "Q4_K_M",
                "text model {} must not use Q4_K_M quantization",
                m.id
            );
        }
    }

    /// All MLX entries shipped by [`full_model_registry`] across every
    /// capability. Used by the platform-list count assertions below —
    /// adding a new MLX entry to the registry intentionally bumps the
    /// expected count, and the failing assertion points at the gap.
    fn count_mlx_in_registry() -> usize {
        full_model_registry()
            .iter()
            .filter(|m| m.format == ModelFormat::Mlx)
            .count()
    }

    fn count_gguf_in_registry() -> usize {
        full_model_registry()
            .iter()
            .filter(|m| m.format == ModelFormat::Gguf)
            .count()
    }

    #[test]
    fn registry_contains_three_text_sizes_per_format() {
        let registry = full_model_registry();
        let mlx_text: Vec<_> = registry
            .iter()
            .filter(|m| m.format == ModelFormat::Mlx && m.capability == ModelCapability::Text)
            .collect();
        let gguf_text: Vec<_> = registry
            .iter()
            .filter(|m| m.format == ModelFormat::Gguf && m.capability == ModelCapability::Text)
            .collect();
        assert_eq!(mlx_text.len(), 3, "three Bonsai MLX text variants");
        assert_eq!(gguf_text.len(), 3, "three Bonsai GGUF text variants");
    }

    #[test]
    fn registry_contains_vision_entries_for_each_format() {
        let registry = full_model_registry();
        let mlx_vision: Vec<_> = registry
            .iter()
            .filter(|m| m.format == ModelFormat::Mlx && m.capability == ModelCapability::Vision)
            .collect();
        let gguf_vision: Vec<_> = registry
            .iter()
            .filter(|m| m.format == ModelFormat::Gguf && m.capability == ModelCapability::Vision)
            .collect();
        // One low-tier (SmolVLM 256M) + one mid-tier (Qwen3.5-4B-VL)
        // per format.
        assert_eq!(mlx_vision.len(), 2, "two MLX vision variants");
        assert_eq!(gguf_vision.len(), 2, "two GGUF vision variants");
    }

    #[test]
    fn registry_contains_imagegen_entry_for_each_format() {
        let registry = full_model_registry();
        let mlx_imagegen: Vec<_> = registry
            .iter()
            .filter(|m| m.format == ModelFormat::Mlx && m.capability == ModelCapability::Imagegen)
            .collect();
        let gguf_imagegen: Vec<_> = registry
            .iter()
            .filter(|m| m.format == ModelFormat::Gguf && m.capability == ModelCapability::Imagegen)
            .collect();
        // Single FLUX.2-klein 4B variant per format.
        assert_eq!(mlx_imagegen.len(), 1, "one MLX imagegen variant");
        assert_eq!(gguf_imagegen.len(), 1, "one GGUF imagegen variant");
    }

    #[test]
    fn text_models_do_not_use_q4km() {
        // Ternary-Bonsai is the canonical text family; it ships at
        // 1.58-bit (Q1_0_g128 for GGUF, 2-bit for MLX). A Q4_K_M
        // value would mean someone wired a non-Bonsai text model
        // into the registry by accident and inflated the download
        // sizes 4×. Vision/imagegen entries DO use Q4_K_M / Q4_0 /
        // 4-bit — that's correct and intentional.
        for m in full_model_registry() {
            assert_no_q4km_for_text(&m);
            if m.capability == ModelCapability::Text {
                assert!(
                    m.quantization == "Q1_0_g128" || m.quantization == "2-bit",
                    "unexpected text quantization {} on {}",
                    m.quantization,
                    m.id
                );
            }
        }
    }

    #[test]
    fn vision_models_use_expected_quantization() {
        for m in full_model_registry() {
            if m.capability != ModelCapability::Vision {
                continue;
            }
            match m.format {
                ModelFormat::Gguf => assert!(
                    m.quantization == "Q4_K_M" || m.quantization == "Q4_K_S",
                    "vision GGUF entry {} has unexpected quantization {}",
                    m.id,
                    m.quantization
                ),
                ModelFormat::Mlx => assert_eq!(
                    m.quantization, "4-bit",
                    "vision MLX entry {} must use 4-bit",
                    m.id
                ),
            }
        }
    }

    #[test]
    fn imagegen_models_use_expected_quantization() {
        for m in full_model_registry() {
            if m.capability != ModelCapability::Imagegen {
                continue;
            }
            match m.format {
                ModelFormat::Gguf => assert_eq!(
                    m.quantization, "Q4_0",
                    "imagegen GGUF entry {} must use Q4_0",
                    m.id
                ),
                ModelFormat::Mlx => assert_eq!(
                    m.quantization, "4-bit",
                    "imagegen MLX entry {} must use 4-bit",
                    m.id
                ),
            }
        }
    }

    #[test]
    fn imagegen_models_exclude_cpu_backend() {
        // CRITICAL invariant: image generation entries must NEVER
        // include `Cpu` in their compute_backends. The renderer's UI
        // gate keys off the compute-backends intersection to grey
        // out the slot on CPU-only hosts, and a leaked CPU backend
        // would re-enable a job that takes minutes per diffusion
        // step. The corresponding TS-side guard lives in
        // `apps/desktop/electron/modelManagement.ts`.
        for m in full_model_registry() {
            if m.capability != ModelCapability::Imagegen {
                continue;
            }
            assert!(
                !m.compute_backends.contains(&ComputeBackend::Cpu),
                "imagegen entry {} must NOT list Cpu as a compute backend; \
                 see IMAGEGEN_GGUF_COMPUTE and the FLUX MLX variant",
                m.id
            );
            // Plus at least one GPU backend must be listed (otherwise
            // there's no host that can run it).
            assert!(
                m.compute_backends.iter().any(ComputeBackend::is_gpu),
                "imagegen entry {} must list at least one GPU backend",
                m.id
            );
        }
    }

    #[test]
    fn imagegen_context_length_is_zero() {
        // Diffusion models don't have a transformer context window
        // and the manifest carries `0` to make that explicit. A
        // non-zero value would imply we'd accidentally pasted a
        // text-model context into an imagegen entry.
        for m in full_model_registry() {
            if m.capability != ModelCapability::Imagegen {
                continue;
            }
            assert_eq!(
                m.context_length, 0,
                "imagegen entry {} must declare context_length=0 \
                 (diffusion models have no transformer context)",
                m.id
            );
        }
    }

    #[test]
    fn apple_silicon_returns_only_mlx() {
        let models = available_models_for_platform(Platform::MacosAppleSilicon);
        assert_eq!(models.len(), count_mlx_in_registry());
        for m in &models {
            assert_eq!(m.format, ModelFormat::Mlx);
            assert_eq!(m.platform, Platform::MacosAppleSilicon);
            assert_eq!(m.compute_backends, vec![ComputeBackend::Metal]);
            // MLX entries ship as tar.gz archives. Bonsai uses the
            // `.mlx.tar.gz` double-extension; upstream community
            // archives (Qwen3.5/SmolVLM/FLUX) use plain `.tar.gz`.
            // Both are valid — the contract is "archive, not a single
            // raw weight file".
            assert!(
                m.filename.ends_with(".tar.gz") || m.filename.ends_with(".tgz"),
                "MLX entry {} has filename {} - expected archive",
                m.id,
                m.filename
            );
        }
    }

    #[test]
    fn windows_returns_only_gguf() {
        let models = available_models_for_platform(Platform::WindowsX64);
        assert_eq!(models.len(), count_gguf_in_registry());
        for m in &models {
            assert_eq!(m.format, ModelFormat::Gguf);
            assert_eq!(m.platform, Platform::WindowsX64);
            assert!(m.filename.ends_with(".gguf"));
            // Text/vision GGUF entries include CPU; imagegen GGUF
            // entries deliberately exclude CPU. The mixed shape is
            // the whole point of imagegen-on-GPU gating, so the
            // per-platform list is allowed to contain both.
        }
    }

    #[test]
    fn linux_returns_only_gguf() {
        let models = available_models_for_platform(Platform::LinuxX64);
        assert_eq!(models.len(), count_gguf_in_registry());
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
        let m = select_model(
            DeviceTier::High,
            Platform::MacosAppleSilicon,
            ModelCapability::Text,
        );
        assert_eq!(m.parameters, "8B");
        assert_eq!(m.format, ModelFormat::Mlx);
        assert_eq!(m.capability, ModelCapability::Text);
        assert!((1100..=1300).contains(&m.download_size_mb));
    }

    #[test]
    fn select_model_high_windows() {
        let m = select_model(
            DeviceTier::High,
            Platform::WindowsX64,
            ModelCapability::Text,
        );
        assert_eq!(m.parameters, "8B");
        assert_eq!(m.format, ModelFormat::Gguf);
        assert!((1800..=2200).contains(&m.download_size_mb));
        assert_eq!(m.quantization, "Q1_0_g128");
    }

    #[test]
    fn select_model_medium_linux() {
        let m = select_model(
            DeviceTier::Medium,
            Platform::LinuxX64,
            ModelCapability::Text,
        );
        assert_eq!(m.parameters, "4B");
        assert!((900..=1100).contains(&m.download_size_mb));
    }

    #[test]
    fn select_model_low_apple_silicon_size_reasonable() {
        let m = select_model(
            DeviceTier::Low,
            Platform::MacosAppleSilicon,
            ModelCapability::Text,
        );
        // 1.58-bit MLX, must NOT be Q4_K_M-inflated (~1.1 GB).
        assert!(m.download_size_mb < 400);
        assert_eq!(m.format, ModelFormat::Mlx);
    }

    #[test]
    fn select_model_low_windows_size_reasonable() {
        let m = select_model(DeviceTier::Low, Platform::WindowsX64, ModelCapability::Text);
        // 1.58-bit GGUF, must NOT be Q4_K_M-inflated (~1.1 GB).
        assert!(m.download_size_mb < 600);
        assert_eq!(m.format, ModelFormat::Gguf);
    }

    #[test]
    fn select_model_vision_apple_silicon_returns_mlx_vision_entry() {
        let m = select_model(
            DeviceTier::Medium,
            Platform::MacosAppleSilicon,
            ModelCapability::Vision,
        );
        assert_eq!(m.capability, ModelCapability::Vision);
        assert_eq!(m.format, ModelFormat::Mlx);
        // Medium tier maps to Qwen3.5-4B.
        assert_eq!(m.parameters, "4B");
    }

    #[test]
    fn select_model_imagegen_linux_returns_gguf_imagegen_entry() {
        let m = select_model(
            DeviceTier::Medium,
            Platform::LinuxX64,
            ModelCapability::Imagegen,
        );
        assert_eq!(m.capability, ModelCapability::Imagegen);
        assert_eq!(m.format, ModelFormat::Gguf);
        assert!(!m.compute_backends.contains(&ComputeBackend::Cpu));
        assert!(m.compute_backends.iter().any(ComputeBackend::is_gpu));
    }

    #[test]
    fn mlx_disk_size_exceeds_download_size_for_archives() {
        // MLX models ship as `.tar.gz` archives, so the on-disk extracted
        // footprint is necessarily larger than the compressed download.
        // Before the fix the Rust hardcoded fallback registry had
        // `disk_size_mb == download_size_mb` for every MLX entry, which
        // made the swap planner under-account for disk usage on the Rust
        // side of the bridge (the renderer-side TypeScript registry had
        // the same bug, fixed in sidecars/models.json). The invariant we
        // lock in: for every `.tar.gz`/`.tgz` MLX entry, disk_size_mb >
        // download_size_mb; for non-archive formats, disk_size_mb >=
        // download_size_mb.
        for m in full_model_registry() {
            let is_archive = m.filename.ends_with(".tar.gz") || m.filename.ends_with(".tgz");
            if m.format == ModelFormat::Mlx && is_archive {
                assert!(
                    m.disk_size_mb > m.download_size_mb,
                    "MLX archive entry {} has disk_size_mb={} <= download_size_mb={} \
                     — archives MUST report the post-extract footprint as disk size",
                    m.id,
                    m.disk_size_mb,
                    m.download_size_mb,
                );
                // Expansion ratio bound: gzip on already-quantized
                // weights + small metadata is empirically ~3-15%.
                // Anything above ~30% likely indicates unit confusion.
                let upper = (m.download_size_mb as f64 * 1.3).ceil() as u64;
                assert!(
                    m.disk_size_mb <= upper,
                    "MLX archive entry {} reports disk_size_mb={} > 1.3x download_size_mb={} \
                     — suspicious expansion ratio, double-check units",
                    m.id,
                    m.disk_size_mb,
                    m.download_size_mb,
                );
            } else {
                assert!(
                    m.disk_size_mb >= m.download_size_mb,
                    "Non-archive entry {} has disk_size_mb={} < download_size_mb={} \
                     — single-file installs should have equal sizes",
                    m.id,
                    m.disk_size_mb,
                    m.download_size_mb,
                );
            }
        }
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
        assert_eq!(
            Platform::MacosAppleSilicon.preferred_format(),
            ModelFormat::Mlx
        );
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
        // Existing call sites use the platform-less helper, which
        // defaults to the text capability.
        let m = select_model_for_tier(DeviceTier::Low);
        assert_eq!(m.context_length, 2048);
        assert_eq!(m.capability, ModelCapability::Text);
        assert_no_q4km_for_text(&m);
    }

    #[test]
    fn select_model_medium_tier_back_compat() {
        let m = select_model_for_tier(DeviceTier::Medium);
        assert_eq!(m.context_length, 4096);
        assert_eq!(m.capability, ModelCapability::Text);
        assert_no_q4km_for_text(&m);
    }

    #[test]
    fn select_model_high_tier_back_compat() {
        let m = select_model_for_tier(DeviceTier::High);
        assert_eq!(m.context_length, 8192);
        assert_eq!(m.capability, ModelCapability::Text);
        assert_no_q4km_for_text(&m);
    }

    // --- ModelCapability helpers -------------------------------------

    #[test]
    fn capability_serialization_is_lowercase() {
        // The serde wire format must match the TypeScript enum strings
        // (`"text" | "vision" | "imagegen"`). A casing change here
        // would silently break the renderer's manifest deserialization.
        let cases = [
            (ModelCapability::Text, "\"text\""),
            (ModelCapability::Vision, "\"vision\""),
            (ModelCapability::Imagegen, "\"imagegen\""),
        ];
        for (cap, expected) in cases {
            assert_eq!(serde_json::to_string(&cap).unwrap(), expected);
            let parsed: ModelCapability = serde_json::from_str(expected).unwrap();
            assert_eq!(parsed, cap);
        }
    }

    #[test]
    fn capability_as_str_matches_serde() {
        for c in ModelCapability::all() {
            let serde = serde_json::to_string(&c).unwrap();
            // Strip surrounding quotes.
            let stripped = serde.trim_matches('"');
            assert_eq!(
                stripped,
                c.as_str(),
                "ModelCapability::as_str() must match the serde wire format"
            );
        }
    }

    #[test]
    fn capability_all_is_stable_and_complete() {
        // The Settings UI iterates `ModelCapability::all()` to render
        // its three sections in a fixed order. The test locks the
        // ordering in so a future addition to the enum doesn't
        // silently reshuffle the UI.
        assert_eq!(
            ModelCapability::all(),
            [
                ModelCapability::Text,
                ModelCapability::Vision,
                ModelCapability::Imagegen
            ]
        );
    }

    // --- available_models_for_capability gating ---------------------

    #[test]
    fn available_models_for_capability_text_returns_text_only() {
        // Apple Silicon MLX models dispatch to Metal; non-Apple GGUF
        // models dispatch to CPU/CUDA/Vulkan/ROCm. Pass the host's
        // matching backend so the compute-backend intersection is
        // non-empty.
        let cases: [(Platform, &[ComputeBackend]); 2] = [
            (Platform::MacosAppleSilicon, &[ComputeBackend::Metal]),
            (Platform::LinuxX64, &[ComputeBackend::Cpu]),
        ];
        for (platform, backends) in cases {
            let models = available_models_for_capability(platform, ModelCapability::Text, backends);
            assert!(
                !models.is_empty(),
                "text capability must always have at least one model on {platform:?}"
            );
            for m in models {
                assert_eq!(m.capability, ModelCapability::Text);
                assert_eq!(m.platform, platform);
            }
        }
    }

    #[test]
    fn available_models_for_capability_vision_returns_vision_only() {
        // Vision works on CPU at low tier (SmolVLM 256M) for GGUF
        // platforms; on Apple Silicon vision MLX entries dispatch to
        // Metal.
        let cases: [(Platform, &[ComputeBackend]); 2] = [
            (Platform::MacosAppleSilicon, &[ComputeBackend::Metal]),
            (Platform::LinuxX64, &[ComputeBackend::Cpu]),
        ];
        for (platform, backends) in cases {
            let models =
                available_models_for_capability(platform, ModelCapability::Vision, backends);
            assert!(
                !models.is_empty(),
                "vision capability must always have at least one model on {platform:?}"
            );
            for m in models {
                assert_eq!(m.capability, ModelCapability::Vision);
                assert_eq!(m.platform, platform);
            }
        }
    }

    #[test]
    fn available_models_for_capability_imagegen_empty_on_cpu_only() {
        // CPU-only Linux box — imagegen entries deliberately exclude
        // CPU, so the intersection must be empty. The renderer keys
        // off this to grey out the slot.
        for platform in [
            Platform::LinuxX64,
            Platform::WindowsX64,
            Platform::MacosIntel,
        ] {
            let models = available_models_for_capability(
                platform,
                ModelCapability::Imagegen,
                &[ComputeBackend::Cpu],
            );
            assert!(
                models.is_empty(),
                "imagegen on CPU-only {platform:?} must be empty (got {} entries)",
                models.len(),
            );
        }
    }

    #[test]
    fn available_models_for_capability_imagegen_present_on_cuda_linux() {
        let models = available_models_for_capability(
            Platform::LinuxX64,
            ModelCapability::Imagegen,
            &[ComputeBackend::Cpu, ComputeBackend::Cuda],
        );
        assert_eq!(models.len(), 1, "expected the FLUX GGUF entry");
        assert_eq!(models[0].capability, ModelCapability::Imagegen);
        assert!(models[0].compute_backends.contains(&ComputeBackend::Cuda));
    }

    #[test]
    fn available_models_for_capability_imagegen_present_on_metal_apple() {
        let models = available_models_for_capability(
            Platform::MacosAppleSilicon,
            ModelCapability::Imagegen,
            &[ComputeBackend::Metal],
        );
        assert_eq!(models.len(), 1, "expected the FLUX MLX entry");
        assert_eq!(models[0].format, ModelFormat::Mlx);
        assert_eq!(models[0].capability, ModelCapability::Imagegen);
    }

    // --- is_capability_available tier × backend gating -------------

    #[test]
    fn is_capability_available_text_always_true() {
        for tier in [DeviceTier::Low, DeviceTier::Medium, DeviceTier::High] {
            for backends in [
                vec![ComputeBackend::Cpu],
                vec![ComputeBackend::Cpu, ComputeBackend::Cuda],
                vec![ComputeBackend::Metal],
                vec![],
            ] {
                assert!(
                    is_capability_available(tier, ModelCapability::Text, &backends),
                    "text must be available for tier={tier:?} backends={backends:?}",
                );
            }
        }
    }

    #[test]
    fn is_capability_available_vision_always_true() {
        // Vision works on every tier because SmolVLM 256M runs on CPU.
        for tier in [DeviceTier::Low, DeviceTier::Medium, DeviceTier::High] {
            for backends in [vec![ComputeBackend::Cpu], vec![ComputeBackend::Metal]] {
                assert!(
                    is_capability_available(tier, ModelCapability::Vision, &backends),
                    "vision must be available for tier={tier:?} backends={backends:?}",
                );
            }
        }
    }

    #[test]
    fn is_capability_available_imagegen_low_tier_blocked() {
        // Low tier × any-backend — imagegen is unavailable even with
        // a GPU present because the device tier signals RAM headroom
        // is insufficient.
        for backends in [
            vec![ComputeBackend::Cpu],
            vec![ComputeBackend::Cuda],
            vec![ComputeBackend::Metal],
            vec![ComputeBackend::Cpu, ComputeBackend::Vulkan],
        ] {
            assert!(
                !is_capability_available(DeviceTier::Low, ModelCapability::Imagegen, &backends),
                "imagegen must be unavailable at low tier even with backends={backends:?}"
            );
        }
    }

    #[test]
    fn is_capability_available_imagegen_cpu_only_blocked() {
        for tier in [DeviceTier::Medium, DeviceTier::High] {
            assert!(
                !is_capability_available(tier, ModelCapability::Imagegen, &[ComputeBackend::Cpu]),
                "imagegen on CPU-only {tier:?} must be blocked"
            );
        }
    }

    #[test]
    fn is_capability_available_imagegen_gpu_medium_or_high_allowed() {
        for tier in [DeviceTier::Medium, DeviceTier::High] {
            for backend in [
                ComputeBackend::Cuda,
                ComputeBackend::Vulkan,
                ComputeBackend::Metal,
                ComputeBackend::Rocm,
            ] {
                assert!(
                    is_capability_available(
                        tier,
                        ModelCapability::Imagegen,
                        &[ComputeBackend::Cpu, backend]
                    ),
                    "imagegen must be available at {tier:?} with GPU backend {backend:?}"
                );
            }
        }
    }

    #[test]
    fn compute_backend_is_gpu_classifies_correctly() {
        assert!(!ComputeBackend::Cpu.is_gpu());
        assert!(ComputeBackend::Cuda.is_gpu());
        assert!(ComputeBackend::Vulkan.is_gpu());
        assert!(ComputeBackend::Metal.is_gpu());
        assert!(ComputeBackend::Rocm.is_gpu());
    }

    #[test]
    fn pick_or_first_falls_back_when_tier_missing() {
        // Two-entry vec missing the requested High tier; should return
        // the first entry rather than panic.
        let mut models = full_model_registry();
        models.retain(|m| m.tier != DeviceTier::High);
        assert!(!models.is_empty());
        let m = pick_or_first(models, DeviceTier::High);
        // Any tier is acceptable; the contract is just "non-panicking".
        assert!(matches!(
            m.tier,
            DeviceTier::Low | DeviceTier::Medium | DeviceTier::High
        ));
    }

    #[test]
    fn pick_or_first_returns_matching_tier() {
        let models = full_model_registry();
        let m = pick_or_first(models, DeviceTier::Medium);
        assert_eq!(m.tier, DeviceTier::Medium);
    }

    #[test]
    fn full_model_registry_is_non_empty() {
        // Invariant select_model relies on for its defensive fallback.
        assert!(!full_model_registry().is_empty());
    }

    #[test]
    fn available_models_non_empty_for_every_platform() {
        // Invariant select_model relies on to avoid the defensive
        // fallback. If a Platform variant is added without a matching
        // format in the registry, this fails and points at the gap.
        for p in [
            Platform::MacosAppleSilicon,
            Platform::MacosIntel,
            Platform::WindowsX64,
            Platform::LinuxX64,
            Platform::LinuxArm64,
        ] {
            assert!(
                !available_models_for_platform(p).is_empty(),
                "available_models_for_platform({p:?}) returned an empty list; \
                 add a registry entry whose format matches {p:?}.preferred_format()",
            );
        }
    }

    #[test]
    fn default_config() {
        let config = RuntimeConfig::default();
        assert_eq!(config.port, 8384);
        assert_eq!(config.host, "127.0.0.1");
    }

    #[test]
    fn model_format_labels() {
        // `ModelFormat::display_label` is now just the format name; the
        // quantization is per-entry and lives on `ModelInfo`.
        assert_eq!(ModelFormat::Gguf.display_label(), "GGUF");
        assert_eq!(ModelFormat::Mlx.display_label(), "MLX");
    }

    #[test]
    fn model_info_display_label_uses_per_entry_quantization() {
        // Pick one text, one vision, one imagegen entry from the
        // registry and confirm each labels itself with ITS quantization
        // (not a hardcoded text one). This is the regression guard for
        // the pre-Block-A "GGUF Q1_0_g128" trap.
        let reg = full_model_registry();
        let bonsai_gguf = reg
            .iter()
            .find(|m| m.id == "ternary-bonsai-1.7b-gguf")
            .expect("registry must contain ternary-bonsai-1.7b-gguf");
        assert_eq!(bonsai_gguf.display_label(), "GGUF Q1_0_g128");

        let qwen_vision_gguf = reg
            .iter()
            .find(|m| m.id == "qwen3.5-4b-vision-gguf")
            .expect("registry must contain qwen3.5-4b-vision-gguf");
        assert_eq!(qwen_vision_gguf.display_label(), "GGUF Q4_K_M");

        let smolvlm_vision_mlx = reg
            .iter()
            .find(|m| m.id == "smolvlm-256m-vision-mlx")
            .expect("registry must contain smolvlm-256m-vision-mlx");
        assert_eq!(smolvlm_vision_mlx.display_label(), "MLX 4-bit");

        let flux_imagegen_gguf = reg
            .iter()
            .find(|m| m.id == "flux2-klein-4b-gguf")
            .expect("registry must contain flux2-klein-4b-gguf");
        assert_eq!(flux_imagegen_gguf.display_label(), "GGUF Q4_0");
    }

    // ---------------------------------------------------------------
    // Manifest ↔ hardcoded registry cross-check
    // `sidecars/models.json` is the single source of truth used by the
    // Electron download path (it carries the HuggingFace URLs and the
    // expected SHA-256 checksums). The Rust `full_model_registry()`
    // duplicates the same metadata so the Rust runtime can answer
    // "what's the best model for this device tier?" without parsing
    // JSON at every startup AND can fall back gracefully if the
    // manifest is ever missing on disk.
    // The risk is silent drift: a future bump to a model size in the
    // manifest (because we re-quantized, retrained, or HF mirror
    // returned a different file) could leave the Rust copy stale.
    // The swap-planner uses `disk_size_mb` to tell the user "swapping
    // saves X MB / costs X MB", so drift here directly mis-informs
    // the user.
    // This test loads the manifest at test time and asserts that
    // every field shared between the two representations matches
    // EXACTLY (no tolerance — these are bytes-on-disk numbers, not
    // measurements; if they don't match one of them is wrong). When
    // it fires the failure message names the model id and the
    // diverging field so the fix is mechanical.
    // ---------------------------------------------------------------

    #[derive(serde::Deserialize)]
    struct ManifestRoot {
        models: Vec<ManifestModel>,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ManifestModel {
        id: String,
        name: String,
        parameters: String,
        format: String,
        quantization: String,
        // `capability` is optional during the manifest roll-out so a
        // pre-capability manifest copy doesn't panic; once the field is
        // required everywhere (Block A is fully landed) this becomes
        // mandatory. Default `"text"` matches the Rust-side serde
        // default on [`ModelInfo::capability`] for the same reason.
        #[serde(default = "default_manifest_capability")]
        capability: String,
        platform: String,
        compute: Vec<String>,
        tier: String,
        download_size_mb: u64,
        disk_size_mb: u64,
        required_ram_gb: f64,
        context_length: u32,
        filename: String,
        url: Option<String>,
    }

    fn default_manifest_capability() -> String {
        "text".to_string()
    }

    fn load_manifest() -> ManifestRoot {
        // CARGO_MANIFEST_DIR points at crates/tessera_runtime/.
        // Manifest lives at <workspace_root>/sidecars/models.json.
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/models.json");
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| {
            panic!(
                "failed to read manifest at {}: {e}. \
                 This test must run from the workspace; \
                 it cross-checks sidecars/models.json against \
                 full_model_registry().",
                path.display()
            )
        });
        serde_json::from_str(&raw)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
    }

    fn tier_from_str(s: &str, model_id: &str) -> DeviceTier {
        match s {
            "low" => DeviceTier::Low,
            "medium" => DeviceTier::Medium,
            "high" => DeviceTier::High,
            other => panic!("manifest model {model_id} has unknown tier {other}"),
        }
    }

    fn format_from_str(s: &str, model_id: &str) -> ModelFormat {
        match s {
            "gguf" => ModelFormat::Gguf,
            "mlx" => ModelFormat::Mlx,
            other => panic!("manifest model {model_id} has unknown format {other}"),
        }
    }

    fn backend_from_str(s: &str, model_id: &str) -> ComputeBackend {
        match s {
            "cpu" => ComputeBackend::Cpu,
            "cuda" => ComputeBackend::Cuda,
            "vulkan" => ComputeBackend::Vulkan,
            "metal" => ComputeBackend::Metal,
            "rocm" => ComputeBackend::Rocm,
            other => panic!("manifest model {model_id} has unknown compute backend {other}"),
        }
    }

    fn capability_from_str(s: &str, model_id: &str) -> ModelCapability {
        match s {
            "text" => ModelCapability::Text,
            "vision" => ModelCapability::Vision,
            "imagegen" => ModelCapability::Imagegen,
            other => panic!("manifest model {model_id} has unknown capability {other}"),
        }
    }

    #[test]
    fn manifest_matches_full_registry_exactly() {
        let manifest = load_manifest();
        let registry = full_model_registry();

        // Same set of model ids.
        let manifest_ids: std::collections::BTreeSet<&str> =
            manifest.models.iter().map(|m| m.id.as_str()).collect();
        let registry_ids: std::collections::BTreeSet<&str> =
            registry.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            manifest_ids, registry_ids,
            "manifest and full_model_registry() must list the same model ids; \
             update sidecars/models.json AND crates/tessera_runtime/src/config.rs \
             together when adding or removing a variant"
        );

        // Each model id has identical metadata in both places.
        for mm in &manifest.models {
            let rm = registry
                .iter()
                .find(|r| r.id == mm.id)
                .unwrap_or_else(|| panic!("registry missing manifest entry {}", mm.id));

            assert_eq!(rm.name, mm.name, "{}: name", mm.id);
            assert_eq!(rm.parameters, mm.parameters, "{}: parameters", mm.id);
            assert_eq!(rm.quantization, mm.quantization, "{}: quantization", mm.id);
            assert_eq!(
                rm.format,
                format_from_str(&mm.format, &mm.id),
                "{}: format",
                mm.id
            );
            assert_eq!(
                rm.capability,
                capability_from_str(&mm.capability, &mm.id),
                "{}: capability registry={:?} manifest={:?} — update both \
                 (manifest at sidecars/models.json and registry at \
                 crates/tessera_runtime/src/config.rs::full_model_registry)",
                mm.id,
                rm.capability,
                mm.capability
            );
            assert_eq!(rm.tier, tier_from_str(&mm.tier, &mm.id), "{}: tier", mm.id);
            assert_eq!(
                rm.context_length, mm.context_length,
                "{}: context_length",
                mm.id
            );
            assert_eq!(rm.filename, mm.filename, "{}: filename", mm.id);

            // f64 ram in manifest, f64 in registry — exact equality is
            // fine because both come from human-authored small
            // decimals (2.0, 4.0, 8.0) with no arithmetic.
            assert!(
                (rm.required_ram_gb - mm.required_ram_gb).abs() < f64::EPSILON,
                "{}: required_ram_gb registry={} manifest={}",
                mm.id,
                rm.required_ram_gb,
                mm.required_ram_gb,
            );

            // The critical pair: swap planner uses these to compute
            // "this swap saves X MB". They MUST match exactly.
            assert_eq!(
                rm.download_size_mb, mm.download_size_mb,
                "{}: download_size_mb registry={} manifest={} — update both \
                 (manifest at sidecars/models.json and registry at \
                 crates/tessera_runtime/src/config.rs::full_model_registry)",
                mm.id, rm.download_size_mb, mm.download_size_mb,
            );
            assert_eq!(
                rm.disk_size_mb, mm.disk_size_mb,
                "{}: disk_size_mb registry={} manifest={} — for MLX \
                 archives this is the POST-EXTRACT footprint; the swap \
                 planner uses it to size on-disk eviction. Update both \
                 places together",
                mm.id, rm.disk_size_mb, mm.disk_size_mb,
            );

            // Compute backends: order-independent compare. Manifest
            // lists them lowercase strings, registry uses the enum.
            let expected: Vec<ComputeBackend> = mm
                .compute
                .iter()
                .map(|s| backend_from_str(s, &mm.id))
                .collect();
            let mut want: Vec<ComputeBackend> = expected;
            let mut got: Vec<ComputeBackend> = rm.compute_backends.clone();
            want.sort_by_key(ComputeBackend::as_str);
            got.sort_by_key(ComputeBackend::as_str);
            assert_eq!(got, want, "{}: compute_backends", mm.id);

            // URL must be present in both and match. The manifest is
            // the source of truth for the actual HuggingFace download
            // URL; if these drift the runtime would compute a
            // different URL than the manifest the downloader follows.
            let manifest_url = mm
                .url
                .as_deref()
                .unwrap_or_else(|| panic!("manifest model {} missing url", mm.id));
            let registry_url = rm
                .url
                .as_deref()
                .unwrap_or_else(|| panic!("registry model {} missing url", mm.id));
            assert_eq!(
                registry_url, manifest_url,
                "{}: url mismatch — registry={} manifest={}",
                mm.id, registry_url, manifest_url,
            );

            // Platform consistency: MLX variants in the manifest are
            // declared `macos-apple-silicon`; in the registry MLX is
            // hardcoded to MacosAppleSilicon. GGUF variants in the
            // manifest are declared `any-non-apple-silicon` (because
            // the same file runs on Windows, Linux, macOS Intel —
            // available_models_for_platform rewrites the platform
            // field per platform).
            match mm.format.as_str() {
                "mlx" => {
                    assert_eq!(
                        mm.platform, "macos-apple-silicon",
                        "{}: MLX manifest entries must declare platform=macos-apple-silicon",
                        mm.id
                    );
                    assert_eq!(
                        rm.platform,
                        Platform::MacosAppleSilicon,
                        "{}: MLX registry entries must use Platform::MacosAppleSilicon",
                        mm.id
                    );
                }
                "gguf" => {
                    assert_eq!(
                        mm.platform, "any-non-apple-silicon",
                        "{}: GGUF manifest entries must declare platform=any-non-apple-silicon",
                        mm.id
                    );
                    // Registry GGUF entries carry a placeholder
                    // Platform that's rewritten by
                    // available_models_for_platform; just assert it's
                    // not MacosAppleSilicon.
                    assert_ne!(
                        rm.platform,
                        Platform::MacosAppleSilicon,
                        "{}: GGUF registry entries must NOT declare \
                         Platform::MacosAppleSilicon",
                        mm.id
                    );
                }
                _ => unreachable!("validated above"),
            }
        }
    }
}
