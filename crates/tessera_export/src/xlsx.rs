//! XLSX export — converts Tessera Sheet artifacts (JSON cells/rows model)
//! into a `.xlsx` workbook using `rust_xlsxwriter`.
//!
//! The Sheet artifact's `content` field is JSON produced by `SheetEditor.tsx`
//! and matches the TypeScript `SheetContent` interface — i.e. `{ columns:
//! string[], rows: string[][] }`. We accept the legacy `headers` field name
//! via `#[serde(alias = "headers")]` so any persisted artifacts produced by
//! older builds (or hand-authored test fixtures) still round-trip cleanly.
//! If the content is not parseable JSON, we fall back to treating each line
//! as a row and splitting on commas — the CSV exporter does the same
//! conversion, so the two formats agree on shape.
//!
//! Formulas: cells whose string value starts with `=` are written via
//! `write_formula` so Excel will evaluate them on open. Everything else is
//! written as a string, with numeric strings auto-converted to numbers.

use rust_xlsxwriter::{Format, Workbook};
use serde::Deserialize;
use tessera_artifacts::Artifact;

#[derive(Debug, Default, Deserialize)]
struct SheetContent {
    // `columns` matches the field name produced by `SheetEditor.tsx` (the
    // sole producer of Sheet artifact JSON in production). `alias =
    // "headers"` keeps backward compatibility with any older Tessera build
    // that may have written `headers` instead
    // caught this mismatch silently dropping all column names from XLSX exports.
    #[serde(default, alias = "headers")]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<String>>,
}

/// Parse the Sheet artifact's content into a `SheetContent`. Returns
/// `None` if the content is empty or not parseable.
fn parse_sheet(content: &str) -> Option<SheetContent> {
    if content.trim().is_empty() {
        return None;
    }
    // Preferred form: JSON with columns + rows.
    if let Ok(sheet) = serde_json::from_str::<SheetContent>(content) {
        return Some(sheet);
    }
    // Fallback: CSV-ish lines.
    let mut lines = content.lines();
    let header_line = lines.next()?;
    let columns = header_line
        .split(',')
        .map(|s| s.trim().to_string())
        .collect();
    let rows = lines
        .map(|line| line.split(',').map(|s| s.trim().to_string()).collect())
        .collect();
    Some(SheetContent { columns, rows })
}

/// Export a Tessera Sheet artifact to XLSX bytes.
pub fn export_xlsx(artifact: &Artifact) -> Vec<u8> {
    let mut workbook = Workbook::new();
    let sheet_name = sanitize_sheet_name(&artifact.title);
    let worksheet = workbook
        .add_worksheet()
        .set_name(&sheet_name)
        .expect("worksheet name should be valid after sanitization");

    let header_fmt = Format::new().set_bold().set_background_color("#EFE7FD");

    if let Some(sheet) = parse_sheet(&artifact.content) {
        for (col, header) in sheet.columns.iter().enumerate() {
            worksheet
                .write_string_with_format(0, col as u16, header, &header_fmt)
                .expect("write header");
        }
        for (r, row) in sheet.rows.iter().enumerate() {
            let row_idx = (r + 1) as u32;
            for (c, cell) in row.iter().enumerate() {
                let col_idx = c as u16;
                write_cell(worksheet, row_idx, col_idx, cell);
            }
        }
    } else {
        // Empty sheet: still emit a header row with the artifact title so
        // the file opens without a warning.
        worksheet
            .write_string_with_format(0, 0, &artifact.title, &header_fmt)
            .expect("write title");
    }

    workbook.save_to_buffer().expect("save XLSX to buffer")
}

fn write_cell(worksheet: &mut rust_xlsxwriter::Worksheet, row: u32, col: u16, value: &str) {
    // CSV/XLSX-injection escape: `'=foo` is the standard convention for
    // "please don't interpret the leading `=` as a formula trigger". We strip
    // the apostrophe and emit the remainder verbatim as text. This mirrors
    // Excel's own paste behavior and protects against artifact content that
    // happens to start with `=` but is meant as prose (e.g. `=NOTE: ...`).
    if let Some(literal) = value.strip_prefix("'=") {
        let mut as_text = String::with_capacity(literal.len() + 1);
        as_text.push('=');
        as_text.push_str(literal);
        worksheet
            .write_string(row, col, &as_text)
            .expect("write string");
        return;
    }
    if let Some(formula) = value.strip_prefix('=') {
        // Strip the leading '=' since rust_xlsxwriter's write_formula adds
        // it automatically.
        worksheet
            .write_formula(row, col, formula)
            .expect("write formula");
        return;
    }
    if let Ok(n) = value.parse::<f64>() {
        worksheet.write_number(row, col, n).expect("write number");
        return;
    }
    worksheet
        .write_string(row, col, value)
        .expect("write string");
}

