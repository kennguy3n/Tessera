use std::cmp::Reverse;
use std::collections::{HashMap, HashSet};
use std::fmt::Write;

/// Result of comparing two sources' content.
#[derive(Debug, Clone)]
pub struct ComparisonResult {
    pub common_themes: Vec<Theme>,
    pub unique_to_a: Vec<Theme>,
    pub unique_to_b: Vec<Theme>,
    pub similarity_score: f64,
}

#[derive(Debug, Clone)]
pub struct Theme {
    pub label: String,
    pub frequency: usize,
}

/// Compare two sets of text chunks and produce a structured comparison.
pub fn compare_sources(chunks_a: &[String], chunks_b: &[String]) -> ComparisonResult {
    let ngrams_a = extract_key_phrases(chunks_a);
    let ngrams_b = extract_key_phrases(chunks_b);

    let keys_a: HashSet<&str> = ngrams_a.keys().map(String::as_str).collect();
    let keys_b: HashSet<&str> = ngrams_b.keys().map(String::as_str).collect();

    let common_keys: Vec<&&str> = keys_a.intersection(&keys_b).collect();
    let only_a_keys: Vec<&&str> = keys_a.difference(&keys_b).collect();
    let only_b_keys: Vec<&&str> = keys_b.difference(&keys_a).collect();

    let mut common_themes: Vec<Theme> = common_keys
        .iter()
        .map(|&&k| Theme {
            label: k.to_string(),
            frequency: ngrams_a.get(k).unwrap_or(&0) + ngrams_b.get(k).unwrap_or(&0),
        })
        .collect();
    common_themes.sort_by_key(|t| Reverse(t.frequency));
    common_themes.truncate(30);

    let mut unique_a: Vec<Theme> = only_a_keys
        .iter()
        .map(|&&k| Theme {
            label: k.to_string(),
            frequency: *ngrams_a.get(k).unwrap_or(&0),
        })
        .collect();
    unique_a.sort_by_key(|t| Reverse(t.frequency));
    unique_a.truncate(20);

    let mut unique_b: Vec<Theme> = only_b_keys
        .iter()
        .map(|&&k| Theme {
            label: k.to_string(),
            frequency: *ngrams_b.get(k).unwrap_or(&0),
        })
        .collect();
    unique_b.sort_by_key(|t| Reverse(t.frequency));
    unique_b.truncate(20);

    let total = keys_a.len() + keys_b.len();
    let similarity = if total == 0 {
        0.0
    } else {
        (2.0 * common_keys.len() as f64) / total as f64
    };

    ComparisonResult {
        common_themes,
        unique_to_a: unique_a,
        unique_to_b: unique_b,
        similarity_score: similarity,
    }
}

impl ComparisonResult {
    pub fn to_markdown(&self, label_a: &str, label_b: &str) -> String {
        let mut md = String::from("# Source Comparison\n\n");
        let _ = write!(
            md,
            "**Similarity Score:** {:.0}%\n\n",
            self.similarity_score * 100.0
        );

        md.push_str("## Common Themes\n\n");
        if self.common_themes.is_empty() {
            md.push_str("*No common themes found.*\n\n");
        } else {
            for theme in &self.common_themes {
                let _ = writeln!(
                    md,
                    "- **{}** (mentioned {} times)",
                    theme.label, theme.frequency
                );
            }
            md.push('\n');
        }

        let _ = write!(md, "## Unique to {label_a}\n\n");
        if self.unique_to_a.is_empty() {
            md.push_str("*No unique themes found.*\n\n");
        } else {
            for theme in &self.unique_to_a {
                let _ = writeln!(md, "- {} ({})", theme.label, theme.frequency);
            }
            md.push('\n');
        }

        let _ = write!(md, "## Unique to {label_b}\n\n");
        if self.unique_to_b.is_empty() {
            md.push_str("*No unique themes found.*\n\n");
        } else {
            for theme in &self.unique_to_b {
                let _ = writeln!(md, "- {} ({})", theme.label, theme.frequency);
            }
            md.push('\n');
        }

        md
    }
}

