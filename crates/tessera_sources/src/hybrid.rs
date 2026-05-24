//! Hybrid retrieval: combines BM25 lexical scoring, vector
//! similarity, and temporal recency into a single ranked list.
//!
//! ## Why three signals
//!
//! Each signal captures something the others miss:
//!
//! - **BM25 (FTS5)** rewards exact term matches and is dominant for
//!   keyword queries (e.g. "hybrid retrieval"). It struggles with
//!   typos, abbreviations, paraphrases, and short queries.
//! - **Vector cosine** rewards lexical-or-semantic similarity. With
//!   the `HashTrickEmbedding` provider it captures character n-gram
//!   overlap (helps with typos, partial matches, and substring
//!   queries). With a transformer-backed provider it additionally
//!   captures distributional semantics ("cat" ≈ "feline").
//! - **Recency** rewards freshly-indexed chunks via exponential
//!   decay on `indexed_files.last_modified`. Critical for evolving
//!   knowledge bases where the user wants "the latest version of
//!   the spec", not the version from six months ago.
//!
//! ## Fusion strategy: Reciprocal Rank Fusion (RRF)
//!
//! We use **Reciprocal Rank Fusion** (Cormack, Clarke, and Buettcher
//! 2009) as the combiner. RRF is the de facto industry standard for
//! hybrid retrieval — used by Elasticsearch's `_rrf`, OpenSearch's
//! `hybrid` query, Vespa's `reciprocal_rank_fusion`, and most
//! production RAG systems including LangChain's `EnsembleRetriever`.
//!
//! The score for a document in the combined ranking is:
//!
//! ```text
//!   score(d) = Σᵢ wᵢ / (k + rankᵢ(d))
//! ```
//!
//! where `i` ranges over the input rankings (BM25, vector), `wᵢ` is
//! a per-signal weight (default 1.0 for both), `rankᵢ(d)` is `d`'s
//! 1-based rank in ranking `i` (or `∞` if absent), and `k` is the
//! RRF damping constant (default 60, per Cormack et al. — large
//! enough to dampen the dominance of top-ranked items so lower-
//! ranked items in one list can still surface if they're top of the
//! other).
//!
//! Recency is applied multiplicatively on top of the RRF score using a
//! true half-life decay:
//!
//! ```text
//!   final(d) = score(d) * 2^(-Δt(d) / halflife)
//!            = score(d) * exp(-Δt(d) * ln(2) / halflife)
//! ```
//!
//! where `Δt(d)` is the age in seconds and `halflife` is configurable
//! (default 30 days). At one half-life the multiplier is exactly 0.5;
//! at two half-lives 0.25; and so on. (The `ln(2)` factor is what
//! converts the natural-exponent form into a true half-life — without
//! it the multiplier at one half-life would be `1/e ≈ 0.368` instead
//! of `0.5`. The `recency_one_halflife_is_half` regression test in
//! this module pins the correct behaviour.) Chunks with no
//! `last_modified` get a recency multiplier of 1.0 (neutral).
//!
//! ## Why RRF over weighted-sum-of-normalised-scores
//!
//! BM25 and cosine produce scores on incomparable scales (BM25 is
//! unbounded and corpus-dependent; cosine is in [-1, 1]). Any
//! linear combination requires per-corpus tuning of weights and
//! normalisation. RRF sidesteps this entirely by operating on ranks,
//! not scores — it is parameter-free up to `k`, and `k=60` works
//! across most corpora out of the box (this is the value Cormack
//! et al. recommend and is what Elasticsearch defaults to).

use crate::embedding::{cosine_similarity, EmbeddingProvider};
use crate::store::{ChunkEmbeddingRow, SourceStore};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tessera_core::error::{Error, Result};

/// Reciprocal Rank Fusion damping constant. The value Cormack,
/// Clarke, and Buettcher (2009) recommend; matches Elasticsearch's
/// default. Higher values dampen the dominance of top-ranked items.
pub const RRF_K: f64 = 60.0;

/// Default recency half-life: chunks lose half their multiplier
/// every 30 days. Chosen to be relevant on the time-scale of
/// project work without overpenalising older reference material.
pub const DEFAULT_RECENCY_HALFLIFE_SECS: f64 = 30.0 * 24.0 * 60.0 * 60.0;

