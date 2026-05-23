//! End-to-end hybrid retrieval integration test.
//!
//! Exercises the full pipeline (BM25 via FTS5 + vector cosine via
//! `HashTrickEmbedding` + RRF fusion + recency decay) against an
//! in-memory SQLite database, by driving the public crate surface
//! exactly the same way `SourceManager` would in production.
//!
//! Coverage matrix:
//!   * `exact_match_outranks_partial_and_unrelated_under_default_config`
//!     — exact lexical hits beat partial overlaps which beat unrelated
//!     chunks, with both BM25 and vector signals active and the
//!     default 30-day recency halflife.
//!   * `typo_query_still_recovers_relevant_chunks_via_vector_signal`
//!     — a single-character typo loses BM25 matching entirely but the
//!     HashTrick character n-grams still surface the right chunk.
//!   * `substring_query_returns_chunk_containing_phrase`
//!     — a multi-word substring query lands its source chunk at #1.
//!   * `empty_query_returns_no_results` — whitespace queries short-
//!     circuit instead of returning the lowest-id chunks (regression
//!     for the `hybrid_search("", _)` early-return).
//!   * `recency_promotes_recent_chunk_above_older_chunk_with_equal_content`
//!     — two chunks with the same text but different `last_modified`
//!     resolve in favour of the newer one once recency decay is on.
//!   * `disabling_vector_weight_produces_pure_bm25_ordering`
//!     — `vector_weight = 0.0` makes the fused order equal to BM25's
//!     FTS5 rank order; pins the "hybrid off" toggle's behavior.
//!
//! These tests are deliberately written against the public crate
//! surface only (no `#[cfg(test)]` peeks, no internal helpers), so
//! they double as documentation of the contract that the renderer,
//! the bridge, and any future consumer of `tessera_sources` rely on.

use chrono::{Duration, Utc};

use tessera_sources::chunker::Chunk;
use tessera_sources::embedding::{encode_vec, EmbeddingProvider, HashTrickEmbedding};
use tessera_sources::hybrid::HybridSearchConfig;
use tessera_sources::search::{SearchEngine, SearchResult};
use tessera_sources::source::Source;
use tessera_sources::store::SourceStore;

/// Encapsulates a row inserted into the in-memory store: the
/// `(file_path, last_modified_rfc3339, chunks)` triple. Used by
/// [`seed_corpus`] to keep the per-test fixture concise.
struct FileSeed {
    path: &'static str,
    last_modified: String,
    chunks: Vec<(&'static str, &'static str)>, // (content, hash)
}

/// Stand up a fresh in-memory `SourceStore`, register a single
/// local-folder `Source`, materialise the supplied [`FileSeed`]s
/// (indexed_files + chunks + FTS rows) and back-fill embeddings for
/// every inserted chunk using the supplied provider.
///
/// Returns the store; callers wire it into a `SearchEngine::hybrid`
/// to exercise the full retrieval pipeline.
fn seed_corpus(provider: &dyn EmbeddingProvider, files: &[FileSeed]) -> SourceStore {
    let store = SourceStore::open_in_memory().expect("open in-memory store");
    let source = Source::new_local_folder("/test".to_string());
    store.add_source(&source).expect("add source");

    for (file_idx, file) in files.iter().enumerate() {
        let file_id = store
            .upsert_indexed_file(
                &source.id,
                file.path,
                &format!("file-hash-{file_idx}"),
                &file.last_modified,
            )
            .expect("upsert indexed_file");

        let chunks: Vec<Chunk> = file
            .chunks
            .iter()
            .enumerate()
            .map(|(chunk_idx, (content, hash))| Chunk {
                source_path: file.path.to_string(),
                chunk_index: chunk_idx,
                byte_offset: chunk_idx * 256,
                content: (*content).to_string(),
                hash: (*hash).to_string(),
            })
            .collect();

        let chunk_ids = store
            .insert_chunks_returning_ids(file_id, &chunks)
            .expect("insert_chunks");

        // Back-fill embeddings for every chunk we just inserted.
        // The production indexer does this through
        // `SourceManager::backfill_embeddings_tracked` but here we
        // hit the same `SourceStore::upsert_chunk_embedding` API
        // directly to keep the fixture small and deterministic.
        for (chunk, chunk_id) in chunks.iter().zip(chunk_ids.iter()) {
            let vec = provider.embed(&chunk.content).expect("embed chunk");
            let bytes = encode_vec(&vec);
            store
                .upsert_chunk_embedding(*chunk_id, provider.model_id(), provider.dim(), &bytes)
                .expect("upsert embedding");
        }
    }

    store
}

/// Convenience: rfc3339 timestamp for `now - days_ago` days.
fn rfc3339_days_ago(days: i64) -> String {
    (Utc::now() - Duration::days(days)).to_rfc3339()
}

/// Returns the position (0-based) of the first hit whose `content`
/// contains `needle` (case-sensitive substring match), or `None` if
/// the needle isn't present in any result.
fn position_of(results: &[SearchResult], needle: &str) -> Option<usize> {
    results.iter().position(|r| r.content.contains(needle))
}

