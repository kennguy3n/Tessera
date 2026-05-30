use calamine::Reader;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tessera_core::error::{Error, Result};

use crate::image_metadata::{extract_image_metadata, is_image_extension};
use crate::pdf_extractor::extract_pdf_text;

/// Phase 15 Task 2: process-wide rayon pool sized to `num_cpus / 2`
/// (min 1, max 8) so bulk extraction parallelises across CPU cores
/// without starving the rest of the app — most notably the UI thread,
/// the file watcher's notify loop, and the model sidecar's HTTP
/// transport. The pool is initialised once on first use and reused
/// across every subsequent bulk-extract call to avoid the per-call
/// startup cost of a fresh `ThreadPoolBuilder::build()`.
///
/// Pool sizing rationale:
///
///   - **Min 1**: `num_cpus() / 2` is `0` on a uniprocessor machine,
///     and rayon rejects `num_threads(0)`. The min-1 clamp keeps the
///     pool valid on every host.
///   - **Max 8**: extraction is I/O-bound for the large-PDF case and
///     CPU-bound for the small-Markdown case. On 32+ core servers,
///     spinning up 16+ workers thrashes the FS page cache (each
///     thread `read()`s a different file simultaneously) without
///     producing a proportional throughput gain. The cap balances
///     the two regimes.
///
/// Returns `None` if pool initialisation fails (rayon throws on
/// thread-spawn failure, which only happens on hosts with severely
/// restricted resource limits). The serial fallback in
/// [`extract_files_parallel`] preserves correctness in that case.
fn extraction_pool() -> Option<&'static rayon::ThreadPool> {
    static POOL: OnceLock<Option<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        let available = std::thread::available_parallelism()
            .map(std::num::NonZeroUsize::get)
            .unwrap_or(1);
        let target = (available / 2).clamp(1, 8);
        rayon::ThreadPoolBuilder::new()
            .num_threads(target)
            .thread_name(|i| format!("tessera-extract-{i}"))
            .build()
            .ok()
    })
    .as_ref()
}

/// Extract text from every supported file in `paths` in parallel,
/// returning per-path results in input order.
///
/// Phase 15 Task 2: this is the bulk-extract entrypoint used by the
/// indexer (`index_folder_with_progress`) when it has a batch of
/// pre-walked paths to process. The parallel pass:
///
///   1. Spawns work onto the bounded `extraction_pool()`, capped at
///      `num_cpus / 2` threads so the UI / watcher / sidecar threads
///      keep CPU headroom.
///   2. Preserves input order — the returned `Vec` is indexed
///      identically to the input slice — so callers that walk the
///      vector alongside their own per-path metadata (file id,
///      progress slot offset, etc.) can rely on positional alignment.
///   3. Mirrors the semantics of calling `extract_text(path)` for
///      each path serially: every error path from the dispatch
///      (unsupported extension, I/O failure, parse failure) surfaces
///      as `Err(...)` in the corresponding output slot — so a
///      caller that wraps the parallel pass in a `for (path, res) in
///      paths.iter().zip(...)` loop sees identical control flow.
///
/// If the global rayon pool fails to initialise, falls back to
/// serial extraction so the indexer still makes progress on hosts
/// where rayon cannot spawn threads.
///
/// The integration test in `tests/parallel_extraction_parity.rs`
/// asserts that for any mixed input slice, the output `Vec` is
/// byte-identical to the serial path's output — so a future refactor
/// of `extract_text` cannot drift the parallel path silently.
pub fn extract_files_parallel(paths: &[PathBuf]) -> Vec<(PathBuf, Result<String>)> {
    use rayon::prelude::{IntoParallelRefIterator, ParallelIterator};

    let serial = |inputs: &[PathBuf]| -> Vec<(PathBuf, Result<String>)> {
        inputs
            .iter()
            .map(|p| (p.clone(), extract_text(p)))
            .collect()
    };

    let Some(pool) = extraction_pool() else {
        return serial(paths);
    };

    pool.install(|| {
        paths
            .par_iter()
            .map(|p| (p.clone(), extract_text(p)))
            .collect()
    })
}

pub fn extract_text(path: &Path) -> Result<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_lowercase();

    match ext.as_str() {
        "txt" | "text" => extract_plain_text(path),
        "md" | "markdown" => extract_markdown(path),
        "csv" => extract_csv(path),
        "json" => extract_json(path),
        "html" | "htm" => extract_html(path),
        "xlsx" | "xls" => extract_xlsx(path),
        "pdf" => extract_pdf_text(path),
        "jpg" | "jpeg" | "png" | "tif" | "tiff" | "webp" => extract_image_metadata(path),
        _ => Err(Error::Extraction {
            path: path.display().to_string(),
            message: format!("unsupported file type: .{ext}"),
        }),
    }
}