/// Custom (de)serializer for [`HybridSearchConfig::recency_halflife_secs`].
///
/// The runtime sentinel for "disable recency decay" is `f64::INFINITY`
/// (see [`recency_multiplier`]), but `serde_json` lowers `INFINITY`
/// (and `NaN`) to JSON `null`, which then fails to round-trip back
/// to a bare `f64` field on deserialize. So we shape the wire format
/// explicitly as `number | null`:
///
///   * finite, positive number → number on the wire
///   * `f64::INFINITY` (no decay) → JSON `null` on the wire
///   * JSON `null` on read → `f64::INFINITY` in memory
///
/// This makes `HybridSearchConfig` safely persistable through the
/// renderer's `config.ts` JSON store and through `bridge_*` IPC
/// envelopes without losing the "decay disabled" semantic.
mod halflife_serde {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    // The `&f64` arg shape is fixed by serde's `serialize_with`
    // contract; clippy's trivially-copy-pass-by-ref lint can't see
    // through that constraint.
    #[allow(clippy::trivially_copy_pass_by_ref)]
    pub fn serialize<S>(value: &f64, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        if value.is_finite() {
            value.serialize(serializer)
        } else {
            serializer.serialize_none()
        }
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<f64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let opt: Option<f64> = Option::deserialize(deserializer)?;
        Ok(opt.unwrap_or(f64::INFINITY))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HybridSearchConfig {
    /// Weight applied to the BM25 ranking in RRF. Default 1.0.
    pub bm25_weight: f64,
    /// Weight applied to the vector-cosine ranking in RRF.
    /// Default 1.0. Set to 0.0 to disable vector search (e.g. when
    /// no embeddings are computed yet).
    pub vector_weight: f64,
    /// RRF damping constant. Default `RRF_K` (60.0).
    pub rrf_k: f64,
    /// Recency half-life in seconds. Default 30 days. Set to
    /// `f64::INFINITY` to disable recency decay (multiplier = 1.0
    /// for all chunks). On the JSON wire this is represented as
    /// `null`; see [`halflife_serde`] for the round-trip contract.
    #[serde(with = "halflife_serde")]
    pub recency_halflife_secs: f64,
    /// How many candidates to retrieve from each individual ranking
    /// before fusion. Defaults to 4× the requested limit so the
    /// fused output has enough candidates to choose from. Setting
    /// this too low causes the fusion to miss items that would
    /// rank well after combination.
    pub candidate_pool_size: usize,
}

impl Default for HybridSearchConfig {
    fn default() -> Self {
        Self {
            bm25_weight: 1.0,
            vector_weight: 1.0,
            rrf_k: RRF_K,
            recency_halflife_secs: DEFAULT_RECENCY_HALFLIFE_SECS,
            candidate_pool_size: 0, // 0 means "4× limit", set in apply()
        }
    }
}

/// Partial-update payload accepted by
/// [`SourceManager::update_hybrid_config`]. Fields that are `None`
/// keep their existing value; fields that are `Some` are validated
/// (see [`HybridSearchConfig::apply_patch`]) and applied atomically.
///
/// Lives in this crate (rather than the bridge layer) so the input
/// validation contract is co-located with the algorithm it feeds
/// — the bridge translates between IPC types and this struct, but
/// the source of truth for "what's a legal hybrid config" stays
/// in `tessera_sources`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HybridSearchConfigInput {
    pub bm25_weight: Option<f64>,
    pub vector_weight: Option<f64>,
    pub rrf_k: Option<f64>,
    pub recency_halflife_secs: Option<f64>,
    pub candidate_pool_size: Option<usize>,
}

impl HybridSearchConfig {
    /// Resolve `candidate_pool_size` against `limit`, applying the
    /// 4× default when the field is 0.
    fn pool_size(&self, limit: usize) -> usize {
        if self.candidate_pool_size > 0 {
            self.candidate_pool_size
        } else {
            (limit * 4).max(20)
        }
    }

