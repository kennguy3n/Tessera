use std::fmt::Write;
use tessera_core::error::Result;
use tessera_core::ArtifactType;

/// A section of source context assembled for generation.
#[derive(Debug, Clone)]
pub struct SourcePack {
    pub section_title: String,
    pub prompt: String,
    pub chunks: Vec<SourceChunk>,
}

#[derive(Debug, Clone)]
pub struct SourceChunk {
    pub content: String,
    pub source_path: String,
    pub relevance: f64,
}

/// Assembled artifact content produced by a generator pipeline.
#[derive(Debug, Clone)]
pub struct GeneratedContent {
    pub title: String,
    pub artifact_type: ArtifactType,
    pub sections: Vec<GeneratedSection>,
}

#[derive(Debug, Clone)]
pub struct GeneratedSection {
    pub heading: String,
    pub body: String,
    pub citation_refs: Vec<String>,
}

impl GeneratedContent {
    pub fn to_markdown(&self) -> String {
        let mut md = format!("# {}\n\n", self.title);
        for section in &self.sections {
            let _ = write!(md, "## {}\n\n", section.heading);
            md.push_str(&section.body);
            md.push('\n');
            if !section.citation_refs.is_empty() {
                md.push_str("\n**Sources:** ");
                md.push_str(&section.citation_refs.join(", "));
                md.push_str("\n\n");
            }
        }
        md
    }
}

/// Build structured draft content from source packs without an LLM.
/// Each section gets the top-K chunks as a structured outline with citations.
pub fn generate_draft_from_sources(
    title: &str,
    artifact_type: ArtifactType,
    source_packs: &[SourcePack],
) -> Result<GeneratedContent> {
    let mut sections = Vec::new();

    for pack in source_packs {
        let mut body = String::new();
        let mut refs = Vec::new();

        if pack.chunks.is_empty() {
            body.push_str("*No source material found for this section.*\n");
        } else {
            for (i, chunk) in pack.chunks.iter().enumerate() {
                let excerpt = truncate_to_sentences(&chunk.content, 500);
                let _ = write!(body, "**[{}]** {excerpt}\n\n", i + 1);
                refs.push(format!("[{}] {}", i + 1, chunk.source_path));
            }
        }

        sections.push(GeneratedSection {
            heading: pack.section_title.clone(),
            body,
            citation_refs: refs,
        });
    }

    Ok(GeneratedContent {
        title: title.to_string(),
        artifact_type,
        sections,
    })
}

/// Truncate text to approximately `max_chars` at a sentence boundary.
fn truncate_to_sentences(text: &str, max_chars: usize) -> String {
    if text.len() <= max_chars {
        return text.to_string();
    }
    let mut end = max_chars;
    for (i, c) in text.char_indices() {
        if i > max_chars {
            break;
        }
        if c == '.' || c == '!' || c == '?' {
            end = i + 1;
        }
    }
    let truncated = &text[..end];
    truncated.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_draft_with_sources() {
        let packs = vec![
            SourcePack {
                section_title: "Problem Statement".to_string(),
                prompt: "Summarize the problem".to_string(),
                chunks: vec![
                    SourceChunk {
                        content: "The main challenge is scaling the database to handle 10x load."
                            .to_string(),
                        source_path: "docs/scaling-report.pdf".to_string(),
                        relevance: 0.95,
                    },
                    SourceChunk {
                        content: "Current latency exceeds SLA thresholds during peak hours."
                            .to_string(),
                        source_path: "docs/monitoring.md".to_string(),
                        relevance: 0.88,
                    },
                ],
            },
            SourcePack {
                section_title: "Proposed Solution".to_string(),
                prompt: "Describe the solution".to_string(),
                chunks: vec![],
            },
        ];

        let result =
            generate_draft_from_sources("Scale-Up PRD", ArtifactType::Document, &packs).unwrap();

        assert_eq!(result.title, "Scale-Up PRD");
        assert_eq!(result.sections.len(), 2);
        assert!(result.sections[0].body.contains("scaling the database"));
        assert!(result.sections[0].citation_refs.len() == 2);
        assert!(result.sections[1].body.contains("No source material"));
    }

    #[test]
    fn to_markdown_renders_headings_and_citations() {
        let content = GeneratedContent {
            title: "Test Doc".to_string(),
            artifact_type: ArtifactType::Document,
            sections: vec![GeneratedSection {
                heading: "Overview".to_string(),
                body: "Some content here.\n".to_string(),
                citation_refs: vec!["[1] report.pdf".to_string()],
            }],
        };
        let md = content.to_markdown();
        assert!(md.contains("# Test Doc"));
        assert!(md.contains("## Overview"));
        assert!(md.contains("**Sources:**"));
    }

    #[test]
    fn truncate_respects_sentence_boundary() {
        let text = "First sentence. Second sentence. Third sentence which is longer than needed.";
        let truncated = truncate_to_sentences(text, 35);
        assert!(truncated.ends_with('.'));
        assert!(truncated.len() <= 40);
    }

    #[test]
    fn generate_draft_all_empty_sections() {
        let packs = vec![
            SourcePack {
                section_title: "Scope".to_string(),
                prompt: "Define scope".to_string(),
                chunks: vec![],
            },
            SourcePack {
                section_title: "Timeline".to_string(),
                prompt: "Timeline".to_string(),
                chunks: vec![],
            },
        ];
        let result =
            generate_draft_from_sources("Empty PRD", ArtifactType::Document, &packs).unwrap();
        assert_eq!(result.sections.len(), 2);
        for section in &result.sections {
            assert!(section.body.contains("No source material"));
            assert!(section.citation_refs.is_empty());
        }
    }

    #[test]
    fn generate_draft_preserves_artifact_type() {
        let packs = vec![SourcePack {
            section_title: "Slide 1".to_string(),
            prompt: "QBR summary".to_string(),
            chunks: vec![SourceChunk {
                content: "Revenue grew 15% quarter over quarter.".to_string(),
                source_path: "finance/q3.csv".to_string(),
                relevance: 0.91,
            }],
        }];
        let result = generate_draft_from_sources("Q3 QBR", ArtifactType::Slides, &packs).unwrap();
        assert!(matches!(result.artifact_type, ArtifactType::Slides));
        assert!(result.sections[0].body.contains("Revenue grew"));
    }

    #[test]
    fn truncate_short_text_returns_unchanged() {
        let text = "Short.";
        let truncated = truncate_to_sentences(text, 100);
        assert_eq!(truncated, "Short.");
    }
}
