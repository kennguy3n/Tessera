//! in-memory IVF-Flat ANN index for the
//! hybrid-retrieval vector signal.
//!
//! ## Why we need this
//!
//! Before this module landed, [`crate::hybrid::hybrid_search`] called
//! [`crate::store::SourceStore::load_embeddings_for_model`] on every
//! query (which scans `chunk_embeddings` for the active model_id),
//! decoded the binary `vec` blob for every row into a `Vec<f32>`,
//! and then ran [`crate::hybrid::rank_chunks_by_cosine`] which does
//! a brute-force `O(N * D)` cosine pass against every stored vector.
//!
//! On a 50K-chunk corpus with 384-dim embeddings, that is ~19M
//! float multiplications per query (plus the SQL scan + blob
//! decoding). At hot-path query rates the cost dominates the
//! BM25 path and feeds back into UI latency.
//!
//! ## What this module does
//!
//! Builds an [IVF-Flat](https://github.com/facebookresearch/faiss/wiki/Faiss-indexes#cell-probe-methods-ivfflat-and-ivfsq)
//! ("inverted file with flat quantisation") index over the cached
//! embedding rows:
//!
//!   1. Run k-means with `K = ⌈√N⌉.clamp(MIN_CENTROIDS, MAX_CENTROIDS).min(N)`
//!      cells (defaults: `MIN_CENTROIDS = 8`, `MAX_CENTROIDS = 256`),
//!      deterministically seeded so two builds over the same input
//!      produce the same index (matters for test stability and for
//!      the cache contract below). See [`pick_k`] for the exact
//!      formula.
//!   2. Each vector is assigned to its nearest centroid; the
//!      assignments form `K` inverted lists.
//!   3. To answer a top-k query, rank centroids by cosine to the
//!      query, probe the top `nprobe = ⌈√K⌉.max(1).min(K)` cells
//!      (see [`pick_nprobe`]), and brute-force inside the probed
//!      cells only.
//!
//! Total query work: `O(K * D + nprobe * (N/K) * D)`. With
//! `K ≈ √N` and `nprobe ≈ √K`, that simplifies to roughly
//! `O(√N * D + N^(3/4) * D)`, i.e. sublinear in N. For
//! N=50K, D=384: ~3M ops vs ~19M for brute force, a ~6×
//! speedup at typical Tessera scale and an even larger one as
//! the corpus grows. (The `MAX_CENTROIDS = 256` clamp means K
//! tops out at 256 around N≈65K; above that, cell occupancy
//! grows linearly with N rather than `√N`, but the asymptotic
//! shape still beats brute force.)
//!
//! ## What this module does NOT do
//!
//! It does not own its own freshness contract — invalidation lives
//! on [`crate::store::SourceStore`] (see `embedding_generation` /
//! `vector_index_cache`). The store calls [`IvfIndex::build`] from
//! its cache miss path and the cached `Arc<IvfIndex>` is returned
//! for subsequent queries with the same `(model_id, generation)`.
//!
//! ## Vectors are L2-normalised
//!
//! All vectors (rows + centroids) are stored unit-normalised, so
//! cosine similarity reduces to dot product. The dim-mismatch
//! filter and zero-vector handling match
//! [`crate::embedding::cosine_similarity`] semantics so the
//! ANN path is observationally identical to the brute-force path
//! up to recall.

use std::collections::BinaryHeap;

use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};

use crate::store::ChunkEmbeddingRow;

/// Below this corpus size, the brute-force scan is faster than
/// building + querying an IVF index. The store falls back to the
/// brute-force path under this threshold.
///
/// Empirically chosen: at N < ~1K, the constant factors in IVF
/// (centroid scan + cell-probe overhead) dominate the savings
/// from sublinear search. Above this point IVF wins, and the
/// crossover sharpens as N grows.
pub const IVF_BRUTE_FORCE_THRESHOLD: usize = 1024;

/// Maximum number of k-means iterations during index build. Five
/// iterations is the standard FAISS default — empirically reaches
/// roughly 95% of the recall achievable with a hundred iterations
/// on random embedding distributions, at a small fraction of the
/// build cost.
const KMEANS_MAX_ITERS: usize = 5;

/// Upper bound on cell count, to keep centroid scan cost
/// bounded on very large corpora. With `K = √N`, this caps
/// the per-query centroid pass at 256 dot products even for
/// N > 65K.
const MAX_CENTROIDS: usize = 256;