pub fn is_supported_extension(ext: &str) -> bool {
    let lower = ext.to_lowercase();
    matches!(
        lower.as_str(),
        "txt"
            | "text"
            | "md"
            | "markdown"
            | "csv"
            | "json"
            | "html"
            | "htm"
            | "xlsx"
            | "xls"
            | "pdf"
    ) || is_image_extension(&lower)
}

fn extract_plain_text(path: &Path) -> Result<String> {
    let mut content = String::new();
    let mut file = std::fs::File::open(path)?;
    file.read_to_string(&mut content)?;
    Ok(content)
}

fn extract_markdown(path: &Path) -> Result<String> {
    let raw = std::fs::read_to_string(path)?;
    let parser = pulldown_cmark::Parser::new(&raw);
    let mut text_parts = Vec::new();

    for event in parser {
        match event {
            pulldown_cmark::Event::Text(t) => text_parts.push(t.to_string()),
            pulldown_cmark::Event::Code(c) => text_parts.push(c.to_string()),
            pulldown_cmark::Event::SoftBreak | pulldown_cmark::Event::HardBreak => {
                text_parts.push("\n".to_string());
            }
            pulldown_cmark::Event::End(_) => {
                text_parts.push("\n".to_string());
            }
            _ => {}
        }
    }

    let result = text_parts.join("");
    let cleaned: String = result
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n");
    Ok(collapse_newlines(&cleaned))
}

fn extract_csv(path: &Path) -> Result<String> {
    let content = std::fs::read_to_string(path)?;
    let mut output = Vec::new();

    for line in content.lines() {
        let fields: Vec<&str> = line.split(',').collect();
        let row = fields
            .iter()
            .map(|f| f.trim().trim_matches('"'))
            .collect::<Vec<_>>()
            .join(" | ");
        output.push(row);
    }

    Ok(output.join("\n"))
}

fn extract_json(path: &Path) -> Result<String> {
    let content = std::fs::read_to_string(path)?;
    let value: serde_json::Value = serde_json::from_str(&content)?;
    Ok(flatten_json_value(&value, ""))
}

fn flatten_json_value(value: &serde_json::Value, prefix: &str) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let mut parts = Vec::new();
            for (key, val) in map {
                let new_prefix = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                parts.push(flatten_json_value(val, &new_prefix));
            }
            parts.join("\n")
        }
        serde_json::Value::Array(arr) => {
            let mut parts = Vec::new();
            for (i, val) in arr.iter().enumerate() {
                let new_prefix = format!("{prefix}[{i}]");
                parts.push(flatten_json_value(val, &new_prefix));
            }
            parts.join("\n")
        }
        serde_json::Value::String(s) => format!("{prefix}: {s}"),
        serde_json::Value::Number(n) => format!("{prefix}: {n}"),
        serde_json::Value::Bool(b) => format!("{prefix}: {b}"),
        serde_json::Value::Null => format!("{prefix}: null"),
    }
}

fn extract_html(path: &Path) -> Result<String> {
    let content = std::fs::read_to_string(path)?;
    Ok(strip_html_tags(&content))
}

fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_script = false;
    let mut in_style = false;
    let mut tag_name = String::new();
    let mut collecting_tag_name = false;

    for ch in html.chars() {
        if ch == '<' {
            in_tag = true;
            collecting_tag_name = true;
            tag_name.clear();
            continue;
        }
        if ch == '>' {
            in_tag = false;
            collecting_tag_name = false;
            let lower_tag = tag_name.to_lowercase();
            if lower_tag == "script" {
                in_script = true;
            } else if lower_tag == "/script" {
                in_script = false;
            } else if lower_tag == "style" {
                in_style = true;
            } else if lower_tag == "/style" {
                in_style = false;
            } else if matches!(
                lower_tag.as_str(),
                "br" | "br/"
                    | "p"
                    | "/p"
                    | "div"
                    | "/div"
                    | "h1"
                    | "h2"
                    | "h3"
                    | "h4"
                    | "h5"
                    | "h6"
                    | "/h1"
                    | "/h2"
                    | "/h3"
                    | "/h4"
                    | "/h5"
                    | "/h6"
                    | "li"
                    | "/li"
                    | "tr"
                    | "/tr"
                    | "hr"
                    | "hr/"
            ) {
                result.push('\n');
            }
            continue;
        }
        if in_tag {
            if collecting_tag_name {
                if ch == ' ' {
                    collecting_tag_name = false;
                } else {
                    tag_name.push(ch);
                }
            }
            continue;
        }
        if in_script || in_style {
            continue;
        }
        result.push(ch);
    }

    decode_html_entities(&collapse_newlines(result.trim()))
}

