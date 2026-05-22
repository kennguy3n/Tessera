use tessera_core::error::Result;

use crate::embedding::EmbeddingProvider;
use crate::hybrid::{hybrid_search, HybridSearchConfig};
use crate::store::SourceStore;

pub struct SearchEngine<'a> {
    store: &'a SourceStore,
    provider: Option<&'a dyn EmbeddingProvider>,
    config: HybridSearchConfig,
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub content: String,
    pub excerpt: String,
    pub source_path: String,
    pub source_id: String,
    pub chunk_index: usize,
    pub relevance: f64,
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
        }
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchResult>> {
        self.search_with_mode(query, limit, false)
    }

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

        let ranked_ids = hybrid_search(
            self.store,
            self.provider,
            query,
            &fts_query,
            limit,
            &self.config,
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

fn build_fts_query(query: &str, use_or: bool) -> String {
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

fn build_excerpt(content: &str, query: &str, max_len: usize) -> String {
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
                    },
                    crate::chunker::Chunk {
                        source_path: "/test/doc.txt".to_string(),
                        chunk_index: 1,
                        byte_offset: 80,
                        content: "It uses encrypted storage with SQLCipher and BLAKE3 hashing for content integrity".to_string(),
                        hash: "ch2".to_string(),
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
}
