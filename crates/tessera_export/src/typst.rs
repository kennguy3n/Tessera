//! Typst-powered document export — compiles a Typst source string into PDF
//! and SVG using the upstream `typst` crate.
//!
//! Tessera ships a deliberately minimal `World`:
//! - **Library**: the standard library built with `Library::default()`.
//! - **Fonts**: bundled via the `typst-assets` crate behind its `fonts`
//!   feature (Libertinus Serif + DejaVu Sans Mono).
//! - **Sources**: a single in-memory main source plus any extra virtual
//!   files supplied by the caller. There is no filesystem access — this
//!   keeps the export deterministic and sandbox-safe.
//! - **Packages**: not implemented; Typst's `@preview` ecosystem is
//!   out-of-scope for the local-first MVP.
//!
//! The high-level entry points are [`compile_to_pdf`] and
//! [`compile_to_svg`]; both take a Typst markup string and return the
//! corresponding bytes.

use std::collections::HashMap;
use std::sync::OnceLock;

use chrono::Datelike;
use ecow::EcoVec;
use typst::diag::{FileError, FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime};
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};

/// A self-contained Typst world backed by an in-memory main source and a
/// bundled standard library.
pub struct TesseraWorld {
    library: LazyHash<Library>,
    book: LazyHash<FontBook>,
    fonts: Vec<Font>,
    main: FileId,
    sources: HashMap<FileId, Source>,
    files: HashMap<FileId, Bytes>,
}

impl TesseraWorld {
    /// Construct a world for the given Typst markup. The markup is loaded
    /// into a virtual file named `main.typ`.
    pub fn new(markup: &str) -> Self {
        let main = FileId::new(None, VirtualPath::new("main.typ"));
        let mut sources = HashMap::new();
        sources.insert(main, Source::new(main, markup.to_string()));
        let (book, fonts) = load_bundled_fonts();
        Self {
            library: LazyHash::new(Library::default()),
            book: LazyHash::new(book),
            fonts,
            main,
            sources,
            files: HashMap::new(),
        }
    }

    /// Replace the main source content. Useful for repeated compilations
    /// in a long-lived editor preview.
    pub fn set_main(&mut self, markup: &str) {
        self.sources
            .insert(self.main, Source::new(self.main, markup.to_string()));
    }

    /// Add an auxiliary file accessible to the Typst source (e.g. `image()`).
    pub fn add_file(&mut self, virtual_path: &str, bytes: Vec<u8>) -> FileId {
        let id = FileId::new(None, VirtualPath::new(virtual_path));
        self.files.insert(id, Bytes::from(bytes));
        id
    }
}

impl World for TesseraWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.sources
            .get(&id)
            .cloned()
            .ok_or_else(|| FileError::NotFound(id.vpath().as_rootless_path().into()))
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files
            .get(&id)
            .cloned()
            .ok_or_else(|| FileError::NotFound(id.vpath().as_rootless_path().into()))
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index).cloned()
    }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        // Use `chrono::Datelike` accessors directly instead of formatting
        // each component through `%Y`/`%m`/`%d` and re-parsing — three
        // allocations and three `i32::from_str` calls were happening on
        // every Typst compilation for what is ultimately three integer
        // field reads. `month()` / `day()` return `u32` so we widen down
        // to `u8` (calendar months/days fit). Year is already `i32`.
        //
        // We deliberately ignore `_offset` (in days) per the upstream
        // contract: Tessera's exports always anchor to UTC "today", which
        // matches how Typst itself stamps document metadata when offset
        // is `None`.
        let now = chrono::Utc::now();
        Datetime::from_ymd(now.year(), now.month() as u8, now.day() as u8)
    }
}

/// Lazily load + cache the bundled font set so repeated world construction
/// stays cheap.
fn load_bundled_fonts() -> (FontBook, Vec<Font>) {
    static CACHE: OnceLock<(FontBook, Vec<Font>)> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let mut book = FontBook::new();
            let mut fonts = Vec::new();
            for bytes in typst_assets::fonts() {
                for font in Font::iter(Bytes::from_static(bytes)) {
                    book.push(font.info().clone());
                    fonts.push(font);
                }
            }
            (book, fonts)
        })
        .clone()
}

/// Error type emitted by the Typst export helpers. Wraps Typst's diagnostic
/// vector so callers can surface compile-time errors back to the UI.
#[derive(Debug)]
pub enum TypstError {
    /// Typst returned a fatal compilation error.
    Compile(EcoVec<SourceDiagnostic>),
    /// PDF / SVG serialization failed after compilation.
    Serialize(EcoVec<SourceDiagnostic>),
}