fn decode_html_entities(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}

fn collapse_newlines(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut prev_newline = false;
    for ch in text.chars() {
        if ch == '\n' {
            if !prev_newline {
                result.push(ch);
            }
            prev_newline = true;
        } else {
            prev_newline = false;
            result.push(ch);
        }
    }
    result.trim().to_string()
}

fn extract_xlsx(path: &Path) -> Result<String> {
    let mut workbook = calamine::open_workbook_auto(path).map_err(|e| Error::Extraction {
        path: path.display().to_string(),
        message: format!("failed to open workbook: {e}"),
    })?;

    let mut output = Vec::new();
    let sheet_names: Vec<String> = workbook.sheet_names();

    for name in &sheet_names {
        if let Ok(range) = workbook.worksheet_range(name) {
            output.push(format!("## Sheet: {name}"));
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|cell| match cell {
                        calamine::Data::Empty => String::new(),
                        calamine::Data::String(s) => s.clone(),
                        calamine::Data::Float(f) => {
                            if (f - f.round()).abs() < f64::EPSILON {
                                format!("{}", *f as i64)
                            } else {
                                format!("{f}")
                            }
                        }
                        calamine::Data::Int(i) => i.to_string(),
                        calamine::Data::Bool(b) => b.to_string(),
                        calamine::Data::DateTime(dt) => format!("{dt}"),
                        calamine::Data::Error(e) => format!("ERROR({e:?})"),
                        calamine::Data::DateTimeIso(s) => s.clone(),
                        calamine::Data::DurationIso(s) => s.clone(),
                    })
                    .collect();
                output.push(cells.join(" | "));
            }
        }
    }

    Ok(output.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn extract_plain_text_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.txt");
        std::fs::write(&path, "Hello, world!\nSecond line.").unwrap();
        let text = extract_text(&path).unwrap();
        assert_eq!(text, "Hello, world!\nSecond line.");
    }

    #[test]
    fn extract_markdown_strips_formatting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.md");
        std::fs::write(
            &path,
            "# Heading\n\nSome **bold** text.\n\n- item 1\n- item 2",
        )
        .unwrap();
        let text = extract_text(&path).unwrap();
        assert!(text.contains("Heading"));
        assert!(text.contains("bold"));
        assert!(text.contains("item 1"));
    }

    #[test]
    fn extract_csv_formats_as_table() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.csv");
        std::fs::write(&path, "name,age,city\nAlice,30,NYC\nBob,25,LA").unwrap();
        let text = extract_text(&path).unwrap();
        assert!(text.contains("name | age | city"));
        assert!(text.contains("Alice | 30 | NYC"));
    }

    #[test]
    fn extract_json_flattens_structure() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.json");
        std::fs::write(
            &path,
            r#"{"name": "Tessera", "version": "0.1.0", "features": ["search", "index"]}"#,
        )
        .unwrap();
        let text = extract_text(&path).unwrap();
        assert!(text.contains("name: Tessera"));
        assert!(text.contains("version: 0.1.0"));
        assert!(text.contains("search"));
    }

    #[test]
    fn extract_html_strips_tags() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("page.html");
        std::fs::write(
            &path,
            "<html><head><title>Test</title><script>var x = 1;</script></head>\
             <body><h1>Hello</h1><p>World &amp; friends</p></body></html>",
        )
        .unwrap();
        let text = extract_text(&path).unwrap();
        assert!(text.contains("Hello"));
        assert!(text.contains("World & friends"));
        assert!(!text.contains("<h1>"));
        assert!(!text.contains("var x"));
    }

    #[test]
    fn unsupported_extension_returns_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin");
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(b"random binary").unwrap();
        let result = extract_text(&path);
        assert!(result.is_err());
    }

    #[test]
    fn supported_extensions_detected() {
        assert!(is_supported_extension("txt"));
        assert!(is_supported_extension("md"));
        assert!(is_supported_extension("csv"));
        assert!(is_supported_extension("json"));
        assert!(is_supported_extension("html"));
        assert!(is_supported_extension("xlsx"));
        // Image formats are now supported (metadata extraction)
        assert!(is_supported_extension("png"));
        assert!(is_supported_extension("jpg"));
        assert!(is_supported_extension("webp"));
        assert!(!is_supported_extension("exe"));
    }

    #[test]
    fn extracts_image_metadata_via_dispatcher() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("dispatch.png");
        let img = image::RgbaImage::from_fn(3, 3, |_, _| image::Rgba([100, 150, 200, 255]));
        img.save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        let text = extract_text(&path).unwrap();
        assert!(text.contains("Format: png"));
        assert!(text.contains("Dimensions: 3x3"));
    }
}
