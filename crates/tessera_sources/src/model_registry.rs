//! Registry of the ONNX embedding models Tessera ships with, plus a
//! resumable + checksum-verified downloader.
//!
//! ## Why this lives next to the embedder, not the runtime crate
//!
//! Tessera's `tessera_runtime` crate manages the *text-generation*
//! sidecar (llama-server) and the *vision* sidecar. Those are
//! supervised child processes with a long lifecycle: start, health
//! check, stream, kill. Embeddings are different — the ONNX session
//! lives **in-process** alongside the rest of `tessera_sources`, so
//! the model files are owned by the same crate that consumes them.
//! Keeping the registry here also means `tessera_runtime` does not
//! pick up a transitive dependency on `ort`, which keeps the
//! sidecar-only build of `tessera_runtime` lean.
//!
//! ## Model selection
//!
//! Two models are pre-registered:
//!
//!   * `all-MiniLM-L6-v2` — Xenova's quantised ONNX export of
//!     sentence-transformers/all-MiniLM-L6-v2. 22 MB on disk,
//!     384-dim, English only. Best for English-only corpora where
//!     download size matters.
//!   * `paraphrase-multilingual-MiniLM-L12-v2` — Xenova's quantised
//!     ONNX export of sentence-transformers/paraphrase-multilingual-
//!     MiniLM-L12-v2. ~118 MB on disk, 384-dim, 50+ languages. The
//!     default recommendation for multilingual workspaces; cross-
//!     lingual cosine similarity of e.g. "financial report" vs
//!     "rapport financier" lands above 0.7 vs the English-only model's
//!     ~0.2 for the same pair.
//!
//! Both models output 384 dimensions, so the ANN index, cosine
//! similarity code, and `chunk_embeddings` schema work identically
//! whichever is active. The provider's `model_id()` differs across
//! the two so the hybrid pipeline correctly invalidates cached
//! embeddings when the user switches.
//!
//! ## Why we pin both URL revision AND SHA-256
//!
//! HuggingFace serves model files via Xet/S3 with CloudFront caching;
//! the file at `resolve/main/...` is the latest commit on the main
//! branch and CAN change if the upstream repo is updated. Pinning
//! the URL to a specific git revision (`resolve/<sha>/...`) makes
//! the URL itself immutable. The SHA-256 check is then a
//! belt-and-braces integrity layer that catches (a) any
//! transport-level corruption (truncated downloads, MITM tampering)
//! and (b) any HF infrastructure change that silently rewrites
//! pinned-revision content. If either fails, the download is
//! discarded and the caller sees an error rather than a silently
//! corrupted model that produces garbage vectors at search time.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use tessera_core::error::{Error, Result};

/// One row in the model registry. All fields are `'static` because
/// the registry is a compile-time constant — there is no scenario in
/// which adding a model requires touching anything other than this
/// file plus a maintainer-side download verification step.
#[derive(Debug, Clone, Copy)]
pub struct ModelInfo {
    /// Short, URL-safe identifier used as the directory name under
    /// `{models_root}/onnx/{slug}/` and as the public IPC tag.
    /// Must NOT change once a model is shipped — the slug is the
    /// stable key the renderer persists for "current model".
    pub slug: &'static str,
    /// Human-readable display name shown in the Settings UI.
    pub display_name: &'static str,
    /// ONNX model file URL. Pinned to a specific HuggingFace
    /// commit so the URL is immutable. See module docs for why the
    /// SHA-256 below is a separate layer of protection.
    pub model_url: &'static str,
    /// Tokenizer JSON URL, also pinned to a specific commit.
    pub tokenizer_url: &'static str,
    /// Expected SHA-256 of the ONNX model file. Computed once from
    /// the pinned-revision URL and committed here. Mismatch on
    /// download = abort + delete (see `download_model`).
    pub model_sha256: &'static str,
    /// Expected SHA-256 of the tokenizer.json file.
    pub tokenizer_sha256: &'static str,
    /// Output vector dimensionality. Both shipped models are 384
    /// so the ANN index / cosine code never branches; we still
    /// store it per-model so the bridge can sanity-check the
    /// loaded session's output shape before announcing it.
    pub dim: usize,
    /// Approximate on-disk size of the ONNX file in bytes. Used by
    /// the Settings UI to render a "120 MB download" preview before
    /// the user commits.
    pub model_size_bytes: u64,
    /// Approximate on-disk size of the tokenizer JSON in bytes.
    pub tokenizer_size_bytes: u64,
    /// Comma-separated short list of language codes / language
    /// families this model handles well. Used by the auto-detect
    /// hint that suggests switching to the multilingual model.
    pub languages: &'static str,
}

