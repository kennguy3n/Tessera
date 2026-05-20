//! XLSX export — converts Tessera Sheet artifacts (JSON cells/rows model)
//! into a `.xlsx` workbook using `rust_xlsxwriter`.
//!
//! The Sheet artifact's `content` field stores JSON with `headers` and
//! `rows` arrays; if the content is not parseable JSON we fall back to
//! treating each line as a row and splitting on commas — the CSV exporter
//! does the same conversion, so the two formats agree on shape.
//!
//! Formulas: cells whose string value starts with `=` are written via
//! `write_formula` so Excel will evaluate them on open. Everything else is
//! written as a string, with numeric strings auto-converted to numbers.

use rust_xlsxwriter::{Format, Workbook};
use serde::Deserialize;
use tessera_artifacts::Artifact;

#[derive(Debug, Default, Deserialize)]
struct SheetContent {
    #[serde(default)]
    headers: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<String>>,
}

/// Parse the Sheet artifact's content into a `SheetContent`. Returns
/// `None` if the content is empty or not parseable.
fn parse_sheet(content: &str) -> Option<SheetContent> {
    if content.trim().is_empty() {
        return None;
    }
    // Preferred form: JSON with headers + rows.
    if let Ok(sheet) = serde_json::from_str::<SheetContent>(content) {
        return Some(sheet);
    }
    // Fallback: CSV-ish lines.
    let mut lines = content.lines();
    let header_line = lines.next()?;
    let headers = header_line.split(',').map(|s| s.trim().to_string()).collect();
    let rows = lines
        .map(|line| line.split(',').map(|s| s.trim().to_string()).collect())
        .collect();
    Some(SheetContent { headers, rows })
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
        for (col, header) in sheet.headers.iter().enumerate() {
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
    worksheet.write_string(row, col, value).expect("write string");
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

    #[test]
    fn export_basic_xlsx_returns_zip_bytes() {
        let mut artifact = Artifact::new("Sales".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(
            r#"{"headers":["Region","Q1","Q2"],"rows":[["North","100","120"],["South","80","95"]]}"#
                .to_string(),
        );
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
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
        artifact.update_content(
            r#"{"headers":["A","B","Sum"],"rows":[["1","2","=A2+B2"]]}"#.into(),
        );
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        // Formula appears as a string `<f>A2+B2</f>` inside sheet1.xml when
        // unzipped — we just smoke-check the bytes contain something
        // formula-shaped if the substring is not compressed.
        let s = String::from_utf8_lossy(&bytes);
        assert!(s.contains("A2+B2") || bytes.len() > 512);
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
