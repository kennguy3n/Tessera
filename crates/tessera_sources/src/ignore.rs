//! `.gitignore`-style ignore matching for source indexing.
//!
//! PROPOSAL.md line 85 specifies that Tessera should skip files via
//! "`.gitignore`-style patterns, binary files, system files". This
//! module wraps the battle-tested
//! [`ignore::gitignore::GitignoreBuilder`] from BurntSushi's
//! `ignore` crate (used by ripgrep) so we get correct support for
//! the full .gitignore syntax: anchored vs. unanchored patterns,
//! double-star (`**`) directory matches, `!` negations, character
//! classes, and case sensitivity per the platform default.
//!
//! The public API exposed to the rest of the codebase is
//! intentionally identical to the previous bespoke matcher
//! ([`IgnoreRules::new`], [`IgnoreRules::default_rules`],
//! [`IgnoreRules::is_ignored`]) so the indexer, file watcher, and
//! source manager do not need to change. We also keep
//! [`default_patterns`] public so the SettingsPage UI can render the
//! defaults inline as a hint to users who want to extend them.

use std::path::Path;

use ignore::gitignore::{Gitignore, GitignoreBuilder};

/// A compiled set of ignore patterns.
///
/// The patterns are anchored to a logical `/` root so that
/// gitignore semantics around leading `/` (anchored) vs.
/// non-anchored patterns behave predictably regardless of the
/// caller's working directory. We always test paths *as if they
/// were relative to that synthetic root* — `is_ignored` strips any
/// drive-letter / leading `/` before matching so absolute paths
/// from `walkdir` work the same as relative paths the user enters.
pub struct IgnoreRules {
    matcher: Gitignore,
    /// Raw patterns kept for debugging / round-tripping back to the
    /// renderer via IPC. The order matches insertion order.
    patterns: Vec<String>,
}

impl IgnoreRules {
    /// Build a rule-set from the given user-supplied patterns. The
    /// default binary / system patterns from [`default_patterns`]
    /// are NOT included — callers that want them should use
    /// [`IgnoreRules::with_defaults`].
    pub fn new(patterns: &[String]) -> Self {
        Self::compile(patterns, /*with_defaults=*/ false)
    }

    /// Build a rule-set containing the user patterns AND the
    /// curated default binary / system / build-output patterns.
    /// User patterns are appended last so users can override
    /// defaults with a leading `!` negation when needed.
    pub fn with_defaults(extra_patterns: &[String]) -> Self {
        let mut all = default_patterns();
        all.extend(extra_patterns.iter().cloned());
        Self::compile(&all, /*with_defaults=*/ true)
    }

    /// Build a rule-set with only the curated default patterns —
    /// preserves the previous behaviour of
    /// `IgnoreRules::default_rules()`.
    pub fn default_rules() -> Self {
        Self::with_defaults(&[])
    }

    fn compile(patterns: &[String], _with_defaults: bool) -> Self {
        // The synthetic root is purely a path the ignore crate uses
        // to anchor patterns; nothing on disk has to exist there.
        let mut builder = GitignoreBuilder::new("/");
        for pat in patterns {
            // The `ignore` crate treats blank/comment lines exactly
            // like git does. We still validate by ignoring add()
            // errors so a single bad pattern can't poison the
            // entire rule-set.
            let _ = builder.add_line(None, pat);
        }
        let matcher = builder.build().unwrap_or_else(|_| {
            // Fallback to an empty matcher if compilation fails
            // (should never happen for the curated defaults). This
            // matches the behaviour of the previous custom matcher
            // which never errored.
            GitignoreBuilder::new("/")
                .build()
                .expect("empty gitignore builder must always build")
        });
        Self {
            matcher,
            patterns: patterns.to_vec(),
        }
    }

    /// Return true when the given path matches any active ignore
    /// pattern. Both absolute and relative paths are supported —
    /// drive letters / leading `/` are stripped before matching so
    /// the same patterns work cross-platform.
    pub fn is_ignored(&self, path: &Path) -> bool {
        let normalised = normalise_path(path);
        // We don't know whether the caller is asking about a file
        // or a directory; checking both shapes correctly handles
        // patterns like `node_modules/` (trailing slash = directory
        // only) vs. `node_modules` (file or directory).
        if self
            .matcher
            .matched_path_or_any_parents(&normalised, /*is_dir=*/ false)
            .is_ignore()
        {
            return true;
        }
        if self
            .matcher
            .matched_path_or_any_parents(&normalised, /*is_dir=*/ true)
            .is_ignore()
        {
            return true;
        }
        false
    }