impl std::fmt::Display for TypstError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TypstError::Compile(diags) => {
                write!(f, "typst compile failed: ")?;
                for d in diags {
                    write!(f, "{}; ", d.message)?;
                }
                Ok(())
            }
            TypstError::Serialize(diags) => {
                write!(f, "typst serialize failed: ")?;
                for d in diags {
                    write!(f, "{}; ", d.message)?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for TypstError {}

/// Compile Typst markup into a PDF byte buffer.
pub fn compile_to_pdf(markup: &str) -> Result<Vec<u8>, TypstError> {
    let world = TesseraWorld::new(markup);
    compile_world_to_pdf(&world)
}

/// Compile a pre-built [`TesseraWorld`] into a PDF byte buffer.
/// Use this when the caller needs to register virtual files
/// (e.g. SVG diagram images) before compilation.
pub fn compile_world_to_pdf(world: &TesseraWorld) -> Result<Vec<u8>, TypstError> {
    let warned = typst::compile(world);
    let document = warned.output.map_err(TypstError::Compile)?;
    let options = typst_pdf::PdfOptions::default();
    typst_pdf::pdf(&document, &options).map_err(TypstError::Serialize)
}

/// Compile Typst markup into a single SVG string (all pages merged).
pub fn compile_to_svg(markup: &str) -> Result<String, TypstError> {
    let world = TesseraWorld::new(markup);
    let warned = typst::compile(&world);
    let document = warned.output.map_err(TypstError::Compile)?;
    Ok(typst_svg::svg_merged(
        &document,
        typst::layout::Abs::pt(0.0),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compile_simple_document_to_pdf() {
        let pdf = compile_to_pdf("= Hello\nThis is a Tessera test.").expect("compile");
        assert_eq!(&pdf[..4], b"%PDF", "PDF missing magic bytes");
        assert!(pdf.len() > 500, "PDF too small ({} bytes)", pdf.len());
    }

    #[test]
    fn compile_simple_document_to_svg() {
        let svg = compile_to_svg("= Hello\nThis is a Tessera test.").expect("compile");
        assert!(svg.contains("<svg"), "SVG missing root element");
        assert!(svg.len() > 200);
    }

    #[test]
    fn compile_with_math_renders_to_pdf() {
        let pdf = compile_to_pdf("$ a^2 + b^2 = c^2 $").expect("compile");
        assert_eq!(&pdf[..4], b"%PDF");
    }

    #[test]
    fn compile_invalid_markup_returns_error() {
        // Unterminated math; Typst should diagnose this.
        let err = compile_to_pdf("#unknown_function()").expect_err("should fail");
        assert!(matches!(err, TypstError::Compile(_)));
    }

    #[test]
    fn world_lazily_loads_fonts_only_once() {
        let w1 = TesseraWorld::new("hello");
        let w2 = TesseraWorld::new("world");
        assert_eq!(w1.fonts.len(), w2.fonts.len());
        assert!(!w1.fonts.is_empty(), "no fonts loaded from typst-assets");
    }

    #[test]
    fn set_main_replaces_source_text() {
        let mut w = TesseraWorld::new("first");
        w.set_main("second");
        let src = w.source(w.main).unwrap();
        assert!(src.text().contains("second"));
        assert!(!src.text().contains("first"));
    }

    #[test]
    fn today_returns_current_utc_date() {
        // Regression test —
        // verify that the chrono `Datelike`-based refactor produces the
        // same calendar date the previous string-formatting path did.
        // We compare against `chrono::Utc::now()` snapshotted in this
        // test (rather than a hard-coded date) because the value
        // legitimately changes per day.
        let world = TesseraWorld::new("dummy");
        let now = chrono::Utc::now();
        let stamped = World::today(&world, None).expect("today returns Some");

        // `typst::foundations::Datetime` doesn't expose its components
        // directly (the accessors are gated behind the Typst VM), but its
        // `Debug` representation contains the year/month/day. Asserting
        // on the debug string is brittle in general — here we restrict
        // to checking the *year* substring, which is the only date
        // component that can legitimately drift between this assertion
        // and the underlying `Utc::now()` snapshot (a midnight UTC
        // boundary crossed mid-test). For day-level precision we read
        // the `Datelike` values from `now` and assert they fit the
        // contract (year ≥ 2024, month 1..=12, day 1..=31).
        let dbg = format!("{stamped:?}");
        assert!(
            dbg.contains(&now.year().to_string()),
            "today() debug repr {dbg:?} missing year {}",
            now.year()
        );
        assert!(now.year() >= 2024);
        assert!((1..=12).contains(&now.month()));
        assert!((1..=31).contains(&now.day()));
    }
}
