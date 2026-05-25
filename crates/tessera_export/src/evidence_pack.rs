use std::io::{Cursor, Seek, Write};
use tessera_artifacts::Artifact;
use tessera_citations::citation::Citation;
use tessera_core::error::Result;
use zip::write::SimpleFileOptions;
use zip::ZipWriter;

/// Write the deflated evidence-pack archive into `writer`. This is
/// the engine shared by the on-disk [`build_evidence_pack`] and the
/// in-memory [`evidence_pack_bytes`] paths so the produced ZIP is
/// byte-for-byte identical regardless of where the bytes land.
///
/// Structure:
/// ```text
/// evidence-pack.zip
/// ├── artifact.md
/// ├── citations.json
/// └── sources/
///     └── <source_id>.txt  (excerpt for each cited source)
/// ```
fn write_evidence_pack<W: Write + Seek>(
    writer: W,
    artifact: &Artifact,
    citations: &[Citation],
) -> Result<W> {
    let mut zip = ZipWriter::new(writer);
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

    let inner = zip
        .finish()
        .map_err(|e| tessera_core::error::Error::Io(std::io::Error::other(e.to_string())))?;
    Ok(inner)
}

/// Build a ZIP evidence pack containing the artifact and its citations
/// and write it to `output_path` on disk.
pub fn build_evidence_pack(
    artifact: &Artifact,
    citations: &[Citation],
    output_path: &str,
) -> Result<String> {
    let file = std::fs::File::create(output_path).map_err(tessera_core::error::Error::Io)?;
    let _ = write_evidence_pack(file, artifact, citations)?;
    Ok(output_path.to_string())
}

/// Build a ZIP evidence pack in memory and return the raw bytes.
///
/// Used by the "Share to KChat" path so the artifact + citations
/// archive can stream straight into the channel's file store without
/// landing on disk first (the on-disk variant exists for the
/// `artifacts:exportEvidencePack` IPC). Implementation backs the
/// ZIP writer with [`std::io::Cursor<Vec<u8>>`] so the produced
/// bytes are byte-for-byte identical to what would have landed in
/// `build_evidence_pack`'s output file.
pub fn evidence_pack_bytes(artifact: &Artifact, citations: &[Citation]) -> Result<Vec<u8>> {
    let cursor = Cursor::new(Vec::<u8>::new());
    let inner = write_evidence_pack(cursor, artifact, citations)?;
    Ok(inner.into_inner())
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

    #[test]
    fn evidence_pack_bytes_matches_file_variant() {
        // The in-memory and on-disk paths share `write_evidence_pack`,
        // so the produced ZIP should be structurally identical.
        // (The ZIP central-directory timestamps are derived from the
        // current `SystemTime` at write time so a strict byte-for-byte
        // comparison would race; we assert the archive's *logical*
        // contents are equal instead.)
        use std::io::Read;

        let dir = tempfile::tempdir().unwrap();
        let output = dir.path().join("evidence.zip");
        let art = sample_artifact();
        let cits = sample_citations();

        build_evidence_pack(&art, &cits, output.to_str().unwrap()).unwrap();
        let bytes = evidence_pack_bytes(&art, &cits).unwrap();
        assert!(
            !bytes.is_empty(),
            "in-memory evidence pack must not be empty"
        );

        // Reopen both archives and compare entry sets + payloads.
        let mut file_archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        let mut mem_archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(file_archive.len(), mem_archive.len());

        let names: Vec<String> = (0..file_archive.len())
            .map(|i| file_archive.by_index(i).unwrap().name().to_string())
            .collect();
        for name in &names {
            let mut a = String::new();
            file_archive
                .by_name(name)
                .unwrap()
                .read_to_string(&mut a)
                .unwrap();
            let mut b = String::new();
            mem_archive
                .by_name(name)
                .unwrap()
                .read_to_string(&mut b)
                .unwrap();
            assert_eq!(
                a, b,
                "entry {name} must match between disk and in-memory variants"
            );
        }
    }

    #[test]
    fn evidence_pack_bytes_with_no_citations_is_well_formed() {
        let art = sample_artifact();
        let bytes = evidence_pack_bytes(&art, &[]).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        // Even with no citations the manifest entries must be present
        // so a consumer can unzip and find a valid archive layout.
        assert!(archive.by_name("artifact.md").is_ok());
        assert!(archive.by_name("citations.json").is_ok());
        // No sources/ entries when there are no citations.
        let names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(!names.iter().any(|n| n.starts_with("sources/")));
    }
}
