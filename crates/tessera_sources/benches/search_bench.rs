//! hybrid search latency benchmark.
//!
//! Drives [`hybrid_search`] against an in-memory `SourceStore`
//! pre-seeded with 1K, 10K, and 100K synthetic chunks so we can
//! track p50 latency at the three corpus sizes that bracket the
//! realistic user workload:
//!
//!   - **1K chunks** — fresh source pointing at a documentation
//!     folder. p50 latency must stay under 5 ms here so the search
//!     palette feels instantaneous.
//!   - **10K chunks** — typical mid-sized personal corpus
//!     (Documents + Notes + Drive sync). Target: under 50 ms.
//!   - **100K chunks** — large personal corpus (everything an
//!     enthusiast user might index). Target: under 200 ms.
//!
//! Each size is benchmarked twice: once with the vector signal
//! enabled (true hybrid path) and once with `vector_weight = 0.0`
//! (BM25-only, the `SearchEngine::new()` fallback used when no
//! embeddings are present). Comparing the two reveals the per-
//! signal cost so a future optimisation can target the slow half
//! directly.
//!
//! The seeded chunks have realistic distribution: 80% of the
//! corpus uses a small vocabulary (~200 words from the standard
//! "lorem ipsum"-style English text) so BM25 has plenty of
//! matches; the remaining 20% are unique phrases so the vector
//! signal contributes meaningful reranking.
//!
//! Run with `cargo bench -p tessera_sources --bench search_bench`.

use chrono::Utc;
use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};

use tessera_sources::chunker::Chunk;
use tessera_sources::embedding::{encode_vec, EmbeddingProvider, HashTrickEmbedding};
use tessera_sources::hybrid::{hybrid_search, HybridSearchConfig};
use tessera_sources::source::Source;
use tessera_sources::store::SourceStore;

const COMMON_TOKENS: &[&str] = &[
    "alpha",
    "beta",
    "gamma",
    "delta",
    "epsilon",
    "zeta",
    "eta",
    "theta",
    "iota",
    "kappa",
    "lambda",
    "mu",
    "nu",
    "xi",
    "omicron",
    "pi",
    "rho",
    "sigma",
    "tau",
    "upsilon",
    "phi",
    "chi",
    "psi",
    "omega",
    "lorem",
    "ipsum",
    "dolor",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "do",
    "eiusmod",
    "tempor",
    "incididunt",
    "labore",
    "magna",
    "aliqua",
    "enim",
    "minim",
    "veniam",
    "quis",
    "nostrud",
    "exercitation",
    "ullamco",
    "laboris",
    "nisi",
    "aliquip",
    "ex",
    "ea",
    "commodo",
    "consequat",
    "duis",
    "aute",
    "irure",
    "reprehenderit",
    "voluptate",
    "velit",
    "esse",
    "cillum",
    "dolore",
    "fugiat",
    "nulla",
    "pariatur",
    "excepteur",
    "sint",
    "occaecat",
    "cupidatat",
    "non",
    "proident",
    "sunt",
    "culpa",
    "qui",
    "officia",
    "deserunt",
    "mollit",
    "anim",
    "id",
    "est",
];

fn synthetic_chunk_content(i: usize) -> String {
    // 80% draw from COMMON_TOKENS so BM25 has many matches.
    // 20% inject a unique marker so the vector signal sees
    // genuinely distinct n-gram fingerprints between chunks.
    let mut words = Vec::with_capacity(8);
    for j in 0..6 {
        let t = COMMON_TOKENS[(i + j) % COMMON_TOKENS.len()];
        words.push(t.to_string());
    }
    if i % 5 == 0 {
        words.push(format!("uniqueid{i:06}"));
    }
    words.join(" ")
}

fn seed_store(chunk_count: usize, provider: &dyn EmbeddingProvider) -> SourceStore {
    let store = SourceStore::open_in_memory().expect("open in-memory store");
    let source = Source::new_local_folder("/bench".to_string());
    store.add_source(&source).expect("add source");

    let last_modified = Utc::now().to_rfc3339();
    // Distribute chunks across 200 synthetic files so the FTS5
    // index has realistic per-file partitioning. (A single
    // 100K-chunk file is degenerate — FTS5's segment merge cost
    // skews differently from the realistic many-files case.)
    let files = 200.max(chunk_count / 50);
    let chunks_per_file = chunk_count.div_ceil(files);

    let mut chunk_id_global = 0usize;
    for file_idx in 0..files {
        if chunk_id_global >= chunk_count {
            break;
        }
        let path = format!("/bench/file-{file_idx:05}.txt");
        let file_id = store
            .upsert_indexed_file(
                &source.id,
                &path,
                &format!("file-hash-{file_idx}"),
                &last_modified,
            )
            .expect("upsert indexed_file");

        let take = (chunks_per_file).min(chunk_count - chunk_id_global);
        let chunks: Vec<Chunk> = (0..take)
            .map(|local_idx| {
                let global_idx = chunk_id_global + local_idx;
                Chunk {
                    source_path: path.clone(),
                    chunk_index: local_idx,
                    byte_offset: local_idx * 256,
                    content: synthetic_chunk_content(global_idx),
                    hash: format!("chunk-{global_idx:08}"),
                    extraction_method: None,
                    extraction_model_id: None,
                }
            })
            .collect();

        let chunk_ids = store
            .insert_chunks_returning_ids(file_id, &chunks)
            .expect("insert_chunks");

        for (chunk, chunk_id) in chunks.iter().zip(chunk_ids.iter()) {
            let vec = provider.embed(&chunk.content).expect("embed chunk");
            let bytes = encode_vec(&vec);
            store
                .upsert_chunk_embedding(*chunk_id, provider.model_id(), provider.dim(), &bytes)
                .expect("upsert embedding");
        }

        chunk_id_global += take;
    }

    store
}

const QUERIES: &[&str] = &[
    "alpha beta gamma",
    "uniqueid001234",
    "lorem ipsum",
    "consectetur adipiscing",
];

fn bench_at_size(c: &mut Criterion, label: &str, chunk_count: usize) {
    let provider = HashTrickEmbedding::default_config();
    let store = seed_store(chunk_count, &provider);

    let hybrid_cfg = HybridSearchConfig::default();
    let bm25_only_cfg = HybridSearchConfig {
        vector_weight: 0.0,
        ..HybridSearchConfig::default()
    };

    let mut group = c.benchmark_group(format!("hybrid_search:{label}"));
    group.sample_size(20);

    for q in QUERIES {
        group.bench_with_input(BenchmarkId::new("hybrid", q), q, |b, query| {
            b.iter(|| {
                let results = hybrid_search(
                    &store,
                    Some(&provider as &dyn EmbeddingProvider),
                    query,
                    query,
                    10,
                    &hybrid_cfg,
                );
                let _ = black_box(results);
            });
        });

        group.bench_with_input(BenchmarkId::new("bm25-only", q), q, |b, query| {
            b.iter(|| {
                let results = hybrid_search(&store, None, query, query, 10, &bm25_only_cfg);
                let _ = black_box(results);
            });
        });
    }
    group.finish();
}

fn search_bench(c: &mut Criterion) {
    bench_at_size(c, "1k", 1_000);
    bench_at_size(c, "10k", 10_000);
    // 100K is gated behind an env var because seeding 100K chunks
    // takes ~30 s and bloats the default `cargo bench` run. Set
    // `TESSERA_BENCH_100K=1` to enable it for a focused run.
    if std::env::var("TESSERA_BENCH_100K").is_ok() {
        bench_at_size(c, "100k", 100_000);
    }
}

criterion_group!(benches, search_bench);
criterion_main!(benches);