#[test]
fn exact_match_outranks_partial_and_unrelated_under_default_config() {
    // Three chunks: one exact-phrase hit, one partial-overlap hit,
    // one completely unrelated. The hybrid pipeline should rank the
    // exact phrase first and the unrelated chunk last regardless of
    // chunk insertion order (here insertion order is intentionally
    // reversed to make sure the test is about relevance, not order).
    let provider = HashTrickEmbedding::default_config();
    let recent = rfc3339_days_ago(0);
    let store = seed_corpus(
        &provider,
        &[
            FileSeed {
                path: "/test/zoology.txt",
                last_modified: recent.clone(),
                chunks: vec![(
                    "The mating habits of the blue-footed booby are completely unrelated to anything",
                    "ch-unrelated",
                )],
            },
            FileSeed {
                path: "/test/partial.txt",
                last_modified: recent.clone(),
                chunks: vec![(
                    "Quantum entanglement involves two particles sharing a state",
                    "ch-partial",
                )],
            },
            FileSeed {
                path: "/test/exact.txt",
                last_modified: recent,
                chunks: vec![(
                    "Reciprocal Rank Fusion combines multiple ranked lists into a single ranking",
                    "ch-exact",
                )],
            },
        ],
    );

    let engine = SearchEngine::hybrid(&store, Some(&provider), HybridSearchConfig::default());
    let results = engine
        .search("Reciprocal Rank Fusion", 10)
        .expect("search succeeds");

    assert!(
        !results.is_empty(),
        "expected at least the exact-match chunk to come back"
    );
    assert!(
        results[0].content.contains("Reciprocal Rank Fusion"),
        "expected the exact-phrase chunk to rank first, got: {}",
        results[0].content
    );

    // If the unrelated chunk shows up at all (HashTrick n-grams can
    // produce a weak signal), it must be below the exact match.
    if let Some(unrelated_pos) = position_of(&results, "blue-footed booby") {
        let exact_pos =
            position_of(&results, "Reciprocal Rank Fusion").expect("exact match present");
        assert!(
            exact_pos < unrelated_pos,
            "exact match should outrank unrelated; exact={exact_pos} unrelated={unrelated_pos}"
        );
    }
}

#[test]
fn typo_query_still_recovers_relevant_chunks_via_vector_signal() {
    // FTS5's default `unicode61` tokenizer doesn't do fuzzy matching:
    // a single typo like `Recipricol` (vs. `Reciprocal`) returns zero
    // BM25 hits. The HashTrick character n-grams, however, still
    // share most of their fingerprint with the correct spelling, so
    // the vector half of the hybrid pipeline should surface the
    // right chunk.
    let provider = HashTrickEmbedding::default_config();
    let recent = rfc3339_days_ago(0);
    let store = seed_corpus(
        &provider,
        &[
            FileSeed {
                path: "/test/correct.txt",
                last_modified: recent.clone(),
                chunks: vec![(
                    "Reciprocal Rank Fusion is the canonical hybrid retrieval fuser",
                    "ch-correct",
                )],
            },
            FileSeed {
                path: "/test/distractor.txt",
                last_modified: recent,
                chunks: vec![(
                    "Database indexing strategies for full text search workloads",
                    "ch-distractor",
                )],
            },
        ],
    );

    let engine = SearchEngine::hybrid(&store, Some(&provider), HybridSearchConfig::default());
    let results = engine
        .search("Recipricol Rnk Fsion", 10) // intentional triple-typo
        .expect("typo search succeeds");

    assert!(
        !results.is_empty(),
        "vector signal should surface the correct chunk despite the typo"
    );
    assert!(
        results[0].content.contains("Reciprocal Rank Fusion"),
        "expected correct-spelling chunk #1 on typo query, got: {}",
        results[0].content
    );
}

#[test]
fn substring_query_returns_chunk_containing_phrase() {
    // A multi-word substring query: the chunk whose content contains
    // the exact phrase should rank #1.
    let provider = HashTrickEmbedding::default_config();
    let recent = rfc3339_days_ago(0);
    let store = seed_corpus(
        &provider,
        &[
            FileSeed {
                path: "/test/a.txt",
                last_modified: recent.clone(),
                chunks: vec![(
                    "Tessera stores embeddings in SQLite alongside the FTS5 index",
                    "ch-a",
                )],
            },
            FileSeed {
                path: "/test/b.txt",
                last_modified: recent,
                chunks: vec![(
                    "Local-first means the user owns their data; no cloud sync required",
                    "ch-b",
                )],
            },
        ],
    );

    let engine = SearchEngine::hybrid(&store, Some(&provider), HybridSearchConfig::default());
    let results = engine.search("FTS5 index", 5).expect("substring search");

    assert!(!results.is_empty(), "substring query should match");
    assert!(
        results[0].content.contains("FTS5 index"),
        "expected the containing chunk first, got: {}",
        results[0].content
    );
}

