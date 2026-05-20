//! Model manifest loading and download planning.
//!
//! At runtime Tessera prefers the `sidecars/models.json` manifest
//! shipped alongside the app (or downloaded from CDN later) so the
//! list of models, URLs, and checksums can change without a code
//! release. The hardcoded [`crate::config::full_model_registry`] is
//! the fallback when the manifest is missing or unparseable.
//!
//! Single-model enforcement is encoded as a [`DownloadPlan`]: callers
//! ask `plan_download(...)` what to do given the model that's
//! currently on disk and the model the user wants to install, and
//! the planner returns either `DirectDownload` (nothing on disk),
//! `AlreadyInstalled` (same model already installed), or
//! `Swap { evict, install }` (delete then download).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::config::{
    available_models_for_platform, full_model_registry, ComputeBackend, DeviceTier, ModelFormat,
    ModelInfo, Platform,
};

#[derive(thiserror::Error, Debug)]
pub enum ManifestError {
    #[error("IO error reading manifest: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Unknown platform in manifest: {0}")]
    UnknownPlatform(String),
    #[error("Unknown format in manifest: {0}")]
    UnknownFormat(String),
    #[error("Unknown tier in manifest: {0}")]
    UnknownTier(String),
    #[error("Unknown compute backend in manifest: {0}")]
    UnknownCompute(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestModel {
    pub id: String,
    pub name: String,
    pub parameters: String,
    pub format: String,
    pub quantization: String,
    pub platform: String,
    pub compute: Vec<String>,
    pub tier: String,
    #[serde(rename = "downloadSizeMb")]
    pub download_size_mb: u64,
    #[serde(rename = "diskSizeMb")]
    pub disk_size_mb: u64,
    #[serde(rename = "requiredRamGb")]
    pub required_ram_gb: f64,
    #[serde(rename = "contextLength")]
    pub context_length: u32,
    pub filename: String,
    pub url: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestLlamaServerVariant {
    pub platform: String,
    pub compute: String,
    pub url: String,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestLlamaServer {
    pub version: String,
    #[serde(default)]
    pub note: Option<String>,
    pub variants: Vec<ManifestLlamaServerVariant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelManifest {
    pub format_version: u32,
    #[serde(default)]
    pub note: Option<String>,
    pub models: Vec<ManifestModel>,
    pub llama_server: Option<ManifestLlamaServer>,
}

fn parse_format(s: &str) -> Result<ModelFormat, ManifestError> {
    match s {
        "gguf" => Ok(ModelFormat::Gguf),
        "mlx" => Ok(ModelFormat::Mlx),
        other => Err(ManifestError::UnknownFormat(other.into())),
    }
}

fn parse_tier(s: &str) -> Result<DeviceTier, ManifestError> {
    match s {
        "low" => Ok(DeviceTier::Low),
        "medium" => Ok(DeviceTier::Medium),
        "high" => Ok(DeviceTier::High),
        other => Err(ManifestError::UnknownTier(other.into())),
    }
}

fn parse_compute(s: &str) -> Result<ComputeBackend, ManifestError> {
    match s {
        "cpu" => Ok(ComputeBackend::Cpu),
        "cuda" => Ok(ComputeBackend::Cuda),
        "vulkan" => Ok(ComputeBackend::Vulkan),
        "metal" => Ok(ComputeBackend::Metal),
        "rocm" => Ok(ComputeBackend::Rocm),
        other => Err(ManifestError::UnknownCompute(other.into())),
    }
}

/// Parse a manifest platform string.
///
/// The manifest uses the wildcard `"any-non-apple-silicon"` for GGUF
/// variants; callers resolve that to a concrete platform via the
/// `target` parameter.
fn parse_platform(s: &str, target: Platform) -> Result<Platform, ManifestError> {
    match s {
        "macos-apple-silicon" => Ok(Platform::MacosAppleSilicon),
        "macos-intel" => Ok(Platform::MacosIntel),
        "windows-x64" => Ok(Platform::WindowsX64),
        "linux-x64" => Ok(Platform::LinuxX64),
        "linux-arm64" => Ok(Platform::LinuxArm64),
        "any-non-apple-silicon" => match target {
            Platform::MacosAppleSilicon => Err(ManifestError::UnknownPlatform(s.into())),
            other => Ok(other),
        },
        other => Err(ManifestError::UnknownPlatform(other.into())),
    }
}

impl ManifestModel {
    pub fn into_model_info(self, target: Platform) -> Result<ModelInfo, ManifestError> {
        let format = parse_format(&self.format)?;
        let tier = parse_tier(&self.tier)?;
        let platform = parse_platform(&self.platform, target)?;
        let mut compute_backends = Vec::with_capacity(self.compute.len());
        for c in &self.compute {
            compute_backends.push(parse_compute(c)?);
        }
        Ok(ModelInfo {
            id: self.id,
            name: self.name,
            parameters: self.parameters,
            quantization: self.quantization,
            format,
            platform,
            compute_backends,
            required_ram_gb: self.required_ram_gb,
            download_size_mb: self.download_size_mb,
            disk_size_mb: self.disk_size_mb,
            context_length: self.context_length,
            tier,
            filename: self.filename,
            url: Some(self.url),
            checksum: self.sha256,
            local_path: None,
        })
    }
}

/// Parse a manifest JSON string.
pub fn parse_manifest(json: &str) -> Result<ModelManifest, ManifestError> {
    Ok(serde_json::from_str::<ModelManifest>(json)?)
}

/// Load the manifest from disk.
pub fn load_manifest(path: &Path) -> Result<ModelManifest, ManifestError> {
    let raw = std::fs::read_to_string(path)?;
    parse_manifest(&raw)
}

/// Load the model registry for the current platform from a manifest
/// file, falling back to the hardcoded registry on any error.
#[must_use]
pub fn load_model_registry(manifest_path: &Path, platform: Platform) -> Vec<ModelInfo> {
    match load_manifest(manifest_path) {
        Ok(manifest) => filter_manifest_for_platform(&manifest, platform),
        Err(_) => available_models_for_platform(platform),
    }
}

/// Filter a parsed manifest down to the models applicable to a
/// concrete platform.
#[must_use]
pub fn filter_manifest_for_platform(manifest: &ModelManifest, target: Platform) -> Vec<ModelInfo> {
    let preferred = target.preferred_format();
    manifest
        .models
        .iter()
        .filter_map(|entry| {
            let entry = entry.clone();
            let format = parse_format(&entry.format).ok()?;
            if format != preferred {
                return None;
            }
            // Skip entries whose platform string is not applicable
            // to the target (e.g. macos-intel entry on linux-x64).
            let entry_platform = parse_platform(&entry.platform, target).ok()?;
            if format == ModelFormat::Mlx && entry_platform != Platform::MacosAppleSilicon {
                return None;
            }
            entry.into_model_info(target).ok()
        })
        .collect()
}

/// Recommend a manifest llama-server variant for the given platform
/// and compute backend.
#[must_use]
pub fn pick_llama_server_variant(
    manifest: &ModelManifest,
    platform: Platform,
    preferred: ComputeBackend,
) -> Option<&ManifestLlamaServerVariant> {
    let server = manifest.llama_server.as_ref()?;
    server
        .variants
        .iter()
        .find(|v| v.platform == platform.as_str() && v.compute == preferred.as_str())
        .or_else(|| {
            server
                .variants
                .iter()
                .find(|v| v.platform == platform.as_str())
        })
}

// --- Single-model download planning -------------------------------------

/// On-disk record of the single model currently installed.
///
/// The serialised JSON shape is intentionally camelCase so it lines up
/// with the TypeScript `InstalledModelRecord` in
/// `apps/desktop/electron/modelManagement.ts`. Tessera's
/// `active-model.json` is currently owned by the TS side, but keeping
/// the wire format identical lets the Rust runtime read the same file
/// without a translation layer the moment it needs to (e.g. when the
/// model loader needs to know which file to mmap at startup).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledModel {
    pub model_id: String,
    pub format: ModelFormat,
    pub filename: String,
    pub path: String,
    /// Bytes pulled over the wire when this model was installed.
    pub download_size_mb: u64,
    /// On-disk footprint after extraction (equal to `download_size_mb`
    /// for single-file GGUF; larger for MLX archives that expand on
    /// disk). Carried separately so `plan_download` can compute correct
    /// disk-space deltas independent of network-transfer size.
    #[serde(default)]
    pub disk_size_mb: u64,
    /// SHA-256 of the downloaded artifact (hex), or `None` if the
    /// manifest entry had no `sha256` recorded.
    ///
    /// Optional + `default` because (a) legacy records written before
    /// this field existed must still deserialise, and (b) the
    /// TypeScript `InstalledModelRecord` declares `sha256: string |
    /// null` — keeping the Rust side `Option<String>` means the wire
    /// shape round-trips through serde without dropping the field. The
    /// whole point of `rename_all = "camelCase"` on this struct is so
    /// the Rust runtime can eventually read/write the same
    /// `active-model.json` as the TS Electron main process; omitting
    /// `sha256` here would silently strip the field on round-trip.
    #[serde(default)]
    pub sha256: Option<String>,
    pub downloaded_at: String,
}

impl InstalledModel {
    /// Fall back to `download_size_mb` if a record was persisted before
    /// the `disk_size_mb` field was introduced (serde defaults to 0).
    #[must_use]
    pub fn effective_disk_size_mb(&self) -> u64 {
        if self.disk_size_mb == 0 {
            self.download_size_mb
        } else {
            self.disk_size_mb
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwapDecision {
    pub evict_model_id: String,
    pub evict_filename: String,
    pub evict_size_mb: u64,
    pub install_model_id: String,
    pub install_filename: String,
    pub install_size_mb: u64,
    pub net_disk_delta_mb: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DownloadPlan {
    AlreadyInstalled {
        model_id: String,
    },
    DirectDownload {
        model_id: String,
        filename: String,
        download_size_mb: u64,
        message: String,
    },
    Swap(SwapDecision),
}

/// Decide what to do when the user asks to install `requested`.
///
/// The planner enforces single-model storage: at most one model file
/// ever lives in the model cache directory.
///
/// `SwapDecision` describes disk-space accounting ("save X MB", "net
/// disk delta"), so the evict / install / delta fields are filled
/// from `disk_size_mb` (the post-extract footprint) on both sides.
/// `DirectDownload.download_size_mb` describes network transfer and
/// is kept as the requested download size for progress UI.
#[must_use]
pub fn plan_download(current: Option<&InstalledModel>, requested: &ModelInfo) -> DownloadPlan {
    let download_size = requested.download_size_mb;
    let install_disk_size = requested.disk_size_mb;
    match current {
        None => DownloadPlan::DirectDownload {
            model_id: requested.id.clone(),
            filename: requested.filename.clone(),
            download_size_mb: download_size,
            message: format!("Download {} ({} MB).", requested.name, download_size),
        },
        Some(inst) if inst.model_id == requested.id => DownloadPlan::AlreadyInstalled {
            model_id: inst.model_id.clone(),
        },
        Some(inst) => {
            let evict_disk_size = inst.effective_disk_size_mb();
            let net = install_disk_size as i64 - evict_disk_size as i64;
            let message = format!(
                "Current: {} ({} MB). New: {} ({} MB). This will remove {} to save {} MB and install {} MB.",
                inst.model_id,
                evict_disk_size,
                requested.name,
                install_disk_size,
                inst.filename,
                evict_disk_size,
                install_disk_size,
            );
            DownloadPlan::Swap(SwapDecision {
                evict_model_id: inst.model_id.clone(),
                evict_filename: inst.filename.clone(),
                evict_size_mb: evict_disk_size,
                install_model_id: requested.id.clone(),
                install_filename: requested.filename.clone(),
                install_size_mb: install_disk_size,
                net_disk_delta_mb: net,
                message,
            })
        }
    }
}

/// Convenience: list models the host can choose from given an
/// optional manifest path.
#[must_use]
pub fn registry_for_host(manifest_path: Option<&Path>, platform: Platform) -> Vec<ModelInfo> {
    if let Some(p) = manifest_path {
        let v = load_model_registry(p, platform);
        if !v.is_empty() {
            return v;
        }
    }
    let _ = full_model_registry; // ensure the registry compiles in.
    available_models_for_platform(platform)
}

#[cfg(test)]
#[allow(clippy::case_sensitive_file_extension_comparisons)]
mod tests {
    use super::*;
    use std::io::Write;

    const SAMPLE_MANIFEST: &str = r#"{
        "format_version": 1,
        "note": "test",
        "models": [
            {
                "id": "ternary-bonsai-1.7b-mlx",
                "name": "Ternary-Bonsai 1.7B",
                "parameters": "1.7B",
                "format": "mlx",
                "quantization": "2-bit",
                "platform": "macos-apple-silicon",
                "compute": ["metal"],
                "tier": "low",
                "downloadSizeMb": 248,
                "diskSizeMb": 248,
                "requiredRamGb": 2.0,
                "contextLength": 2048,
                "filename": "ternary-bonsai-1.7b-2bit.mlx.tar.gz",
                "url": "https://example.invalid/1.7b.mlx.tar.gz",
                "sha256": null
            },
            {
                "id": "ternary-bonsai-1.7b-gguf",
                "name": "Ternary-Bonsai 1.7B",
                "parameters": "1.7B",
                "format": "gguf",
                "quantization": "Q1_0_g128",
                "platform": "any-non-apple-silicon",
                "compute": ["cpu", "cuda", "vulkan", "rocm"],
                "tier": "low",
                "downloadSizeMb": 450,
                "diskSizeMb": 450,
                "requiredRamGb": 2.0,
                "contextLength": 2048,
                "filename": "ternary-bonsai-1.7b-q1_0_g128.gguf",
                "url": "https://example.invalid/1.7b.gguf",
                "sha256": null
            }
        ],
        "llama_server": {
            "version": "b4546",
            "variants": [
                { "platform": "linux-x64", "compute": "cpu", "url": "u1", "sha256": null },
                { "platform": "linux-x64", "compute": "cuda", "url": "u2", "sha256": null },
                { "platform": "windows-x64", "compute": "vulkan", "url": "u3", "sha256": null }
            ]
        }
    }"#;

    #[test]
    fn parse_manifest_succeeds() {
        let m = parse_manifest(SAMPLE_MANIFEST).expect("parse");
        assert_eq!(m.format_version, 1);
        assert_eq!(m.models.len(), 2);
        assert!(m.llama_server.is_some());
    }

    #[test]
    fn filter_apple_silicon_keeps_only_mlx() {
        let m = parse_manifest(SAMPLE_MANIFEST).unwrap();
        let v = filter_manifest_for_platform(&m, Platform::MacosAppleSilicon);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].format, ModelFormat::Mlx);
        assert_eq!(v[0].platform, Platform::MacosAppleSilicon);
        assert_eq!(v[0].quantization, "2-bit");
    }

    #[test]
    fn filter_linux_keeps_only_gguf() {
        let m = parse_manifest(SAMPLE_MANIFEST).unwrap();
        let v = filter_manifest_for_platform(&m, Platform::LinuxX64);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].format, ModelFormat::Gguf);
        assert_eq!(v[0].platform, Platform::LinuxX64);
        assert_eq!(v[0].quantization, "Q1_0_g128");
    }

    #[test]
    fn filter_windows_keeps_only_gguf() {
        let m = parse_manifest(SAMPLE_MANIFEST).unwrap();
        let v = filter_manifest_for_platform(&m, Platform::WindowsX64);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].platform, Platform::WindowsX64);
    }

    #[test]
    fn shipped_manifest_parses_and_has_six_variants() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/models.json");
        let manifest = load_manifest(&path).expect("ship manifest parses");
        assert_eq!(manifest.models.len(), 6);
        let mlx = manifest.models.iter().filter(|m| m.format == "mlx").count();
        let gguf = manifest
            .models
            .iter()
            .filter(|m| m.format == "gguf")
            .count();
        assert_eq!(mlx, 3);
        assert_eq!(gguf, 3);
        for m in &manifest.models {
            assert_ne!(m.quantization, "Q4_K_M");
        }
    }

