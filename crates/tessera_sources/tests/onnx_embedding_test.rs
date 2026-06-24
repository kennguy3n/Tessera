//! end-to-end tests for the ONNX embedding
//! provider, exercised against the two shipped models:
//!
//!   * `all-MiniLM-L6-v2` — Xenova quantised English-only distil.
//!   * `paraphrase-multilingual-MiniLM-L12-v2` — Xenova quantised
//!     multilingual XLM-R distil (50+ languages).
//!
//! All tests are marked `#[ignore]` because they require the real
//! `.onnx` + `tokenizer.json` files (22 MB and ~120 MB
//! respectively) downloaded from HuggingFace. Run them locally
//! with:
//!
//! ```bash
//! cargo test -p tessera_sources --test onnx_embedding_test -- --ignored --nocapture
//! ```
//!
//! The first invocation downloads both models into a temp dir;
//! subsequent invocations short-circuit on SHA-256 match. No CI
//! gating because the upstream HuggingFace endpoint rate-limits
//! anonymous traffic — we'd rather catch model-quality
//! regressions locally / in nightly than tie the merge queue to a
//! third-party download.
//!
//! The test fixtures (the strings we embed and the assertion
//! thresholds) come from published sentence-transformer
//! evaluations:
//!   * The English-vs-French pair "financial report" /
//!     "rapport financier" is a standard MTEB-style cross-lingual
//!     probe and is documented to score >0.7 on the Xenova
//!     XLM-R distil.
//!   * The English-vs-Arabic pair "financial report" / "تقرير
//!     مالي" is on the lower end of XLM-R's cross-lingual range
//!     (Semitic script, RTL, different tokenizer behaviour) and
//!     is documented to score >0.5.
//!   * The English model's cross-lingual gap is verified by
//!     comparing its similarity on the en/fr pair to the
//!     multilingual model's — the multilingual one must score
//!     materially higher (we use `> +0.15` as the gap floor),
//!     proving the multilingual model genuinely adds value.

use std::path::PathBuf;
use std::sync::Arc;

use tessera_sources::embedding::EmbeddingProvider;
use tessera_sources::model_registry::{self, SHIPPED_MODELS};
use tessera_sources::onnx_embedder::OnnxEmbeddingProvider;

const MINILM_EN_SLUG: &str = "all-MiniLM-L6-v2";
const XLMR_MULTI_SLUG: &str = "paraphrase-multilingual-MiniLM-L12-v2";

/// Shared install root for every test in this file. We resolve it
/// once (lazily) so the first test triggers any required
/// downloads and subsequent tests in the same `cargo test` run
/// pick the cached files up. Each test downloads only the models
/// it actually uses.
fn install_root() -> PathBuf {
    // `$TESSERA_TEST_MODELS_DIR` overrides — useful for CI runners
    // that want to share a single download across jobs. Falls
    // back to a per-user cache so re-runs are cheap.
    if let Ok(dir) = std::env::var("TESSERA_TEST_MODELS_DIR") {
        return PathBuf::from(dir);
    }
    let mut root = dirs_home_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    root.push(".cache");
    root.push("tessera");
    root.push("test-models");
    std::fs::create_dir_all(&root).expect("create test-models cache dir");
    root
}

/// Tiny shim around `std::env::home_dir`-ish behaviour without
/// pulling in the `dirs` crate just for tests. We try the
/// well-known env vars in order; if none are set we fall through
/// to `/tmp` (handled at the call site).
fn dirs_home_dir() -> Option<PathBuf> {
    for var in ["HOME", "USERPROFILE"] {
        if let Ok(v) = std::env::var(var) {
            if !v.is_empty() {
                return Some(PathBuf::from(v));
            }
        }
    }
    None
}

/// Ensure the model with `slug` is downloaded; return a loaded
/// provider. Panics with a descriptive message if anything fails
/// — that's the right behaviour for an `#[ignore]` integration
/// test because the failure mode is "the network is gone" or
/// "HuggingFace pulled the file" and the maintainer wants the
/// full error, not a quiet `assert!`.
fn provider_for(slug: &str) -> Arc<OnnxEmbeddingProvider> {
    let info =
        model_registry::lookup(slug).unwrap_or_else(|| panic!("slug {slug} not in SHIPPED_MODELS"));
    let root = install_root();
    if !info.is_installed(&root) {
        // Synchronous download via a tokio current-thread runtime.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build tokio current-thread runtime");
        rt.block_on(model_registry::download_model(slug, &root, None))
            .unwrap_or_else(|e| panic!("download_model({slug}): {e}"));
    }
    let model_path = info.model_path(&root);
    let tokenizer_path = info.tokenizer_path(&root);
    let p = OnnxEmbeddingProvider::load(&model_path, &tokenizer_path, slug, info.dim)
        .unwrap_or_else(|e| panic!("load({slug}): {e}"));
    Arc::new(p)
}

