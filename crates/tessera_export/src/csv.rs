//! CSV export of an artifact and its citations.

use std::fmt::Write;
use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;

/// Renders `artifact` (plus its `citations`) as CSV text: a metadata
/// header row followed by the artifact's tabular content. Returns the
/// CSV as a `String` rather than writing to disk so the caller chooses
/// the destination.
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

/// Escapes a free-text field for safe inclusion in a quoted CSV cell.
///
/// Two concerns are handled:
///
/// 1. **RFC 4180 quoting** — embedded `"` are doubled. Every caller
///    wraps the result in `"..."`, so commas and newlines need no
///    further handling.
/// 2. **Formula (CSV) injection** — spreadsheet apps (Excel,
///    LibreOffice, Google Sheets) evaluate any cell whose value begins
///    with `=`, `+`, `-`, `@`, or a leading tab/CR as a formula. An
///    attacker-influenced field such as a source title of
///    `=HYPERLINK("http://evil","click")` or `=cmd|'/c calc'!A1` would
///    then execute or exfiltrate data when an exported sheet is opened.
///    Citation/source metadata originates from external connectors
///    (Notion/Drive/Jira/KChat) and model output, so such cells are
///    defanged by prefixing a single quote — the spreadsheet
///    "treat as text" marker, the OWASP-recommended mitigation.
fn escape_csv(text: &str) -> String {
    let doubled = text.replace('"', "\"\"");
    if text
        .chars()
        .next()
        .is_some_and(|c| matches!(c, '=' | '+' | '-' | '@' | '\t' | '\r'))
    {
        format!("'{doubled}")
    } else {
        doubled
    }
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

    #[test]
    fn csv_defangs_formula_injection() {
        // Title and citation fields beginning with a formula trigger
        // (`=`, `+`, `-`, `@`) are prefixed with `'` so a spreadsheet
        // app treats them as text instead of evaluating them.
        let artifact = Artifact::new("=cmd|'/c calc'!A1".to_string(), ArtifactType::Sheet, None);
        let citations = vec![Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "=HYPERLINK(\"http://evil\",\"x\")".to_string(),
            "@SUM(A1:A9)".to_string(),
            "h".to_string(),
            "fh".to_string(),
            "-1+1".to_string(),
            0.5,
        )];

        let csv = export_csv(&artifact, &citations);

        // Artifact title cell defanged.
        assert!(csv.contains("\"'=cmd|'/c calc'!A1\""));
        // Citation source_title (with its embedded quotes still doubled),
        // source_uri, and used_for cells all defanged.
        assert!(csv.contains("\"'=HYPERLINK(\"\"http://evil\"\",\"\"x\"\")\""));
        assert!(csv.contains("\"'@SUM(A1:A9)\""));
        assert!(csv.contains("\"'-1+1\""));
    }

    #[test]
    fn csv_leaves_benign_leading_chars_untouched() {
        // A title that merely contains — but does not start with — a
        // trigger char is not altered.
        let artifact = Artifact::new("Q4 = great".to_string(), ArtifactType::Sheet, None);
        let csv = export_csv(&artifact, &[]);
        assert!(csv.contains("\"Q4 = great\""));
        assert!(!csv.contains("'Q4"));
    }
}
