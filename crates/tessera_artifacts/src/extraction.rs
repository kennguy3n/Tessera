use serde::{Deserialize, Serialize};

/// An extracted actionable item from source material.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtractedItem {
    pub item_type: ItemType,
    pub text: String,
    pub source_citation: String,
    pub confidence: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemType {
    Task,
    Decision,
}

impl std::fmt::Display for ItemType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Task => write!(f, "task"),
            Self::Decision => write!(f, "decision"),
        }
    }
}

const TASK_INDICATORS: &[&str] = &[
    "action item",
    "todo",
    "must",
    "should",
    "need to",
    "needs to",
    "will",
    "responsible for",
    "assigned to",
    "deadline",
    "by end of",
    "follow up",
    "next step",
    "to do",
    "deliverable",
    "due date",
];

const DECISION_INDICATORS: &[&str] = &[
    "decided",
    "agreed",
    "approved",
    "resolved",
    "conclusion",
    "recommendation",
    "determined",
    "we will",
    "going forward",
    "consensus",
    "decision",
    "final approach",
    "chosen",
    "selected",
];

/// Extract tasks and decisions from raw text chunks.
/// Uses keyword-proximity heuristics to identify actionable sentences.
pub fn extract_tasks_decisions(chunks: &[String], source_citation: &str) -> Vec<ExtractedItem> {
    let mut items = Vec::new();

    for chunk in chunks {
        for sentence in split_sentences(chunk) {
            let trimmed = sentence.trim();
            if trimmed.len() < 10 {
                continue;
            }

            let lower = trimmed.to_lowercase();

            let task_score = compute_indicator_score(&lower, TASK_INDICATORS);
            let decision_score = compute_indicator_score(&lower, DECISION_INDICATORS);

            if task_score > 0.0 && task_score >= decision_score {
                items.push(ExtractedItem {
                    item_type: ItemType::Task,
                    text: trimmed.to_string(),
                    source_citation: source_citation.to_string(),
                    confidence: (0.5 + task_score * 0.5).min(0.95),
                });
            } else if decision_score > 0.0 {
                items.push(ExtractedItem {
                    item_type: ItemType::Decision,
                    text: trimmed.to_string(),
                    source_citation: source_citation.to_string(),
                    confidence: (0.5 + decision_score * 0.5).min(0.95),
                });
            }
        }
    }

    items.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    items
}

/// Compute a match score [0.0, 1.0] based on how many indicator phrases appear.
fn compute_indicator_score(text: &str, indicators: &[&str]) -> f64 {
    let matches = indicators.iter().filter(|&&ind| text.contains(ind)).count();
    if matches == 0 {
        return 0.0;
    }
    // Scale: 1 match = 0.4, 2 matches = 0.7, 3+ = 0.9+
    match matches {
        1 => 0.4,
        2 => 0.7,
        _ => (0.7 + 0.1 * (matches as f64 - 2.0)).min(1.0),
    }
}

/// Split text into sentences, handling common abbreviations.
fn split_sentences(text: &str) -> Vec<&str> {
    let mut sentences = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();

    for (i, &byte) in bytes.iter().enumerate() {
        if (byte == b'.' || byte == b'!' || byte == b'?') && i + 1 < bytes.len() {
            let next = bytes[i + 1];
            if next == b' ' || next == b'\n' || next == b'\r' {
                let sentence = &text[start..=i];
                if !sentence.trim().is_empty() {
                    sentences.push(sentence.trim());
                }
                start = i + 1;
            }
        }
    }

    if start < text.len() {
        let remainder = &text[start..];
        if !remainder.trim().is_empty() {
            sentences.push(remainder.trim());
        }
    }

    sentences
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_task_from_meeting_notes() {
        let chunks = vec![
            "John must submit the budget report by end of Q3. The weather was nice.".to_string(),
        ];
        let items = extract_tasks_decisions(&chunks, "meeting-notes.md");
        assert!(!items.is_empty());
        let tasks: Vec<_> = items
            .iter()
            .filter(|i| i.item_type == ItemType::Task)
            .collect();
        assert!(!tasks.is_empty());
        assert!(tasks[0].text.to_lowercase().contains("must"));
        assert!(tasks[0].text.to_lowercase().contains("by end of"));
    }

    #[test]
    fn extracts_decision() {
        let chunks =
            vec!["After discussion, we decided to use Postgres going forward.".to_string()];
        let items = extract_tasks_decisions(&chunks, "decision-log");
        let decisions: Vec<_> = items
            .iter()
            .filter(|i| i.item_type == ItemType::Decision)
            .collect();
        assert!(!decisions.is_empty());
        assert!(decisions[0].text.to_lowercase().contains("decided"));
    }

    #[test]
    fn ignores_short_sentences() {
        let chunks = vec!["Hi. Ok. The quick brown fox.".to_string()];
        let items = extract_tasks_decisions(&chunks, "test");
        assert!(items.is_empty());
    }

    #[test]
    fn multiple_indicators_increase_confidence() {
        let chunks = vec![
            "Action item: John is responsible for delivering the deadline deliverable by next step.".to_string(),
        ];
        let items = extract_tasks_decisions(&chunks, "test");
        assert!(!items.is_empty());
        assert!(items[0].confidence > 0.7);
    }

    #[test]
    fn sorted_by_confidence_descending() {
        let chunks = vec![
            "We must fix this. After discussion, we decided and agreed and approved the plan going forward.".to_string(),
        ];
        let items = extract_tasks_decisions(&chunks, "test");
        if items.len() > 1 {
            assert!(items[0].confidence >= items[1].confidence);
        }
    }

    #[test]
    fn extracted_item_serializes_to_json() {
        let item = ExtractedItem {
            item_type: ItemType::Task,
            text: "Ship the feature by Friday".to_string(),
            source_citation: "standup.md".to_string(),
            confidence: 0.85,
        };
        let json = serde_json::to_string(&item).unwrap();
        assert!(json.contains("\"item_type\":\"task\""));
        assert!(json.contains("Ship the feature by Friday"));
        let roundtrip: ExtractedItem = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtrip.item_type, ItemType::Task);
    }

    #[test]
    fn empty_chunks_returns_no_items() {
        let items = extract_tasks_decisions(&[], "empty");
        assert!(items.is_empty());
    }

    #[test]
    fn mixed_tasks_and_decisions_in_single_chunk() {
        let chunks = vec![
            "We decided to migrate to Kubernetes. The team must complete training by March deadline.".to_string(),
        ];
        let items = extract_tasks_decisions(&chunks, "meeting");
        let types: Vec<_> = items.iter().map(|i| i.item_type).collect();
        assert!(types.contains(&ItemType::Decision));
        assert!(types.contains(&ItemType::Task));
    }
}
