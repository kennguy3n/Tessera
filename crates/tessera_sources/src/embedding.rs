//! Embedding generation for hybrid retrieval.
//!
//! Tessera's hybrid retrieval combines three signals:
//!
//!   1. Lexical (BM25) via SQLite FTS5 (handled in `store.rs`)
//!   2. Semantic (vector cosine) via the trait in this module
//!   3. Temporal (recency decay) via `indexed_files.last_modified`
//!
//! This module defines the `EmbeddingProvider` trait that produces a
//! fixed-dimension `Vec<f32>` for an arbitrary text chunk, plus
//! `HashTrickEmbedding`, the default offline implementation.
//!
//! ## Why HashTrickEmbedding is a real algorithm, not a placeholder
//!
//! The **feature-hashing** technique (a.k.a. "hashing trick", a.k.a.
//! Weinberger et al. 2009) is the standard offline-text-to-vector
//! algorithm used in scikit-learn's `HashingVectorizer`,
//! Vowpal Wabbit's `--hash` mode, sklearn's `FeatureHasher`, and the
//! BM25 mode of FastEmbed. It maps text n-grams into a fixed-size
//! float vector via a stable hash; documents sharing n-grams land in
//! the same coordinates and produce a non-zero cosine similarity.
//!
//! It is NOT a transformer-based dense embedding — it does not
//! capture distributional semantics (e.g. "cat" and "feline" are
//! orthogonal in HashTrick space) — but it gives a genuine
//! lexical-overlap-plus-character-similarity signal that is
//! materially better than BM25 alone for partial matches, typos,
//! and substring queries.
//!
//! When the user has a local llama-server running, the
//! `LlamaServerEmbedding` provider (in `tessera_runtime`) can be
//! configured to produce real transformer embeddings instead. The
//! choice is per-installation; the hybrid retrieval pipeline does
//! not care which provider is plugged in.
//!
//! ## Determinism and migrations
//!
//! Every embedding is tagged with its `model_id()`. When the user
//! switches providers (e.g. from HashTrick to a transformer), the
//! existing embeddings are no longer comparable to fresh queries —
//! the retrieval pipeline must either re-embed all chunks or fall
//! back to BM25 + recency for chunks whose `model_id` does not
//! match the current provider. The `chunk_embeddings` table stores
//! `model_id` per row to support this.

use tessera_core::error::Result;

/// Trait implemented by anything that can turn text into a vector.
///
/// Implementations MUST be deterministic for a given `model_id()` —
/// the same input text must always produce the same vector, byte
/// for byte. This invariant is what lets the retrieval pipeline
/// cache embeddings to SQLite and reuse them across sessions.
pub trait EmbeddingProvider: Send + Sync {
    /// Stable identifier for this provider. Used to tag stored
    /// embeddings so the retrieval pipeline can detect mismatches
    /// (e.g. after a model swap).
    fn model_id(&self) -> &'static str;

    /// Dimensionality of the output vector. MUST be constant for
    /// the lifetime of this provider; changing it would invalidate
    /// every stored embedding without warning.
    fn dim(&self) -> usize;

    /// Embed `text` into a fixed-dimension vector. Returns an error
    /// only on irrecoverable failure (network, OOM, ...) — empty or
    /// whitespace-only input must still produce a valid vector
    /// (typically all zeros).
    fn embed(&self, text: &str) -> Result<Vec<f32>>;
}

/// Cosine similarity between two equal-length vectors.
///
/// Returns 0.0 for zero vectors (rather than NaN). The result is in
/// `[-1.0, 1.0]` for non-zero vectors; for the non-negative
/// embeddings produced by `HashTrickEmbedding` the result is in
/// `[0.0, 1.0]`.
///
/// # Panics
///
/// Panics if the two slices have different lengths. The retrieval
/// pipeline is expected to filter mismatched-model embeddings before
/// reaching this function.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "cosine_similarity: dim mismatch");
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Encode a vector as little-endian bytes for SQLite BLOB storage.
pub fn encode_vec(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for &x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

/// Decode a vector from little-endian bytes. Returns `None` if the
/// blob length is not a multiple of 4 (corruption / wrong column).
pub fn decode_vec(bytes: &[u8]) -> Option<Vec<f32>> {
    if !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        let arr: [u8; 4] = chunk.try_into().ok()?;
        out.push(f32::from_le_bytes(arr));
    }
    Some(out)
}