/// Lower bound on cell count. With fewer than this many cells
/// the inverted-list assignment becomes lopsided and recall
/// suffers. For N < `IVF_BRUTE_FORCE_THRESHOLD` we fall back
/// to brute force entirely, so this bound only matters for
/// the threshold-to-64-cell range.
const MIN_CENTROIDS: usize = 8;

/// Fixed RNG seed used by k-means++ initialisation. Pinning
/// this makes index builds deterministic — two builds over
/// the same input produce the same centroids, the same cell
/// assignments, and therefore the same query results. This
/// keeps the cache-hit and cache-miss paths in sync for tests
/// and makes recall comparisons reproducible across runs.
const KMEANS_SEED: u64 = 0xA5A5_A5A5_A5A5_A5A5;

/// One stored vector inside the IVF index.
#[derive(Clone, Debug)]
struct IndexedVector {
    chunk_id: i64,
    /// L2-normalised so cosine == dot product. Length always
    /// equals [`IvfIndex::dim`].
    normalised: Vec<f32>,
}

/// In-memory IVF-Flat index over a homogeneous set of embedding
/// vectors. All vectors must share the same `dim`. Rows whose
/// vector length differs from `dim` are filtered out at build
/// time — they never reach the index, so the brute-force-equivalent
/// behaviour is preserved on the dim-mismatch path.
#[derive(Clone, Debug)]
pub struct IvfIndex {
    dim: usize,
    /// Cluster centroids. `centroids[c * dim .. (c + 1) * dim]` is
    /// the L2-normalised centroid vector for cell `c`.
    centroids: Vec<f32>,
    /// `cells[c]` is the set of vector indices assigned to centroid
    /// `c` (indices into [`Self::vectors`]).
    cells: Vec<Vec<usize>>,
    /// All indexed vectors. Order matches the original `rows` slice
    /// passed to [`Self::build`] after dim-mismatch filtering.
    vectors: Vec<IndexedVector>,
    /// How many cells to probe per query. Higher values trade
    /// query time for recall; we default to `⌈√K⌉` which is the
    /// FAISS default and gives roughly 95% recall@10 on uniform
    /// distributions.
    nprobe: usize,
}

/// A single (chunk_id, similarity) pair emitted by
/// [`IvfIndex::top_k_cosine`]. The score is the unnormalised
/// cosine in `[-1, 1]`; callers that only care about rank order
/// can ignore it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct IndexHit {
    pub chunk_id: i64,
    pub score: f32,
}

impl IvfIndex {
    /// Build an IVF-Flat index from a set of [`ChunkEmbeddingRow`].
    ///
    /// Rows whose `model_id` does not match `model_id` or whose
    /// vector dimension does not equal `dim` are filtered out
    /// before clustering. This matches the existing
    /// [`crate::hybrid::rank_chunks_by_cosine`] contract: only
    /// rows that the brute-force path would have scored are
    /// candidates for the ANN result.
    ///
    /// Zero-length input or input that filters to zero rows
    /// produces an empty index; [`Self::top_k_cosine`] then
    /// returns an empty `Vec` (matching brute-force behaviour
    /// when there are no embeddings to score).
    pub fn build(rows: &[ChunkEmbeddingRow], model_id: &str, dim: usize) -> Self {
        let filtered: Vec<IndexedVector> = rows
            .iter()
            .filter(|r| r.model_id == model_id && r.vector.len() == dim)
            .map(|r| IndexedVector {
                chunk_id: r.chunk_id,
                normalised: l2_normalise(&r.vector),
            })
            .collect();

        if filtered.is_empty() {
            return Self::empty(dim);
        }

        let n = filtered.len();
        let k = pick_k(n);
        let mut rng = StdRng::seed_from_u64(KMEANS_SEED);
        let mut centroids = kmeans_plus_plus_init(&filtered, k, dim, &mut rng);

        // Lloyd iterations: alternate (assign, update) until stable
        // or until we hit the iteration cap. We don't bother with
        // an early-stop convergence test — five iterations on
        // normalised vectors is overwhelmingly enough.
        let mut assignments = vec![0usize; n];
        for _ in 0..KMEANS_MAX_ITERS {
            assign_to_nearest(&filtered, &centroids, k, dim, &mut assignments);
            update_centroids(&filtered, &assignments, k, dim, &mut centroids);
        }
        // One final assignment pass with the updated centroids so
        // the inverted lists reflect the final centroid positions
        // (not the second-to-last ones).
        assign_to_nearest(&filtered, &centroids, k, dim, &mut assignments);

        // Build inverted lists from the final assignment.
        let mut cells: Vec<Vec<usize>> = vec![Vec::new(); k];
        for (vec_idx, &cell_idx) in assignments.iter().enumerate() {
            cells[cell_idx].push(vec_idx);
        }

        let nprobe = pick_nprobe(k);

        Self {
            dim,
            centroids,
            cells,
            vectors: filtered,
            nprobe,
        }
    }