    #[test]
    fn ship_manifest_no_duplicate_platform_tier_combination() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/models.json");
        let manifest = load_manifest(&path).expect("ship manifest parses");
        let mut seen: Vec<(String, String, String)> = Vec::new();
        for m in &manifest.models {
            let key = (m.format.clone(), m.platform.clone(), m.tier.clone());
            assert!(!seen.contains(&key), "duplicate manifest entry {key:?}");
            seen.push(key);
        }
    }

    #[test]
    fn ship_manifest_filename_extension_matches_format() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../sidecars/models.json");
        let manifest = load_manifest(&path).expect("ship manifest parses");
        for m in &manifest.models {
            if m.format == "mlx" {
                assert!(m.filename.ends_with(".mlx.tar.gz"), "{}", m.filename);
            } else if m.format == "gguf" {
                assert!(m.filename.ends_with(".gguf"), "{}", m.filename);
            }
        }
    }

    #[test]
    fn plan_direct_download_when_nothing_installed() {
        let registry = full_model_registry();
        let req = registry
            .into_iter()
            .find(|m| m.id == "ternary-bonsai-4b-gguf")
            .unwrap();
        let plan = plan_download(None, &req);
        match plan {
            DownloadPlan::DirectDownload {
                model_id,
                download_size_mb,
                ..
            } => {
                assert_eq!(model_id, "ternary-bonsai-4b-gguf");
                assert_eq!(download_size_mb, 1000);
            }
            other => panic!("expected DirectDownload, got {other:?}"),
        }
    }

    #[test]
    fn plan_already_installed_when_same_id() {
        let registry = full_model_registry();
        let req = registry
            .into_iter()
            .find(|m| m.id == "ternary-bonsai-1.7b-gguf")
            .unwrap();
        let installed = InstalledModel {
            model_id: req.id.clone(),
            format: req.format,
            filename: req.filename.clone(),
            path: "/tmp/x".into(),
            download_size_mb: req.download_size_mb,
            disk_size_mb: req.disk_size_mb,
            sha256: None,
            downloaded_at: "2026-05-19T00:00:00Z".into(),
        };
        let plan = plan_download(Some(&installed), &req);
        match plan {
            DownloadPlan::AlreadyInstalled { model_id } => {
                assert_eq!(model_id, "ternary-bonsai-1.7b-gguf");
            }
            other => panic!("expected AlreadyInstalled, got {other:?}"),
        }
    }

    #[test]
    fn plan_swap_when_different_id() {
        let registry = full_model_registry();
        let installed_info = registry
            .iter()
            .find(|m| m.id == "ternary-bonsai-1.7b-gguf")
            .unwrap()
            .clone();
        let requested = registry
            .iter()
            .find(|m| m.id == "ternary-bonsai-4b-gguf")
            .unwrap()
            .clone();
        let installed = InstalledModel {
            model_id: installed_info.id.clone(),
            format: installed_info.format,
            filename: installed_info.filename.clone(),
            path: "/tmp/old".into(),
            download_size_mb: installed_info.download_size_mb,
            disk_size_mb: installed_info.disk_size_mb,
            sha256: None,
            downloaded_at: "2026-05-19T00:00:00Z".into(),
        };
        let plan = plan_download(Some(&installed), &requested);
        match plan {
            DownloadPlan::Swap(decision) => {
                assert_eq!(decision.evict_model_id, "ternary-bonsai-1.7b-gguf");
                assert_eq!(decision.install_model_id, "ternary-bonsai-4b-gguf");
                assert_eq!(decision.evict_size_mb, 450);
                assert_eq!(decision.install_size_mb, 1000);
                assert_eq!(decision.net_disk_delta_mb, 550);
                assert!(decision.message.contains("1.7b"));
                assert!(decision.message.contains("4B"));
            }
            other => panic!("expected Swap, got {other:?}"),
        }
    }

    #[test]
    fn plan_swap_disk_size_used_when_diverges_from_download_size() {
        // Simulate a model where the on-disk footprint after extract is
        // bigger than the compressed download (e.g. future MLX archive).
        // The swap decision must reflect disk usage, not network transfer.
        let installed = InstalledModel {
            model_id: "installed-archive".into(),
            format: ModelFormat::Mlx,
            filename: "installed.tar.gz".into(),
            path: "/tmp/installed".into(),
            download_size_mb: 100,
            disk_size_mb: 300,
            sha256: None,
            downloaded_at: "2026-05-19T00:00:00Z".into(),
        };
        let requested = ModelInfo {
            id: "new-archive".into(),
            name: "New Archive".into(),
            parameters: "4B".into(),
            quantization: "2-bit".into(),
            format: ModelFormat::Mlx,
            platform: Platform::MacosAppleSilicon,
            compute_backends: vec![ComputeBackend::Metal],
            required_ram_gb: 4.0,
            download_size_mb: 250,
            disk_size_mb: 700,
            context_length: 4096,
            tier: DeviceTier::Medium,
            filename: "new.tar.gz".into(),
            url: None,
            checksum: None,
            local_path: None,
        };
        let plan = plan_download(Some(&installed), &requested);
        match plan {
            DownloadPlan::Swap(decision) => {
                assert_eq!(decision.evict_size_mb, 300);
                assert_eq!(decision.install_size_mb, 700);
                assert_eq!(decision.net_disk_delta_mb, 400);
                assert!(decision.message.contains("300 MB"));
                assert!(decision.message.contains("700 MB"));
            }
            other => panic!("expected Swap, got {other:?}"),
        }
    }

    #[test]
    fn installed_model_serialises_with_camel_case_keys_matching_ts() {
        let m = InstalledModel {
            model_id: "ternary-bonsai-1.7b-gguf".into(),
            format: ModelFormat::Gguf,
            filename: "ternary-bonsai-1.7b-q1_0_g128.gguf".into(),
            path: "/tmp/m".into(),
            download_size_mb: 450,
            disk_size_mb: 450,
            sha256: Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".into()),
            downloaded_at: "2026-05-19T00:00:00Z".into(),
        };
        let json = serde_json::to_value(&m).unwrap();
        // These are the camelCase keys the TypeScript `InstalledModelRecord`
        // expects to find in `active-model.json`. If serde renaming ever
        // regresses, the Rust runtime would silently fail to deserialise the
        // file shipped by the TS Electron main process.
        for key in [
            "modelId",
            "format",
            "filename",
            "path",
            "downloadSizeMb",
            "diskSizeMb",
            "sha256",
            "downloadedAt",
        ] {
            assert!(json.get(key).is_some(), "missing key {key} in {json}");
        }
        // And the snake_case names must NOT leak into the wire format.
        for key in [
            "model_id",
            "download_size_mb",
            "disk_size_mb",
            "downloaded_at",
        ] {
            assert!(json.get(key).is_none(), "unexpected key {key} in {json}");
        }
    }

    #[test]
    fn installed_model_deserialises_camel_case_record_written_by_ts() {
        // Verbatim shape that the TS Electron main process writes to
        // active-model.json. Round-tripping this through serde must succeed
        // so the Rust runtime can read the same file going forward.
        let written_by_ts = r#"{
            "modelId": "ternary-bonsai-1.7b-gguf",
            "format": "gguf",
            "filename": "ternary-bonsai-1.7b-q1_0_g128.gguf",
            "path": "/var/data/models/ternary-bonsai-1.7b-q1_0_g128.gguf",
            "downloadSizeMb": 450,
            "diskSizeMb": 450,
            "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            "downloadedAt": "2026-05-19T00:00:00Z"
        }"#;
        let parsed: InstalledModel = serde_json::from_str(written_by_ts).unwrap();
        assert_eq!(parsed.model_id, "ternary-bonsai-1.7b-gguf");
        assert_eq!(parsed.download_size_mb, 450);
        assert_eq!(parsed.disk_size_mb, 450);
        assert_eq!(
            parsed.sha256.as_deref(),
            Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        );
        assert_eq!(parsed.downloaded_at, "2026-05-19T00:00:00Z");
    }

    #[test]
    fn installed_model_round_trips_through_ts_when_sha256_present_and_absent() {
        // Forward path: TS writes a record with `sha256: "…"`, Rust
        // deserialises, re-serialises, and the field must survive.
        let written_by_ts_with_sha = r#"{
            "modelId": "id",
            "format": "gguf",
            "filename": "x.gguf",
            "path": "/x",
            "downloadSizeMb": 1,
            "diskSizeMb": 1,
            "sha256": "deadbeef",
            "downloadedAt": "t"
        }"#;
        let parsed: InstalledModel = serde_json::from_str(written_by_ts_with_sha).unwrap();
        let reserialised = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            reserialised.get("sha256").and_then(|v| v.as_str()),
            Some("deadbeef"),
            "Rust must preserve sha256 across deserialise->serialise round-trip"
        );

        // Reverse path: TS writes `sha256: null` (manifest entry had no
        // checksum). Rust must deserialise that as None and re-emit null
        // — not omit the key, because the TS type declares `string |
        // null`, not `string | undefined`.
        let written_by_ts_with_null_sha = r#"{
            "modelId": "id",
            "format": "gguf",
            "filename": "x.gguf",
            "path": "/x",
            "downloadSizeMb": 1,
            "diskSizeMb": 1,
            "sha256": null,
            "downloadedAt": "t"
        }"#;
        let parsed_null: InstalledModel =
            serde_json::from_str(written_by_ts_with_null_sha).unwrap();
        assert_eq!(parsed_null.sha256, None);
        let reserialised_null = serde_json::to_value(&parsed_null).unwrap();
        assert!(
            reserialised_null.get("sha256").is_some()
                && reserialised_null.get("sha256").unwrap().is_null(),
            "None sha256 must serialise as JSON null, not be omitted"
        );
    }

    #[test]
    fn installed_model_falls_back_to_download_size_when_disk_size_missing() {
        let m = InstalledModel {
            model_id: "legacy".into(),
            format: ModelFormat::Gguf,
            filename: "legacy.gguf".into(),
            path: "/tmp/legacy".into(),
            download_size_mb: 450,
            disk_size_mb: 0,
            sha256: None,
            downloaded_at: "2026-05-19T00:00:00Z".into(),
        };
        assert_eq!(m.effective_disk_size_mb(), 450);

        let m2 = InstalledModel {
            disk_size_mb: 700,
            ..m
        };
        assert_eq!(m2.effective_disk_size_mb(), 700);
    }

    #[test]
    fn pick_llama_server_variant_prefers_exact_compute() {
        let manifest = parse_manifest(SAMPLE_MANIFEST).unwrap();
        let v = pick_llama_server_variant(&manifest, Platform::LinuxX64, ComputeBackend::Cuda)
            .expect("cuda variant present");
        assert_eq!(v.compute, "cuda");
        assert_eq!(v.platform, "linux-x64");
    }

    #[test]
    fn pick_llama_server_variant_falls_back_to_any_platform_match() {
        let manifest = parse_manifest(SAMPLE_MANIFEST).unwrap();
        let v = pick_llama_server_variant(&manifest, Platform::WindowsX64, ComputeBackend::Cuda)
            .expect("falls back to first windows variant");
        assert_eq!(v.platform, "windows-x64");
    }

    #[test]
    fn load_manifest_from_tempfile_round_trip() {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(SAMPLE_MANIFEST.as_bytes()).unwrap();
        let m = load_manifest(tmp.path()).unwrap();
        assert_eq!(m.models.len(), 2);
    }

    #[test]
    fn load_manifest_missing_file_returns_err() {
        let err = load_manifest(std::path::Path::new("/nonexistent/manifest.json")).unwrap_err();
        matches!(err, ManifestError::Io(_));
    }

    #[test]
    fn registry_for_host_falls_back_when_manifest_absent() {
        let v = registry_for_host(
            Some(std::path::Path::new("/nonexistent/manifest.json")),
            Platform::WindowsX64,
        );
        assert_eq!(v.len(), 3);
        for m in &v {
            assert_eq!(m.format, ModelFormat::Gguf);
        }
    }
}
