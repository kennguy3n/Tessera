//! The search engine: hybrid lexical + vector retrieval over indexed
//! source chunks.

use std::collections::HashMap;

use tessera_core::error::Result;

use crate::embedding::EmbeddingProvider;
use crate::hybrid::{hybrid_search_with_retention, HybridSearchConfig};
use crate::store::SourceStore;

/// Runs full-text (BM25) and optional hybrid vector/recency search
/// over a [`SourceStore`], producing ranked [`SearchResult`]s.
pub struct SearchEngine<'a> {
    store: &'a SourceStore,
    provider: Option<&'a dyn EmbeddingProvider>,
    config: HybridSearchConfig,
    /// Per-source retention scores from the knowledge substrate, fed
    /// into the hybrid RRF fusion as a fourth signal. Empty for the
    /// `new`/`hybrid` constructors (BM25 + vector + recency only);
    /// populated via [`SearchEngine::hybrid_with_retention`].
    retention_by_source: HashMap<String, f64>,
}

#[derive(Debug, Clone)]
/// A single ranked hit: the matching chunk plus enough provenance to
/// build a citation and a relevance score for display.
pub struct SearchResult {
    /// Full text of the matching chunk.
    pub content: String,
    /// Short snippet around the match, for preview in the UI.
    pub excerpt: String,
    /// Path of the source the chunk came from.
    pub source_path: String,
    /// Id of the source the chunk came from.
    pub source_id: String,
    /// Position of the chunk within its source.
    pub chunk_index: usize,
    /// Reciprocal-rank relevance score, bounded to `(0.0, 1.0]`.
    ///
    /// For the result ranked at position `i` (1-based) in the
    /// query result list, this is `1.0 / i`. The highest-ranked
    /// result therefore has `relevance == 1.0`; the second has
    /// `0.5`; the third `0.333`; and so on.
    ///
    /// Why reciprocal-rank rather than the raw BM25 / RRF /
    /// recency-fused score:
    ///
    /// * The fused score combines three signals (BM25, cosine,
    ///   recency) with weights from `HybridSearchConfig`. Its
    ///   magnitude is not stable across queries (or across
    ///   weight configurations) and is therefore meaningless as
    ///   an absolute confidence value at the UI layer.
    /// * Reciprocal-rank is *position-stable*: the top hit is
    ///   always `1.0`, the second always `0.5`, regardless of
    ///   which signals fired.
    /// * The renderer (`CitationPanel`) displays this value as a
    ///   percentage; bounding to `(0, 1]` means the displayed
    ///   value is always in `[1%, 100%]` instead of the
    ///   previous BM25-derived path which could produce
    ///   nonsensical magnitudes (raw `-FTS5_rank` was unbounded
    ///   positive and routinely exceeded 2.0, displaying as
    ///   "230%" etc.).
    ///
    /// Compatibility note: chunks indexed prior to the
    /// hybrid-retrieval landing have citation `confidence`
    /// values stored on disk in the *old* BM25-derived
    /// magnitude. Renderer code that needs to compare against
    /// stored values should clamp on read; new values are
    /// always in `(0, 1]`. The
    /// `search_result_relevance_is_bounded` regression test
    /// pins the new contract.
    pub relevance: f64,
    /// Content hash of the matched chunk.
    pub hash: String,
}

impl<'a> SearchEngine<'a> {
    /// Build a search engine that runs BM25-only retrieval (no
    /// vector / no recency). Kept for backwards compatibility with
    /// call sites that haven't been migrated to hybrid yet.
    pub fn new(store: &'a SourceStore) -> Self {
        Self {
            store,
            provider: None,
            config: HybridSearchConfig {
                vector_weight: 0.0,
                recency_halflife_secs: f64::INFINITY,
                ..Default::default()
            },
            retention_by_source: HashMap::new(),
        }
    }

    /// Build a hybrid search engine. When `provider` is `Some`,
    /// vector cosine contributes to ranking via Reciprocal Rank
    /// Fusion alongside BM25; when `None`, only BM25 contributes.
    /// Recency decay is always applied per the supplied `config`.
    pub fn hybrid(
        store: &'a SourceStore,
        provider: Option<&'a dyn EmbeddingProvider>,
        config: HybridSearchConfig,
    ) -> Self {
        Self {
            store,
            provider,
            config,
            retention_by_source: HashMap::new(),
        }
    }