    /// Construct an empty index for a given dim. [`Self::top_k_cosine`]
    /// on an empty index always returns an empty `Vec`. Used both
    /// for genuinely-empty corpora and for the "all rows filtered
    /// out" build path.
    pub fn empty(dim: usize) -> Self {
        Self {
            dim,
            centroids: Vec::new(),
            cells: Vec::new(),
            vectors: Vec::new(),
            nprobe: 0,
        }
    }

    /// Vector dimension every row in this index shares. Used by the
    /// store's cache validator to confirm an existing index still
    /// matches the active model before reusing it.
    pub fn dim(&self) -> usize {
        self.dim
    }

    /// Number of indexed vectors. Equal to the number of input
    /// rows that survived the dim/model filter at build time.
    pub fn len(&self) -> usize {
        self.vectors.len()
    }

    pub fn is_empty(&self) -> bool {
        self.vectors.is_empty()
    }

    /// Top-`k` cosine matches against `query`. Returns at most
    /// `min(k, self.len())` results sorted by descending score
    /// with the same `chunk_id` ascending tiebreaker as
    /// [`crate::hybrid::rank_chunks_by_cosine`] so the ANN path's
    /// rank order is observationally compatible with brute force.
    ///
    /// `query.len() != self.dim` returns an empty `Vec` — matches
    /// the brute-force path's "dim mismatch filters the row out"
    /// behaviour, applied here to the entire query.
    pub fn top_k_cosine(&self, query: &[f32], k: usize) -> Vec<IndexHit> {
        if k == 0 || self.is_empty() || query.len() != self.dim {
            return Vec::new();
        }

        let normalised_query = l2_normalise(query);

        // Score every centroid and pick the top `nprobe`. For
        // small K (we cap at 256) the centroid scan is cheap
        // enough to not justify a partial-sort optimisation.
        let mut centroid_scores: Vec<(usize, f32)> = (0..self.cells.len())
            .map(|c| {
                let centroid = &self.centroids[c * self.dim..(c + 1) * self.dim];
                (c, dot(centroid, &normalised_query))
            })
            .collect();
        centroid_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let probe_count = self.nprobe.min(centroid_scores.len());

        // Walk the probed cells, pushing (score, chunk_id) into a
        // bounded max-heap-of-worst-entries (effectively a min-heap
        // of the *top*-k results). `BinaryHeap` is a max-heap, so
        // we invert the [`MinHeapEntry`] `Ord` impl: entries with
        // the LOWEST score (= worst result so far) compare as
        // greatest, and `peek()` returns the worst kept entry.
        //
        // Insertion contract: while the heap has fewer than k
        // entries, push unconditionally. Once full, compare the
        // candidate against `peek()` (the worst kept entry) — if
        // the candidate is *better* (which in the inverted `Ord`
        // means it compares as *less than* `peek()`), evict the
        // worst and push the candidate. `<` (not `>`) is the
        // correct direction precisely because of the inversion;
        // using `>` would keep the worst k entries instead of the
        // best k, which the `top_hit_is_query_aligned_vector`
        // regression test pins.
        let mut top: BinaryHeap<MinHeapEntry> = BinaryHeap::with_capacity(k + 1);
        for (cell_idx, _) in centroid_scores.iter().take(probe_count) {
            for &vec_idx in &self.cells[*cell_idx] {
                let v = &self.vectors[vec_idx];
                let score = dot(&v.normalised, &normalised_query);
                let entry = MinHeapEntry {
                    score,
                    chunk_id: v.chunk_id,
                };
                if top.len() < k {
                    top.push(entry);
                } else if entry < *top.peek().expect("non-empty by len check") {
                    top.pop();
                    top.push(entry);
                }
            }
        }

        // Drain heap to sorted descending Vec. The heap holds at
        // most k entries so the sort is bounded.
        let mut out: Vec<IndexHit> = top
            .into_iter()
            .map(|e| IndexHit {
                chunk_id: e.chunk_id,
                score: e.score,
            })
            .collect();
        out.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.chunk_id.cmp(&b.chunk_id))
        });
        out
    }
}

