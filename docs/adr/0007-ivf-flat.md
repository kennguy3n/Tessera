# 7. IVF-Flat ANN index for vector search

## Status

Accepted.

## Context

The hybrid retrieval pipeline fuses a vector-similarity signal with BM25
lexical search and recency
(`crates/tessera_sources/src/hybrid.rs`). The original vector path
loaded every stored embedding for the active model and ran a
brute-force `O(N * D)` cosine pass on each query. On a 50K-chunk corpus
with 384-dimension embeddings that is ~19M float multiplies per query,
plus the SQL scan and blob decode — enough to dominate query latency and
feed back into UI lag as corpora grow.

We need an approximate-nearest-neighbour (ANN) index that is sublinear
in corpus size, deterministic (for test stability and caching), pure
Rust (no native ANN dependency, to keep the build self-contained), and
observationally identical to the brute-force path up to recall.

## Decision

Implement an in-memory **IVF-Flat** ("inverted file with flat
quantisation") index in `crates/tessera_sources/src/vector_index.rs`:

- Run deterministically-seeded k-means with
  `K = ⌈√N⌉.clamp(8, 256).min(N)` cells; assign each vector to its
  nearest centroid to form `K` inverted lists.
- To answer a top-k query, rank centroids by cosine to the query, probe
  the top `nprobe = ⌈√K⌉` cells, and brute-force only inside the probed
  cells. Query work is roughly `O(√N·D + N^(3/4)·D)`, i.e. sublinear.
- All vectors and centroids are L2-normalised, so cosine reduces to a
  dot product and the dim-mismatch / zero-vector handling matches the
  brute-force `cosine_similarity` semantics.
- Below `IVF_BRUTE_FORCE_THRESHOLD = 1024` chunks, fall back to
  brute-force, where constant factors make IVF not worth building.
- The index is cached as an `Arc<IvfIndex>` keyed by `(model_id,
generation)`; the `SourceStore` owns the freshness/invalidation
  contract and calls `IvfIndex::build` on a cache miss.

## Consequences

- Vector search is sublinear and roughly ~6× faster at 50K chunks, with
  the gap widening as the corpus grows, keeping retrieval off the UI
  critical path.
- IVF-Flat is approximate, so recall is below an exhaustive scan; the
  `nprobe`/centroid bounds and the brute-force threshold are tuned to
  keep recall high at Tessera's scale, and the small-corpus fallback
  preserves exactness where it matters most.
- A pure-Rust, deterministically-seeded implementation avoids a native
  ANN dependency and keeps builds reproducible, at the cost of
  maintaining the k-means/IVF code ourselves.
- The index lives in memory and is rebuilt on cache miss, so the
  `(model_id, generation)` cache key and the store's invalidation logic
  are load-bearing; switching embedding providers re-keys and rebuilds
  the index.