    /// Returns the raw patterns this rule-set was built from. The
    /// renderer uses this to display the active rules in the
    /// SourcesPage / SettingsPage.
    pub fn patterns(&self) -> &[String] {
        &self.patterns
    }
}

/// Strip leading absolute-path noise (Windows drive letter,
/// leading `/`) so a path like `C:\projects\.git\config` or
/// `/home/me/proj/.git/config` matches the same patterns as
/// `projects/.git/config`. The ignore crate is happy with relative
/// paths.
fn normalise_path(path: &Path) -> std::path::PathBuf {
    let s = path.to_string_lossy();
    // Drop Windows drive-letter prefix.
    let trimmed = if let Some(rest) = s.strip_prefix(|c: char| c.is_ascii_alphabetic()) {
        if rest.starts_with(':') {
            rest.trim_start_matches(':')
                .trim_start_matches(['\\', '/'])
                .to_string()
        } else {
            s.to_string()
        }
    } else {
        s.to_string()
    };
    // Drop leading separators so the path is relative to the
    // synthetic root, then convert all backslashes to forward
    // slashes — the `ignore` crate expects POSIX separators
    // regardless of host OS.
    let trimmed = trimmed.trim_start_matches(['\\', '/']);
    let normalised = trimmed.replace('\\', "/");
    std::path::PathBuf::from(normalised)
}