/// Min-heap entry. Implements `Ord` such that *smaller* entries
/// (by ascending score, then descending chunk_id) compare as
/// *greater* — putting them at the top of a `BinaryHeap` (which
/// is a max-heap). This lets the heap evict the worst entry in
/// O(log k) per insert when a new entry beats it.
#[derive(Clone, Copy, Debug)]
struct MinHeapEntry {
    score: f32,
    chunk_id: i64,
}

impl PartialEq for MinHeapEntry {
    // Note the deliberate asymmetry with `Ord` below: `PartialEq`
    // delegates to IEEE 754 `f32::eq` (so `NaN != NaN`), while `Ord`
    // treats `NaN` as `Equal`. The convention is that `a == b` should
    // imply `a.cmp(&b) == Ordering::Equal`, and that holds here for
    // every non-NaN input. The NaN case is a documented carve-out:
    // a poisoned score must not corrupt the heap's `cmp`-based
    // sift-up/sift-down invariant, but two NaN-scored entries are
    // still observationally distinct rows we don't want to dedupe in
    // hash sets or equality assertions. `BinaryHeap` only consults
    // `Ord`, never `PartialEq`, so the asymmetry never escapes the
    // top-k path.
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score && self.chunk_id == other.chunk_id
    }
}
impl Eq for MinHeapEntry {}

impl Ord for MinHeapEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Smaller score == greater in heap order. NaN treated as
        // equal so a poisoned score does not corrupt the heap
        // invariant.
        //
        // Tiebreaker on equal scores: HIGHER chunk_id == greater. The
        // brute-force path `rank_chunks_by_cosine` sorts (score desc,
        // chunk_id asc) and `take(k)`, so it keeps the LOWER chunk_ids
        // when scores tie. To match that here we want the worst-kept
        // entry (the one `peek()`/`pop()` returns first) to be the
        // entry with the HIGHEST chunk_id, so a candidate with a lower
        // chunk_id can evict it. Reversed direction (`other.cmp(&self)`)
        // would invert that and silently keep different rows from
        // brute force when ties span the k boundary.
        match other
            .score
            .partial_cmp(&self.score)
            .unwrap_or(std::cmp::Ordering::Equal)
        {
            std::cmp::Ordering::Equal => self.chunk_id.cmp(&other.chunk_id),
            ord => ord,
        }
    }
}

impl PartialOrd for MinHeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// L2-normalise a vector. Zero vectors stay zero (and produce
/// zero cosine against anything else, matching
/// [`crate::embedding::cosine_similarity`]).
fn l2_normalise(v: &[f32]) -> Vec<f32> {
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter().map(|x| x / norm).collect()
    } else {
        v.to_vec()
    }
}

/// Plain dot product. Both inputs are assumed L2-normalised so the
/// result is the cosine similarity in `[-1, 1]`.
fn dot(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "dim mismatch in dot");
    let mut sum = 0.0f32;
    for i in 0..a.len() {
        sum += a[i] * b[i];
    }
    sum
}

/// Cell count for `n` vectors. Targets `K = √N` clamped to
/// `[MIN_CENTROIDS, MAX_CENTROIDS]` — the classic FAISS rule
/// of thumb. Below the brute-force threshold the index isn't
/// built at all, so `MIN_CENTROIDS=8` only matters when
/// `N ≈ 1024..256K`.
fn pick_k(n: usize) -> usize {
    let sqrt_n = (n as f64).sqrt().ceil() as usize;
    sqrt_n.clamp(MIN_CENTROIDS, MAX_CENTROIDS).min(n)
}

/// Cells to probe per query. `⌈√K⌉` is the FAISS default;
/// gives ~95% recall@10 on uniform vector distributions. Clamped
/// to `[1, k]` so we never probe more cells than exist nor zero
/// cells when k > 0.
fn pick_nprobe(k: usize) -> usize {
    let sqrt_k = (k as f64).sqrt().ceil() as usize;
    sqrt_k.max(1).min(k)
}