    /// Build a hybrid search engine that additionally fuses the
    /// knowledge-substrate retention signal (a fourth RRF input)
    /// using `retention_by_source` (Tessera source id → live
    /// retention score). Equivalent to [`SearchEngine::hybrid`] when
    /// the map is empty.
    pub fn hybrid_with_retention(
        store: &'a SourceStore,
        provider: Option<&'a dyn EmbeddingProvider>,
        config: HybridSearchConfig,
        retention_by_source: HashMap<String, f64>,
    ) -> Self {
        Self {
            store,
            provider,
            config,
            retention_by_source,
        }
    }

    /// Runs an AND-joined query (all terms must match), returning up
    /// to `limit` ranked results.
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        self.search_with_mode(query, limit, false)
    }

    /// Runs an OR-joined (broader) query, returning up to `limit`
    /// ranked results — useful when the strict query is too narrow.
    pub fn search_broad(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        self.search_with_mode(query, limit, true)
    }

    fn search_with_mode(
        &self,
        query: &str,
        limit: usize,
        use_or: bool,
    ) -> Result<Vec<SearchResult>> {
        let fts_query = build_fts_query(query, use_or);

        let ranked_ids = hybrid_search_with_retention(
            self.store,
            self.provider,
            query,
            &fts_query,
            limit,
            &self.config,
            &self.retention_by_source,
        )?;
        if ranked_ids.is_empty() {
            return Ok(Vec::new());
        }
        let hits = self.store.fetch_chunks_by_ids(&ranked_ids)?;

        // Build a (chunk_id -> 1-based rank) map so we can attach a
        // monotonically-decreasing relevance score to each result.
        // The actual fused score isn't surfaced to the renderer
        // (it's not stable across queries), but rank-based
        // relevance gives callers a usable ordering signal.
        let rank_of: std::collections::HashMap<i64, f64> = ranked_ids
            .iter()
            .enumerate()
            .map(|(i, id)| (*id, 1.0 / (i as f64 + 1.0)))
            .collect();

        let results = hits
            .into_iter()
            .map(|hit| {
                let excerpt = build_excerpt(&hit.content, query, 200);
                let relevance = rank_of.get(&hit.chunk_id).copied().unwrap_or(0.0);
                SearchResult {
                    content: hit.content,
                    excerpt,
                    source_path: hit.source_path,
                    source_id: hit.source_id,
                    chunk_index: hit.chunk_index,
                    relevance,
                    hash: hit.hash,
                }
            })
            .collect();

        Ok(results)
    }
}

fn sanitize_fts_term(term: &str) -> String {
    let cleaned: String = term
        .chars()
        .filter(|c| !matches!(c, '"' | '*' | '(' | ')' | '^' | '{' | '}'))
        .collect();
    if cleaned.is_empty() {
        return String::new();
    }
    format!("\"{cleaned}\"")
}

const STOPWORDS: &[&str] = &[
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "by",
    "for",
    "from",
    "has",
    "he",
    "in",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "she",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "to",
    "was",
    "were",
    "will",
    "with",
    "you",
    "your",
    "all",
    "also",
    "any",
    "been",
    "but",
    "can",
    "do",
    "each",
    "how",
    "if",
    "into",
    "may",
    "more",
    "most",
    "no",
    "not",
    "only",
    "other",
    "our",
    "out",
    "own",
    "so",
    "some",
    "such",
    "than",
    "too",
    "very",
    "what",
    "when",
    "which",
    "who",
    "whom",
    "why",
    "would",
    "about",
    "after",
    "before",
    "between",
    "both",
    "could",
    "did",
    "does",
    "done",
    "during",
    "get",
    "got",
    "had",
    "have",
    "her",
    "here",
    "him",
    "his",
    "just",
    "let",
    "like",
    "make",
    "my",
    "new",
    "now",
    "old",
    "over",
    "should",
    "still",
    "take",
    "through",
    "under",
    "up",
    "upon",
    "us",
    "use",
    "using",
    "we",
    "well",
    "where",
    "while",
    "citing",
    "relevant",
    "summarize",
    "describe",
    "explain",
    "outline",
];