/// The curated defaults Tessera applies on top of any user
/// patterns. These cover:
///
/// - VCS metadata (`.git/`, `.hg/`, `.svn/`)
/// - Common dependency dirs (`node_modules/`, `__pycache__/`)
/// - Build outputs (`target/`, `dist/`)
/// - OS junk (`.DS_Store`, `Thumbs.db`, `Desktop.ini`)
/// - Binary file extensions that text indexing can't use
pub fn default_patterns() -> Vec<String> {
    [
        // VCS metadata
        ".git/",
        ".hg/",
        ".svn/",
        // Common dep / build output dirs
        "node_modules/",
        "__pycache__/",
        "target/",
        "dist/",
        "build/",
        // OS junk
        ".DS_Store",
        "Thumbs.db",
        "Desktop.ini",
        // Binary extensions
        "*.exe",
        "*.dll",
        "*.so",
        "*.dylib",
        "*.bin",
        "*.o",
        "*.a",
        "*.lib",
        "*.obj",
        "*.class",
        "*.pyc",
        "*.pyo",
        // Archives
        "*.zip",
        "*.tar",
        "*.gz",
        "*.bz2",
        "*.7z",
        "*.rar",
        "*.iso",
        "*.dmg",
        "*.img",
        // Audio / video — too big and lossy to index as text
        "*.mp3",
        "*.mp4",
        "*.avi",
        "*.mov",
        "*.wav",
        "*.flac",
        // Fonts and icons
        "*.woff",
        "*.woff2",
        "*.ttf",
        "*.otf",
        "*.eot",
        "*.ico",
        "*.icns",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn ignores_git_directory() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new(".git")));
        assert!(rules.is_ignored(Path::new("repo/.git/config")));
        assert!(rules.is_ignored(Path::new("/home/user/repo/.git/config")));
    }

    #[test]
    fn ignores_node_modules_recursively() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new("node_modules")));
        assert!(rules.is_ignored(Path::new("project/node_modules/pkg/index.js")));
        assert!(rules.is_ignored(Path::new("apps/desktop/node_modules/pkg/sub/file.js")));
    }

    #[test]
    fn ignores_binary_extensions() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new("program.exe")));
        assert!(rules.is_ignored(Path::new("lib.dll")));
        assert!(rules.is_ignored(Path::new("path/to/lib.so")));
        assert!(rules.is_ignored(Path::new("photo.dylib")));
    }

    #[test]
    fn allows_supported_text_files() {
        let rules = IgnoreRules::default_rules();
        assert!(!rules.is_ignored(Path::new("README.md")));
        assert!(!rules.is_ignored(Path::new("docs/document.pdf")));
        assert!(!rules.is_ignored(Path::new("data.csv")));
        assert!(!rules.is_ignored(Path::new("notes.txt")));
        assert!(!rules.is_ignored(Path::new("page.html")));
    }

    #[test]
    fn custom_patterns_override_defaults_when_extended() {
        let rules = IgnoreRules::with_defaults(&["*.log".to_string(), "temp/".to_string()]);
        assert!(rules.is_ignored(Path::new("app.log")));
        assert!(rules.is_ignored(Path::new("subdir/app.log")));
        assert!(rules.is_ignored(Path::new("temp")));
        assert!(rules.is_ignored(Path::new("temp/foo.txt")));
        assert!(!rules.is_ignored(Path::new("data.csv")));
        assert!(rules.is_ignored(Path::new("node_modules")));
    }

    #[test]
    fn user_negations_can_re_include_otherwise_ignored_files() {
        // Re-include a single binary-extension file via a `!` rule.
        let rules = IgnoreRules::with_defaults(&["!docs/diagram.dll".to_string()]);
        // The earlier `*.dll` default still matches *.dll names in
        // other locations…
        assert!(rules.is_ignored(Path::new("lib.dll")));
        // …but the explicit negation takes precedence for the
        // negated path.
        assert!(!rules.is_ignored(Path::new("docs/diagram.dll")));
    }

    #[test]
    fn ds_store_is_ignored() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new(".DS_Store")));
        assert!(rules.is_ignored(Path::new("subdir/.DS_Store")));
    }

    #[test]
    fn build_outputs_are_ignored() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new("target")));
        assert!(rules.is_ignored(Path::new("target/release/binary")));
        assert!(rules.is_ignored(Path::new("apps/desktop/dist")));
        assert!(rules.is_ignored(Path::new("apps/desktop/dist/main.js")));
    }

    #[test]
    fn font_and_icon_extensions_ignored() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(Path::new("assets/Roboto.ttf")));
        assert!(rules.is_ignored(Path::new("fonts/material.woff2")));
        assert!(rules.is_ignored(Path::new("brand.icns")));
    }

    #[test]
    fn windows_drive_letter_paths_are_normalised() {
        let rules = IgnoreRules::default_rules();
        assert!(rules.is_ignored(&PathBuf::from(r"C:\projects\.git\config")));
        assert!(rules.is_ignored(&PathBuf::from(r"D:\src\node_modules\pkg\index.js")));
    }

    #[test]
    fn user_only_rules_do_not_include_defaults() {
        let rules = IgnoreRules::new(&["*.log".to_string()]);
        assert!(rules.is_ignored(Path::new("debug.log")));
        // node_modules is in defaults but NOT in this matcher.
        assert!(!rules.is_ignored(Path::new("node_modules/pkg/index.js")));
    }

    #[test]
    fn raw_patterns_round_trip() {
        let rules = IgnoreRules::new(&["*.tmp".to_string(), "scratch/".to_string()]);
        assert_eq!(rules.patterns(), &["*.tmp", "scratch/"]);
    }

    #[test]
    fn deep_double_star_pattern() {
        // .gitignore double-star pattern: any `secrets.yaml` at
        // any depth, but not other names.
        let rules = IgnoreRules::new(&["**/secrets.yaml".to_string()]);
        assert!(rules.is_ignored(Path::new("secrets.yaml")));
        assert!(rules.is_ignored(Path::new("config/secrets.yaml")));
        assert!(rules.is_ignored(Path::new("a/b/c/secrets.yaml")));
        assert!(!rules.is_ignored(Path::new("a/b/secrets.json")));
    }

    #[test]
    fn anchored_pattern_only_matches_root() {
        let rules = IgnoreRules::new(&["/build".to_string()]);
        assert!(rules.is_ignored(Path::new("build")));
        // Anchored pattern should NOT match `build` nested in
        // subdirectories.
        assert!(!rules.is_ignored(Path::new("apps/desktop/build")));
    }

    #[test]
    fn invalid_pattern_does_not_poison_matcher() {
        // Even with a syntactically odd pattern, other patterns
        // should still work.
        let rules = IgnoreRules::new(&[
            "[".to_string(), // unterminated character class
            "*.tmp".to_string(),
        ]);
        assert!(rules.is_ignored(Path::new("scratch.tmp")));
    }
}