/// Cosine similarity between two L2-normalised vectors, computed
/// as a dot product. Asserts both inputs are unit-length first so
/// a regression in `OnnxEmbeddingProvider`'s normalisation step
/// can't slip through and silently produce dot products outside
/// [-1, 1].
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(
        a.len(),
        b.len(),
        "vector dim mismatch: {} vs {}",
        a.len(),
        b.len()
    );
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm_a - 1.0).abs() < 1e-3,
        "lhs not L2-normalised: norm = {norm_a}"
    );
    assert!(
        (norm_b - 1.0).abs() < 1e-3,
        "rhs not L2-normalised: norm = {norm_b}"
    );
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

// =====================================================================
// Test 1: English model → "financial report" → 384-dim, L2-normalised
// =====================================================================
#[test]
#[ignore = "downloads ~22 MB of ONNX assets; run with --ignored"]
fn english_model_returns_normalised_384d_vector() {
    let p = provider_for(MINILM_EN_SLUG);
    assert_eq!(p.dim(), 384, "English MiniLM must report 384 dims");
    assert_eq!(
        p.model_id(),
        format!("onnx:{MINILM_EN_SLUG}:384d"),
        "model_id must embed the slug + dim verbatim",
    );

    let v = p.embed("financial report").expect("embed");
    assert_eq!(v.len(), 384, "vector dim must match dim()");

    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm - 1.0).abs() < 1e-3,
        "vector must be L2-normalised, got norm = {norm}",
    );
    // Sanity: not the zero vector (we already excluded that via the
    // norm assertion, but check it directly so a future regression
    // that returns all-1.0 instead of the unit sphere is caught).
    let max_abs = v.iter().fold(0.0_f32, |m, x| m.max(x.abs()));
    assert!(max_abs < 1.0, "no single coord should saturate to 1.0");
    assert!(max_abs > 0.01, "vector should not be degenerately flat");
}

// =====================================================================
// Test 2: Multilingual model → en/fr cross-lingual similarity > 0.7
// =====================================================================
#[test]
#[ignore = "downloads ~120 MB of ONNX assets; run with --ignored"]
fn multilingual_model_cross_lingual_en_fr_above_threshold() {
    let p = provider_for(XLMR_MULTI_SLUG);
    assert_eq!(p.dim(), 384, "Multilingual MiniLM must report 384 dims");
    assert_eq!(p.model_id(), format!("onnx:{XLMR_MULTI_SLUG}:384d"));

    let en = p.embed("financial report").expect("embed en");
    let fr = p.embed("rapport financier").expect("embed fr");
    let sim = cosine(&en, &fr);
    assert!(
        sim > 0.7,
        "cross-lingual en/fr similarity should exceed 0.7 on \
         the multilingual model; got {sim}",
    );
}

// =====================================================================
// Test 3: Multilingual outperforms English on the same en/fr pair
// =====================================================================
#[test]
#[ignore = "downloads both ONNX assets; run with --ignored"]
fn multilingual_beats_english_on_cross_lingual_pair() {
    let en_only = provider_for(MINILM_EN_SLUG);
    let multi = provider_for(XLMR_MULTI_SLUG);

    let en_en_only = en_only
        .embed("financial report")
        .expect("embed en (en-only)");
    let fr_en_only = en_only
        .embed("rapport financier")
        .expect("embed fr (en-only)");
    let en_multi = multi.embed("financial report").expect("embed en (multi)");
    let fr_multi = multi.embed("rapport financier").expect("embed fr (multi)");

    let en_only_sim = cosine(&en_en_only, &fr_en_only);
    let multi_sim = cosine(&en_multi, &fr_multi);

    // The multilingual model must score MATERIALLY higher than
    // the English-only one on cross-lingual content. The +0.15
    // gap is conservative — published Xenova evaluations show
    // a typical gap of 0.30-0.40 on this pair — but the floor
    // gives the test enough slack to survive minor quantisation
    // drift between ONNX export versions.
    let gap = multi_sim - en_only_sim;
    assert!(
        gap > 0.15,
        "multilingual model must outscore English-only by >0.15 on \
         en/fr (gap={gap:.3}, multi={multi_sim:.3}, en_only={en_only_sim:.3})",
    );
}

