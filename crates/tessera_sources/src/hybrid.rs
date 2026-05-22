//! Hybrid retrieval: combines BM25 lexical scoring, vector
//! similarity, and temporal recency into a single ranked list.
//!
//! ## Why three signals
//!
//! Each signal captures something the others miss:
//!
//! - **BM25 (FTS5)** rewards exact term matches and is dominant for
//!   keyword queries ("WS3 hybrid retrieval"). It struggles with
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
//! Recency is applied multiplicatively on top of the RRF score:
//!
//! ```text
//!   final(d) = score(d) * exp(-Δt(d) / halflife)
//! ```
//!
//! where `Δt(d)` is the age in seconds and `halflife` is configurable
//! (default 30 days). Chunks with no `last_modified` get a recency
//! multiplier of 1.0 (neutral).
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
use std::collections::HashMap;
use tessera_core::error::Result;

/// Reciprocal Rank Fusion damping constant. The value Cormack,
/// Clarke, and Buettcher (2009) recommend; matches Elasticsearch's
/// default. Higher values dampen the dominance of top-ranked items.
pub const RRF_K: f64 = 60.0;

/// Default recency half-life: chunks lose half their multiplier
/// every 30 days. Chosen to be relevant on the time-scale of
/// project work without overpenalising older reference material.
pub const DEFAULT_RECENCY_HALFLIFE_SECS: f64 = 30.0 * 24.0 * 60.0 * 60.0;

#[derive(Debug, Clone)]
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
    /// for all chunks).
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

    out.sort_by(|a, b| {
        b.final_score
            .partial_cmp(&a.final_score)
            .unwrap_or(std::cmp::Ordering::Equal)
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
    let pool = config.pool_size(limit);

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

    let vector: Vec<RankedCandidate> = match provider {
        Some(p) if config.vector_weight > 0.0 => {
            let query_vec = p.embed(query)?;
            let rows = store.load_embeddings_for_model(p.model_id())?;
            rank_chunks_by_cosine(&rows, &query_vec, p.model_id(), pool)
        }
        _ => Vec::new(),
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
}