impl ModelInfo {
    /// Final directory that holds this model's `.onnx` + `tokenizer.json`
    /// once downloaded. `models_root` is the user's data dir (e.g.
    /// `{userData}/models`) — same root the vision/imagegen sidecars
    /// use, so the on-disk layout is uniform across capabilities.
    pub fn install_dir(&self, models_root: &Path) -> PathBuf {
        models_root.join("onnx").join(self.slug)
    }

    /// Final on-disk path of the ONNX model file.
    pub fn model_path(&self, models_root: &Path) -> PathBuf {
        self.install_dir(models_root).join("model.onnx")
    }

    /// Final on-disk path of the tokenizer JSON file.
    pub fn tokenizer_path(&self, models_root: &Path) -> PathBuf {
        self.install_dir(models_root).join("tokenizer.json")
    }

    /// True iff both files exist on disk AND their SHA-256 matches
    /// the pinned expected hash. This is the function the bridge
    /// calls before announcing "model loaded": a partial download
    /// from a previous run that crashed mid-stream reports `false`
    /// here so the user is prompted to re-download.
    pub fn is_installed(&self, models_root: &Path) -> bool {
        let model_path = self.model_path(models_root);
        let tokenizer_path = self.tokenizer_path(models_root);
        if !model_path.exists() || !tokenizer_path.exists() {
            return false;
        }
        matches!(
            (
                verify_sha256_sync(&model_path, self.model_sha256),
                verify_sha256_sync(&tokenizer_path, self.tokenizer_sha256),
            ),
            (Ok(true), Ok(true))
        )
    }
}

/// Registry of shipped models, in display order. Add new entries by
/// (1) appending to this slice and (2) pinning the SHA-256 via the
/// `pin-model-sha` maintainer script described in CONTRIBUTING.md.
pub const SHIPPED_MODELS: &[ModelInfo] = &[
    ModelInfo {
        slug: "all-MiniLM-L6-v2",
        display_name: "Semantic — English (MiniLM-L6, 22 MB)",
        // Pinned to commit 751bff37182d3f1213fa05d7196b954e230abad9
        // of Xenova/all-MiniLM-L6-v2. See module docs for why we pin
        // the URL revision AND check the SHA-256.
        model_url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/onnx/model_quantized.onnx",
        tokenizer_url: "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/751bff37182d3f1213fa05d7196b954e230abad9/tokenizer.json",
        model_sha256: "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
        tokenizer_sha256: "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
        dim: 384,
        model_size_bytes: 22_972_370,
        tokenizer_size_bytes: 711_661,
        languages: "en",
    },
    ModelInfo {
        slug: "paraphrase-multilingual-MiniLM-L12-v2",
        display_name: "Semantic — Multilingual (XLM-R MiniLM-L12, 118 MB)",
        // Pinned to commit 2c4055b12046f11709e9df2c122e59ffbdc2f900
        // of Xenova/paraphrase-multilingual-MiniLM-L12-v2. Covers
        // 50+ languages via the underlying XLM-R SentencePiece
        // tokenizer; recommended for any workspace with non-English
        // content.
        model_url: "https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/2c4055b12046f11709e9df2c122e59ffbdc2f900/onnx/model_quantized.onnx",
        tokenizer_url: "https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/2c4055b12046f11709e9df2c122e59ffbdc2f900/tokenizer.json",
        model_sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
        tokenizer_sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
        dim: 384,
        model_size_bytes: 118_308_126,
        tokenizer_size_bytes: 17_082_913,
        // The underlying XLM-R model card lists 50+ supported
        // languages; we don't enumerate them all in the UI hint.
        languages: "multilingual",
    },
];