    /// Apply a partial-update patch in-place. Returns `Err` and
    /// leaves the receiver untouched if any patched field is out of
    /// range, so callers can safely propagate the error to the user
    /// without rolling back manually.
    ///
    /// Validation rules:
    ///   * `bm25_weight` and `vector_weight` must be finite and
    ///     non-negative. Negative weights would invert the ranking;
    ///     `NaN` / `Inf` would poison every downstream RRF score.
    ///   * `rrf_k` must be finite and strictly positive — `k=0`
    ///     gives `1/(rank+1)` which is fine, but Cormack et al.'s
    ///     formulation assumes `k > 0` and `k=0` makes the score
    ///     unbounded for rank=0 inputs in degenerate edge cases.
    ///   * `recency_halflife_secs` must be either `f64::INFINITY`
    ///     (no decay) or strictly positive and finite. Zero / NaN /
    ///     negative would produce a multiplier of 0 or NaN for every
    ///     chunk and crater all search results.
    ///   * `candidate_pool_size` is bounded above at 10_000 so a
    ///     misconfigured renderer can't issue searches that
    ///     materialise hundreds of thousands of candidate rows on
    ///     every call. `0` is allowed and means "use the 4× default".
    pub fn apply_patch(&mut self, patch: &HybridSearchConfigInput) -> Result<()> {
        // Validate ALL patched fields first, then commit. This
        // makes the method transactional: a patch that touches
        // both `bm25_weight` (valid) and `recency_halflife_secs`
        // (invalid) leaves the config unchanged rather than
        // half-applied.
        if let Some(v) = patch.bm25_weight {
            if !v.is_finite() || v < 0.0 {
                return Err(Error::InvalidConfig(format!(
                    "hybrid bm25_weight must be a finite, non-negative number; got {v}"
                )));
            }
        }
        if let Some(v) = patch.vector_weight {
            if !v.is_finite() || v < 0.0 {
                return Err(Error::InvalidConfig(format!(
                    "hybrid vector_weight must be a finite, non-negative number; got {v}"
                )));
            }
        }
        if let Some(v) = patch.rrf_k {
            if !v.is_finite() || v <= 0.0 {
                return Err(Error::InvalidConfig(format!(
                    "hybrid rrf_k must be a finite, strictly positive number; got {v}"
                )));
            }
        }
        if let Some(v) = patch.recency_halflife_secs {
            // f64::INFINITY is explicitly allowed (means "no decay").
            // Everything else must be finite and strictly positive.
            if v != f64::INFINITY && (!v.is_finite() || v <= 0.0) {
                return Err(Error::InvalidConfig(format!(
                    "hybrid recency_halflife_secs must be Infinity or a finite, strictly positive number of seconds; got {v}"
                )));
            }
        }
        if let Some(v) = patch.candidate_pool_size {
            if v > 10_000 {
                return Err(Error::InvalidConfig(format!(
                    "hybrid candidate_pool_size must be <= 10000 (use 0 for the 4× limit default); got {v}"
                )));
            }
        }

        // All patched fields validated — commit.
        if let Some(v) = patch.bm25_weight {
            self.bm25_weight = v;
        }
        if let Some(v) = patch.vector_weight {
            self.vector_weight = v;
        }
        if let Some(v) = patch.rrf_k {
            self.rrf_k = v;
        }
        if let Some(v) = patch.recency_halflife_secs {
            self.recency_halflife_secs = v;
        }
        if let Some(v) = patch.candidate_pool_size {
            self.candidate_pool_size = v;
        }
        Ok(())
    }
}

/// A single hybrid-retrieval candidate ready to be fused. Produced
/// by each individual signal (BM25, vector) before RRF.
#[derive(Debug, Clone)]
pub struct RankedCandidate {
    pub chunk_id: i64,
    pub rank: usize,
}

/// Internal accumulator used to build the fused ranking. Public for
/// testability — most callers want `hybrid_score` or
/// `fuse_rankings` instead.
#[derive(Debug, Default, Clone)]
pub struct FusedScore {
    pub chunk_id: i64,
    pub rrf_score: f64,
    pub recency_multiplier: f64,
    pub final_score: f64,
}

/// Compute the RRF contribution of one ranked candidate to its
/// document's combined score. Exposed for unit testing — production
/// callers invoke `fuse_rankings` which aggregates over a full
/// ranking.
pub fn rrf_contribution(rank: usize, k: f64, weight: f64) -> f64 {
    // Rank is 1-based per the standard definition. We accept 0-based
    // input by adding 1.
    weight / (k + (rank + 1) as f64)
}

/// Compute the recency multiplier for a chunk based on its age in
/// seconds. Exposed for unit testing.
pub fn recency_multiplier(age_secs: f64, halflife_secs: f64) -> f64 {
    if !halflife_secs.is_finite() || halflife_secs <= 0.0 {
        return 1.0;
    }
    // exp(-age * ln(2) / halflife) — half every `halflife` seconds.
    let exponent = -age_secs * std::f64::consts::LN_2 / halflife_secs;
    exponent.exp()
}

/// Fuse two rankings (BM25 + vector) into a combined `FusedScore`
/// list, ordered by `final_score` descending. Pure function — no
/// I/O, no embeddings computed here. The caller is responsible for
/// producing the individual rankings and supplying the per-chunk
/// `last_modified` timestamps for recency decay.
pub fn fuse_rankings<S>(
    bm25: &[RankedCandidate],
    vector: &[RankedCandidate],
    ages_secs: &HashMap<i64, f64, S>,
    config: &HybridSearchConfig,
) -> Vec<FusedScore>
where
    S: std::hash::BuildHasher,
{
    let mut acc: HashMap<i64, f64> = HashMap::new();

    for c in bm25 {
        let contrib = rrf_contribution(c.rank, config.rrf_k, config.bm25_weight);
        *acc.entry(c.chunk_id).or_insert(0.0) += contrib;
    }
    for c in vector {
        let contrib = rrf_contribution(c.rank, config.rrf_k, config.vector_weight);
        *acc.entry(c.chunk_id).or_insert(0.0) += contrib;
    }

    let mut out: Vec<FusedScore> = acc
        .into_iter()
        .map(|(chunk_id, rrf_score)| {
            let age = ages_secs.get(&chunk_id).copied().unwrap_or(0.0);
            let recency = recency_multiplier(age, config.recency_halflife_secs);
            FusedScore {
                chunk_id,
                rrf_score,
                recency_multiplier: recency,
                final_score: rrf_score * recency,
            }
        })
        .collect();

    // Tiebreak on `chunk_id` ascending when two candidates have equal
    // `final_score`. Without this the iteration order from
    // `HashMap::into_iter` above leaks into the sorted output — Rust's
    // `HashMap` uses a random per-process seed, so identical inputs
    // produce different orderings across runs. That non-determinism
    // propagates into the `relevance = 1/(position+1)` values assigned
    // by `SearchEngine::search_with_mode`, so the same query against
    // the same corpus would surface tied chunks with different
    // displayed confidences from one launch to the next.
    //
    // The chunk_id tiebreaker mirrors what `rank_chunks_by_cosine`
    // already does for the vector-ranking path (`.then_with(|a, b|
    // a.0.cmp(&b.0))`). Pinning the contract here means the entire
    // hybrid ranking is fully reproducible given fixed inputs.
    out.sort_by(|a, b| {
        b.final_score
            .partial_cmp(&a.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.chunk_id.cmp(&b.chunk_id))
    });
    out
}

/// Rank a set of embedding rows by cosine similarity against the
/// query embedding and return the top `limit` as `RankedCandidate`s.
///
/// Filters out rows whose `model_id` does not match the query
/// provider's `model_id`, since cosine across different models is
/// meaningless. Such rows will simply not contribute to the vector
/// signal — BM25 + recency still apply.
pub fn rank_chunks_by_cosine(
    rows: &[ChunkEmbeddingRow],
    query_vec: &[f32],
    query_model_id: &str,
    limit: usize,
) -> Vec<RankedCandidate> {
    let mut scored: Vec<(i64, f32)> = rows
        .iter()
        .filter(|r| r.model_id == query_model_id && r.vector.len() == query_vec.len())
        .map(|r| (r.chunk_id, cosine_similarity(&r.vector, query_vec)))
        .collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    scored
        .into_iter()
        .take(limit)
        .enumerate()
        .map(|(rank, (chunk_id, _score))| RankedCandidate { chunk_id, rank })
        .collect()
}

/// High-level hybrid search entry point. Runs BM25 via FTS5,
/// vector cosine via the provided embedding provider, fuses with
/// RRF, applies recency decay, and returns the top `limit` chunks.
///
/// When `provider` is `None`, falls back to BM25 + recency only —
/// the vector signal is skipped. This is the operating mode when
/// no embeddings have been computed yet (fresh install, or the user
/// has disabled embeddings).
pub fn hybrid_search(
    store: &SourceStore,
    provider: Option<&dyn EmbeddingProvider>,
    query: &str,
    fts_query: &str,
    limit: usize,
    config: &HybridSearchConfig,
) -> Result<Vec<i64>> {
    // Whitespace-only query short-circuit. Both signals would otherwise
    // produce "results":
    //
    //   * BM25: `build_fts_query("")` already returns "" and the
    //     `fts_query.is_empty()` branch below skips the FTS call, so this
    //     half is fine on its own.
    //   * Vector: `EmbeddingProvider::embed("")` — for the only provider
    //     wired today (`HashTrickEmbedding`) — returns the zero vector,
    //     and `cosine_similarity(any_stored_vec, zero_vec)` returns `0.0`
    //     for every stored chunk (see `embedding::cosine_similarity`).
    //     `rank_chunks_by_cosine` then sorts the all-tied set by the
    //     `chunk_id` secondary key and emits up to `pool` candidates,
    //     each of which picks up a non-zero RRF contribution from
    //     `fuse_rankings`. Net effect: a `SourceManager::search("", N)`
    //     call would return `N` lowest-chunk_id rows with monotonically
    //     decreasing relevance instead of returning empty.
    //
    // Pinning this contract here — at the boundary that owns the
    // BM25+vector union — means every caller of `hybrid_search` (the
    // `SearchEngine` API today, plus any future direct consumers like
    // the planned `/sources/search` HTTP endpoint) inherits the
    // correct behaviour without each one having to remember to guard
    // its own input. The `search_with_mode` caller keeps its own
    // `ranked_ids.is_empty()` early return as a defence-in-depth path
    // for non-empty queries that happen to produce no matches.
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }

    // Pool sizing: oversample BM25 + vector candidates so the fusion
    // has enough material to rerank, but ONLY when both signals are
    // contributing. When the vector signal is disabled (provider is
    // None, e.g. fresh install with no embeddings; OR `vector_weight`
    // is explicitly set to 0.0, the `SearchEngine::new()` BM25-only
    // path), RRF is monotonic over the single remaining BM25 ranking
    // — the top-`limit` IDs after fusion are exactly the top-`limit`
    // BM25 hits in BM25 order, so fetching 4× candidates from FTS
    // would be wasted work (extra rows materialised, extra HashMap
    // accumulator entries built, extra `ages_secs_for_chunks` IDs
    // probed). Reduce to `limit` for the BM25-only path so the
    // backwards-compatible `SearchEngine::new()` call site doesn't pay
    // a perf regression for the hybrid feature it isn't using.
    let vector_active = provider.is_some() && config.vector_weight > 0.0;
    let pool = if vector_active {
        config.pool_size(limit)
    } else {
        limit
    };

    let bm25_hits = if fts_query.is_empty() {
        Vec::new()
    } else {
        store.search_fts(fts_query, pool)?
    };
    let bm25: Vec<RankedCandidate> = bm25_hits
        .iter()
        .enumerate()
        .map(|(rank, hit)| RankedCandidate {
            chunk_id: hit.chunk_id,
            rank,
        })
        .collect();

