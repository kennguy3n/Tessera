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
    // that may have written `headers` instead. Without the alias the
    // field-name mismatch silently dropped all column names from XLSX
    // exports.
    #[serde(default, alias = "headers")]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<String>>,
    /// workbook-level named ranges mirrored from the TS
    /// `SheetContent.namedRanges` field. We use `camelCase` to match the JS
    /// JSON shape since `serde_json::from_str` is case-sensitive. The list
    /// may be absent (older artifacts) or empty (new artifacts without
    /// named ranges); both cases are treated as "no named ranges".
    #[serde(default, rename = "namedRanges")]
    named_ranges: Vec<NamedRange>,
    /// multi-sheet support. When the artifact contains
    /// `sheets[]`, each entry becomes its own XLSX worksheet. The legacy
    /// `columns`/`rows` fields above remain populated for the active tab
    /// (the TS `fromWorkbook` helper guarantees that invariant) so older
    /// readers still see a usable spreadsheet.
    #[serde(default)]
    sheets: Option<Vec<SheetTab>>,
    #[serde(default, rename = "activeSheetIndex")]
    active_sheet_index: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SheetTab {
    name: String,
    #[serde(default)]
    columns: Vec<String>,
    #[serde(default)]
    rows: Vec<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct NamedRange {
    name: String,
    range: String,
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
    Some(SheetContent {
        columns,
        rows,
        named_ranges: Vec::new(),
        sheets: None,
        active_sheet_index: None,
    })
}

/// Export a Tessera Sheet artifact to XLSX bytes.
pub fn export_xlsx(artifact: &Artifact) -> Vec<u8> {
    let mut workbook = Workbook::new();
    let parsed = parse_sheet(&artifact.content);
    let header_fmt = Format::new().set_bold().set_background_color("#EFE7FD");

    // Named ranges must be registered AFTER the worksheets exist (so the
    // sheet names are resolvable) but BEFORE `save_to_buffer()` flushes
    // the workbook XML. We extract them now and apply after the
    // worksheets are populated. Cloning is cheap (`Vec<NamedRange>` is
    // short — typically <10 entries — and `String`s are owned anyway).
    let named_ranges: Vec<NamedRange> = parsed
        .as_ref()
        .map(|s| {
            s.named_ranges
                .iter()
                .map(|r| NamedRange {
                    name: r.name.clone(),
                    range: r.range.clone(),
                })
                .collect()
        })
        .unwrap_or_default();

    match parsed {
        // multi-sheet artifact. Emit one worksheet
        // per tab so cross-sheet refs (`Sheet2!A1`) inside formula cells
        // resolve correctly on open in Excel / Numbers / LibreOffice.
        Some(sheet) if sheet.sheets.as_ref().is_some_and(|s| !s.is_empty()) => {
            // De-duplicate sanitized sheet names — Excel rejects a
            // workbook with two worksheets sharing a name (case-insensitive
            // in Excel's eyes), and sanitization can introduce collisions
            // (e.g. two tabs both named "My/Sheet" both become
            // "My_Sheet"). We append `~2`, `~3`, ... until the name is
            // unique within the workbook.
            let tabs = sheet.sheets.unwrap();
            // Honor the persisted active-tab pointer so the file opens
            // on the same sheet the user was viewing in Tessera (matches
            // Excel's save-the-selection-with-the-file semantics). Out-
            // of-range or missing values fall back to the first tab.
            let active_idx = sheet
                .active_sheet_index
                .filter(|i| *i < tabs.len())
                .unwrap_or(0);
            let mut taken: Vec<String> = Vec::with_capacity(tabs.len());
            for (i, tab) in tabs.iter().enumerate() {
                let raw = sanitize_sheet_name(&tab.name);
                let unique = dedupe_sheet_name(&raw, &taken);
                let worksheet = workbook
                    .add_worksheet()
                    .set_name(&unique)
                    .expect("worksheet name should be valid after sanitization");
                if i == active_idx {
                    worksheet.set_active(true);
                }
                write_sheet_payload(worksheet, &tab.columns, &tab.rows, &header_fmt);
                taken.push(unique);
            }
        }
        // Single-sheet artifact — preserve the legacy behaviour of using
        // the artifact's title as the worksheet name. Existing fixtures
        // and exports continue to land at byte-identical bytes for this
        // path so the schema migration is a no-op for the common case.
        Some(sheet) => {
            let worksheet = workbook
                .add_worksheet()
                .set_name(sanitize_sheet_name(&artifact.title))
                .expect("worksheet name should be valid after sanitization");
            write_sheet_payload(worksheet, &sheet.columns, &sheet.rows, &header_fmt);
        }
        None => {
            // Empty / unparseable artifact: still emit a single
            // worksheet with a header row carrying the title so the
            // file opens without a warning.
            let worksheet = workbook
                .add_worksheet()
                .set_name(sanitize_sheet_name(&artifact.title))
                .expect("worksheet name should be valid after sanitization");
            worksheet
                .write_string_with_format(0, 0, &artifact.title, &header_fmt)
                .expect("write title");
        }
    }

    // workbook-level defined names. Each entry becomes
    // a `<definedName>` in xl/workbook.xml. Invalid names (e.g. starting
    // with a digit, containing spaces) are silently skipped — Excel would
    // reject the file otherwise and we don't want a single malformed name
    // to fail the entire export.
    for nr in &named_ranges {
        if !is_valid_defined_name(&nr.name) {
            continue;
        }
        // `define_name` returns Err only when the name fails validation —
        // we've already guarded above, so this should not happen, but we
        // ignore the result rather than panicking on any future stricter
        // validator (forward-compat: rust_xlsxwriter may tighten its
        // checks in a later release and we'd rather drop the name than
        // crash the entire export).
        let _ = workbook.define_name(&nr.name, &nr.range);
    }

    workbook.save_to_buffer().expect("save XLSX to buffer")
}

/// Populate `worksheet` with a header row and a body. Pulled out of
/// `export_xlsx` so the multi-sheet and single-sheet branches share
/// identical row/column emission semantics.
fn write_sheet_payload(
    worksheet: &mut rust_xlsxwriter::Worksheet,
    columns: &[String],
    rows: &[Vec<String>],
    header_fmt: &Format,
) {
    for (col, header) in columns.iter().enumerate() {
        worksheet
            .write_string_with_format(0, col as u16, header, header_fmt)
            .expect("write header");
    }
    for (r, row) in rows.iter().enumerate() {
        let row_idx = (r + 1) as u32;
        for (c, cell) in row.iter().enumerate() {
            let col_idx = c as u16;
            write_cell(worksheet, row_idx, col_idx, cell);
        }
    }
}

/// Append a numeric suffix until `name` no longer collides
/// (case-insensitively) with any name in `taken`. Excel rejects a
/// workbook whose worksheet names differ only in case, so the
/// comparison must be case-insensitive.
fn dedupe_sheet_name(name: &str, taken: &[String]) -> String {
    let lower = name.to_lowercase();
    if !taken.iter().any(|n| n.to_lowercase() == lower) {
        return name.to_string();
    }
    let mut n = 2u32;
    loop {
        let suffix = format!("~{n}");
        // Re-sanitize the truncated base so we never push the name past
        // Excel's 31-char limit, then re-check for collisions.
        let take_chars = 31usize.saturating_sub(suffix.chars().count());
        let base: String = name.chars().take(take_chars).collect();
        let candidate = format!("{base}{suffix}");
        let lower = candidate.to_lowercase();
        if !taken.iter().any(|t| t.to_lowercase() == lower) {
            return candidate;
        }
        n += 1;
        if n > 1000 {
            // Defensive cap — 1000 same-named sheets is absurd and any
            // such artifact is malformed. Return the candidate anyway
            // and let rust_xlsxwriter raise the validation error.
            return candidate;
        }
    }
}

/// Excel defined names must start with a letter or underscore, contain only
/// letters / digits / underscores / periods, and be <= 255 chars. They also
/// can't collide with cell references (e.g. `A1`, `XFD1048576`). We apply a
/// conservative subset of the spec — good enough to keep the workbook
/// loadable and reject obvious garbage.
fn is_valid_defined_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 255 {
        return false;
    }
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_alphabetic() || first == '_') {
        return false;
    }
    if !chars.all(|c| c.is_alphanumeric() || c == '_' || c == '.') {
        return false;
    }
    // Looks-like-cell-reference rejection. Excel cells use the form
    // `[A-Z]{1,3}[1-9][0-9]*` and columns max out at `XFD` (16384) /
    // rows at `1048576`. The previous heuristic rejected ANY name that
    // matched `[A-Z]+[0-9]+`, which over-rejected legitimate defined
    // names like `Revenue1`, `Phase2`, `Tier3`, `Quarter1990` — none
    // of those are valid Excel cell references (`REVENUE1` would be a
    // 7-letter column, which doesn't exist) and Excel itself happily
    // accepts them as defined names.
    //
    // Devin Review PR #70: tighten the check so we only
    // reject names that actually collide with the Excel address space:
    //   * column part: 1-3 ASCII letters, AND
    //   * the resulting column index is <= 16384 (XFD), AND
    //   * row part: a positive integer 1..=1048576.
    // Anything outside that envelope is safely a defined name.
    let lower = name.to_ascii_lowercase();
    if let Some(digit_start) = lower.find(|c: char| c.is_ascii_digit()) {
        let (alpha, digits) = lower.split_at(digit_start);
        let alpha_ok =
            !alpha.is_empty() && alpha.len() <= 3 && alpha.chars().all(|c| c.is_ascii_lowercase());
        let digits_ok = !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit());
        if alpha_ok && digits_ok {
            // Compute the 1-indexed column number from the lowercase letters.
            // 'a' = 1, 'z' = 26, 'aa' = 27, ..., 'xfd' = 16384.
            let col_idx: u32 = alpha
                .chars()
                .fold(0u32, |acc, c| acc * 26 + (c as u32 - 'a' as u32 + 1));
            // Row part must also parse as a valid Excel row (1..=1048576).
            // Anything outside the row range (e.g. `A0`, `A0001` with
            // leading zero is fine since `.parse::<u32>()` accepts it,
            // `XFD9999999`) cannot collide with a real cell reference
            // and is safely a defined name.
            let row_ok = digits
                .parse::<u32>()
                .is_ok_and(|r| (1..=1_048_576).contains(&r));
            if (1..=16_384).contains(&col_idx) && row_ok {
                return false;
            }
        }
    }
    true
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

    // ---------------------------------------------------------------------
    // formula preservation + named-range support tests.
    // ---------------------------------------------------------------------

    /// Verifies that the four formula categories the Sheet editor supports
    /// (`SUM`, `AVERAGE`, `COUNT`, `MAX`) all reach the XLSX as formula
    /// elements (`<f>...</f>` inside sheet1.xml) rather than being
    /// flattened to computed string values. This is the regression the
    /// task description names explicitly: "currently the exporter may
    /// serialize computed values instead of formula strings."
    #[test]
    fn export_xlsx_preserves_all_supported_formula_kinds() {
        let mut artifact = Artifact::new("Stats".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(
            r#"{
                "columns":["Value","Sum","Average","Count","Max"],
                "rows":[
                    ["10","=SUM(A2:A4)","=AVERAGE(A2:A4)","=COUNT(A2:A4)","=MAX(A2:A4)"],
                    ["20","","","",""],
                    ["30","","","",""]
                ]
            }"#
            .to_string(),
        );
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        let xml = read_xlsx_text(&bytes);
        // Each formula must appear inside a <f>...</f> element. The
        // `<f>` prefix guarantees rust_xlsxwriter routed the call through
        // `write_formula`, not `write_string` (a string `=SUM(A2:A4)`
        // would land in sharedStrings.xml without a `<f>` wrapper).
        for fmla in ["SUM(A2:A4)", "AVERAGE(A2:A4)", "COUNT(A2:A4)", "MAX(A2:A4)"] {
            let needle = format!("<f>{fmla}</f>");
            assert!(
                xml.contains(&needle),
                "formula {fmla:?} not preserved as <f> element in workbook XML",
            );
        }
    }

    /// `is_valid_defined_name`: the validator must accept the names Excel
    /// itself accepts and reject the canonical foot-guns (cell refs,
    /// leading digits, illegal characters, empty / too-long strings).
    #[test]
    fn is_valid_defined_name_accepts_excel_legal_names() {
        // Legal names — leading letter or underscore, alphanumerics +
        // underscores + dots, not a cell reference.
        // Devin Review PR #70: the tightened cell-ref
        // heuristic now correctly accepts `Revenue1`, `Phase2`,
        // `Tier3`, `Quarter1990`, and `XFE1` (alpha part is 3 chars
        // but the resulting column index 16385 is past the Excel
        // limit of 16384 / XFD). The previous over-broad pattern
        // would have rejected all of these.
        for ok in [
            "Revenue",
            "Q1_Sales",
            "_Hidden",
            "Tax.2025",
            "x", // single char letter — Excel allows this
            "Tier1_Threshold.Override",
            "Revenue1",
            "Phase2",
            "Tier3",
            "Quarter1990",
            "XFE1",     // col 16385 — past XFD/16384, so not a cell ref
            "ABCD1",    // 4-letter alpha cannot be a cell ref
            "A1048577", // row 1048577 — past the 1048576 limit
            "A0",       // row 0 doesn't exist in Excel
        ] {
            assert!(is_valid_defined_name(ok), "rejected legal name {ok:?}");
        }
        // Illegal — empty, leading digit, illegal char, looks like a
        // real cell reference (A1, XFD1048576, Z99999), too long.
        let too_long = "n".repeat(256);
        for bad in [
            "",
            "1Revenue",
            "Has Space",
            "Has-Dash",
            "Pct%",
            "A1",
            "XFD1048576",
            "Z99999",
            "AA1",
            "XFD1",
            too_long.as_str(),
        ] {
            assert!(!is_valid_defined_name(bad), "accepted illegal name {bad:?}");
        }
    }

    /// End-to-end: a Sheet artifact whose JSON includes a valid
    /// `namedRanges` entry must produce an XLSX whose `xl/workbook.xml`
    /// contains a `<definedName name="...">` element pointing at the
    /// declared range. This is what makes Excel recognise `=SUM(Revenue)`
    /// in a downstream workbook that imports the file.
    #[test]
    fn export_xlsx_emits_defined_names_for_valid_named_ranges() {
        let mut artifact = Artifact::new("Budget".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(
            r#"{
                "columns":["Month","Revenue","Cost"],
                "rows":[
                    ["Jan","1000","700"],
                    ["Feb","1200","800"],
                    ["Mar","1500","900"]
                ],
                "namedRanges":[
                    {"name":"Revenue","range":"Budget!$B$2:$B$4"},
                    {"name":"Cost","range":"Budget!$C$2:$C$4"}
                ]
            }"#
            .to_string(),
        );
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        let xml = read_xlsx_text(&bytes);
        // The `<definedName name="...">` element lives in
        // `xl/workbook.xml` (one of the XML entries our `read_xlsx_text`
        // helper concatenates). Both names should appear with their
        // range body inside the element value.
        assert!(
            xml.contains("definedName") && xml.contains("name=\"Revenue\""),
            "Revenue definedName not present in workbook XML:\n{xml}",
        );
        assert!(
            xml.contains("name=\"Cost\""),
            "Cost definedName not present in workbook XML:\n{xml}",
        );
        // The range body must reach the workbook intact — without it
        // Excel would render the defined name as `#REF!`.
        assert!(
            xml.contains("Budget!$B$2:$B$4"),
            "Revenue range body lost during export",
        );
        assert!(
            xml.contains("Budget!$C$2:$C$4"),
            "Cost range body lost during export",
        );
    }

    /// A malformed defined name (collision with cell-ref pattern, illegal
    /// character, leading digit) must NOT abort the export. The valid
    /// names in the same batch must still land in the workbook XML.
    /// This is the failure mode the validator was added to address: one
    /// bad name from a data corruption or a buggy upstream must never
    /// break the entire export.
    #[test]
    fn export_xlsx_silently_skips_invalid_named_ranges_and_keeps_valid_ones() {
        let mut artifact = Artifact::new("Mixed".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(
            r#"{
                "columns":["A","B"],
                "rows":[["1","2"]],
                "namedRanges":[
                    {"name":"A1","range":"Mixed!$A$1"},
                    {"name":"1Bad","range":"Mixed!$B$1"},
                    {"name":"Has Space","range":"Mixed!$A$1"},
                    {"name":"GoodName","range":"Mixed!$B$1"}
                ]
            }"#
            .to_string(),
        );
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        let xml = read_xlsx_text(&bytes);
        // Good name lands.
        assert!(
            xml.contains("name=\"GoodName\""),
            "valid GoodName dropped when invalid siblings were present",
        );
        // Invalid names must NOT appear as definedName entries — verify
        // by searching for the `name="<bad>"` quoted form so we don't
        // accidentally match the row data.
        for bad in ["name=\"A1\"", "name=\"1Bad\"", "name=\"Has Space\""] {
            assert!(
                !xml.contains(bad),
                "invalid named range {bad:?} leaked into workbook XML",
            );
        }
    }

    /// Backward compat: an artifact whose JSON has no `namedRanges` field
    /// (older artifact, or a producer that doesn't yet know about Phase
    /// 15 Task 14) must export cleanly with zero named ranges. Likewise
    /// for an explicit empty array.
    #[test]
    fn export_xlsx_tolerates_missing_or_empty_named_ranges_field() {
        // Missing field entirely.
        let mut a1 = Artifact::new("Old".to_string(), ArtifactType::Sheet, None);
        a1.update_content(r#"{"columns":["A"],"rows":[["1"]]}"#.to_string());
        let bytes1 = export_xlsx(&a1);
        assert_is_zip(&bytes1);
        // Empty array.
        let mut a2 = Artifact::new("Empty".to_string(), ArtifactType::Sheet, None);
        a2.update_content(r#"{"columns":["A"],"rows":[["1"]],"namedRanges":[]}"#.to_string());
        let bytes2 = export_xlsx(&a2);
        assert_is_zip(&bytes2);
        // Neither workbook should contain a definedName element.
        let xml1 = read_xlsx_text(&bytes1);
        let xml2 = read_xlsx_text(&bytes2);
        assert!(
            !xml1.contains("<definedName"),
            "absent namedRanges produced spurious definedName entries",
        );
        assert!(
            !xml2.contains("<definedName"),
            "empty namedRanges array produced spurious definedName entries",
        );
    }

    /// when an artifact carries a `sheets[]` array,
    /// each tab must become its own worksheet inside the workbook so
    /// cross-sheet references (e.g. `Sheet2!A1`) inside formula cells
    /// resolve correctly on open. We also verify that a VLOOKUP across
    /// sheets is written through `write_formula` so Excel evaluates it
    /// (rather than being stored as a literal text cell).
    #[test]
    fn export_xlsx_emits_one_worksheet_per_tab() {
        let json = serde_json::json!({
            "columns": ["Name", "Salary"],
            "rows": [["Alice", "100"], ["Bob", "200"]],
            "activeSheetIndex": 1,
            "sheets": [
                {
                    "name": "People",
                    "columns": ["Name", "Salary"],
                    "rows": [["Alice", "100"], ["Bob", "200"]],
                },
                {
                    "name": "Lookup",
                    "columns": ["Who", "Earnings"],
                    "rows": [
                        ["Alice", "=VLOOKUP(A2,People!A:B,2,FALSE)"],
                        ["Bob", "=VLOOKUP(A3,People!A:B,2,FALSE)"],
                    ],
                },
            ],
        });
        let mut artifact = Artifact::new("Payroll".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(json.to_string());
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);

        // Both sheet names appear in workbook.xml (which lists sheets).
        let xml = read_xlsx_text(&bytes);
        assert!(
            xml.contains("name=\"People\""),
            "missing People worksheet declaration in {xml}",
        );
        assert!(
            xml.contains("name=\"Lookup\""),
            "missing Lookup worksheet declaration in {xml}",
        );

        // Two worksheet entries exist on disk inside the zip.
        let names = list_xlsx_entries(&bytes);
        let n_sheets = names
            .iter()
            .filter(|n| {
                n.starts_with("xl/worksheets/sheet")
                    && std::path::Path::new(n.as_str())
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("xml"))
            })
            .count();
        assert_eq!(
            n_sheets, 2,
            "expected 2 worksheets, got {n_sheets}: {names:?}"
        );

        // The cross-sheet VLOOKUP formula must round-trip as a formula
        // (the function name reaches an `<f>` element), not as plain text.
        assert!(
            xml.contains("VLOOKUP"),
            "VLOOKUP formula text missing from {xml}",
        );
        assert!(
            xml.contains("<f>VLOOKUP"),
            "VLOOKUP was written as text, not a formula, in {xml}",
        );
    }

    /// `activeSheetIndex` chooses which tab is selected when the file is
    /// opened in Excel — translated to `set_active(true)` on the matching
    /// worksheet, which emits `<sheetView tabSelected="1">` for that
    /// tab. Out-of-range values fall back to the first tab.
    #[test]
    fn export_xlsx_honors_active_sheet_index() {
        let json = serde_json::json!({
            "columns": ["A"],
            "rows": [["1"]],
            "activeSheetIndex": 1,
            "sheets": [
                {"name": "First", "columns": ["A"], "rows": [["1"]]},
                {"name": "Second", "columns": ["A"], "rows": [["2"]]},
            ],
        });
        let mut artifact = Artifact::new("Active".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(json.to_string());
        let bytes = export_xlsx(&artifact);
        let xml = read_xlsx_text(&bytes);
        // The second worksheet (sheet2.xml) must carry tabSelected="1".
        assert!(
            xml.contains("tabSelected=\"1\""),
            "expected tabSelected=1 to mark the active tab in {xml}",
        );
    }

    /// Sanitization collisions across tabs must be deduplicated, since
    /// Excel rejects two worksheets with the same name. Both tabs below
    /// sanitize to "My_Sheet" because `/` is illegal; the second must
    /// land at "My_Sheet~2" (case-insensitive uniqueness within the
    /// workbook).
    #[test]
    fn export_xlsx_deduplicates_colliding_sheet_names() {
        let json = serde_json::json!({
            "columns": ["A"],
            "rows": [["1"]],
            "sheets": [
                {"name": "My/Sheet", "columns": ["A"], "rows": [["1"]]},
                {"name": "My?Sheet", "columns": ["A"], "rows": [["2"]]},
            ],
        });
        let mut artifact = Artifact::new("Dup".to_string(), ArtifactType::Sheet, None);
        artifact.update_content(json.to_string());
        let bytes = export_xlsx(&artifact);
        assert_is_zip(&bytes);
        let xml = read_xlsx_text(&bytes);
        assert!(
            xml.contains("My_Sheet") && xml.contains("My_Sheet~2"),
            "expected deduplicated sheet names (My_Sheet, My_Sheet~2) in {xml}",
        );
    }

    /// dedupe_sheet_name unit test — uniqueness is case-insensitive
    /// (Excel's rule), and the resulting name still fits within the
    /// 31-char limit after the `~N` suffix is appended.
    #[test]
    fn dedupe_sheet_name_is_case_insensitive_and_respects_length_limit() {
        assert_eq!(dedupe_sheet_name("Foo", &[]), "Foo");
        assert_eq!(dedupe_sheet_name("Foo", &["foo".to_string()]), "Foo~2");
        // 30-char base + "~2" = 32 chars; the base must be trimmed by 1
        // so the final candidate is exactly 31 chars.
        let long = "A".repeat(31);
        let res = dedupe_sheet_name(&long, &[long.clone()]);
        assert_eq!(
            res.chars().count(),
            31,
            "result must fit Excel's 31-char limit"
        );
        assert!(res.ends_with("~2"));
    }

    /// List entry names inside the XLSX zip so multi-sheet tests can
    /// assert structural properties (e.g. how many `xl/worksheets/sheetN.xml`
    /// entries exist).
    fn list_xlsx_entries(bytes: &[u8]) -> Vec<String> {
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).expect("XLSX should be a valid zip");
        let mut names = Vec::with_capacity(archive.len());
        for i in 0..archive.len() {
            let entry = archive.by_index(i).expect("entry");
            names.push(entry.name().to_string());
        }
        names
    }
}