/// k-means++ initialisation. Picks the first centroid uniformly
/// at random, then weights subsequent picks by `D(x)^2` (squared
/// distance to the nearest already-chosen centroid). Produces
/// better-spread initial centroids than uniform sampling and
/// converges faster.
fn kmeans_plus_plus_init(
    vectors: &[IndexedVector],
    k: usize,
    dim: usize,
    rng: &mut StdRng,
) -> Vec<f32> {
    let n = vectors.len();
    debug_assert!(n > 0 && k > 0 && k <= n);

    let mut centroids: Vec<f32> = Vec::with_capacity(k * dim);

    // First centroid: uniform random.
    let first_idx = rng.gen_range(0..n);
    centroids.extend_from_slice(&vectors[first_idx].normalised);

    // Subsequent centroids: weighted by squared distance.
    let mut min_sq_dist: Vec<f32> = vectors
        .iter()
        .map(|v| sq_distance(&v.normalised, &centroids[0..dim]))
        .collect();

    for c in 1..k {
        // Roulette-wheel selection weighted by min_sq_dist.
        let total: f32 = min_sq_dist.iter().sum();
        let chosen_idx = if total <= 0.0 {
            // Degenerate: all vectors coincide with existing
            // centroids. Pick uniformly so we don't infinitely
            // loop trying to find a non-zero-distance point.
            rng.gen_range(0..n)
        } else {
            let mut target = rng.gen_range(0.0..total);
            let mut idx = n - 1;
            for (i, &w) in min_sq_dist.iter().enumerate() {
                if target < w {
                    idx = i;
                    break;
                }
                target -= w;
            }
            idx
        };

        centroids.extend_from_slice(&vectors[chosen_idx].normalised);

        // Update min_sq_dist: each vector's distance to the
        // nearest centroid is the min of its current value and
        // its distance to the new centroid.
        let new_centroid = &centroids[c * dim..(c + 1) * dim];
        for (i, v) in vectors.iter().enumerate() {
            let d = sq_distance(&v.normalised, new_centroid);
            if d < min_sq_dist[i] {
                min_sq_dist[i] = d;
            }
        }
    }

    centroids
}

/// Squared Euclidean distance. For L2-normalised vectors,
/// `||a - b||² = 2 - 2 * dot(a, b)`, but we compute the
/// general form so this helper works on un-normalised inputs
/// too (k-means++ runs on the normalised vectors, but exposing
/// the helper for future re-use is cheap).
fn sq_distance(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len(), "dim mismatch in sq_distance");
    let mut sum = 0.0f32;
    for i in 0..a.len() {
        let d = a[i] - b[i];
        sum += d * d;
    }
    sum
}

/// Assign each vector to the nearest centroid. `assignments` is
/// re-used across iterations to avoid allocation churn.
fn assign_to_nearest(
    vectors: &[IndexedVector],
    centroids: &[f32],
    k: usize,
    dim: usize,
    assignments: &mut [usize],
) {
    debug_assert_eq!(assignments.len(), vectors.len());
    for (vec_idx, v) in vectors.iter().enumerate() {
        let mut best_c = 0usize;
        let mut best_score = f32::NEG_INFINITY;
        for c in 0..k {
            let centroid = &centroids[c * dim..(c + 1) * dim];
            let score = dot(&v.normalised, centroid);
            if score > best_score {
                best_score = score;
                best_c = c;
            }
        }
        assignments[vec_idx] = best_c;
    }
}