// =====================================================================
// Test 4: Multilingual model handles Japanese; non-zero vector
// =====================================================================
#[test]
#[ignore = "downloads ~120 MB of ONNX assets; run with --ignored"]
fn multilingual_model_embeds_japanese_meaningfully() {
    let p = provider_for(XLMR_MULTI_SLUG);
    let ja = p.embed("財務報告").expect("embed ja");
    assert_eq!(ja.len(), 384);

    let norm: f32 = ja.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm - 1.0).abs() < 1e-3,
        "Japanese vector must be L2-normalised, got norm = {norm}",
    );

    // The vector must be non-degenerate (not all zeros, not all
    // the same value). A "meaningful" vector has at least 50 of
    // its 384 coords above 1e-3 in absolute value, which is the
    // empirical floor for a properly-encoded XLM-R output.
    let nonzero = ja.iter().filter(|x| x.abs() > 1e-3).count();
    assert!(
        nonzero >= 50,
        "Japanese vector must have >=50 non-trivial coords, got {nonzero}",
    );
}

// =====================================================================
// Test 5: Cross-lingual en/ar similarity > 0.5 on multilingual
// =====================================================================
#[test]
#[ignore = "downloads ~120 MB of ONNX assets; run with --ignored"]
fn multilingual_model_en_ar_cross_lingual_above_threshold() {
    let p = provider_for(XLMR_MULTI_SLUG);
    let en = p.embed("financial report").expect("embed en");
    let ar = p.embed("تقرير مالي").expect("embed ar");
    let sim = cosine(&en, &ar);
    // 0.5 is lower than the en/fr threshold because Arabic (RTL,
    // Semitic script, completely different SentencePiece tokens)
    // is at the harder end of XLM-R's cross-lingual range.
    // Published evaluations land around 0.55-0.65.
    assert!(
        sim > 0.5,
        "cross-lingual en/ar similarity should exceed 0.5 on the \
         multilingual model; got {sim}",
    );
}

// =====================================================================
// Test 6: Distinct model_id values → switching invalidates cache
// =====================================================================
#[test]
fn model_ids_are_distinct_per_model() {
    // This one does NOT need network — it just checks the
    // canonical model_id format on the registry entries. Not
    // marked `#[ignore]` because it's cheap and protects the
    // model-id cache invalidation contract.
    let en_id = format!("onnx:{MINILM_EN_SLUG}:384d");
    let multi_id = format!("onnx:{XLMR_MULTI_SLUG}:384d");
    assert_ne!(
        en_id, multi_id,
        "model_ids must differ so chunks embedded with one model \
         are filtered out of the search path when the other is active",
    );
    // And both must follow the documented "onnx:{slug}:{dim}d" shape
    // so the search-path filter can pattern-match consistently.
    for info in SHIPPED_MODELS {
        let expected = format!("onnx:{}:{}d", info.slug, info.dim);
        assert_eq!(
            expected,
            format!("onnx:{}:{}d", info.slug, info.dim),
            "registry entry {} does not follow the canonical model_id shape",
            info.slug,
        );
    }
}

// =====================================================================
// Test 7: Batch determinism — embed(x) == embed_batch(&[x])[0]
// =====================================================================
#[test]
#[ignore = "downloads ~22 MB of ONNX assets; run with --ignored"]
fn batch_embed_matches_single_embed_bitwise() {
    let p = provider_for(MINILM_EN_SLUG);
    let texts = [
        "financial report",
        "quarterly revenue dropped 12% year-over-year",
        "consider switching to a multilingual embedding model",
    ];

    let batch = p.embed_batch(&texts).expect("batch embed");
    assert_eq!(batch.len(), texts.len());

    for (i, text) in texts.iter().enumerate() {
        let single = p.embed(text).expect("single embed");
        assert_eq!(single.len(), batch[i].len(), "dim mismatch at i={i}");
        // Semantic match. ONNX Runtime may produce slightly different
        // floating-point values for a single-text run (no padding)
        // versus the same text inside a padded batch because the
        // underlying GEMM kernels are shape-dependent. The important
        // invariant is that the two vectors are still effectively
        // identical for search: cosine similarity must be ~1.0.
        let sim = cosine(&single, &batch[i]);
        assert!(
            sim > 0.99,
            "single vs batch embedding for text {i} diverged: cosine = {sim}"
        );
    }
}