    let vector: Vec<RankedCandidate> = if vector_active {
        let p = provider.expect("vector_active implies provider is Some");
        let query_vec = p.embed(query)?;
        let rows = store.load_embeddings_for_model(p.model_id())?;
        rank_chunks_by_cosine(&rows, &query_vec, p.model_id(), pool)
    } else {
        Vec::new()
    };

    // Gather ages_secs for every candidate in the union.
    let mut candidate_ids: Vec<i64> = bm25.iter().map(|c| c.chunk_id).collect();
    candidate_ids.extend(vector.iter().map(|c| c.chunk_id));
    candidate_ids.sort_unstable();
    candidate_ids.dedup();

    let ages = store.ages_secs_for_chunks(&candidate_ids)?;
    let fused = fuse_rankings(&bm25, &vector, &ages, config);

    Ok(fused.into_iter().take(limit).map(|f| f.chunk_id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rrf_contribution_decreases_with_rank() {
        let k = 60.0;
        let r0 = rrf_contribution(0, k, 1.0);
        let r1 = rrf_contribution(1, k, 1.0);
        let r10 = rrf_contribution(10, k, 1.0);
        assert!(r0 > r1);
        assert!(r1 > r10);
    }

    #[test]
    fn rrf_contribution_scales_linearly_with_weight() {
        let k = 60.0;
        let r_default = rrf_contribution(5, k, 1.0);
        let r_double = rrf_contribution(5, k, 2.0);
        assert!((r_double - 2.0 * r_default).abs() < 1e-12);
    }

    #[test]
    fn rrf_contribution_matches_cormack_2009_formula() {
        // Sanity-check the formula against a hand-computed value
        // so future tweaks to the implementation don't silently
        // drift from the published RRF definition.
        let k = 60.0;
        let r0 = rrf_contribution(0, k, 1.0);
        // rank 0 → 1-based rank 1 → 1 / (60 + 1) = 1/61
        assert!((r0 - 1.0 / 61.0).abs() < 1e-12);
        let r9 = rrf_contribution(9, k, 1.0);
        // rank 9 → 1-based rank 10 → 1 / 70
        assert!((r9 - 1.0 / 70.0).abs() < 1e-12);
    }

    #[test]
    fn recency_zero_age_is_one() {
        let m = recency_multiplier(0.0, 86400.0);
        assert!((m - 1.0).abs() < 1e-12, "expected 1.0, got {m}");
    }

    #[test]
    fn recency_one_halflife_is_half() {
        let hl = 86400.0;
        let m = recency_multiplier(hl, hl);
        assert!((m - 0.5).abs() < 1e-9, "expected 0.5, got {m}");
    }

    #[test]
    fn recency_two_halflives_is_quarter() {
        let hl = 86400.0;
        let m = recency_multiplier(2.0 * hl, hl);
        assert!((m - 0.25).abs() < 1e-9, "expected 0.25, got {m}");
    }

    #[test]
    fn recency_infinite_halflife_returns_one() {
        let m = recency_multiplier(1e9, f64::INFINITY);
        assert!((m - 1.0).abs() < 1e-12, "expected 1.0, got {m}");
    }

    #[test]
    fn recency_negative_halflife_treated_as_disabled() {
        let m_neg = recency_multiplier(86400.0, -1.0);
        let m_zero = recency_multiplier(86400.0, 0.0);
        assert!((m_neg - 1.0).abs() < 1e-12, "expected 1.0, got {m_neg}");
        assert!((m_zero - 1.0).abs() < 1e-12, "expected 1.0, got {m_zero}");
    }

    #[test]
    fn fuse_rankings_combines_two_lists() {
        let bm25 = vec![
            RankedCandidate {
                chunk_id: 1,
                rank: 0,
            },
            RankedCandidate {
                chunk_id: 2,
                rank: 1,
            },
            RankedCandidate {
                chunk_id: 3,
                rank: 2,
            },
        ];
        let vector = vec![
            RankedCandidate {
                chunk_id: 3,
                rank: 0,
            },
            RankedCandidate {
                chunk_id: 1,
                rank: 1,
            },
            RankedCandidate {
                chunk_id: 4,
                rank: 2,
            },
        ];
        let ages = HashMap::new();
        let cfg = HybridSearchConfig {
            recency_halflife_secs: f64::INFINITY,
            ..Default::default()
        };
        let fused = fuse_rankings(&bm25, &vector, &ages, &cfg);

        // chunk_id 1 appears in both rankings → should rank highest
        assert_eq!(fused[0].chunk_id, 1);
        // chunk_id 3 also appears in both → should be #2 (lower
        // average rank than 1 since its bm25 rank is worse)
        assert_eq!(fused[1].chunk_id, 3);
        // chunk_ids 2 and 4 each appear in one ranking → tail
        assert!(fused.iter().any(|f| f.chunk_id == 2));
        assert!(fused.iter().any(|f| f.chunk_id == 4));
    }

    #[test]
    fn fuse_rankings_zero_weight_disables_signal() {
        let bm25 = vec![RankedCandidate {
            chunk_id: 1,
            rank: 0,
        }];
        let vector = vec![RankedCandidate {
            chunk_id: 2,
            rank: 0,
        }];
        let ages = HashMap::new();
        let cfg = HybridSearchConfig {
            vector_weight: 0.0,
            recency_halflife_secs: f64::INFINITY,
            ..Default::default()
        };
        let fused = fuse_rankings(&bm25, &vector, &ages, &cfg);
        assert_eq!(fused[0].chunk_id, 1);
        // chunk_id 2 still appears because vector contributed 0.0,
        // and 0 + 0 < 1/61, so it ranks last.
        let two = fused.iter().find(|f| f.chunk_id == 2).unwrap();
        assert!(
            two.rrf_score.abs() < 1e-12,
            "expected 0.0, got {}",
            two.rrf_score
        );
    }

    #[test]
    fn fuse_rankings_recency_breaks_ties() {
        // Two chunks with identical RRF scores; recency should
        // determine the final order.
        let bm25 = vec![
            RankedCandidate {
                chunk_id: 1,
                rank: 0,
            },
            RankedCandidate {
                chunk_id: 2,
                rank: 0,
            }, // same rank → same contrib
        ];
        let vector = Vec::new();
        let mut ages = HashMap::new();
        ages.insert(1i64, 86400.0 * 60.0); // 60 days old
        ages.insert(2i64, 0.0); // brand new
        let cfg = HybridSearchConfig {
            recency_halflife_secs: 86400.0 * 30.0,
            ..Default::default()
        };
        let fused = fuse_rankings(&bm25, &vector, &ages, &cfg);
        // Chunk 2 is newer → should win
        assert_eq!(fused[0].chunk_id, 2);
        assert_eq!(fused[1].chunk_id, 1);
        // The age-60-days chunk should be at ~0.25 of the new one's
        // final score (two halflives → 1/4).
        let ratio = fused[1].final_score / fused[0].final_score;
        assert!((ratio - 0.25).abs() < 1e-3, "expected ~0.25, got {ratio}");
    }

    #[test]
    fn fuse_rankings_orders_ties_deterministically_by_chunk_id() {
        // Three chunks all sharing the same BM25 rank and no vector
        // signal → all final scores are identical. Without the
        // `chunk_id` tiebreaker the relative order would depend on
        // `HashMap::into_iter()` iteration order (random per-process
        // seed), so the same query could surface tied chunks in a
        // different order on each launch.
        //
        // The contract this test pins: ties resolve in ascending
        // `chunk_id` order, which makes the entire fused ranking a
        // pure function of the inputs.
        let bm25 = vec![
            RankedCandidate {
                chunk_id: 17,
                rank: 0,
            },
            RankedCandidate {
                chunk_id: 3,
                rank: 0,
            },
            RankedCandidate {
                chunk_id: 42,
                rank: 0,
            },
        ];
        let vector: Vec<RankedCandidate> = Vec::new();
        let ages: HashMap<i64, f64> = HashMap::new();
        let cfg = HybridSearchConfig {
            // Disable recency so every chunk has multiplier 1.0 and
            // the test is solely about score-equality tiebreaking.
            recency_halflife_secs: f64::INFINITY,
            ..Default::default()
        };

        // Run the fusion multiple times. Each invocation builds a
        // fresh `HashMap` whose iteration order is randomised by
        // SipHash's per-process key, so a missing tiebreaker would
        // produce different orderings here even with no other
        // changes. The first call sets the expected ordering;
        // subsequent calls must match it byte-for-byte.
        let first = fuse_rankings(&bm25, &vector, &ages, &cfg);
        let chunk_ids: Vec<i64> = first.iter().map(|f| f.chunk_id).collect();
        assert_eq!(
            chunk_ids,
            vec![3, 17, 42],
            "expected ascending chunk_id on ties, got {chunk_ids:?}"
        );
        for _ in 0..50 {
            let again = fuse_rankings(&bm25, &vector, &ages, &cfg);
            let again_ids: Vec<i64> = again.iter().map(|f| f.chunk_id).collect();
            assert_eq!(
                again_ids, chunk_ids,
                "fuse_rankings must be order-stable across repeated invocations on identical inputs"
            );
        }
    }

    #[test]
    fn rank_by_cosine_filters_model_mismatch() {
        let rows = vec![
            ChunkEmbeddingRow {
                chunk_id: 1,
                model_id: "model-a".to_string(),
                vector: vec![1.0, 0.0],
            },
            ChunkEmbeddingRow {
                chunk_id: 2,
                model_id: "model-b".to_string(),
                vector: vec![1.0, 0.0],
            },
            ChunkEmbeddingRow {
                chunk_id: 3,
                model_id: "model-a".to_string(),
                vector: vec![0.0, 1.0],
            },
        ];
        let q = vec![1.0f32, 0.0];
        let result = rank_chunks_by_cosine(&rows, &q, "model-a", 10);
        // chunk 2 is filtered out (wrong model)
        assert!(!result.iter().any(|r| r.chunk_id == 2));
        // chunk 1 (identical to query) ranks above chunk 3 (orthogonal)
        assert_eq!(result[0].chunk_id, 1);
        assert_eq!(result[1].chunk_id, 3);
    }

    #[test]
    fn rank_by_cosine_filters_dim_mismatch() {
        let rows = vec![
            ChunkEmbeddingRow {
                chunk_id: 1,
                model_id: "model-a".to_string(),
                vector: vec![1.0, 0.0],
            },
            ChunkEmbeddingRow {
                chunk_id: 2,
                model_id: "model-a".to_string(),
                vector: vec![1.0, 0.0, 0.0], // wrong dim — must be filtered
            },
        ];
        let q = vec![1.0f32, 0.0];
        let result = rank_chunks_by_cosine(&rows, &q, "model-a", 10);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].chunk_id, 1);
    }

