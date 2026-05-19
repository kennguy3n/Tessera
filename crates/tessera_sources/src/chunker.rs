use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chunk {
    pub source_path: String,
    pub chunk_index: usize,
    pub byte_offset: usize,
    pub content: String,
    pub hash: String,
}

#[derive(Debug, Clone)]
pub struct ChunkerConfig {
    pub chunk_size: usize,
    pub chunk_overlap: usize,
}

impl Default for ChunkerConfig {
    fn default() -> Self {
        Self {
            chunk_size: 1024,
            chunk_overlap: 128,
        }
    }
}

pub fn chunk_text(source_path: &str, text: &str, config: &ChunkerConfig) -> Vec<Chunk> {
    if text.is_empty() {
        return Vec::new();
    }

    if text.len() <= config.chunk_size {
        let hash = blake3::hash(text.as_bytes()).to_hex().to_string();
        return vec![Chunk {
            source_path: source_path.to_string(),
            chunk_index: 0,
            byte_offset: 0,
            content: text.to_string(),
            hash,
        }];
    }

    let mut chunks = Vec::new();
    let bytes = text.as_bytes();
    let mut offset = 0;
    let mut index = 0;

    while offset < bytes.len() {
        let end = (offset + config.chunk_size).min(bytes.len());

        let actual_end = if end < bytes.len() {
            find_break_point(text, offset, end)
        } else {
            end
        };

        let chunk_text = &text[offset..actual_end];
        if !chunk_text.trim().is_empty() {
            let hash = blake3::hash(chunk_text.as_bytes()).to_hex().to_string();
            chunks.push(Chunk {
                source_path: source_path.to_string(),
                chunk_index: index,
                byte_offset: offset,
                content: chunk_text.to_string(),
                hash,
            });
            index += 1;
        }

        let step = if actual_end - offset > config.chunk_overlap {
            actual_end - offset - config.chunk_overlap
        } else {
            actual_end - offset
        };
        offset += step;

        if offset >= bytes.len() {
            break;
        }
    }

    chunks
}

fn find_break_point(text: &str, start: usize, target: usize) -> usize {
    let search_start = if target > 100 { target - 100 } else { start };

    if let Some(pos) = text[search_start..target].rfind("\n\n") {
        return search_start + pos + 2;
    }
    if let Some(pos) = text[search_start..target].rfind('\n') {
        return search_start + pos + 1;
    }
    if let Some(pos) = text[search_start..target].rfind(". ") {
        return search_start + pos + 2;
    }
    if let Some(pos) = text[search_start..target].rfind(' ') {
        return search_start + pos + 1;
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_produces_no_chunks() {
        let chunks = chunk_text("test.txt", "", &ChunkerConfig::default());
        assert!(chunks.is_empty());
    }

    #[test]
    fn short_text_produces_single_chunk() {
        let text = "Hello, world!";
        let chunks = chunk_text("test.txt", text, &ChunkerConfig::default());
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, text);
        assert_eq!(chunks[0].chunk_index, 0);
        assert_eq!(chunks[0].byte_offset, 0);
        assert!(!chunks[0].hash.is_empty());
    }

    #[test]
    fn long_text_produces_multiple_chunks() {
        let text = "word ".repeat(500);
        let config = ChunkerConfig {
            chunk_size: 100,
            chunk_overlap: 20,
        };
        let chunks = chunk_text("test.txt", &text, &config);
        assert!(chunks.len() > 1);

        for (i, chunk) in chunks.iter().enumerate() {
            assert_eq!(chunk.chunk_index, i);
            assert!(!chunk.content.is_empty());
        }
    }

    #[test]
    fn chunks_have_correct_provenance() {
        let text = "line one\nline two\nline three\nline four\nline five";
        let config = ChunkerConfig {
            chunk_size: 20,
            chunk_overlap: 5,
        };
        let chunks = chunk_text("doc.md", text, &config);
        for chunk in &chunks {
            assert_eq!(chunk.source_path, "doc.md");
        }
    }

    #[test]
    fn chunk_hashes_are_deterministic() {
        let text = "Hello, world! This is a test.";
        let c1 = chunk_text("test.txt", text, &ChunkerConfig::default());
        let c2 = chunk_text("test.txt", text, &ChunkerConfig::default());
        assert_eq!(c1[0].hash, c2[0].hash);
    }

    #[test]
    fn identical_content_produces_same_hash() {
        let text = "Identical content.";
        let c1 = chunk_text("a.txt", text, &ChunkerConfig::default());
        let c2 = chunk_text("b.txt", text, &ChunkerConfig::default());
        assert_eq!(c1[0].hash, c2[0].hash);
    }

    #[test]
    fn break_prefers_paragraph_boundaries() {
        let text = format!(
            "{}.\n\n{}.",
            "First paragraph with enough words to fill a chunk".repeat(3),
            "Second paragraph after the break"
        );
        let config = ChunkerConfig {
            chunk_size: 150,
            chunk_overlap: 20,
        };
        let chunks = chunk_text("test.txt", &text, &config);
        assert!(chunks.len() >= 2);
    }
}
