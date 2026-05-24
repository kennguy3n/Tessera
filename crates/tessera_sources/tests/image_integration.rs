//! Integration tests for the image-VLM pass of `Indexer::index_file`.
//!
//! These tests verify the recovery semantics when a VLM call on an
//! image file fails (sidecar dead, model unloaded, transient network
//! hiccup). The contract — pinned by Devin Review pass-9 🚩 finding —
//! is that an image-VLM failure stamps a `partial:` sentinel on the
//! `indexed_files` row so the next `index_file` call detects the
//! mismatch and retries the VLM describe pass, instead of
//! short-circuiting on hash match and permanently losing the
//! description for that image.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use image::{ImageBuffer, Rgb};
use tempfile::TempDir;

use tessera_core::error::{Error, Result};
use tessera_sources::indexer::Indexer;
use tessera_sources::source::Source;
use tessera_sources::store::SourceStore;
use tessera_sources::vision_extractor::VisionExtractor;

/// Write a tiny solid-colour PNG to `<dir>/<name>` and return the
/// path. The pixel content doesn't matter — the tests stub out the
/// VLM extractor — but the file must be a real image so the
/// indexer's `is_image_extension` + EXIF/metadata path succeeds.
fn write_tiny_png(dir: &Path, name: &str) -> PathBuf {
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(8, 8, |_, _| Rgb([200, 100, 50]));
    let path = dir.join(name);
    img.save(&path).expect("png save must succeed");
    path
}

/// VLM stub that fails its first call and succeeds on every
/// subsequent call. Used to verify the retry path: first pass
/// fails → row stamped `partial:` → second pass re-runs VLM.
struct FailThenSucceedStub {
    description: String,
    model: String,
    call_count: Mutex<usize>,
}

impl FailThenSucceedStub {
    fn new(description: &str, model: &str) -> Self {
        Self {
            description: description.to_string(),
            model: model.to_string(),
            call_count: Mutex::new(0),
        }
    }

    fn call_count(&self) -> usize {
        *self.call_count.lock().unwrap()
    }
}

impl VisionExtractor for FailThenSucceedStub {
    fn describe_image(&self, _image_path: &Path) -> Result<String> {
        let mut n = self.call_count.lock().unwrap();
        *n += 1;
        if *n == 1 {
            // First call simulates a transient sidecar failure
            // (e.g. llama-server timed out, mmproj not loaded).
            Err(Error::Extraction {
                path: "<vlm>".to_string(),
                message: "simulated transient VLM failure".to_string(),
            })
        } else {
            Ok(self.description.clone())
        }
    }

    fn model_id(&self) -> &str {
        &self.model
    }
}

/// VLM stub that always errors. Used to verify the row stays
/// stamped as `partial:` across repeated failed passes, so that a
/// model fix on a later run can still recover the description
/// rather than being permanently shadowed by the file's content
/// hash.
struct AlwaysFailStub;

impl VisionExtractor for AlwaysFailStub {
    fn describe_image(&self, _image_path: &Path) -> Result<String> {
        Err(Error::Extraction {
            path: "<vlm>".to_string(),
            message: "persistent VLM failure".to_string(),
        })
    }

    fn model_id(&self) -> &'static str {
        "always-fail-vlm"
    }
}

#[test]
fn image_vlm_failure_stamps_partial_sentinel_for_retry() {
    // Devin Review pass-9 🚩 regression guard: when the VLM call on
    // an image file fails, `index_file` must stamp a `partial:`
    // sentinel on the `indexed_files` row. Without that stamp, the
    // next scheduled scan would short-circuit on hash match and the
    // user would never get a description for the image even after
    // the sidecar recovered.
    let dir = TempDir::new().expect("tempdir must be created");
    let png_path = write_tiny_png(dir.path(), "photo.png");

    let store = SourceStore::open_in_memory().expect("store open");
    let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
    store.add_source(&source).expect("add_source");

    let stub: Arc<dyn VisionExtractor> = Arc::new(AlwaysFailStub);
    let indexer = Indexer::new(&[]).with_vision_extractor(stub);

    indexer
        .index_single_file(&source.id, &png_path, &store)
        .expect("index_single_file must succeed (VLM errors are non-fatal)");

    let stored_hash = store
        .get_file_hash(&png_path.to_string_lossy())
        .expect("get_file_hash must succeed")
        .expect("a row must exist for the indexed image");
    assert!(
        stored_hash.starts_with("partial:"),
        "image-VLM failure must stamp `partial:` so the next pass retries; got hash={stored_hash}"
    );
}

#[test]
fn image_vlm_retry_after_partial_sentinel_recovers_description() {
    // Companion to the test above: once the partial sentinel is on
    // the row, a second `index_file` call must NOT short-circuit
    // (the on-disk file hash differs from the stored
    // `partial:HEX`), so the VLM call is retried. With the
    // `FailThenSucceedStub`, the second call returns the canned
    // description and a chunk tagged `Vlm` is emitted.
    let dir = TempDir::new().expect("tempdir must be created");
    let png_path = write_tiny_png(dir.path(), "photo.png");

    let store = SourceStore::open_in_memory().expect("store open");
    let source = Source::new_local_folder(dir.path().to_string_lossy().to_string());
    store.add_source(&source).expect("add_source");

    let stub = Arc::new(FailThenSucceedStub::new(
        "A close-up photo of a circuit board.",
        "test-image-vlm",
    ));
    let stub_dyn: Arc<dyn VisionExtractor> = stub.clone();
    let indexer = Indexer::new(&[]).with_vision_extractor(stub_dyn);

    // First pass: VLM stub errors → row stamped `partial:`.
    indexer
        .index_single_file(&source.id, &png_path, &store)
        .expect("first index_single_file must succeed");
    assert_eq!(
        stub.call_count(),
        1,
        "first pass must invoke the VLM exactly once"
    );

    // Second pass: stored hash is `partial:...`, real hash is
    // raw `...`, so `get_file_hash` mismatches and the file gets
    // re-processed; this time the stub succeeds.
    indexer
        .index_single_file(&source.id, &png_path, &store)
        .expect("second index_single_file must succeed");
    assert_eq!(
        stub.call_count(),
        2,
        "second pass must retry the VLM call after the partial sentinel"
    );

    // After the successful retry the row must be stamped with the
    // real hash (no `partial:` prefix) so subsequent unchanged
    // passes short-circuit correctly.
    let stored_hash = store
        .get_file_hash(&png_path.to_string_lossy())
        .expect("get_file_hash must succeed")
        .expect("row must still exist after retry");
    assert!(
        !stored_hash.starts_with("partial:"),
        "successful VLM retry must clear the partial sentinel; got hash={stored_hash}"
    );

    let chunks = store
        .all_chunks_for_path(&png_path.to_string_lossy())
        .expect("chunk fetch must succeed");
    assert!(
        chunks
            .iter()
            .any(|c| c.content.contains("A close-up photo of a circuit board.")),
        "after the successful retry the VLM-derived chunk must be present; chunks={:?}",
        chunks.iter().map(|c| &c.content).collect::<Vec<_>>()
    );
}