    #[test]
    fn rank_by_cosine_respects_limit() {
        let rows: Vec<ChunkEmbeddingRow> = (0..50)
            .map(|i| ChunkEmbeddingRow {
                chunk_id: i,
                model_id: "m".to_string(),
                vector: vec![1.0, (i as f32) / 50.0],
            })
            .collect();
        let q = vec![1.0f32, 0.0];
        let result = rank_chunks_by_cosine(&rows, &q, "m", 5);
        assert_eq!(result.len(), 5);
    }

    // ----------------------------------------------------------------
    // HybridSearchConfig patch + serialization tests
    // ----------------------------------------------------------------

    /// f64-equality tolerance used by every assert in this test
    /// block. We test for exact-value preservation across patch /
    /// serialize / deserialize round-trips, so the tolerance only
    /// needs to guard against compiler reordering of
    /// `30.0 * 24.0 * 60.0 * 60.0` — a single ULP is plenty.
    const F64_EPS: f64 = 1e-9;

    #[test]
    fn apply_patch_updates_only_specified_fields() {
        let mut cfg = HybridSearchConfig::default();
        let original = cfg.clone();

        let patch = HybridSearchConfigInput {
            vector_weight: Some(0.0),
            recency_halflife_secs: Some(7.0 * 24.0 * 60.0 * 60.0),
            ..HybridSearchConfigInput::default()
        };
        cfg.apply_patch(&patch).unwrap();

        assert!(cfg.vector_weight.abs() < F64_EPS);
        assert!(
            (cfg.recency_halflife_secs - 7.0 * 24.0 * 60.0 * 60.0).abs() < 1.0,
            "7-day half-life should be applied verbatim"
        );
        // Unchanged fields must keep their original value.
        assert!((cfg.bm25_weight - original.bm25_weight).abs() < F64_EPS);
        assert!((cfg.rrf_k - original.rrf_k).abs() < F64_EPS);
        assert_eq!(cfg.candidate_pool_size, original.candidate_pool_size);
    }