/// Look up a model by slug. Returns `None` if unknown.
pub fn lookup(slug: &str) -> Option<&'static ModelInfo> {
    SHIPPED_MODELS.iter().find(|m| m.slug == slug)
}

/// Progress callback signature. The downloader calls this with
/// `(bytes_downloaded, total_bytes)` after every chunk so the UI
/// can render a progress bar without polling.
///
/// The callback runs on the tokio worker that drives the download,
/// NOT on the renderer thread — implementations that want to update
/// React state must marshal back to the main thread themselves
/// (e.g. via the napi-rs `ThreadsafeFunction` shim in the bridge).
///
/// `Arc<dyn Fn>` not `Box<dyn Fn>` because the callback is cloned
/// into both the model-file and tokenizer-file download branches.
pub type ProgressCallback = Arc<dyn Fn(u64, u64) + Send + Sync + 'static>;

/// Download (or refresh) the given model into
/// `{models_root}/onnx/{slug}/`.
///
/// Semantics:
///
///   * Idempotent. If both files already exist with matching SHA-256
///     the function returns immediately without touching the network.
///   * Atomic per-file. Each file is written to `*.partial`, fsynced,
///     verified against the expected SHA-256, and only then renamed
///     to its final name. A crash mid-download leaves the `.partial`
///     file in place but does NOT corrupt the live `model.onnx` —
///     the next run sees `is_installed() == false` and tries again.
///   * Reports progress per file via the callback. The two files are
///     downloaded sequentially (not in parallel) so a slow network
///     does not interleave progress percentages between them.
///   * Fails closed on checksum mismatch. The partial file is
///     unlinked and the error includes both the expected and the
///     observed hash so the maintainer can update the registry if
///     they intentionally bumped the upstream commit.
pub async fn download_model(
    slug: &str,
    models_root: &Path,
    progress: Option<ProgressCallback>,
) -> Result<PathBuf> {
    let info = lookup(slug).ok_or_else(|| {
        Error::InvalidConfig(format!(
            "unknown embedding model slug: {slug} (known: {})",
            SHIPPED_MODELS
                .iter()
                .map(|m| m.slug)
                .collect::<Vec<_>>()
                .join(", "),
        ))
    })?;

    let install_dir = info.install_dir(models_root);
    std::fs::create_dir_all(&install_dir)?;

    // Short-circuit if both files are already on disk with the
    // pinned SHA-256. Avoids a wasted network round-trip when the
    // renderer calls `download_model` defensively before
    // `load_embedding_model`.
    if info.is_installed(models_root) {
        return Ok(install_dir);
    }

    // Sequential download (model file first, tokenizer second). The
    // model is the big one; surfacing its progress first matches the
    // user's mental model of "this 120 MB download is the bulk of
    // the wait."
    //
    // Wrap the user-supplied callback so the renderer sees ONE
    // monotonic stream of `(downloaded, total)` across both files
    // instead of the progress bar snapping back from 100 % to 0 %
    // when the tokenizer download starts. The combined total is
    // the sum of the registry hints; per-file `download_and_verify`
    // emits per-file `(downloaded, total)` to the wrapper, which
    // offsets by `cumulative_done` and re-emits against the
    // combined total. The combined total is fixed (registry hint
    // sum) rather than recomputed from the per-stream
    // Content-Length so the bar never widens mid-download.
    let combined_total = info
        .model_size_bytes
        .saturating_add(info.tokenizer_size_bytes);
    if let Some(cb) = progress.as_ref() {
        // Anchor the bar at (0, combined_total) before bytes start
        // flowing. Without this the renderer's first poll between
        // `download_model` entry and the first stream chunk would
        // see the IDLE_DOWNLOAD snapshot (bytes_total = None) for a
        // 100-500 ms window even though the download is logically
        // in flight.
        cb(0, combined_total);
    }
    let model_progress = progress.as_ref().map(|cb| {
        let cb = cb.clone();
        Arc::new(move |downloaded: u64, _total: u64| {
            cb(downloaded.min(combined_total), combined_total);
        }) as ProgressCallback
    });
    download_and_verify(
        info.model_url,
        &info.model_path(models_root),
        info.model_sha256,
        info.model_size_bytes,
        model_progress,
    )
    .await?;

    let cumulative_done = info.model_size_bytes;
    let tokenizer_progress = progress.as_ref().map(|cb| {
        let cb = cb.clone();
        Arc::new(move |downloaded: u64, _total: u64| {
            cb(
                cumulative_done
                    .saturating_add(downloaded)
                    .min(combined_total),
                combined_total,
            );
        }) as ProgressCallback
    });
    download_and_verify(
        info.tokenizer_url,
        &info.tokenizer_path(models_root),
        info.tokenizer_sha256,
        info.tokenizer_size_bytes,
        tokenizer_progress,
    )
    .await?;

    if let Some(cb) = progress.as_ref() {
        // Ensure the renderer sees a final 100 % tick. The last
        // per-file callback already reports combined_total, but a
        // final explicit pin guards against rounding when the
        // server's Content-Length differs from the registry hint.
        cb(combined_total, combined_total);
    }

    Ok(install_dir)
}