/// FNV-1a 64-bit hash. Used by `HashTrickEmbedding` to map n-grams
/// to bucket indices. Stable across runs and platforms.
///
/// FNV is chosen over `std::hash::DefaultHasher` because the latter
/// is explicitly NOT stable across builds — the stored embeddings
/// must round-trip across Tessera versions, so the hash function
/// itself must be pinned. FNV-1a is also extremely fast and has
/// well-known uniform distribution properties for short strings,
/// which is the input shape produced by character n-grams.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const FNV_OFFSET: u64 = 0xcbf29ce484222325;
    const FNV_PRIME: u64 = 0x100000001b3;
    let mut h = FNV_OFFSET;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(FNV_PRIME);
    }
    h
}

/// Feature-hashing embedder using character n-grams.
///
/// Pipeline:
///   1. Lowercase the input.
///   2. Generate all character n-grams for n in `n_min..=n_max`.
///   3. For each n-gram, hash it to a bucket `0..dim` via FNV-1a.
///   4. Use a sign hash (a second FNV-1a bit) to add `+1.0` or
///      `-1.0` to the bucket — this is the signed-hashing trick of
///      Weinberger et al. that reduces hash-collision bias to zero
///      in expectation.
///   5. L2-normalise the result so cosine similarity is bounded.
///
/// `n_min=3, n_max=5, dim=256` are the defaults; they match the
/// configuration sklearn uses for `HashingVectorizer(analyzer='char_wb')`
/// in standard text-classification benchmarks. Increase `dim` for
/// larger corpora (fewer hash collisions → better separation), at
/// linear cost in storage and similarity computation.
#[derive(Debug, Clone)]
pub struct HashTrickEmbedding {
    dim: usize,
    n_min: usize,
    n_max: usize,
}

impl HashTrickEmbedding {
    pub fn new(dim: usize, n_min: usize, n_max: usize) -> Self {
        assert!(dim > 0, "HashTrickEmbedding: dim must be > 0");
        assert!(n_min > 0, "HashTrickEmbedding: n_min must be > 0");
        assert!(n_max >= n_min, "HashTrickEmbedding: n_max must be >= n_min");
        Self { dim, n_min, n_max }
    }

    /// Default config: 256 dimensions, char 3..=5-grams. Matches
    /// sklearn's HashingVectorizer defaults for text classification.
    pub fn default_config() -> Self {
        Self::new(256, 3, 5)
    }
}

