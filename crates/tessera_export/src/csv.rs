//! CSV export of an artifact and its citations.

use std::fmt::Write;
use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;

/// Export csv.
pub fn export_csv(artifact: &Artifact, citations: &[Citation]) -> String {
    let mut output = String::new();

    output.push_str("title,type,version,created_at,updated_at\n");
    let _ = writeln!(
        output,
        "\"{}\",\"{}\",{},\"{}\",\"{}\"",
        escape_csv(&artifact.title),
        artifact.artifact_type,
        artifact.version,
        artifact.created_at.to_rfc3339(),
        artifact.updated_at.to_rfc3339(),
    );

    if !citations.is_empty() {
        output.push('\n');
        output.push_str("citation_id,source_title,source_uri,used_for,confidence,page\n");
        for citation in citations {
            let _ = writeln!(
                output,
                "\"{}\",\"{}\",\"{}\",\"{}\",{:.2},{}",
                citation.citation_id,
                escape_csv(&citation.source_title),
                escape_csv(&citation.source_uri),
                escape_csv(&citation.used_for),
                citation.confidence,
                citation.page.map(|p| p.to_string()).unwrap_or_default(),
            );
        }
    }

    output
}

fn escape_csv(text: &str) -> String {
    text.replace('"', "\"\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_artifacts::Artifact;
    use tessera_citations::citation::Citation;
    use tessera_core::{ArtifactType, SourceId, SourceType};

    #[test]
    fn export_basic_csv() {
        let artifact = Artifact::new("Budget Q4".to_string(), ArtifactType::Sheet, None);
        let csv = export_csv(&artifact, &[]);
        assert!(csv.contains("title,type,version"));
        assert!(csv.contains("Budget Q4"));
    }

    #[test]
    fn export_csv_with_citations() {
        let artifact = Artifact::new("Report".to_string(), ArtifactType::Document, None);
        let citations = vec![Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "data.csv".to_string(),
            "file:///data.csv".to_string(),
            "hash1".to_string(),
            "file_hash1".to_string(),
            "Data Source".to_string(),
            0.95,
        )];

        let csv = export_csv(&artifact, &citations);
        assert!(csv.contains("citation_id,source_title"));
        assert!(csv.contains("data.csv"));
        assert!(csv.contains("0.95"));
    }

    #[test]
    fn csv_escapes_quotes() {
        let mut artifact =
            Artifact::new("Test \"quoted\"".to_string(), ArtifactType::Document, None);
        artifact.update_content("content".to_string());

        let csv = export_csv(&artifact, &[]);
        assert!(csv.contains("Test \"\"quoted\"\""));
    }
}