/// Update centroids to the mean (then L2-renormalised) of their
/// assigned vectors. Cells that lost all members keep their old
/// position — a more aggressive "re-seed empty cells from the
/// farthest outlier" strategy would buy slightly better recall
/// but adds complexity for marginal gain at Tessera's scale.
fn update_centroids(
    vectors: &[IndexedVector],
    assignments: &[usize],
    k: usize,
    dim: usize,
    centroids: &mut [f32],
) {
    debug_assert_eq!(assignments.len(), vectors.len());
    debug_assert_eq!(centroids.len(), k * dim);

    let mut counts = vec![0usize; k];
    let mut sums = vec![0.0f32; k * dim];

    for (vec_idx, &c) in assignments.iter().enumerate() {
        counts[c] += 1;
        let base = c * dim;
        for d in 0..dim {
            sums[base + d] += vectors[vec_idx].normalised[d];
        }
    }

    for (c, &count) in counts.iter().enumerate().take(k) {
        if count == 0 {
            // Empty cell — keep the old centroid in place so it
            // can still receive members in subsequent iterations
            // (if a re-allocation moves anyone closer).
            continue;
        }
        let inv_n = 1.0f32 / count as f32;
        let base = c * dim;
        let mut norm_sq = 0.0f32;
        for d in 0..dim {
            let mean = sums[base + d] * inv_n;
            centroids[base + d] = mean;
            norm_sq += mean * mean;
        }
        // Re-normalise so the centroid stays on the unit sphere.
        // This keeps the centroid-vs-vector dot product directly
        // comparable to the (already-normalised) vector-vs-vector
        // dot products.
        let norm = norm_sq.sqrt();
        if norm > 0.0 {
            let inv = 1.0f32 / norm;
            for d in 0..dim {
                centroids[base + d] *= inv;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(chunk_id: i64, model_id: &str, vector: Vec<f32>) -> ChunkEmbeddingRow {
        ChunkEmbeddingRow {
            chunk_id,
            model_id: model_id.to_string(),
            vector,
        }
    }

    #[test]
    fn empty_input_returns_empty_index() {
        let idx = IvfIndex::build(&[], "m", 4);
        assert!(idx.is_empty());
        assert_eq!(idx.len(), 0);
        assert_eq!(idx.dim(), 4);
        assert!(idx.top_k_cosine(&[1.0, 0.0, 0.0, 0.0], 10).is_empty());
    }

    #[test]
    fn dim_mismatch_filters_out_rows_at_build() {
        let rows = vec![
            row(1, "m", vec![1.0, 0.0, 0.0, 0.0]),
            // wrong dim — filtered
            row(2, "m", vec![1.0, 0.0, 0.0]),
            // wrong model — filtered
            row(3, "other", vec![1.0, 0.0, 0.0, 0.0]),
        ];
        let idx = IvfIndex::build(&rows, "m", 4);
        assert_eq!(idx.len(), 1);
        let hits = idx.top_k_cosine(&[1.0, 0.0, 0.0, 0.0], 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk_id, 1);
    }

    #[test]
    fn query_dim_mismatch_returns_empty() {
        let rows = vec![row(1, "m", vec![1.0, 0.0])];
        let idx = IvfIndex::build(&rows, "m", 2);
        assert!(idx.top_k_cosine(&[1.0, 0.0, 0.0], 5).is_empty());
        assert!(idx.top_k_cosine(&[], 5).is_empty());
    }

    #[test]
    fn k_zero_returns_empty() {
        let rows = vec![row(1, "m", vec![1.0, 0.0])];
        let idx = IvfIndex::build(&rows, "m", 2);
        assert!(idx.top_k_cosine(&[1.0, 0.0], 0).is_empty());
    }

    #[test]
    fn deterministic_across_builds_with_same_input() {
        // Same input → same centroids → same cell assignments
        // → same query results across two independent builds.
        let mut rows = Vec::new();
        for i in 0..200 {
            let x = (i as f32) / 100.0 - 1.0;
            let y = ((i * 17) as f32).sin();
            rows.push(row(i as i64, "m", vec![x, y, 1.0 - x, 1.0 - y]));
        }
        let a = IvfIndex::build(&rows, "m", 4);
        let b = IvfIndex::build(&rows, "m", 4);
        let q = vec![0.3f32, 0.4, 0.5, 0.6];
        let hits_a = a.top_k_cosine(&q, 10);
        let hits_b = b.top_k_cosine(&q, 10);
        assert_eq!(hits_a, hits_b);
        assert!(!hits_a.is_empty());
    }

    /// Brute-force reference for recall@k comparison in the test
    /// below. Mirrors the semantics of
    /// [`crate::hybrid::rank_chunks_by_cosine`] minus the
    /// `RankedCandidate` wrapping.
    fn brute_force_top_k(
        rows: &[ChunkEmbeddingRow],
        model_id: &str,
        query: &[f32],
        k: usize,
    ) -> Vec<i64> {
        use crate::embedding::cosine_similarity;
        let mut scored: Vec<(i64, f32)> = rows
            .iter()
            .filter(|r| r.model_id == model_id && r.vector.len() == query.len())
            .map(|r| (r.chunk_id, cosine_similarity(&r.vector, query)))
            .collect();
        scored.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        scored.into_iter().take(k).map(|(id, _)| id).collect()
    }

    #[test]
    fn ivf_recall_at_10_meets_threshold_on_clustered_corpus() {
        // Generate a 2000-vector synthetic corpus in 64 dims with
        // 20 underlying clusters (each cluster = a random base
        // direction perturbed by Gaussian-ish noise). This mimics
        // real embedding distributions where the corpus has
        // semantic structure — random uniform vectors in 64 dims
        // hit "concentration of measure" and even FAISS struggles
        // to beat 30-40% recall on them.
        //
        // The query is placed near (but not exactly at) one of the
        // cluster centres so the top-10 brute-force results are
        // mostly drawn from that cluster. IVF should probe the
        // cell(s) containing that cluster and recover the bulk
        // of the brute-force results — we require at least 7 of
        // 10 to flag a regression while leaving headroom for the
        // remaining stochastic component.
        let dim = 64;
        let n = 2000;
        let n_clusters = 20;
        let mut rng = StdRng::seed_from_u64(0xDEAD_BEEF_CAFE_BABE);

        // Pick `n_clusters` random unit-direction cluster centres.
        let mut centres: Vec<Vec<f32>> = (0..n_clusters)
            .map(|_| {
                let mut v: Vec<f32> = (0..dim).map(|_| rng.gen_range(-1.0f32..1.0)).collect();
                let n: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
                if n > 0.0 {
                    for x in &mut v {
                        *x /= n;
                    }
                }
                v
            })
            .collect();

        // Build the corpus by perturbing each cluster centre with
        // small Gaussian-ish noise (sum of two uniforms approximates
        // a normal). Round-robin across clusters so they're roughly
        // balanced in size.
        let mut rows = Vec::with_capacity(n);
        for i in 0..n {
            let centre = &centres[i % n_clusters];
            let mut v: Vec<f32> = centre
                .iter()
                .map(|c| {
                    let noise = (rng.gen_range(-1.0f32..1.0) + rng.gen_range(-1.0f32..1.0)) * 0.15;
                    c + noise
                })
                .collect();
            // Normalise so the test exercises the same on-sphere
            // distribution that real embedding providers produce.
            let n_norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if n_norm > 0.0 {
                for x in &mut v {
                    *x /= n_norm;
                }
            }
            rows.push(row(i as i64, "m", v));
        }

        // Query: cluster 0's centre with a tiny perturbation so the
        // top-10 brute-force results are mostly from cluster 0.
        let target = centres.swap_remove(0);
        let query: Vec<f32> = target
            .iter()
            .map(|c| c + rng.gen_range(-0.05f32..0.05))
            .collect();

        let idx = IvfIndex::build(&rows, "m", dim);
        let ivf_hits: Vec<i64> = idx
            .top_k_cosine(&query, 10)
            .into_iter()
            .map(|h| h.chunk_id)
            .collect();
        let brute_hits = brute_force_top_k(&rows, "m", &query, 10);

        let overlap = ivf_hits.iter().filter(|id| brute_hits.contains(id)).count();
        assert!(
            overlap >= 7,
            "IVF recall@10 too low: overlap={overlap}, ivf={ivf_hits:?}, brute={brute_hits:?}"
        );
    }

    #[test]
    fn top_k_truncates_to_corpus_size() {
        let rows = vec![
            row(1, "m", vec![1.0, 0.0]),
            row(2, "m", vec![0.0, 1.0]),
            row(3, "m", vec![-1.0, 0.0]),
        ];
        let idx = IvfIndex::build(&rows, "m", 2);
        let hits = idx.top_k_cosine(&[1.0, 0.0], 100);
        assert!(hits.len() <= 3);
        assert!(!hits.is_empty());
    }

    #[test]
    fn top_hit_is_query_aligned_vector() {
        let rows = vec![
            row(1, "m", vec![1.0, 0.0, 0.0]),
            row(2, "m", vec![0.7, 0.7, 0.0]),
            row(3, "m", vec![-1.0, 0.0, 0.0]),
        ];
        let idx = IvfIndex::build(&rows, "m", 3);
        let hits = idx.top_k_cosine(&[1.0, 0.0, 0.0], 1);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk_id, 1);
        assert!((hits[0].score - 1.0).abs() < 1e-6);
    }

    #[test]
    fn tied_scores_tiebreak_on_chunk_id_ascending() {
        // Two identical vectors → identical cosine → must rank
        // by chunk_id ascending. Mirrors the
        // `rank_chunks_by_cosine` contract so the brute-force /
        // ANN paths produce the same ordering for tied results.
        let rows = vec![
            row(2, "m", vec![1.0, 0.0]),
            row(1, "m", vec![1.0, 0.0]),
            row(3, "m", vec![1.0, 0.0]),
        ];
        let idx = IvfIndex::build(&rows, "m", 2);
        let hits = idx.top_k_cosine(&[1.0, 0.0], 3);
        let ids: Vec<i64> = hits.iter().map(|h| h.chunk_id).collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn tied_scores_evict_high_chunk_ids_when_k_lt_n() {
        // Regression: on the IVF index. When all
        // candidates have equal scores and `k < n`, the bounded heap
        // must evict entries with the HIGHEST chunk_id so the result
        // matches brute force's (score desc, chunk_id asc) → take(k)
        // contract. A previous tiebreaker direction silently kept the
        // wrong rows for ties spanning the k boundary.
        let rows = vec![
            row(1, "m", vec![1.0, 0.0]),
            row(2, "m", vec![1.0, 0.0]),
            row(3, "m", vec![1.0, 0.0]),
            row(4, "m", vec![1.0, 0.0]),
            row(5, "m", vec![1.0, 0.0]),
        ];
        let idx = IvfIndex::build(&rows, "m", 2);
        let hits = idx.top_k_cosine(&[1.0, 0.0], 2);
        let ids: Vec<i64> = hits.iter().map(|h| h.chunk_id).collect();
        assert_eq!(
            ids,
            vec![1, 2],
            "expected lowest two chunk_ids when ties span the k boundary"
        );
    }

    #[test]
    fn zero_query_vector_is_handled_without_nan() {
        // Cosine against a zero vector is 0.0 per the
        // `cosine_similarity` contract. The IVF path must not
        // produce NaN scores or panic.
        let rows = vec![row(1, "m", vec![1.0, 0.0]), row(2, "m", vec![0.0, 1.0])];
        let idx = IvfIndex::build(&rows, "m", 2);
        let hits = idx.top_k_cosine(&[0.0, 0.0], 2);
        for h in &hits {
            assert!(h.score.is_finite(), "score is NaN: {h:?}");
        }
    }

    #[test]
    fn zero_indexed_vector_is_kept_and_returns_zero_score() {
        // A stored zero vector cannot have a non-zero cosine
        // against anything. It still has to make it through the
        // assign/update loop without poisoning a centroid.
        let rows = vec![row(1, "m", vec![0.0, 0.0]), row(2, "m", vec![1.0, 0.0])];
        let idx = IvfIndex::build(&rows, "m", 2);
        let hits = idx.top_k_cosine(&[1.0, 0.0], 2);
        // The non-zero, query-aligned vector must rank first.
        assert_eq!(hits[0].chunk_id, 2);
        assert!((hits[0].score - 1.0).abs() < 1e-6);
    }

    #[test]
    fn pick_k_respects_bounds() {
        assert_eq!(pick_k(1), 1); // n < MIN_CENTROIDS → capped to n
        assert_eq!(pick_k(4), 4);
        assert_eq!(pick_k(8), 8);
        assert!(pick_k(100) >= MIN_CENTROIDS);
        assert!(pick_k(100) <= MAX_CENTROIDS);
        assert_eq!(pick_k(1_000_000), MAX_CENTROIDS);
    }

    #[test]
    fn pick_nprobe_respects_bounds() {
        assert_eq!(pick_nprobe(1), 1);
        assert_eq!(pick_nprobe(4), 2);
        assert!(pick_nprobe(256) >= 1);
        assert!(pick_nprobe(256) <= 256);
    }

    #[test]
    fn build_above_threshold_does_not_panic_and_produces_results() {
        // Smoke test at the brute-force / IVF crossover. Mostly a
        // shape check — recall is covered by
        // `ivf_recall_at_10_meets_threshold_on_random_corpus`.
        let dim = 16;
        let n = IVF_BRUTE_FORCE_THRESHOLD + 10;
        let mut rng = StdRng::seed_from_u64(7);
        let rows: Vec<ChunkEmbeddingRow> = (0..n)
            .map(|i| {
                let v: Vec<f32> = (0..dim).map(|_| rng.gen_range(-1.0f32..1.0)).collect();
                row(i as i64, "m", v)
            })
            .collect();
        let idx = IvfIndex::build(&rows, "m", dim);
        assert_eq!(idx.len(), n);
        let query: Vec<f32> = (0..dim).map(|_| rng.gen_range(-1.0f32..1.0)).collect();
        let hits = idx.top_k_cosine(&query, 5);
        assert_eq!(hits.len(), 5);
    }
}