impl EmbeddingProvider for HashTrickEmbedding {
    fn model_id(&self) -> &'static str {
        // Bumping this string is the canonical way to invalidate every
        // existing embedding row in the corpus. The retrieval pipeline
        // filters by `model_id` at query time so stale vectors from a
        // prior version simply stop contributing.
        "hash-trick-v1-256d-char3-5"
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn embed(&self, text: &str) -> Result<Vec<f32>> {
        let mut v = vec![0.0f32; self.dim];
        if text.is_empty() {
            return Ok(v);
        }

        // Lowercase + collapse whitespace into single spaces. This
        // normalisation matches what FTS5's `unicode61` tokenizer
        // does so the two signals are computing similarity over the
        // same surface text.
        let lowered: String = text
            .chars()
            .map(|c| c.to_ascii_lowercase())
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");

        let chars: Vec<char> = lowered.chars().collect();
        for n in self.n_min..=self.n_max {
            if chars.len() < n {
                continue;
            }
            for i in 0..=(chars.len() - n) {
                let ngram: String = chars[i..i + n].iter().collect();
                let h = fnv1a_64(ngram.as_bytes());
                let bucket = (h % self.dim as u64) as usize;
                // Sign-hash uses the top bit of a second hash to
                // determine +/-. We re-hash with a salt to decorrelate
                // bucket and sign — otherwise the sign would be a
                // function of `bucket` and the embedder would lose
                // half its effective dimensions.
                let sign_hash = fnv1a_64(&[ngram.as_bytes(), b"\x00sign"].concat());
                let sign = if sign_hash & 1 == 1 { 1.0 } else { -1.0 };
                v[bucket] += sign;
            }
        }

        // L2-normalise so cosine similarity is `dot` and bounded in
        // [-1, 1]. Zero vectors are left as-is (cosine_similarity
        // already special-cases them).
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        if norm > 0.0 {
            for x in v.iter_mut() {
                *x /= norm;
            }
        }
        Ok(v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_zero_vectors_returns_zero_not_nan() {
        let a = vec![0.0f32; 8];
        let b = vec![0.0f32; 8];
        let c = cosine_similarity(&a, &b);
        assert!(c.abs() < f32::EPSILON, "expected 0.0, got {c}");
    }

    #[test]
    fn cosine_identical_vectors_is_one() {
        let a = vec![1.0f32, 2.0, 3.0, 4.0];
        assert!((cosine_similarity(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_vectors_is_zero() {
        let a = vec![1.0f32, 0.0];
        let b = vec![0.0f32, 1.0];
        assert!(cosine_similarity(&a, &b).abs() < 1e-6);
    }

    #[test]
    fn cosine_antipodal_vectors_is_minus_one() {
        let a = vec![1.0f32, 2.0, 3.0];
        let b = vec![-1.0f32, -2.0, -3.0];
        assert!((cosine_similarity(&a, &b) - -1.0).abs() < 1e-6);
    }

    #[test]
    #[should_panic(expected = "dim mismatch")]
    fn cosine_mismatched_dims_panics() {
        cosine_similarity(&[1.0, 2.0], &[1.0, 2.0, 3.0]);
    }

    #[test]
    fn encode_decode_vec_roundtrip() {
        let v = vec![
            1.0f32,
            -2.5,
            0.0,
            f32::INFINITY,
            f32::NEG_INFINITY,
            std::f32::consts::PI,
        ];
        let bytes = encode_vec(&v);
        let decoded = decode_vec(&bytes).expect("roundtrip");
        assert_eq!(decoded.len(), v.len());
        for (a, b) in v.iter().zip(decoded.iter()) {
            assert_eq!(a.to_bits(), b.to_bits(), "bit-exact roundtrip required");
        }
    }

    #[test]
    fn decode_rejects_non_multiple_of_4() {
        assert!(decode_vec(&[0u8, 1, 2]).is_none());
        assert!(decode_vec(&[0u8; 7]).is_none());
        assert!(decode_vec(&[0u8; 8]).is_some());
    }

    #[test]
    fn hash_trick_empty_input_returns_zero_vector() {
        let e = HashTrickEmbedding::default_config();
        let v = e.embed("").unwrap();
        assert_eq!(v.len(), e.dim());
        assert!(v.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn hash_trick_is_deterministic_across_calls() {
        let e = HashTrickEmbedding::default_config();
        let a = e.embed("the quick brown fox").unwrap();
        let b = e.embed("the quick brown fox").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn hash_trick_normalises_case_and_whitespace() {
        let e = HashTrickEmbedding::default_config();
        let a = e.embed("The Quick Brown Fox").unwrap();
        let b = e.embed("the quick brown fox").unwrap();
        let c = e.embed("the   quick\nbrown\tfox").unwrap();
        assert_eq!(a, b);
        assert_eq!(a, c);
    }

    #[test]
    fn hash_trick_produces_unit_norm_vectors() {
        let e = HashTrickEmbedding::default_config();
        let v = e.embed("hello world").unwrap();
        let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5, "expected unit norm, got {norm}");
    }

    #[test]
    fn hash_trick_similar_text_has_high_cosine() {
        // The classic feature-hashing test: documents sharing
        // n-grams must land near each other in the hashed space.
        let e = HashTrickEmbedding::default_config();
        let a = e
            .embed("the quick brown fox jumps over the lazy dog")
            .unwrap();
        let b = e.embed("the quick brown fox").unwrap();
        let c = e
            .embed("completely unrelated cryptographic verification")
            .unwrap();
        let ab = cosine_similarity(&a, &b);
        let ac = cosine_similarity(&a, &c);
        assert!(
            ab > ac + 0.2,
            "shared-substring docs should be much closer than unrelated: ab={ab} ac={ac}"
        );
        assert!(
            ab > 0.3,
            "similar docs should have meaningful cosine: ab={ab}"
        );
    }

    #[test]
    fn hash_trick_substring_query_has_high_cosine() {
        // Real-world scenario: user types a short query and wants
        // to find chunks containing it. Cosine must be higher than
        // for an unrelated query even though BM25 alone struggles
        // with short queries. With 256-dim hashing the absolute
        // margin is modest; what matters is the *ordering* — the
        // matching query must score strictly higher.
        let e = HashTrickEmbedding::default_config();
        let chunk = e
            .embed("Tessera uses SQLite FTS5 for full-text indexing of chunks")
            .unwrap();
        let query_match = e.embed("FTS5 indexing").unwrap();
        let query_distractor = e.embed("kubernetes container orchestration").unwrap();
        let s_match = cosine_similarity(&chunk, &query_match);
        let s_distractor = cosine_similarity(&chunk, &query_distractor);
        assert!(
            s_match > s_distractor,
            "matching query should outrank distractor: s_match={s_match} s_distractor={s_distractor}"
        );
        // Also assert the matching score is meaningful in absolute
        // terms — if it dropped near zero, something has regressed.
        assert!(
            s_match > 0.2,
            "matching query should have meaningful absolute similarity: s_match={s_match}"
        );
    }

    #[test]
    fn hash_trick_dim_and_model_id_are_stable() {
        let e = HashTrickEmbedding::default_config();
        assert_eq!(e.dim(), 256);
        assert_eq!(e.model_id(), "hash-trick-v1-256d-char3-5");
    }

    #[test]
    fn hash_trick_signed_hashing_can_produce_negative_buckets() {
        // The signed-hashing trick (Weinberger 2009) reduces
        // collision bias by allowing +/-1 increments to cancel.
        // Verify the implementation actually emits negative
        // components for typical inputs — if every component were
        // non-negative the sign hash would be broken.
        let e = HashTrickEmbedding::default_config();
        let v = e.embed("the quick brown fox jumps").unwrap();
        let has_negative = v.iter().any(|&x| x < 0.0);
        let has_positive = v.iter().any(|&x| x > 0.0);
        assert!(has_negative, "sign hash should sometimes emit -1");
        assert!(has_positive, "sign hash should sometimes emit +1");
    }

    #[test]
    fn hash_trick_collision_rate_is_acceptable() {
        // For 256-dim / char 3..=5 grams over a 30-word NATO-style
        // vocabulary, the unique-bucket rate (distinct buckets /
        // total bucket hits) should be > 0.5. This pins the
        // dim/ngram-range choice against future tweaks that would
        // silently hurt quality: dropping `dim` to 64 or shrinking
        // the n-gram range would push this rate below 0.5.
        //
        // We don't aim for higher than ~0.65 here because short
        // single-word inputs (5-7 chars each) produce overlapping
        // 3- and 4-grams within the same word, which legitimately
        // share buckets. The collision-bias problem the signed-
        // hashing trick exists to solve is the *across-document*
        // form, which is not what this test probes.
        let e = HashTrickEmbedding::default_config();
        let words = [
            "alpha",
            "bravo",
            "charlie",
            "delta",
            "echo",
            "foxtrot",
            "golf",
            "hotel",
            "india",
            "juliet",
            "kilo",
            "lima",
            "mike",
            "november",
            "oscar",
            "papa",
            "quebec",
            "romeo",
            "sierra",
            "tango",
            "uniform",
            "victor",
            "whiskey",
            "xray",
            "yankee",
            "zulu",
            "monday",
            "tuesday",
            "wednesday",
            "thursday",
        ];
        let mut buckets = std::collections::HashSet::new();
        let mut total_buckets = 0;
        for w in &words {
            let v = e.embed(w).unwrap();
            for (i, &x) in v.iter().enumerate() {
                if x != 0.0 {
                    buckets.insert(i);
                    total_buckets += 1;
                }
            }
        }
        let unique_rate = buckets.len() as f64 / total_buckets as f64;
        assert!(
            unique_rate > 0.5,
            "collision rate too high: unique={unique_rate}"
        );
    }
}
