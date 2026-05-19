use std::io::Write;
use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::error::Result;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Build a ZIP evidence pack containing the artifact and its citations.
///
/// Structure:
/// ```text
/// evidence-pack.zip
/// ├── artifact.md
/// ├── citations.json
/// └── sources/
///     └── <source_id>.txt  (excerpt for each cited source)
/// ```
pub fn build_evidence_pack(
    artifact: &Artifact,
    citations: &[Citation],
    output_path: &str,
) -> Result<String> {
    let file = std::fs::File::create(output_path).map_err(tessera_core::error::Error::Io)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    // artifact.md
    zip.start_file("artifact.md", options)
        .map_err(|e| tessera_core::error::Error::Io(std::io::Error::other(e.to_string())))?;
    let artifact_md = format!(
        "# {}\n\nType: {}\nCreated: {}\nVersion: {}\n\n---\n\n{}",
        artifact.title,
        artifact.artifact_type,
        artifact.created_at.format("%Y-%m-%d %H:%M"),
        artifact.version,
        artifact.content
    );
    zip.write_all(artifact_md.as_bytes())
        .map_err(tessera_core::error::Error::Io)?;

    // citations.json
    zip.start_file("citations.json", options)
        .map_err(|e| tessera_core::error::Error::Io(std::io::Error::other(e.to_string())))?;
    let citations_json =
        serde_json::to_string_pretty(citations).unwrap_or_else(|_| "[]".to_string());
    zip.write_all(citations_json.as_bytes())
        .map_err(tessera_core::error::Error::Io)?;

    // Per-source excerpts
    let mut seen_sources = std::collections::HashSet::new();
    for citation in citations {
        let sid = citation.source_id.to_string();
        if seen_sources.insert(sid.clone()) {
            let filename = format!("sources/{}.txt", sid);
            zip.start_file(&filename, options).map_err(|e| {
                tessera_core::error::Error::Io(std::io::Error::other(e.to_string()))
            })?;
            let excerpt = format!(
                "Source: {}\nURI: {}\nType: {}\nUsed for: {}\nConfidence: {:.2}\n",
                citation.source_title,
                citation.source_uri,
                citation.source_type,
                citation.used_for,
                citation.confidence,
            );
            zip.write_all(excerpt.as_bytes())
                .map_err(tessera_core::error::Error::Io)?;
        }
    }

    zip.finish()
        .map_err(|e| tessera_core::error::Error::Io(std::io::Error::other(e.to_string())))?;

    Ok(output_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_citations::citation::Citation;
    use tessera_core::{ArtifactType, SourceId, SourceType};

    fn sample_artifact() -> Artifact {
        let mut art = Artifact::new("Test Report".to_string(), ArtifactType::Document, None);
        art.update_content("This is the report content.\n\nSection two.".to_string());
        art
    }

    fn sample_citations() -> Vec<Citation> {
        vec![Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "data-report.pdf".to_string(),
            "file:///docs/data-report.pdf".to_string(),
            blake3::hash(b"chunk1").to_hex().to_string(),
            blake3::hash(b"file1").to_hex().to_string(),
            "Problem Statement".to_string(),
            0.92,
        )]
    }

    #[test]
    fn evidence_pack_creates_valid_zip() {
        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("evidence.zip");
        let art = sample_artifact();
        let cits = sample_citations();

        let result = build_evidence_pack(&art, &cits, output.to_str().unwrap());
        assert!(result.is_ok());

        // Verify ZIP contents
        let file = std::fs::File::open(&output).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();

        assert!(names.contains(&"artifact.md".to_string()));
        assert!(names.contains(&"citations.json".to_string()));
        assert!(names.iter().any(|n| n.starts_with("sources/")));

        // Verify artifact content
        use std::io::Read;
        let mut artifact_md = String::new();
        archive
            .by_name("artifact.md")
            .unwrap()
            .read_to_string(&mut artifact_md)
            .unwrap();
        assert!(artifact_md.contains("Test Report"));
        assert!(artifact_md.contains("This is the report content"));

        // Verify citations JSON
        let mut cit_json = String::new();
        archive
            .by_name("citations.json")
            .unwrap()
            .read_to_string(&mut cit_json)
            .unwrap();
        assert!(cit_json.contains("data-report.pdf"));
    }
}