    #[test]
    fn apply_patch_rejects_negative_weights() {
        let mut cfg = HybridSearchConfig::default();
        let snapshot_before = cfg.clone();
        let patch = HybridSearchConfigInput {
            bm25_weight: Some(-0.5),
            ..HybridSearchConfigInput::default()
        };
        let err = cfg.apply_patch(&patch).unwrap_err();
        assert!(
            err.to_string().contains("bm25_weight"),
            "error message should name the offending field: {err}"
        );
        // Receiver must be untouched on validation failure.
        assert!((cfg.bm25_weight - snapshot_before.bm25_weight).abs() < F64_EPS);
    }

    #[test]
    fn apply_patch_rejects_nan_and_infinity_weights() {
        let mut cfg = HybridSearchConfig::default();
        let patch_nan = HybridSearchConfigInput {
            vector_weight: Some(f64::NAN),
            ..HybridSearchConfigInput::default()
        };
        assert!(cfg.apply_patch(&patch_nan).is_err(), "NaN must be rejected");

        let patch_inf = HybridSearchConfigInput {
            bm25_weight: Some(f64::INFINITY),
            ..HybridSearchConfigInput::default()
        };
        assert!(
            cfg.apply_patch(&patch_inf).is_err(),
            "Infinity weight must be rejected (weights must be finite)"
        );
    }

    #[test]
    fn apply_patch_accepts_infinity_halflife_as_disable_sentinel() {
        // Recency half-life is the one f64 field where Infinity is
        // an explicit "no decay" sentinel — make sure the validator
        // allows it through.
        let mut cfg = HybridSearchConfig::default();
        let patch = HybridSearchConfigInput {
            recency_halflife_secs: Some(f64::INFINITY),
            ..HybridSearchConfigInput::default()
        };
        cfg.apply_patch(&patch).unwrap();
        assert!(cfg.recency_halflife_secs.is_infinite());
    }