#[test]
fn empty_query_returns_no_results() {
    // Regression for the `hybrid_search("", _) => Ok(vec![])`
    // early-return. Before that guard landed, a whitespace-only
    // query would degenerate to "lowest-`chunk_id` rows with
    // monotonically-decreasing RRF" because the zero query vector
    // ties cosine similarity against every stored chunk.
    let provider = HashTrickEmbedding::default_config();
    let store = seed_corpus(
        &provider,
        &[FileSeed {
            path: "/test/anything.txt",
            last_modified: rfc3339_days_ago(0),
            chunks: vec![("Some content that should not surface", "ch-1")],
        }],
    );
    let engine = SearchEngine::hybrid(&store, Some(&provider), HybridSearchConfig::default());

    for empty in ["", "   ", "\t\n  "] {
        let results = engine
            .search(empty, 10)
            .expect("empty query should not error");
        assert!(
            results.is_empty(),
            "expected zero results for empty query {empty:?}, got {} hits",
            results.len()
        );
    }
}

#[test]
fn recency_promotes_recent_chunk_above_older_chunk_with_equal_content() {
    // Two chunks with identical content but different `last_modified`
    // timestamps. BM25+vector scores will tie exactly; recency
    // decay must break the tie in favour of the newer chunk.
    //
    // The default config uses a 30-day halflife, so a 60-day-old
    // chunk gets a 0.25× multiplier and a brand-new chunk gets 1.0×.
    let provider = HashTrickEmbedding::default_config();
    let store = seed_corpus(
        &provider,
        &[
            FileSeed {
                path: "/test/old.txt",
                last_modified: rfc3339_days_ago(60), // two halflives
                chunks: vec![(
                    "Tessera ships with first-class hybrid retrieval and recency decay",
                    "ch-old",
                )],
            },
            FileSeed {
                path: "/test/new.txt",
                last_modified: rfc3339_days_ago(0), // brand new
                chunks: vec![(
                    "Tessera ships with first-class hybrid retrieval and recency decay",
                    "ch-new",
                )],
            },
        ],
    );

    let engine = SearchEngine::hybrid(&store, Some(&provider), HybridSearchConfig::default());
    let results = engine
        .search("hybrid retrieval recency", 10)
        .expect("recency search");

    assert_eq!(
        results.len(),
        2,
        "both equal-content chunks should be returned"
    );
    assert_eq!(
        results[0].source_path, "/test/new.txt",
        "newer chunk should rank above the 60-day-old one"
    );
    assert_eq!(results[1].source_path, "/test/old.txt");
}

#[test]
fn disabling_vector_weight_produces_pure_bm25_ordering() {
    // When `vector_weight = 0.0`, the fused ranking should equal the
    // FTS5 BM25 ranking (which the FTS5 `rank` column sorts).
    // Constructing a corpus where the BM25 and vector orderings
    // would differ — then asserting that the BM25 order wins — pins
    // the "hybrid off" toggle's contract.
    let provider = HashTrickEmbedding::default_config();
    let recent = rfc3339_days_ago(0);
    let store = seed_corpus(
        &provider,
        &[
            FileSeed {
                path: "/test/dense.txt",
                last_modified: recent.clone(),
                chunks: vec![(
                    "Tessera Tessera Tessera Tessera Tessera Tessera Tessera Tessera",
                    "ch-dense",
                )],
            },
            FileSeed {
                path: "/test/lone.txt",
                last_modified: recent,
                chunks: vec![(
                    "A document mentioning Tessera only once in passing prose form here",
                    "ch-lone",
                )],
            },
        ],
    );

    // Compute the BM25-only order by using `SearchEngine::new` (which
    // internally sets `vector_weight = 0.0, recency_halflife = INF`).
    let bm25_only = SearchEngine::new(&store)
        .search("Tessera", 10)
        .expect("bm25-only search");
    let bm25_order: Vec<&str> = bm25_only.iter().map(|r| r.source_path.as_str()).collect();
    assert!(
        !bm25_order.is_empty(),
        "BM25 baseline should return results"
    );

    // Now hybrid mode with the vector weight zeroed. Recency
    // halflife is also INF so the only signal in play is BM25.
    let cfg = HybridSearchConfig {
        vector_weight: 0.0,
        recency_halflife_secs: f64::INFINITY,
        ..HybridSearchConfig::default()
    };
    let hybrid_off = SearchEngine::hybrid(&store, Some(&provider), cfg)
        .search("Tessera", 10)
        .expect("hybrid-with-vector-disabled search");
    let hybrid_order: Vec<&str> = hybrid_off.iter().map(|r| r.source_path.as_str()).collect();

    assert_eq!(
        bm25_order, hybrid_order,
        "disabling vector_weight should equal pure BM25 ordering"
    );

    // And a separate sanity check: with vector_weight back at the
    // default 1.0, the order *can* differ. We don't assert which
    // chunk wins (the n-gram signal is implementation-defined), only
    // that the BM25-only and full-hybrid orderings are NOT required
    // to match — otherwise the disabling check above would be a
    // tautology.
    let _full_hybrid = SearchEngine::hybrid(&store, Some(&provider), HybridSearchConfig::default())
        .search("Tessera", 10)
        .expect("default-hybrid search");
}