/// Extract meaningful n-grams (bigrams/trigrams) from chunks, filtering stop words.
fn extract_key_phrases(chunks: &[String]) -> HashMap<String, usize> {
    let stop_words: HashSet<&str> = [
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
        "do", "does", "did", "will", "would", "could", "should", "may", "might", "shall", "can",
        "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through",
        "during", "before", "after", "above", "below", "between", "out", "off", "over", "under",
        "again", "further", "then", "once", "and", "but", "or", "nor", "not", "so", "very", "just",
        "about", "up", "it", "its", "this", "that", "these", "those", "i", "we", "you", "he",
        "she", "they", "me", "him", "her", "us", "them", "my", "our", "your", "his", "their",
        "all", "each", "every", "both", "few", "more", "most", "other", "some", "such", "no",
        "only", "own", "same", "than", "too", "also",
    ]
    .into_iter()
    .collect();

    let mut phrases: HashMap<String, usize> = HashMap::new();

    for chunk in chunks {
        let words: Vec<&str> = chunk
            .split(|c: char| !c.is_alphanumeric() && c != '-')
            .filter(|w| !w.is_empty())
            .map(str::trim)
            .collect();

        let cleaned: Vec<String> = words
            .iter()
            .map(|w| w.to_lowercase())
            .filter(|w| w.len() > 2 && !stop_words.contains(w.as_str()))
            .collect();

        // Bigrams
        for window in cleaned.windows(2) {
            let bigram = format!("{} {}", window[0], window[1]);
            *phrases.entry(bigram).or_insert(0) += 1;
        }

        // Single significant words (4+ chars)
        for word in &cleaned {
            if word.len() >= 4 {
                *phrases.entry(word.clone()).or_insert(0) += 1;
            }
        }
    }

    // Filter to phrases that appear at least twice or are bigrams
    phrases.retain(|k, v| *v >= 2 || k.contains(' '));
    phrases
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_identical_sources() {
        let chunks = vec!["The database scaling plan requires more servers.".to_string()];
        let result = compare_sources(&chunks, &chunks);
        assert!(result.similarity_score > 0.9);
        assert!(result.unique_to_a.is_empty());
        assert!(result.unique_to_b.is_empty());
    }

    #[test]
    fn compare_distinct_sources() {
        let a = vec!["Machine learning models need GPU training infrastructure.".to_string()];
        let b = vec!["The finance team approved the quarterly budget forecast.".to_string()];
        let result = compare_sources(&a, &b);
        assert!(result.similarity_score < 0.5);
    }

    #[test]
    fn compare_overlapping_sources() {
        let a = vec![
            "The project requires database scaling. The team needs more servers for the database."
                .to_string(),
        ];
        let b = vec![
            "Database performance is critical. We need database optimization and more servers."
                .to_string(),
        ];
        let result = compare_sources(&a, &b);
        assert!(!result.common_themes.is_empty());
        let common_labels: Vec<&str> = result
            .common_themes
            .iter()
            .map(|t| t.label.as_str())
            .collect();
        let has_database = common_labels.iter().any(|l| l.contains("database"));
        assert!(
            has_database,
            "Expected 'database' in common themes: {:?}",
            common_labels
        );
    }

    #[test]
    fn markdown_output_has_sections() {
        let result = ComparisonResult {
            common_themes: vec![Theme {
                label: "testing".to_string(),
                frequency: 5,
            }],
            unique_to_a: vec![Theme {
                label: "rust".to_string(),
                frequency: 3,
            }],
            unique_to_b: vec![],
            similarity_score: 0.45,
        };
        let md = result.to_markdown("Source A", "Source B");
        assert!(md.contains("# Source Comparison"));
        assert!(md.contains("45%"));
        assert!(md.contains("testing"));
        assert!(md.contains("Unique to Source A"));
        assert!(md.contains("Unique to Source B"));
    }

    #[test]
    fn compare_empty_sources() {
        let result = compare_sources(&[], &[]);
        assert!(result.similarity_score.abs() < f64::EPSILON);
        assert!(result.common_themes.is_empty());
        assert!(result.unique_to_a.is_empty());
        assert!(result.unique_to_b.is_empty());
    }

    #[test]
    fn similarity_score_within_valid_range() {
        let a = vec!["Some content about testing. More about testing tools.".to_string()];
        let b =
            vec!["Different content about deployment. More about deployment tools.".to_string()];
        let result = compare_sources(&a, &b);
        assert!(result.similarity_score >= 0.0);
        assert!(result.similarity_score <= 1.0);
    }

    #[test]
    fn markdown_with_no_common_themes_shows_placeholder() {
        let result = ComparisonResult {
            common_themes: vec![],
            unique_to_a: vec![],
            unique_to_b: vec![],
            similarity_score: 0.0,
        };
        let md = result.to_markdown("A", "B");
        assert!(md.contains("No common themes found"));
    }
}