    #[test]
    fn apply_patch_rejects_zero_or_negative_halflife() {
        let mut cfg = HybridSearchConfig::default();
        let patch_zero = HybridSearchConfigInput {
            recency_halflife_secs: Some(0.0),
            ..HybridSearchConfigInput::default()
        };
        assert!(cfg.apply_patch(&patch_zero).is_err());
        let patch_neg = HybridSearchConfigInput {
            recency_halflife_secs: Some(-60.0),
            ..HybridSearchConfigInput::default()
        };
        assert!(cfg.apply_patch(&patch_neg).is_err());
    }

    #[test]
    fn apply_patch_rejects_oversize_candidate_pool() {
        let mut cfg = HybridSearchConfig::default();
        let patch = HybridSearchConfigInput {
            candidate_pool_size: Some(20_000),
            ..HybridSearchConfigInput::default()
        };
        let err = cfg.apply_patch(&patch).unwrap_err();
        assert!(
            err.to_string().contains("candidate_pool_size"),
            "error must identify the field: {err}"
        );
    }

    #[test]
    fn apply_patch_is_transactional_on_partial_failure() {
        // A patch that touches both a valid field (vector_weight=0)
        // and an invalid field (recency=-1) must leave the config
        // entirely untouched. This is the contract the IPC layer
        // relies on so the renderer never sees a half-applied state.
        let mut cfg = HybridSearchConfig::default();
        let before = cfg.clone();
        let patch = HybridSearchConfigInput {
            vector_weight: Some(0.0),
            recency_halflife_secs: Some(-1.0),
            ..HybridSearchConfigInput::default()
        };
        let _ = cfg.apply_patch(&patch).unwrap_err();
        assert!((cfg.vector_weight - before.vector_weight).abs() < F64_EPS);
        assert!((cfg.recency_halflife_secs - before.recency_halflife_secs).abs() < F64_EPS);
    }

    #[test]
    fn hybrid_search_config_roundtrips_through_json_with_finite_halflife() {
        // Default config has a finite 30-day half-life — must serialize
        // as a JSON number and round-trip back identically.
        let cfg = HybridSearchConfig::default();
        let s = serde_json::to_string(&cfg).expect("serialize default");
        let back: HybridSearchConfig = serde_json::from_str(&s).expect("deserialize default");
        assert!((back.bm25_weight - cfg.bm25_weight).abs() < F64_EPS);
        assert!((back.vector_weight - cfg.vector_weight).abs() < F64_EPS);
        assert!((back.rrf_k - cfg.rrf_k).abs() < F64_EPS);
        assert!((back.recency_halflife_secs - cfg.recency_halflife_secs).abs() < F64_EPS);
        assert_eq!(back.candidate_pool_size, cfg.candidate_pool_size);
    }

    #[test]
    fn hybrid_search_config_roundtrips_through_json_with_infinity_halflife() {
        // The dangerous case the knowledge hint warns about: a config
        // with `recency_halflife_secs == f64::INFINITY` would silently
        // serialize as JSON `null` via the default serde_json behaviour
        // and then fail to round-trip back to `f64`. The custom
        // `halflife_serde` module exists specifically to make this
        // work — pin it with an explicit round-trip test so a future
        // refactor that removes the custom serde catches itself here.
        let cfg = HybridSearchConfig {
            recency_halflife_secs: f64::INFINITY,
            ..HybridSearchConfig::default()
        };
        let s = serde_json::to_string(&cfg).expect("INFINITY must serialize cleanly");
        // The wire shape is `null`, not the literal string "Infinity"
        // — pin that contract so a future "encode as string" refactor
        // doesn't break wire-compat with the renderer.
        assert!(
            s.contains("\"recencyHalflifeSecs\":null"),
            "expected null wire shape for INFINITY, got: {s}"
        );
        let back: HybridSearchConfig =
            serde_json::from_str(&s).expect("INFINITY must deserialize cleanly");
        assert!(back.recency_halflife_secs.is_infinite());
    }

    #[test]
    fn hybrid_search_config_input_roundtrips_with_camelcase() {
        // The IPC layer hands us camelCase JSON; make sure the input
        // deserializes from that shape.
        let json = r#"{ "vectorWeight": 0.0, "recencyHalflifeSecs": 86400 }"#;
        let input: HybridSearchConfigInput = serde_json::from_str(json).unwrap();
        assert!(input.vector_weight.unwrap().abs() < F64_EPS);
        assert!((input.recency_halflife_secs.unwrap() - 86400.0).abs() < F64_EPS);
        assert!(input.bm25_weight.is_none());
        assert!(input.rrf_k.is_none());
        assert!(input.candidate_pool_size.is_none());
    }

    #[test]
    fn hybrid_search_config_input_accepts_missing_fields_as_no_op() {
        let input: HybridSearchConfigInput = serde_json::from_str("{}").unwrap();
        assert!(input.bm25_weight.is_none());
        assert!(input.vector_weight.is_none());
        assert!(input.rrf_k.is_none());
        assert!(input.recency_halflife_secs.is_none());
        assert!(input.candidate_pool_size.is_none());
    }
}