fn is_stopword(word: &str) -> bool {
    STOPWORDS.contains(&word.to_ascii_lowercase().as_str())
}

pub(crate) fn build_fts_query(query: &str, use_or: bool) -> String {
    let terms: Vec<String> = query
        .split_whitespace()
        .filter(|w| !use_or || !is_stopword(w))
        .map(sanitize_fts_term)
        .filter(|t| !t.is_empty())
        .collect();
    if terms.is_empty() {
        return String::new();
    }
    if terms.len() == 1 {
        return terms.into_iter().next().unwrap();
    }
    terms.join(if use_or { " OR " } else { " AND " })
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    idx = idx.min(s.len());
    while idx < s.len() && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

pub(crate) fn build_excerpt(content: &str, query: &str, max_len: usize) -> String {
    let query_terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();

    let best_pos = query_terms
        .iter()
        .filter_map(|term| {
            content
                .char_indices()
                .position(|(i, _)| content[i..].to_lowercase().starts_with(term.as_str()))
                .and_then(|char_pos| {
                    content
                        .char_indices()
                        .nth(char_pos)
                        .map(|(byte_pos, _)| byte_pos)
                })
        })
        .min()
        .unwrap_or(0);

    let start = floor_char_boundary(content, best_pos.saturating_sub(50));

    let start = if start > 0 {
        content[start..].find(' ').map_or(start, |p| start + p + 1)
    } else {
        0
    };
    let start = ceil_char_boundary(content, start);

    let end = floor_char_boundary(content, start + max_len);
    let end = if end < content.len() {
        content[start..end].rfind(' ').map_or(end, |p| start + p)
    } else {
        end
    };

    let mut excerpt = content[start..end].to_string();
    if start > 0 {
        excerpt = format!("...{excerpt}");
    }
    if end < content.len() {
        excerpt = format!("{excerpt}...");
    }
    excerpt
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::Source;

    fn setup_store_with_data() -> SourceStore {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/test".to_string());
        store.add_source(&source).unwrap();

        let fid = store
            .upsert_indexed_file(&source.id, "/test/doc.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                fid,
                &[
                    crate::chunker::Chunk {
                        source_path: "/test/doc.txt".to_string(),
                        chunk_index: 0,
                        byte_offset: 0,
                        content: "Tessera is a local-first productivity workspace for creating documents and slides".to_string(),
                        hash: "ch1".to_string(),
                        extraction_method: None,
                        extraction_model_id: None,
                    },
                    crate::chunker::Chunk {
                        source_path: "/test/doc.txt".to_string(),
                        chunk_index: 1,
                        byte_offset: 80,
                        content: "It uses encrypted storage with SQLCipher and BLAKE3 hashing for content integrity".to_string(),
                        hash: "ch2".to_string(),
                        extraction_method: None,
                        extraction_model_id: None,
                    },
                ],
            )
            .unwrap();

        let fid2 = store
            .upsert_indexed_file(&source.id, "/test/notes.md", "h2", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                fid2,
                &[crate::chunker::Chunk {
                    source_path: "/test/notes.md".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "Meeting notes about the project budget and roadmap planning session"
                        .to_string(),
                    hash: "ch3".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();

        store
    }

    #[test]
    fn search_finds_matching_content() {
        let store = setup_store_with_data();
        let engine = SearchEngine::new(&store);
        let results = engine.search("productivity workspace", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].content.contains("productivity"));
    }

    #[test]
    fn search_returns_excerpts() {
        let store = setup_store_with_data();
        let engine = SearchEngine::new(&store);
        let results = engine.search("encrypted storage", 10).unwrap();
        assert!(!results.is_empty());
        assert!(!results[0].excerpt.is_empty());
    }

    #[test]
    fn search_no_results_for_unmatched_query() {
        let store = setup_store_with_data();
        let engine = SearchEngine::new(&store);
        let results = engine.search("xyznonexistent", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn search_respects_limit() {
        let store = setup_store_with_data();
        let engine = SearchEngine::new(&store);
        let results = engine.search("Tessera OR project", 1).unwrap();
        assert!(results.len() <= 1);
    }

    #[test]
    fn excerpt_highlights_query_area() {
        let text =
            "Lorem ipsum dolor sit amet. Tessera workspace is great. Consectetur adipiscing.";
        let excerpt = build_excerpt(text, "Tessera", 200);
        assert!(excerpt.contains("Tessera"));
    }

    /// Pins the `SearchResult::relevance` contract: every returned
    /// score is in `(0.0, 1.0]`, the first result is exactly
    /// `1.0`, and the i-th (1-based) result is `1.0 / i`.
    ///
    /// Before hybrid retrieval landed, this field held
    /// `-FTS5_rank` (unbounded positive BM25-derived magnitude),
    /// which the renderer multiplied by 100 to produce a
    /// percentage — resulting in displays like "230%" for
    /// strongly-matching chunks. The renderer is unchanged; only
    /// the value now produced by this struct is reciprocal-rank
    /// (`1/i`) so the percentage stays in `[0, 100]`. A future
    /// refactor that changes the score function MUST keep the
    /// `(0, 1]` invariant or update the renderer + this test in
    /// the same commit.
    #[test]
    fn search_result_relevance_is_bounded() {
        let store = setup_store_with_data();
        let engine = SearchEngine::new(&store);
        // Use an OR query that matches multiple chunks so we get a
        // ranking with at least two positions.
        // `search_broad` uses OR semantics so we get hits from
        // multiple chunks — necessary to exercise rank > 1.
        let results = engine
            .search_broad("Tessera encrypted meeting", 10)
            .unwrap();
        assert!(
            results.len() >= 2,
            "test needs at least two hits to exercise rank ordering"
        );
        for (i, hit) in results.iter().enumerate() {
            let expected = 1.0 / (i as f64 + 1.0);
            assert!(
                hit.relevance > 0.0,
                "relevance must be strictly positive (got {} at rank {})",
                hit.relevance,
                i
            );
            assert!(
                hit.relevance <= 1.0,
                "relevance must be <= 1.0 — the renderer multiplies by 100 to display a percentage (got {} at rank {})",
                hit.relevance,
                i
            );
            assert!(
                (hit.relevance - expected).abs() < 1e-9,
                "rank {} should have relevance {} (= 1/(rank+1)) but got {}",
                i,
                expected,
                hit.relevance
            );
        }
        assert!(
            (results[0].relevance - 1.0).abs() < 1e-9,
            "top hit must have relevance == 1.0; got {}",
            results[0].relevance
        );
    }

    /// Pins the empty/whitespace-only query contract.
    ///
    /// Before this guard landed, the hybrid path would:
    ///   * skip the BM25 call (good — `build_fts_query("")` returns
    ///     ""), but then
    ///   * still build a "query embedding" via `embed("")` (which
    ///     for `HashTrickEmbedding` is the all-zeros vector), and
    ///   * cosine-rank every stored embedding against that zero
    ///     vector. Cosine similarity is `0.0` for every chunk, the
    ///     all-tied set is sorted by the `chunk_id` secondary key,
    ///     and `take(limit)` returns the `limit` lowest-id chunks
    ///     with monotonically-decreasing RRF relevance.
    ///
    /// Net effect: `SourceManager::search("", 10)` would surface
    /// up to 10 arbitrary chunks instead of an empty result — a
    /// data-leak-shaped UX bug (the renderer would render the
    /// snippets as if they were "matches"). This test pins the
    /// fix at the public `SearchEngine::search` API level.
    #[test]
    fn search_empty_or_whitespace_query_returns_no_results() {
        let store = setup_store_with_data();
        let engine = SearchEngine::new(&store);

        for q in ["", " ", "\t", "  \n  ", "\u{00A0}"] {
            let results = engine.search(q, 10).unwrap();
            assert!(
                results.is_empty(),
                "expected no results for empty/whitespace-only query {q:?}, got {} hits",
                results.len()
            );
            let broad = engine.search_broad(q, 10).unwrap();
            assert!(
                broad.is_empty(),
                "expected no results for empty/whitespace-only broad query {q:?}, got {} hits",
                broad.len()
            );
        }
    }
}