/// Download a single file, verify its SHA-256, then atomically
/// rename `*.partial` → final path.
async fn download_and_verify(
    url: &str,
    final_path: &Path,
    expected_sha256: &str,
    expected_size_hint: u64,
    progress: Option<ProgressCallback>,
) -> Result<()> {
    // If the final file already exists with the right hash, skip.
    // (Per-file idempotence; `download_model` also has a coarser
    // idempotence check at the model level.)
    if final_path.exists() && verify_sha256_sync(final_path, expected_sha256)? {
        if let Some(cb) = &progress {
            cb(expected_size_hint, expected_size_hint);
        }
        return Ok(());
    }

    let partial_path = final_path.with_extension(format!(
        "{}partial",
        final_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default(),
    ));

    // Reqwest client with a generous timeout. 120 MB on a slow link
    // can take a few minutes; we don't want to false-fail on a
    // residential connection. The default timeout is `None` (no
    // timeout); we set 30 minutes as an outer bound so a stuck
    // connection eventually surfaces an error rather than hanging
    // forever.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30 * 60))
        // Tessera-User-Agent so HF's monitoring can attribute
        // download volume to the app.
        .user_agent(format!(
            "tessera/{} (+https://github.com/kennguy3n/Tessera)",
            env!("CARGO_PKG_VERSION"),
        ))
        .build()
        .map_err(|e| Error::InvalidConfig(format!("reqwest client build failed: {e}")))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| Error::Extraction {
            path: url.to_string(),
            message: format!("download failed: {e}"),
        })?;

    if !response.status().is_success() {
        return Err(Error::Extraction {
            path: url.to_string(),
            message: format!("download returned HTTP {}", response.status()),
        });
    }

    // Prefer the server-reported Content-Length over the registry
    // hint. The hint is approximate (rounded to the pinned commit's
    // file size at registry-update time); the response header is
    // exact. Falling back to the hint matters when the server's
    // Content-Length is absent — e.g. some HF mirrors return
    // chunked-encoded responses for large LFS files.
    let total = response.content_length().unwrap_or(expected_size_hint);

    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut file = tokio::fs::File::create(&partial_path).await?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Error::Extraction {
            path: url.to_string(),
            message: format!("download stream error: {e}"),
        })?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        if let Some(cb) = &progress {
            cb(downloaded, total);
        }
    }

    // fsync the partial file before verifying + renaming. Without
    // this, a power loss between write and rename could leave a
    // zero-length `final_path` on next boot (the rename is durable
    // but the file's contents are not yet). `flush` ensures the
    // writes are sent; `sync_all` waits for the kernel to commit
    // them.
    file.flush().await?;
    file.sync_all().await?;
    drop(file);

    let observed = format!("{:x}", hasher.finalize());
    if !observed.eq_ignore_ascii_case(expected_sha256) {
        // Mismatch: unlink the partial file so a retry starts from
        // scratch, and surface both hashes so the maintainer can
        // tell whether the upstream changed (update the registry)
        // vs the file was corrupted (network issue, retry).
        let _ = tokio::fs::remove_file(&partial_path).await;
        return Err(Error::Extraction {
            path: final_path.display().to_string(),
            message: format!("SHA-256 mismatch: expected {expected_sha256}, observed {observed}"),
        });
    }

    // Atomic rename. On every supported platform (Linux, macOS,
    // Windows) `rename` of files on the same filesystem is atomic;
    // either the new file is visible at `final_path` or it isn't.
    tokio::fs::rename(&partial_path, final_path).await?;

    Ok(())
}