/// Excel sheet names must be ≤ 31 chars and cannot contain `: \\ / ? * [ ]`.
fn sanitize_sheet_name(title: &str) -> String {
    let mut s = String::with_capacity(title.len());
    for ch in title.chars() {
        if matches!(ch, ':' | '\\' | '/' | '?' | '*' | '[' | ']') {
            s.push('_');
        } else {
            s.push(ch);
        }
    }
    if s.is_empty() {
        s.push_str("Sheet1");
    }
    if s.chars().count() > 31 {
        s = s.chars().take(31).collect();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_artifacts::Artifact;
    use tessera_core::ArtifactType;

    fn assert_is_zip(bytes: &[u8]) {
        assert!(bytes.len() > 4);
        assert_eq!(&bytes[..4], b"PK\x03\x04", "XLSX missing PK ZIP signature");
    }

    /// Concatenate the text content of every XML entry in the XLSX zip. Used
    /// to assert that arbitrary user strings (column headers, cell values) made
    /// it into the workbook, which is otherwise opaque since the bytes are
    /// deflate-compressed inside a zip container.
    fn read_xlsx_text(bytes: &[u8]) -> String {
        use std::io::Read;
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).expect("XLSX should be a valid zip");
        let mut combined = String::new();
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).expect("entry");
            let is_xml = std::path::Path::new(entry.name())
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("xml"));
            if is_xml {
                let mut buf = String::new();
                entry.read_to_string(&mut buf).expect("read entry");
                combined.push_str(&buf);
                combined.push('\n');
            }
        }
        combined
    }

    #[test]
    fn export_basic_xlsx_returns_zip_bytes() {
        // Production format: matches what SheetEditor.tsx serializes.
        let mut artifact = Artifact::new("Sales".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(
            r#"{"columns":["Region","Q1","Q2"],"rows":[["North","100","120"],["South","80","95"]]}"#
                .to_string(),
        );
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        // Column headers must actually appear inside the workbook XML —
        // guards against the regression where the field-name mismatch
        // silently dropped all column names. We unzip and read the XML
        // entries because the headers end up in `xl/sharedStrings.xml` which
        // is deflate-compressed inside the zip.
        let xml = read_xlsx_text(&bytes);
        assert!(xml.contains("Region"), "missing Region header in {xml}");
        assert!(xml.contains("Q1"), "missing Q1 header in {xml}");
        assert!(xml.contains("Q2"), "missing Q2 header in {xml}");
    }

    #[test]
    fn export_xlsx_accepts_legacy_headers_field_name() {
        // Backward compat: artifacts that were persisted under the old `headers`
        // name still deserialize correctly via the serde alias. This guards
        // against a regression where renaming the field to match production
        // (`columns`) would have broken any in-flight test fixtures or older
        // builds.
        let mut artifact = Artifact::new("Legacy".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(r#"{"headers":["OldCol"],"rows":[["v"]]}"#.to_string());
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        let xml = read_xlsx_text(&bytes);
        assert!(xml.contains("OldCol"), "legacy `headers` field was dropped");
    }

    #[test]
    fn export_xlsx_falls_back_to_csv_when_not_json() {
        let mut artifact = Artifact::new("Inventory".to_string(), ArtifactType::Sheet, None);
        artifact.update_content("Item,Count\nWidget,42\nGadget,7".to_string());
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
    }

    #[test]
    fn export_xlsx_writes_formulas() {
        let mut artifact = Artifact::new("Math".to_string(), ArtifactType::Sheet, None);
        artifact
            .update_content(r#"{"columns":["A","B","Sum"],"rows":[["1","2","=A2+B2"]]}"#.into());
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        // Formula appears as `<f>A2+B2</f>` inside sheet1.xml when unzipped.
        let xml = read_xlsx_text(&bytes);
        assert!(xml.contains("A2+B2"), "formula not found in workbook XML");
    }

    #[test]
    fn write_cell_escapes_apostrophe_equals_as_literal_text() {
        // `'=NOTE: important` must be emitted as the text `=NOTE: important`,
        // not as a formula. This is the standard CSV/XLSX injection escape.
        let mut artifact = Artifact::new("Notes".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(r#"{"columns":["A"],"rows":[["'=NOTE: important"]]}"#.to_string());
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        // Sanity check inside the unzipped workbook XML: the `<f>` formula
        // element should not enclose `NOTE`, and the literal `=NOTE: important`
        // text should appear in sharedStrings.xml as plain text.
        let xml = read_xlsx_text(&bytes);
        assert!(
            !xml.contains("<f>NOTE"),
            "apostrophe-prefixed value was incorrectly treated as a formula",
        );
        assert!(
            xml.contains("=NOTE: important"),
            "escaped literal text not present in shared strings",
        );
    }

    #[test]
    fn export_empty_sheet_still_valid() {
        let artifact = Artifact::new("Empty".to_string(), ArtifactType::Sheet, None);
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
    }

    #[test]
    fn sanitize_sheet_name_strips_forbidden_chars() {
        assert_eq!(sanitize_sheet_name("a/b\\c"), "a_b_c");
        assert_eq!(sanitize_sheet_name("[hidden]"), "_hidden_");
        assert_eq!(sanitize_sheet_name(""), "Sheet1");
        let long = "x".repeat(50);
        assert_eq!(sanitize_sheet_name(&long).chars().count(), 31);
    }
}