/// Synchronous SHA-256 verify of an on-disk file. Returns
/// `Ok(true)` on match, `Ok(false)` on mismatch, and `Err` only
/// on IO failure (so the caller can distinguish "the file is
/// corrupt" from "I couldn't read it to check").
///
/// Used by `is_installed()` from the bridge's synchronous loading
/// path and by `download_and_verify`'s fast-path skip. The 1 MiB
/// read buffer is enough to stream the 120 MB multilingual model
/// in ~120 reads — negligible vs the SHA-256 work itself.
fn verify_sha256_sync(path: &Path, expected: &str) -> Result<bool> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let observed = format!("{:x}", hasher.finalize());
    Ok(observed.eq_ignore_ascii_case(expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shipped_models_have_distinct_slugs() {
        // Catches a copy-paste in the registry where two entries
        // share a slug — would cause `lookup` to silently return
        // the first match and the second to be unreachable.
        let mut seen = std::collections::HashSet::new();
        for m in SHIPPED_MODELS {
            assert!(
                seen.insert(m.slug),
                "duplicate slug in SHIPPED_MODELS: {}",
                m.slug,
            );
        }
    }

    #[test]
    fn shipped_models_have_384_dim() {
        // The hybrid retrieval / ANN code assumes every shipped
        // ONNX model produces 384-dim vectors so the schema and
        // cosine-similarity code don't branch on the active model.
        // Adding a model with a different dim is a deliberate
        // schema change that must update this assertion AND the
        // ANN index implementation, not just bump the constant.
        for m in SHIPPED_MODELS {
            assert_eq!(m.dim, 384, "shipped model {} must be 384-dim", m.slug);
        }
    }

    #[test]
    fn lookup_resolves_known_slugs() {
        assert!(lookup("all-MiniLM-L6-v2").is_some());
        assert!(lookup("paraphrase-multilingual-MiniLM-L12-v2").is_some());
        assert!(lookup("nonexistent").is_none());
    }

    #[test]
    fn install_dir_matches_models_root_layout() {
        // Pins the on-disk layout: `{root}/onnx/{slug}/...`. The
        // bridge layer relies on this so it can compute the model
        // path from just the slug + the user-data dir.
        let root = Path::new("/tmp/tessera-test-root");
        let info = lookup("all-MiniLM-L6-v2").unwrap();
        assert_eq!(
            info.install_dir(root),
            root.join("onnx").join("all-MiniLM-L6-v2")
        );
        assert_eq!(
            info.model_path(root),
            root.join("onnx")
                .join("all-MiniLM-L6-v2")
                .join("model.onnx")
        );
        assert_eq!(
            info.tokenizer_path(root),
            root.join("onnx")
                .join("all-MiniLM-L6-v2")
                .join("tokenizer.json")
        );
    }

    #[test]
    fn verify_sha256_sync_detects_mismatch() {
        // Real hash of "hello world" computed once on the maintainer
        // box: `printf 'hello world' | sha256sum`. Pinning a literal
        // here rather than computing it via the same Sha256 used
        // in production avoids a circular validation (where a bug
        // in `verify_sha256_sync` would silently agree with itself).
        let tmp = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(tmp.path(), b"hello world").unwrap();
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert!(verify_sha256_sync(tmp.path(), expected).unwrap());
        assert!(!verify_sha256_sync(tmp.path(), "0".repeat(64).as_str()).unwrap());
    }
}
